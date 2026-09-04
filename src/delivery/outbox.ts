import { createLogger } from '../shared/index.js';
import type { DeliveryRow, Store } from '../store/index.js';
import { isGroupJid } from './deliver.js';
import type { Transport } from './types.js';

export interface OutboxOptions {
  tenantId: string;
  store: Store;
  transport: Transport;
  /** Per-tenant cap on WhatsApp sends in any rolling 24 h window. */
  maxSendsPerDay: number;
  /**
   * Send-time check that a group still has `deliver.group: true`. Defaults to
   * "never", so an outbox without it drops every group row.
   */
  isGroupPostAllowed?: (groupJid: string) => boolean;
  /** Minimum spacing between two posts into the same group. */
  minGroupPostGapMs?: number;
  pollMs?: number;
  /** Human-like pause before each send, [min, max] ms. */
  jitterMs?: [number, number];
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface OutboxHandle {
  /** Process at most one queued delivery. Returns what happened. */
  drainOnce(): Promise<DrainResult>;
  stop(): void;
}

export type DrainResult =
  | { kind: 'idle' }
  | { kind: 'not-connected' }
  | { kind: 'capped'; sentToday: number }
  /** Only group rows remain and each is inside its per-group gap. */
  | { kind: 'held'; count: number }
  | { kind: 'sent'; summaryId: string; channel: string }
  | { kind: 'failed'; summaryId: string; channel: string; permanent: boolean };

const DAY_S = 86_400;

/**
 * Per-tenant outbound queue. Drains `deliveries` rows with status `queued`
 * one at a time, with jitter between sends and a rolling daily cap. Rows
 * survive restarts, so a send that never happened is retried, and a send that
 * happened is never repeated.
 *
 * Group rows are the one channel that can reach other people, so they get an
 * extra gate here: the target must be a group JID that is opted in *at send
 * time*, and two posts into the same group are spaced by `minGroupPostGapMs`.
 * A held group row does not block self-DMs queued behind it.
 */
export function startOutbox(opts: OutboxOptions): OutboxHandle {
  const {
    tenantId,
    store,
    transport,
    maxSendsPerDay,
    isGroupPostAllowed = () => false,
    minGroupPostGapMs = 3_600_000,
    pollMs = 5_000,
    jitterMs = [2_000, 5_000],
    maxAttempts = 5,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
  } = opts;
  const log = createLogger('outbox', { tenant_id: tenantId });

  let stopped = false;
  let busy = false;
  let timer: NodeJS.Timeout | undefined;

  function resolveTarget(row: DeliveryRow): string | undefined {
    if (row.channel === 'self_dm') return transport.selfJid();
    if (row.channel === 'group') return row.target ?? undefined;
    return undefined;
  }

  /** Why a row can never be sent, or undefined if it is sendable. */
  function rejectReason(row: DeliveryRow): string | undefined {
    // Vault rows are written synchronously by deliverSummary; a queued one
    // here is a bug, not something to send.
    if (row.channel === 'vault' || !row.text) return 'not an outbox channel';
    if (row.channel === 'group') {
      if (!row.target || !isGroupJid(row.target)) return 'group target is not a group JID';
      if (!isGroupPostAllowed(row.target)) return `group posting not enabled for ${row.target}`;
    }
    return undefined;
  }

  function heldUntil(row: DeliveryRow, nowS: number): number | undefined {
    if (row.channel !== 'group' || !row.target || minGroupPostGapMs <= 0) return undefined;
    const last = store.lastSentTs(tenantId, 'group', row.target);
    if (last === undefined) return undefined;
    const until = last + Math.ceil(minGroupPostGapMs / 1000);
    return until > nowS ? until : undefined;
  }

  async function drainOnce(): Promise<DrainResult> {
    if (busy) return { kind: 'idle' };
    busy = true;
    try {
      const rows = store.queuedDeliveries(tenantId, 10);
      if (rows.length === 0) return { kind: 'idle' };
      if (!transport.isConnected()) return { kind: 'not-connected' };

      const nowS = Math.floor(now() / 1000);
      const sentToday = store.countSentSince(tenantId, nowS - DAY_S);
      if (sentToday >= maxSendsPerDay) {
        log.warn({ sentToday, maxSendsPerDay }, 'daily send cap reached, holding queue');
        return { kind: 'capped', sentToday };
      }

      let held = 0;
      let row: DeliveryRow | undefined;
      for (const candidate of rows) {
        const reason = rejectReason(candidate);
        if (reason) {
          store.markDeliveryFailed(tenantId, candidate.summaryId, candidate.channel, reason, true);
          log.warn(
            { summaryId: candidate.summaryId, channel: candidate.channel, reason },
            'dropped',
          );
          return {
            kind: 'failed',
            summaryId: candidate.summaryId,
            channel: candidate.channel,
            permanent: true,
          };
        }
        const until = heldUntil(candidate, nowS);
        if (until !== undefined) {
          held += 1;
          log.debug({ summaryId: candidate.summaryId, target: candidate.target, until }, 'held');
          continue;
        }
        row = candidate;
        break;
      }
      if (!row) return held > 0 ? { kind: 'held', count: held } : { kind: 'idle' };
      const text = row.text as string;

      const target = resolveTarget(row);
      if (!target) {
        log.warn({ summaryId: row.summaryId }, 'self JID unknown yet, retrying later');
        return { kind: 'not-connected' };
      }

      const [lo, hi] = jitterMs;
      await sleep(lo + random() * (hi - lo));
      if (stopped) return { kind: 'idle' };

      const sent = await transport.sendText(target, text);
      const sentS = Math.floor(now() / 1000);
      if (sent.ok) {
        store.markDeliverySent(tenantId, row.summaryId, row.channel, target, sentS);
        log.info({ summaryId: row.summaryId, channel: row.channel, target }, 'sent');
        return { kind: 'sent', summaryId: row.summaryId, channel: row.channel };
      }
      const permanent = row.attempts + 1 >= maxAttempts;
      const message = sent.error.tag === 'send' ? sent.error.message : sent.error.tag;
      store.markDeliveryFailed(tenantId, row.summaryId, row.channel, message, permanent);
      log.warn(
        { summaryId: row.summaryId, attempt: row.attempts + 1, permanent, error: message },
        'send failed',
      );
      return { kind: 'failed', summaryId: row.summaryId, channel: row.channel, permanent };
    } finally {
      busy = false;
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await drainOnce();
      } catch (e) {
        log.error({ err: e }, 'outbox tick failed');
      }
      schedule();
    }, pollMs);
    timer.unref?.();
  }
  schedule();

  return {
    drainOnce,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
