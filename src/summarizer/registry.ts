import { err, ok, type Result } from '../shared/index.js';
import { createClaudeCliSummarizer } from './cli-claude.js';
import { createFakeSummarizer } from './fake.js';
import type { AdapterOptions, Summarizer } from './types.js';

const FACTORIES: Record<string, (opts: AdapterOptions) => Summarizer> = {
  fake: () => createFakeSummarizer(),
  'cli-claude': createClaudeCliSummarizer,
};

export const ADAPTER_NAMES: readonly string[] = Object.keys(FACTORIES);

export interface UnknownAdapterError {
  tag: 'unknown-adapter';
  name: string;
  available: readonly string[];
}

export function createSummarizer(
  name: string,
  opts: AdapterOptions = {},
): Result<Summarizer, UnknownAdapterError> {
  const factory = FACTORIES[name];
  if (!factory) return err({ tag: 'unknown-adapter', name, available: ADAPTER_NAMES });
  return ok(factory(opts));
}
