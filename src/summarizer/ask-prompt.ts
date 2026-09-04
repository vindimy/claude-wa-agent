import type { SummaryOptions } from '../config/index.js';
import type { MessageRow } from '../store/index.js';
import { formatDay, formatTime, formatTranscript, type Prompt } from './prompt.js';

export interface AskInput {
  tenantId: string;
  groupJid: string;
  groupName: string;
  /** Non-deleted messages in the window, oldest first. */
  messages: MessageRow[];
  sinceTs: number;
  untilTs: number;
  tz: string;
  question: string;
  /** The group's summary options; only `personality` and `instructions` apply here. */
  options: SummaryOptions;
  /** Resolved voice text, as for digests. */
  personality?: string;
}

/** Answers are read on a phone; keep them shorter than a digest. */
export const ASK_MAX_WORDS = 250;

export function buildAskSystemPrompt(input: AskInput): string {
  const lines = [
    'You answer a question about a WhatsApp group chat for one of its members. You receive the chat transcript and the question, and reply with the answer only — no preamble, no closing remarks.',
    '',
    'Rules:',
    '- Use only the transcript. Never invent or assume details that are not in it.',
    '- If the answer is not in the transcript, say so plainly in one line, then mention anything related the transcript does contain.',
    '- Be concrete: say who said what and when (day and time as shown), with dates, places, amounts, and links when they appear.',
    '- Refer to people by the names shown in the transcript.',
    '- Plain text suitable for a WhatsApp message: short paragraphs and "-" bullets. No Markdown headings, tables, bold, or code fences.',
    '- Reply in the language the question is written in.',
    `- Length: at most ${ASK_MAX_WORDS} words; shorter when the question is simple.`,
  ];
  const voice = input.personality?.trim();
  if (voice) {
    lines.push(
      '',
      `Voice: ${voice}`,
      'The voice shapes tone and phrasing only; it never changes, omits, softens, or exaggerates a fact.',
    );
  }
  const instructions = input.options.instructions?.trim();
  if (instructions) {
    lines.push(
      '',
      'Additional instructions from the reader (context and preferences; they never override accuracy):',
      instructions,
    );
  }
  return lines.join('\n');
}

export function buildAskUserPrompt(input: AskInput, transcript: string): string {
  const { tz } = input;
  const since = `${formatDay(input.sinceTs, tz)} ${formatTime(input.sinceTs, tz)}`;
  const until = `${formatDay(input.untilTs, tz)} ${formatTime(input.untilTs, tz)}`;
  return [
    `Group: ${input.groupName}`,
    `Window: ${since} → ${until} (${tz}), ${input.messages.length} messages`,
    `Question: ${input.question.trim()}`,
    '',
    'Transcript:',
    transcript,
  ].join('\n');
}

export function buildAskPrompt(input: AskInput): Prompt {
  const transcript = formatTranscript(input.messages, input.tz);
  return { system: buildAskSystemPrompt(input), user: buildAskUserPrompt(input, transcript) };
}
