import {
  ApiError,
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';
import { createLogger, err, ok } from '../shared/index.js';
import { buildPrompt } from './prompt.js';
import type { AdapterOptions, Summarizer, SummarizerError, SummaryInput } from './types.js';

const log = createLogger('summarizer:api-google');

export const DEFAULT_GOOGLE_MODEL = 'gemini-3.8-flash';
const DEFAULT_TIMEOUT_MS = 180_000;
/** Thinking tokens count against this cap, so it is well above the summary's size. */
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Paid-tier standard prices, USD per million tokens (input, output), for
 * prompts up to 200k tokens, from ai.google.dev/gemini-api/docs/pricing on
 * 2026-09-04. Output prices include thinking tokens. Cached input is billed
 * at a tenth of the input price.
 */
const PRICES: Record<string, [number, number]> = {
  'gemini-3.8-flash': [0.75, 3.75],
  'gemini-3.7-flash': [0.75, 3.75],
  'gemini-3.6-flash': [0.75, 3.75],
  'gemini-3.5-flash': [1.5, 9],
  'gemini-3.5-flash-lite': [0.3, 2.5],
  'gemini-3.1-flash-lite': [0.25, 1.5],
  'gemini-3.1-pro-preview': [2, 12],
  'gemini-3-flash-preview': [0.5, 3],
  'gemini-2.5-pro': [1.25, 10],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
};

export interface GoogleUsage {
  /** Includes the cached tokens reported in `cachedContentTokenCount`. */
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

/** Cost from the price table, or null for a model we do not know. */
export function estimateGoogleCostUsd(model: string, usage: GoogleUsage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const [inPrice, outPrice] = price;
  const cached = usage.cachedContentTokenCount ?? 0;
  const fresh = Math.max((usage.promptTokenCount ?? 0) - cached, 0);
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const cost = (fresh * inPrice + cached * inPrice * 0.1 + output * outPrice) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

type GenerateFn = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;

export interface ApiGoogleDeps {
  /** Test seam: replaces the SDK call. */
  generate?: GenerateFn;
  apiKey?: string;
}

export function googleRequest(
  system: string,
  user: string,
  model: string,
  timeoutMs: number,
): GenerateContentParameters {
  return {
    model,
    contents: user,
    config: {
      systemInstruction: system,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      httpOptions: { timeout: timeoutMs },
    },
  };
}

/**
 * Gemini API adapter. Same prompt and `Summary` shape as the other `api-*`
 * adapters. Reads `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) unless a key is
 * injected.
 */
export function createApiGoogleSummarizer(
  opts: AdapterOptions = {},
  deps: ApiGoogleDeps = {},
): Summarizer {
  const model = opts.model ?? DEFAULT_GOOGLE_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let generate = deps.generate;

  return {
    name: 'api-google',
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
        'calling the Gemini API',
      );
      log.debug({ system: prompt.system, user: prompt.user }, 'prompt');

      if (!generate) {
        const apiKey = deps.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
        if (!apiKey) {
          return err({
            tag: 'model' as const,
            message: 'no Gemini API key (set GOOGLE_API_KEY or GEMINI_API_KEY)',
          });
        }
        try {
          const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: timeoutMs } });
          generate = (params) => client.models.generateContent(params);
        } catch (e) {
          return err({ tag: 'model' as const, message: describeError(e) });
        }
      }

      const started = Date.now();
      let response: GenerateContentResponse;
      try {
        response = await generate(googleRequest(prompt.system, prompt.user, model, timeoutMs));
      } catch (e) {
        return err(classifyGoogleError(e, timeoutMs));
      }
      const durationMs = Date.now() - started;

      const blocked = response.promptFeedback?.blockReason;
      if (blocked) {
        return err({
          tag: 'model' as const,
          message: `Gemini blocked the transcript (${blocked})`,
        });
      }
      const candidate = response.candidates?.[0];
      const finish = candidate?.finishReason;
      if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
        return err({
          tag: 'model' as const,
          message: `the model declined to summarize this transcript (${finish})`,
        });
      }
      const text = (candidate?.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (!text) return err({ tag: 'model' as const, message: 'the API returned no text' });
      if (finish === 'MAX_TOKENS') {
        log.warn(
          { model, maxOutputTokens: MAX_OUTPUT_TOKENS },
          'summary hit maxOutputTokens; it may be cut off',
        );
      }

      const usedModel = response.modelVersion ?? model;
      return ok({
        text,
        adapter: 'api-google',
        model: usedModel,
        messageCount: input.messages.length,
        inputChars: prompt.user.length,
        durationMs,
        costUsd: response.usageMetadata
          ? estimateGoogleCostUsd(usedModel, response.usageMetadata)
          : null,
      });
    },
  };
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function classifyGoogleError(e: unknown, timeoutMs: number): SummarizerError {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return { tag: 'timeout', bin: 'api-google', timeoutMs };
  }
  if (e instanceof ApiError) {
    const message = unwrapApiMessage(e.message);
    // A bad key comes back as 400 API_KEY_INVALID, not 401.
    if (
      e.status === 401 ||
      e.status === 403 ||
      /API key not valid|API_KEY_INVALID/i.test(message)
    ) {
      return {
        tag: 'model',
        message: 'Gemini rejected the API key (set GOOGLE_API_KEY or GEMINI_API_KEY)',
      };
    }
    if (e.status === 429) {
      return { tag: 'model', message: 'Gemini rate limit hit; the scheduler retries later' };
    }
    return { tag: 'model', message: `Gemini API error ${e.status}: ${message}`.trim() };
  }
  return { tag: 'model', message: describeError(e) };
}

/** The SDK stringifies the whole JSON error body into `message`; pull out the text. */
function unwrapApiMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
    if (typeof parsed?.error?.message === 'string') return parsed.error.message;
  } catch {
    // not JSON
  }
  return raw;
}
