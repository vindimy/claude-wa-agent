import { describe, expect, it } from 'vitest';
import { destinationSchema, normalizePhoneNumber, resolveDestination } from './destinations.js';

describe('normalizePhoneNumber', () => {
  it('keeps digits only', () => {
    expect(normalizePhoneNumber('+1 (310) 555-1234')).toBe('13105551234');
    expect(normalizePhoneNumber('13105551234')).toBe('13105551234');
  });
  it('rejects too short, too long, or non-numeric input', () => {
    expect(normalizePhoneNumber('12345')).toBeUndefined();
    expect(normalizePhoneNumber('1234567890123456')).toBeUndefined();
    expect(normalizePhoneNumber('abc')).toBeUndefined();
    expect(normalizePhoneNumber('+1 310 555 12x4')).toBeUndefined();
  });
});

describe('destinationSchema', () => {
  it('accepts a group or a number, not both, not neither', () => {
    expect(destinationSchema.safeParse({ group: '1@g.us' }).success).toBe(true);
    expect(destinationSchema.safeParse({ number: '+1 310 555 1234' }).success).toBe(true);
    expect(destinationSchema.safeParse({ group: '1@g.us', number: '+13105551234' }).success).toBe(
      false,
    );
    expect(destinationSchema.safeParse({}).success).toBe(false);
    expect(destinationSchema.safeParse({ group: '1@s.whatsapp.net' }).success).toBe(false);
    expect(destinationSchema.safeParse({ number: '12' }).success).toBe(false);
  });
});

describe('resolveDestination', () => {
  const destinations = {
    hub: { group: '120363000000000009@g.us' },
    me: { number: '+1 (310) 555-1234' },
  };
  it('resolves a group to its JID', () => {
    expect(resolveDestination(destinations, 'hub')).toEqual({
      name: 'hub',
      kind: 'group',
      jid: '120363000000000009@g.us',
    });
  });
  it('resolves a number to a user JID', () => {
    expect(resolveDestination(destinations, 'me')).toEqual({
      name: 'me',
      kind: 'number',
      jid: '13105551234@s.whatsapp.net',
    });
  });
  it('returns undefined for an unknown name', () => {
    expect(resolveDestination(destinations, 'nope')).toBeUndefined();
  });
});
