import { tmpdir } from 'node:os';
import { createLogger, err, ok, type Result } from '../shared/index.js';
import { runCli } from './run-cli.js';
import { summarizeVia } from './summarize-via.js';
import type { AdapterOptions, Summarizer, SummarizerError } from './types.js';

const log = createLogger('summarizer:cli-codex');

const DEFAULT_BIN = 'codex';
const DEFAULT_TIMEOUT_MS = 180_000;

export interface ParsedCodexOutput {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Parse `codex exec --json` stdout: JSON lines, one event each. The answer is
 * the last `item.completed` whose item is an `agent_message`; token usage
 * rides on `turn.completed`. A `turn.failed` or `error` event is a model
 * error with the CLI's message.
 */
export function parseCodexOutput(stdout: string): Result<ParsedCodexOutput, SummarizerError> {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v === 'object' && v !== null) events.push(v as Record<string, unknown>);
    } catch {
      // progress noise on stdout; ignore
    }
  }
  if (events.length === 0) {
    return err({ tag: 'parse', message: 'stdout has no JSON events', raw: stdout });
  }

  let text = '';
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (const ev of events) {
    switch (ev.type) {
      case 'item.completed': {
        const item = ev.item;
        if (typeof item !== 'object' || item === null) break;
        const it = item as Record<string, unknown>;
        if (it.type === 'agent_message' && typeof it.text === 'string') text = it.text;
        break;
      }
      case 'turn.completed': {
        const usage = ev.usage;
        if (typeof usage === 'object' && usage !== null) {
          const u = usage as Record<string, unknown>;
          inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : null;
          outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : null;
        }
        break;
      }
      case 'turn.failed': {
        const e = ev.error;
        const message =
          typeof e === 'object' && e !== null
            ? (e as Record<string, unknown>).message
            : typeof e === 'string'
              ? e
              : undefined;
        return err({
          tag: 'model',
          message: typeof message === 'string' && message ? message : 'codex turn failed',
        });
      }
      case 'error': {
        const message = ev.message;
        return err({
          tag: 'model',
          message: typeof message === 'string' && message ? message : 'codex reported an error',
        });
      }
      default:
        break;
    }
  }
  const trimmed = text.trim();
  if (trimmed === '') return err({ tag: 'model', message: 'codex returned no agent message' });
  return ok({ text: trimmed, inputTokens, outputTokens });
}

/**
 * Headless flags for `codex exec`. The prompt comes from stdin (`-`). No
 * session files, no `~/.codex/config.toml`, no `.rules`, a read-only sandbox
 * in case the model reaches for a tool, and a throwaway cwd so no AGENTS.md
 * from wherever the agent runs is picked up. Auth still comes from
 * `$CODEX_HOME/auth.json`.
 */
export function codexArgs(cwd: string, model: string | undefined): string[] {
  return [
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
    cwd,
    ...(model ? ['-m', model] : []),
    '-',
  ];
}

/**
 * Codex has no system-prompt flag, so both halves travel in one prompt: the
 * rules first, the material after a hard separator.
 */
export function codexPrompt(system: string, user: string): string {
  return `${system}\n\n---\n\n${user}`;
}

export function createCodexCliSummarizer(opts: AdapterOptions = {}): Summarizer {
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
      'invoking codex',
    );
    log.debug({ system: req.system, user: req.user }, 'prompt');

    const cwd = tmpdir();
    const run = await runCli({
      bin,
      args: codexArgs(cwd, opts.model),
      stdin: codexPrompt(req.system, req.user),
      timeoutMs,
      cwd,
    });
    if (!run.ok) return run;
    log.debug({ stderr: run.value.stderr }, 'codex stderr');

    const parsed = parseCodexOutput(run.value.stdout);
    if (!parsed.ok) return parsed;
    log.debug(
      { input_tokens: parsed.value.inputTokens, output_tokens: parsed.value.outputTokens },
      'codex usage',
    );
    return ok({
      text: parsed.value.text,
      // The event stream does not name the model; report the configured one.
      model: opts.model ?? null,
      durationMs: run.value.durationMs,
      // ChatGPT-plan usage; the CLI reports tokens, not money.
      costUsd: null,
    });
  };

  return {
    name: 'cli-codex',
    summarize: (input) => summarizeVia('cli-codex', input, complete),
    complete,
  };
}
