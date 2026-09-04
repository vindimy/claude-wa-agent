import { ApiError, type GenerateContentResponse } from '@google/genai';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyGoogleError,
  createApiGoogleSummarizer,
  DEFAULT_GOOGLE_MODEL,
  estimateGoogleCostUsd,
  googleRequest,
} from './api-google.js';
import { loadFixtureTranscript } from './fixtures.js';
import type { SummaryInput } from './types.js';

const input: SummaryInput = {
  tenantId: 'owner',
  groupJid: '120363000000000001@g.us',
  groupName: 'Team',
  messages: loadFixtureTranscript(),
  sinceTs: 0,
  untilTs: 2_000_000_000,
  tz: 'UTC',
  options: {
    language: 'auto',
    style: 'topics',
    max_words: 200,
    personality: 'neutral',
    instructions: '',
  },
};

function response(over: Partial<GenerateContentResponse> = {}): GenerateContentResponse {
  return {
    modelVersion: 'gemini-3.8-flash',
    candidates: [
      {
        finishReason: 'STOP',
        content: { role: 'model', parts: [{ text: '  Summary text  ' }] },
      },
    ],
    usageMetadata: {
      promptTokenCount: 10_000,
      candidatesTokenCount: 400,
      thoughtsTokenCount: 100,
      totalTokenCount: 10_500,
    },
    ...over,
  } as unknown as GenerateContentResponse;
}

describe('estimateGoogleCostUsd', () => {
  it('prices known models, bills thinking as output, and returns null for unknown ones', () => {
    expect(
      estimateGoogleCostUsd('gemini-3.8-flash', {
        promptTokenCount: 1e6,
        candidatesTokenCount: 5e5,
        thoughtsTokenCount: 5e5,
      }),
    ).toBe(4.5);
    // Cached prompt tokens are a subset of promptTokenCount and cost a tenth.
    expect(
      estimateGoogleCostUsd('gemini-3.1-pro-preview', {
        promptTokenCount: 10_000,
        cachedContentTokenCount: 9_000,
        candidatesTokenCount: 0,
      }),
    ).toBeCloseTo(0.0038, 6);
    expect(estimateGoogleCostUsd('mystery', { promptTokenCount: 1 })).toBeNull();
  });
});

describe('googleRequest', () => {
  it('sends the system prompt as systemInstruction and the transcript as contents', () => {
    const req = googleRequest('SYS', 'USER', 'gemini-3.8-flash', 5000);
    expect(req).toMatchObject({ model: 'gemini-3.8-flash', contents: 'USER' });
    expect(req.config?.systemInstruction).toBe('SYS');
    expect(req.config?.maxOutputTokens).toBeGreaterThan(0);
    expect(req.config?.httpOptions?.timeout).toBe(5000);
  });
});

