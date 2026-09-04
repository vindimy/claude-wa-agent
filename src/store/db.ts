import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// Each entry runs once, in order, inside a transaction. Never edit a shipped
// migration — append a new one.
const MIGRATIONS: string[] = [
  // 001 — groups + messages (phase 1)
  `
  CREATE TABLE groups (
    jid TEXT PRIMARY KEY,
    subject TEXT,
    participant_count INTEGER,
    first_seen_ts INTEGER NOT NULL,
    last_seen_ts INTEGER NOT NULL
  );

  CREATE TABLE messages (
    group_jid TEXT NOT NULL,
    id TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    sender_name TEXT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    body TEXT,
    edited_ts INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_jid, id)
  );

  CREATE INDEX idx_messages_group_ts ON messages (group_jid, ts);
  `,
  // 002 — tenant_id on every table (ADR 0001). Rebuilds both tables because
  // SQLite cannot alter a primary key; existing rows become tenant "owner".
  `
  CREATE TABLE groups_v2 (
    tenant_id TEXT NOT NULL,
    jid TEXT NOT NULL,
    subject TEXT,
    participant_count INTEGER,
    first_seen_ts INTEGER NOT NULL,
    last_seen_ts INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, jid)
  );
  INSERT INTO groups_v2
    SELECT 'owner', jid, subject, participant_count, first_seen_ts, last_seen_ts FROM groups;
  DROP TABLE groups;
  ALTER TABLE groups_v2 RENAME TO groups;

  CREATE TABLE messages_v2 (
    tenant_id TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    id TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    sender_name TEXT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    body TEXT,
    edited_ts INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, group_jid, id)
  );
  INSERT INTO messages_v2
    SELECT 'owner', group_jid, id, sender_jid, sender_name, ts, kind, body, edited_ts, deleted
    FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_v2 RENAME TO messages;

  CREATE INDEX idx_messages_tenant_group_ts ON messages (tenant_id, group_jid, ts);
  `,
  // 003 — summaries, runs, deliveries (phase 3)
  `
  CREATE TABLE summaries (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    since_ts INTEGER NOT NULL,
    until_ts INTEGER NOT NULL,
    watermark_ts INTEGER NOT NULL,
    watermark_id TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    adapter TEXT NOT NULL,
    model TEXT,
    text TEXT NOT NULL,
    created_ts INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  );
  CREATE INDEX idx_summaries_tenant_group ON summaries (tenant_id, group_jid, watermark_ts);

  CREATE TABLE runs (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    trigger TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    since_ts INTEGER NOT NULL,
    until_ts INTEGER NOT NULL,
    message_count INTEGER NOT NULL,
    watermark_ts INTEGER,
    watermark_id TEXT,
    summary_id TEXT,
    adapter TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    error TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    created_ts INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  );
  CREATE INDEX idx_runs_tenant_group ON runs (tenant_id, group_jid, created_ts);

  CREATE TABLE deliveries (
    tenant_id TEXT NOT NULL,
    summary_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    target TEXT,
    text TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_ts INTEGER NOT NULL,
    sent_ts INTEGER,
    PRIMARY KEY (tenant_id, summary_id, channel)
  );
  CREATE INDEX idx_deliveries_tenant_status ON deliveries (tenant_id, status, created_ts);
  `,
];

export const MIGRATION_COUNT = MIGRATIONS.length;

export function openDatabase(path: string, upTo = MIGRATION_COUNT): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db, upTo);
  return db;
}

/** Apply migrations 1..upTo that are not yet recorded. Exported for tests. */
export function migrate(db: Database.Database, upTo = MIGRATION_COUNT): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );
  MIGRATIONS.slice(0, upTo).forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    })();
  });
}
