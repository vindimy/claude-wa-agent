import { describe, expect, it } from 'vitest';
import { ADAPTER_NAMES, createSummarizer } from './registry.js';

describe('createSummarizer', () => {
  it('builds known adapters', () => {
    expect(ADAPTER_NAMES).toEqual(['fake', 'cli-claude', 'api-anthropic']);
    const fake = createSummarizer('fake');
    expect(fake.ok && fake.value.name).toBe('fake');
    const claude = createSummarizer('cli-claude', { model: 'sonnet' });
    expect(claude.ok && claude.value.name).toBe('cli-claude');
  });

  it('rejects unknown adapters and lists the available ones', () => {
    const r = createSummarizer('cli-gemini');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.tag).toBe('unknown-adapter');
      expect(r.error.available).toContain('cli-claude');
    }
  });
});
