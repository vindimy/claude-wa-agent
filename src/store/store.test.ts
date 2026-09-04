import { beforeEach, describe, expect, it } from 'vitest';
import {
  type NewMessage,
  type QuestionRecord,
  type RunRecord,
  Store,
  type SummaryRecord,
  summaryId,
} from './store.js';

const T = 'owner';

function msg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    tenantId: T,
    groupJid: 'g1@g.us',
    id: 'MSG1',
    senderJid: '111@s.whatsapp.net',
    senderName: 'Alice',
    ts: 1_700_000_000,
    kind: 'text',
    body: 'hello',
    ...overrides,
  };
}

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  it('inserts and reads back a message', () => {
    store.insertMessage(msg());
    const row = store.getMessage(T, 'g1@g.us', 'MSG1');
    expect(row?.body).toBe('hello');
    expect(row?.deleted).toBe(false);
    expect(row?.editedTs).toBeNull();
  });

  it('ignores redelivery of the same message id', () => {
    store.insertMessage(msg());
    store.insertMessage(msg({ body: 'changed on redelivery' }));
    expect(store.getMessage(T, 'g1@g.us', 'MSG1')?.body).toBe('hello');
    expect(store.countMessages(T, 'g1@g.us')).toBe(1);
  });

  it('applies edits to body and edited_ts', () => {
    store.insertMessage(msg());
    store.applyEdit(T, 'g1@g.us', 'MSG1', 'hello, edited', 1_700_000_100);
    const row = store.getMessage(T, 'g1@g.us', 'MSG1');
    expect(row?.body).toBe('hello, edited');
    expect(row?.editedTs).toBe(1_700_000_100);
  });

  it('marks messages deleted and excludes them from queries', () => {
    store.insertMessage(msg());
    store.insertMessage(msg({ id: 'MSG2', body: 'second' }));
    store.markDeleted(T, 'g1@g.us', 'MSG1');
    expect(store.getMessage(T, 'g1@g.us', 'MSG1')?.deleted).toBe(true);
    expect(store.countMessages(T, 'g1@g.us')).toBe(1);
    expect(store.messagesSince(T, 'g1@g.us', 0).map((m) => m.id)).toEqual(['MSG2']);
  });

  it('filters messagesSince by timestamp', () => {
    store.insertMessage(msg({ id: 'A', ts: 100 }));
    store.insertMessage(msg({ id: 'B', ts: 200 }));
    store.insertMessage(msg({ id: 'C', ts: 300 }));
    expect(store.messagesSince(T, 'g1@g.us', 200).map((m) => m.id)).toEqual(['B', 'C']);
    expect(store.countMessages(T, 'g1@g.us', 200)).toBe(2);
  });

  it('upserts groups, keeping first_seen and refreshing metadata', () => {
    store.upsertGroup({ tenantId: T, jid: 'g1@g.us', subject: 'Old name', seenTs: 100 });
    store.upsertGroup({
      tenantId: T,
      jid: 'g1@g.us',
      subject: 'New name',
      participantCount: 5,
      seenTs: 200,
    });
    store.upsertGroup({ tenantId: T, jid: 'g1@g.us', seenTs: 300 }); // no subject — must not erase it
    const groups = store.listGroups(T);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.subject).toBe('New name');
    expect(groups[0]?.participantCount).toBe(5);
    expect(groups[0]?.firstSeenTs).toBe(100);
    expect(groups[0]?.lastSeenTs).toBe(300);
  });

  it('counts messages per group in listGroups', () => {
    store.upsertGroup({ tenantId: T, jid: 'g1@g.us', seenTs: 100 });
    store.upsertGroup({ tenantId: T, jid: 'g2@g.us', seenTs: 100 });
    store.insertMessage(msg({ id: 'A' }));
    store.insertMessage(msg({ id: 'B', ts: 1_700_000_050 }));
    const groups = store.listGroups(T);
    const g1 = groups.find((g) => g.jid === 'g1@g.us');
    const g2 = groups.find((g) => g.jid === 'g2@g.us');
    expect(g1?.messageCount).toBe(2);
    expect(g1?.lastMessageTs).toBe(1_700_000_050);
    expect(g2?.messageCount).toBe(0);
    expect(g2?.lastMessageTs).toBeNull();
  });

  it('never leaks rows across tenants', () => {
    store.upsertGroup({ tenantId: T, jid: 'g1@g.us', subject: 'Owner group', seenTs: 1 });
    store.upsertGroup({ tenantId: 'acme', jid: 'g1@g.us', subject: 'Acme group', seenTs: 1 });
    store.insertMessage(msg({ id: 'A' }));
    store.insertMessage(msg({ id: 'A', tenantId: 'acme', body: 'acme copy' }));
    store.insertMessage(msg({ id: 'B', tenantId: 'acme' }));

    expect(store.listGroups(T).map((g) => g.subject)).toEqual(['Owner group']);
    expect(store.listGroups('acme')[0]?.messageCount).toBe(2);
    expect(store.countMessages(T, 'g1@g.us')).toBe(1);
    expect(store.getMessage('acme', 'g1@g.us', 'A')?.body).toBe('acme copy');
    expect(store.messagesSince('nobody', 'g1@g.us', 0)).toEqual([]);

    store.markDeleted('acme', 'g1@g.us', 'A');
    store.applyEdit('acme', 'g1@g.us', 'B', 'edited', 5);
    expect(store.getMessage(T, 'g1@g.us', 'A')?.deleted).toBe(false);
    expect(store.getMessage(T, 'g1@g.us', 'B')).toBeUndefined();
  });
});

