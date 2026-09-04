import { createLogger, err, ok, type Result } from '../shared/index.js';
import { buildPrompt } from './prompt.js';
import { runCli } from './run-cli.js';
import type { AdapterOptions, Summarizer, SummarizerError, SummaryInput } from './types.js';

const log = createLogger('summarizer:cli-claude');

const DEFAULT_BIN = 'claude';
const DEFAULT_TIMEOUT_MS = 180_000;

export interface ParsedClaudeOutput {
  text: string;
  model: string | null;
  costUsd: number | null;
}

/**
 * Parse `claude -p --output-format json` stdout. The CLI prints one JSON
 * object with `type: "result"`; on failure it still exits 0 but sets
 * `is_error: true` with the message in `result`.
 */
export function parseClaudeOutput(stdout: string): Result<ParsedClaudeOutput, SummarizerError> {
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
  const result = typeof obj.result === 'string' ? obj.result : '';
  if (obj.is_error === true) {
    return err({ tag: 'model', message: result || 'claude reported an error' });
  }
  if (result.trim() === '') {
    return err({ tag: 'model', message: 'claude returned an empty result' });
  }
  const modelUsage =
    typeof obj.modelUsage === 'object' && obj.modelUsage !== null
      ? (obj.modelUsage as Record<string, unknown>)
      : {};
  // The CLI may make small side-calls on another model (seen: a 14-token
  // haiku call next to the real sonnet call), so attribute to the model that
  // produced the most output rather than the first key.
  const model =
    Object.entries(modelUsage)
      .map(([name, u]) => ({ name, out: outputTokens(u) }))
      .sort((a, b) => b.out - a.out)[0]?.name ?? null;
  const costUsd = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;
  return ok({ text: result.trim(), model, costUsd });
}

function outputTokens(u: unknown): number {
  if (typeof u !== 'object' || u === null) return 0;
  const v = (u as Record<string, unknown>).outputTokens;
  return typeof v === 'number' ? v : 0;
}

export function claudeArgs(system: string, model: string | undefined): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    // Pure text-in/text-out: no tools, no MCP servers, no skills, no session
    // files, no settings/CLAUDE.md pickup from wherever the agent runs. Without
    // --strict-mcp-config the user's MCP tool definitions ride along on every
    // call (measured: ~78k context tokens vs ~500).
    '--tools',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--system-prompt',
    system,
    ...(model ? ['--model', model] : []),
  ];
}

export function createClaudeCliSummarizer(opts: AdapterOptions = {}): Summarizer {
  const bin = opts.bin ?? DEFAULT_BIN;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: 'cli-claude',
    async summarize(input: SummaryInput) {
      if (input.messages.length === 0) return err({ tag: 'empty' as const });
      const prompt = buildPrompt(input);
      log.info(
        { group: input.groupJid, messages: input.messages.length, chars: prompt.user.length, bin },
        'invoking claude',
      );
      log.debug({ system: prompt.system, user: prompt.user }, 'prompt');

      const run = await runCli({
        bin,
        args: claudeArgs(prompt.system, opts.model),
        stdin: prompt.user,
        timeoutMs,
      });
      if (!run.ok) return run;
      log.debug({ stderr: run.value.stderr }, 'claude stderr');

      const parsed = parseClaudeOutput(run.value.stdout);
      if (!parsed.ok) return parsed;
      return ok({
        text: parsed.value.text,
        adapter: 'cli-claude',
        model: parsed.value.model,
        messageCount: input.messages.length,
        inputChars: prompt.user.length,
        durationMs: run.value.durationMs,
        costUsd: parsed.value.costUsd,
      });
    },
  };
}
