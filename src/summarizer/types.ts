import type { SummaryOptions } from '../config/index.js';
import type { Result } from '../shared/index.js';
import type { MessageRow } from '../store/index.js';

export interface SummaryInput {
  tenantId: string;
  groupJid: string;
  groupName: string;
  /** Non-deleted messages in the window, oldest first. */
  messages: MessageRow[];
  /** Window bounds, unix seconds. */
  sinceTs: number;
  untilTs: number;
  /** IANA time zone used to render timestamps in the transcript. */
  tz: string;
  options: SummaryOptions;
  /**
   * Resolved voice text for `options.personality` (empty or absent for the
   * neutral voice). Resolved by the caller so adapters never read config.
   */
  personality?: string;
}

export interface Summary {
  text: string;
  adapter: string;
  model: string | null;
  messageCount: number;
  /** Size of the transcript handed to the model, in characters. */
  inputChars: number;
  durationMs: number;
  costUsd: number | null;
}

export type SummarizerError =
  | { tag: 'empty' }
  | { tag: 'spawn'; bin: string; message: string }
  | { tag: 'timeout'; bin: string; timeoutMs: number }
  | { tag: 'exit'; bin: string; code: number | null; stderr: string }
  | { tag: 'parse'; message: string; raw: string }
  | { tag: 'model'; message: string };

/** What a `complete()` call is for; adapters use it in logs and error text. */
export type CompletionPurpose = 'summary' | 'answer';

/** One system+user prompt to send to the model, with routing context for logs. */
export interface CompletionRequest {
  tenantId: string;
  groupJid: string;
  system: string;
  user: string;
  purpose: CompletionPurpose;
}

export interface Completion {
  text: string;
  model: string | null;
  durationMs: number;
  costUsd: number | null;
}

/**
 * A model backend. `summarize` is the digest path (fixed prompt, `Summary`
 * shape); `complete` sends any prompt the caller built, which is how `/ask`
 * reuses the same adapters and credentials.
 */
export interface Summarizer {
  readonly name: string;
  summarize(input: SummaryInput): Promise<Result<Summary, SummarizerError>>;
  complete(req: CompletionRequest): Promise<Result<Completion, SummarizerError>>;
}

/** Verb for "the model declined to …" messages. */
export function purposeVerb(purpose: CompletionPurpose): string {
  return purpose === 'answer' ? 'answer this question' : 'summarize this transcript';
}

/** Per-adapter settings from `summarizers.<name>` in config.yaml. */
export interface AdapterOptions {
  /** Executable name or path for CLI adapters. */
  bin?: string;
  model?: string;
  timeoutMs?: number;
}