describe('Store: summaries, runs, deliveries', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  const summary = (overrides: Partial<SummaryRecord> = {}): SummaryRecord => ({
    tenantId: T,
    id: 'abc123',
    groupJid: 'g1@g.us',
    sinceTs: 100,
    untilTs: 200,
    watermarkTs: 190,
    watermarkId: 'M9',
    messageCount: 3,
    adapter: 'fake',
    model: null,
    text: 'summary text',
    createdTs: 200,
    ...overrides,
  });

  it('derives a stable summary id from the first and last message', () => {
    const b = {
      tenantId: T,
      groupJid: 'g1@g.us',
      firstTs: 100,
      firstId: 'M1',
      lastTs: 190,
      lastId: 'M9',
    };
    const a = summaryId(b);
    expect(a).toBe(summaryId({ ...b }));
    expect(a).toHaveLength(16);
    expect(a).not.toBe(summaryId({ ...b, tenantId: 'acme' }));
    expect(a).not.toBe(summaryId({ ...b, lastId: 'M10' }));
    expect(a).not.toBe(summaryId({ ...b, firstId: 'M2', firstTs: 101 }));
  });

  it('upserts summaries, replacing text on conflict', () => {
    store.upsertSummary(summary());
    store.upsertSummary(summary({ text: 'regenerated', model: 'sonnet' }));
    const got = store.getSummary(T, 'abc123');
    expect(got?.text).toBe('regenerated');
    expect(got?.model).toBe('sonnet');
    expect(store.getSummary('acme', 'abc123')).toBeUndefined();
  });

  it('records runs and exposes the last delivered watermark', () => {
    const run = (o: Partial<RunRecord>): RunRecord => ({
      tenantId: T,
      id: o.id ?? 'r',
      groupJid: 'g1@g.us',
      trigger: 'manual',
      dryRun: false,
      sinceTs: 0,
      untilTs: 10,
      messageCount: 1,
      watermarkTs: 5,
      watermarkId: 'A',
      summaryId: 'abc123',
      adapter: 'fake',
      model: null,
      status: 'ok',
      error: null,
      costUsd: 0,
      durationMs: 1,
      createdTs: 10,
      ...o,
    });
    expect(store.lastWatermark(T, 'g1@g.us')).toBeUndefined();
    store.insertRun(run({ id: 'r1', watermarkTs: 5, watermarkId: 'A' }));
    store.insertRun(run({ id: 'r2', watermarkTs: 9, watermarkId: 'B', dryRun: true }));
    store.insertRun(run({ id: 'r3', watermarkTs: 8, watermarkId: 'C', status: 'error' }));
    store.insertRun(run({ id: 'r4', watermarkTs: 7, watermarkId: 'D' }));
    expect(store.lastWatermark(T, 'g1@g.us')).toEqual({ watermarkTs: 7, watermarkId: 'D' });
    expect(store.lastWatermark('acme', 'g1@g.us')).toBeUndefined();
  });

  it('tracks deliveries per channel with sent/failed transitions', () => {
    store.putDelivery({
      tenantId: T,
      summaryId: 'abc123',
      channel: 'self_dm',
      status: 'queued',
      text: 'hello',
      createdTs: 1,
    });
    expect(store.queuedDeliveries(T).map((d) => d.channel)).toEqual(['self_dm']);
    expect(store.queuedDeliveries('acme')).toEqual([]);

    store.markDeliveryFailed(T, 'abc123', 'self_dm', 'boom', false);
    let d = store.getDelivery(T, 'abc123', 'self_dm');
    expect(d?.status).toBe('queued');
    expect(d?.attempts).toBe(1);
    expect(d?.error).toBe('boom');

    store.markDeliverySent(T, 'abc123', 'self_dm', 'me@s.whatsapp.net', 50);
    d = store.getDelivery(T, 'abc123', 'self_dm');
    expect(d?.status).toBe('sent');
    expect(d?.target).toBe('me@s.whatsapp.net');
    expect(d?.sentTs).toBe(50);
    expect(store.queuedDeliveries(T)).toEqual([]);

    store.markDeliveryFailed(T, 'abc123', 'self_dm', 'perm', true);
    expect(store.getDelivery(T, 'abc123', 'self_dm')?.status).toBe('failed');

    // re-queue resets attempts and error
    store.putDelivery({
      tenantId: T,
      summaryId: 'abc123',
      channel: 'self_dm',
      status: 'queued',
      text: 'hello again',
      createdTs: 60,
    });
    d = store.getDelivery(T, 'abc123', 'self_dm');
    expect(d).toMatchObject({ status: 'queued', attempts: 0, error: null, text: 'hello again' });
  });

  it('counts WhatsApp sends in a window, ignoring vault rows and other tenants', () => {
    const put = (tenantId: string, summaryId: string, channel: 'self_dm' | 'vault' | 'group') =>
      store.putDelivery({
        tenantId,
        summaryId,
        channel,
        status: 'sent',
        createdTs: 1,
        sentTs: 100,
      });
    put(T, 's1', 'self_dm');
    put(T, 's2', 'group');
    put(T, 's3', 'vault');
    put('acme', 's4', 'self_dm');
    store.putDelivery({
      tenantId: T,
      summaryId: 's5',
      channel: 'self_dm',
      status: 'sent',
      createdTs: 1,
      sentTs: 10,
    });
    expect(store.countSentSince(T, 50)).toBe(2);
    expect(store.countSentSince(T, 0)).toBe(3);
  });

  it('reports the last send to a target per channel and tenant', () => {
    const put = (tenantId: string, summaryId: string, target: string, sentTs: number) =>
      store.putDelivery({
        tenantId,
        summaryId,
        channel: 'group',
        status: 'sent',
        target,
        createdTs: 1,
        sentTs,
      });
    put(T, 'a', 'g1@g.us', 100);
    put(T, 'b', 'g1@g.us', 300);
    put(T, 'c', 'g2@g.us', 900);
    put('acme', 'd', 'g1@g.us', 5000);
    store.putDelivery({
      tenantId: T,
      summaryId: 'q',
      channel: 'group',
      status: 'queued',
      target: 'g1@g.us',
      createdTs: 1,
    });
    expect(store.lastSentTs(T, 'group', 'g1@g.us')).toBe(300);
    expect(store.lastSentTs(T, 'group', 'g2@g.us')).toBe(900);
    expect(store.lastSentTs(T, 'group', 'g3@g.us')).toBeUndefined();
    expect(store.lastSentTs(T, 'self_dm', 'g1@g.us')).toBeUndefined();
  });
});

