import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  apiRequest,
  classifyError,
  createApiAnthropicSummarizer,
  estimateCostUsd,
} from './api-anthropic.js';
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

function response(over: Partial<Anthropic.Beta.Messages.BetaMessage> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: '  Summary text  ', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10_000,
      output_tokens: 500,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
    ...over,
  } as unknown as Anthropic.Beta.Messages.BetaMessage;
}

describe('estimateCostUsd', () => {
  it('prices known models and returns null for unknown ones', () => {
    expect(estimateCostUsd('claude-opus-5', { input_tokens: 1e6, output_tokens: 1e6 })).toBe(30);
    expect(
      estimateCostUsd('claude-sonnet-5', {
        input_tokens: 1000,
        output_tokens: 0,
        cache_read_input_tokens: 10_000,
      }),
    ).toBeCloseTo(0.004, 6);
    expect(estimateCostUsd('claude-opus-5-20260401', { input_tokens: 1e6, output_tokens: 0 })).toBe(
      5,
    );
    expect(estimateCostUsd('mystery', { input_tokens: 1, output_tokens: 1 })).toBeNull();
  });
});

describe('apiRequest', () => {
  it('sends the prompt on a single user turn with server-side fallbacks', () => {
    const req = apiRequest('SYS', 'USER', 'claude-opus-5');
    expect(req).toMatchObject({
      model: 'claude-opus-5',
      system: 'SYS',
      messages: [{ role: 'user', content: 'USER' }],
      fallbacks: 'default',
    });
    expect(req.betas).toContain('server-side-fallback-2026-07-01');
  });
});

describe('createApiAnthropicSummarizer', () => {
  it('returns the trimmed text, model, and cost from the API response', async () => {
    const calls: Array<{ model: string; timeout: number }> = [];
    const s = createApiAnthropicSummarizer(
      { model: 'claude-sonnet-5', timeoutMs: 5000 },
      {
        create: async (params, o) => {
          calls.push({ model: params.model, timeout: o.timeout });
          expect(typeof params.system).toBe('string');
          expect(params.messages[0]?.content).toContain('Lena');
          return response({ model: 'claude-sonnet-5' });
        },
      },
    );
    const r = await s.summarize(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      text: 'Summary text',
      adapter: 'api-anthropic',
      model: 'claude-sonnet-5',
      messageCount: input.messages.length,
      costUsd: 0.025,
    });
    expect(calls).toEqual([{ model: 'claude-sonnet-5', timeout: 5000 }]);
  });

  it('defaults to claude-opus-5', async () => {
    let model = '';
    const s = createApiAnthropicSummarizer(
      {},
      {
        create: async (p) => {
          model = p.model;
          return response();
        },
      },
    );
    await s.summarize(input);
    expect(model).toBe('claude-opus-5');
  });

  it('turns a refusal into a model error', async () => {
    const s = createApiAnthropicSummarizer(
      {},
      {
        create: async () =>
          response({
            stop_reason: 'refusal',
            stop_details: {
              type: 'refusal',
              category: 'cyber',
              explanation: null,
              fallback_credit_token: null,
              fallback_has_prefill_claim: false,
              recommended_model: null,
            } as unknown as Anthropic.Beta.Messages.BetaRefusalStopDetails,
            content: [],
          }),
      },
    );
    const r = await s.summarize(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ tag: 'model' });
    expect(r.error.tag === 'model' && r.error.message).toContain('cyber');
  });

  it('fails on an empty response and on thrown SDK errors', async () => {
    const empty = createApiAnthropicSummarizer(
      {},
      { create: async () => response({ content: [] }) },
    );
    expect((await empty.summarize(input)).ok).toBe(false);
    const boom = createApiAnthropicSummarizer(
      {},
      {
        create: async () => {
          throw new Anthropic.APIConnectionTimeoutError({ message: 'slow' });
        },
      },
    );
    const r = await boom.summarize(input);
    expect(!r.ok && r.error).toEqual({ tag: 'timeout', bin: 'api-anthropic', timeoutMs: 180_000 });
  });

  it('rejects an empty window without calling the API', async () => {
    const s = createApiAnthropicSummarizer(
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

describe('classifyError', () => {
  it('maps SDK error classes to tagged errors', () => {
    const auth = new Anthropic.AuthenticationError(401, { error: {} }, 'nope', new Headers());
    expect(classifyError(auth, 1)).toMatchObject({ tag: 'model' });
    expect(classifyError(auth, 1)).toMatchObject({ message: expect.stringContaining('API key') });
    expect(classifyError(new Error('x'), 1)).toEqual({ tag: 'model', message: 'x' });
  });
});

describe('api-anthropic complete()', () => {
  it('sends the given system and user text and returns the completion', async () => {
    const seen: Array<{ system: unknown; user: unknown }> = [];
    const s = createApiAnthropicSummarizer(
      { model: 'claude-sonnet-5' },
      {
        create: async (params) => {
          seen.push({ system: params.system, user: params.messages[0]?.content });
          return response({ model: 'claude-sonnet-5' });
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
    expect(r.value).toMatchObject({
      text: 'Summary text',
      model: 'claude-sonnet-5',
      costUsd: 0.025,
    });
    expect(seen).toEqual([{ system: 'ANSWER SYS', user: 'Question: who?' }]);
  });

  it('words a refusal for the purpose of the call', async () => {
    const s = createApiAnthropicSummarizer(
      {},
      {
        create: async () =>
          response({
            stop_reason: 'refusal',
            stop_details: {
              type: 'refusal',
              category: 'general_harms',
              explanation: null,
              fallback_credit_token: null,
              fallback_has_prefill_claim: false,
              recommended_model: null,
            } as unknown as Anthropic.Beta.Messages.BetaRefusalStopDetails,
            content: [],
          }),
      },
    );
    const r = await s.complete({
      tenantId: 'owner',
      groupJid: 'g@g.us',
      system: 'S',
      user: 'U',
      purpose: 'answer',
    });
    expect(!r.ok && r.error.tag === 'model' && r.error.message).toContain('declined to answer');
  });
});
