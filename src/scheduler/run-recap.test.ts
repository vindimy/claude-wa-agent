import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema, resolveRecapConfig } from '../config/index.js';
import { ok } from '../shared/index.js';
import { Store } from '../store/index.js';
import { loadFixtureTranscript } from '../summarizer/fixtures.js';
import type { Summarizer, SummaryInput } from '../summarizer/index.js';
import { runRecap } from './run-recap.js';

const A = '120363000000000001@g.us';
const B = '120363000000000002@g.us';
const HUB = '120363000000000009@g.us';

function setup(extra: Record<string, unknown> = {}) {
  const store = new Store(':memory:');
  const a = loadFixtureTranscript(A).slice(0, 6);
  const b = loadFixtureTranscript(B).slice(6, 10);
  for (const g of [A, B]) store.upsertGroup({ tenantId: 'owner', jid: g, subject: g, seenTs: 1 });
  for (const r of [...a, ...b]) store.insertMessage(r);
  const lastTs = Math.max(...[...a, ...b].map((r) => r.ts));
  const config = configSchema.parse({
    defaults: { summarizer: 'fake', cadence: { type: 'daily', at: '08:00' } },
    destinations: { hub: { group: HUB } },
    groups: [
      { jid: A, name: 'Announcements' },
      { jid: B, name: 'Nerds' },
    ],
    recaps: [{ name: 'Zouk', sources: ['Announcements', 'Nerds'], deliver: { to: ['hub'] } }],
    ...extra,
  });
  const recap = resolveRecapConfig(config, 'Zouk');
  if (!recap) throw new Error('recap missing');
  const seen: SummaryInput[] = [];
  const capturing: Summarizer = {
    name: 'fake',
    async summarize(input) {
      seen.push(input);
      return ok({
        text: 'recap text',
        adapter: 'fake',
        model: null,
        messageCount: input.messages.length,
        inputChars: 1,
        durationMs: 1,
        costUsd: 0,
      });
    },
    async complete() {
      return ok({ text: 'x', model: null, durationMs: 1, costUsd: 0 });
    },
  };
  const vaultDir = mkdtempSync(join(tmpdir(), 'vault-'));
  const base = {
    tenantId: 'owner',
    store,
    config,
    recap,
    untilTs: lastTs + 1,
    trigger: 'weekly' as const,
    tz: 'UTC',
    vaultDir,
    summarizerFactory: () => ok(capturing),
  };
  return { store, config, recap, seen, base, a, b, vaultDir };
}

describe('runRecap', () => {
  it('summarizes every source in one call, sectioned in config order', async () => {
    const { seen, base, a, b } = setup();
    const result = await runRecap(base);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'ok') throw new Error('unexpected');
    expect(seen).toHaveLength(1);
    const input = seen[0];
    expect(input?.groupJid).toBe('recap:Zouk');
    expect(input?.groupName).toBe('Zouk');
    expect(input?.sections?.map((s) => [s.groupName, s.messages.length])).toEqual([
      ['Announcements', a.length],
      ['Nerds', b.length],
    ]);
    expect(input?.messages).toHaveLength(a.length + b.length);
    const ts = input?.messages.map((m) => m.ts) ?? [];
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);
    expect(result.value.summary.groupJid).toBe('recap:Zouk');
    expect(result.value.summary.messageCount).toBe(a.length + b.length);
  });

  it('records a run under the recap key and one watermark per source', async () => {
    const { store, base, a, b } = setup();
    await runRecap(base);
    const runs = store.recentRuns('owner', 'recap:Zouk', 0);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('ok');
    const wm = store.recapWatermarks('owner', 'Zouk');
    expect(wm.get(A)?.watermarkId).toBe(a[a.length - 1]?.id);
    expect(wm.get(B)?.watermarkId).toBe(b[b.length - 1]?.id);
    expect(store.lastWatermark('owner', A)).toBeUndefined();
  });

  it('reads each source from its own watermark and skips empty sources', async () => {
    const { store, base, seen, b } = setup();
    await runRecap(base);
    // Only B gets new messages after the first recap.
    const extra = loadFixtureTranscript(B)
      .slice(10, 12)
      .map((r, i) => ({ ...r, ts: base.untilTs + 10 + i }));
    for (const r of extra) store.insertMessage(r);
    const second = await runRecap({ ...base, untilTs: base.untilTs + 100 });
    if (!second.ok || second.value.kind !== 'ok') throw new Error('unexpected');
    expect(second.value.reused).toBe(false);
    expect(seen[1]?.sections?.map((s) => s.groupName)).toEqual(['Nerds']);
    expect(seen[1]?.messages).toHaveLength(2);
    expect(store.recapWatermarks('owner', 'Zouk').get(B)?.watermarkId).toBe(extra[1]?.id);
    expect(store.recapWatermarks('owner', 'Zouk').get(A)?.watermarkId).toBe(
      loadFixtureTranscript(A).slice(0, 6).at(-1)?.id,
    );
    expect(b.length).toBeGreaterThan(0);
  });

  it('returns empty when no source has messages', async () => {
    const { base } = setup();
    const result = await runRecap({ ...base, sinceTs: base.untilTs + 1 });
    expect(result).toEqual({ ok: true, value: { kind: 'empty' } });
  });

  it('reuses the stored summary for the same messages', async () => {
    const { base, seen } = setup();
    await runRecap({ ...base, sinceTs: 0 });
    const again = await runRecap({ ...base, sinceTs: 0 });
    if (!again.ok || again.value.kind !== 'ok') throw new Error('unexpected');
    expect(again.value.reused).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('delivers outward on a scheduled run and privately on demand', async () => {
    const { store, base } = setup();
    const scheduled = await runRecap(base);
    if (!scheduled.ok || scheduled.value.kind !== 'ok') throw new Error('unexpected');
    expect(scheduled.value.outcomes).toContainEqual({
      channel: 'to',
      name: 'hub',
      outcome: 'queued',
      target: HUB,
    });
    expect(
      store
        .queuedDeliveries('owner')
        .map((r) => r.channel)
        .sort(),
    ).toEqual(['self_dm', 'to:hub']);

    const fresh = setup();
    const manual = await runRecap({ ...fresh.base, trigger: 'manual' });
    if (!manual.ok || manual.value.kind !== 'ok') throw new Error('unexpected');
    expect(manual.value.outcomes).toContainEqual({
      channel: 'to',
      name: 'hub',
      outcome: 'skipped',
      reason: expect.stringContaining('--post'),
    });
    expect(fresh.store.queuedDeliveries('owner').map((r) => r.channel)).toEqual(['self_dm']);
  });

  it('writes the vault note under the recap slug with sources in the front matter', async () => {
    const { base, vaultDir } = setup();
    await runRecap(base);
    const files = readdirSync(join(vaultDir, 'zouk'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(vaultDir, 'zouk', files[0] ?? ''), 'utf8');
    expect(md).toContain('recap: "Zouk"');
    expect(md).toContain(`jid: "${A}"`);
  });

  it('dry run stores the summary but moves no watermark', async () => {
    const { store, base } = setup();
    const result = await runRecap({ ...base, dryRun: true });
    if (!result.ok || result.value.kind !== 'ok') throw new Error('unexpected');
    expect(store.getSummary('owner', result.value.summary.id)).toBeDefined();
    expect(store.recapWatermarks('owner', 'Zouk').size).toBe(0);
    expect(store.queuedDeliveries('owner')).toEqual([]);
  });
});
