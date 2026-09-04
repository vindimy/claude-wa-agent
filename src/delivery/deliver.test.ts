import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Store, type SummaryRecord } from '../store/index.js';
import { deliverSummary } from './deliver.js';

const summary: SummaryRecord = {
  tenantId: 'owner',
  id: 'abc',
  groupJid: 'g@g.us',
  sinceTs: 1_756_800_000,
  untilTs: 1_756_990_000,
  watermarkTs: 1_756_980_000,
  watermarkId: 'M',
  messageCount: 2,
  adapter: 'fake',
  model: null,
  text: 'hello',
  createdTs: 1_756_990_100,
};

describe('deliverSummary', () => {
  let store: Store;
  let vaultDir: string;
  beforeEach(() => {
    store = new Store(':memory:');
    vaultDir = mkdtempSync(join(tmpdir(), 'vault-'));
  });

  const run = (deliver = { self_dm: true, vault: true, group: false }) =>
    deliverSummary({
      store,
      summary,
      deliver,
      vaultDir,
      render: { groupName: 'Team', tz: 'UTC' },
      nowTs: 1_756_990_200,
    });

  it('writes the vault note and queues the self-DM', () => {
    const outcomes = run();
    expect(outcomes).toEqual([
      { channel: 'vault', outcome: 'written', path: join(vaultDir, 'team/2025-09-04-abc.md') },
      { channel: 'self_dm', outcome: 'queued' },
    ]);
    expect(readFileSync(join(vaultDir, 'team/2025-09-04-abc.md'), 'utf8')).toContain('hello');
    const queued = store.queuedDeliveries('owner');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toContain('🤖 Digest: Team');
    expect(store.getDelivery('owner', 'abc', 'vault')?.status).toBe('sent');
  });

  it('is idempotent on a second call', () => {
    run();
    const again = run();
    expect(again).toEqual([
      { channel: 'vault', outcome: 'already', path: join(vaultDir, 'team/2025-09-04-abc.md') },
      { channel: 'self_dm', outcome: 'already', status: 'queued' },
    ]);
    expect(store.queuedDeliveries('owner')).toHaveLength(1);
  });

  it('re-queues a permanently failed self-DM', () => {
    run();
    store.markDeliveryFailed('owner', 'abc', 'self_dm', 'nope', true);
    expect(run()[1]).toEqual({ channel: 'self_dm', outcome: 'queued' });
    expect(store.getDelivery('owner', 'abc', 'self_dm')?.status).toBe('queued');
  });

  it('redoes every channel with force', () => {
    run();
    store.markDeliverySent('owner', 'abc', 'self_dm', 'me@s.whatsapp.net', 5);
    const outcomes = deliverSummary({
      store,
      summary: { ...summary, text: 'regenerated' },
      deliver: { self_dm: true, vault: true, group: false },
      vaultDir,
      render: { groupName: 'Team', tz: 'UTC' },
      nowTs: 9,
      force: true,
    });
    expect(outcomes.map((o) => o.outcome)).toEqual(['written', 'queued']);
    expect(readFileSync(join(vaultDir, 'team/2025-09-04-abc.md'), 'utf8')).toContain('regenerated');
    const dm = store.getDelivery('owner', 'abc', 'self_dm');
    expect(dm).toMatchObject({ status: 'queued', attempts: 0 });
    expect(dm?.text).toContain('regenerated');
  });

  it('never posts to the group even when configured', () => {
    const outcomes = run({ self_dm: false, vault: false, group: true });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ channel: 'group', outcome: 'skipped' });
    expect(store.getDelivery('owner', 'abc', 'group')).toBeUndefined();
    expect(existsSync(join(vaultDir, 'team'))).toBe(false);
  });

  it('reports a vault write error without touching the delivery row', () => {
    const outcomes = deliverSummary({
      store,
      summary,
      deliver: { self_dm: false, vault: true, group: false },
      vaultDir: '/dev/null/notadir',
      render: { groupName: 'Team', tz: 'UTC' },
      nowTs: 1,
    });
    expect(outcomes[0]).toMatchObject({ channel: 'vault', outcome: 'error' });
    expect(store.getDelivery('owner', 'abc', 'vault')).toBeUndefined();
  });
});
