import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { configSchema, resolveGroupConfig } from '../config/index.js';
import { type NewMessage, Store } from '../store/index.js';
import { backfillLinks, enqueueEnrichments } from './ingest.js';

const T = 'owner';
const G1 = '120363000000000001@g.us';
const NOW = 1_800_000_000;

function msg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    tenantId: T,
    groupJid: G1,
    id: 'M1',
    senderJid: '111@s.whatsapp.net',
    senderName: 'Alice',
    ts: NOW - 60,
    kind: 'text',
    body: 'hello',
    ...overrides,
  };
}

describe('enqueueEnrichments', () => {
  let store: Store;
  let mediaDir: string;

  beforeEach(() => {
    store = new Store(':memory:');
    mediaDir = mkdtempSync(join(tmpdir(), 'media-'));
  });

  const groupWith = (ingest: Record<string, boolean>) => {
    const config = configSchema.parse({ groups: [{ jid: G1, ingest }] });
    const group = resolveGroupConfig(config, G1);
    if (!group) throw new Error('group missing');
    return group;
  };

  it('downloads an image into the tenant media dir and queues an image job', async () => {
    const m = msg({ kind: 'image', body: 'look' });
    store.insertMessage(m);
    const r = await enqueueEnrichments({
      tenantId: T,
      store,
      group: groupWith({ describe_images: true }),
      message: m,
      mediaDir,
      image: { mimeType: 'image/png', download: async () => Buffer.from('PNGDATA') },
      nowTs: NOW,
    });
    expect(r).toEqual({ image: true, links: 0 });
    const job = store.listEnrichments(T, 10)[0];
    expect(job).toMatchObject({ id: 'M1:image', kind: 'image', messageId: 'M1', status: 'queued' });
    expect(job?.payload).toBe(join(mediaDir, G1, 'M1.png'));
    expect(readFileSync(job?.payload ?? '', 'utf8')).toBe('PNGDATA');
  });

  it('queues nothing for images when describe_images is off', async () => {
    let downloads = 0;
    const m = msg({ kind: 'image' });
    store.insertMessage(m);
    const r = await enqueueEnrichments({
      tenantId: T,
      store,
      group: groupWith({ describe_images: false, describe_links: true }),
      message: m,
      mediaDir,
      image: {
        mimeType: 'image/jpeg',
        download: async () => {
          downloads += 1;
          return Buffer.from('x');
        },
      },
      nowTs: NOW,
    });
    expect(r).toEqual({ image: false, links: 0 });
    expect(downloads).toBe(0);
    expect(store.listEnrichments(T, 10)).toEqual([]);
  });

  it('logs and moves on when the download fails; the caption still stands', async () => {
    const m = msg({ kind: 'image', body: 'caption' });
    store.insertMessage(m);
    const r = await enqueueEnrichments({
      tenantId: T,
      store,
      group: groupWith({ describe_images: true }),
      message: m,
      mediaDir,
      image: {
        mimeType: 'image/jpeg',
        download: async () => {
          throw new Error('media key expired');
        },
      },
      nowTs: NOW,
    });
    expect(r).toEqual({ image: false, links: 0 });
    expect(store.listEnrichments(T, 10)).toEqual([]);
    expect(existsSync(join(mediaDir, G1, 'M1.jpg'))).toBe(false);
    expect(store.getMessage(T, G1, 'M1')?.body).toBe('caption');
  });

  it('pre-fills URL-only links in order and queues one link job each, three at most', async () => {
    const m = msg({
      body: 'a https://a.example/1 b https://b.example/2 c https://c.example/3 d https://d.example/4',
    });
    store.insertMessage(m);
    const r = await enqueueEnrichments({
      tenantId: T,
      store,
      group: groupWith({ describe_links: true }),
      message: m,
      mediaDir,
      nowTs: NOW,
    });
    expect(r).toEqual({ image: false, links: 3 });
    expect(store.getMessage(T, G1, 'M1')?.links.map((l) => l.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ]);
    expect(
      store
        .listEnrichments(T, 10)
        .map((j) => [j.id, j.payload])
        .sort(),
    ).toEqual([
      ['M1:link:0', 'https://a.example/1'],
      ['M1:link:1', 'https://b.example/2'],
      ['M1:link:2', 'https://c.example/3'],
    ]);
  });

  it('also finds links in an image caption', async () => {
    const m = msg({ kind: 'image', body: 'menu https://cafe.example/menu' });
    store.insertMessage(m);
    const r = await enqueueEnrichments({
      tenantId: T,
      store,
      group: groupWith({ describe_links: true }),
      message: m,
      mediaDir,
      nowTs: NOW,
    });
    expect(r).toEqual({ image: false, links: 1 });
  });
});

describe('backfillLinks', () => {
  it('queues link jobs for stored messages in the window that have none yet', () => {
    const store = new Store(':memory:');
    const config = configSchema.parse({ groups: [{ jid: G1, ingest: { describe_links: true } }] });
    const group = resolveGroupConfig(config, G1);
    if (!group) throw new Error('group missing');
    store.insertMessage(msg({ id: 'OLD', ts: NOW - 10_000, body: 'https://old.example/' }));
    store.insertMessage(msg({ id: 'A', ts: NOW - 100, body: 'https://a.example/ and text' }));
    store.insertMessage(msg({ id: 'B', ts: NOW - 90, body: 'no links here' }));
    store.insertMessage(msg({ id: 'C', ts: NOW - 80, body: 'https://c.example/' }));
    store.setLinks(T, G1, 'C', [{ url: 'https://c.example/', title: 'C', description: 'done' }]);
    store.insertMessage(msg({ id: 'D', ts: NOW - 70, body: 'https://d.example/' }));
    store.markDeleted(T, G1, 'D');

    const queued = backfillLinks({ tenantId: T, store, group, sinceTs: NOW - 1000, nowTs: NOW });
    expect(queued).toBe(1);
    expect(store.listEnrichments(T, 10).map((j) => j.id)).toEqual(['A:link:0']);
    expect(store.getMessage(T, G1, 'A')?.links).toEqual([
      { url: 'https://a.example/', title: null, description: null },
    ]);
    // a second backfill is a no-op
    expect(backfillLinks({ tenantId: T, store, group, sinceTs: NOW - 1000, nowTs: NOW })).toBe(0);
  });
});
