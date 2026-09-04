import { beforeEach, describe, expect, it } from 'vitest';
import { err, ok } from '../shared/index.js';
import { Store } from '../store/index.js';
import { type OutboxHandle, startOutbox } from './outbox.js';
import type { Transport } from './types.js';

function fakeTransport(over: Partial<Transport> = {}) {
  const sent: Array<{ jid: string; text: string }> = [];
  const t: Transport & { sent: typeof sent } = {
    sent,
    isConnected: () => true,
    selfJid: () => 'me@s.whatsapp.net',
    async sendText(jid, text) {
      sent.push({ jid, text });
      return ok(undefined);
    },
    ...over,
  };
  return t;
}

const G = '120363000000000001@g.us';

describe('outbox', () => {
  let store: Store;
  let clock: number;
  let slept: number[];
  let handle: OutboxHandle | undefined;

  beforeEach(() => {
    store = new Store(':memory:');
    clock = 1_000_000_000_000;
    slept = [];
    handle?.stop();
  });

  const queue = (id: string, channel: 'self_dm' | 'group' | 'vault' = 'self_dm') =>
    store.putDelivery({
      tenantId: 'owner',
      summaryId: id,
      channel,
      status: 'queued',
      text: `msg ${id}`,
      target: channel === 'group' ? G : null,
      createdTs: Math.floor(clock / 1000),
    });

  const start = (transport: Transport, maxSendsPerDay = 30, allowGroup = false) => {
    handle = startOutbox({
      tenantId: 'owner',
      store,
      transport,
      maxSendsPerDay,
      isGroupPostAllowed: () => allowGroup,
      minGroupPostGapMs: 3_600_000,
      pollMs: 1_000_000, // never ticks on its own during tests
      jitterMs: [2000, 5000],
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      random: () => 0.5,
    });
    return handle;
  };

  it('is idle with nothing queued', async () => {
    const h = start(fakeTransport());
    expect(await h.drainOnce()).toEqual({ kind: 'idle' });
  });

  it('sends one queued self-DM with jitter and records it', async () => {
    const t = fakeTransport();
    const h = start(t);
    queue('s1');
    expect(await h.drainOnce()).toEqual({ kind: 'sent', summaryId: 's1', channel: 'self_dm' });
    expect(slept).toEqual([3500]);
    expect(t.sent).toEqual([{ jid: 'me@s.whatsapp.net', text: 'msg s1' }]);
    const row = store.getDelivery('owner', 's1', 'self_dm');
    expect(row?.status).toBe('sent');
    expect(row?.target).toBe('me@s.whatsapp.net');
    expect(row?.sentTs).toBe(Math.floor(clock / 1000));
    expect(await h.drainOnce()).toEqual({ kind: 'idle' });
  });

  it('waits while disconnected and when the self JID is unknown', async () => {
    queue('s1');
    let h = start(fakeTransport({ isConnected: () => false }));
    expect(await h.drainOnce()).toEqual({ kind: 'not-connected' });
    h.stop();
    h = start(fakeTransport({ selfJid: () => undefined }));
    expect(await h.drainOnce()).toEqual({ kind: 'not-connected' });
    expect(store.getDelivery('owner', 's1', 'self_dm')?.status).toBe('queued');
  });

  it('holds the queue at the daily cap', async () => {
    const t = fakeTransport();
    const h = start(t, 2);
    queue('a');
    queue('b');
    queue('c');
    expect((await h.drainOnce()).kind).toBe('sent');
    expect((await h.drainOnce()).kind).toBe('sent');
    expect(await h.drainOnce()).toEqual({ kind: 'capped', sentToday: 2 });
    expect(t.sent).toHaveLength(2);
    clock += 86_400_000 + 1000;
    expect((await h.drainOnce()).kind).toBe('sent');
  });

  it('retries failed sends and gives up after maxAttempts', async () => {
    const t = fakeTransport({
      async sendText() {
        return err({ tag: 'send', message: 'nope' });
      },
    });
    const h = start(t);
    queue('s1');
    for (let i = 1; i < 5; i += 1) {
      expect(await h.drainOnce()).toEqual({
        kind: 'failed',
        summaryId: 's1',
        channel: 'self_dm',
        permanent: false,
      });
      expect(store.getDelivery('owner', 's1', 'self_dm')?.attempts).toBe(i);
    }
    expect(await h.drainOnce()).toMatchObject({ kind: 'failed', permanent: true });
    expect(store.getDelivery('owner', 's1', 'self_dm')?.status).toBe('failed');
    expect(await h.drainOnce()).toEqual({ kind: 'idle' });
  });

  it('drops group rows unless the group is opted in at send time', async () => {
    const t = fakeTransport();
    const h = start(t);
    queue('g1', 'group');
    expect(await h.drainOnce()).toMatchObject({
      kind: 'failed',
      channel: 'group',
      permanent: true,
    });
    expect(store.getDelivery('owner', 'g1', 'group')?.error).toContain('not enabled');
    expect(t.sent).toEqual([]);
  });

  it('posts into an opted-in group and counts it against the daily cap', async () => {
    const t = fakeTransport();
    const h = start(t, 1, true);
    queue('g1', 'group');
    expect(await h.drainOnce()).toEqual({ kind: 'sent', summaryId: 'g1', channel: 'group' });
    expect(t.sent).toEqual([{ jid: G, text: 'msg g1' }]);
    queue('s1');
    expect(await h.drainOnce()).toEqual({ kind: 'capped', sentToday: 1 });
  });

  it('refuses a group row whose target is not a group JID', async () => {
    const t = fakeTransport();
    const h = start(t, 30, true);
    store.putDelivery({
      tenantId: 'owner',
      summaryId: 'bad',
      channel: 'group',
      status: 'queued',
      text: 'x',
      target: 'me@s.whatsapp.net',
      createdTs: 1,
    });
    expect(await h.drainOnce()).toMatchObject({ kind: 'failed', permanent: true });
    expect(store.getDelivery('owner', 'bad', 'group')?.error).toContain('not a group JID');
    expect(t.sent).toEqual([]);
  });

  it('spaces posts into the same group and lets self-DMs pass meanwhile', async () => {
    const t = fakeTransport();
    const h = start(t, 30, true);
    queue('g1', 'group');
    expect((await h.drainOnce()).kind).toBe('sent');
    queue('g2', 'group');
    clock += 1000;
    queue('s1');
    expect(await h.drainOnce()).toEqual({ kind: 'sent', summaryId: 's1', channel: 'self_dm' });
    expect(await h.drainOnce()).toEqual({ kind: 'held', count: 1 });
    clock += 3_600_000;
    expect(await h.drainOnce()).toEqual({ kind: 'sent', summaryId: 'g2', channel: 'group' });
    expect(t.sent.map((m) => m.jid)).toEqual([G, 'me@s.whatsapp.net', G]);
  });
});
