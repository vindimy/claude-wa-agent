import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
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

/** One URL found in a message body, with what the enrichment worker learned about it. */
export interface LinkInfo {
  url: string;
  title: string | null;
  /** Null when the link was not fetched (login-walled host, non-HTML, or a failed fetch). */
  description: string | null;
}

export interface MessageRow extends NewMessage {
  editedTs: number | null;
  deleted: boolean;
  /** Vision-model description of an image message, once produced. */
  mediaDescription: string | null;
  links: LinkInfo[];
}

export type EnrichmentKind = 'image' | 'link';
export type EnrichmentStatus = 'queued' | 'done' | 'failed' | 'skipped';

export interface NewEnrichment {
  tenantId: string;
  /** `<message_id>:image` or `<message_id>:link:<n>`; a re-enqueue is a no-op. */
  id: string;
  groupJid: string;
  messageId: string;
  kind: EnrichmentKind;
  /** File path for `image`, the URL for `link`. */
  payload: string;
  createdTs: number;
}

export interface EnrichmentRow extends NewEnrichment {
  status: EnrichmentStatus;
  attempts: number;
  nextAttemptTs: number;
  /** When the last model call for this job started; drives the daily cap. */
  calledTs: number | null;
  error: string | null;
  updatedTs: number;
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

export type QuestionStatus = 'ok' | 'error';

/** One `/ask` question and its answer (or failure). */
export interface QuestionRecord {
  tenantId: string;
  id: string;
  groupJid: string;
  question: string;
  answer: string | null;
  sinceTs: number;
  untilTs: number;
  messageCount: number;
  adapter: string;
  model: string | null;
  status: QuestionStatus;
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

interface RawQuestionRow {
  tenant_id: string;
  id: string;
  group_jid: string;
  question: string;
  answer: string | null;
  since_ts: number;
  until_ts: number;
  message_count: number;
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
  media_description: string | null;
  links: string | null;
}

interface RawEnrichmentRow {
  tenant_id: string;
  id: string;
  group_jid: string;
  message_id: string;
  kind: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_ts: number;
  called_ts: number | null;
  error: string | null;
  created_ts: number;
  updated_ts: number;
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

  setMediaDescription(tenantId: string, groupJid: string, id: string, text: string): void {
    this.db
      .prepare(
        `UPDATE messages SET media_description = ?
         WHERE tenant_id = ? AND group_jid = ? AND id = ?`,
      )
      .run(text, tenantId, groupJid, id);
  }

  setLinks(tenantId: string, groupJid: string, id: string, links: LinkInfo[]): void {
    this.db
      .prepare('UPDATE messages SET links = ? WHERE tenant_id = ? AND group_jid = ? AND id = ?')
      .run(JSON.stringify(links), tenantId, groupJid, id);
  }

  /**
   * Retention: delete this tenant's messages older than `cutoffTs`, along
   * with their enrichment jobs and any image files those jobs still point at.
   * Groups, summaries, runs, and deliveries are kept. Returns the number of
   * messages removed.
   */
  pruneMessagesBefore(
    tenantId: string,
    cutoffTs: number,
    unlink: (path: string) => void = (p) => rmSync(p, { force: true }),
  ): number {
    const stale = this.db
      .prepare(
        `SELECT e.id, e.kind, e.payload FROM enrichments e
         JOIN messages m
           ON m.tenant_id = e.tenant_id AND m.group_jid = e.group_jid AND m.id = e.message_id
         WHERE e.tenant_id = ? AND m.ts < ?`,
      )
      .all(tenantId, cutoffTs) as Array<{ id: string; kind: string; payload: string }>;
    for (const e of stale) {
      if (e.kind === 'image') {
        try {
          unlink(e.payload);
        } catch {
          // a missing file is the goal; anything else is not worth failing retention over
        }
      }
    }
    const removeJob = this.db.prepare('DELETE FROM enrichments WHERE tenant_id = ? AND id = ?');
    const removeMessages = this.db.prepare('DELETE FROM messages WHERE tenant_id = ? AND ts < ?');
    return this.db.transaction(() => {
      for (const e of stale) removeJob.run(tenantId, e.id);
      return removeMessages.run(tenantId, cutoffTs).changes;
    })();
  }

  // --- enrichment queue ----------------------------------------------------

