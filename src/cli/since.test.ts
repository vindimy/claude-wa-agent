import { describe, expect, it } from 'vitest';
import { parseSince } from './since.js';

const NOW = 1_757_000_000;

describe('parseSince', () => {
  it('parses relative spans', () => {
    expect(parseSince('30m', NOW)).toEqual({ ok: true, value: NOW - 1_800 });
    expect(parseSince('12h', NOW)).toEqual({ ok: true, value: NOW - 43_200 });
    expect(parseSince('2d', NOW)).toEqual({ ok: true, value: NOW - 172_800 });
    expect(parseSince('1w', NOW)).toEqual({ ok: true, value: NOW - 604_800 });
    expect(parseSince(' 1.5H ', NOW)).toEqual({ ok: true, value: NOW - 5_400 });
  });

  it('parses ISO dates and datetimes', () => {
    expect(parseSince('2025-09-01T00:00:00Z', NOW)).toEqual({ ok: true, value: 1_756_684_800 });
    const r = parseSince('2025-09-01', NOW);
    expect(r.ok).toBe(true);
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'yesterday', '0d', '2x', 'd2']) {
      const r = parseSince(bad, NOW);
      expect(r.ok, bad).toBe(false);
    }
  });
});
