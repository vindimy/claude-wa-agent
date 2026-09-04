import type { proto } from 'baileys';
import { describe, expect, it } from 'vitest';
import { extractAction, extractContent, toUnixSeconds } from './extract.js';

const GROUP = '120363000000000001@g.us';

function wamsg(overrides: Partial<proto.IWebMessageInfo> = {}): proto.IWebMessageInfo {
  return {
    key: { remoteJid: GROUP, id: 'ABC123', fromMe: false, participant: '111@s.whatsapp.net' },
    messageTimestamp: 1_700_000_000,
    pushName: 'Alice',
    message: { conversation: 'привет, hello' },
    ...overrides,
  };
}

describe('extractContent', () => {
  it('extracts plain conversation text', () => {
    expect(extractContent({ conversation: 'hi' })).toEqual({ kind: 'text', body: 'hi' });
  });

  it('extracts extended text', () => {
    expect(extractContent({ extendedTextMessage: { text: 'linked text' } })).toEqual({
      kind: 'text',
      body: 'linked text',
    });
  });

  it('extracts image captions and caption-less media', () => {
    expect(extractContent({ imageMessage: { caption: 'a photo' } })).toEqual({
      kind: 'image',
      body: 'a photo',
    });
    expect(extractContent({ imageMessage: {} })).toEqual({ kind: 'image', body: null });
    expect(extractContent({ audioMessage: {} })).toEqual({ kind: 'audio', body: null });
  });

  it('unwraps ephemeral messages', () => {
    expect(
      extractContent({ ephemeralMessage: { message: { conversation: 'disappearing' } } }),
    ).toEqual({ kind: 'text', body: 'disappearing' });
  });
});

describe('extractAction', () => {
  it('turns a group text message into an insert', () => {
    const action = extractAction(wamsg());
    expect(action).toEqual({
      action: 'insert',
      message: {
        groupJid: GROUP,
        id: 'ABC123',
        senderJid: '111@s.whatsapp.net',
        senderName: 'Alice',
        ts: 1_700_000_000,
        kind: 'text',
        body: 'привет, hello',
      },
    });
  });

  it('turns a revoke protocol message into a delete of the target', () => {
    const action = extractAction(
      wamsg({
        message: { protocolMessage: { type: 0, key: { id: 'TARGET1', remoteJid: GROUP } } },
      }),
    );
    expect(action).toEqual({ action: 'delete', groupJid: GROUP, id: 'TARGET1' });
  });

  it('turns an edit protocol message into an edit of the target', () => {
    const action = extractAction(
      wamsg({
        messageTimestamp: 1_700_000_500,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: 'TARGET2', remoteJid: GROUP },
            editedMessage: { conversation: 'new text' },
          },
        },
      }),
    );
    expect(action).toEqual({
      action: 'edit',
      groupJid: GROUP,
      id: 'TARGET2',
      body: 'new text',
      editedTs: 1_700_000_500,
    });
  });

  it('skips messages without a key', () => {
    const action = extractAction({ message: { conversation: 'x' } });
    expect(action.action).toBe('skip');
  });

  it('skips unhandled protocol messages', () => {
    const action = extractAction(
      wamsg({ message: { protocolMessage: { type: 3, key: { id: 'T' } } } }),
    );
    expect(action.action).toBe('skip');
  });
});

describe('toUnixSeconds', () => {
  it('passes numbers through', () => {
    expect(toUnixSeconds(123)).toBe(123);
  });

  it('converts Long-like values', () => {
    expect(toUnixSeconds({ toNumber: () => 456 })).toBe(456);
  });
});
