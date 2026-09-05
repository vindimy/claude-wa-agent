import { describe, expect, it } from 'vitest';
import { configSchema } from '../config/index.js';
import { helpText, parseCommand } from './commands.js';

describe('parseCommand', () => {
  it('parses the documented forms', () => {
    expect(parseCommand('/digest')).toEqual({
      kind: 'digest',
      groupRef: undefined,
      sinceSpec: undefined,
      options: {},
    });
    expect(parseCommand('/digest 3d')).toEqual({
      kind: 'digest',
      groupRef: undefined,
      sinceSpec: '3d',
      options: {},
    });
    expect(parseCommand('/digest Family')).toEqual({
      kind: 'digest',
      groupRef: 'Family',
      sinceSpec: undefined,
      options: {},
    });
    expect(parseCommand('/digest Family 12h')).toEqual({
      kind: 'digest',
      groupRef: 'Family',
      sinceSpec: '12h',
      options: {},
    });
    expect(parseCommand('/digest 12h Family')).toEqual({
      kind: 'digest',
      groupRef: 'Family',
      sinceSpec: '12h',
      options: {},
    });
    expect(parseCommand('  /DIGEST "Zouk team" 2d ')).toEqual({
      kind: 'digest',
      groupRef: 'Zouk team',
      sinceSpec: '2d',
      options: {},
    });
    expect(parseCommand('/digest Family 2026-09-01')).toEqual({
      kind: 'digest',
      groupRef: 'Family',
      sinceSpec: '2026-09-01',
      options: {},
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
    expect(helpText(cfg)).toContain('style=');
  });
});

describe('parseCommand /digest options', () => {
  const full = {
    style: 'narrative',
    language: 'ru',
    maxWords: 150,
    personality: 'grumpy-uncle',
    adapter: 'api-openai',
    instructions: 'call out deadlines',
  };

  it('accepts key=value tokens with short keys', () => {
    expect(
      parseCommand(
        '/digest Family 2d style=narrative lang=ru words=150 voice=grumpy-uncle via=api-openai note="call out deadlines"',
      ),
    ).toEqual({ kind: 'digest', groupRef: 'Family', sinceSpec: '2d', options: full });
  });

  it('accepts the long key names used in config.yaml', () => {
    expect(
      parseCommand(
        "/digest Family 2d style=narrative language=ru max_words=150 personality=grumpy-uncle adapter=api-openai instructions='call out deadlines'",
      ),
    ).toEqual({ kind: 'digest', groupRef: 'Family', sinceSpec: '2d', options: full });
    expect(parseCommand('/digest max-words=80')).toMatchObject({ options: { maxWords: 80 } });
  });

  it('accepts CLI-style --flags, including --since', () => {
    expect(
      parseCommand(
        '/digest Family --since 2d --style narrative --language ru --max-words 150 --personality grumpy-uncle --adapter api-openai --instructions "call out deadlines"',
      ),
    ).toEqual({ kind: 'digest', groupRef: 'Family', sinceSpec: '2d', options: full });
    expect(parseCommand('/digest --style=action-items --lang=en')).toEqual({
      kind: 'digest',
      groupRef: undefined,
      sinceSpec: undefined,
      options: { style: 'action-items', language: 'en' },
    });
  });

  it('rejects unknown keys and bad values without running anything', () => {
    expect(parseCommand('/digest Family foo=bar')).toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('foo'),
    });
    expect(parseCommand('/digest style=poem')).toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('style'),
    });
    expect(parseCommand('/digest lang=klingon')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/digest words=abc')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/digest words=0')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/digest --style')).toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('--style'),
    });
    expect(parseCommand('/digest --since')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/digest --bogus 1')).toMatchObject({ kind: 'invalid' });
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
