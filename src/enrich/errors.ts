import type { SummarizerError } from '../summarizer/index.js';

/** Everything that can go wrong while producing one description. */
export type EnrichError =
  | { tag: 'download'; message: string }
  | { tag: 'fetch'; url: string; message: string }
  | { tag: 'blocked-address'; url: string; host: string }
  | { tag: 'unsupported-adapter'; adapter: string }
  | { tag: 'model'; error: SummarizerError }
  | { tag: 'cap'; max: number };

export function describeEnrichError(e: EnrichError): string {
  switch (e.tag) {
    case 'download':
      return `media download failed: ${e.message}`;
    case 'fetch':
      return `fetch failed for ${e.url}: ${e.message}`;
    case 'blocked-address':
      return `refused to fetch ${e.url}: ${e.host} resolves to a private or local address`;
    case 'unsupported-adapter':
      return `adapter ${e.adapter} cannot describe images`;
    case 'model':
      return describeModelError(e.error);
    case 'cap':
      return `daily enrichment cap of ${e.max} model calls reached`;
  }
}

function describeModelError(e: SummarizerError): string {
  switch (e.tag) {
    case 'empty':
      return 'nothing to describe';
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
