import { join } from 'node:path';
import pino, { type TransportTargetOptions } from 'pino';

export interface LoggerSettings {
  level: string;
  /** Human-readable console output (TTY, non-production). Files are always JSON. */
  pretty: boolean;
  /** Directory for rolling log files; undefined means stdout only. */
  logDir?: string;
}

/** Rolling files: rotate daily or at this size, keep this many rotated files per stream. */
const ROLL_SIZE = '20m';
const ROLL_KEEP = 30;

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): LoggerSettings {
  const logDir = env.LOG_DIR?.trim();
  return {
    level: env.LOG_LEVEL ?? 'info',
    pretty: Boolean(process.stdout.isTTY) && env.NODE_ENV !== 'production',
    ...(logDir ? { logDir } : {}),
  };
}

function rolling(dir: string, name: string, level: string): TransportTargetOptions {
  return {
    target: 'pino-roll',
    level,
    options: {
      file: join(dir, name),
      frequency: 'daily',
      size: ROLL_SIZE,
      dateFormat: 'yyyy-MM-dd',
      extension: '.log',
      mkdir: true,
      // Also prune files left by earlier processes (container restarts).
      limit: { count: ROLL_KEEP, removeOtherLogFiles: true },
    },
  };
}

/**
 * Console always; with `logDir`, also `app.<date>.<n>.log` (everything at
 * `level`) and `errors.<date>.<n>.log` (warn and above) so problems can be
 * read without scrolling the full stream.
 */
export function transportTargets(settings: LoggerSettings): TransportTargetOptions[] {
  const console: TransportTargetOptions = settings.pretty
    ? { target: 'pino-pretty', level: settings.level, options: { translateTime: 'SYS:HH:MM:ss' } }
    : { target: 'pino/file', level: settings.level, options: { destination: 1 } };
  if (!settings.logDir) return [console];
  return [
    console,
    rolling(settings.logDir, 'app', settings.level),
    rolling(settings.logDir, 'errors', 'warn'),
  ];
}

export function createRootLogger(settings: LoggerSettings): pino.Logger {
  return pino({ level: settings.level }, pino.transport({ targets: transportTargets(settings) }));
}

const root = createRootLogger(settingsFromEnv());

export type Logger = pino.Logger;

/** One child logger per module; pass `{ tenant_id }` for tenant-scoped work. */
export function createLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return root.child({ module, ...bindings });
}
