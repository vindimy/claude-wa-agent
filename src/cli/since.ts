import { err, ok, type Result } from '../shared/index.js';

export interface BadSinceError {
  tag: 'bad-since';
  spec: string;
}

const UNIT_SECONDS: Record<string, number> = {
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 7 * 86_400,
};

/**
 * Parse a `--since` window into a unix-seconds lower bound.
 * Accepts relative spans (`30m`, `12h`, `2d`, `1w`) or an ISO date/datetime.
 */
export function parseSince(spec: string, nowTs: number): Result<number, BadSinceError> {
  const trimmed = spec.trim();
  const rel = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(trimmed);
  if (rel?.[1] && rel[2]) {
    const n = Number(rel[1]);
    const unit = UNIT_SECONDS[rel[2].toLowerCase()];
    if (unit && n > 0) return ok(Math.floor(nowTs - n * unit));
    return err({ tag: 'bad-since', spec });
  }
  const abs = Date.parse(trimmed);
  if (!Number.isNaN(abs)) return ok(Math.floor(abs / 1000));
  return err({ tag: 'bad-since', spec });
}
