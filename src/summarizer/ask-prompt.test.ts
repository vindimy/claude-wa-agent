import { describe, expect, it } from 'vitest';
import type { AskInput } from './ask-prompt.js';
import { buildAskPrompt } from './ask-prompt.js';
import { loadFixtureTranscript } from './fixtures.js';

function input(overrides: Partial<AskInput> = {}): AskInput {
  return {
    tenantId: 'owner',
    groupJid: '120363000000000001@g.us',
    groupName: 'Team',
    messages: loadFixtureTranscript(),
    sinceTs: 1_756_800_000,
    untilTs: 1_757_000_000,
    tz: 'UTC',
    question: 'When is the deadline for the deck?',
    options: {
      language: 'en',
      style: 'topics',
      max_words: 300,
      personality: 'neutral',
      instructions: '',
    },
    ...overrides,
  };
}

describe('buildAskPrompt', () => {
  it('tells the model to answer only from the transcript and admit gaps', () => {
    const { system } = buildAskPrompt(input());
    expect(system).toContain('answer');
    expect(system).toMatch(/only .*transcript/i);
    expect(system).toMatch(/not (in|covered by) the transcript/i);
    expect(system).toMatch(/language .*question/i);
    expect(system).not.toContain('summary');
  });

  it('puts the group, window, question and transcript in the user prompt', () => {
    const { user } = buildAskPrompt(input());
    expect(user).toContain('Group: Team');
    expect(user).toContain('Question: When is the deadline for the deck?');
    expect(user).toContain('Transcript:');
    expect(user).toContain('Lena');
    expect(user.indexOf('Question:')).toBeLessThan(user.indexOf('Transcript:'));
  });

  it('carries the voice and reader instructions like the digest prompt', () => {
    const { system } = buildAskPrompt(
      input({
        personality: 'Arr, matey.',
        options: {
          language: 'en',
          style: 'topics',
          max_words: 300,
          personality: 'pirate',
          instructions: 'Baba is grandma.',
        },
      }),
    );
    expect(system).toContain('Voice: Arr, matey.');
    expect(system).toContain('Baba is grandma.');
    expect(system).toMatch(/never changes.*fact/);
  });

  it('omits voice and instructions when both are empty', () => {
    const { system } = buildAskPrompt(input());
    expect(system).not.toContain('Voice:');
    expect(system).not.toContain('Additional instructions');
  });
});
