import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { err, ok, type Result } from '../shared/index.js';
import { type Config, configSchema } from './schema.js';

export type ConfigError =
  | { tag: 'read'; path: string; message: string }
  | { tag: 'parse'; path: string; message: string }
  | { tag: 'validate'; path: string; message: string };

export function loadConfig(path: string): Result<Config, ConfigError> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return err({ tag: 'read', path, message: e instanceof Error ? e.message : String(e) });
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return err({ tag: 'parse', path, message: e instanceof Error ? e.message : String(e) });
  }

  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return err({ tag: 'validate', path, message: z.prettifyError(parsed.error) });
  }
  return ok(parsed.data);
}
