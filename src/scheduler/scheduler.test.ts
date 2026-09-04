import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Config, configSchema } from '../config/index.js';
import { Store } from '../store/index.js';
import { loadFixtureTranscript } from '../summarizer/fixtures.js';
import { createFakeSummarizer } from '../summarizer/index.js';
import { runDigest } from './run-digest.js';
import { startScheduler } from './scheduler.js';

const LA = 'America/Los_Angeles';
const G1 = '120363000000000001@g.us';
const G2 = '120363000000000002@g.us';
// Friday 2026-09-04 10:00 PDT
const NOW_MS = Date.UTC(2026, 8, 4, 17, 0);
const NOW = NOW_MS / 1000;
const TODAY_0800 = Date.UTC(2026, 8, 4, 15, 0) / 1000;

const fakeFactory = (name: string) =>
  name === 'fake' || name === 'cli-claude'
    ? ({ ok: true, value: createFakeSummarizer() } as const)
    : ({
        ok: false,
        error: { tag: 'unknown-adapter' as const, name, available: ['fake'] },
      } as const);

function seed(store: Store, jid: string, endTs: number, count = 25) {
  const rows = loadFixtureTranscript(jid).slice(0, count);
  const last = rows[rows.length - 1];
  if (!last) throw new Error('fixture empty');
  const shift = endTs - last.ts;
  store.upsertGroup({ tenantId: 'owner', jid, subject: 'Seeded', seenTs: endTs - 3 * 86_400 });
  for (const r of rows) store.insertMessage({ ...r, ts: r.ts + shift });
}

