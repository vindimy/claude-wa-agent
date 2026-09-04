import type { Cadence } from '../config/index.js';
import type { RunRecord } from '../store/index.js';
import { previousDaily, previousWeekly } from './time.js';

const HOUR = 3_600;
const DAY = 86_400;
const WEEK = 7 * DAY;

/** How long to wait before retrying a scheduled run that errored. */
export const RETRY_AFTER_S = 30 * 60;
/** Attempts per scheduled occurrence before giving up until the next one. */
export const MAX_ATTEMPTS_PER_OCCURRENCE = 3;

export interface GroupScheduleState {
  /** Non-dry runs for this group, newest first, covering at least the last occurrence. */
  runs: RunRecord[];
  watermark: { watermarkTs: number; watermarkId: string } | undefined;
  /** When the listener first saw the group (persisted), unix seconds. */
  firstSeenTs: number | undefined;
  /** Messages stored after the watermark (threshold cadences only). */
  pendingMessages: number;
}

export type DueDecision =
  | { due: false; reason: string; nextTs?: number }
  | { due: true; reason: string; occurrenceTs: number };

const SCHEDULED: ReadonlySet<string> = new Set(['daily', 'weekly', 'threshold']);

function lastOccurrence(cadence: Cadence, tz: string, nowTs: number): number | undefined {
  switch (cadence.type) {
    case 'daily':
      return previousDaily(cadence.at, cadence.tz ?? tz, nowTs);
    case 'weekly':
      return previousWeekly(cadence.day, cadence.at, cadence.tz ?? tz, nowTs);
    default:
      return undefined;
  }
}

/** Lookback for a group that has never been summarized. */
export function defaultLookbackS(cadence: Cadence): number {
  switch (cadence.type) {
    case 'daily':
      return DAY;
    case 'weekly':
      return WEEK;
    case 'threshold':
      return Math.ceil(cadence.max_hours * HOUR);
    case 'manual':
      return DAY;
  }
}

/**
 * Restart-safe due check. State comes from the store, never from memory, so
 * a process restart cannot double-fire or skip an occurrence.
 */
export function decideDue(
  cadence: Cadence,
  state: GroupScheduleState,
  nowTs: number,
  tz: string,
): DueDecision {
  if (cadence.type === 'manual') return { due: false, reason: 'manual cadence' };

  const scheduledRuns = state.runs.filter((r) => SCHEDULED.has(r.trigger));
  const anchor = state.watermark?.watermarkTs ?? state.firstSeenTs;

  if (cadence.type === 'threshold') {
    if (state.pendingMessages <= 0) return { due: false, reason: 'no new messages' };
    const lastAttempt = scheduledRuns[0];
    const errorsRecent = scheduledRuns.filter(
      (r) => r.status === 'error' && r.createdTs >= nowTs - DAY,
    ).length;
    if (lastAttempt?.status === 'error') {
      if (errorsRecent >= MAX_ATTEMPTS_PER_OCCURRENCE) {
        return { due: false, reason: 'too many recent errors' };
      }
      if (nowTs - lastAttempt.createdTs < RETRY_AFTER_S) {
        return { due: false, reason: 'waiting to retry after error' };
      }
    }
    if (state.pendingMessages >= cadence.messages) {
      return {
        due: true,
        reason: `${state.pendingMessages} messages ≥ ${cadence.messages}`,
        occurrenceTs: nowTs,
      };
    }
    const since = lastAttempt?.createdTs ?? anchor;
    if (since !== undefined && nowTs - since >= cadence.max_hours * HOUR) {
      return {
        due: true,
        reason: `${cadence.max_hours}h elapsed with new messages`,
        occurrenceTs: nowTs,
      };
    }
    return { due: false, reason: 'below threshold' };
  }

  const occurrence = lastOccurrence(cadence, tz, nowTs);
  if (occurrence === undefined) return { due: false, reason: 'no occurrence' };

  // Which runs belong to this occurrence?
  const thisOccurrence = scheduledRuns.filter((r) => r.createdTs >= occurrence);
  if (thisOccurrence.length === 0) {
    // Never fired for this occurrence. Only catch up if the group predates it;
    // a group configured after 08:00 waits for tomorrow's 08:00.
    if (anchor === undefined) return { due: false, reason: 'group not seen yet' };
    if (scheduledRuns.length === 0 && anchor > occurrence) {
      return { due: false, reason: 'first occurrence not reached yet' };
    }
    return { due: true, reason: 'occurrence reached', occurrenceTs: occurrence };
  }
  const last = thisOccurrence[0];
  if (!last) return { due: false, reason: 'unreachable' };
  if (last.status !== 'error') return { due: false, reason: 'already ran for this occurrence' };
  if (thisOccurrence.length >= MAX_ATTEMPTS_PER_OCCURRENCE) {
    return { due: false, reason: 'gave up for this occurrence' };
  }
  if (nowTs - last.createdTs < RETRY_AFTER_S) {
    return { due: false, reason: 'waiting to retry after error' };
  }
  return { due: true, reason: 'retry after error', occurrenceTs: occurrence };
}

/**
 * Window for the next run: everything after the watermark, or a default
 * lookback for a group never summarized. `+1` skips the watermark message
 * itself; two messages in the same second is the accepted edge.
 */
export function windowSince(
  cadence: Cadence,
  watermark: { watermarkTs: number } | undefined,
  nowTs: number,
): number {
  if (watermark) return watermark.watermarkTs + 1;
  return nowTs - defaultLookbackS(cadence);
}
