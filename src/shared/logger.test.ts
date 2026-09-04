import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRootLogger, settingsFromEnv, transportTargets } from './logger.js';

function readLines(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}.`) && f.endsWith('.log'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean));
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for log files');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('settingsFromEnv', () => {
  it('logs to stdout only when LOG_DIR is unset or blank', () => {
    expect(settingsFromEnv({}).logDir).toBeUndefined();
    expect(settingsFromEnv({ LOG_DIR: '  ' }).logDir).toBeUndefined();
  });

  it('reads level and directory from the environment', () => {
    const s = settingsFromEnv({ LOG_LEVEL: 'debug', LOG_DIR: '/var/log/wa' });
    expect(s.level).toBe('debug');
    expect(s.logDir).toBe('/var/log/wa');
  });

  it('defaults to info', () => {
    expect(settingsFromEnv({}).level).toBe('info');
  });
});

describe('transportTargets', () => {
  it('keeps a single stdout target without a log directory', () => {
    const targets = transportTargets({ level: 'info', pretty: false });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      target: 'pino/file',
      level: 'info',
      options: { destination: 1 },
    });
  });

  it('uses pino-pretty for the console when pretty', () => {
    const targets = transportTargets({ level: 'info', pretty: true });
    expect(targets[0]?.target).toBe('pino-pretty');
  });

  it('adds a rolling full log and a rolling warn+ log under the directory', () => {
    const targets = transportTargets({ level: 'debug', pretty: false, logDir: '/logs' });
    expect(targets.map((t) => t.target)).toEqual(['pino/file', 'pino-roll', 'pino-roll']);
    expect(targets[1]).toMatchObject({
      level: 'debug',
      options: { file: join('/logs', 'app'), mkdir: true, frequency: 'daily' },
    });
    expect(targets[2]).toMatchObject({
      level: 'warn',
      options: {
        file: join('/logs', 'errors'),
        mkdir: true,
        frequency: 'daily',
        limit: { count: 30, removeOtherLogFiles: true },
      },
    });
  });
});

describe('createRootLogger', () => {
  it('writes every line to app.* and only warn+ to errors.*', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'wa-digest-logs-')), 'nested');
    const log = createRootLogger({ level: 'info', pretty: false, logDir: dir }).child({
      module: 't',
    });
    log.info('hello');
    log.warn({ tenant_id: 'owner' }, 'careful');
    log.error('broken');
    log.flush();

    await waitFor(() => readLines(dir, 'app').length >= 3 && readLines(dir, 'errors').length >= 2);

    const app = readLines(dir, 'app').map((l) => JSON.parse(l));
    const errors = readLines(dir, 'errors').map((l) => JSON.parse(l));
    expect(app.map((l) => l.msg)).toEqual(['hello', 'careful', 'broken']);
    expect(errors.map((l) => l.msg)).toEqual(['careful', 'broken']);
    expect(errors[0]).toMatchObject({ level: 40, module: 't', tenant_id: 'owner' });
  });
});
