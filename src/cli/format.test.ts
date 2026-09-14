import { describe, expect, it } from 'vitest';
import { describeDeliver, formatOutcome } from './format.js';

describe('describeDeliver', () => {
  it('lists channels and destinations', () => {
    expect(describeDeliver({ self_dm: true, vault: true, group: false, to: [] })).toBe(
      'self-DM, vault',
    );
    expect(describeDeliver({ self_dm: false, vault: false, group: true, to: ['hub', 'me'] })).toBe(
      'GROUP POST, → hub, → me',
    );
    expect(describeDeliver({ self_dm: false, vault: false, to: [] })).toBe('nothing');
  });
});

describe('formatOutcome', () => {
  it('describes destination outcomes', () => {
    expect(formatOutcome({ channel: 'to', name: 'hub', outcome: 'queued', target: '9@g.us' })).toBe(
      'to hub:   queued for 9@g.us — the listener (`digest run`) sends it',
    );
    expect(formatOutcome({ channel: 'to', name: 'hub', outcome: 'already', status: 'sent' })).toBe(
      'to hub:   already sent',
    );
    expect(
      formatOutcome({ channel: 'to', name: 'hub', outcome: 'skipped', reason: 'private' }),
    ).toBe('to hub:   skipped — private');
  });
});