describe('Store: retention', () => {
  it('prunes only this tenant’s messages older than the cutoff', () => {
    const store = new Store(':memory:');
    const msg = (tenantId: string, id: string, ts: number) =>
      store.insertMessage({
        tenantId,
        groupJid: 'g@g.us',
        id,
        senderJid: 's@s.whatsapp.net',
        senderName: 'S',
        ts,
        kind: 'text',
        body: 'x',
      });
    msg(T, 'old', 100);
    msg(T, 'edge', 500);
    msg(T, 'new', 900);
    msg('acme', 'old', 100);
    expect(store.pruneMessagesBefore(T, 500)).toBe(1);
    expect(store.messagesSince(T, 'g@g.us', 0).map((m) => m.id)).toEqual(['edge', 'new']);
    expect(store.messagesSince('acme', 'g@g.us', 0)).toHaveLength(1);
    expect(store.pruneMessagesBefore(T, 500)).toBe(0);
  });
});

describe('Store: scheduler helpers', () => {
  it('returns recent non-dry runs newest first and looks up a group', () => {
    const store = new Store(':memory:');
    const base: RunRecord = {
      tenantId: T,
      id: 'a',
      groupJid: 'g1@g.us',
      trigger: 'daily',
      dryRun: false,
      sinceTs: 0,
      untilTs: 1,
      messageCount: 0,
      watermarkTs: null,
      watermarkId: null,
      summaryId: null,
      adapter: 'fake',
      model: null,
      status: 'empty',
      error: null,
      costUsd: null,
      durationMs: null,
      createdTs: 100,
    };
    store.insertRun(base);
    store.insertRun({ ...base, id: 'b', createdTs: 300, status: 'ok' });
    store.insertRun({ ...base, id: 'c', createdTs: 200, dryRun: true });
    store.insertRun({ ...base, id: 'd', createdTs: 400, tenantId: 'acme' });
    expect(store.recentRuns(T, 'g1@g.us', 0).map((r) => r.id)).toEqual(['b', 'a']);
    expect(store.recentRuns(T, 'g1@g.us', 250).map((r) => r.id)).toEqual(['b']);
    expect(store.recentRuns(T, 'g1@g.us', 0)[0]?.status).toBe('ok');

    store.upsertGroup({ tenantId: T, jid: 'g1@g.us', subject: 'One', seenTs: 5 });
    expect(store.getGroup(T, 'g1@g.us')?.firstSeenTs).toBe(5);
    expect(store.getGroup('acme', 'g1@g.us')).toBeUndefined();
  });
});

