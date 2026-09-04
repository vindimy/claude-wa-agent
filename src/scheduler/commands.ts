import { parseSince } from '../cli/since.js';
import type { Config } from '../config/index.js';

export type DigestCommand =
  | { kind: 'digest'; groupRef: string | undefined; sinceSpec: string | undefined }
  | { kind: 'help' }
  | { kind: 'invalid'; message: string };

/**
 * Parse an owner command typed into the self-chat.
 *   /digest                → every allow-listed group since its watermark
 *   /digest 3d             → every group over the last 3 days
 *   /digest Family         → one group since its watermark
 *   /digest Family 12h     → one group over 12 hours
 * The group may be quoted when its name has spaces: /digest "Zouk team" 2d
 */
export function parseCommand(text: string): DigestCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const tokens = tokenize(trimmed);
  const [cmd, ...rest] = tokens;
  if (!cmd) return undefined;
  const name = cmd.toLowerCase();
  if (name === '/help') return { kind: 'help' };
  if (name !== '/digest') return undefined;

  let groupRef: string | undefined;
  let sinceSpec: string | undefined;
  for (const t of rest) {
    if (sinceSpec === undefined && looksLikeSince(t)) sinceSpec = t;
    else if (groupRef === undefined) groupRef = t;
    else return { kind: 'invalid', message: `unexpected argument "${t}"` };
  }
  return { kind: 'digest', groupRef, sinceSpec };
}

function looksLikeSince(t: string): boolean {
  return /^\d+(?:\.\d+)?[mhdw]$/i.test(t) || (/^\d{4}-\d{2}-\d{2}/.test(t) && parseSince(t, 0).ok);
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export function helpText(config: Config): string {
  const groups = config.groups.map((g) => `- ${g.name ?? g.jid}`).join('\n');
  return [
    '🤖 Commands (send here, in your own chat):',
    '/digest — summarize every group since its last digest',
    '/digest 3d — every group over the last 3 days',
    '/digest <group> [12h|2d|1w] — one group',
    '',
    'Groups:',
    groups || '(none configured)',
  ].join('\n');
}
