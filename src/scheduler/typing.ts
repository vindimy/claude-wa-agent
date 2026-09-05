import type { SendError } from '../delivery/index.js';
import { createLogger, type Result } from '../shared/index.js';

/**
 * What the typing indicator needs from the WhatsApp session. The listener
 * satisfies it; tests pass a recorder.
 */
export interface TypingPresence {
  isConnected(): boolean;
  selfJid(): string | undefined;
  setComposing(jid: string, on: boolean): Promise<Result<void, SendError>>;
}

/** WhatsApp drops a `composing` state after roughly 10 s; refresh well before that. */
export const TYPING_REFRESH_MS = 8_000;

const log = createLogger('typing');

/**
 * Show "typing…" on the self-chat while `work` runs. Presence updates are not
 * messages: they never touch the outbox or the daily send cap, and a failure
 * is logged at debug and ignored. With no presence source, no connection, or
 * no known self JID the work simply runs.
 */
export async function withTyping<T>(
  presence: TypingPresence | undefined,
  work: () => Promise<T>,
  opts: { refreshMs?: number } = {},
): Promise<T> {
  const jid = presence?.isConnected() ? presence.selfJid() : undefined;
  if (!presence || !jid) return work();

  const set = async (on: boolean) => {
    try {
      const r = await presence.setComposing(jid, on);
      if (!r.ok) log.debug({ on, error: r.error }, 'presence update failed');
    } catch (e) {
      log.debug({ on, err: e }, 'presence update threw');
    }
  };

  await set(true);
  const timer = setInterval(() => void set(true), opts.refreshMs ?? TYPING_REFRESH_MS);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await set(false);
  }
}
