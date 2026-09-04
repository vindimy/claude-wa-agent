import { describe, expect, it } from 'vitest';
import { localParts, previousDaily, previousWeekly, tzOffsetMs, zonedToUtcMs } from './time.js';

const LA = 'America/Los_Angeles';
const iso = (ts: number) => new Date(ts * 1000).toISOString();

describe('time zone helpers', () => {
  it('reads local parts and offsets across DST', () => {
    // 2026-07-01 12:00 PDT = 19:00Z ; 2026-01-15 12:00 PST = 20:00Z
    expect(localParts(Date.UTC(2026, 6, 1, 19, 0), LA)).toMatchObject({
      month: 7,
      day: 1,
      hour: 12,
      weekday: 3,
    });
    expect(tzOffsetMs(Date.UTC(2026, 6, 1, 19, 0), LA)).toBe(-7 * 3_600_000);
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 20, 0), LA)).toBe(-8 * 3_600_000);
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 20, 0), 'UTC')).toBe(0);
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 20, 0), 'Europe/Berlin')).toBe(3_600_000);
  });

  it('converts wall-clock to instants, including day overflow', () => {
    expect(zonedToUtcMs(2026, 7, 1, 8, 0, LA)).toBe(Date.UTC(2026, 6, 1, 15, 0));
    expect(zonedToUtcMs(2026, 1, 15, 8, 0, LA)).toBe(Date.UTC(2026, 0, 15, 16, 0));
    expect(zonedToUtcMs(2026, 3, 0, 8, 0, LA)).toBe(zonedToUtcMs(2026, 2, 28, 8, 0, LA));
  });

  it('finds the previous daily occurrence', () => {
    // now = 2026-09-04 10:00 PDT → previous 08:00 is today
    const now = Date.UTC(2026, 8, 4, 17, 0) / 1000;
    expect(iso(previousDaily('08:00', LA, now))).toBe('2026-09-04T15:00:00.000Z');
    // now = 07:59 PDT → yesterday 08:00
    const early = Date.UTC(2026, 8, 4, 14, 59) / 1000;
    expect(iso(previousDaily('08:00', LA, early))).toBe('2026-09-03T15:00:00.000Z');
    // exactly at 08:00 counts as reached
    expect(previousDaily('08:00', LA, Date.UTC(2026, 8, 4, 15, 0) / 1000)).toBe(
      Date.UTC(2026, 8, 4, 15, 0) / 1000,
    );
  });

  it('handles the DST transition day', () => {
    // 2026-11-01 02:00 PDT clocks go back; 08:00 PST = 16:00Z
    const now = Date.UTC(2026, 10, 1, 18, 0) / 1000;
    expect(iso(previousDaily('08:00', LA, now))).toBe('2026-11-01T16:00:00.000Z');
    // 2026-03-08 spring forward; 08:00 PDT = 15:00Z
    const spring = Date.UTC(2026, 2, 8, 18, 0) / 1000;
    expect(iso(previousDaily('08:00', LA, spring))).toBe('2026-03-08T15:00:00.000Z');
  });

  it('finds the previous weekly occurrence', () => {
    // 2026-09-04 is a Friday. Sunday 18:00 PDT before it = Aug 30 → 2026-08-31T01:00Z
    const now = Date.UTC(2026, 8, 4, 17, 0) / 1000;
    expect(iso(previousWeekly('sun', '18:00', LA, now))).toBe('2026-08-31T01:00:00.000Z');
    // Friday 09:00 PDT when now is Friday 10:00 → today
    expect(iso(previousWeekly('fri', '09:00', LA, now))).toBe('2026-09-04T16:00:00.000Z');
    // Friday 11:00 when now is Friday 10:00 → last week
    expect(iso(previousWeekly('fri', '11:00', LA, now))).toBe('2026-08-28T18:00:00.000Z');
  });
});
