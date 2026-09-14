import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema, PERSONALITY_PRESETS } from '../config/index.js';
import { ok } from '../shared/index.js';
import { Store } from '../store/index.js';
import { loadFixtureTranscript } from '../summarizer/fixtures.js';
import type { Summarizer, SummaryInput } from '../summarizer/index.js';
import { describeDigestError, runDigest } from './run-digest.js';

const G1 = '120363000000000001@g.us';

function setup(configRaw: Record<string, unknown>) {
  const store = new Store(':memory:');
  const rows = loadFixtureTranscript(G1);
  store.upsertGroup({ tenantId: 'owner', jid: G1, subject: 'Team', seenTs: rows[0]?.ts ?? 0 });
  for (const r of rows) store.insertMessage(r);
  const last = rows[rows.length - 1];
  if (!last) throw new Error('fixture empty');
  const config = configSchema.parse({ defaults: { summarizer: 'fake' }, ...configRaw });
  const seen: SummaryInput[] = [];
  const capturing: Summarizer = {
    name: 'fake',
    async summarize(input) {
      seen.push(input);
      return ok({
        text: 'summary',
        adapter: 'fake',
        model: null,
        messageCount: input.messages.length,
        inputChars: 1,
        durationMs: 1,
        costUsd: 0,
      });
    },
    async complete() {
      return ok({ text: 'answer', model: null, durationMs: 1, costUsd: 0 });
    },
  };
  const base = {
    tenantId: 'owner',
    store,
    config,
    sinceTs: 0,
    untilTs: last.ts + 1,
    trigger: 'manual' as const,
    tz: 'UTC',
    vaultDir: mkdtempSync(join(tmpdir(), 'vault-')),
    dryRun: true,
    summarizerFactory: () => ok(capturing),
  };
  return { store, config, seen, base };
}

describe('runDigest personality and instructions', () => {
  it('hands the adapter the resolved voice text and layered instructions', async () => {
    const { config, seen, base } = setup({
      defaults: { summary: { personality: 'dry', instructions: 'Flag deadlines.' } },
      personalities: { pirate: 'Arr, matey.' },
      groups: [
        {
          jid: G1,
          name: 'Team',
          summary: { personality: 'pirate', instructions: 'Kostya is the lead.' },
        },
      ],
    });
    const { resolveGroupConfig } = await import('../config/index.js');
    const group = resolveGroupConfig(config, G1);
    if (!group) throw new Error('group missing');
    const result = await runDigest({ ...base, group });
    expect(result.ok).toBe(true);
    expect(seen[0]?.personality).toBe('Arr, matey.');
    expect(seen[0]?.options.personality).toBe('pirate');
    expect(seen[0]?.options.instructions).toBe('Flag deadlines.\nKostya is the lead.');
  });

  it('lets a CLI override switch the personality and add instructions', async () => {
    const { config, seen, base } = setup({
      defaults: { summary: { instructions: 'Flag deadlines.' } },
      groups: [{ jid: G1, name: 'Team' }],
    });
    const { resolveGroupConfig } = await import('../config/index.js');
    const group = resolveGroupConfig(config, G1);
    if (!group) throw new Error('group missing');
    const result = await runDigest({
      ...base,
      group,
      summaryOptions: { personality: 'butler', instructions: 'Mention the weather.' },
    });
    expect(result.ok).toBe(true);
    expect(seen[0]?.personality).toBe(PERSONALITY_PRESETS.butler);
    expect(seen[0]?.options.instructions).toBe('Flag deadlines.\nMention the weather.');
  });

  it('rejects an unknown personality from the CLI before calling the adapter', async () => {
    const { config, seen, base } = setup({ groups: [{ jid: G1, name: 'Team' }] });
    const { resolveGroupConfig } = await import('../config/index.js');
    const group = resolveGroupConfig(config, G1);
    if (!group) throw new Error('group missing');
    const result = await runDigest({ ...base, group, summaryOptions: { personality: 'nope' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe('unknown-personality');
      expect(describeDigestError(result.error)).toContain('unknown personality "nope"');
      expect(describeDigestError(result.error)).toContain('neutral');
    }
    expect(seen).toHaveLength(0);
  });
});

describe('runDigest reuse', () => {
  it('records a run when a real run reuses a dry-run summary', async () => {
    const { config, store, base } = setup({ groups: [{ jid: G1, name: 'Team' }] });
    const { resolveGroupConfig } = await import('../config/index.js');
    const group = resolveGroupConfig(config, G1);
    if (!group) throw new Error('group missing');
    const dry = await runDigest({ ...base, group, dryRun: true });
    if (!dry.ok || dry.value.kind !== 'ok') throw new Error('unexpected');
    expect(store.recentRuns('owner', G1, 0)).toHaveLength(0);

    const real = await runDigest({ ...base, group, dryRun: false, trigger: 'daily' });
    if (!real.ok || real.value.kind !== 'ok') throw new Error('unexpected');
    expect(real.value.reused).toBe(true);
    const runs = store.recentRuns('owner', G1, 0);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'ok',
      trigger: 'daily',
      summaryId: dry.value.summary.id,
      costUsd: null,
      durationMs: null,
    });
    expect(store.lastWatermark('owner', G1)?.watermarkTs).toBe(dry.value.summary.watermarkTs);
  });
});

