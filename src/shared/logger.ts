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

export function createLogger(module: string): Logger {
  return root.child({ module });
}
