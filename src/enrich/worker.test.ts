import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Config, configSchema } from '../config/index.js';
import { ok } from '../shared/index.js';
import { type NewMessage, Store } from '../store/index.js';
import { createFakeSummarizer, type Summarizer } from '../summarizer/index.js';
import type { FetchPageDeps } from './links.js';
import { BACKOFF_S, createEnrichmentWorker, type EnrichmentWorkerOptions } from './worker.js';

const T = 'owner';
const G1 = '120363000000000001@g.us';
// 2026-09-04 22:00 PDT = 2026-09-05 05:00 UTC
const NOW = Date.UTC(2026, 8, 5, 5, 0) / 1000;
const LA_NEXT_MIDNIGHT = Date.UTC(2026, 8, 5, 7, 0) / 1000;

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

const html = (body: string, type = 'text/html') =>
  new Response(body, { status: 200, headers: { 'content-type': type } });

function fetchDeps(handler: (url: string) => Response | Promise<Response>): FetchPageDeps {
  return {
    fetchImpl: ((input: string | URL | Request) =>
      handler(String(input))) as unknown as typeof fetch,
    resolveHost: async () => ['93.184.216.34'],
  };
}

describe('enrichment worker', () => {
  let store: Store;
  let config: Config;
  let clock: number;
  let mediaDir: string;

  beforeEach(() => {
    store = new Store(':memory:');
    clock = NOW * 1000;
    mediaDir = mkdtempSync(join(tmpdir(), 'media-'));
    config = configSchema.parse({
      defaults: { summarizer: 'fake' },
      ingest: { describe_images: true, describe_links: true },
      groups: [{ jid: G1, name: 'Team' }],
    });
  });

  const factoryFor =
    (adapter: Summarizer): NonNullable<EnrichmentWorkerOptions['summarizerFactory']> =>
    () =>
      ok(adapter);

  const worker = (overrides: Partial<EnrichmentWorkerOptions> = {}) =>
    createEnrichmentWorker({
      tenantId: T,
      config,
      store,
      tz: 'America/Los_Angeles',
      now: () => clock,
      summarizerFactory: factoryFor(createFakeSummarizer()),
      fetchDeps: fetchDeps(() => html('<title>Page</title><p>Body text</p>')),
      ...overrides,
    });

  function imageFile(name = 'M1.jpg'): string {
    const path = join(mediaDir, name);
    writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff]));
    return path;
  }

  function queueImage(id = 'M1', path = imageFile(`${id}.jpg`)) {
    store.insertMessage(msg({ id, kind: 'image', body: 'cap' }));
    store.enqueueEnrichment({
      tenantId: T,
      id: `${id}:image`,
      groupJid: G1,
      messageId: id,
      kind: 'image',
      payload: path,
      createdTs: NOW - 30,
    });
    return path;
  }

  function queueLink(id: string, url: string, n = 0) {
    if (!store.getMessage(T, G1, id)) {
      store.insertMessage(msg({ id, body: `see ${url}` }));
      store.setLinks(T, G1, id, [{ url, title: null, description: null }]);
    } else {
      const row = store.getMessage(T, G1, id);
      store.setLinks(T, G1, id, [...(row?.links ?? []), { url, title: null, description: null }]);
    }
    store.enqueueEnrichment({
      tenantId: T,
      id: `${id}:link:${n}`,
      groupJid: G1,
      messageId: id,
      kind: 'link',
      payload: url,
      createdTs: NOW - 30,
    });
  }

  it('describes an image, stores the text, and deletes the file', async () => {
    const path = queueImage();
    const r = await worker().runOnce();
    expect(r).toEqual({ processed: 1, capped: false });
    expect(store.getMessage(T, G1, 'M1')?.mediaDescription).toBe('[fake image description]');
    expect(store.listEnrichments(T, 10)[0]).toMatchObject({ status: 'done', calledTs: NOW });
    expect(existsSync(path)).toBe(false);
  });

  it('keeps the image file when the group has ingest.media on', async () => {
    config = configSchema.parse({
      defaults: { summarizer: 'fake' },
      groups: [{ jid: G1, ingest: { media: true, describe_images: true } }],
    });
    const path = queueImage();
    await worker().runOnce();
    expect(existsSync(path)).toBe(true);
  });

  it('skips images when the adapter cannot see them, and drops the file', async () => {
    const blind: Summarizer = { ...createFakeSummarizer() };
    blind.describeImage = undefined;
    const path = queueImage();
    await worker({ summarizerFactory: factoryFor(blind) }).runOnce();
    expect(store.listEnrichments(T, 10)[0]).toMatchObject({
      status: 'skipped',
      error: expect.stringContaining('cannot describe images'),
    });
    expect(store.getMessage(T, G1, 'M1')?.mediaDescription).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('fetches a link, describes it, and merges into the message links in order', async () => {
    queueLink('M2', 'https://a.example/first', 0);
    queueLink('M2', 'https://b.example/second', 1);
    const w = worker({
      fetchDeps: fetchDeps((url) =>
        url.includes('b.example')
          ? html('<title>B page</title><p>About B</p>')
          : html('<title>A page</title><meta name="description" content="A desc"><p>About A</p>'),
      ),
    });
    // process the second job first to prove order comes from the message, not the queue
    await w.runOnce({ limit: 2 });
    expect(store.getMessage(T, G1, 'M2')?.links).toEqual([
      { url: 'https://a.example/first', title: 'A page', description: '[fake link description]' },
      { url: 'https://b.example/second', title: 'B page', description: '[fake link description]' },
    ]);
    expect(store.listEnrichments(T, 10).map((j) => j.status)).toEqual(['done', 'done']);
  });

  it('never fetches login-walled hosts', async () => {
    let fetched = 0;
    queueLink('M3', 'https://www.instagram.com/p/abc/');
    await worker({
      fetchDeps: fetchDeps(() => {
        fetched += 1;
        return html('x');
      }),
    }).runOnce();
    expect(fetched).toBe(0);
    expect(store.getMessage(T, G1, 'M3')?.links).toEqual([
      { url: 'https://www.instagram.com/p/abc/', title: null, description: null },
    ]);
    expect(store.listEnrichments(T, 10)[0]).toMatchObject({ status: 'done', calledTs: null });
  });

  it('stores a path-derived title and no description for non-HTML links', async () => {
    queueLink('M4', 'https://a.example/docs/annual-report.pdf');
    await worker({
      fetchDeps: fetchDeps(() => html('%PDF', 'application/pdf')),
    }).runOnce();
    expect(store.getMessage(T, G1, 'M4')?.links).toEqual([
      {
        url: 'https://a.example/docs/annual-report.pdf',
        title: 'annual report.pdf',
        description: null,
      },
    ]);
    expect(store.listEnrichments(T, 10)[0]).toMatchObject({ status: 'done', calledTs: null });
  });

  it('marks a link skipped when its host resolves to a private address', async () => {
    queueLink('M5', 'http://router.local/admin');
    await worker({
      fetchDeps: {
        fetchImpl: fetchDeps(() => html('x')).fetchImpl,
        resolveHost: async () => ['192.168.1.1'],
      },
    }).runOnce();
    expect(store.listEnrichments(T, 10)[0]).toMatchObject({
      status: 'skipped',
      error: expect.stringContaining('private or local address'),
    });
  });

  it('retries fetch failures with backoff and gives up after the last attempt', async () => {
    queueLink('M6', 'https://down.example/');
    const w = worker({
      fetchDeps: fetchDeps(() => {
        throw new Error('ECONNRESET');
      }),
    });
    for (const [i, delay] of BACKOFF_S.entries()) {
      await w.runOnce();
      expect(store.listEnrichments(T, 10)[0]).toMatchObject({
        status: 'queued',
        attempts: i + 1,
        nextAttemptTs: Math.floor(clock / 1000) + delay,
      });
      // not due yet
      expect(await w.runOnce()).toEqual({ processed: 0, capped: false });
      clock += delay * 1000;
    }
    await w.runOnce();
    expect(store.listEnrichments(T, 10)[0]).toMatchObject({
      status: 'failed',
      attempts: BACKOFF_S.length + 1,
      error: expect.stringContaining('ECONNRESET'),
    });
    expect(store.getMessage(T, G1, 'M6')?.links).toEqual([
      { url: 'https://down.example/', title: null, description: null },
    ]);
  });

  it('defers jobs to the next local midnight once the daily cap is reached', async () => {
    config = configSchema.parse({
      defaults: { summarizer: 'fake' },
      enrich: { max_per_day: 1 },
      groups: [{ jid: G1, ingest: { describe_images: true } }],
    });
    queueImage('A');
    queueImage('B');
    const w = worker();
    expect(await w.runOnce()).toEqual({ processed: 1, capped: true });
    const jobs = store.listEnrichments(T, 10);
    expect(jobs.find((j) => j.id === 'A:image')).toMatchObject({ status: 'done' });
    expect(jobs.find((j) => j.id === 'B:image')).toMatchObject({
      status: 'queued',
      attempts: 0,
      nextAttemptTs: LA_NEXT_MIDNIGHT,
    });
    expect(store.getMessage(T, G1, 'B')?.mediaDescription).toBeNull();

    clock = LA_NEXT_MIDNIGHT * 1000 + 1000;
    expect(await w.runOnce()).toEqual({ processed: 1, capped: false });
    expect(store.getMessage(T, G1, 'B')?.mediaDescription).toBe('[fake image description]');
  });

  it('skips jobs whose message was deleted or whose group is no longer configured', async () => {
    const path = queueImage('D');
    store.markDeleted(T, G1, 'D');
    await worker().runOnce();
    expect(store.listEnrichments(T, 10)[0]).toMatchObject({ status: 'skipped' });
    expect(existsSync(path)).toBe(false);

    config = configSchema.parse({ defaults: { summarizer: 'fake' } });
    queueImage('E');
    await worker().runOnce();
    expect(store.listEnrichments(T, 10).find((j) => j.id === 'E:image')).toMatchObject({
      status: 'skipped',
    });
  });

  it('drain processes one group until empty or the deadline passes', async () => {
    const slow: Summarizer = {
      ...createFakeSummarizer(),
      async describeImage() {
        await new Promise((r) => setTimeout(r, 40));
        return ok({ text: 'slow', model: null, durationMs: 40, costUsd: 0 });
      },
    };
    for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) queueImage(id);
    const other = '120363000000000002@g.us';
    store.insertMessage(msg({ id: 'X', groupJid: other, kind: 'image' }));
    store.enqueueEnrichment({
      tenantId: T,
      id: 'X:image',
      groupJid: other,
      messageId: 'X',
      kind: 'image',
      payload: imageFile('X.jpg'),
      createdTs: NOW - 30,
    });
    // real clock: the deadline has to actually pass
    const w = worker({ summarizerFactory: factoryFor(slow), now: () => Date.now() });
    const remaining = await w.drain(G1, 60);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(6);
    expect(store.pendingEnrichments(T, other)).toBe(1);

    expect(await w.drain(G1, 10_000)).toBe(0);
    expect(store.pendingEnrichments(T, other)).toBe(1);
  });

  it('polls on its own when started and stops cleanly', async () => {
    queueImage('P');
    const w = worker({ pollMs: 10 });
    w.start();
    await new Promise((r) => setTimeout(r, 80));
    w.stop();
    expect(store.getMessage(T, G1, 'P')?.mediaDescription).toBe('[fake image description]');
  });
});
