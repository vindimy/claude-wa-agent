import { createHash, randomUUID } from 'node:crypto';
import {
  type Config,
  mergeSummary,
  personalityNames,
  type ResolvedRecapConfig,
  resolvePersonality,
  resolveScopeDestinations,
  type SummaryOptions,
} from '../config/index.js';
import { deliverSummary } from '../delivery/index.js';
import { createLogger, err, ok, type Result } from '../shared/index.js';
import type {
  MessageRow,
  RecapWatermark,
  RunTrigger,
  Store,
  SummaryRecord,
} from '../store/index.js';
import type { SummarySection } from '../summarizer/index.js';
import { defaultLookbackS } from './cadence.js';
import {
  type DigestError,
  type DigestResult,
  type DigestStats,
  describeSummarizerError,
  isScheduledTrigger,
} from './run-digest.js';
import { type SummarizerFactory, summarizerFor } from './run-shared.js';

export interface RecapRequest {
  tenantId: string;
  store: Store;
  config: Config;
  recap: ResolvedRecapConfig;
  untilTs: number;
  trigger: RunTrigger;
  tz: string;
  vaultDir: string;
  /** Explicit window start for every source (`--since`); otherwise each source's own watermark. */
  sinceTs?: number;
  dryRun?: boolean;
  /** Regenerate and re-deliver even if this message set was summarized before. */
  fresh?: boolean;
  adapter?: string;
  summaryOptions?: Partial<SummaryOptions>;
  /** Always send to the self-chat (used for `/digest` replies). */
  forceSelfDm?: boolean;
  /** Send to `deliver.to`. Defaults to true for scheduled triggers, false on demand. */
  postOutward?: boolean;
  now?: () => number;
  summarizerFactory?: SummarizerFactory;
}

/**
 * Stable id for a recap: the same set of messages across the same sources
 * maps to the same id, so a rerun reuses the stored text.
 */
