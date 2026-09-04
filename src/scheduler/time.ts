/**
 * Minimal IANA time-zone arithmetic on top of Intl, enough to find "the last
 * 08:00 in America/Los_Angeles before now" without a date library.
 * All `ts` values are unix seconds unless the name says `Ms`.
 */

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
export const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function localParts(tsMs: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(tsMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  const wd = get('weekday').slice(0, 3).toLowerCase() as Weekday;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: Math.max(0, WEEKDAYS.indexOf(wd)),
  };
}

/** Offset of `tz` from UTC at the given instant, in ms (positive east of UTC). */
export function tzOffsetMs(tsMs: number, tz: string): number {
  const p = localParts(tsMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  const secondsIntoMinute = Math.floor(tsMs / 1000) % 60;
  return asUtc - (tsMs - secondsIntoMinute * 1000 - (tsMs % 1000));
}

/** Instant (ms) for a wall-clock time in `tz`. Day may overflow (Date.UTC semantics). */
export function zonedToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1 = tzOffsetMs(guess, tz);
  const first = guess - off1;
  const off2 = tzOffsetMs(first, tz);
  return off2 === off1 ? first : guess - off2;
}

export function parseHHMM(at: string): { hour: number; minute: number } {
  const [h, m] = at.split(':');
  return { hour: Number(h), minute: Number(m) };
}

/** Latest `HH:MM` in `tz` that is <= now. */
export function previousDaily(at: string, tz: string, nowTs: number): number {
  const { hour, minute } = parseHHMM(at);
  const nowMs = nowTs * 1000;
  const p = localParts(nowMs, tz);
  let candidate = zonedToUtcMs(p.year, p.month, p.day, hour, minute, tz);
  if (candidate > nowMs) candidate = zonedToUtcMs(p.year, p.month, p.day - 1, hour, minute, tz);
  return Math.floor(candidate / 1000);
}

/** Latest `<weekday> HH:MM` in `tz` that is <= now. */
export function previousWeekly(day: Weekday, at: string, tz: string, nowTs: number): number {
  const { hour, minute } = parseHHMM(at);
  const nowMs = nowTs * 1000;
  const p = localParts(nowMs, tz);
  const back = (p.weekday - WEEKDAYS.indexOf(day) + 7) % 7;
  let candidate = zonedToUtcMs(p.year, p.month, p.day - back, hour, minute, tz);
  if (candidate > nowMs) {
    candidate = zonedToUtcMs(p.year, p.month, p.day - back - 7, hour, minute, tz);
  }
  return Math.floor(candidate / 1000);
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
