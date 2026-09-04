import type { proto } from 'baileys';
import type { MessageKind, NewMessage } from '../store/index.js';

export type IngestAction =
  | { action: 'insert'; message: NewMessage }
  | { action: 'edit'; groupJid: string; id: string; body: string | null; editedTs: number }
  | { action: 'delete'; groupJid: string; id: string }
  | { action: 'skip'; reason: string };

const REVOKE = 0; // proto.Message.ProtocolMessage.Type.REVOKE

type LongLike = { toNumber(): number };

export function toUnixSeconds(ts: number | LongLike | null | undefined): number {
  if (ts == null) return Math.floor(Date.now() / 1000);
  if (typeof ts === 'number') return ts;
  return ts.toNumber();
}

interface ExtractedContent {
  kind: MessageKind;
  body: string | null;
}

/** Pull displayable text (or a caption) out of a raw message payload. */
export function extractContent(m: proto.IMessage | null | undefined): ExtractedContent | null {
  if (!m) return null;
  // ephemeral / view-once wrappers carry the real message one level down
  const inner =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message ??
    m;

  if (inner.conversation != null) return { kind: 'text', body: inner.conversation };
  if (inner.extendedTextMessage?.text != null)
    return { kind: 'text', body: inner.extendedTextMessage.text };
  if (inner.imageMessage) return { kind: 'image', body: inner.imageMessage.caption ?? null };
  if (inner.videoMessage) return { kind: 'video', body: inner.videoMessage.caption ?? null };
  if (inner.documentMessage)
    return { kind: 'document', body: inner.documentMessage.caption ?? null };
  if (inner.audioMessage) return { kind: 'audio', body: null };
  if (inner.stickerMessage) return { kind: 'sticker', body: null };
  if (inner.protocolMessage) return null; // handled separately
  return { kind: 'other', body: null };
}

/**
 * Classify one incoming WAMessage from an allow-listed group into a store
 * action. Assumes the caller already checked the group allow-list.
 */
export function extractAction(msg: proto.IWebMessageInfo): IngestAction {
  const groupJid = msg.key?.remoteJid;
  const id = msg.key?.id;
  if (!groupJid || !id) return { action: 'skip', reason: 'missing key' };

  const pm = msg.message?.protocolMessage;
  if (pm) {
    const targetId = pm.key?.id;
    if (!targetId) return { action: 'skip', reason: 'protocol message without target key' };
    if (pm.editedMessage) {
      const content = extractContent(pm.editedMessage);
      return {
        action: 'edit',
        groupJid,
        id: targetId,
        body: content?.body ?? null,
        editedTs: toUnixSeconds(msg.messageTimestamp),
      };
    }
    if (pm.type === REVOKE) return { action: 'delete', groupJid, id: targetId };
    return { action: 'skip', reason: `protocol message type ${pm.type}` };
  }

  const content = extractContent(msg.message);
  if (!content) return { action: 'skip', reason: 'no extractable content' };

  const senderJid = msg.key?.participant ?? (msg.key?.fromMe ? 'me' : groupJid);
  return {
    action: 'insert',
    message: {
      groupJid,
      id,
      senderJid,
      senderName: msg.pushName ?? null,
      ts: toUnixSeconds(msg.messageTimestamp),
      kind: content.kind,
      body: content.body,
    },
  };
}
