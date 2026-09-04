import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { err, ok, type Result } from '../shared/index.js';

export interface VaultError {
  tag: 'vault-write';
  path: string;
  message: string;
}

/** Write a note into the vault, creating directories as needed. Returns the absolute path. */
export function writeVaultNote(
  vaultDir: string,
  relativePath: string,
  content: string,
): Result<string, VaultError> {
  const path = join(vaultDir, relativePath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    return ok(path);
  } catch (e) {
    return err({ tag: 'vault-write', path, message: e instanceof Error ? e.message : String(e) });
  }
}
