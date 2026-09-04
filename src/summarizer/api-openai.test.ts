import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import {
  classifyOpenAiError,
  createApiOpenAiSummarizer,
  DEFAULT_OPENAI_MODEL,
  estimateOpenAiCostUsd,
  openAiRequest,
} from './api-openai.js';
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
  options: { language: 'auto', style: 'topics', max_words: 200 },
};

function response(over: Partial<OpenAI.Responses.Response> = {}): OpenAI.Responses.Response {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    model: 'gpt-5.6-terra',
    status: 'completed',
    output_text: '  Summary text  ',
    output: [
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '  Summary text  ', annotations: [] }],
      },
    ],
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: 10_000,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 500,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 10_500,
    },
    ...over,
  } as unknown as OpenAI.Responses.Response;
}

describe('estimateOpenAiCostUsd', () => {
  it('prices known models, bills cached input at the cached rate, and returns null for unknown ones', () => {
    expect(estimateOpenAiCostUsd('gpt-5.6-terra', { input_tokens: 1e6, output_tokens: 1e6 })).toBe(
      14,
    );
    expect(
      estimateOpenAiCostUsd('gpt-5.6-terra', {
        input_tokens: 10_000,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 9_000 },
      }),
    ).toBeCloseTo(0.0038, 6);
    expect(
      estimateOpenAiCostUsd('gpt-5.2-2025-12-11', { input_tokens: 1e6, output_tokens: 0 }),
    ).toBe(1.75);
    expect(estimateOpenAiCostUsd('mystery', { input_tokens: 1, output_tokens: 1 })).toBeNull();
  });
});

describe('openAiRequest', () => {
  it('sends the system prompt as instructions and the transcript as input', () => {
    const req = openAiRequest('SYS', 'USER', 'gpt-5.6-terra');
    expect(req).toMatchObject({ model: 'gpt-5.6-terra', instructions: 'SYS', input: 'USER' });
    expect(req.max_output_tokens).toBeGreaterThan(0);
    expect(req.stream).toBeFalsy();
  });
});

describe('createApiOpenAiSummarizer', () => {
  it('returns the trimmed text, model, and cost from the API response', async () => {
    const calls: Array<{ model: string; timeout: number }> = [];
    const s = createApiOpenAiSummarizer(
      { model: 'gpt-5.6-luna', timeoutMs: 5000 },
      {
        create: async (params, o) => {
          calls.push({ model: String(params.model), timeout: o.timeout });
          expect(typeof params.instructions).toBe('string');
          expect(params.input).toContain('Lena');
          return response({ model: 'gpt-5.6-luna' });
        },
      },
    );
    const r = await s.summarize(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      text: 'Summary text',
      adapter: 'api-openai',
      model: 'gpt-5.6-luna',
      messageCount: input.messages.length,
      costUsd: 0.0026,
    });
    expect(calls).toEqual([{ model: 'gpt-5.6-luna', timeout: 5000 }]);
  });

  it('defaults to gpt-5.6-terra', async () => {
    let model = '';
    const s = createApiOpenAiSummarizer(
      {},
      {
        create: async (p) => {
          model = String(p.model);
          return response();
        },
      },
    );
    await s.summarize(input);
    expect(model).toBe('gpt-5.6-terra');
    expect(DEFAULT_OPENAI_MODEL).toBe('gpt-5.6-terra');
  });

  it('turns a refusal into a model error', async () => {
    const s = createApiOpenAiSummarizer(
      {},
      {
        create: async () =>
          response({
            output_text: '',
            output: [
              {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
              },
            ] as unknown as OpenAI.Responses.ResponseOutputItem[],
          }),
      },
    );
    const r = await s.summarize(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ tag: 'model' });
    expect(r.error.tag === 'model' && r.error.message).toContain('I cannot help with that.');
  });

  it('reports a content-filter cutoff and a failed response as model errors', async () => {
    const filtered = createApiOpenAiSummarizer(
      {},
      {
        create: async () =>
          response({
            status: 'incomplete',
            incomplete_details: { reason: 'content_filter' },
          }),
      },
    );
    const f = await filtered.summarize(input);
    expect(!f.ok && f.error).toMatchObject({ tag: 'model' });

    const failed = createApiOpenAiSummarizer(
      {},
      {
        create: async () =>
          response({
            status: 'failed',
            output_text: '',
            output: [],
            error: { code: 'server_error', message: 'boom' },
          }),
      },
    );
    const r = await failed.summarize(input);
    expect(!r.ok && r.error).toEqual({ tag: 'model', message: 'OpenAI response failed: boom' });
  });

  it('still returns a summary that hit max_output_tokens', async () => {
    const s = createApiOpenAiSummarizer(
      {},
      {
        create: async () =>
          response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
      },
    );
    const r = await s.summarize(input);
    expect(r.ok && r.value.text).toBe('Summary text');
  });

  it('fails on an empty response and on thrown SDK errors', async () => {
    const empty = createApiOpenAiSummarizer(
      {},
      { create: async () => response({ output_text: '', output: [] }) },
    );
    expect((await empty.summarize(input)).ok).toBe(false);
    const boom = createApiOpenAiSummarizer(
      {},
      {
        create: async () => {
          throw new OpenAI.APIConnectionTimeoutError({ message: 'slow' });
        },
      },
    );
    const r = await boom.summarize(input);
    expect(!r.ok && r.error).toEqual({ tag: 'timeout', bin: 'api-openai', timeoutMs: 180_000 });
  });

  it('rejects an empty window without calling the API', async () => {
    const s = createApiOpenAiSummarizer(
      {},
      {
        create: async () => {
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

describe('classifyOpenAiError', () => {
  it('maps SDK error classes to tagged errors', () => {
    const auth = new OpenAI.AuthenticationError(401, { error: {} }, 'nope', new Headers());
    expect(classifyOpenAiError(auth, 1)).toMatchObject({
      tag: 'model',
      message: expect.stringContaining('OPENAI_API_KEY'),
    });
    const limit = new OpenAI.RateLimitError(429, { error: {} }, 'slow down', new Headers());
    expect(classifyOpenAiError(limit, 1)).toMatchObject({
      tag: 'model',
      message: expect.stringContaining('rate limit'),
    });
    expect(classifyOpenAiError(new Error('x'), 1)).toEqual({ tag: 'model', message: 'x' });
  });
});
