import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createGeminiCliSummarizer,
  GEMINI_TMP_PREFIX,
  geminiArgs,
  parseGeminiOutput,
} from './cli-gemini.js';
import { loadFixtureTranscript } from './fixtures.js';
import type { SummaryInput } from './types.js';

describe('parseGeminiOutput', () => {
  it('extracts text and the model that produced the answer', () => {
    const r = parseGeminiOutput(
      JSON.stringify({
        session_id: 'abc',
        response: '  Summary text.\n',
        stats: {
          models: {
            'gemini-2.5-flash-lite': { tokens: { prompt: 100, candidates: 3 } },
            'gemini-2.5-pro': { tokens: { prompt: 9000, candidates: 420 } },
          },
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe('Summary text.');
      expect(r.value.model).toBe('gemini-2.5-pro');
    }
  });

  it('returns null model when stats are absent', () => {
    const r = parseGeminiOutput(JSON.stringify({ response: 'ok' }));
    expect(r.ok && r.value.model).toBeNull();
  });

  it('turns an error envelope into a model error with the message', () => {
    const r = parseGeminiOutput(
      JSON.stringify({
        session_id: 'abc',
        error: { type: 'Error', message: 'Please set an Auth method', code: 41 },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.tag).toBe('model');
      if (r.error.tag === 'model') expect(r.error.message).toContain('Auth method');
    }
  });

  it('rejects an empty response and non-JSON output', () => {
    const empty = parseGeminiOutput(JSON.stringify({ response: '   ' }));
    expect(!empty.ok && empty.error.tag).toBe('model');
    const missing = parseGeminiOutput('{}');
    expect(!missing.ok && missing.error.tag).toBe('model');
    const junk = parseGeminiOutput('Loading…');
    expect(!junk.ok && junk.error.tag).toBe('parse');
    const arr = parseGeminiOutput('[1,2]');
    expect(!arr.ok && arr.error.tag).toBe('model');
  });
});

describe('geminiArgs', () => {
  it('runs headless with JSON output, no extensions, read-only tools', () => {
    expect(geminiArgs('gemini-2.5-pro')).toEqual([
      '-p',
      '',
      '-o',
      'json',
      '-e',
      'none',
      '--approval-mode',
      'plan',
      '-m',
      'gemini-2.5-pro',
    ]);
    expect(geminiArgs(undefined)).not.toContain('-m');
  });
});

describe('cli-gemini adapter (unit)', () => {
  it('rejects an empty window without spawning', async () => {
    const s = createGeminiCliSummarizer({ bin: '/nonexistent' });
    const r = await s.summarize(fixtureInput({ messages: [] }));
    expect(!r.ok && r.error.tag).toBe('empty');
  });

  it('surfaces a missing binary as a spawn error', async () => {
    const s = createGeminiCliSummarizer({ bin: '/nonexistent/gemini' });
    const r = await s.summarize(fixtureInput());
    expect(!r.ok && r.error.tag).toBe('spawn');
  });

  it('complete() surfaces a missing binary as a spawn error', async () => {
    const s = createGeminiCliSummarizer({ bin: '/nonexistent/gemini' });
    const r = await s.complete({
      tenantId: 'owner',
      groupJid: 'g@g.us',
      system: 'SYS',
      user: 'Question: hi',
      purpose: 'answer',
    });
    expect(!r.ok && r.error.tag).toBe('spawn');
  });

  it('hands the system prompt over GEMINI_SYSTEM_MD and the user prompt on stdin', async () => {
    const s = createGeminiCliSummarizer({ bin: fakeGeminiBin(), timeoutMs: 10_000 });
    const r = await s.complete({
      tenantId: 'owner',
      groupJid: 'g@g.us',
      system: 'SYSTEM PROMPT HERE',
      user: 'USER PROMPT HERE',
      purpose: 'answer',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe(
        'sys=SYSTEM PROMPT HERE|user=USER PROMPT HERE|cwd-has-gemini-md=false',
      );
      expect(r.value.model).toBe('gemini-fake');
    }
  });

  it('maps a JSON error on stderr with a non-zero exit to a model error', async () => {
    const s = createGeminiCliSummarizer({ bin: failingGeminiBin(), timeoutMs: 10_000 });
    const r = await s.complete({
      tenantId: 'o',
      groupJid: 'g',
      system: 'S',
      user: 'U',
      purpose: 'answer',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.tag).toBe('model');
      if (r.error.tag === 'model') expect(r.error.message).toContain('Please set an Auth method');
    }
  });

  it('removes the temporary system prompt file afterwards', async () => {
    const before = countTmpPromptDirs();
    const s = createGeminiCliSummarizer({ bin: fakeGeminiBin(), timeoutMs: 10_000 });
    await s.complete({ tenantId: 'o', groupJid: 'g', system: 'S', user: 'U', purpose: 'answer' });
    expect(countTmpPromptDirs()).toBe(before);
  });
});

/**
 * A stand-in for `gemini`: reads the system prompt file named by
 * GEMINI_SYSTEM_MD and the user prompt from stdin, prints the JSON envelope
 * the real CLI prints with `-o json`.
 */
function fakeGeminiBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gemini-'));
  const bin = join(dir, 'gemini');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const sys = fs.readFileSync(process.env.GEMINI_SYSTEM_MD, 'utf8');
const user = fs.readFileSync(0, 'utf8');
const hasMd = fs.existsSync('GEMINI.md');
process.stdout.write(JSON.stringify({
  response: 'sys=' + sys + '|user=' + user + '|cwd-has-gemini-md=' + hasMd,
  stats: { models: { 'gemini-fake': { tokens: { prompt: 1, candidates: 1 } } } },
}));
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** What `gemini` does when nobody is logged in: JSON error on stderr, exit 41. */
function failingGeminiBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gemini-'));
  const bin = join(dir, 'gemini');
  writeFileSync(
    bin,
    `#!${process.execPath}
process.stderr.write('Approval mode overridden to "default" because the current folder is not trusted.\\n');
process.stderr.write(JSON.stringify({ session_id: 'x', error: { type: 'Error', message: 'Please set an Auth method in your settings.json', code: 41 } }, null, 2) + '\\n');
process.exitCode = 41;
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function countTmpPromptDirs(): number {
  if (!existsSync(tmpdir())) return 0;
  return readdirSync(tmpdir()).filter((d) => d.startsWith(GEMINI_TMP_PREFIX)).length;
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

// Real CLI call. Needs a logged-in `gemini` (or GEMINI_API_KEY in the env).
describe.skipIf(!process.env.INTEGRATION)('cli-gemini adapter (INTEGRATION=1)', () => {
  it('summarizes the fixture transcript', async () => {
    const s = createGeminiCliSummarizer({ model: process.env.INTEGRATION_MODEL });
    const r = await s.summarize(fixtureInput());
    if (!r.ok) throw new Error(`summarize failed: ${JSON.stringify(r.error)}`);
    const { text, model, durationMs } = r.value;
    console.log(`\n${text}\n\nmodel=${model} ${durationMs}ms`);
    expect(text.length).toBeGreaterThan(100);
    expect(text.split(/\s+/).length).toBeLessThan(320);
    expect(text).toMatch(/11:30|48|Sept(ember)? 15|Sasha|Саша/);
  }, 240_000);
});
