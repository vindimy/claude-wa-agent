import { describe, expect, it } from 'vitest';
import { runCli } from './run-cli.js';

const node = process.execPath;

describe('runCli', () => {
  it('pipes stdin and collects stdout', async () => {
    const r = await runCli({
      bin: node,
      args: ['-e', 'process.stdin.on("data", d => process.stdout.write("got:" + d))'],
      stdin: 'hello',
      timeoutMs: 10_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.stdout).toBe('got:hello');
      expect(r.value.code).toBe(0);
    }
  });

  it('reports a non-zero exit with stderr', async () => {
    const r = await runCli({
      bin: node,
      args: ['-e', 'console.error("boom"); process.exit(3)'],
      stdin: '',
      timeoutMs: 10_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.tag).toBe('exit');
      if (r.error.tag === 'exit') {
        expect(r.error.code).toBe(3);
        expect(r.error.stderr).toContain('boom');
      }
    }
  });

  it('kills the child after the timeout', async () => {
    const r = await runCli({
      bin: node,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      stdin: '',
      timeoutMs: 300,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tag).toBe('timeout');
  });

  it('reports a missing binary as a spawn error', async () => {
    const r = await runCli({
      bin: '/nonexistent/definitely-not-a-binary',
      args: [],
      stdin: '',
      timeoutMs: 1_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tag).toBe('spawn');
  });
});
