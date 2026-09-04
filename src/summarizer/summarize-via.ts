import { err, ok, type Result } from '../shared/index.js';
import { buildPrompt } from './prompt.js';
import type { Summarizer, SummarizerError, Summary, SummaryInput } from './types.js';

/**
 * The digest path shared by every real adapter: build the fixed digest
 * prompt, send it through the adapter's own `complete`, and shape the result
 * as a `Summary`. Adapters only implement `complete`.
 */
export async function summarizeVia(
  name: string,
  input: SummaryInput,
  complete: Summarizer['complete'],
): Promise<Result<Summary, SummarizerError>> {
  if (input.messages.length === 0) return err({ tag: 'empty' as const });
  const prompt = buildPrompt(input);
  const r = await complete({
    tenantId: input.tenantId,
    groupJid: input.groupJid,
    system: prompt.system,
    user: prompt.user,
    purpose: 'summary',
  });
  if (!r.ok) return r;
  return ok({
    text: r.value.text,
    adapter: name,
    model: r.value.model,
    messageCount: input.messages.length,
    inputChars: prompt.user.length,
    durationMs: r.value.durationMs,
    costUsd: r.value.costUsd,
  });
}
