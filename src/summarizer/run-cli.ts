import { spawn } from 'node:child_process';
import { err, ok, type Result } from '../shared/index.js';

export interface CliRunOptions {
  bin: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
}

export interface CliRunOutput {
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
}

export type CliRunError =
  | { tag: 'spawn'; bin: string; message: string }
  | { tag: 'timeout'; bin: string; timeoutMs: number }
  | { tag: 'exit'; bin: string; code: number | null; stderr: string };

const STDERR_KEEP = 2_000;
const KILL_GRACE_MS = 5_000;

/**
 * Run a binary non-interactively: prompt on stdin, collect stdout/stderr,
 * enforce a wall-clock timeout. Never uses a shell, so arguments are passed
 * verbatim.
 */
export function runCli(opts: CliRunOptions): Promise<Result<CliRunOutput, CliRunError>> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Strip the nested-session markers so the adapter also works when the
    // agent itself was launched from inside a Claude Code session.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.bin, opts.args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
      resolve(err({ tag: 'spawn', bin: opts.bin, message: String(e) }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, KILL_GRACE_MS).unref();
    }, opts.timeoutMs);

    const finish = (result: Result<CliRunOutput, CliRunError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (e) => finish(err({ tag: 'spawn', bin: opts.bin, message: e.message })));

    child.on('close', (code) => {
      if (timedOut) {
        finish(err({ tag: 'timeout', bin: opts.bin, timeoutMs: opts.timeoutMs }));
      } else if (code !== 0) {
        finish(err({ tag: 'exit', bin: opts.bin, code, stderr: stderr.slice(-STDERR_KEEP) }));
      } else {
        finish(ok({ stdout, stderr, code: 0, durationMs: Date.now() - started }));
      }
    });

    child.stdin?.on('error', () => {
      // EPIPE when the child exits before reading stdin; 'close' reports it.
    });
    child.stdin?.end(opts.stdin);
  });
}
