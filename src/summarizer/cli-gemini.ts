import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, err, ok, type Result } from '../shared/index.js';
import { runCli } from './run-cli.js';
import { summarizeVia } from './summarize-via.js';
import type { AdapterOptions, Summarizer, SummarizerError } from './types.js';

const log = createLogger('summarizer:cli-gemini');

const DEFAULT_BIN = 'gemini';
const DEFAULT_TIMEOUT_MS = 180_000;
/** Prefix of the per-call temp directory holding the system prompt file. */
export const GEMINI_TMP_PREFIX = 'wa-digest-gemini-';

export interface ParsedGeminiOutput {
  text: string;
  model: string | null;
}

/**
 * Parse `gemini -p … -o json` stdout: one JSON object with `response` and
 * `stats.models.<name>.tokens`. Failures come as `{ error: { message } }` on
 * stderr with a non-zero exit, which `runCli` reports before we get here, but
 * the same envelope is handled in case it ever lands on stdout.
 */
export function parseGeminiOutput(stdout: string): Result<ParsedGeminiOutput, SummarizerError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    return err({ tag: 'parse', message: `stdout is not JSON: ${String(e)}`, raw: stdout });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return err({ tag: 'parse', message: 'stdout JSON is not an object', raw: stdout });
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.error === 'object' && obj.error !== null) {
    const message = (obj.error as Record<string, unknown>).message;
    return err({
      tag: 'model',
      message: typeof message === 'string' && message ? message : 'gemini reported an error',
    });
  }
  const response = typeof obj.response === 'string' ? obj.response.trim() : '';
  if (response === '') return err({ tag: 'model', message: 'gemini returned an empty response' });
  return ok({ text: response, model: pickModel(obj.stats) });
}

/** The model that produced the most output tokens, or null without stats. */
function pickModel(stats: unknown): string | null {
  if (typeof stats !== 'object' || stats === null) return null;
  const models = (stats as Record<string, unknown>).models;
  if (typeof models !== 'object' || models === null) return null;
  return (
    Object.entries(models as Record<string, unknown>)
      .map(([name, m]) => ({ name, out: candidateTokens(m) }))
      .sort((a, b) => b.out - a.out)[0]?.name ?? null
  );
}

function candidateTokens(m: unknown): number {
  if (typeof m !== 'object' || m === null) return 0;
  const tokens = (m as Record<string, unknown>).tokens;
  if (typeof tokens !== 'object' || tokens === null) return 0;
  const v = (tokens as Record<string, unknown>).candidates;
  return typeof v === 'number' ? v : 0;
}

/**
 * Headless flags. The prompt itself travels on stdin (`-p ""` only switches
 * the CLI into non-interactive mode and appends nothing). `-e none` drops
 * every extension; `--approval-mode plan` keeps the built-in tools read-only
 * in case the model reaches for one. The system prompt is not a flag: it is
 * the file named by `GEMINI_SYSTEM_MD`, set per call in `complete`.
 */
export function geminiArgs(model: string | undefined): string[] {
  return [
    '-p',
    '',
    '-o',
    'json',
    '-e',
    'none',
    '--approval-mode',
    'plan',
    ...(model ? ['-m', model] : []),
  ];
}

/**
 * On failure the CLI exits non-zero and prints its JSON error envelope on
 * stderr (after any warnings). Surface that message as a model error instead
 * of a raw exit code; fall back to the exit error when there is no envelope.
 */
function stderrError(
  exit: Extract<SummarizerError, { tag: 'exit' }>,
): Result<never, SummarizerError> {
  const start = exit.stderr.indexOf('{');
  if (start < 0) return err(exit);
  const parsed = parseGeminiOutput(exit.stderr.slice(start));
  if (!parsed.ok && parsed.error.tag === 'model') return err(parsed.error);
  return err(exit);
}

export function createGeminiCliSummarizer(opts: AdapterOptions = {}): Summarizer {
  const bin = opts.bin ?? DEFAULT_BIN;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const complete: Summarizer['complete'] = async (req) => {
    log.info(
      {
        tenant_id: req.tenantId,
        group: req.groupJid,
        purpose: req.purpose,
        chars: req.user.length,
        bin,
      },
      'invoking gemini',
    );
    log.debug({ system: req.system, user: req.user }, 'prompt');

    // The system prompt goes through GEMINI_SYSTEM_MD, which replaces the
    // CLI's coding-agent prompt wholesale. The same throwaway directory is
    // the child's cwd, so no GEMINI.md, .gemini/ settings, or trusted-folder
    // state from wherever the agent runs can leak into the call.
    const dir = await mkdtemp(join(tmpdir(), GEMINI_TMP_PREFIX));
    const systemPath = join(dir, 'system.md');
    try {
      await writeFile(systemPath, req.system, 'utf8');
      const run = await runCli({
        bin,
        args: geminiArgs(opts.model),
        stdin: req.user,
        timeoutMs,
        cwd: dir,
        env: { GEMINI_SYSTEM_MD: systemPath },
      });
      if (!run.ok) return run.error.tag === 'exit' ? stderrError(run.error) : run;
      log.debug({ stderr: run.value.stderr }, 'gemini stderr');

      const parsed = parseGeminiOutput(run.value.stdout);
      if (!parsed.ok) return parsed;
      return ok({
        text: parsed.value.text,
        model: parsed.value.model ?? opts.model ?? null,
        durationMs: run.value.durationMs,
        // Subscription / free-tier usage; the CLI reports tokens, not money.
        costUsd: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  return {
    name: 'cli-gemini',
    summarize: (input) => summarizeVia('cli-gemini', input, complete),
    complete,
  };
}
