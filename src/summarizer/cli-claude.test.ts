import { describe, expect, it } from 'vitest';
import { claudeArgs, createClaudeCliSummarizer, parseClaudeOutput } from './cli-claude.js';
import { loadFixtureTranscript } from './fixtures.js';
import type { SummaryInput } from './types.js';

describe('parseClaudeOutput', () => {
  it('extracts text, model and cost from a result envelope', () => {
    const r = parseClaudeOutput(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: '  Summary text.\n',
        total_cost_usd: 0.0123,
        modelUsage: { 'claude-sonnet-5': { inputTokens: 1 } },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe('Summary text.');
      expect(r.value.model).toBe('claude-sonnet-5');
      expect(r.value.costUsd).toBe(0.0123);
    }
  });

  it('attributes to the model that produced the most output, not the first key', () => {
    const r = parseClaudeOutput(
      JSON.stringify({
        type: 'result',
        result: 'ok',
        modelUsage: {
          'claude-haiku-4-5-20251001': { outputTokens: 14 },
          'claude-sonnet-5': { outputTokens: 447 },
        },
      }),
    );
    expect(r.ok && r.value.model).toBe('claude-sonnet-5');
  });

  it('turns is_error into a model error with the message', () => {
    const r = parseClaudeOutput(
      JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Not logged in · Please run /login',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.tag).toBe('model');
      if (r.error.tag === 'model') expect(r.error.message).toContain('Not logged in');
    }
  });

  it('rejects an empty result and non-JSON output', () => {
    const empty = parseClaudeOutput(JSON.stringify({ type: 'result', result: '   ' }));
    expect(!empty.ok && empty.error.tag).toBe('model');
    const junk = parseClaudeOutput('Loading…');
    expect(!junk.ok && junk.error.tag).toBe('parse');
    const arr = parseClaudeOutput('[1,2]');
    expect(!arr.ok && arr.error.tag).toBe('model'); // no result field
    const missing = parseClaudeOutput('{}');
    expect(!missing.ok && missing.error.tag).toBe('model');
  });
});

describe('claudeArgs', () => {
  it('runs headless with no tools, no session, no settings', () => {
    const args = claudeArgs('SYS', 'sonnet');
    expect(args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--setting-sources',
      '',
      '--system-prompt',
      'SYS',
      '--model',
      'sonnet',
    ]);
    expect(claudeArgs('SYS', undefined)).not.toContain('--model');
  });
});

describe('cli-claude adapter (unit)', () => {
  it('rejects an empty window without spawning', async () => {
    const s = createClaudeCliSummarizer({ bin: '/nonexistent' });
    const r = await s.summarize({
      tenantId: 'owner',
      groupJid: 'g@g.us',
      groupName: 'G',
      messages: [],
      sinceTs: 0,
      untilTs: 1,
      tz: 'UTC',
      options: {
        language: 'auto',
        style: 'topics',
        max_words: 100,
        personality: 'neutral',
        instructions: '',
      },
    });
    expect(!r.ok && r.error.tag).toBe('empty');
  });

  it('surfaces a missing binary as a spawn error', async () => {
    const s = createClaudeCliSummarizer({ bin: '/nonexistent/claude' });
    const r = await s.summarize(fixtureInput());
    expect(!r.ok && r.error.tag).toBe('spawn');
  });
});

function fixtureInput(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    tenantId: 'owner',
    groupJid: '120363000000000001@g.us',
    groupName: 'Dance team',
    messages: loadFixtureTranscript(),
    sinceTs: 1_756_800_000,
    untilTs: 1_757_000_000,
    tz: 'America/Los_Angeles',
    options: {
      language: 'auto',
      style: 'topics',
      max_words: 200,
      personality: 'neutral',
      instructions: '',
    },
    ...overrides,
  };
}

// Real CLI call. Needs an authenticated `claude`; costs a few cents.
describe.skipIf(!process.env.INTEGRATION)('cli-claude adapter (INTEGRATION=1)', () => {
  it('summarizes the fixture transcript', async () => {
    const s = createClaudeCliSummarizer({ model: process.env.INTEGRATION_MODEL });
    const r = await s.summarize(fixtureInput());
    if (!r.ok) throw new Error(`summarize failed: ${JSON.stringify(r.error)}`);
    const { text, model, costUsd, durationMs } = r.value;
    console.log(`\n${text}\n\nmodel=${model} cost=$${costUsd} ${durationMs}ms`);
    expect(text.length).toBeGreaterThan(100);
    expect(text.split(/\s+/).length).toBeLessThan(320);
    // must reflect the transcript, not hallucinate
    expect(text).toMatch(/11:30|48|Sept(ember)? 15|Sasha|Саша/);
  }, 240_000);
});
