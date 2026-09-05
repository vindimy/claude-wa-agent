import { rmSync } from 'node:fs';
import { extname } from 'node:path';
import {
  type Config,
  enrichSummarizer,
  type ResolvedGroupConfig,
  resolveGroupConfig,
} from '../config/index.js';
import { nextLocalMidnight, startOfLocalDay } from '../scheduler/index.js';
import { createLogger, type Result } from '../shared/index.js';
import type { EnrichmentRow, LinkInfo, MessageRow, Store } from '../store/index.js';
import {
  createSummarizer,
  type Summarizer,
  type UnknownAdapterError,
} from '../summarizer/index.js';
import { describeEnrichError, type EnrichError } from './errors.js';
import { type FetchPageDeps, fetchPage, isLoginWalled, stripHtml, titleFromPath } from './links.js';
import { imagePrompt, linkPrompt } from './prompts.js';

/** Retry delays after the 1st, 2nd and 3rd failure; the 4th failure is final. */
export const BACKOFF_S: readonly number[] = [60, 300, 1800];
const DEFAULT_POLL_MS = 10_000;
const DEFAULT_BATCH = 20;

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export interface EnrichmentWorkerOptions {
  tenantId: string;
  config: Config;
  store: Store;
  /** Zone whose midnight resets the daily cap (the scheduler's zone). */
  tz: string;
  now?: () => number;
  pollMs?: number;
  /** Test seam. */
  summarizerFactory?: (
    name: string,
    opts: Parameters<typeof createSummarizer>[1],
  ) => Result<Summarizer, UnknownAdapterError>;
  /** Test seam for link fetching. */
  fetchDeps?: FetchPageDeps;
}

export interface RunOutcome {
  processed: number;
  /** True when the pass stopped because the daily cap was reached. */
  capped: boolean;
}

export interface EnrichmentWorker {
  /** Process due jobs once (optionally one group's); never throws. */
  runOnce(opts?: { groupJid?: string; limit?: number }): Promise<RunOutcome>;
  /**
   * Process one group's due jobs until none are left or `deadlineMs` has
   * passed. Returns how many of that group's jobs are still queued.
   */
  drain(groupJid: string, deadlineMs: number): Promise<number>;
  start(): void;
  stop(): void;
}

type JobOutcome = 'done' | 'retry' | 'failed' | 'skipped' | 'capped';

