import type Database from 'better-sqlite3';
import { openDatabase } from './db.js';

export type MessageKind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';

export interface NewMessage {
  groupJid: string;
  id: string;
  senderJid: string;
  senderName: string | null;
  ts: number;
  kind: MessageKind;
  body: string | null;
}

export interface MessageRow extends NewMessage {
  editedTs: number | null;
  deleted: boolean;
}

export interface GroupUpsert {
  jid: string;
  subject?: string | null;
  participantCount?: number | null;
  seenTs: number;
}

export interface GroupRow {
  jid: string;
  subject: string | null;
  participantCount: number | null;
  firstSeenTs: number;
  lastSeenTs: number;
  messageCount: number;
  lastMessageTs: number | null;
}

interface RawMessageRow {
  group_jid: string;
  id: string;
  sender_jid: string;
  sender_name: string | null;
  ts: number;
  kind: string;
  body: string | null;
  edited_ts: number | null;
  deleted: number;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = openDatabase(path);
  }

  upsertGroup(g: GroupUpsert): void {
    this.db
      .prepare(
        `INSERT INTO groups (jid, subject, participant_count, first_seen_ts, last_seen_ts)
         VALUES (@jid, @subject, @participantCount, @seenTs, @seenTs)
         ON CONFLICT (jid) DO UPDATE SET
           subject = COALESCE(excluded.subject, groups.subject),
           participant_count = COALESCE(excluded.participant_count, groups.participant_count),
           last_seen_ts = MAX(groups.last_seen_ts, excluded.last_seen_ts)`,
      )
      .run({
        jid: g.jid,
        subject: g.subject ?? null,
        participantCount: g.participantCount ?? null,
        seenTs: g.seenTs,
      });
  }

  listGroups(): GroupRow[] {
    const rows = this.db
      .prepare(
        `SELECT g.jid, g.subject, g.participant_count, g.first_seen_ts, g.last_seen_ts,
                COUNT(m.id) AS message_count,
                MAX(m.ts) AS last_message_ts
         FROM groups g
         LEFT JOIN messages m ON m.group_jid = g.jid AND m.deleted = 0
         GROUP BY g.jid
         ORDER BY last_message_ts DESC NULLS LAST, g.subject`,
      )
      .all() as Array<{
      jid: string;
      subject: string | null;
      participant_count: number | null;
      first_seen_ts: number;
      last_seen_ts: number;
      message_count: number;
      last_message_ts: number | null;
    }>;
    return rows.map((r) => ({
      jid: r.jid,
      subject: r.subject,
      participantCount: r.participant_count,
      firstSeenTs: r.first_seen_ts,
      lastSeenTs: r.last_seen_ts,
      messageCount: r.message_count,
      lastMessageTs: r.last_message_ts,
    }));
  }

  /** Insert a message; redeliveries of the same (group, id) are ignored. */
  insertMessage(m: NewMessage): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (group_jid, id, sender_jid, sender_name, ts, kind, body)
         VALUES (@groupJid, @id, @senderJid, @senderName, @ts, @kind, @body)`,
      )
      .run({ ...m });
  }

  applyEdit(groupJid: string, id: string, body: string | null, editedTs: number): void {
    this.db
      .prepare('UPDATE messages SET body = ?, edited_ts = ? WHERE group_jid = ? AND id = ?')
      .run(body, editedTs, groupJid, id);
  }

  markDeleted(groupJid: string, id: string): void {
    this.db
      .prepare('UPDATE messages SET deleted = 1 WHERE group_jid = ? AND id = ?')
      .run(groupJid, id);
  }

  getMessage(groupJid: string, id: string): MessageRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM messages WHERE group_jid = ? AND id = ?')
      .get(groupJid, id) as RawMessageRow | undefined;
    return r ? toMessageRow(r) : undefined;
  }

  messagesSince(groupJid: string, sinceTs: number): MessageRow[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE group_jid = ? AND ts >= ? AND deleted = 0 ORDER BY ts')
      .all(groupJid, sinceTs) as RawMessageRow[];
    return rows.map(toMessageRow);
  }

  countMessages(groupJid: string, sinceTs = 0): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE group_jid = ? AND ts >= ? AND deleted = 0')
      .get(groupJid, sinceTs) as { n: number };
    return r.n;
  }

  close(): void {
    this.db.close();
  }
}

function toMessageRow(r: RawMessageRow): MessageRow {
  return {
    groupJid: r.group_jid,
    id: r.id,
    senderJid: r.sender_jid,
    senderName: r.sender_name,
    ts: r.ts,
    kind: r.kind as MessageKind,
    body: r.body,
    editedTs: r.edited_ts,
    deleted: r.deleted === 1,
  };
}
