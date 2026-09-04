import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../store/index.js';
import { decideDue, type GroupScheduleState, RETRY_AFTER_S, windowSince } from './cadence.js';

const LA = 'America/Los_Angeles';
// Friday 2026-09-04 10:00 PDT
const NOW = Date.UTC(2026, 8, 4, 17, 0) / 1000;
const TODAY_0800 = Date.UTC(2026, 8, 4, 15, 0) / 1000;
const DAY = 86_400;

function run(o: Partial<RunRecord>): RunRecord {
  return {
    tenantId: 'owner',
    id: 'r',
    groupJid: 'g@g.us',
    trigger: 'daily',
    dryRun: false,
    sinceTs: 0,
    untilTs: 0,
    messageCount: 1,
    watermarkTs: null,
    watermarkId: null,
    summaryId: null,
    adapter: 'fake',
    model: null,
    status: 'ok',
    error: null,
    costUsd: null,
    durationMs: null,
    createdTs: NOW - 60,
    ...o,
  };
}

function state(o: Partial<GroupScheduleState> = {}): GroupScheduleState {
  return { runs: [], watermark: undefined, firstSeenTs: NOW - 3 * DAY, pendingMessages: 0, ...o };
}

const daily = { type: 'daily', at: '08:00', tz: LA } as const;

describe('decideDue: daily', () => {
  it('fires once the occurrence is reached and not run yet', () => {
    expect(decideDue(daily, state(), NOW, 'UTC')).toEqual({
      due: true,
      reason: 'occurrence reached',
      occurrenceTs: TODAY_0800,
    });
  });

  it('does not fire again after a run for this occurrence', () => {
    const s = state({ runs: [run({ createdTs: TODAY_0800 + 30 })] });
    expect(decideDue(daily, s, NOW, 'UTC').due).toBe(false);
  });

  it('fires the next day even if yesterday ran', () => {
    const s = state({ runs: [run({ createdTs: TODAY_0800 - DAY + 30 })] });
    expect(decideDue(daily, s, NOW, 'UTC').due).toBe(true);
  });

  it('catches up after a restart that missed the occurrence', () => {
    // process was down at 08:00; last run was yesterday
    const s = state({
      runs: [run({ createdTs: TODAY_0800 - DAY + 30 })],
      watermark: { watermarkTs: TODAY_0800 - DAY, watermarkId: 'x' },
    });
    expect(decideDue(daily, s, TODAY_0800 + 3 * 3600, 'UTC').due).toBe(true);
  });

  it('waits for the first occurrence when the group is newer than it', () => {
    const s = state({ firstSeenTs: TODAY_0800 + 600 });
    expect(decideDue(daily, s, NOW, 'UTC')).toMatchObject({
      due: false,
      reason: 'first occurrence not reached yet',
    });
    expect(decideDue(daily, state({ firstSeenTs: undefined }), NOW, 'UTC').due).toBe(false);
  });

  it('ignores manual and command runs when deciding', () => {
    const s = state({ runs: [run({ trigger: 'command', createdTs: TODAY_0800 + 30 })] });
    expect(decideDue(daily, s, NOW, 'UTC').due).toBe(true);
  });

  it('retries an errored occurrence after the retry delay, at most three times', () => {
    const errored = (ago: number) => run({ status: 'error', createdTs: NOW - ago });
    expect(decideDue(daily, state({ runs: [errored(60)] }), NOW, 'UTC')).toMatchObject({
      due: false,
      reason: 'waiting to retry after error',
    });
    expect(
      decideDue(daily, state({ runs: [errored(RETRY_AFTER_S + 1)] }), NOW, 'UTC'),
    ).toMatchObject({ due: true, reason: 'retry after error' });
    const three = [
      errored(RETRY_AFTER_S + 1),
      errored(2 * RETRY_AFTER_S),
      errored(3 * RETRY_AFTER_S),
    ];
    expect(decideDue(daily, state({ runs: three }), NOW, 'UTC')).toMatchObject({
      due: false,
      reason: 'gave up for this occurrence',
    });
  });

  it('uses the scheduler tz when the cadence has none', () => {
    const noTz = { type: 'daily', at: '08:00' } as const;
    // In UTC, 08:00 today is 08:00Z; NOW is 17:00Z → reached
    expect(decideDue(noTz, state(), NOW, 'UTC').due).toBe(true);
    // In a zone where it is still before 08:00 local → yesterday's occurrence, which ran
    const s = state({ runs: [run({ createdTs: NOW - 3600 })] });
    expect(decideDue(noTz, s, NOW, 'Pacific/Honolulu').due).toBe(false);
  });
});

describe('decideDue: weekly', () => {
  const weekly = { type: 'weekly', day: 'sun', at: '18:00', tz: LA } as const;
  it('fires after the weekly slot when nothing ran since', () => {
    expect(decideDue(weekly, state({ firstSeenTs: NOW - 30 * DAY }), NOW, 'UTC').due).toBe(true);
    const ran = state({ runs: [run({ trigger: 'weekly', createdTs: NOW - 4 * DAY })] });
    expect(decideDue(weekly, ran, NOW, 'UTC').due).toBe(false);
  });
});

describe('decideDue: threshold', () => {
  const th = { type: 'threshold', messages: 10, max_hours: 6 } as const;
  it('fires on message count', () => {
    expect(decideDue(th, state({ pendingMessages: 10 }), NOW, 'UTC').due).toBe(true);
    const recent = { watermarkTs: NOW - 3600, watermarkId: 'x' };
    expect(
      decideDue(th, state({ pendingMessages: 9, watermark: recent }), NOW, 'UTC'),
    ).toMatchObject({
      due: false,
      reason: 'below threshold',
    });
    expect(decideDue(th, state({ pendingMessages: 0 }), NOW, 'UTC')).toMatchObject({
      due: false,
      reason: 'no new messages',
    });
  });

  it('fires on elapsed time with pending messages', () => {
    const old = state({
      pendingMessages: 2,
      watermark: { watermarkTs: NOW - 7 * 3600, watermarkId: 'x' },
    });
    expect(decideDue(th, old, NOW, 'UTC').due).toBe(true);
    const recent = state({
      pendingMessages: 2,
      runs: [run({ trigger: 'threshold', createdTs: NOW - 3600 })],
      watermark: { watermarkTs: NOW - 7 * 3600, watermarkId: 'x' },
    });
    expect(decideDue(th, recent, NOW, 'UTC').due).toBe(false);
  });

  it('backs off after errors', () => {
    const s = state({
      pendingMessages: 50,
      runs: [run({ trigger: 'threshold', status: 'error', createdTs: NOW - 60 })],
    });
    expect(decideDue(th, s, NOW, 'UTC').due).toBe(false);
  });
});

describe('manual + windowSince', () => {
  it('never fires manual', () => {
    expect(decideDue({ type: 'manual' }, state({ pendingMessages: 999 }), NOW, 'UTC').due).toBe(
      false,
    );
  });
  it('starts after the watermark, else a cadence-sized lookback', () => {
    expect(windowSince(daily, { watermarkTs: 500 }, NOW)).toBe(501);
    expect(windowSince(daily, undefined, NOW)).toBe(NOW - DAY);
    expect(windowSince({ type: 'weekly', day: 'sun', at: '18:00' }, undefined, NOW)).toBe(
      NOW - 7 * DAY,
    );
    expect(windowSince({ type: 'threshold', messages: 5, max_hours: 2.5 }, undefined, NOW)).toBe(
      NOW - 9000,
    );
  });
});
