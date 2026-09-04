import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production';

const root = pino({
  level,
  ...(pretty
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
    : {}),
});

export type Logger = pino.Logger;

/** One child logger per module; pass `{ tenant_id }` for tenant-scoped work. */
export function createLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return root.child({ module, ...bindings });
}