describe('Store: questions', () => {
  const question = (overrides: Partial<QuestionRecord> = {}): QuestionRecord => ({
    tenantId: T,
    id: 'q1',
    groupJid: 'g1@g.us',
    question: 'Who owns the deck?',
    answer: 'Lena does.',
    sinceTs: 0,
    untilTs: 200,
    messageCount: 12,
    adapter: 'fake',
    model: null,
    status: 'ok',
    error: null,
    costUsd: 0,
    durationMs: 5,
    createdTs: 200,
    ...overrides,
  });

  it('records questions and lists them newest first per tenant', () => {
    const store = new Store(':memory:');
    store.insertQuestion(question({ id: 'q1', createdTs: 100 }));
    store.insertQuestion(
      question({ id: 'q2', createdTs: 300, answer: null, status: 'error', error: 'boom' }),
    );
    store.insertQuestion(question({ id: 'q3', tenantId: 'acme', createdTs: 400 }));
    const got = store.listQuestions(T, 10);
    expect(got.map((q) => q.id)).toEqual(['q2', 'q1']);
    expect(got[0]).toMatchObject({ status: 'error', error: 'boom', answer: null });
    expect(got[1]).toMatchObject({
      question: 'Who owns the deck?',
      answer: 'Lena does.',
      costUsd: 0,
    });
    expect(store.listQuestions(T, 1)).toHaveLength(1);
    expect(store.listQuestions('acme', 10).map((q) => q.id)).toEqual(['q3']);
  });

  it('never advances a group watermark', () => {
    const store = new Store(':memory:');
    store.insertQuestion(question());
    expect(store.lastWatermark(T, 'g1@g.us')).toBeUndefined();
  });
});

