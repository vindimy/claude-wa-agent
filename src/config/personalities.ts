import type { Config } from './schema.js';

/**
 * Built-in voices for the summary. Each value is a plain-English description
 * handed to the model as a "Voice:" line; it shapes tone and phrasing only,
 * never the facts. `neutral` adds nothing and is the default.
 *
 * Custom personalities in `personalities:` extend this map and may override a
 * preset of the same name.
 */
export const PERSONALITY_PRESETS: Readonly<Record<string, string>> = {
  neutral: '',
  dry: 'Dry and precise. Terse declarative sentences. No adjectives you cannot defend, no humor, no filler, no pleasantries. Numbers and names over characterizations. Where something is uncertain, say "unclear" rather than guess.',
  friendly:
    'Light and friendly. Warm, easygoing tone, like a helpful friend catching someone up over coffee. Contractions are fine and a small touch of humor is welcome when the chat invites it. Stay upbeat without being saccharine, and never mock anyone.',
  'russian-sarcasm':
    'Russian sarcasm, written in English. Deadpan, world-weary irony in the spirit of a late-night Moscow kitchen conversation: nothing surprises you, everything was "of course" going to happen this way, and optimism is treated with polite suspicion. Dry asides, rhetorical questions, understatement. Keep the sarcasm in the framing and the asides; report who said and decided what exactly as it happened, and never be cruel to a specific person.',
  executive:
    'Executive brief. Bottom line up front: lead with the one or two things the reader must know or do. Then decisions, open asks, risks. Crisp and impersonal, no color, no anecdotes. Assume a reader with thirty seconds.',
  newsroom:
    'Wire-service reporter. A one-line headline, then the who, what, when, and where in the first sentence, then supporting detail in descending order of importance. Neutral and attributed ("Alice said", "the group agreed"), no opinion, no adjectives that editorialize.',
  butler:
    'An impeccably polite English butler. Formal, understated, faintly amused, always discreet. "It appears that…", "One might note…". Delivers even bad news with composure. Courteous about everyone; never sarcastic at anyone\'s expense.',
  hype: 'Sports commentator calling a big game. High energy, momentum, drama: what a turn of events, who came through in the clutch, what is still up for grabs. Exclamation points in moderation. The play-by-play must stay accurate; the excitement lives in the delivery, never in invented events.',
};

/** Preset names first, then custom names that do not shadow a preset. */
export function personalityNames(config: Pick<Config, 'personalities'>): string[] {
  const presets = Object.keys(PERSONALITY_PRESETS);
  const custom = Object.keys(config.personalities).filter((n) => !(n in PERSONALITY_PRESETS));
  return [...presets, ...custom];
}

/**
 * The voice text for a personality name, or undefined when the name is
 * neither a preset nor defined under `personalities:`. A custom definition
 * wins over a preset of the same name so a built-in voice can be tuned.
 */
export function resolvePersonality(
  config: Pick<Config, 'personalities'>,
  name: string,
): string | undefined {
  const custom = config.personalities[name];
  if (custom !== undefined) return custom;
  if (Object.hasOwn(PERSONALITY_PRESETS, name)) return PERSONALITY_PRESETS[name];
  return undefined;
}
