import { describe, expect, it } from 'vitest';
import type { SummaryRecord } from '../store/index.js';
import {
  GROUP_POST_SIGNATURE,
  renderDestinationText,
  renderGroupPostText,
  renderVaultMarkdown,
  renderWhatsAppText,
  slugify,
  vaultRelativePath,
} from './render.js';

const s: SummaryRecord = {
  tenantId: 'owner',
  id: 'deadbeef00000000',
  groupJid: '120363000000000001@g.us',
  sinceTs: 1_756_800_000, // 2025-09-02 08:00 UTC
  untilTs: 1_756_990_000, // 2025-09-04 12:46 UTC
  watermarkTs: 1_756_980_000,
  watermarkId: 'M25',
  messageCount: 25,
  adapter: 'cli-claude',
  model: 'claude-sonnet-5',
  text: 'Line one\n- bullet',
  createdTs: 1_756_990_100,
};
const ctx = { scopeName: 'Zouk Atoms team', tz: 'UTC' };

describe('slugify', () => {
  it('makes filesystem-friendly names and keeps non-Latin letters', () => {
    expect(slugify('Zouk Atoms team', 'x')).toBe('zouk-atoms-team');
    expect(slugify('  Семья / Family!  ', 'x')).toBe('семья-family');
    expect(slugify('🎉🎉', '1203@g.us')).toBe('1203');
  });
});

describe('renderGroupPostText', () => {
  it('marks the post as automated at both ends', () => {
    const t = renderGroupPostText(s, ctx);
    expect(t.split('\n')[0]).toBe('🤖 Auto-digest · 2025-09-02 → 2025-09-04 · 25 messages');
    expect(t.endsWith(GROUP_POST_SIGNATURE)).toBe(true);
    expect(t).toContain('Line one\n- bullet');
    expect(t).not.toContain('Zouk Atoms team');
  });
});

describe('renderWhatsAppText', () => {
  it('signs the message and states the window and count', () => {
    const t = renderWhatsAppText(s, ctx);
    expect(t.split('\n')[0]).toBe('🤖 Digest: Zouk Atoms team');
    expect(t).toContain('2025-09-02 → 2025-09-04 · 25 messages');
    expect(t.endsWith('Line one\n- bullet')).toBe(true);
  });

  it('collapses a same-day window', () => {
    const t = renderWhatsAppText({ ...s, sinceTs: s.untilTs - 3600, messageCount: 1 }, ctx);
    expect(t).toContain('2025-09-04 · 1 message');
  });
});

describe('vault rendering', () => {
  it('places the note under the group slug by end date and id', () => {
    expect(vaultRelativePath(s, ctx)).toBe('zouk-atoms-team/2025-09-04-deadbeef00000000.md');
  });

  it('writes YAML front matter and a heading', () => {
    const md = renderVaultMarkdown(s, ctx);
    expect(md.startsWith('---\ngroup: "Zouk Atoms team"\n')).toBe(true);
    expect(md).toContain('summary_id: deadbeef00000000');
    expect(md).toContain('messages: 25');
    expect(md).toContain('model: "claude-sonnet-5"');
    expect(md).toContain('tags: [whatsapp-digest]');
    expect(md).toContain('\n# Zouk Atoms team — 2025-09-02 → 2025-09-04\n');
    expect(md.trimEnd().endsWith('- bullet')).toBe(true);
    expect(renderVaultMarkdown({ ...s, model: null }, ctx)).toContain('model: null');
  });
});

describe('renderDestinationText', () => {
  it('heads with the scope name and window and signs at the bottom', () => {
    const text = renderDestinationText(s, { scopeName: 'SoCal Zouk', tz: 'UTC' });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(
      /^🤖 Digest: SoCal Zouk · 2025-09-0\d(?: → 2025-09-0\d)? · 25 messages$/,
    );
    expect(lines[lines.length - 1]).toBe(
      '_Automated digest of "SoCal Zouk", posted by a bot, not typed by hand._',
    );
    expect(text).toContain('\nLine one\n- bullet\n');
  });
});

describe('renderVaultMarkdown for a recap', () => {
  it('lists sources instead of a group', () => {
    const md = renderVaultMarkdown(
      { ...s, groupJid: 'recap:SoCal Zouk' },
      {
        scopeName: 'SoCal Zouk',
        tz: 'UTC',
        sources: [
          { jid: '1@g.us', name: 'Announcements' },
          { jid: '2@g.us', name: 'Nerds' },
        ],
      },
    );
    expect(md).toContain('recap: "SoCal Zouk"');
    expect(md).toContain(
      'sources:\n  - { name: "Announcements", jid: "1@g.us" }\n  - { name: "Nerds", jid: "2@g.us" }',
    );
    expect(md).not.toContain('\ngroup:');
    expect(md).not.toContain('\njid:');
    expect(md).toContain('# SoCal Zouk — ');
  });
});
