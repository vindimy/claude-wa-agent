import type { Prompt } from '../summarizer/index.js';
import type { StrippedPage } from './links.js';

export const IMAGE_MAX_WORDS = 60;
export const LINK_MAX_WORDS = 30;

/** Prompt for one photo from a group chat; the caption, if any, is context. */
export function imagePrompt(caption: string | null): Prompt {
  const system = [
    'You describe one photo that was posted in a WhatsApp group chat, so that a later summary of the chat can refer to it. Reply with the description only — no preamble, no Markdown.',
    '',
    'Rules:',
    `- English, at most ${IMAGE_MAX_WORDS} words, one or two sentences.`,
    '- Say what the picture shows: the subject, the setting, and anything a reader of the chat would care about.',
    '- Transcribe legible text exactly when it matters: dates, times, prices, names of places or products, addresses, phone numbers, screenshots of messages.',
    '- Never guess who a person is. Describe people generically (a child, two adults) and never infer names, identities, ethnicity, or health.',
    '- If the image is a meme, a poster, a screenshot, or a document, say so and summarize its text.',
    '- If it cannot be described (blank, corrupt, too small), say "unclear image".',
  ].join('\n');
  const user = caption?.trim()
    ? `Describe the attached image. The sender's caption was: "${caption.trim()}"`
    : 'Describe the attached image.';
  return { system, user };
}

/** Prompt for a fetched web page; the model sees only what `stripHtml` kept. */
export function linkPrompt(url: string, page: StrippedPage): Prompt {
  const system = [
    'You describe a web page that someone linked in a WhatsApp group chat, so that a later summary of the chat can say what the link was about. Reply with the description only — no preamble, no Markdown, no URL.',
    '',
    'Rules:',
    `- English, one line, at most ${LINK_MAX_WORDS} words.`,
    '- Say what the page is (an article, a product, a venue, an event, a video, a form) and its subject. Include a date, price, or place when the page states one.',
    '- Use only the material below. If it is a cookie wall, a login prompt, or an error page, say "page could not be read".',
  ].join('\n');
  const lines = [`URL: ${url}`];
  if (page.title) lines.push(`Title: ${page.title}`);
  if (page.description) lines.push(`Meta description: ${page.description}`);
  lines.push('', 'Page text:', page.text || '(none)');
  return { system, user: lines.join('\n') };
}
