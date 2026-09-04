import { describe, expect, it } from 'vitest';
import { configSchema, resolveGroupConfig } from '../config/index.js';
import { err, ok } from '../shared/index.js';
import { Store } from '../store/index.js';
import { loadFixtureTranscript } from '../summarizer/fixtures.js';
import { createFakeSummarizer, type Summarizer } from '../summarizer/index.js';
import { askQuestion, describeAskError } from './ask.js';

const G1 = '120363000000000001@g.us';

function setup(configRaw: Record<string, unknown> = {}) {
  const store = new Store(':memory:');
  const rows = loadFixtureTranscript(G1);
  store.upsertGroup({ tenantId: 'owner', jid: G1, subject: 'Team', seenTs: rows[0]?.ts ?? 0 });
  for (const r of rows) store.insertMessage(r);
  const last = rows[rows.length - 1];
  if (!last) throw new Error('fixture empty');
  const config = configSchema.parse({
    defaults: { summarizer: 'fake' },
    groups: [{ jid: G1, name: 'Team' }],
    ...configRaw,
  });
  const group = resolveGroupConfig(config, G1);
  if (!group) throw new Error('group missing');
  const base = {
    tenantId: 'owner',
    store,
    config,
    group,
    question: 'Who is presenting?',
    sinceTs: 0,
    untilTs: last.ts + 1,
    tz: 'UTC',
    now: () => (last.ts + 5) * 1000,
    summarizerFactory: () => ok(createFakeSummarizer()),
  };
  return { store, config, base, rows };
}

describe('askQuestion', () => {
  it('answers from the stored window and records the question', async () => {
    const { store, base, rows } = setup();
    const r = await askQuestion(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('ok');
    if (r.value.kind !== 'ok') return;
    expect(r.value.answer.text).toContain('[fake answer] Who is presenting?');
    expect(r.value.answer.messageCount).toBe(rows.length);
    const [q] = store.listQuestions('owner', 5);
    expect(q).toMatchObject({
      groupJid: G1,
      question: 'Who is presenting?',
      status: 'ok',
      adapter: 'fake',
      messageCount: rows.length,
      createdTs: base.untilTs + 4,
    });
    expect(q?.answer).toContain('[fake answer]');
    expect(store.lastWatermark('owner', G1)).toBeUndefined();
  });

  it('reports an empty window without calling the adapter or recording anything', async () => {
    const { store, base } = setup();
    let called = 0;
    const r = await askQuestion({
      ...base,
      sinceTs: base.untilTs + 100,
      summarizerFactory: () => {
        called += 1;
        return ok(createFakeSummarizer());
      },
    });
    expect(r.ok && r.value.kind).toBe('empty');
    expect(called).toBe(0);
    expect(store.listQuestions('owner', 5)).toHaveLength(0);
  });

  it('hands the adapter the voice, instructions and question', async () => {
    const { base } = setup({
      defaults: { summary: { personality: 'dry', instructions: 'Kostya is the lead.' } },
    });
    const seen: string[] = [];
    const capturing: Summarizer = {
      name: 'fake',
      summarize: async () => err({ tag: 'empty' as const }),
      async complete(req) {
        seen.push(req.system, req.user, req.purpose);
        return ok({ text: 'Lena.', model: 'm', durationMs: 1, costUsd: 0.001 });
      },
    };
    const r = await askQuestion({ ...base, summarizerFactory: () => ok(capturing) });
    expect(r.ok).toBe(true);
    expect(seen[0]).toContain('Kostya is the lead.');
    expect(seen[0]).toContain('Voice:');
    expect(seen[1]).toContain('Question: Who is presenting?');
    expect(seen[2]).toBe('answer');
  });

  it('records a failed question and returns the adapter error', async () => {
    const { store, base } = setup();
    const failing: Summarizer = {
      name: 'fake',
      summarize: async () => err({ tag: 'empty' as const }),
      complete: async () => err({ tag: 'model' as const, message: 'nope' }),
    };
    const r = await askQuestion({ ...base, summarizerFactory: () => ok(failing) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(describeAskError(r.error)).toContain('nope');
    const [q] = store.listQuestions('owner', 5);
    expect(q).toMatchObject({ status: 'error', error: 'adapter error: nope', answer: null });
  });

  it('rejects an unknown adapter by name', async () => {
    const { base } = setup();
    const r = await askQuestion({ ...base, adapter: 'nope', summarizerFactory: undefined });
    expect(!r.ok && r.error.tag).toBe('unknown-adapter');
  });
});
