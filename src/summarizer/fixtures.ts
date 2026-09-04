import { readFileSync } from 'node:fs';
import type { MessageRow } from '../store/index.js';

interface FixtureMessage {
  id: string;
  senderJid: string;
  senderName: string | null;
  ts: number;
  kind: MessageRow['kind'];
  body: string | null;
}

/** Test/dev helper: the bundled bilingual transcript as store rows. */
export function loadFixtureTranscript(groupJid = '120363000000000001@g.us'): MessageRow[] {
  const url = new URL('./__fixtures__/team-chat.json', import.meta.url);
  const raw = JSON.parse(readFileSync(url, 'utf8')) as FixtureMessage[];
  return raw.map((m) => ({ ...m, groupJid, editedTs: null, deleted: false }));
}