describe('runDigest destinations', () => {
  const HUB = '120363000000000009@g.us';
  const withDest = {
    destinations: { hub: { group: HUB }, me: { number: '+13105551234' } },
    groups: [{ jid: G1, name: 'Team', deliver: { to: ['hub', 'me'] } }],
  };

  it('queues destination rows on a scheduled run', async () => {
    const { config, store, base } = setup(withDest);
    const { resolveGroupConfig } = await import('../config/index.js');
    const group = resolveGroupConfig(config, G1);
    if (!group) throw new Error('group missing');
    const result = await runDigest({ ...base, group, dryRun: false, trigger: 'daily' });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'ok') throw new Error('unexpected');
    expect(result.value.outcomes).toContainEqual({
      channel: 'to',
      name: 'hub',
      outcome: 'queued',
      target: HUB,
    });
    expect(result.value.outcomes).toContainEqual({
      channel: 'to',
      name: 'me',
      outcome: 'queued',
      target: '13105551234@s.whatsapp.net',
    });
    expect(
      store
        .queuedDeliveries('owner')
        .map((r) => r.channel)
        .sort(),
    ).toEqual(['self_dm', 'to:hub', 'to:me']);
  });

  it('keeps an on-demand run private unless postOutward is set', async () => {
    const { config, store, base } = setup(withDest);
    const { resolveGroupConfig } = await import('../config/index.js');
    const group = resolveGroupConfig(config, G1);
    if (!group) throw new Error('group missing');
    const quiet = await runDigest({ ...base, group, dryRun: false, trigger: 'manual' });
    if (!quiet.ok || quiet.value.kind !== 'ok') throw new Error('unexpected');
    expect(quiet.value.outcomes.filter((o) => o.channel === 'to')).toEqual([
      { channel: 'to', name: 'hub', outcome: 'skipped', reason: expect.stringContaining('--post') },
      { channel: 'to', name: 'me', outcome: 'skipped', reason: expect.stringContaining('--post') },
    ]);
    expect(store.queuedDeliveries('owner').map((r) => r.channel)).toEqual(['self_dm']);

    const posted = await runDigest({
      ...base,
      group,
      dryRun: false,
      trigger: 'manual',
      postOutward: true,
    });
    if (!posted.ok || posted.value.kind !== 'ok') throw new Error('unexpected');
    expect(
      store
        .queuedDeliveries('owner')
        .map((r) => r.channel)
        .sort(),
    ).toEqual(['self_dm', 'to:hub', 'to:me']);
  });
});
