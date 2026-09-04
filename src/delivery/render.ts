import type { SummaryRecord } from '../store/index.js';
import { formatDay, formatTime } from '../summarizer/index.js';

export interface RenderContext {
  groupName: string;
  tz: string;
}

/** `example-group`; falls back to the JID's numeric part for empty names. */
export function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback.replace(/@.*$/, '');
}

function isoDate(ts: number, tz: string): string {
  return formatDay(ts, tz).slice(0, 10);
}

function windowLabel(s: SummaryRecord, tz: string): string {
  const from = isoDate(s.sinceTs, tz);
  const to = isoDate(s.untilTs, tz);
  return from === to ? from : `${from} → ${to}`;
}

/** Plain text for a WhatsApp message. Signed so nobody mistakes it for typing. */
export function renderWhatsAppText(s: SummaryRecord, ctx: RenderContext): string {
  const n = s.messageCount === 1 ? '1 message' : `${s.messageCount} messages`;
  return [`🤖 Digest: ${ctx.groupName}`, `${windowLabel(s, ctx.tz)} · ${n}`, '', s.text].join('\n');
}

/** Relative path inside the vault: `<group-slug>/<YYYY-MM-DD>-<id>.md`. */
export function vaultRelativePath(s: SummaryRecord, ctx: RenderContext): string {
  return `${slugify(ctx.groupName, s.groupJid)}/${isoDate(s.untilTs, ctx.tz)}-${s.id}.md`;
}

export function renderVaultMarkdown(s: SummaryRecord, ctx: RenderContext): string {
  const stamp = (ts: number) => `${formatDay(ts, ctx.tz)} ${formatTime(ts, ctx.tz)}`;
  const yamlStr = (v: string) => JSON.stringify(v);
  return [
    '---',
    `group: ${yamlStr(ctx.groupName)}`,
    `jid: ${yamlStr(s.groupJid)}`,
    `tenant: ${yamlStr(s.tenantId)}`,
    `summary_id: ${s.id}`,
    `window_from: ${yamlStr(stamp(s.sinceTs))}`,
    `window_to: ${yamlStr(stamp(s.untilTs))}`,
    `tz: ${yamlStr(ctx.tz)}`,
    `messages: ${s.messageCount}`,
    `adapter: ${s.adapter}`,
    `model: ${s.model ? yamlStr(s.model) : 'null'}`,
    `generated: ${yamlStr(new Date(s.createdTs * 1000).toISOString())}`,
    'tags: [whatsapp-digest]',
    '---',
    '',
    `# ${ctx.groupName} — ${windowLabel(s, ctx.tz)}`,
    '',
    s.text,
    '',
  ].join('\n');
}
