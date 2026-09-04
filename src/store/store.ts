import { createHash } from 'node:crypto';
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

export type RunTrigger = 'manual' | 'command' | 'daily' | 'weekly' | 'threshold';
export type RunStatus = 'ok' | 'error' | 'empty';
export type DeliveryChannel = 'self_dm' | 'vault' | 'group';
export type DeliveryStatus = 'queued' | 'sent' | 'failed';

export interface SummaryRecord {
  tenantId: string;
  /** Stable id derived from the window identity; see `summaryId()`. */
  id: string;
  groupJid: string;
  sinceTs: number;
  untilTs: number;
  watermarkTs: number;
  watermarkId: string;
  messageCount: number;
  adapter: string;
  model: string | null;
  text: string;
  createdTs: number;
}

export interface RunRecord {
  tenantId: string;
  id: string;
  groupJid: string;
  trigger: RunTrigger;
  dryRun: boolean;
  sinceTs: number;
  untilTs: number;
  messageCount: number;
  watermarkTs: number | null;
  watermarkId: string | null;
  summaryId: string | null;
  adapter: string;
  model: string | null;
  status: RunStatus;
  error: string | null;
  costUsd: number | null;
  durationMs: number | null;
  createdTs: number;
}

export interface DeliveryRow {
  tenantId: string;
  summaryId: string;
  channel: DeliveryChannel;
  /** File path for vault; JID for WhatsApp channels (set when sent). */
  target: string | null;
  /** Rendered message for outbox channels; null for vault. */
  text: string | null;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  createdTs: number;
  sentTs: number | null;
}

/**
 * A summary's identity is the set of messages it covers: same tenant, group,
 * first message, and last message → same id. A relative `--since` that shifts
 * by a few seconds between invocations still maps to the same summary as long
 * as the same messages fall inside it. Re-running reuses the stored text and
 * retries only channels that have not been delivered.
 */
export function summaryId(bounds: {
  tenantId: string;
  groupJid: string;
  firstTs: number;
  firstId: string;
  lastTs: number;
  lastId: string;
}): string {
  const { tenantId, groupJid, firstTs, firstId, lastTs, lastId } = bounds;
  return createHash('sha256')
    .update([tenantId, groupJid, firstTs, firstId, lastTs, lastId].join('\n'))
    .digest('hex')
    .slice(0, 16);
}

interface RawSummaryRow {
  tenant_id: string;
  id: string;
  group_jid: string;
  since_ts: number;
  until_ts: number;
  watermark_ts: number;
  watermark_id: string;
  message_count: number;
  adapter: string;
  model: string | null;
  text: string;
  created_ts: number;
}

interface RawRunRow {
  tenant_id: string;
  id: string;
  group_jid: string;
  trigger: string;
  dry_run: number;
  since_ts: number;
  until_ts: number;
  message_count: number;
  watermark_ts: number | null;
  watermark_id: string | null;
  summary_id: string | null;
  adapter: string;
  model: string | null;
  status: string;
  error: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_ts: number;
}

interface RawDeliveryRow {
  tenant_id: string;
  summary_id: string;
  channel: string;
  target: string | null;
  text: string | null;
  status: string;
  attempts: number;
  error: string | null;
  created_ts: number;
  sent_ts: number | null;
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

