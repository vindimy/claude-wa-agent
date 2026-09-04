import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexArgs, codexPrompt, createCodexCliSummarizer, parseCodexOutput } from './cli-codex.js';
import { loadFixtureTranscript } from './fixtures.js';
import type { SummaryInput } from './types.js';

const jsonl = (...events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

describe('parseCodexOutput', () => {
  it('takes the last agent message and the turn usage', () => {
    const r = parseCodexOutput(
      jsonl(
        { type: 'thread.started', thread_id: 't1' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } },
        { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'draft' } },
        { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: '  Final.\n' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: 22_106, cached_input_tokens: 0, output_tokens: 6 },
        },
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe('Final.');
      expect(r.value.inputTokens).toBe(22_106);
      expect(r.value.outputTokens).toBe(6);
    }
  });

  it('ignores non-JSON lines mixed into stdout', () => {
    const r = parseCodexOutput(
      `warning: something\n${jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })}`,
    );
    expect(r.ok && r.value.text).toBe('ok');
  });

  it('turns a failed turn into a model error with the message', () => {
    const r = parseCodexOutput(
      jsonl({ type: 'turn.started' }, { type: 'turn.failed', error: { message: 'Not logged in' } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.tag).toBe('model');
      if (r.error.tag === 'model') expect(r.error.message).toContain('Not logged in');
    }
  });

  it('turns a top-level error event into a model error', () => {
    const r = parseCodexOutput(jsonl({ type: 'error', message: 'rate limited' }));
    expect(!r.ok && r.error.tag === 'model' && r.error.message).toBe('rate limited');
  });

  it('rejects output without an agent message', () => {
    const none = parseCodexOutput(jsonl({ type: 'turn.completed', usage: {} }));
    expect(!none.ok && none.error.tag).toBe('model');
    const blank = parseCodexOutput(
      jsonl({ type: 'item.completed', item: { type: 'agent_message', text: '  ' } }),
    );
    expect(!blank.ok && blank.error.tag).toBe('model');
    const empty = parseCodexOutput('');
    expect(!empty.ok && empty.error.tag).toBe('parse');
  });
});

describe('codexArgs', () => {
  it('runs exec headless, read-only, without session files or user config', () => {
    expect(codexArgs('/tmp/x', 'gpt-5.6-terra')).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--color',
      'never',
      '-s',
      'read-only',
      '-C',
      '/tmp/x',
      '-m',
      'gpt-5.6-terra',
      '-',
    ]);
    const noModel = codexArgs('/tmp/x', undefined);
    expect(noModel).not.toContain('-m');
    expect(noModel[noModel.length - 1]).toBe('-');
  });
});

describe('codexPrompt', () => {
  it('puts the system prompt first and the user prompt after a separator', () => {
    const p = codexPrompt('SYS', 'USER');
    expect(p.indexOf('SYS')).toBeLessThan(p.indexOf('USER'));
    expect(p).toContain('SYS');
    expect(p).toContain('USER');
  });
});

describe('cli-codex adapter (unit)', () => {
  it('rejects an empty window without spawning', async () => {
    const s = createCodexCliSummarizer({ bin: '/nonexistent' });
    const r = await s.summarize(fixtureInput({ messages: [] }));
    expect(!r.ok && r.error.tag).toBe('empty');
  });

  it('surfaces a missing binary as a spawn error', async () => {
    const s = createCodexCliSummarizer({ bin: '/nonexistent/codex' });
    const r = await s.summarize(fixtureInput());
    expect(!r.ok && r.error.tag).toBe('spawn');
  });

  it('complete() surfaces a missing binary as a spawn error', async () => {
    const s = createCodexCliSummarizer({ bin: '/nonexistent/codex' });
    const r = await s.complete({
      tenantId: 'owner',
      groupJid: 'g@g.us',
      system: 'SYS',
      user: 'Question: hi',
      purpose: 'answer',
    });
    expect(!r.ok && r.error.tag).toBe('spawn');
  });

  it('sends the combined prompt on stdin and reports the configured model', async () => {
    const s = createCodexCliSummarizer({
      bin: fakeCodexBin(),
      model: 'gpt-test',
      timeoutMs: 10_000,
    });
    const r = await s.complete({
      tenantId: 'owner',
      groupJid: 'g@g.us',
      system: 'SYSTEM PROMPT HERE',
      user: 'USER PROMPT HERE',
      purpose: 'answer',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe(`echo:${codexPrompt('SYSTEM PROMPT HERE', 'USER PROMPT HERE')}`);
      expect(r.value.model).toBe('gpt-test');
      expect(r.value.costUsd).toBeNull();
    }
  });
});

/** A stand-in for `codex exec --json`: echoes stdin back as the agent message. */
function fakeCodexBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
  const bin = join(dir, 'codex');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
const out = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'echo:' + input } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
];
process.stdout.write(out.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

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

// Real CLI call. Needs a logged-in `codex` (`codex login status`).
describe.skipIf(!process.env.INTEGRATION)('cli-codex adapter (INTEGRATION=1)', () => {
  it('summarizes the fixture transcript', async () => {
    const s = createCodexCliSummarizer({ model: process.env.INTEGRATION_MODEL });
    const r = await s.summarize(fixtureInput());
    if (!r.ok) throw new Error(`summarize failed: ${JSON.stringify(r.error)}`);
    const { text, model, durationMs } = r.value;
    console.log(`\n${text}\n\nmodel=${model} ${durationMs}ms`);
    expect(text.length).toBeGreaterThan(100);
    expect(text.split(/\s+/).length).toBeLessThan(320);
    expect(text).toMatch(/11:30|48|Sept(ember)? 15|Sasha|Саша/);
  }, 240_000);
});
