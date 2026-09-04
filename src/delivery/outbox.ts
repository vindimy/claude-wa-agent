import { createLogger } from '../shared/index.js';
import type { DeliveryRow, Store } from '../store/index.js';
import type { Transport } from './types.js';

export interface OutboxOptions {
  tenantId: string;
  store: Store;
  transport: Transport;
  /** Per-tenant cap on WhatsApp sends in any rolling 24 h window. */
  maxSendsPerDay: number;
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
  | { kind: 'sent'; summaryId: string; channel: string }
  | { kind: 'failed'; summaryId: string; channel: string; permanent: boolean };

const DAY_S = 86_400;

/**
 * Per-tenant outbound queue. Drains `deliveries` rows with status `queued`
 * one at a time, with jitter between sends and a rolling daily cap. Rows
 * survive restarts, so a send that never happened is retried, and a send that
 * happened is never repeated.
 */
export function startOutbox(opts: OutboxOptions): OutboxHandle {
  const {
    tenantId,
    store,
    transport,
    maxSendsPerDay,
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

  async function drainOnce(): Promise<DrainResult> {
    if (busy) return { kind: 'idle' };
    busy = true;
    try {
      const [row] = store.queuedDeliveries(tenantId, 1);
      if (!row) return { kind: 'idle' };
      if (!transport.isConnected()) return { kind: 'not-connected' };

      const nowS = Math.floor(now() / 1000);
      const sentToday = store.countSentSince(tenantId, nowS - DAY_S);
      if (sentToday >= maxSendsPerDay) {
        log.warn({ sentToday, maxSendsPerDay }, 'daily send cap reached, holding queue');
        return { kind: 'capped', sentToday };
      }

      if (row.channel === 'vault' || !row.text) {
        // Vault rows are written synchronously by deliverSummary; a queued one
        // here is a bug, not something to send.
        store.markDeliveryFailed(
          tenantId,
          row.summaryId,
          row.channel,
          'not an outbox channel',
          true,
        );
        return { kind: 'failed', summaryId: row.summaryId, channel: row.channel, permanent: true };
      }

      // Phase 5 turns this on. Until then group rows never leave the queue.
      if (row.channel === 'group') {
        store.markDeliveryFailed(
          tenantId,
          row.summaryId,
          row.channel,
          'group posting disabled',
          true,
        );
        return { kind: 'failed', summaryId: row.summaryId, channel: row.channel, permanent: true };
      }

      const target = resolveTarget(row);
      if (!target) {
        log.warn({ summaryId: row.summaryId }, 'self JID unknown yet, retrying later');
        return { kind: 'not-connected' };
      }

      const [lo, hi] = jitterMs;
      await sleep(lo + random() * (hi - lo));
      if (stopped) return { kind: 'idle' };

      const sent = await transport.sendText(target, row.text);
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
