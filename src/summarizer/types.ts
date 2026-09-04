import type { SummaryOptions } from '../config/index.js';
import type { Result } from '../shared/index.js';
import type { MessageRow } from '../store/index.js';

export interface SummaryInput {
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

export interface Summarizer {
  readonly name: string;
  summarize(input: SummaryInput): Promise<Result<Summary, SummarizerError>>;
}

/** Per-adapter settings from `summarizers.<name>` in config.yaml. */
export interface AdapterOptions {
  /** Executable name or path for CLI adapters. */
  bin?: string;
  model?: string;
  timeoutMs?: number;
}
