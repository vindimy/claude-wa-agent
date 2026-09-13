import type { MessageRow } from '../store/index.js';
import type { SummaryInput, SummarySection } from './types.js';

export interface Prompt {
  system: string;
  user: string;
}

const KIND_LABEL: Record<string, string> = {
  image: '[photo]',
  video: '[video]',
  audio: '[voice message]',
  document: '[document]',
  sticker: '[sticker]',
  other: '[attachment]',
};

function dayFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
}

function timeFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** `2026-09-03 (Thu)` in the given zone. */
export function formatDay(ts: number, tz: string): string {
  const parts = dayFormatter(tz).formatToParts(new Date(ts * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} (${get('weekday')})`;
}

/** `14:05` in the given zone. */
export function formatTime(ts: number, tz: string): string {
  return timeFormatter(tz).format(new Date(ts * 1000));
}

export function displayName(m: Pick<MessageRow, 'senderJid' | 'senderName'>): string {
  if (m.senderName?.trim()) return m.senderName.trim();
  if (m.senderJid === 'me') return 'me';
  return m.senderJid.split('@')[0] ?? m.senderJid;
}

function kindLabel(m: MessageRow): string {
  if (m.kind === 'text') return '';
  const description = m.mediaDescription?.trim();
  if (m.kind === 'image' && description) return `[photo: ${description}]`;
  return KIND_LABEL[m.kind] ?? '[attachment]';
}

function messageLine(m: MessageRow, tz: string): string {
  const body = m.body?.replace(/\s*\n\s*/g, ' ⏎ ').trim() ?? '';
  const content = [kindLabel(m), body].filter(Boolean).join(' ') || '[empty]';
  const links = m.links
    .filter((l) => l.description?.trim())
    .map((l) => ` (link: ${l.description?.trim()})`)
    .join('');
  const edited = m.editedTs ? ' (edited)' : '';
  return `${formatTime(m.ts, tz)} ${displayName(m)}: ${content}${links}${edited}`;
}

/**
 * Compact, model-friendly transcript. Messages are grouped by day with a
 * separator line; each message is one line.
 */
export function formatTranscript(messages: MessageRow[], tz: string): string {
  const lines: string[] = [];
  let currentDay = '';
  for (const m of messages) {
    const day = formatDay(m.ts, tz);
    if (day !== currentDay) {
      if (lines.length > 0) lines.push('');
      lines.push(`--- ${day} ---`);
      currentDay = day;
    }
    lines.push(messageLine(m, tz));
  }
  return lines.join('\n');
}

const STYLE_INSTRUCTIONS = {
  topics:
    'Group the summary by topic. For each topic write one short heading line (plain text, no Markdown "#"), then 1–4 "-" bullets with the substance.',
  narrative:
    'Write a short flowing narrative in chronological order. Plain paragraphs, no bullets, no headings.',
  'action-items':
    'List, in this order: decisions made; action items (owner and deadline when stated); open questions still unanswered. Use "-" bullets under a plain-text label for each section. If a section is empty, say so in one line.',
} as const;

const LANGUAGE_INSTRUCTIONS = {
  auto: 'Write in the language(s) the chat itself uses. If the chat mixes languages, keep that mix and use the dominant language for structure.',
  en: 'Write the entire summary in English.',
  ru: 'Write the entire summary in Russian.',
  pt: 'Write the entire summary in Portuguese.',
  es: 'Write the entire summary in Spanish.',
  zh: 'Write the entire summary in Chinese.',
  ja: 'Write the entire summary in Japanese.',
} as const;

export function buildSystemPrompt(input: SummaryInput): string {
  const { options } = input;
  const lines = [
    'You summarize a WhatsApp group chat for one of its members, who reads your summary instead of the chat. You receive a transcript and reply with the summary only — no preamble, no closing remarks.',
    '',
    'Rules:',
    '- Plain text suitable for a WhatsApp message: short paragraphs and "-" bullets. No Markdown headings, tables, bold, or code fences.',
    '- Be concrete: who proposed, decided, or asked what; dates, times, places, amounts, links. Skip greetings, reactions, and small talk.',
    '- Refer to people by the names shown in the transcript.',
    '- Never invent details that are not in the transcript. If the window is mostly noise, say so in one or two lines.',
    `- Length: at most ${options.max_words} words.`,
    `- ${STYLE_INSTRUCTIONS[options.style]}`,
    `- ${LANGUAGE_INSTRUCTIONS[options.language]}`,
  ];
  if (input.sections && input.sections.length > 0) {
    lines.push(
      '- The transcript covers several groups of one community, one block per group. Write a single recap: a short section per group in the given order (plain-text heading line with the group name, then bullets), skip a group with nothing of substance, and name the group when a topic spans several.',
    );
  }
  const voice = input.personality?.trim();
  if (voice) {
    lines.push(
      '',
      `Voice: ${voice}`,
      'The voice shapes tone and phrasing only; it never changes, omits, softens, or exaggerates a fact.',
    );
  }
  const instructions = options.instructions?.trim();
  if (instructions) {
    lines.push(
      '',
      'Additional instructions from the reader (they take precedence over the style and voice above, but never over accuracy):',
      instructions,
    );
  }
  return lines.join('\n');
}

function count(n: number): string {
  return n === 1 ? '1 message' : `${n} messages`;
}

export function buildUserPrompt(input: SummaryInput, transcript: string): string {
  const { tz } = input;
  const since = `${formatDay(input.sinceTs, tz)} ${formatTime(input.sinceTs, tz)}`;
  const until = `${formatDay(input.untilTs, tz)} ${formatTime(input.untilTs, tz)}`;
  const window = `Window: ${since} → ${until} (${tz}), ${count(input.messages.length)}`;
  if (input.sections && input.sections.length > 0) {
    const groups = input.sections.map((s) => `${s.groupName} (${s.messages.length})`).join(', ');
    return [
      `Recap: ${input.groupName}`,
      `Groups: ${groups}`,
      window,
      '',
      'Transcript:',
      transcript,
    ].join('\n');
  }
  return [`Group: ${input.groupName}`, window, '', 'Transcript:', transcript].join('\n');
}

/** One block per section, each headed by the group name and its message count. */
export function formatSectionedTranscript(sections: SummarySection[], tz: string): string {
  return sections
    .map(
      (s) =>
        `=== ${s.groupName} (${count(s.messages.length)}) ===\n${formatTranscript(s.messages, tz)}`,
    )
    .join('\n\n');
}

export function buildPrompt(input: SummaryInput): Prompt {
  const transcript =
    input.sections && input.sections.length > 0
      ? formatSectionedTranscript(input.sections, input.tz)
      : formatTranscript(input.messages, input.tz);
  return { system: buildSystemPrompt(input), user: buildUserPrompt(input, transcript) };
}