describe('scheduler', () => {
  let store: Store;
  let config: Config;
  let vaultDir: string;
  let clock: number;

  beforeEach(() => {
    store = new Store(':memory:');
    vaultDir = mkdtempSync(join(tmpdir(), 'vault-'));
    clock = NOW_MS;
    config = configSchema.parse({
      defaults: { summarizer: 'fake', cadence: { type: 'daily', at: '08:00', tz: LA } },
      groups: [
        { jid: G1, name: 'Team' },
        {
          jid: G2,
          name: 'Family',
          cadence: { type: 'threshold', messages: 10, max_hours: 24 },
          deliver: { self_dm: false },
        },
      ],
    });
  });

  const start = () =>
    startScheduler({
      tenantId: 'owner',
      config,
      store,
      vaultDir,
      tickMs: 3_600_000,
      now: () => clock,
      tz: 'UTC',
      summarizerFactory: fakeFactory,
    });

  it('runs a due daily digest once, records the run, and is quiet afterwards', async () => {
    seed(store, G1, NOW - 600);
    const s = start();
    const first = await s.tick();
    expect(first.find((o) => o.groupJid === G1)).toMatchObject({
      decision: { due: true },
      result: 'ok',
    });
    expect(store.queuedDeliveries('owner')).toHaveLength(1);
    expect(store.recentRuns('owner', G1, 0)).toHaveLength(1);
    expect(store.lastWatermark('owner', G1)?.watermarkTs).toBe(NOW - 600);

    const second = await s.tick();
    expect(second.find((o) => o.groupJid === G1)?.decision.due).toBe(false);
    expect(store.recentRuns('owner', G1, 0)).toHaveLength(1);
    s.stop();
  });

  it('records an empty run so an empty window does not re-fire every tick', async () => {
    store.upsertGroup({ tenantId: 'owner', jid: G1, seenTs: NOW - 3 * 86_400 });
    const s = start();
    expect((await s.tick()).find((o) => o.groupJid === G1)?.result).toBe('empty');
    const runs = store.recentRuns('owner', G1, 0);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('empty');
    expect((await s.tick()).find((o) => o.groupJid === G1)?.decision.due).toBe(false);
    s.stop();
  });

  it('starts the next window after the watermark', async () => {
    seed(store, G1, NOW - 600);
    const s = start();
    await s.tick();
    // next day: three new messages
    clock += 86_400_000;
    const t = Math.floor(clock / 1000);
    for (const i of [1, 2, 3]) {
      store.insertMessage({
        tenantId: 'owner',
        groupJid: G1,
        id: `N${i}`,
        senderJid: 'x@s.whatsapp.net',
        senderName: 'X',
        ts: t - 100 + i,
        kind: 'text',
        body: `new ${i}`,
      });
    }
    const out = await s.tick();
    expect(out.find((o) => o.groupJid === G1)?.result).toBe('ok');
    const runs = store.recentRuns('owner', G1, 0);
    expect(runs[0]?.messageCount).toBe(3);
    expect(runs[0]?.sinceTs).toBe(NOW - 600 + 1);
    s.stop();
  });

  it('fires threshold groups on count and respects deliver overrides', async () => {
    seed(store, G2, NOW - 60, 12);
    const s = start();
    const out = await s.tick();
    expect(out.find((o) => o.groupJid === G2)).toMatchObject({
      decision: { due: true },
      result: 'ok',
    });
    // self_dm disabled for Family → only the vault
    expect(store.queuedDeliveries('owner')).toHaveLength(0);
    expect(
      store.getDelivery('owner', store.recentRuns('owner', G2, 0)[0]?.summaryId ?? '', 'vault')
        ?.status,
    ).toBe('sent');
    s.stop();
  });

  it('handles /digest commands with a self-DM reply regardless of deliver config', async () => {
    seed(store, G2, NOW - 60, 5);
    const s = start();
    await s.handleCommand('/digest Family 1d');
    const queued = store.queuedDeliveries('owner');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toContain('🤖 Digest: Family');
    expect(store.recentRuns('owner', G2, 0)[0]?.trigger).toBe('command');

    await s.handleCommand('/digest Nope');
    expect(store.queuedDeliveries('owner').at(-1)?.text).toContain('Unknown group');
    await s.handleCommand('/help');
    expect(store.queuedDeliveries('owner').at(-1)?.text).toContain('/digest <group>');
    await s.handleCommand('not a command');
    expect(store.queuedDeliveries('owner')).toHaveLength(3);
    s.stop();
  });

  it('/digest with no args covers every group and reports empty ones', async () => {
    seed(store, G1, NOW - 60, 5);
    const s = start();
    await s.handleCommand('/digest');
    const texts = store.queuedDeliveries('owner').map((d) => d.text ?? '');
    expect(texts.some((t) => t.includes('🤖 Digest: Team'))).toBe(true);
    expect(texts.some((t) => t.includes('Family: no new messages'))).toBe(true);
    s.stop();
  });

  it('describe() reports state without running anything', () => {
    seed(store, G1, NOW - 600);
    const s = start();
    const d = s.describe();
    expect(d.map((x) => x.group.jid)).toEqual([G1, G2]);
    expect(d[0]?.decision).toMatchObject({ due: true, occurrenceTs: TODAY_0800 });
    expect(store.recentRuns('owner', G1, 0)).toHaveLength(0);
    s.stop();
  });
});

describe('runDigest', () => {
  it('records an error run and returns the adapter error', async () => {
    const store = new Store(':memory:');
    const config = configSchema.parse({ groups: [{ jid: G1, name: 'Team' }] });
    seed(store, G1, NOW - 60, 3);
    const group = {
      jid: G1,
      name: 'Team',
      summarizer: 'cli-claude',
      cadence: { type: 'manual' as const },
      deliver: { self_dm: true, group: false, vault: true },
      summary: { language: 'auto' as const, style: 'topics' as const, max_words: 100 },
    };
    const r = await runDigest({
      tenantId: 'owner',
      store,
      config,
      group,
      sinceTs: 0,
      untilTs: NOW,
      trigger: 'manual',
      tz: 'UTC',
      vaultDir: mkdtempSync(join(tmpdir(), 'v-')),
      summarizerFactory: () => ({
        ok: true,
        value: {
          name: 'x',
          summarize: async () => ({
            ok: false,
            error: { tag: 'timeout', bin: 'claude', timeoutMs: 1 },
          }),
        },
      }),
    });
    expect(r.ok).toBe(false);
    const runs = store.recentRuns('owner', G1, 0);
    expect(runs[0]).toMatchObject({ status: 'error', summaryId: null });
    expect(runs[0]?.error).toContain('did not finish');
  });
});
