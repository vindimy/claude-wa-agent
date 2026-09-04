import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../store/index.js';
import { loadFixtureTranscript } from './fixtures.js';
import { buildPrompt, displayName, formatDay, formatTime, formatTranscript } from './prompt.js';
import type { SummaryInput } from './types.js';

const TZ = 'America/Los_Angeles';

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    tenantId: 'owner',
    groupJid: 'g@g.us',
    id: 'X',
    senderJid: '15550001111@s.whatsapp.net',
    senderName: 'Alice',
    ts: 1_756_890_000, // 2025-09-03 02:00 PDT
    kind: 'text',
    body: 'hi',
    editedTs: null,
    deleted: false,
    ...overrides,
  };
}

function input(messages: MessageRow[], overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    tenantId: 'owner',
    groupJid: 'g@g.us',
    groupName: 'Team',
    messages,
    sinceTs: 1_756_800_000,
    untilTs: 1_757_000_000,
    tz: TZ,
    options: { language: 'auto', style: 'topics', max_words: 300 },
    ...overrides,
  };
}

describe('formatting helpers', () => {
  it('renders day and time in the requested zone', () => {
    expect(formatDay(1_756_890_000, 'UTC')).toBe('2025-09-03 (Wed)');
    expect(formatTime(1_756_890_000, 'UTC')).toBe('09:00');
    expect(formatTime(1_756_890_000, TZ)).toBe('02:00');
  });

  it('falls back from display name to phone number to "me"', () => {
    expect(displayName(row())).toBe('Alice');
    expect(displayName(row({ senderName: null }))).toBe('15550001111');
    expect(displayName(row({ senderName: '  ' }))).toBe('15550001111');
    expect(displayName(row({ senderName: null, senderJid: 'me' }))).toBe('me');
  });
});

describe('formatTranscript', () => {
  it('groups messages by day with one line per message', () => {
    const t = formatTranscript(
      [
        row({ id: '1', body: 'first' }),
        row({ id: '2', ts: 1_756_890_000 + 60, senderName: 'Bob', body: 'second' }),
        row({ id: '3', ts: 1_756_890_000 + 86_400, body: 'next day' }),
      ],
      'UTC',
    );
    expect(t).toBe(
      [
        '--- 2025-09-03 (Wed) ---',
        '09:00 Alice: first',
        '09:01 Bob: second',
        '',
        '--- 2025-09-04 (Thu) ---',
        '09:00 Alice: next day',
      ].join('\n'),
    );
  });

  it('labels media, keeps captions, and marks edits', () => {
    const t = formatTranscript(
      [
        row({ id: '1', kind: 'image', body: 'look at this' }),
        row({ id: '2', kind: 'audio', body: null }),
        row({ id: '3', kind: 'document', body: null }),
        row({ id: '4', body: 'fixed typo', editedTs: 1 }),
        row({ id: '5', body: 'line one\n  line two' }),
      ],
      'UTC',
    );
    expect(t).toContain('Alice: [photo] look at this');
    expect(t).toContain('Alice: [voice message]');
    expect(t).toContain('Alice: [document]');
    expect(t).toContain('Alice: fixed typo (edited)');
    expect(t).toContain('Alice: line one ⏎ line two');
  });

  it('returns an empty string for no messages', () => {
    expect(formatTranscript([], 'UTC')).toBe('');
  });
});

describe('buildPrompt', () => {
  it('encodes style, language and length in the system prompt', () => {
    const { system } = buildPrompt(
      input([row()], { options: { language: 'ru', style: 'action-items', max_words: 120 } }),
    );
    expect(system).toContain('at most 120 words');
    expect(system).toContain('entire summary in Russian');
    expect(system).toContain('action items');
    expect(system).not.toContain('Markdown "#"');
  });

  it('describes the mixed-language rule for auto', () => {
    const { system } = buildPrompt(input([row()]));
    expect(system).toContain('mixes Russian and English');
  });

  it('puts the group, window and transcript in the user prompt', () => {
    const messages = loadFixtureTranscript();
    const { user } = buildPrompt(input(messages, { groupName: 'Dance team' }));
    expect(user).toContain('Group: Dance team');
    expect(user).toContain(`(${TZ}), ${messages.length} messages`);
    expect(user).toContain('Lena: Всем привет!');
    expect(user).toContain('https://drive.example.com/d/final-mix-v3');
  });
});
