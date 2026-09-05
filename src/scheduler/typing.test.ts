import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '../shared/index.js';
import { type TypingPresence, withTyping } from './typing.js';

function fakePresence(over: Partial<TypingPresence> = {}) {
  const calls: Array<{ jid: string; on: boolean }> = [];
  const p: TypingPresence & { calls: typeof calls } = {
    calls,
    isConnected: () => true,
    selfJid: () => 'me@s.whatsapp.net',
    async setComposing(jid, on) {
      calls.push({ jid, on });
      return ok(undefined);
    },
    ...over,
  };
  return p;
}

describe('withTyping', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('turns composing on before the work and off after it', async () => {
    const p = fakePresence();
    const result = await withTyping(p, async () => {
      expect(p.calls).toEqual([{ jid: 'me@s.whatsapp.net', on: true }]);
      return 42;
    });
    expect(result).toBe(42);
    expect(p.calls).toEqual([
      { jid: 'me@s.whatsapp.net', on: true },
      { jid: 'me@s.whatsapp.net', on: false },
    ]);
  });

  it('refreshes the indicator while the work is running', async () => {
    const p = fakePresence();
    let release: () => void = () => {};
    const done = withTyping(p, () => new Promise<void>((r) => (release = r)), { refreshMs: 8_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(p.calls.filter((c) => c.on)).toHaveLength(3);
    release();
    await done;
    expect(p.calls.at(-1)).toEqual({ jid: 'me@s.whatsapp.net', on: false });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(p.calls).toHaveLength(4); // no refresh after the work ends
  });

  it('clears the indicator when the work throws, then rethrows', async () => {
    const p = fakePresence();
    await expect(
      withTyping(p, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(p.calls.at(-1)).toEqual({ jid: 'me@s.whatsapp.net', on: false });
  });

  it('does nothing without a presence source, when disconnected, or without a self JID', async () => {
    expect(await withTyping(undefined, async () => 'a')).toBe('a');
    const off = fakePresence({ isConnected: () => false });
    expect(await withTyping(off, async () => 'b')).toBe('b');
    expect(off.calls).toEqual([]);
    const anon = fakePresence({ selfJid: () => undefined });
    expect(await withTyping(anon, async () => 'c')).toBe('c');
    expect(anon.calls).toEqual([]);
  });

  it('never fails the work when a presence update fails', async () => {
    const p = fakePresence({
      async setComposing() {
        return err({ tag: 'send' as const, message: 'nope' });
      },
    });
    expect(await withTyping(p, async () => 'ok')).toBe('ok');
    const thrower = fakePresence({
      async setComposing() {
        throw new Error('socket closed');
      },
    });
    expect(await withTyping(thrower, async () => 'still ok')).toBe('still ok');
  });
});