  /** Queue a description job; the same id queued twice is left as it was. */
  enqueueEnrichment(e: NewEnrichment): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO enrichments (tenant_id, id, group_jid, message_id, kind, payload,
           status, attempts, next_attempt_ts, called_ts, error, created_ts, updated_ts)
         VALUES (@tenantId, @id, @groupJid, @messageId, @kind, @payload,
           'queued', 0, @createdTs, NULL, NULL, @createdTs, @createdTs)`,
      )
      .run({ ...e });
  }

  /** Queued jobs due at `nowTs`, oldest first; optionally only one group's. */
  claimDueEnrichments(
    tenantId: string,
    nowTs: number,
    limit: number,
    groupJid?: string,
  ): EnrichmentRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM enrichments
         WHERE tenant_id = @tenantId AND status = 'queued' AND next_attempt_ts <= @nowTs
           AND (@groupJid IS NULL OR group_jid = @groupJid)
         ORDER BY created_ts, id LIMIT @limit`,
      )
      .all({ tenantId, nowTs, limit, groupJid: groupJid ?? null }) as RawEnrichmentRow[];
    return rows.map(toEnrichmentRow);
  }

  completeEnrichment(tenantId: string, id: string, updatedTs: number): void {
    this.db
      .prepare(
        `UPDATE enrichments SET status = 'done', error = NULL, updated_ts = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(updatedTs, tenantId, id);
  }

  /**
   * Record a failed attempt. With `nextAttemptTs` the job stays queued for a
   * retry at that time; with null it is `failed` for good.
   */
  failEnrichment(
    tenantId: string,
    id: string,
    error: string,
    nextAttemptTs: number | null,
    updatedTs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE enrichments SET status = ?, error = ?, attempts = attempts + 1,
           next_attempt_ts = COALESCE(?, next_attempt_ts), updated_ts = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(
        nextAttemptTs === null ? 'failed' : 'queued',
        error,
        nextAttemptTs,
        updatedTs,
        tenantId,
        id,
      );
  }

  /** Give up on a job without counting it as a failure (e.g. adapter cannot see images). */
  skipEnrichment(tenantId: string, id: string, reason: string, updatedTs: number): void {
    this.db
      .prepare(
        `UPDATE enrichments SET status = 'skipped', error = ?, updated_ts = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(reason, updatedTs, tenantId, id);
  }

  /** Push a queued job's next attempt out without counting an attempt (daily cap). */
  deferEnrichment(tenantId: string, id: string, nextAttemptTs: number, updatedTs: number): void {
    this.db
      .prepare(
        `UPDATE enrichments SET next_attempt_ts = ?, updated_ts = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(nextAttemptTs, updatedTs, tenantId, id);
  }

  /** Note that a model call is being made for this job (counted by the daily cap). */
  markEnrichmentCalled(tenantId: string, id: string, calledTs: number): void {
    this.db
      .prepare('UPDATE enrichments SET called_ts = ? WHERE tenant_id = ? AND id = ?')
      .run(calledTs, tenantId, id);
  }

  countEnrichmentCallsSince(tenantId: string, sinceTs: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM enrichments WHERE tenant_id = ? AND called_ts >= ?')
      .get(tenantId, sinceTs) as { n: number };
    return r.n;
  }

  /** Queued jobs for one group, whether or not they are due yet. */
  pendingEnrichments(tenantId: string, groupJid: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM enrichments
         WHERE tenant_id = ? AND group_jid = ? AND status = 'queued'`,
      )
      .get(tenantId, groupJid) as { n: number };
    return r.n;
  }

  /** Queue health for the dashboard; `done` counts jobs completed at or after `doneSinceTs`. */
  enrichmentCounts(
    tenantId: string,
    doneSinceTs: number,
  ): { queued: number; failed: number; done: number } {
    const r = this.db
      .prepare(
        `SELECT
           SUM(status = 'queued') AS queued,
           SUM(status = 'failed') AS failed,
           SUM(status = 'done' AND updated_ts >= ?) AS done
         FROM enrichments WHERE tenant_id = ?`,
      )
      .get(doneSinceTs, tenantId) as {
      queued: number | null;
      failed: number | null;
      done: number | null;
    };
    return { queued: r.queued ?? 0, failed: r.failed ?? 0, done: r.done ?? 0 };
  }

  /** Most recently updated jobs for this tenant. */
  listEnrichments(tenantId: string, limit: number): EnrichmentRow[] {
    const rows = this.db
      .prepare('SELECT * FROM enrichments WHERE tenant_id = ? ORDER BY updated_ts DESC, id LIMIT ?')
      .all(tenantId, limit) as RawEnrichmentRow[];
    return rows.map(toEnrichmentRow);
  }

  /**
   * Non-deleted messages per local day for one group, from `sinceTs` on.
   * Day boundaries follow `tz`; the dashboard draws activity from this.
   */
  messageCountsByDay(
    tenantId: string,
    groupJid: string,
    sinceTs: number,
    tz: string,
  ): Array<{ day: string; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT ts FROM messages
         WHERE tenant_id = ? AND group_jid = ? AND ts >= ? AND deleted = 0
         ORDER BY ts`,
      )
      .all(tenantId, groupJid, sinceTs) as Array<{ ts: number }>;
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const counts = new Map<string, number>();
    for (const r of rows) {
      const day = fmt.format(new Date(r.ts * 1000));
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return [...counts.entries()].map(([day, count]) => ({ day, count }));
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

  /** Newest summaries for this tenant across groups, each with its delivery rows. */
  listSummaries(
    tenantId: string,
    limit: number,
  ): Array<SummaryRecord & { deliveries: DeliveryRow[] }> {
    const rows = this.db
      .prepare('SELECT * FROM summaries WHERE tenant_id = ? ORDER BY created_ts DESC LIMIT ?')
      .all(tenantId, limit) as RawSummaryRow[];
    const byChannel = this.db.prepare(
      'SELECT * FROM deliveries WHERE tenant_id = ? AND summary_id = ? ORDER BY channel',
    );
    return rows.map((r) => ({
      ...toSummaryRecord(r),
      deliveries: (byChannel.all(tenantId, r.id) as RawDeliveryRow[]).map(toDeliveryRow),
    }));
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

  /** Newest runs for this tenant across groups, dry runs included. */
  listRuns(tenantId: string, limit: number): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE tenant_id = ? ORDER BY created_ts DESC LIMIT ?')
      .all(tenantId, limit) as RawRunRow[];
    return rows.map(toRunRecord);
  }

  // --- questions -----------------------------------------------------------

  insertQuestion(q: QuestionRecord): void {
    this.db
      .prepare(
        `INSERT INTO questions (tenant_id, id, group_jid, question, answer, since_ts, until_ts,
           message_count, adapter, model, status, error, cost_usd, duration_ms, created_ts)
         VALUES (@tenantId, @id, @groupJid, @question, @answer, @sinceTs, @untilTs,
           @messageCount, @adapter, @model, @status, @error, @costUsd, @durationMs, @createdTs)`,
      )
      .run({ ...q });
  }

  /** Newest questions for this tenant across groups. */
  listQuestions(tenantId: string, limit: number): QuestionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM questions WHERE tenant_id = ? ORDER BY created_ts DESC LIMIT ?')
      .all(tenantId, limit) as RawQuestionRow[];
    return rows.map(toQuestionRecord);
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

  /** Newest delivery rows for this tenant; `unsentOnly` keeps queued and failed. */
  listDeliveries(
    tenantId: string,
    limit: number,
    opts: { unsentOnly?: boolean } = {},
  ): DeliveryRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM deliveries WHERE tenant_id = ? ${opts.unsentOnly ? "AND status != 'sent'" : ''}
         ORDER BY created_ts DESC LIMIT ?`,
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

  /** When this tenant last sent on `channel` to `target`, if ever. */
  lastSentTs(tenantId: string, channel: DeliveryChannel, target: string): number | undefined {
    const r = this.db
      .prepare(
        `SELECT MAX(sent_ts) AS ts FROM deliveries
         WHERE tenant_id = ? AND channel = ? AND target = ? AND status = 'sent'`,
      )
      .get(tenantId, channel, target) as { ts: number | null };
    return r.ts ?? undefined;
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

function toQuestionRecord(r: RawQuestionRow): QuestionRecord {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    groupJid: r.group_jid,
    question: r.question,
    answer: r.answer,
    sinceTs: r.since_ts,
    untilTs: r.until_ts,
    messageCount: r.message_count,
    adapter: r.adapter,
    model: r.model,
    status: r.status as QuestionStatus,
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
    mediaDescription: r.media_description,
    links: parseLinks(r.links),
  };
}

function parseLinks(raw: string | null): LinkInfo[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
      .filter((l) => typeof l.url === 'string')
      .map((l) => ({
        url: l.url as string,
        title: typeof l.title === 'string' ? l.title : null,
        description: typeof l.description === 'string' ? l.description : null,
      }));
  } catch {
    return [];
  }
}

function toEnrichmentRow(r: RawEnrichmentRow): EnrichmentRow {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    groupJid: r.group_jid,
    messageId: r.message_id,
    kind: r.kind as EnrichmentKind,
    payload: r.payload,
    status: r.status as EnrichmentStatus,
    attempts: r.attempts,
    nextAttemptTs: r.next_attempt_ts,
    calledTs: r.called_ts,
    error: r.error,
    createdTs: r.created_ts,
    updatedTs: r.updated_ts,
  };
}
