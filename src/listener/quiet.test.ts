import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The listener behaves like a quiet human on the tenant's own account. These
 * are the Baileys calls that would break that; none may appear in the source.
 */
const src = readFileSync(new URL('./listener.ts', import.meta.url), 'utf8');
const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('listener stays a quiet client', () => {
  it('never marks messages read or sends receipts', () => {
    expect(code).not.toMatch(/\breadMessages\s*\(/);
    expect(code).not.toMatch(/\bsendReceipt\s*\(/);
    expect(code).not.toMatch(/\bsendReceipts\s*\(/);
  });

  it('never announces itself online', () => {
    expect(code).toMatch(/markOnlineOnConnect:\s*false/);
    expect(code).not.toMatch(/sendPresenceUpdate\(\s*['"]available['"]/);
  });

  it('feeds sends from a group metadata cache', () => {
    expect(code).toMatch(/cachedGroupMetadata:/);
  });
});
