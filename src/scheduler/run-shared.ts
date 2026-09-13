import type { Config } from '../config/index.js';
import type { Result } from '../shared/index.js';
import {
  createSummarizer,
  type Summarizer,
  type UnknownAdapterError,
} from '../summarizer/index.js';

export type SummarizerFactory = (
  name: string,
  opts: Parameters<typeof createSummarizer>[1],
) => Result<Summarizer, UnknownAdapterError>;

/** Build the adapter named `adapterName` with its `summarizers.<name>` options. */
export function summarizerFor(
  config: Config,
  adapterName: string,
  factory: SummarizerFactory = createSummarizer,
): Result<Summarizer, UnknownAdapterError> {
  const adapterCfg = config.summarizers[adapterName] ?? {};
  return factory(adapterName, {
    bin: adapterCfg.bin,
    model: adapterCfg.model,
    timeoutMs: adapterCfg.timeout_seconds ? adapterCfg.timeout_seconds * 1000 : undefined,
  });
}