  getGroup(tenantId: string, jid: string): GroupRow | undefined {
    return this.listGroups(tenantId).find((g) => g.jid === jid);
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

  // --- summaries -----------------------------------------------------------

  /** Insert or replace the text for a summary id (replace = `--fresh`). */
  upsertSummary(sm: SummaryRecord): void {
    this.db
      .prepare(
        `INSERT INTO summaries (tenant_id, id, group_jid, since_ts, until_ts, watermark_ts,
           watermark_id, message_count, adapter, model, text, created_ts)
         VALUES (@tenantId, @id, @groupJid, @sinceTs, @untilTs, @watermarkTs,
           @watermarkId, @messageCount, @adapter, @model, @text, @createdTs)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           until_ts = excluded.until_ts,
           message_count = excluded.message_count,
           adapter = excluded.adapter,
           model = excluded.model,
           text = excluded.text,
           created_ts = excluded.created_ts`,
      )
      .run({ ...sm });
  }

  getSummary(tenantId: string, id: string): SummaryRecord | undefined {
    const r = this.db
      .prepare('SELECT * FROM summaries WHERE tenant_id = ? AND id = ?')
      .get(tenantId, id) as RawSummaryRow | undefined;
    return r ? toSummaryRecord(r) : undefined;
  }

  // --- runs ----------------------------------------------------------------

  insertRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (tenant_id, id, group_jid, trigger, dry_run, since_ts, until_ts,
           message_count, watermark_ts, watermark_id, summary_id, adapter, model, status,
           error, cost_usd, duration_ms, created_ts)
         VALUES (@tenantId, @id, @groupJid, @trigger, @dryRun, @sinceTs, @untilTs,
           @messageCount, @watermarkTs, @watermarkId, @summaryId, @adapter, @model, @status,
           @error, @costUsd, @durationMs, @createdTs)`,
      )
      .run({ ...run, dryRun: run.dryRun ? 1 : 0 });
  }

  /** Watermark of the latest successful, delivered (non-dry) run for a group. */
  lastWatermark(
    tenantId: string,
    groupJid: string,
  ): { watermarkTs: number; watermarkId: string } | undefined {
    const r = this.db
      .prepare(
        `SELECT watermark_ts, watermark_id FROM runs
         WHERE tenant_id = ? AND group_jid = ? AND dry_run = 0 AND status = 'ok'
           AND watermark_ts IS NOT NULL
         ORDER BY watermark_ts DESC, created_ts DESC LIMIT 1`,
      )
      .get(tenantId, groupJid) as { watermark_ts: number; watermark_id: string } | undefined;
    return r ? { watermarkTs: r.watermark_ts, watermarkId: r.watermark_id } : undefined;
  }

  /** Non-dry runs for a group created at or after `sinceTs`, newest first. */
  recentRuns(tenantId: string, groupJid: string, sinceTs: number): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE tenant_id = ? AND group_jid = ? AND dry_run = 0 AND created_ts >= ?
         ORDER BY created_ts DESC`,
      )
      .all(tenantId, groupJid, sinceTs) as RawRunRow[];
    return rows.map(toRunRecord);
  }

  // --- deliveries ----------------------------------------------------------

  getDelivery(
    tenantId: string,
    summaryId: string,
    channel: DeliveryChannel,
  ): DeliveryRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM deliveries WHERE tenant_id = ? AND summary_id = ? AND channel = ?')
      .get(tenantId, summaryId, channel) as RawDeliveryRow | undefined;
    return r ? toDeliveryRow(r) : undefined;
  }

  /** Create or reset a delivery row (a failed row can be re-queued this way). */
  putDelivery(d: {
    tenantId: string;
    summaryId: string;
    channel: DeliveryChannel;
    status: DeliveryStatus;
    target?: string | null;
    text?: string | null;
    createdTs: number;
    sentTs?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO deliveries (tenant_id, summary_id, channel, target, text, status, attempts,
           error, created_ts, sent_ts)
         VALUES (@tenantId, @summaryId, @channel, @target, @text, @status, 0, NULL, @createdTs,
           @sentTs)
         ON CONFLICT (tenant_id, summary_id, channel) DO UPDATE SET
           target = excluded.target, text = excluded.text, status = excluded.status,
           attempts = 0, error = NULL, created_ts = excluded.created_ts,
           sent_ts = excluded.sent_ts`,
      )
      .run({
        tenantId: d.tenantId,
        summaryId: d.summaryId,
        channel: d.channel,
        status: d.status,
        target: d.target ?? null,
        text: d.text ?? null,
        createdTs: d.createdTs,
        sentTs: d.sentTs ?? null,
      });
  }

  queuedDeliveries(tenantId: string, limit = 10): DeliveryRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM deliveries WHERE tenant_id = ? AND status = 'queued'
         ORDER BY created_ts LIMIT ?`,
      )
      .all(tenantId, limit) as RawDeliveryRow[];
    return rows.map(toDeliveryRow);
  }

  markDeliverySent(
    tenantId: string,
    summaryId: string,
    channel: DeliveryChannel,
    target: string,
    sentTs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE deliveries SET status = 'sent', target = ?, sent_ts = ?, error = NULL,
           attempts = attempts + 1
         WHERE tenant_id = ? AND summary_id = ? AND channel = ?`,
      )
      .run(target, sentTs, tenantId, summaryId, channel);
  }

  /** Record a failed attempt; `permanent` moves it to `failed`, else it stays queued. */
  markDeliveryFailed(
    tenantId: string,
    summaryId: string,
    channel: DeliveryChannel,
    error: string,
    permanent: boolean,
  ): void {
    this.db
      .prepare(
        `UPDATE deliveries SET status = ?, error = ?, attempts = attempts + 1
         WHERE tenant_id = ? AND summary_id = ? AND channel = ?`,
      )
      .run(permanent ? 'failed' : 'queued', error, tenantId, summaryId, channel);
  }

  /** WhatsApp sends (self_dm + group) marked sent at or after `sinceTs`. */
  countSentSince(tenantId: string, sinceTs: number): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM deliveries
         WHERE tenant_id = ? AND status = 'sent' AND channel IN ('self_dm', 'group')
           AND sent_ts >= ?`,
      )
      .get(tenantId, sinceTs) as { n: number };
    return r.n;
  }

  close(): void {
    this.db.close();
  }
}

function toSummaryRecord(r: RawSummaryRow): SummaryRecord {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    groupJid: r.group_jid,
    sinceTs: r.since_ts,
    untilTs: r.until_ts,
    watermarkTs: r.watermark_ts,
    watermarkId: r.watermark_id,
    messageCount: r.message_count,
    adapter: r.adapter,
    model: r.model,
    text: r.text,
    createdTs: r.created_ts,
  };
}

function toRunRecord(r: RawRunRow): RunRecord {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    groupJid: r.group_jid,
    trigger: r.trigger as RunTrigger,
    dryRun: r.dry_run === 1,
    sinceTs: r.since_ts,
    untilTs: r.until_ts,
    messageCount: r.message_count,
    watermarkTs: r.watermark_ts,
    watermarkId: r.watermark_id,
    summaryId: r.summary_id,
    adapter: r.adapter,
    model: r.model,
    status: r.status as RunStatus,
    error: r.error,
    costUsd: r.cost_usd,
    durationMs: r.duration_ms,
    createdTs: r.created_ts,
  };
}

function toDeliveryRow(r: RawDeliveryRow): DeliveryRow {
  return {
    tenantId: r.tenant_id,
    summaryId: r.summary_id,
    channel: r.channel as DeliveryChannel,
    target: r.target,
    text: r.text,
    status: r.status as DeliveryStatus,
    attempts: r.attempts,
    error: r.error,
    createdTs: r.created_ts,
    sentTs: r.sent_ts,
  };
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
