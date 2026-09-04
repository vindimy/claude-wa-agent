import { err, ok } from '../shared/index.js';
import { displayName, formatDay, formatTranscript } from './prompt.js';
import type { Summarizer, SummaryInput } from './types.js';

/**
 * Deterministic adapter with no external calls. Used in tests and for
 * exercising the pipeline end to end without spending tokens.
 */
export function createFakeSummarizer(): Summarizer {
  return {
    name: 'fake',
    async summarize(input: SummaryInput) {
      const started = Date.now();
      if (input.messages.length === 0) return err({ tag: 'empty' as const });

      const bySender = new Map<string, number>();
      for (const m of input.messages) {
        const name = displayName(m);
        bySender.set(name, (bySender.get(name) ?? 0) + 1);
      }
      const senders = [...bySender.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, n]) => `${name} (${n})`)
        .join(', ');

      const first = input.messages[0];
      const last = input.messages[input.messages.length - 1];
      const snippet = (body: string | null) =>
        body ? `"${body.slice(0, 60)}${body.length > 60 ? '…' : ''}"` : '[no text]';

      const text = [
        `[fake summary · ${input.options.style} · ${input.options.language}]`,
        `${input.groupName}: ${input.messages.length} messages from ${bySender.size} participants, ${formatDay(input.sinceTs, input.tz)} → ${formatDay(input.untilTs, input.tz)}.`,
        `- Senders: ${senders}`,
        `- First: ${first ? snippet(first.body) : '—'}`,
        `- Last: ${last ? snippet(last.body) : '—'}`,
      ].join('\n');

      return ok({
        text,
        adapter: 'fake',
        model: null,
        messageCount: input.messages.length,
        inputChars: formatTranscript(input.messages, input.tz).length,
        durationMs: Date.now() - started,
        costUsd: 0,
      });
    },
  };
}
