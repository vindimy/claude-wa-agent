import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedGroupConfig } from '../config/index.js';
import { createLogger } from '../shared/index.js';
import type { NewMessage, Store } from '../store/index.js';
import { extractUrls } from './links.js';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface EnqueueInput {
  tenantId: string;
  store: Store;
  group: ResolvedGroupConfig;
  /** The message as just stored. */
  message: NewMessage;
  /** `data/tenants/<tenant>/media`; files go under `<group_jid>/`. */
  mediaDir: string;
  /**
   * For image messages: how to fetch the bytes. Only called when the group
   * has `describe_images` on, because the media keys are only in the raw
   * message at ingest time.
   */
  image?: { mimeType: string; download: () => Promise<Buffer> };
  nowTs: number;
}

export interface EnqueueOutcome {
  image: boolean;
  links: number;
}

/**
 * Queue the description jobs a freshly stored message needs, per the group's
 * ingest flags. A failed image download is logged and dropped; the caption
 * still stands. Links are pre-filled URL-only on the message so the
 * transcript keeps their order of appearance while the worker fills them in.
 */
export async function enqueueEnrichments(input: EnqueueInput): Promise<EnqueueOutcome> {
  const { tenantId, store, group, message, nowTs } = input;
  const log = createLogger('enrich', { tenant_id: tenantId });
  const outcome: EnqueueOutcome = { image: false, links: 0 };

  if (message.kind === 'image' && group.ingest.describe_images && input.image) {
    const ext = EXT_BY_MIME[input.image.mimeType.split(';')[0]?.trim().toLowerCase() ?? ''];
    if (!ext) {
      log.info(
        { group: group.jid, message_id: message.id, mimeType: input.image.mimeType },
        'unsupported image type, not described',
      );
    } else {
      try {
        const bytes = await input.image.download();
        const dir = join(input.mediaDir, group.jid);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${message.id}.${ext}`);
        writeFileSync(path, bytes);
        store.enqueueEnrichment({
          tenantId,
          id: `${message.id}:image`,
          groupJid: group.jid,
          messageId: message.id,
          kind: 'image',
          payload: path,
          createdTs: nowTs,
        });
        outcome.image = true;
        log.debug(
          { group: group.jid, message_id: message.id, bytes: bytes.length },
          'image queued',
        );
      } catch (e) {
        log.warn(
          { group: group.jid, message_id: message.id, err: e },
          'image download failed; keeping the caption only',
        );
      }
    }
  }

  if (group.ingest.describe_links) {
    outcome.links = queueLinks(store, tenantId, group.jid, message.id, message.body, nowTs);
  }
  return outcome;
}

/** Pre-fill URL-only link entries and queue one job per URL. Returns how many were queued. */
function queueLinks(
  store: Store,
  tenantId: string,
  groupJid: string,
  messageId: string,
  body: string | null,
  nowTs: number,
): number {
  const urls = extractUrls(body);
  if (urls.length === 0) return 0;
  store.setLinks(
    tenantId,
    groupJid,
    messageId,
    urls.map((url) => ({ url, title: null, description: null })),
  );
  urls.forEach((url, n) => {
    store.enqueueEnrichment({
      tenantId,
      id: `${messageId}:link:${n}`,
      groupJid,
      messageId,
      kind: 'link',
      payload: url,
      createdTs: nowTs,
    });
  });
  return urls.length;
}

export interface BackfillInput {
  tenantId: string;
  store: Store;
  group: ResolvedGroupConfig;
  sinceTs: number;
  nowTs: number;
}

/**
 * Queue link jobs for stored messages in a window that have no link entries
 * yet (`digest enrich --backfill-links`). Images cannot be backfilled: their
 * media keys are gone once the raw message is.
 */
export function backfillLinks(input: BackfillInput): number {
  const { tenantId, store, group, sinceTs, nowTs } = input;
  let queued = 0;
  for (const m of store.messagesSince(tenantId, group.jid, sinceTs)) {
    if (m.links.length > 0) continue;
    queued += queueLinks(store, tenantId, group.jid, m.id, m.body, nowTs);
  }
  return queued;
}
