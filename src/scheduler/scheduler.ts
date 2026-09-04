import { randomUUID } from 'node:crypto';
import { parseSince } from '../cli/since.js';
import { type Config, type ResolvedGroupConfig, resolveGroupConfig } from '../config/index.js';
import { createLogger } from '../shared/index.js';
import type { Store } from '../store/index.js';
import { type DueDecision, decideDue, type GroupScheduleState, windowSince } from './cadence.js';
import { type DigestCommand, helpText, parseCommand } from './commands.js';
import { type DigestRequest, describeDigestError, runDigest } from './run-digest.js';
import { systemTimeZone } from './time.js';

export interface SchedulerOptions {
  tenantId: string;
  config: Config;
  store: Store;
  vaultDir: string;
  tickMs?: number;
  now?: () => number;
  tz?: string;
  /** Passed through to runDigest (test seam). */
  summarizerFactory?: DigestRequest['summarizerFactory'];
}

export interface TickOutcome {
  groupJid: string;
  decision: DueDecision;
  result?: 'ok' | 'empty' | 'error' | 'reused';
}

export interface SchedulerHandle {
  /** Evaluate every group once; run the due ones sequentially. */
  tick(): Promise<TickOutcome[]>;
  /** Handle an owner command from the self-chat; replies are queued as self-DMs. */
  handleCommand(text: string): Promise<void>;
  /** Snapshot for `digest schedule`. */
  describe(): Array<{
    group: ResolvedGroupConfig;
    decision: DueDecision;
    state: GroupScheduleState;
  }>;
  stop(): void;
}

const RUN_HORIZON_S = 8 * 86_400;
const PRUNE_EVERY_MS = 3_600_000;

