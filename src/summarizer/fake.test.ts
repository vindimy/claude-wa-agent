import { describe, expect, it } from 'vitest';
import { createFakeSummarizer } from './fake.js';
import { loadFixtureTranscript } from './fixtures.js';
import type { SummaryInput } from './types.js';

function input(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    tenantId: 'owner',
    groupJid: '120363000000000001@g.us',
    groupName: 'Team',
    messages: loadFixtureTranscript(),
    sinceTs: 1_756_800_000,
    untilTs: 1_757_000_000,
    tz: 'UTC',
    options: {
      language: 'auto',
      style: 'topics',
      max_words: 300,
      personality: 'neutral',
      instructions: '',
    },
    ...overrides,
  };
}

describe('fake summarizer', () => {
  it('is deterministic and reports stats', async () => {
    const s = createFakeSummarizer();
    const a = await s.summarize(input());
    const b = await s.summarize(input());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.text).toBe(b.value.text);
    expect(a.value.adapter).toBe('fake');
    expect(a.value.messageCount).toBe(25);
    expect(a.value.inputChars).toBeGreaterThan(500);
    expect(a.value.costUsd).toBe(0);
    expect(a.value.text).toContain('Team: 25 messages from 5 participants');
    expect(a.value.text).toContain('Lena (7)');
    expect(a.value.text).toContain('[fake summary · topics · auto]');
  });

  it('rejects an empty window', async () => {
    const r = await createFakeSummarizer().summarize(input({ messages: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tag).toBe('empty');
  });
});

describe('fake summarizer complete()', () => {
  it('answers deterministically from the prompt and echoes the question', async () => {
    const s = createFakeSummarizer();
    const req = {
      tenantId: 'owner',
      groupJid: 'g@g.us',
      system: 'SYS',
      user: 'Group: Team\nQuestion: Who owns the deck?\n\nTranscript:\n10:00 Lena: hi',
      purpose: 'answer' as const,
    };
    const a = await s.complete(req);
    const b = await s.complete(req);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.text).toBe(b.value.text);
    expect(a.value.text).toContain('[fake answer]');
    expect(a.value.text).toContain('Who owns the deck?');
    expect(a.value.model).toBeNull();
    expect(a.value.costUsd).toBe(0);
  });
});