describe('Store: dashboard reads', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  const run = (o: Partial<RunRecord>): RunRecord => ({
    tenantId: T,
    id: o.id ?? 'r',
    groupJid: 'g1@g.us',
    trigger: 'daily',
    dryRun: false,
    sinceTs: 0,
    untilTs: 10,
    messageCount: 1,
    watermarkTs: 9,
    watermarkId: 'M',
    summaryId: 's',
    adapter: 'fake',
    model: null,
    status: 'ok',
    error: null,
    costUsd: 0.01,
    durationMs: 10,
    createdTs: 10,
    ...o,
  });

  const summary = (o: Partial<SummaryRecord> = {}): SummaryRecord => ({
    tenantId: T,
    id: 's',
    groupJid: 'g1@g.us',
    sinceTs: 0,
    untilTs: 10,
    watermarkTs: 9,
    watermarkId: 'M',
    messageCount: 1,
    adapter: 'fake',
    model: null,
    text: 'text',
    createdTs: 10,
    ...o,
  });

  it('lists runs across groups newest first, including dry runs, per tenant', () => {
    store.insertRun(run({ id: 'a', groupJid: 'g1@g.us', createdTs: 10 }));
    store.insertRun(run({ id: 'b', groupJid: 'g2@g.us', createdTs: 30, dryRun: true }));
    store.insertRun(run({ id: 'c', groupJid: 'g1@g.us', createdTs: 20 }));
    store.insertRun(run({ id: 'z', tenantId: 'acme', createdTs: 99 }));
    expect(store.listRuns(T, 10).map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(store.listRuns(T, 2).map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('lists summaries newest first with their delivery rows', () => {
    store.upsertSummary(summary({ id: 's1', createdTs: 10 }));
    store.upsertSummary(summary({ id: 's2', createdTs: 20, groupJid: 'g2@g.us' }));
    store.upsertSummary(summary({ id: 's9', tenantId: 'acme', createdTs: 30 }));
    store.putDelivery({
      tenantId: T,
      summaryId: 's1',
      channel: 'vault',
      status: 'sent',
      target: 'a.md',
      createdTs: 10,
      sentTs: 10,
    });
    store.putDelivery({
      tenantId: T,
      summaryId: 's1',
      channel: 'self_dm',
      status: 'queued',
      text: 'x',
      createdTs: 10,
    });
    const got = store.listSummaries(T, 10);
    expect(got.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(got[1]?.deliveries.map((d) => [d.channel, d.status])).toEqual([
      ['self_dm', 'queued'],
      ['vault', 'sent'],
    ]);
    expect(got[0]?.deliveries).toEqual([]);
  });

  it('lists recent deliveries newest first, optionally only the unsent ones', () => {
    store.putDelivery({
      tenantId: T,
      summaryId: 's1',
      channel: 'vault',
      status: 'sent',
      target: 'a.md',
      createdTs: 10,
      sentTs: 10,
    });
    store.putDelivery({
      tenantId: T,
      summaryId: 's2',
      channel: 'self_dm',
      status: 'queued',
      text: 'x',
      createdTs: 20,
    });
    store.putDelivery({
      tenantId: T,
      summaryId: 's3',
      channel: 'group',
      status: 'failed',
      text: 'y',
      createdTs: 30,
    });
    store.putDelivery({
      tenantId: 'acme',
      summaryId: 's4',
      channel: 'self_dm',
      status: 'queued',
      text: 'z',
      createdTs: 40,
    });
    expect(store.listDeliveries(T, 10).map((d) => d.summaryId)).toEqual(['s3', 's2', 's1']);
    expect(store.listDeliveries(T, 10, { unsentOnly: true }).map((d) => d.summaryId)).toEqual([
      's3',
      's2',
    ]);
  });

  it('counts messages per day for a group inside a window', () => {
    const day = 86_400;
    const base = 1_756_800_000; // 2025-09-02 08:00 UTC
    const msg = (id: string, ts: number, groupJid = 'g1@g.us'): NewMessage => ({
      tenantId: T,
      groupJid,
      id,
      senderJid: 'a@s.whatsapp.net',
      senderName: 'A',
      ts,
      kind: 'text',
      body: 'hi',
    });
    store.insertMessage(msg('1', base));
    store.insertMessage(msg('2', base + 60));
    store.insertMessage(msg('3', base + day));
    store.insertMessage(msg('4', base + 3 * day));
    store.insertMessage(msg('5', base + day, 'g2@g.us'));
    store.markDeleted(T, 'g1@g.us', '4');
    expect(store.messageCountsByDay(T, 'g1@g.us', base - 1, 'UTC')).toEqual([
      { day: '2025-09-02', count: 2 },
      { day: '2025-09-03', count: 1 },
    ]);
  });
});