export function createEnrichmentWorker(opts: EnrichmentWorkerOptions): EnrichmentWorker {
  const { tenantId, config, store, tz, pollMs = DEFAULT_POLL_MS, now = () => Date.now() } = opts;
  const log = createLogger('enrich', { tenant_id: tenantId });
  const nowTs = () => Math.floor(now() / 1000);

  let adapter: Summarizer | undefined;
  let adapterError: string | undefined;
  function getAdapter(): Summarizer | undefined {
    if (adapter || adapterError) return adapter;
    const name = enrichSummarizer(config);
    const cfg = config.summarizers[name] ?? {};
    const made = (opts.summarizerFactory ?? createSummarizer)(name, {
      bin: cfg.bin,
      model: cfg.model,
      timeoutMs: cfg.timeout_seconds ? cfg.timeout_seconds * 1000 : undefined,
    });
    if (!made.ok) {
      adapterError = `unknown enrichment adapter "${name}" (available: ${made.error.available.join(', ')})`;
      log.error({ adapter: name }, adapterError);
      return undefined;
    }
    adapter = made.value;
    return adapter;
  }

  let capLoggedDay: number | undefined;
  /** True when another model call is allowed today; otherwise the job is deferred. */
  function underCap(job: EnrichmentRow): boolean {
    const t = nowTs();
    const dayStart = startOfLocalDay(t, tz);
    const used = store.countEnrichmentCallsSince(tenantId, dayStart);
    if (used < config.enrich.max_per_day) return true;
    const midnight = nextLocalMidnight(t, tz);
    store.deferEnrichment(tenantId, job.id, midnight, t);
    if (capLoggedDay !== dayStart) {
      capLoggedDay = dayStart;
      log.warn(
        { max: config.enrich.max_per_day, resumesTs: midnight },
        'daily enrichment cap reached; remaining jobs wait for local midnight',
      );
    }
    return false;
  }

  function fail(job: EnrichmentRow, error: EnrichError): 'retry' | 'failed' {
    const t = nowTs();
    const delay = BACKOFF_S[job.attempts];
    const message = describeEnrichError(error);
    const ctx = {
      group: job.groupJid,
      message_id: job.messageId,
      kind: job.kind,
      attempt: job.attempts + 1,
    };
    if (delay === undefined) {
      store.failEnrichment(tenantId, job.id, message, null, t);
      log.warn({ ...ctx, error }, `enrichment failed for good: ${message}`);
      return 'failed';
    }
    store.failEnrichment(tenantId, job.id, message, t + delay, t);
    log.info({ ...ctx, retryInS: delay }, `enrichment attempt failed: ${message}`);
    return 'retry';
  }

  function skip(job: EnrichmentRow, reason: string): 'skipped' {
    store.skipEnrichment(tenantId, job.id, reason, nowTs());
    log.info(
      { group: job.groupJid, message_id: job.messageId, kind: job.kind, reason },
      'enrichment skipped',
    );
    return 'skipped';
  }

  function dropFile(job: EnrichmentRow, group: ResolvedGroupConfig | undefined): void {
    if (job.kind !== 'image' || group?.ingest.media) return;
    try {
      rmSync(job.payload, { force: true });
    } catch (e) {
      log.warn({ err: e, path: job.payload }, 'could not delete media file');
    }
  }

  async function processImage(
    job: EnrichmentRow,
    msg: MessageRow,
    group: ResolvedGroupConfig,
  ): Promise<JobOutcome> {
    const a = getAdapter();
    if (!a) return skip(job, adapterError ?? 'no adapter');
    if (!a.describeImage) {
      dropFile(job, group);
      return skip(job, describeEnrichError({ tag: 'unsupported-adapter', adapter: a.name }));
    }
    if (!underCap(job)) return 'capped';
    const prompt = imagePrompt(msg.body);
    const t = nowTs();
    store.markEnrichmentCalled(tenantId, job.id, t);
    const r = await a.describeImage({
      tenantId,
      groupJid: job.groupJid,
      system: prompt.system,
      user: prompt.user,
      image: {
        path: job.payload,
        mimeType: MIME_BY_EXT[extname(job.payload).toLowerCase()] ?? 'image/jpeg',
      },
    });
    if (!r.ok) return fail(job, { tag: 'model', error: r.error });
    store.setMediaDescription(tenantId, job.groupJid, job.messageId, r.value.text.trim());
    store.completeEnrichment(tenantId, job.id, nowTs());
    dropFile(job, group);
    log.info(
      {
        group: job.groupJid,
        message_id: job.messageId,
        kind: 'image',
        model: r.value.model,
        durationMs: r.value.durationMs,
        costUsd: r.value.costUsd,
      },
      'image described',
    );
    log.debug({ message_id: job.messageId, description: r.value.text }, 'image description');
    return 'done';
  }

  function mergeLink(msg: MessageRow, entry: LinkInfo): void {
    const current = store.getMessage(tenantId, msg.groupJid, msg.id)?.links ?? [];
    const links = current.some((l) => l.url === entry.url)
      ? current.map((l) => (l.url === entry.url ? entry : l))
      : [...current, entry];
    store.setLinks(tenantId, msg.groupJid, msg.id, links);
  }

  async function processLink(job: EnrichmentRow, msg: MessageRow): Promise<JobOutcome> {
    const url = job.payload;
    const ctx = { group: job.groupJid, message_id: job.messageId, kind: 'link' };
    if (isLoginWalled(url)) {
      mergeLink(msg, { url, title: null, description: null });
      store.completeEnrichment(tenantId, job.id, nowTs());
      log.info({ ...ctx, host: new URL(url).hostname }, 'login-walled host, stored URL only');
      return 'done';
    }
    const page = await fetchPage(url, opts.fetchDeps);
    if (!page.ok) {
      if (page.error.tag === 'blocked-address') {
        mergeLink(msg, { url, title: null, description: null });
        log.warn({ ...ctx, host: page.error.host }, 'refused to fetch a private address');
        return skip(job, describeEnrichError(page.error));
      }
      const outcome = fail(job, page.error);
      if (outcome === 'failed') mergeLink(msg, { url, title: null, description: null });
      return outcome;
    }
    if (page.value.body === '') {
      mergeLink(msg, { url, title: titleFromPath(page.value.finalUrl), description: null });
      store.completeEnrichment(tenantId, job.id, nowTs());
      log.info({ ...ctx, contentType: page.value.contentType }, 'non-text link, stored URL only');
      return 'done';
    }
    const a = getAdapter();
    if (!a) return skip(job, adapterError ?? 'no adapter');
    if (!underCap(job)) return 'capped';
    const stripped = stripHtml(page.value.body);
    const prompt = linkPrompt(page.value.finalUrl, stripped);
    store.markEnrichmentCalled(tenantId, job.id, nowTs());
    const r = await a.complete({
      tenantId,
      groupJid: job.groupJid,
      system: prompt.system,
      user: prompt.user,
      purpose: 'describe',
    });
    if (!r.ok) {
      const outcome = fail(job, { tag: 'model', error: r.error });
      if (outcome === 'failed') mergeLink(msg, { url, title: stripped.title, description: null });
      return outcome;
    }
    mergeLink(msg, { url, title: stripped.title, description: r.value.text.trim() });
    store.completeEnrichment(tenantId, job.id, nowTs());
    log.info(
      { ...ctx, model: r.value.model, durationMs: r.value.durationMs, costUsd: r.value.costUsd },
      'link described',
    );
    log.debug({ message_id: job.messageId, url, description: r.value.text }, 'link description');
    return 'done';
  }

  async function processJob(job: EnrichmentRow): Promise<JobOutcome> {
    const group = resolveGroupConfig(config, job.groupJid);
    const msg = store.getMessage(tenantId, job.groupJid, job.messageId);
    if (!msg || msg.deleted) {
      dropFile(job, undefined);
      return skip(job, msg ? 'message was deleted' : 'message no longer stored');
    }
    if (!group) {
      dropFile(job, undefined);
      return skip(job, 'group is no longer configured');
    }
    try {
      return job.kind === 'image'
        ? await processImage(job, msg, group)
        : await processLink(job, msg);
    } catch (e) {
      log.error(
        { err: e, group: job.groupJid, message_id: job.messageId, kind: job.kind },
        'enrichment job crashed',
      );
      return fail(job, {
        tag: 'fetch',
        url: job.payload,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Jobs run strictly one at a time, whether the poll loop or a drain asks.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  }

  async function pass(
    groupJid: string | undefined,
    limit: number,
    deadlineMs?: number,
  ): Promise<RunOutcome> {
    const jobs = store.claimDueEnrichments(tenantId, nowTs(), limit, groupJid);
    let processed = 0;
    for (const job of jobs) {
      if (stopped && deadlineMs === undefined) break;
      if (deadlineMs !== undefined && now() >= deadlineMs) break;
      const outcome = await processJob(job);
      if (outcome === 'capped') return { processed, capped: true };
      processed += 1;
    }
    return { processed, capped: false };
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  function runOnce(o: { groupJid?: string; limit?: number } = {}): Promise<RunOutcome> {
    return serialized(() => pass(o.groupJid, o.limit ?? DEFAULT_BATCH));
  }

  async function drain(groupJid: string, deadlineMs: number): Promise<number> {
    const until = now() + deadlineMs;
    await serialized(async () => {
      for (;;) {
        if (now() >= until) break;
        const r = await pass(groupJid, DEFAULT_BATCH, until);
        if (r.capped || r.processed === 0) break;
      }
    });
    const remaining = store.pendingEnrichments(tenantId, groupJid);
    if (remaining > 0)
      log.info({ group: groupJid, remaining }, 'drain ended with jobs still queued');
    return remaining;
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await runOnce();
      } catch (e) {
        log.error({ err: e }, 'enrichment pass failed');
      }
      schedule();
    }, pollMs);
    timer.unref?.();
  }

  return {
    runOnce,
    drain,
    start() {
      if (timer) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