export function recapSummaryId(tenantId: string, key: string, sections: SummarySection[]): string {
  const parts = [tenantId, key];
  for (const s of sections) {
    const first = s.messages[0];
    const last = s.messages[s.messages.length - 1];
    if (!first || !last) continue;
    parts.push(s.groupJid, String(first.ts), first.id, String(last.ts), last.id);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * The recap pipeline: read every source from its own watermark, summarize
 * the sectioned transcript once, record the run plus per-source watermarks,
 * deliver. Mirrors `runDigest`; the scope key is `recap.key`.
 */
export async function runRecap(req: RecapRequest): Promise<Result<DigestResult, DigestError>> {
  const { tenantId, store, config, recap, untilTs, trigger, tz, vaultDir } = req;
  const now = req.now ?? Date.now;
  const log = createLogger('recap', { tenant_id: tenantId });
  const dryRun = Boolean(req.dryRun);

  const watermarks = store.recapWatermarks(tenantId, recap.name);
  const sections: SummarySection[] = [];
  let sinceTs = untilTs;
  for (const source of recap.sources) {
    const wm = watermarks.get(source.jid);
    const since =
      req.sinceTs ?? (wm ? wm.watermarkTs + 1 : untilTs - defaultLookbackS(recap.cadence));
    const messages = store
      .messagesSince(tenantId, source.jid, since)
      .filter((m) => m.ts <= untilTs);
    if (messages.length === 0) continue;
    sections.push({ groupJid: source.jid, groupName: source.name, messages });
    sinceTs = Math.min(sinceTs, since);
  }
  if (sections.length === 0) return ok({ kind: 'empty' });

  const messages: MessageRow[] = sections.flatMap((s) => s.messages).sort((a, b) => a.ts - b.ts);
  const newest = messages[messages.length - 1];
  if (!newest) return ok({ kind: 'empty' });

  const adapterName = req.adapter ?? recap.summarizer;
  const summarizer = summarizerFor(config, adapterName, req.summarizerFactory);
  if (!summarizer.ok) return err(summarizer.error);

  const sid = recapSummaryId(tenantId, recap.key, sections);
  let summary = req.fresh ? undefined : store.getSummary(tenantId, sid);
  let reused = true;
  let stats: DigestStats | undefined;

  if (summary) {
    log.info({ recap: recap.name, summaryId: sid, trigger }, 'reusing stored recap');
  } else {
    reused = false;
    const options: SummaryOptions = mergeSummary(recap.summary, req.summaryOptions);
    const personality = resolvePersonality(config, options.personality);
    if (personality === undefined) {
      return err({
        tag: 'unknown-personality',
        name: options.personality,
        available: personalityNames(config),
      });
    }
    log.info(
      {
        recap: recap.name,
        adapter: adapterName,
        sources: sections.map((s) => s.groupJid),
        messages: messages.length,
        trigger,
        dryRun,
      },
      'summarizing recap',
    );
    const result = await summarizer.value.summarize({
      tenantId,
      groupJid: recap.key,
      groupName: recap.name,
      messages,
      sections,
      sinceTs,
      untilTs,
      tz,
      options,
      personality,
    });
    const createdTs = Math.floor(now() / 1000);
    const runBase = {
      tenantId,
      id: randomUUID(),
      groupJid: recap.key,
      trigger,
      dryRun,
      sinceTs,
      untilTs,
      messageCount: messages.length,
      watermarkTs: newest.ts,
      watermarkId: newest.id,
      createdTs,
    };
    if (!result.ok) {
      store.recordRecapRun(
        {
          ...runBase,
          summaryId: null,
          adapter: adapterName,
          model: null,
          status: 'error',
          error: describeSummarizerError(result.error),
          costUsd: null,
          durationMs: null,
        },
        recap.name,
        [],
      );
      return err({ tag: 'summarize', error: result.error });
    }
    const s = result.value;
    summary = {
      tenantId,
      id: sid,
      groupJid: recap.key,
      sinceTs,
      untilTs,
      watermarkTs: newest.ts,
      watermarkId: newest.id,
      messageCount: messages.length,
      adapter: s.adapter,
      model: s.model,
      text: s.text,
      createdTs,
    } satisfies SummaryRecord;
    store.upsertSummary(summary);
    const advanced: RecapWatermark[] = dryRun
      ? []
      : sections.flatMap((sec) => {
          const last = sec.messages[sec.messages.length - 1];
          return last
            ? [{ sourceJid: sec.groupJid, watermarkTs: last.ts, watermarkId: last.id }]
            : [];
        });
    store.recordRecapRun(
      {
        ...runBase,
        summaryId: sid,
        adapter: s.adapter,
        model: s.model,
        status: 'ok',
        error: null,
        costUsd: s.costUsd,
        durationMs: s.durationMs,
      },
      recap.name,
      advanced,
    );
    stats = {
      adapter: s.adapter,
      model: s.model,
      messages: s.messageCount,
      inputChars: s.inputChars,
      words: s.text.split(/\s+/).length,
      durationMs: s.durationMs,
      costUsd: s.costUsd,
    };
    log.info({ recap: recap.name, summaryId: sid, ...stats }, 'recap generated and recorded');
  }

  if (dryRun) return ok({ kind: 'ok', summary, reused, stats, outcomes: [] });

  const outward = req.postOutward ?? isScheduledTrigger(trigger);
  const destinations = resolveScopeDestinations(config, recap.key);
  const outcomes = deliverSummary({
    store,
    summary,
    deliver: {
      vault: recap.deliver.vault,
      self_dm: recap.deliver.self_dm || Boolean(req.forceSelfDm),
      group: false,
    },
    destinations: outward ? destinations : [],
    vaultDir,
    render: { scopeName: recap.name, tz, sources: recap.sources },
    nowTs: Math.floor(now() / 1000),
    force: Boolean(req.fresh),
  });
  if (!outward) {
    for (const d of destinations) {
      outcomes.push({
        channel: 'to',
        name: d.name,
        outcome: 'skipped',
        reason: 'on-demand runs stay private; scheduled runs deliver outward, or pass --post',
      });
    }
  }
  return ok({ kind: 'ok', summary, reused, stats, outcomes });
}
