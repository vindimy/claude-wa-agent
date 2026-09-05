import { parseSince } from '../cli/since.js';
import {
  type Config,
  SUMMARY_LANGUAGES,
  SUMMARY_STYLES,
  type SummaryOptions,
} from '../config/index.js';

/** Overrides typed after `/digest`; each maps onto a `digest summarize` flag. */
export interface DigestOptions {
  style?: SummaryOptions['style'];
  language?: SummaryOptions['language'];
  maxWords?: number;
  personality?: string;
  adapter?: string;
  instructions?: string;
}

export type DigestCommand =
  | {
      kind: 'digest';
      groupRef: string | undefined;
      sinceSpec: string | undefined;
      options: DigestOptions;
    }
  | { kind: 'ask'; groupRef: string; sinceSpec: string | undefined; question: string }
  | { kind: 'help' }
  | { kind: 'invalid'; message: string };

type OptionKey = keyof DigestOptions | 'since';

/** Accepted spellings: short chat keys, config.yaml keys, and CLI flag names. */
const OPTION_KEYS: Readonly<Record<string, OptionKey>> = {
  since: 'since',
  style: 'style',
  lang: 'language',
  language: 'language',
  words: 'maxWords',
  max_words: 'maxWords',
  'max-words': 'maxWords',
  voice: 'personality',
  personality: 'personality',
  via: 'adapter',
  adapter: 'adapter',
  note: 'instructions',
  instructions: 'instructions',
};

/**
 * Parse an owner command typed into the self-chat.
 *   /digest                → every allow-listed group since its watermark
 *   /digest 3d             → every group over the last 3 days
 *   /digest Family         → one group since its watermark
 *   /digest Family 12h     → one group over 12 hours
 * The group may be quoted when its name has spaces: /digest "Zouk team" 2d
 *
 * Options follow as key=value tokens or CLI-style flags, mirroring
 * `digest summarize`:
 *   /digest Family 2d style=narrative lang=ru words=150 voice=dry via=api-openai
 *   /digest Family --since 2d --style narrative --max-words 150
 * Quoted values keep their spaces: note="call out deadlines".
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
  const options: DigestOptions = {};
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] ?? '';
    const opt = splitOption(t);
    if (opt) {
      const key = OPTION_KEYS[opt.key.toLowerCase()];
      if (!key) return { kind: 'invalid', message: `unknown option "${opt.key}"` };
      let value = opt.value;
      if (value === undefined) {
        // `--style narrative`: the value is the next token.
        if (!opt.flag) return { kind: 'invalid', message: `missing value for "${opt.key}"` };
        value = rest[++i];
        if (value === undefined)
          return { kind: 'invalid', message: `missing value for --${opt.key}` };
      }
      if (key === 'since') {
        sinceSpec = value;
        continue;
      }
      const err = setOption(options, key, value);
      if (err) return { kind: 'invalid', message: err };
    } else if (sinceSpec === undefined && looksLikeSince(t)) sinceSpec = t;
    else if (groupRef === undefined) groupRef = t;
    else return { kind: 'invalid', message: `unexpected argument "${t}"` };
  }
  return { kind: 'digest', groupRef, sinceSpec, options };
}

/** `key=value`, `--key=value`, or `--key` (value in the next token). */
function splitOption(
  t: string,
): { key: string; value: string | undefined; flag: boolean } | undefined {
  const flag = t.startsWith('--');
  const body = flag ? t.slice(2) : t;
  const eq = body.indexOf('=');
  if (eq > 0) return { key: body.slice(0, eq), value: body.slice(eq + 1), flag };
  if (flag && body.length > 0) return { key: body, value: undefined, flag };
  return undefined;
}

function setOption(
  options: DigestOptions,
  key: keyof DigestOptions,
  value: string,
): string | undefined {
  switch (key) {
    case 'style':
      if (!(SUMMARY_STYLES as readonly string[]).includes(value))
        return `style must be one of ${SUMMARY_STYLES.join(', ')}`;
      options.style = value as SummaryOptions['style'];
      return undefined;
    case 'language':
      if (!(SUMMARY_LANGUAGES as readonly string[]).includes(value))
        return `language must be one of ${SUMMARY_LANGUAGES.join(', ')}`;
      options.language = value as SummaryOptions['language'];
      return undefined;
    case 'maxWords': {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return `words must be a positive number, got "${value}"`;
      options.maxWords = n;
      return undefined;
    }
    case 'personality':
    case 'adapter':
    case 'instructions':
      if (!value.trim()) return `empty value for ${key}`;
      options[key] = value.trim();
      return undefined;
  }
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

/** Split on whitespace, honouring quotes anywhere in a token: `"a b"`, `note="a b"`. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /([^\s"']*)"([^"]*)"|([^\s"']*)'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) {
    if (m[2] !== undefined) out.push((m[1] ?? '') + m[2]);
    else if (m[4] !== undefined) out.push((m[3] ?? '') + m[4]);
    else out.push(m[5] ?? '');
  }
  return out;
}

export function helpText(config: Config): string {
  const groups = config.groups.map((g) => `- ${g.name ?? g.jid}`).join('\n');
  return [
    '🤖 Commands (send here, in your own chat):',
    '/digest — summarize every group since its last digest',
    '/digest 3d — every group over the last 3 days',
    '/digest <group> [12h|2d|1w] — one group',
    'Options after that, key=value or --flag value: style=topics|narrative|action-items lang=en|ru|auto words=<n> voice=<personality> via=<adapter> note="extra guidance"',
    '/ask <group> [12h|2d|1w] <question> — answer from stored messages',
    'Replies come here only; nothing is posted into a group.',
    '',
    'Groups:',
    groups || '(none configured)',
  ].join('\n');
}