export function startScheduler(opts: SchedulerOptions): SchedulerHandle {
  const { tenantId, config, store, vaultDir, tickMs = 60_000, now = () => Date.now() } = opts;
  const tz = opts.tz ?? systemTimeZone();
  const log = createLogger('scheduler', { tenant_id: tenantId });
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let lastPruneMs: number | undefined;

  const groups = (): ResolvedGroupConfig[] =>
    config.groups
      .map((g) => resolveGroupConfig(config, g.jid))
      .filter((g): g is ResolvedGroupConfig => g !== undefined);

  function stateFor(group: ResolvedGroupConfig, nowTs: number): GroupScheduleState {
    const watermark = store.lastWatermark(tenantId, group.jid);
    const pendingSince = watermark ? watermark.watermarkTs + 1 : 0;
    return {
      runs: store.recentRuns(tenantId, group.jid, nowTs - RUN_HORIZON_S),
      watermark,
      firstSeenTs: store.getGroup(tenantId, group.jid)?.firstSeenTs,
      pendingMessages:
        group.cadence.type === 'threshold'
          ? store.countMessages(tenantId, group.jid, pendingSince)
          : 0,
    };
  }

  async function runGroup(
    group: ResolvedGroupConfig,
    sinceTs: number,
    trigger: DigestRequest['trigger'],
    extra: Partial<DigestRequest> = {},
  ): Promise<TickOutcome['result']> {
    const nowTs = Math.floor(now() / 1000);
    const groupTz = 'tz' in group.cadence && group.cadence.tz ? group.cadence.tz : tz;
    const result = await runDigest({
      tenantId,
      store,
      config,
      group,
      sinceTs,
      untilTs: nowTs,
      trigger,
      tz: groupTz,
      vaultDir,
      now,
      summarizerFactory: opts.summarizerFactory,
      ...extra,
    });
    if (!result.ok) {
      log.error(
        { group: group.jid, trigger, error: result.error },
        describeDigestError(result.error),
      );
      return 'error';
    }
    if (result.value.kind === 'empty') return 'empty';
    return result.value.reused ? 'reused' : 'ok';
  }

  /** Apply `retention.days` at most once an hour; messages only, never summaries. */
  function pruneIfDue(): void {
    const nowMs = now();
    if (lastPruneMs !== undefined && nowMs - lastPruneMs < PRUNE_EVERY_MS) return;
    lastPruneMs = nowMs;
    const cutoffTs = Math.floor(nowMs / 1000) - config.retention.days * 86_400;
    const removed = store.pruneMessagesBefore(tenantId, cutoffTs);
    if (removed > 0) log.info({ removed, days: config.retention.days }, 'pruned old messages');
  }

  async function tick(): Promise<TickOutcome[]> {
    if (running) return [];
    running = true;
    const outcomes: TickOutcome[] = [];
    try {
      pruneIfDue();
      const nowTs = Math.floor(now() / 1000);
      for (const group of groups()) {
        if (stopped) break;
        const state = stateFor(group, nowTs);
        const decision = decideDue(group.cadence, state, nowTs, tz);
        const outcome: TickOutcome = { groupJid: group.jid, decision };
        if (decision.due) {
          log.info({ group: group.jid, reason: decision.reason }, 'scheduled digest due');
          const trigger = group.cadence.type === 'manual' ? 'manual' : group.cadence.type;
          outcome.result = await runGroup(
            group,
            windowSince(group.cadence, state.watermark, nowTs),
            trigger,
          );
          if (outcome.result === 'empty') {
            // Record the attempt so an empty window does not re-fire every tick.
            store.insertRun({
              tenantId,
              id: randomUUID(),
              groupJid: group.jid,
              trigger,
              dryRun: false,
              sinceTs: windowSince(group.cadence, state.watermark, nowTs),
              untilTs: nowTs,
              messageCount: 0,
              watermarkTs: null,
              watermarkId: null,
              summaryId: null,
              adapter: group.summarizer,
              model: null,
              status: 'empty',
              error: null,
              costUsd: null,
              durationMs: null,
              createdTs: nowTs,
            });
          }
        }
        outcomes.push(outcome);
      }
    } finally {
      running = false;
    }
    return outcomes;
  }

  function queueReply(text: string): void {
    store.putDelivery({
      tenantId,
      summaryId: `cmd:${randomUUID()}`,
      channel: 'self_dm',
      status: 'queued',
      text,
      createdTs: Math.floor(now() / 1000),
    });
  }

  function findGroup(ref: string): ResolvedGroupConfig | undefined {
    const needle = ref.trim().toLowerCase();
    return (
      groups().find((g) => g.jid === ref.trim() || g.name?.toLowerCase() === needle) ??
      groups().find((g) => g.name?.toLowerCase().includes(needle))
    );
  }

  async function handleCommand(text: string): Promise<void> {
    const cmd: DigestCommand | undefined = parseCommand(text);
    if (!cmd) return;
    if (cmd.kind === 'help') return queueReply(helpText(config));
    if (cmd.kind === 'invalid') return queueReply(`🤖 ${cmd.message}. Send /help for usage.`);

    const nowTs = Math.floor(now() / 1000);
    let targets = groups();
    if (cmd.groupRef) {
      const g = findGroup(cmd.groupRef);
      if (!g) return queueReply(`🤖 Unknown group "${cmd.groupRef}". Send /help to list groups.`);
      targets = [g];
    }
    let since: number | undefined;
    if (cmd.sinceSpec) {
      const parsed = parseSince(cmd.sinceSpec, nowTs);
      if (!parsed.ok) return queueReply(`🤖 Bad window "${cmd.sinceSpec}". Use 12h, 2d, 1w.`);
      since = parsed.value;
    }
    log.info({ groups: targets.map((g) => g.jid), since: cmd.sinceSpec }, 'owner command');

    const lines: string[] = [];
    for (const group of targets) {
      const sinceTs =
        since ?? windowSince(group.cadence, store.lastWatermark(tenantId, group.jid), nowTs);
      const r = await runGroup(group, sinceTs, 'command', { forceSelfDm: true });
      if (r === 'empty') lines.push(`${group.name ?? group.jid}: no new messages`);
      else if (r === 'error') lines.push(`${group.name ?? group.jid}: failed, see logs`);
    }
    if (lines.length > 0) queueReply(`🤖 ${lines.join('\n')}`);
  }

  function describe() {
    const nowTs = Math.floor(now() / 1000);
    return groups().map((group) => {
      const state = stateFor(group, nowTs);
      return { group, state, decision: decideDue(group.cadence, state, nowTs, tz) };
    });
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await tick();
      } catch (e) {
        log.error({ err: e }, 'scheduler tick failed');
      }
      schedule();
    }, tickMs);
    timer.unref?.();
  }
  schedule();

  return {
    tick,
    handleCommand,
    describe,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
