import { readFile } from 'node:fs/promises';
import { err, ok, type Result } from '../shared/index.js';
import type { SummarizerError } from './types.js';

/** Read an image file for an API adapter; a missing file is a model error, not a crash. */
export async function readImageBase64(path: string): Promise<Result<string, SummarizerError>> {
  try {
    return ok((await readFile(path)).toString('base64'));
  } catch (e) {
    return err({
      tag: 'model',
      message: `cannot read image ${path}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
