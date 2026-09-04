import type Database from 'better-sqlite3';
import { openDatabase } from './db.js';

export type MessageKind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';

export interface NewMessage {
  tenantId: string;
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
  tenantId: string;
  jid: string;
  subject?: string | null;
  participantCount?: number | null;
  seenTs: number;
}

export interface GroupRow {
  tenantId: string;
  jid: string;
  subject: string | null;
  participantCount: number | null;
  firstSeenTs: number;
  lastSeenTs: number;
  messageCount: number;
  lastMessageTs: number | null;
}

interface RawMessageRow {
  tenant_id: string;
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

/**
 * Every read and write is scoped by tenant_id. There is deliberately no
 * method that touches more than one tenant.
 */
export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = openDatabase(path);
  }

  upsertGroup(g: GroupUpsert): void {
    this.db
      .prepare(
        `INSERT INTO groups (tenant_id, jid, subject, participant_count, first_seen_ts, last_seen_ts)
         VALUES (@tenantId, @jid, @subject, @participantCount, @seenTs, @seenTs)
         ON CONFLICT (tenant_id, jid) DO UPDATE SET
           subject = COALESCE(excluded.subject, groups.subject),
           participant_count = COALESCE(excluded.participant_count, groups.participant_count),
           last_seen_ts = MAX(groups.last_seen_ts, excluded.last_seen_ts)`,
      )
      .run({
        tenantId: g.tenantId,
        jid: g.jid,
        subject: g.subject ?? null,
        participantCount: g.participantCount ?? null,
        seenTs: g.seenTs,
      });
  }

  listGroups(tenantId: string): GroupRow[] {
    const rows = this.db
      .prepare(
        `SELECT g.tenant_id, g.jid, g.subject, g.participant_count, g.first_seen_ts, g.last_seen_ts,
                COUNT(m.id) AS message_count,
                MAX(m.ts) AS last_message_ts
         FROM groups g
         LEFT JOIN messages m
           ON m.tenant_id = g.tenant_id AND m.group_jid = g.jid AND m.deleted = 0
         WHERE g.tenant_id = ?
         GROUP BY g.tenant_id, g.jid
         ORDER BY last_message_ts DESC NULLS LAST, g.subject`,
      )
      .all(tenantId) as Array<{
      tenant_id: string;
      jid: string;
      subject: string | null;
      participant_count: number | null;
      first_seen_ts: number;
      last_seen_ts: number;
      message_count: number;
      last_message_ts: number | null;
    }>;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      jid: r.jid,
      subject: r.subject,
      participantCount: r.participant_count,
      firstSeenTs: r.first_seen_ts,
      lastSeenTs: r.last_seen_ts,
      messageCount: r.message_count,
      lastMessageTs: r.last_message_ts,
    }));
  }

  /** Insert a message; redeliveries of the same (tenant, group, id) are ignored. */
  insertMessage(m: NewMessage): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (tenant_id, group_jid, id, sender_jid, sender_name, ts, kind, body)
         VALUES (@tenantId, @groupJid, @id, @senderJid, @senderName, @ts, @kind, @body)`,
      )
      .run({ ...m });
  }

  applyEdit(
    tenantId: string,
    groupJid: string,
    id: string,
    body: string | null,
    editedTs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE messages SET body = ?, edited_ts = ?
         WHERE tenant_id = ? AND group_jid = ? AND id = ?`,
      )
      .run(body, editedTs, tenantId, groupJid, id);
  }

  markDeleted(tenantId: string, groupJid: string, id: string): void {
    this.db
      .prepare('UPDATE messages SET deleted = 1 WHERE tenant_id = ? AND group_jid = ? AND id = ?')
      .run(tenantId, groupJid, id);
  }

  getMessage(tenantId: string, groupJid: string, id: string): MessageRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM messages WHERE tenant_id = ? AND group_jid = ? AND id = ?')
      .get(tenantId, groupJid, id) as RawMessageRow | undefined;
    return r ? toMessageRow(r) : undefined;
  }

  messagesSince(tenantId: string, groupJid: string, sinceTs: number): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE tenant_id = ? AND group_jid = ? AND ts >= ? AND deleted = 0
         ORDER BY ts`,
      )
      .all(tenantId, groupJid, sinceTs) as RawMessageRow[];
    return rows.map(toMessageRow);
  }

  countMessages(tenantId: string, groupJid: string, sinceTs = 0): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE tenant_id = ? AND group_jid = ? AND ts >= ? AND deleted = 0`,
      )
      .get(tenantId, groupJid, sinceTs) as { n: number };
    return r.n;
  }

  close(): void {
    this.db.close();
  }
}

function toMessageRow(r: RawMessageRow): MessageRow {
  return {
    tenantId: r.tenant_id,
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
