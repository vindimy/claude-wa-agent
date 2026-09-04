import { randomUUID } from 'node:crypto';
import {
  type Config,
  personalityNames,
  type ResolvedGroupConfig,
  resolvePersonality,
} from '../config/index.js';
import { createLogger, err, ok, type Result } from '../shared/index.js';
import type { QuestionRecord, Store } from '../store/index.js';
import {
  buildAskPrompt,
  createSummarizer,
  type Summarizer,
  type SummarizerError,
  type UnknownAdapterError,
} from '../summarizer/index.js';
import { describeSummarizerError } from './run-digest.js';

export interface AskRequest {
  tenantId: string;
  store: Store;
  config: Config;
  group: ResolvedGroupConfig;
  question: string;
  /** Window bounds, unix seconds. `sinceTs: 0` means everything stored. */
  sinceTs: number;
  untilTs: number;
  tz: string;
  adapter?: string;
  /** Clock in ms; defaults to Date.now(). */
  now?: () => number;
  /** Test seam. */
  summarizerFactory?: (
    name: string,
    opts: Parameters<typeof createSummarizer>[1],
  ) => Result<Summarizer, UnknownAdapterError>;
}

export interface Answer {
  text: string;
  adapter: string;
  model: string | null;
  messageCount: number;
  inputChars: number;
  durationMs: number;
  costUsd: number | null;
}

export type AskResult = { kind: 'empty' } | { kind: 'ok'; answer: Answer; record: QuestionRecord };

export type AskError =
  | { tag: 'unknown-adapter'; name: string; available: readonly string[] }
  | { tag: 'unknown-personality'; name: string; available: readonly string[] }
  | { tag: 'complete'; error: SummarizerError };

/**
 * Answer one question about one group from the messages stored for a window.
 * Nothing is delivered here and no digest watermark moves: the caller (CLI or
 * the `/ask` command) decides where the answer goes. Every attempt is
 * recorded in `questions` so the dashboard can show cost and failures.
 */
export async function askQuestion(req: AskRequest): Promise<Result<AskResult, AskError>> {
  const { tenantId, store, config, group, sinceTs, untilTs, tz } = req;
  const now = req.now ?? Date.now;
  const log = createLogger('ask', { tenant_id: tenantId });
  const question = req.question.trim();
  const groupName = group.name ?? group.jid;

  const personality = resolvePersonality(config, group.summary.personality);
  if (personality === undefined) {
    return err({
      tag: 'unknown-personality',
      name: group.summary.personality,
      available: personalityNames(config),
    });
  }

  const messages = store.messagesSince(tenantId, group.jid, sinceTs).filter((m) => m.ts <= untilTs);
  if (messages.length === 0) return ok({ kind: 'empty' });

  const adapterName = req.adapter ?? group.summarizer;
  const adapterCfg = config.summarizers[adapterName] ?? {};
  const factory = req.summarizerFactory ?? createSummarizer;
  const summarizer = factory(adapterName, {
    bin: adapterCfg.bin,
    model: adapterCfg.model,
    timeoutMs: adapterCfg.timeout_seconds ? adapterCfg.timeout_seconds * 1000 : undefined,
  });
  if (!summarizer.ok) return err(summarizer.error);

  const prompt = buildAskPrompt({
    tenantId,
    groupJid: group.jid,
    groupName,
    messages,
    sinceTs,
    untilTs,
    tz,
    question,
    options: group.summary,
    personality,
  });
  log.info(
    {
      group: group.jid,
      adapter: adapterName,
      messages: messages.length,
      chars: prompt.user.length,
    },
    'answering a question',
  );
  const result = await summarizer.value.complete({
    tenantId,
    groupJid: group.jid,
    system: prompt.system,
    user: prompt.user,
    purpose: 'answer',
  });
  const base = {
    tenantId,
    id: randomUUID(),
    groupJid: group.jid,
    question,
    sinceTs,
    untilTs,
    messageCount: messages.length,
    createdTs: Math.floor(now() / 1000),
  };
  if (!result.ok) {
    store.insertQuestion({
      ...base,
      answer: null,
      adapter: adapterName,
      model: null,
      status: 'error',
      error: describeSummarizerError(result.error),
      costUsd: null,
      durationMs: null,
    });
    return err({ tag: 'complete', error: result.error });
  }
  const c = result.value;
  const record: QuestionRecord = {
    ...base,
    answer: c.text,
    adapter: adapterName,
    model: c.model,
    status: 'ok',
    error: null,
    costUsd: c.costUsd,
    durationMs: c.durationMs,
  };
  store.insertQuestion(record);
  log.info(
    {
      group: group.jid,
      adapter: adapterName,
      model: c.model,
      durationMs: c.durationMs,
      costUsd: c.costUsd,
    },
    'question answered and recorded',
  );
  return ok({
    kind: 'ok',
    record,
    answer: {
      text: c.text,
      adapter: adapterName,
      model: c.model,
      messageCount: messages.length,
      inputChars: prompt.user.length,
      durationMs: c.durationMs,
      costUsd: c.costUsd,
    },
  });
}

export function describeAskError(e: AskError): string {
  if (e.tag === 'unknown-adapter') {
    return `unknown summarizer "${e.name}" (available: ${e.available.join(', ')})`;
  }
  if (e.tag === 'unknown-personality') {
    return `unknown personality "${e.name}" (available: ${e.available.join(', ')})`;
  }
  return describeSummarizerError(e.error);
}
