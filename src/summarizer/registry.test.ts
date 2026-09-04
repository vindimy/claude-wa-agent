import { describe, expect, it } from 'vitest';
import { ADAPTER_NAMES, createSummarizer } from './registry.js';

describe('createSummarizer', () => {
  it('builds known adapters', () => {
    expect(ADAPTER_NAMES).toEqual([
      'fake',
      'cli-claude',
      'cli-gemini',
      'cli-codex',
      'api-anthropic',
      'api-openai',
      'api-google',
    ]);
    expect(createSummarizer('api-openai').ok).toBe(true);
    expect(createSummarizer('api-google').ok).toBe(true);
    const fake = createSummarizer('fake');
    expect(fake.ok && fake.value.name).toBe('fake');
    const claude = createSummarizer('cli-claude', { model: 'sonnet' });
    expect(claude.ok && claude.value.name).toBe('cli-claude');
    const gemini = createSummarizer('cli-gemini');
    expect(gemini.ok && gemini.value.name).toBe('cli-gemini');
    const codex = createSummarizer('cli-codex');
    expect(codex.ok && codex.value.name).toBe('cli-codex');
  });

  it('rejects unknown adapters and lists the available ones', () => {
    const r = createSummarizer('cli-mistral');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.tag).toBe('unknown-adapter');
      expect(r.error.available).toContain('cli-claude');
    }
  });
});