describe('createApiGoogleSummarizer', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('returns the trimmed text, model, and cost from the API response', async () => {
    const calls: Array<{ model: string; timeout: number | undefined }> = [];
    const s = createApiGoogleSummarizer(
      { model: 'gemini-2.5-flash', timeoutMs: 5000 },
      {
        generate: async (params) => {
          calls.push({ model: params.model, timeout: params.config?.httpOptions?.timeout });
          expect(params.config?.systemInstruction).toBeTypeOf('string');
          expect(params.contents).toContain('Lena');
          return response({ modelVersion: 'gemini-2.5-flash' });
        },
      },
    );
    const r = await s.summarize(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      text: 'Summary text',
      adapter: 'api-google',
      model: 'gemini-2.5-flash',
      messageCount: input.messages.length,
      costUsd: 0.00425,
    });
    expect(calls).toEqual([{ model: 'gemini-2.5-flash', timeout: 5000 }]);
  });

  it('defaults to gemini-3.8-flash', async () => {
    let model = '';
    const s = createApiGoogleSummarizer(
      {},
      {
        generate: async (p) => {
          model = p.model;
          return response();
        },
      },
    );
    await s.summarize(input);
    expect(model).toBe('gemini-3.8-flash');
    expect(DEFAULT_GOOGLE_MODEL).toBe('gemini-3.8-flash');
  });

  it('drops thought parts from the summary text', async () => {
    const s = createApiGoogleSummarizer(
      {},
      {
        generate: async () =>
          response({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [{ text: 'thinking...', thought: true }, { text: 'Real summary' }],
                },
              },
            ],
          } as Partial<GenerateContentResponse>),
      },
    );
    const r = await s.summarize(input);
    expect(r.ok && r.value.text).toBe('Real summary');
  });

  it('turns a blocked prompt and a safety stop into model errors', async () => {
    const blocked = createApiGoogleSummarizer(
      {},
      {
        generate: async () =>
          response({
            candidates: [],
            promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
          } as Partial<GenerateContentResponse>),
      },
    );
    const b = await blocked.summarize(input);
    expect(!b.ok && b.error).toMatchObject({ tag: 'model' });
    expect(!b.ok && b.error.tag === 'model' && b.error.message).toContain('PROHIBITED_CONTENT');

    const safety = createApiGoogleSummarizer(
      {},
      {
        generate: async () =>
          response({
            candidates: [{ finishReason: 'SAFETY', content: { role: 'model', parts: [] } }],
          } as Partial<GenerateContentResponse>),
      },
    );
    const r = await safety.summarize(input);
    expect(!r.ok && r.error.tag === 'model' && r.error.message).toContain('SAFETY');
  });

  it('still returns a summary that hit MAX_TOKENS', async () => {
    const s = createApiGoogleSummarizer(
      {},
      {
        generate: async () =>
          response({
            candidates: [
              {
                finishReason: 'MAX_TOKENS',
                content: { role: 'model', parts: [{ text: 'Cut off' }] },
              },
            ],
          } as Partial<GenerateContentResponse>),
      },
    );
    const r = await s.summarize(input);
    expect(r.ok && r.value.text).toBe('Cut off');
  });

  it('fails on an empty response and on thrown SDK errors', async () => {
    const empty = createApiGoogleSummarizer(
      {},
      { generate: async () => response({ candidates: [] }) },
    );
    expect((await empty.summarize(input)).ok).toBe(false);
    const boom = createApiGoogleSummarizer(
      {},
      {
        generate: async () => {
          throw new DOMException('The operation timed out', 'TimeoutError');
        },
      },
    );
    const r = await boom.summarize(input);
    expect(!r.ok && r.error).toEqual({ tag: 'timeout', bin: 'api-google', timeoutMs: 180_000 });
  });

  it('fails before calling the SDK when no API key is configured', async () => {
    process.env.GOOGLE_API_KEY = undefined;
    process.env.GEMINI_API_KEY = undefined;
    const s = createApiGoogleSummarizer();
    const r = await s.summarize(input);
    expect(!r.ok && r.error).toMatchObject({
      tag: 'model',
      message: expect.stringContaining('GOOGLE_API_KEY'),
    });
  });

  it('rejects an empty window without calling the API', async () => {
    const s = createApiGoogleSummarizer(
      {},
      {
        generate: async () => {
          throw new Error('should not be called');
        },
      },
    );
    expect(await s.summarize({ ...input, messages: [] })).toEqual({
      ok: false,
      error: { tag: 'empty' },
    });
  });
});

describe('classifyGoogleError', () => {
  it('maps SDK errors to tagged errors', () => {
    const auth = new ApiError({ status: 401, message: 'API key not valid' });
    expect(classifyGoogleError(auth, 1)).toMatchObject({
      tag: 'model',
      message: expect.stringContaining('GOOGLE_API_KEY'),
    });
    const limit = new ApiError({ status: 429, message: 'quota' });
    expect(classifyGoogleError(limit, 1)).toMatchObject({
      tag: 'model',
      message: expect.stringContaining('rate limit'),
    });
    expect(classifyGoogleError(new Error('x'), 1)).toEqual({ tag: 'model', message: 'x' });
  });

  it('recognises the 400 the API returns for a bad key and unwraps JSON error bodies', () => {
    const badKey = new ApiError({
      status: 400,
      message: JSON.stringify({
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [{ reason: 'API_KEY_INVALID' }],
        },
      }),
    });
    expect(classifyGoogleError(badKey, 1)).toMatchObject({
      message: expect.stringContaining('GOOGLE_API_KEY'),
    });
    const overloaded = new ApiError({
      status: 503,
      message: JSON.stringify({ error: { code: 503, message: 'The model is overloaded.' } }),
    });
    expect(classifyGoogleError(overloaded, 1)).toEqual({
      tag: 'model',
      message: 'Gemini API error 503: The model is overloaded.',
    });
  });
});

describe('api-google complete()', () => {
  it('sends the given system and user text and returns the completion', async () => {
    const seen: Array<{ system: unknown; contents: unknown }> = [];
    const s = createApiGoogleSummarizer(
      { model: 'gemini-3.8-flash' },
      {
        generate: async (params) => {
          seen.push({ system: params.config?.systemInstruction, contents: params.contents });
          return response();
        },
      },
    );
    const r = await s.complete({
      tenantId: 'owner',
      groupJid: 'g@g.us',
      system: 'ANSWER SYS',
      user: 'Question: who?',
      purpose: 'answer',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe('Summary text');
    expect(seen).toEqual([{ system: 'ANSWER SYS', contents: 'Question: who?' }]);
  });
});
