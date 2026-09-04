import { randomUUID } from 'node:crypto';
import type { Config, ResolvedGroupConfig, SummaryOptions } from '../config/index.js';
import { type DeliveryOutcome, deliverSummary } from '../delivery/index.js';
import { createLogger, err, ok, type Result } from '../shared/index.js';
import { type RunTrigger, type Store, type SummaryRecord, summaryId } from '../store/index.js';
import {
  createSummarizer,
  type Summarizer,
  type SummarizerError,
  type UnknownAdapterError,
} from '../summarizer/index.js';

export interface DigestRequest {
  tenantId: string;
  store: Store;
  config: Config;
  group: ResolvedGroupConfig;
  sinceTs: number;
  untilTs: number;
  trigger: RunTrigger;
  tz: string;
  vaultDir: string;
  dryRun?: boolean;
  /** Regenerate and re-deliver even if this message set was summarized before. */
  fresh?: boolean;
  adapter?: string;
  summaryOptions?: Partial<SummaryOptions>;
  /** Always send to the self-chat (used for `/digest` replies). */
  forceSelfDm?: boolean;
  /** Test seam. */
  summarizerFactory?: (
    name: string,
    opts: Parameters<typeof createSummarizer>[1],
  ) => Result<Summarizer, UnknownAdapterError>;
}

export interface DigestStats {
  adapter: string;
  model: string | null;
  messages: number;
  inputChars: number;
  words: number;
  durationMs: number;
  costUsd: number | null;
}

export type DigestResult =
  | { kind: 'empty' }
  | {
      kind: 'ok';
      summary: SummaryRecord;
      reused: boolean;
      stats?: DigestStats;
      outcomes: DeliveryOutcome[];
    };

export type DigestError =
  | { tag: 'unknown-adapter'; name: string; available: readonly string[] }
  | { tag: 'summarize'; error: SummarizerError };

/**
 * The whole pipeline for one group and one window: read messages, reuse or
 * generate the summary, record the run, deliver (unless dry run). Used by the
 * CLI, the scheduler, and the `/digest` command alike.
 */
export async function runDigest(req: DigestRequest): Promise<Result<DigestResult, DigestError>> {
  const { tenantId, store, config, group, sinceTs, untilTs, trigger, tz, vaultDir } = req;
  const log = createLogger('digest', { tenant_id: tenantId });
  const dryRun = Boolean(req.dryRun);
  const groupName = group.name ?? group.jid;

  const messages = store.messagesSince(tenantId, group.jid, sinceTs).filter((m) => m.ts <= untilTs);
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (!first || !last) return ok({ kind: 'empty' });

  const adapterName = req.adapter ?? group.summarizer;
  const adapterCfg = config.summarizers[adapterName] ?? {};
  const factory = req.summarizerFactory ?? createSummarizer;
  const summarizer = factory(adapterName, {
    bin: adapterCfg.bin,
    model: adapterCfg.model,
    timeoutMs: adapterCfg.timeout_seconds ? adapterCfg.timeout_seconds * 1000 : undefined,
  });
  if (!summarizer.ok) return err(summarizer.error);

  const sid = summaryId({
    tenantId,
    groupJid: group.jid,
    firstTs: first.ts,
    firstId: first.id,
    lastTs: last.ts,
    lastId: last.id,
  });

  let summary = req.fresh ? undefined : store.getSummary(tenantId, sid);
  let reused = true;
  let stats: DigestStats | undefined;

  if (summary) {
    log.info({ group: group.jid, summaryId: sid, trigger }, 'reusing stored summary');
  } else {
    reused = false;
    const options: SummaryOptions = { ...group.summary, ...req.summaryOptions };
    log.info(
      { group: group.jid, adapter: adapterName, messages: messages.length, trigger, dryRun },
      'summarizing',
    );
    const result = await summarizer.value.summarize({
      tenantId,
      groupJid: group.jid,
      groupName,
      messages,
      sinceTs,
      untilTs,
      tz,
      options,
    });
    const createdTs = Math.floor(Date.now() / 1000);
    const runBase = {
      tenantId,
      id: randomUUID(),
      groupJid: group.jid,
      trigger,
      dryRun,
      sinceTs,
      untilTs,
      messageCount: messages.length,
      watermarkTs: last.ts,
      watermarkId: last.id,
      createdTs,
    };
    if (!result.ok) {
      store.insertRun({
        ...runBase,
        summaryId: null,
        adapter: adapterName,
        model: null,
        status: 'error',
        error: describeSummarizerError(result.error),
        costUsd: null,
        durationMs: null,
      });
      return err({ tag: 'summarize', error: result.error });
    }
    const s = result.value;
    summary = {
      tenantId,
      id: sid,
      groupJid: group.jid,
      sinceTs,
      untilTs,
      watermarkTs: last.ts,
      watermarkId: last.id,
      messageCount: messages.length,
      adapter: s.adapter,
      model: s.model,
      text: s.text,
      createdTs,
    };
    store.upsertSummary(summary);
    store.insertRun({
      ...runBase,
      summaryId: sid,
      adapter: s.adapter,
      model: s.model,
      status: 'ok',
      error: null,
      costUsd: s.costUsd,
      durationMs: s.durationMs,
    });
    stats = {
      adapter: s.adapter,
      model: s.model,
      messages: s.messageCount,
      inputChars: s.inputChars,
      words: s.text.split(/\s+/).length,
      durationMs: s.durationMs,
      costUsd: s.costUsd,
    };
    log.info({ group: group.jid, summaryId: sid, ...stats }, 'summary generated and recorded');
  }

  if (dryRun) return ok({ kind: 'ok', summary, reused, stats, outcomes: [] });

  const deliver = req.forceSelfDm ? { ...group.deliver, self_dm: true } : group.deliver;
  const outcomes = deliverSummary({
    store,
    summary,
    deliver,
    vaultDir,
    render: { groupName, tz },
    nowTs: Math.floor(Date.now() / 1000),
    force: Boolean(req.fresh),
  });
  return ok({ kind: 'ok', summary, reused, stats, outcomes });
}

export function describeSummarizerError(e: SummarizerError): string {
  switch (e.tag) {
    case 'empty':
      return 'no messages to summarize';
    case 'spawn':
      return `cannot start ${e.bin}: ${e.message}`;
    case 'timeout':
      return `${e.bin} did not finish within ${Math.round(e.timeoutMs / 1000)}s`;
    case 'exit':
      return `${e.bin} exited with code ${e.code}: ${e.stderr.trim() || '(no stderr)'}`;
    case 'parse':
      return `could not parse adapter output: ${e.message}`;
    case 'model':
      return `adapter error: ${e.message}`;
  }
}

export function describeDigestError(e: DigestError): string {
  if (e.tag === 'unknown-adapter') {
    return `unknown summarizer "${e.name}" (available: ${e.available.join(', ')})`;
  }
  return describeSummarizerError(e.error);
}
