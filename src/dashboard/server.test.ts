import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Config, configSchema } from '../config/index.js';
import { startScheduler } from '../scheduler/index.js';
import { Store } from '../store/index.js';
import { loadFixtureTranscript } from '../summarizer/fixtures.js';
import { type DashboardHandle, startDashboard } from './server.js';

const G1 = '120363000000000001@g.us';
const NOW_MS = Date.UTC(2026, 8, 4, 17, 0);
const NOW = NOW_MS / 1000;

describe('dashboard server', () => {
  let store: Store;
  let config: Config;
  let handle: DashboardHandle;
  let stopScheduler: () => void;

  beforeEach(async () => {
    store = new Store(':memory:');
    config = configSchema.parse({
      defaults: { summarizer: 'fake', cadence: { type: 'daily', at: '08:00', tz: 'UTC' } },
      groups: [{ jid: G1, name: 'Team' }],
    });
    const rows = loadFixtureTranscript(G1);
    const last = rows[rows.length - 1];
    if (!last) throw new Error('fixture empty');
    const shift = NOW - 600 - last.ts;
    store.upsertGroup({ tenantId: 'owner', jid: G1, subject: 'Team chat', seenTs: NOW - 86_400 });
    for (const r of rows) store.insertMessage({ ...r, ts: r.ts + shift });
    store.insertQuestion({
      tenantId: 'owner',
      id: 'q1',
      groupJid: G1,
      question: 'Who?',
      answer: 'Lena.',
      sinceTs: 0,
      untilTs: NOW,
      messageCount: 3,
      adapter: 'fake',
      model: null,
      status: 'ok',
      error: null,
      costUsd: 0,
      durationMs: 1,
      createdTs: NOW - 10,
    });
    const scheduler = startScheduler({
      tenantId: 'owner',
      config,
      store,
      vaultDir: '/tmp/unused',
      tickMs: 3_600_000,
      now: () => NOW_MS,
      tz: 'UTC',
    });
    stopScheduler = () => scheduler.stop();
    handle = await startDashboard({
      tenantId: 'owner',
      config,
      store,
      host: '127.0.0.1',
      port: 0,
      describeSchedule: () => scheduler.describe(),
      getSessionState: () => 'connected',
      now: () => NOW_MS,
      tz: 'UTC',
    });
  });

  afterEach(async () => {
    await handle.stop();
    stopScheduler();
    store.close();
  });

  const get = (path: string) => fetch(`${handle.url}${path}`);

  it('serves the page at / with no external assets', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
  });

  it('reports status with the session state and send budget', async () => {
    const res = await get('/api/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      tenantId: 'owner',
      session: 'connected',
      sendsToday: 0,
      maxSendsPerDay: 30,
      retentionDays: 30,
      groupsConfigured: 1,
      nowTs: NOW,
    });
  });

  it('lists configured groups with store stats and schedule state', async () => {
    const body = (await (await get('/api/groups')).json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      jid: G1,
      name: 'Team',
      subject: 'Team chat',
      summarizer: 'fake',
      cadence: 'daily at 08:00 UTC',
      deliver: { self_dm: true, group: false, vault: true },
      messagesStored: 25,
      lastMessageTs: NOW - 600,
      due: { due: true },
    });
    expect(body[0]?.activity).toEqual(
      expect.arrayContaining([expect.objectContaining({ count: expect.any(Number) })]),
    );
  });

  it('serves runs, summaries, questions and outbox as JSON', async () => {
    expect(await (await get('/api/runs?limit=5')).json()).toEqual([]);
    expect(await (await get('/api/summaries')).json()).toEqual([]);
    const questions = (await (await get('/api/questions')).json()) as Array<
      Record<string, unknown>
    >;
    expect(questions[0]).toMatchObject({ question: 'Who?', answer: 'Lena.', groupName: 'Team' });
    expect(await (await get('/api/outbox')).json()).toEqual({ pending: [], recent: [] });
  });

  it('answers 404 for unknown paths and 405 for writes', async () => {
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/api/nope')).status).toBe(404);
    const res = await fetch(`${handle.url}/api/status`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
