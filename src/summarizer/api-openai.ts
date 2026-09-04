import OpenAI from 'openai';
import { createLogger, err, ok } from '../shared/index.js';
import { buildPrompt } from './prompt.js';
import type { AdapterOptions, Summarizer, SummarizerError, SummaryInput } from './types.js';

const log = createLogger('summarizer:api-openai');

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';
const DEFAULT_TIMEOUT_MS = 180_000;
/**
 * Reasoning tokens count against this cap, so it is well above what the
 * few-hundred-word summary itself needs.
 */
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Standard-tier prices, USD per million tokens (input, cached input, output),
 * short-context column, from platform.openai.com/docs/pricing on 2026-09-04.
 */
const PRICES: Record<string, [number, number, number]> = {
  'gpt-6-astra': [10, 1, 50],
  'gpt-5.6-sol': [4, 0.4, 20],
  'gpt-5.6-terra': [2, 0.2, 12],
  'gpt-5.6-luna': [0.2, 0.02, 1.2],
  'gpt-5.4-mini': [0.75, 0.075, 4.5],
  'gpt-5.4-nano': [0.2, 0.02, 1.25],
  'gpt-5.2': [1.75, 0.175, 14],
  'gpt-5.1': [1.25, 0.125, 10],
  'gpt-5': [1.25, 0.125, 10],
  'gpt-5-mini': [0.25, 0.025, 2],
  'gpt-5-nano': [0.05, 0.005, 0.4],
  'gpt-4.1': [2, 0.5, 8],
  'gpt-4.1-mini': [0.4, 0.1, 1.6],
  'gpt-4.1-nano': [0.1, 0.025, 0.4],
};

export interface OpenAiUsage {
  /** Includes the cached tokens reported in `input_tokens_details`. */
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number } | null;
}

/** Cost from the price table, or null for a model we do not know. */
export function estimateOpenAiCostUsd(model: string, usage: OpenAiUsage): number | null {
  const price = PRICES[model] ?? PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
  if (!price) return null;
  const [inPrice, cachedPrice, outPrice] = price;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const fresh = Math.max(usage.input_tokens - cached, 0);
  const cost = (fresh * inPrice + cached * cachedPrice + usage.output_tokens * outPrice) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

type CreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type CreateFn = (
  params: CreateParams,
  reqOpts: { timeout: number },
) => Promise<OpenAI.Responses.Response>;

export interface ApiOpenAiDeps {
  /** Test seam: replaces the SDK call. */
  create?: CreateFn;
  apiKey?: string;
}

export function openAiRequest(system: string, user: string, model: string): CreateParams {
  return {
    model,
    instructions: system,
    input: user,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    // One-shot: nothing to resume, no reason to keep the transcript on their side.
    store: false,
  };
}

/**
 * OpenAI Responses API adapter. Same prompt and `Summary` shape as the other
 * `api-*` adapters. Reads `OPENAI_API_KEY` unless a key is injected.
 */
export function createApiOpenAiSummarizer(
  opts: AdapterOptions = {},
  deps: ApiOpenAiDeps = {},
): Summarizer {
  const model = opts.model ?? DEFAULT_OPENAI_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let create = deps.create;

  return {
    name: 'api-openai',
    async summarize(input: SummaryInput) {
      if (input.messages.length === 0) return err({ tag: 'empty' as const });
      const prompt = buildPrompt(input);
      log.info(
        {
          tenant_id: input.tenantId,
          group: input.groupJid,
          messages: input.messages.length,
          chars: prompt.user.length,
          model,
        },
        'calling the OpenAI API',
      );
      log.debug({ system: prompt.system, user: prompt.user }, 'prompt');

      if (!create) {
        try {
          const client = new OpenAI({
            ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
            timeout: timeoutMs,
            maxRetries: 2,
          });
          create = (params, reqOpts) => client.responses.create(params, reqOpts);
        } catch (e) {
          return err({ tag: 'model' as const, message: describeError(e) });
        }
      }

      const started = Date.now();
      let response: OpenAI.Responses.Response;
      try {
        response = await create(openAiRequest(prompt.system, prompt.user, model), {
          timeout: timeoutMs,
        });
      } catch (e) {
        return err(classifyOpenAiError(e, timeoutMs));
      }
      const durationMs = Date.now() - started;

      if (response.status === 'failed' || response.error) {
        return err({
          tag: 'model' as const,
          message: `OpenAI response failed: ${response.error?.message ?? 'no error details'}`,
        });
      }
      const reason = response.incomplete_details?.reason;
      if (response.status === 'incomplete' && reason && reason !== 'max_output_tokens') {
        return err({
          tag: 'model' as const,
          message: `OpenAI stopped the response early (${reason})`,
        });
      }
      const refusal = findRefusal(response);
      if (refusal !== undefined) {
        return err({
          tag: 'model' as const,
          message: `the model declined to summarize this transcript: ${refusal}`,
        });
      }
      const text = response.output_text.trim();
      if (!text) return err({ tag: 'model' as const, message: 'the API returned no text' });
      if (reason === 'max_output_tokens') {
        log.warn(
          { model, maxOutputTokens: MAX_OUTPUT_TOKENS },
          'summary hit max_output_tokens; it may be cut off',
        );
      }

      return ok({
        text,
        adapter: 'api-openai',
        model: response.model,
        messageCount: input.messages.length,
        inputChars: prompt.user.length,
        durationMs,
        costUsd: response.usage ? estimateOpenAiCostUsd(response.model, response.usage) : null,
      });
    },
  };
}

function findRefusal(response: OpenAI.Responses.Response): string | undefined {
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'refusal') return part.refusal;
    }
  }
  return undefined;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function classifyOpenAiError(e: unknown, timeoutMs: number): SummarizerError {
  if (e instanceof OpenAI.APIConnectionTimeoutError) {
    return { tag: 'timeout', bin: 'api-openai', timeoutMs };
  }
  if (e instanceof OpenAI.AuthenticationError) {
    return { tag: 'model', message: 'OpenAI rejected the API key (set OPENAI_API_KEY)' };
  }
  if (e instanceof OpenAI.RateLimitError) {
    return { tag: 'model', message: 'OpenAI rate limit hit; the scheduler retries later' };
  }
  if (e instanceof OpenAI.APIError) {
    return { tag: 'model', message: `OpenAI API error ${e.status ?? ''}: ${e.message}`.trim() };
  }
  return { tag: 'model', message: describeError(e) };
}
