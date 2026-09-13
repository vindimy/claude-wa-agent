import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Store, type SummaryRecord } from '../store/index.js';
import { deliverSummary } from './deliver.js';

const summary: SummaryRecord = {
  tenantId: 'owner',
  id: 'abc',
  groupJid: '120363000000000001@g.us',
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

  const run = (deliver = { self_dm: true, vault: true, group: false, to: [] }) =>
    deliverSummary({
      store,
      summary,
      deliver,
      vaultDir,
      render: { scopeName: 'Team', tz: 'UTC' },
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
      render: { scopeName: 'Team', tz: 'UTC' },
      nowTs: 9,
      force: true,
    });
    expect(outcomes.map((o) => o.outcome)).toEqual(['written', 'queued']);
    expect(readFileSync(join(vaultDir, 'team/2025-09-04-abc.md'), 'utf8')).toContain('regenerated');
    const dm = store.getDelivery('owner', 'abc', 'self_dm');
    expect(dm).toMatchObject({ status: 'queued', attempts: 0 });
    expect(dm?.text).toContain('regenerated');
  });

  it('queues a signed group post addressed to the source group', () => {
    const outcomes = run({ self_dm: false, vault: false, group: true, to: [] });
    expect(outcomes).toEqual([
      { channel: 'group', outcome: 'queued', target: '120363000000000001@g.us' },
    ]);
    const row = store.getDelivery('owner', 'abc', 'group');
    expect(row).toMatchObject({ status: 'queued', target: '120363000000000001@g.us' });
    expect(row?.text).toContain('🤖 Auto-digest');
    expect(row?.text).toContain('posted by a bot');
    expect(existsSync(join(vaultDir, 'team'))).toBe(false);
  });

  it('does not queue a second group post for the same summary', () => {
    run({ self_dm: false, vault: false, group: true, to: [] });
    store.markDeliverySent('owner', 'abc', 'group', '120363000000000001@g.us', 7);
    expect(run({ self_dm: false, vault: false, group: true, to: [] })).toEqual([
      { channel: 'group', outcome: 'already', status: 'sent' },
    ]);
  });

  it('refuses a group post whose JID is not a group', () => {
    const outcomes = deliverSummary({
      store,
      summary: { ...summary, groupJid: '15551234567@s.whatsapp.net' },
      deliver: { self_dm: false, vault: false, group: true },
      vaultDir,
      render: { scopeName: 'Team', tz: 'UTC' },
      nowTs: 1,
    });
    expect(outcomes[0]).toMatchObject({ channel: 'group', outcome: 'skipped' });
    expect(store.getDelivery('owner', 'abc', 'group')).toBeUndefined();
  });

  it('reports a vault write error without touching the delivery row', () => {
    const outcomes = deliverSummary({
      store,
      summary,
      deliver: { self_dm: false, vault: true, group: false },
      vaultDir: '/dev/null/notadir',
      render: { scopeName: 'Team', tz: 'UTC' },
      nowTs: 1,
    });
    expect(outcomes[0]).toMatchObject({ channel: 'vault', outcome: 'error' });
    expect(store.getDelivery('owner', 'abc', 'vault')).toBeUndefined();
  });

  const hub = { name: 'hub', kind: 'group' as const, jid: '120363000000000009@g.us' };
  const me = { name: 'me', kind: 'number' as const, jid: '13105551234@s.whatsapp.net' };

  it('queues one row per destination with the resolved target', () => {
    const outcomes = deliverSummary({
      store,
      summary,
      deliver: { self_dm: false, vault: false, group: false },
      destinations: [hub, me],
      vaultDir,
      render: { scopeName: 'Team', tz: 'UTC' },
      nowTs: 1_756_990_200,
    });
    expect(outcomes).toEqual([
      { channel: 'to', name: 'hub', outcome: 'queued', target: hub.jid },
      { channel: 'to', name: 'me', outcome: 'queued', target: me.jid },
    ]);
    const rows = store.queuedDeliveries('owner');
    expect(rows.map((r) => [r.channel, r.target])).toEqual([
      ['to:hub', hub.jid],
      ['to:me', me.jid],
    ]);
    expect(rows[0]?.text).toContain('🤖 Digest: Team');
    expect(rows[0]?.text).toContain('Automated digest of "Team"');
  });

  it('does not requeue a destination that is already queued or sent', () => {
    const args = {
      store,
      summary,
      deliver: { self_dm: false, vault: false, group: false },
      destinations: [hub],
      vaultDir,
      render: { scopeName: 'Team', tz: 'UTC' },
      nowTs: 1_756_990_200,
    };
    deliverSummary(args);
    expect(deliverSummary(args)).toEqual([
      { channel: 'to', name: 'hub', outcome: 'already', status: 'queued' },
    ]);
    store.markDeliverySent('owner', 'abc', 'to:hub', hub.jid, 1_756_990_300);
    expect(deliverSummary(args)).toEqual([
      { channel: 'to', name: 'hub', outcome: 'already', status: 'sent' },
    ]);
    expect(deliverSummary({ ...args, force: true })).toEqual([
      { channel: 'to', name: 'hub', outcome: 'queued', target: hub.jid },
    ]);
  });
});
