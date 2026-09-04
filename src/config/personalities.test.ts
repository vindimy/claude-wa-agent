import { describe, expect, it } from 'vitest';
import { PERSONALITY_PRESETS, personalityNames, resolvePersonality } from './personalities.js';
import { configSchema } from './schema.js';

describe('personality presets', () => {
  it('ships the documented presets, with neutral adding no voice text', () => {
    expect(Object.keys(PERSONALITY_PRESETS)).toEqual([
      'neutral',
      'dry',
      'friendly',
      'russian-sarcasm',
      'executive',
      'newsroom',
      'butler',
      'hype',
    ]);
    expect(PERSONALITY_PRESETS.neutral).toBe('');
    for (const [name, text] of Object.entries(PERSONALITY_PRESETS)) {
      if (name !== 'neutral') expect(text.length).toBeGreaterThan(40);
    }
  });

  it('resolves a preset, a custom personality, and a custom override of a preset', () => {
    const config = configSchema.parse({
      personalities: {
        pirate: 'Talk like a pirate.',
        friendly: 'Friendly, but in Yorkshire dialect.',
      },
    });
    expect(resolvePersonality(config, 'dry')).toBe(PERSONALITY_PRESETS.dry);
    expect(resolvePersonality(config, 'pirate')).toBe('Talk like a pirate.');
    expect(resolvePersonality(config, 'friendly')).toBe('Friendly, but in Yorkshire dialect.');
    expect(resolvePersonality(config, 'neutral')).toBe('');
    expect(resolvePersonality(config, 'nope')).toBeUndefined();
  });

  it('lists presets first, then custom names', () => {
    const config = configSchema.parse({ personalities: { pirate: 'Arr.' } });
    const names = personalityNames(config);
    expect(names[0]).toBe('neutral');
    expect(names).toContain('pirate');
    expect(names.filter((n) => n === 'friendly')).toHaveLength(1);
  });
});

describe('configSchema personality and instructions', () => {
  it('defaults to the neutral personality and no instructions', () => {
    const config = configSchema.parse({});
    expect(config.defaults.summary.personality).toBe('neutral');
    expect(config.defaults.summary.instructions).toBe('');
    expect(config.personalities).toEqual({});
  });

  it('rejects an unknown personality in defaults and in a group', () => {
    const bad = configSchema.safeParse({ defaults: { summary: { personality: 'grumpy' } } });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]?.message).toContain('grumpy');
      expect(bad.error.issues[0]?.path).toEqual(['defaults', 'summary', 'personality']);
    }
    const badGroup = configSchema.safeParse({
      groups: [{ jid: '1@g.us', summary: { personality: 'grumpy' } }],
    });
    expect(badGroup.success).toBe(false);
    if (!badGroup.success) {
      expect(badGroup.error.issues[0]?.path).toEqual(['groups', 0, 'summary', 'personality']);
    }
  });

  it('accepts a custom personality once it is defined', () => {
    const ok = configSchema.safeParse({
      personalities: { grumpy: 'Grumble about everything.' },
      groups: [{ jid: '1@g.us', summary: { personality: 'grumpy' } }],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an empty custom personality description', () => {
    expect(configSchema.safeParse({ personalities: { blank: '   ' } }).success).toBe(false);
  });
});

describe('resolveGroupConfig instructions', () => {
  it('appends group instructions to the default instructions', async () => {
    const { resolveGroupConfig } = await import('./schema.js');
    const config = configSchema.parse({
      defaults: { summary: { instructions: 'Always flag deadlines.' } },
      groups: [
        { jid: '1@g.us', summary: { instructions: 'Baba means grandma.' } },
        { jid: '2@g.us' },
      ],
    });
    expect(resolveGroupConfig(config, '1@g.us')?.summary.instructions).toBe(
      'Always flag deadlines.\nBaba means grandma.',
    );
    expect(resolveGroupConfig(config, '2@g.us')?.summary.instructions).toBe(
      'Always flag deadlines.',
    );
  });

  it('lets a group pick its own personality', async () => {
    const { resolveGroupConfig } = await import('./schema.js');
    const config = configSchema.parse({
      defaults: { summary: { personality: 'dry' } },
      groups: [{ jid: '1@g.us', summary: { personality: 'friendly' } }, { jid: '2@g.us' }],
    });
    expect(resolveGroupConfig(config, '1@g.us')?.summary.personality).toBe('friendly');
    expect(resolveGroupConfig(config, '2@g.us')?.summary.personality).toBe('dry');
  });
});
