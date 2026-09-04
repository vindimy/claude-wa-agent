import Anthropic from '@anthropic-ai/sdk';
import { createLogger, err, ok } from '../shared/index.js';
import { summarizeVia } from './summarize-via.js';
import {
  type AdapterOptions,
  purposeVerb,
  type Summarizer,
  type SummarizerError,
} from './types.js';

const log = createLogger('summarizer:api-anthropic');

export const DEFAULT_API_MODEL = 'claude-opus-5';
const DEFAULT_TIMEOUT_MS = 180_000;
/** Summaries are capped at a few hundred words; this leaves ample room. */
const MAX_TOKENS = 4096;

/** First-party API prices, USD per million tokens (input, output). */
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
};

export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Cost from the price table, or null for a model we do not know. */
export function estimateCostUsd(model: string, usage: ApiUsage): number | null {
  const price = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, '')];
  if (!price) return null;
  const [inPrice, outPrice] = price;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const inputCost =
    (usage.input_tokens * inPrice + cacheRead * inPrice * 0.1 + cacheWrite * inPrice * 1.25) / 1e6;
  const outputCost = (usage.output_tokens * outPrice) / 1e6;
  return Math.round((inputCost + outputCost) * 1e6) / 1e6;
}

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type CreateFn = (
  params: CreateParams,
  reqOpts: { timeout: number },
) => Promise<Anthropic.Beta.Messages.BetaMessage>;

export interface ApiAnthropicDeps {
  /** Test seam: replaces the SDK call. */
  create?: CreateFn;
  apiKey?: string;
}

export function apiRequest(system: string, user: string, model: string): CreateParams {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
    // If the safety classifiers decline a group's transcript, let the API
    // re-run the request on a fallback model inside the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
}

/**
 * Anthropic Messages API adapter: the `api-*` path that any tenant can use
 * with their own key. Same prompt as `cli-claude`, same `Summary` shape.
 * Reads `ANTHROPIC_API_KEY` (or an `ant auth login` profile) unless a key is
 * injected.
 */
export function createApiAnthropicSummarizer(
  opts: AdapterOptions = {},
  deps: ApiAnthropicDeps = {},
): Summarizer {
  const model = opts.model ?? DEFAULT_API_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let create = deps.create;

  const complete: Summarizer['complete'] = async (req) => {
    log.info(
      {
        tenant_id: req.tenantId,
        group: req.groupJid,
        purpose: req.purpose,
        chars: req.user.length,
        model,
      },
      'calling the Anthropic API',
    );
    log.debug({ system: req.system, user: req.user }, 'prompt');

    if (!create) {
      try {
        const client = new Anthropic({
          ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
          timeout: timeoutMs,
          maxRetries: 2,
        });
        create = (params, reqOpts) => client.beta.messages.create(params, reqOpts);
      } catch (e) {
        return err({ tag: 'model' as const, message: describeSdkError(e) });
      }
    }

    const started = Date.now();
    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await create(apiRequest(req.system, req.user, model), { timeout: timeoutMs });
    } catch (e) {
      return err(classifyError(e, timeoutMs));
    }
    const durationMs = Date.now() - started;

    if (response.stop_reason === 'refusal') {
      const why = response.stop_details?.type === 'refusal' ? response.stop_details : undefined;
      return err({
        tag: 'model' as const,
        message: `the model declined to ${purposeVerb(req.purpose)}${
          why?.category ? ` (${why.category})` : ''
        }`,
      });
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!text) return err({ tag: 'model' as const, message: 'the API returned no text' });
    if (response.stop_reason === 'max_tokens') {
      log.warn({ model, maxTokens: MAX_TOKENS }, 'response hit max_tokens; it may be cut off');
    }

    return ok({
      text,
      model: response.model,
      durationMs,
      costUsd: estimateCostUsd(response.model, response.usage),
    });
  };

  return {
    name: 'api-anthropic',
    summarize: (input) => summarizeVia('api-anthropic', input, complete),
    complete,
  };
}

function describeSdkError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function classifyError(e: unknown, timeoutMs: number): SummarizerError {
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return { tag: 'timeout', bin: 'api-anthropic', timeoutMs };
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return { tag: 'model', message: 'Anthropic rejected the API key (set ANTHROPIC_API_KEY)' };
  }
  if (e instanceof Anthropic.RateLimitError) {
    return { tag: 'model', message: 'Anthropic rate limit hit; the scheduler retries later' };
  }
  if (e instanceof Anthropic.APIError) {
    return { tag: 'model', message: `Anthropic API error ${e.status ?? ''}: ${e.message}`.trim() };
  }
  return { tag: 'model', message: describeSdkError(e) };
}
