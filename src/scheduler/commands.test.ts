import { describe, expect, it } from 'vitest';
import { configSchema } from '../config/index.js';
import { helpText, parseCommand } from './commands.js';

describe('parseCommand', () => {
  it('parses the documented forms', () => {
    expect(parseCommand('/digest')).toEqual({
      kind: 'digest',
      groupRef: undefined,
      sinceSpec: undefined,
    });
    expect(parseCommand('/digest 3d')).toEqual({
      kind: 'digest',
      groupRef: undefined,
      sinceSpec: '3d',
    });
    expect(parseCommand('/digest Family')).toEqual({
      kind: 'digest',
      groupRef: 'Family',
      sinceSpec: undefined,
    });
    expect(parseCommand('/digest Family 12h')).toEqual({
      kind: 'digest',
      groupRef: 'Family',
      sinceSpec: '12h',
    });
    expect(parseCommand('/digest 12h Family')).toEqual({
      kind: 'digest',
      groupRef: 'Family',
      sinceSpec: '12h',
    });
    expect(parseCommand('  /DIGEST "Zouk team" 2d ')).toEqual({
      kind: 'digest',
      groupRef: 'Zouk team',
      sinceSpec: '2d',
    });
    expect(parseCommand('/digest Family 2026-09-01')).toEqual({
      kind: 'digest',
      groupRef: 'Family',
      sinceSpec: '2026-09-01',
    });
  });

  it('ignores non-commands and unknown commands', () => {
    expect(parseCommand('hello')).toBeUndefined();
    expect(parseCommand('/unknown')).toBeUndefined();
    expect(parseCommand('🤖 Digest: Family')).toBeUndefined();
  });

  it('reports extra arguments and supports /help', () => {
    expect(parseCommand('/digest a b c')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/help')).toEqual({ kind: 'help' });
    const cfg = configSchema.parse({ groups: [{ jid: '1@g.us', name: 'Family' }] });
    expect(helpText(cfg)).toContain('- Family');
  });
});

describe('parseCommand /ask', () => {
  it('takes a group, an optional window, and the rest as the question', () => {
    expect(parseCommand('/ask Family when is the dacha trip?')).toEqual({
      kind: 'ask',
      groupRef: 'Family',
      sinceSpec: undefined,
      question: 'when is the dacha trip?',
    });
    expect(parseCommand('/ask Family 2w when is the dacha trip?')).toEqual({
      kind: 'ask',
      groupRef: 'Family',
      sinceSpec: '2w',
      question: 'when is the dacha trip?',
    });
    expect(parseCommand('/ask "Zouk team" who owns the deck?')).toMatchObject({
      kind: 'ask',
      groupRef: 'Zouk team',
      question: 'who owns the deck?',
    });
  });

  it('keeps the question verbatim, including quotes and windows inside it', () => {
    expect(parseCommand('/ask Family did "Masha" say 2d or 3d?')).toMatchObject({
      kind: 'ask',
      sinceSpec: undefined,
      question: 'did "Masha" say 2d or 3d?',
    });
  });

  it('rejects a missing group or question', () => {
    expect(parseCommand('/ask')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/ask Family')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/ask Family 2w')).toMatchObject({ kind: 'invalid' });
  });

  it('lists /ask in the help text', () => {
    const cfg = configSchema.parse({ groups: [{ jid: '1@g.us', name: 'Family' }] });
    expect(helpText(cfg)).toContain('/ask <group>');
  });
});
