import { parseSince } from '../cli/since.js';
import type { Config } from '../config/index.js';

export type DigestCommand =
  | { kind: 'digest'; groupRef: string | undefined; sinceSpec: string | undefined }
  | { kind: 'ask'; groupRef: string; sinceSpec: string | undefined; question: string }
  | { kind: 'help' }
  | { kind: 'invalid'; message: string };

/**
 * Parse an owner command typed into the self-chat.
 *   /digest                → every allow-listed group since its watermark
 *   /digest 3d             → every group over the last 3 days
 *   /digest Family         → one group since its watermark
 *   /digest Family 12h     → one group over 12 hours
 * The group may be quoted when its name has spaces: /digest "Zouk team" 2d
 *
 *   /ask Family when is the trip?      → answer from everything stored for the group
 *   /ask Family 2w when is the trip?   → answer from the last two weeks only
 * The group comes first (quoted if it has spaces), then an optional window,
 * then the question verbatim.
 */
export function parseCommand(text: string): DigestCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const tokens = tokenize(trimmed);
  const [cmd, ...rest] = tokens;
  if (!cmd) return undefined;
  const name = cmd.toLowerCase();
  if (name === '/help') return { kind: 'help' };
  if (name === '/ask') return parseAsk(trimmed);
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

/** `/ask <group> [window] <question…>`; the question is kept verbatim. */
function parseAsk(text: string): DigestCommand {
  const head = /^\/ask\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*/i.exec(text);
  const groupRef = head ? (head[1] ?? head[2] ?? head[3]) : undefined;
  if (!head || !groupRef) {
    return { kind: 'invalid', message: 'usage: /ask <group> [12h|2d|1w] <question>' };
  }
  let rest = text.slice(head[0].length);
  let sinceSpec: string | undefined;
  const first = /^(\S+)\s*/.exec(rest);
  if (first?.[1] && looksLikeSince(first[1])) {
    sinceSpec = first[1];
    rest = rest.slice(first[0].length);
  }
  const question = rest.trim();
  if (!question) return { kind: 'invalid', message: `no question after "/ask ${groupRef}"` };
  return { kind: 'ask', groupRef, sinceSpec, question };
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
    '/ask <group> [12h|2d|1w] <question> — answer from stored messages',
    'Replies come here only; nothing is posted into a group.',
    '',
    'Groups:',
    groups || '(none configured)',
  ].join('\n');
}
