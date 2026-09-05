import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { err, ok, type Result } from '../shared/index.js';
import type { EnrichError } from './errors.js';

/** How many links per message get their own description job. */
export const MAX_LINKS_PER_MESSAGE = 3;

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Distinct `http(s)` URLs in order of appearance, at most `max`. Trailing
 * punctuation that chat text tends to glue onto a link is dropped; a closing
 * bracket is kept only when the URL also opened one.
 */
export function extractUrls(
  body: string | null | undefined,
  max = MAX_LINKS_PER_MESSAGE,
): string[] {
  if (!body) return [];
  const out: string[] = [];
  for (const raw of body.match(URL_RE) ?? []) {
    const url = trimUrl(raw);
    if (!url || out.includes(url)) continue;
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return '';
    if ('.,;:!?\'"'.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')' && count(url, '(') < count(url, ')')) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ']' && count(url, '[') < count(url, ']')) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

/** Hosts that serve a login page to anonymous fetches; never fetched. */
export const LOGIN_WALLED_HOSTS: readonly string[] = [
  'instagram.com',
  'facebook.com',
  'fb.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'linkedin.com',
];

export function isLoginWalled(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOGIN_WALLED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export interface StrippedPage {
  title: string | null;
  description: string | null;
  /** Visible text with scripts, styles, navigation and chrome removed. */
  text: string;
}

const DROP_ELEMENTS = ['script', 'style', 'noscript', 'svg', 'template', 'nav', 'header', 'footer'];

/** Reduce an HTML (or plain text) document to what a reader would see. */
export function stripHtml(html: string, maxChars = 2000): StrippedPage {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
  const description =
    metaContent(html, 'name', 'description') ?? metaContent(html, 'property', 'og:description');
  let body = html.replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ');
  for (const el of DROP_ELEMENTS) {
    body = body.replace(new RegExp(`<${el}\\b[^>]*>[\\s\\S]*?<\\/${el}\\s*>`, 'gi'), ' ');
  }
  body = body.replace(/<[^>]+>/g, ' ');
  const text = collapse(decodeEntities(body)).slice(0, maxChars).trim();
  return { title: title || null, description, text };
}

function metaContent(html: string, attr: string, value: string): string | null {
  const tagRe = /<meta\b[^>]*>/gi;
  for (const tag of html.match(tagRe) ?? []) {
    const attrs = parseAttrs(tag);
    if (attrs[attr]?.toLowerCase() === value.toLowerCase()) {
      const content = attrs.content?.trim();
      if (content) return decodeEntities(content);
    }
  }
  return null;
}

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const m of tag.matchAll(re)) {
    const name = m[1]?.toLowerCase();
    if (name) out[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A human-ish title for a URL that was not (or could not be) fetched as HTML. */
export function titleFromPath(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const segment = u.pathname.split('/').filter(Boolean).at(-1);
  if (!segment) return u.hostname;
  try {
    return decodeURIComponent(segment).replace(/[-_]+/g, ' ').trim() || u.hostname;
  } catch {
    return segment;
  }
}

// --- SSRF guard ------------------------------------------------------------

/**
 * True for addresses a fetch from inside the owner's network must never
 * reach: loopback, RFC 1918, CGNAT, link-local, unspecified, and their IPv6
 * counterparts (including IPv4-mapped forms).
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true;
}

function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);
  const first = Number.parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

export interface FetchPageDeps {
  fetchImpl?: typeof fetch;
  /** Resolve a hostname to its addresses; defaults to the system resolver. */
  resolveHost?: (host: string) => Promise<string[]>;
}

export interface FetchPageOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
}

export interface FetchedPage {
  finalUrl: string;
  contentType: string;
  /** Decoded body for HTML and plain text; empty for anything else. */
  body: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 1_000_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const TEXT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

async function defaultResolve(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((f) => f.address);
}

async function guardHost(
  url: URL,
  resolveHost: (h: string) => Promise<string[]>,
): Promise<EnrichError | undefined> {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const blocked: EnrichError = { tag: 'blocked-address', url: url.href, host };
  if (host === 'localhost' || host.endsWith('.localhost')) return blocked;
  if (isIP(host)) return isBlockedAddress(host) ? blocked : undefined;
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch (e) {
    return { tag: 'fetch', url: url.href, message: `DNS lookup failed: ${describe(e)}` };
  }
  if (addresses.length === 0)
    return { tag: 'fetch', url: url.href, message: 'DNS lookup returned nothing' };
  return addresses.some(isBlockedAddress) ? blocked : undefined;
}

/**
 * Fetch one page the way a cautious browser would: a real user agent, an
 * HTML accept header, a wall-clock timeout, a redirect limit with every hop
 * checked against the private-address guard, and a body size cap.
 */
export async function fetchPage(
  url: string,
  deps: FetchPageDeps = {},
  opts: FetchPageOptions = {},
): Promise<Result<FetchedPage, EnrichError>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveHost = deps.resolveHost ?? defaultResolve;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return err({ tag: 'fetch', url, message: 'not a valid URL' });
  }
  const deadline = Date.now() + timeoutMs;

  for (let hop = 0; ; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return err({
        tag: 'fetch',
        url: current.href,
        message: `unsupported scheme ${current.protocol}`,
      });
    }
    const guard = await guardHost(current, resolveHost);
    if (guard) return err(guard);

    let response: Response;
    try {
      response = await fetchImpl(current.href, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          'accept-language': 'en,ru;q=0.8',
        },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch (e) {
      return err({ tag: 'fetch', url: current.href, message: describe(e) });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location)
        return err({
          tag: 'fetch',
          url: current.href,
          message: `redirect ${response.status} without location`,
        });
      if (hop >= maxRedirects)
        return err({
          tag: 'fetch',
          url: current.href,
          message: `more than ${maxRedirects} redirects`,
        });
      try {
        current = new URL(location, current);
      } catch {
        return err({ tag: 'fetch', url: current.href, message: `bad redirect target ${location}` });
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return err({ tag: 'fetch', url: current.href, message: `HTTP ${response.status}` });
    }

    const contentType =
      (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!TEXT_TYPES.includes(contentType)) {
      await response.body?.cancel().catch(() => {});
      return ok({ finalUrl: current.href, contentType, body: '' });
    }
    try {
      const body = await readCapped(response, maxBytes);
      return ok({ finalUrl: current.href, contentType, body });
    } catch (e) {
      return err({ tag: 'fetch', url: current.href, message: describe(e) });
    }
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = maxBytes - total;
    if (value.byteLength >= room) {
      chunks.push(value.subarray(0, room));
      total += room;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'timed out' : e.message;
  return String(e);
}
