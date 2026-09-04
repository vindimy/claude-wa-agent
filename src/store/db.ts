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
];

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    })();
  });
}
