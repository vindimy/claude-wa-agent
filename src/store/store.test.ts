import { beforeEach, describe, expect, it } from 'vitest';
import { type NewMessage, Store } from './store.js';

function msg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
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
    const row = store.getMessage('g1@g.us', 'MSG1');
    expect(row?.body).toBe('hello');
    expect(row?.deleted).toBe(false);
    expect(row?.editedTs).toBeNull();
  });

  it('ignores redelivery of the same message id', () => {
    store.insertMessage(msg());
    store.insertMessage(msg({ body: 'changed on redelivery' }));
    expect(store.getMessage('g1@g.us', 'MSG1')?.body).toBe('hello');
    expect(store.countMessages('g1@g.us')).toBe(1);
  });

  it('applies edits to body and edited_ts', () => {
    store.insertMessage(msg());
    store.applyEdit('g1@g.us', 'MSG1', 'hello, edited', 1_700_000_100);
    const row = store.getMessage('g1@g.us', 'MSG1');
    expect(row?.body).toBe('hello, edited');
    expect(row?.editedTs).toBe(1_700_000_100);
  });

  it('marks messages deleted and excludes them from queries', () => {
    store.insertMessage(msg());
    store.insertMessage(msg({ id: 'MSG2', body: 'second' }));
    store.markDeleted('g1@g.us', 'MSG1');
    expect(store.getMessage('g1@g.us', 'MSG1')?.deleted).toBe(true);
    expect(store.countMessages('g1@g.us')).toBe(1);
    expect(store.messagesSince('g1@g.us', 0).map((m) => m.id)).toEqual(['MSG2']);
  });

  it('filters messagesSince by timestamp', () => {
    store.insertMessage(msg({ id: 'A', ts: 100 }));
    store.insertMessage(msg({ id: 'B', ts: 200 }));
    store.insertMessage(msg({ id: 'C', ts: 300 }));
    expect(store.messagesSince('g1@g.us', 200).map((m) => m.id)).toEqual(['B', 'C']);
    expect(store.countMessages('g1@g.us', 200)).toBe(2);
  });

  it('upserts groups, keeping first_seen and refreshing metadata', () => {
    store.upsertGroup({ jid: 'g1@g.us', subject: 'Old name', seenTs: 100 });
    store.upsertGroup({ jid: 'g1@g.us', subject: 'New name', participantCount: 5, seenTs: 200 });
    store.upsertGroup({ jid: 'g1@g.us', seenTs: 300 }); // no subject — must not erase it
    const groups = store.listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.subject).toBe('New name');
    expect(groups[0]?.participantCount).toBe(5);
    expect(groups[0]?.firstSeenTs).toBe(100);
    expect(groups[0]?.lastSeenTs).toBe(300);
  });

  it('counts messages per group in listGroups', () => {
    store.upsertGroup({ jid: 'g1@g.us', seenTs: 100 });
    store.upsertGroup({ jid: 'g2@g.us', seenTs: 100 });
    store.insertMessage(msg({ id: 'A' }));
    store.insertMessage(msg({ id: 'B', ts: 1_700_000_050 }));
    const groups = store.listGroups();
    const g1 = groups.find((g) => g.jid === 'g1@g.us');
    const g2 = groups.find((g) => g.jid === 'g2@g.us');
    expect(g1?.messageCount).toBe(2);
    expect(g1?.lastMessageTs).toBe(1_700_000_050);
    expect(g2?.messageCount).toBe(0);
    expect(g2?.lastMessageTs).toBeNull();
  });
});
