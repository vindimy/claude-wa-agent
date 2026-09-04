import { describe, expect, it } from 'vitest';
import { MIGRATION_COUNT, migrate, openDatabase } from './db.js';

describe('migrations', () => {
  it('002 keeps existing rows and assigns them to the owner tenant', () => {
    const db = openDatabase(':memory:', 1);
    db.prepare(
      `INSERT INTO groups (jid, subject, participant_count, first_seen_ts, last_seen_ts)
       VALUES ('g1@g.us', 'Old', 3, 10, 20)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (group_jid, id, sender_jid, sender_name, ts, kind, body, edited_ts, deleted)
       VALUES ('g1@g.us', 'M1', 's@s.whatsapp.net', 'Alice', 15, 'text', 'hi', NULL, 0),
              ('g1@g.us', 'M2', 's@s.whatsapp.net', 'Alice', 16, 'text', 'bye', 17, 1)`,
    ).run();

    migrate(db);

    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    expect(versions).toEqual(
      Array.from({ length: MIGRATION_COUNT }, (_, i) => ({ version: i + 1 })),
    );

    const groups = db.prepare('SELECT * FROM groups').all() as Array<Record<string, unknown>>;
    expect(groups).toEqual([
      {
        tenant_id: 'owner',
        jid: 'g1@g.us',
        subject: 'Old',
        participant_count: 3,
        first_seen_ts: 10,
        last_seen_ts: 20,
      },
    ]);

    const messages = db
      .prepare('SELECT tenant_id, id, body, edited_ts, deleted FROM messages ORDER BY id')
      .all();
    expect(messages).toEqual([
      { tenant_id: 'owner', id: 'M1', body: 'hi', edited_ts: null, deleted: 0 },
      { tenant_id: 'owner', id: 'M2', body: 'bye', edited_ts: 17, deleted: 1 },
    ]);

    // primary key now includes tenant_id: same ids under another tenant are fine
    db.prepare(
      `INSERT INTO messages (tenant_id, group_jid, id, sender_jid, ts, kind)
       VALUES ('acme', 'g1@g.us', 'M1', 'x', 1, 'text')`,
    ).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 3 });
    db.close();
  });

  it('is idempotent on an already-migrated database', () => {
    const db = openDatabase(':memory:');
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });
});
