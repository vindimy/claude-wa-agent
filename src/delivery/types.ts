import type { Result } from '../shared/index.js';

export type SendError = { tag: 'not-connected' } | { tag: 'send'; message: string };

/** What the outbox needs from the WhatsApp session. Implemented by the listener. */
export interface Transport {
  isConnected(): boolean;
  /** The tenant's own normalized JID, once connected. */
  selfJid(): string | undefined;
  sendText(jid: string, text: string): Promise<Result<void, SendError>>;
}

export type DeliveryOutcome =
  | { channel: 'vault'; outcome: 'written'; path: string }
  | { channel: 'vault'; outcome: 'already'; path: string | null }
  | { channel: 'vault'; outcome: 'error'; message: string }
  | { channel: 'self_dm'; outcome: 'queued' }
  | { channel: 'self_dm'; outcome: 'already'; status: 'queued' | 'sent' }
  | { channel: 'group'; outcome: 'queued'; target: string }
  | { channel: 'group'; outcome: 'already'; status: 'queued' | 'sent' }
  | { channel: 'group'; outcome: 'skipped'; reason: string };
