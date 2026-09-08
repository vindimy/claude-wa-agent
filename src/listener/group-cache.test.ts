import type { GroupMetadata } from 'baileys';
import { describe, expect, it } from 'vitest';
import { createGroupMetadataCache } from './group-cache.js';

function meta(id: string, participants: string[] = ['a@s.whatsapp.net']): GroupMetadata {
  return {
    id,
    owner: undefined,
    subject: `Group ${id}`,
    participants: participants.map((p) => ({ id: p })),
  } as GroupMetadata;
}

describe('createGroupMetadataCache', () => {
  it('returns what was set and undefined for unknown groups', () => {
    const cache = createGroupMetadataCache();
    cache.set(meta('1@g.us'));
    expect(cache.get('1@g.us')?.subject).toBe('Group 1@g.us');
    expect(cache.get('2@g.us')).toBeUndefined();
  });

  it('replaces everything on setAll', () => {
    const cache = createGroupMetadataCache();
    cache.set(meta('old@g.us'));
    cache.setAll([meta('1@g.us'), meta('2@g.us')]);
    expect(cache.size()).toBe(2);
    expect(cache.get('old@g.us')).toBeUndefined();
    expect(cache.get('2@g.us')).toBeDefined();
  });

  it('merges partial updates into an existing entry only', () => {
    const cache = createGroupMetadataCache();
    cache.set(meta('1@g.us'));
    cache.merge({ id: '1@g.us', subject: 'Renamed', announce: true });
    expect(cache.get('1@g.us')).toMatchObject({
      id: '1@g.us',
      subject: 'Renamed',
      announce: true,
      participants: [{ id: 'a@s.whatsapp.net' }],
    });
    cache.merge({ id: 'new@g.us', subject: 'Partial only' });
    expect(cache.get('new@g.us')).toBeUndefined();
    cache.merge({ subject: 'no id' });
    expect(cache.size()).toBe(1);
  });

  it('invalidates one entry', () => {
    const cache = createGroupMetadataCache();
    cache.setAll([meta('1@g.us'), meta('2@g.us')]);
    cache.invalidate('1@g.us');
    expect(cache.get('1@g.us')).toBeUndefined();
    expect(cache.get('2@g.us')).toBeDefined();
  });

  it('expires entries after the TTL', () => {
    let t = 1_000;
    const cache = createGroupMetadataCache({ ttlMs: 100, now: () => t });
    cache.set(meta('1@g.us'));
    t += 99;
    expect(cache.get('1@g.us')).toBeDefined();
    t += 1;
    expect(cache.get('1@g.us')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });
});
