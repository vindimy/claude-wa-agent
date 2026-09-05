import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MessageRow } from '../store/index.js';
import type { ImageRequest } from './types.js';

/** Absolute path of a file under `__fixtures__`. */
export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
}

/** A describeImage request for the bundled red square. */
export function imageRequest(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return {
    tenantId: 'owner',
    groupJid: '120363000000000001@g.us',
    system:
      'You describe one photo in at most 30 words of plain English. Reply with the description only.',
    user: 'Describe the attached image.',
    image: { path: fixturePath('red-square.png'), mimeType: 'image/png' },
    ...overrides,
  };
}

interface FixtureMessage {
  id: string;
  senderJid: string;
  senderName: string | null;
  ts: number;
  kind: MessageRow['kind'];
  body: string | null;
}

/** Test/dev helper: the bundled bilingual transcript as store rows. */
export function loadFixtureTranscript(
  groupJid = '120363000000000001@g.us',
  tenantId = 'owner',
): MessageRow[] {
  const url = new URL('./__fixtures__/team-chat.json', import.meta.url);
  const raw = JSON.parse(readFileSync(url, 'utf8')) as FixtureMessage[];
  return raw.map((m) => ({
    ...m,
    tenantId,
    groupJid,
    editedTs: null,
    deleted: false,
    mediaDescription: null,
    links: [],
  }));
}
