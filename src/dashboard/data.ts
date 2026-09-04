import { type Config, type ResolvedGroupConfig, resolveGroupConfig } from '../config/index.js';
import type { SessionState } from '../listener/index.js';
import { type DueDecision, describeCadence, type GroupScheduleState } from '../scheduler/index.js';
import type {
  DeliveryRow,
  QuestionRecord,
  RunRecord,
  Store,
  SummaryRecord,
} from '../store/index.js';

/** Everything the JSON endpoints need; the CLI and `digest run` wire it up. */
export interface DashboardSource {
  tenantId: string;
  config: Config;
  store: Store;
  /** `scheduler.describe()`; a standalone viewer builds a scheduler for it too. */
  describeSchedule: () => Array<{
    group: ResolvedGroupConfig;
    state: GroupScheduleState;
    decision: DueDecision;
  }>;
  /** Live session state from the listener, or `unknown` for a standalone viewer. */
  getSessionState?: () => SessionState | 'unknown';
  /** Clock in ms; defaults to Date.now(). */
  now?: () => number;
  tz: string;
  startedAtMs?: number;
  version?: string;
}

const ACTIVITY_DAYS = 14;
const DAY_S = 86_400;

export interface StatusView {
  tenantId: string;
  session: SessionState | 'unknown';
  nowTs: number;
  tz: string;
  uptimeS: number | null;
  version: string | null;
  groupsConfigured: number;
  defaultSummarizer: string;
  retentionDays: number;
  sendsToday: number;
  maxSendsPerDay: number;
  pendingSends: number;
  failedSends: number;
}

export function statusView(src: DashboardSource): StatusView {
  const nowMs = (src.now ?? Date.now)();
  const nowTs = Math.floor(nowMs / 1000);
  const unsent = src.store.listDeliveries(src.tenantId, 500, { unsentOnly: true });
  return {
    tenantId: src.tenantId,
    session: src.getSessionState?.() ?? 'unknown',
    nowTs,
    tz: src.tz,
    uptimeS: src.startedAtMs === undefined ? null : Math.floor((nowMs - src.startedAtMs) / 1000),
    version: src.version ?? null,
    groupsConfigured: src.config.groups.length,
    defaultSummarizer: src.config.defaults.summarizer,
    retentionDays: src.config.retention.days,
    sendsToday: src.store.countSentSince(src.tenantId, nowTs - DAY_S),
    maxSendsPerDay: src.config.limits.max_sends_per_day,
    pendingSends: unsent.filter((d) => d.status === 'queued').length,
    failedSends: unsent.filter((d) => d.status === 'failed').length,
  };
}

export interface GroupView {
  jid: string;
  name: string;
  subject: string | null;
  participants: number | null;
  summarizer: string;
  cadence: string;
  cadenceType: ResolvedGroupConfig['cadence']['type'];
  deliver: ResolvedGroupConfig['deliver'];
  personality: string;
  language: string;
  style: string;
  messagesStored: number;
  lastMessageTs: number | null;
  watermarkTs: number | null;
  pendingMessages: number;
  lastRun: Pick<RunRecord, 'createdTs' | 'trigger' | 'status' | 'error' | 'costUsd'> | null;
  due: DueDecision;
  /** Messages per local day over the last two weeks, oldest first. */
  activity: Array<{ day: string; count: number }>;
}

export function groupsView(src: DashboardSource): GroupView[] {
  const nowTs = Math.floor((src.now ?? Date.now)() / 1000);
  const seen = new Map(src.store.listGroups(src.tenantId).map((g) => [g.jid, g]));
  return src.describeSchedule().map(({ group, state, decision }) => {
    const row = seen.get(group.jid);
    const last = state.runs[0];
    return {
      jid: group.jid,
      name: group.name ?? row?.subject ?? group.jid,
      subject: row?.subject ?? null,
      participants: row?.participantCount ?? null,
      summarizer: group.summarizer,
      cadence: describeCadence(group.cadence),
      cadenceType: group.cadence.type,
      deliver: group.deliver,
      personality: group.summary.personality,
      language: group.summary.language,
      style: group.summary.style,
      messagesStored: row?.messageCount ?? 0,
      lastMessageTs: row?.lastMessageTs ?? null,
      watermarkTs: state.watermark?.watermarkTs ?? null,
      pendingMessages: state.pendingMessages,
      lastRun: last
        ? {
            createdTs: last.createdTs,
            trigger: last.trigger,
            status: last.status,
            error: last.error,
            costUsd: last.costUsd,
          }
        : null,
      due: decision,
      activity: src.store.messageCountsByDay(
        src.tenantId,
        group.jid,
        nowTs - ACTIVITY_DAYS * DAY_S,
        src.tz,
      ),
    };
  });
}

function groupName(config: Config, jid: string): string {
  return resolveGroupConfig(config, jid)?.name ?? jid;
}

export type RunView = RunRecord & { groupName: string };

export function runsView(src: DashboardSource, limit: number): RunView[] {
  return src.store
    .listRuns(src.tenantId, limit)
    .map((r) => ({ ...r, groupName: groupName(src.config, r.groupJid) }));
}

export type SummaryView = SummaryRecord & {
  groupName: string;
  deliveries: Array<Pick<DeliveryRow, 'channel' | 'status' | 'target' | 'error' | 'sentTs'>>;
};

export function summariesView(src: DashboardSource, limit: number): SummaryView[] {
  return src.store.listSummaries(src.tenantId, limit).map((s) => ({
    ...s,
    groupName: groupName(src.config, s.groupJid),
    deliveries: s.deliveries.map((d) => ({
      channel: d.channel,
      status: d.status,
      target: d.target,
      error: d.error,
      sentTs: d.sentTs,
    })),
  }));
}

export type QuestionView = QuestionRecord & { groupName: string };

export function questionsView(src: DashboardSource, limit: number): QuestionView[] {
  return src.store
    .listQuestions(src.tenantId, limit)
    .map((q) => ({ ...q, groupName: groupName(src.config, q.groupJid) }));
}

export interface OutboxView {
  /** Queued or failed rows, oldest first (the order the outbox drains them). */
  pending: DeliveryRow[];
  /** Most recent sent rows, newest first. Message bodies are omitted. */
  recent: Array<Omit<DeliveryRow, 'text'>>;
}

export function outboxView(src: DashboardSource, limit: number): OutboxView {
  const pending = src.store
    .listDeliveries(src.tenantId, limit, { unsentOnly: true })
    .map(({ text: _text, ...d }) => ({ ...d, text: null }))
    .reverse();
  const recent = src.store
    .listDeliveries(src.tenantId, limit)
    .filter((d) => d.status === 'sent')
    .map(({ text: _text, ...d }) => d);
  return { pending, recent };
}
