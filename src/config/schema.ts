import { z } from 'zod';

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

export const cadenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('daily'), at: timeOfDay, tz: z.string().optional() }),
  z.object({
    type: z.literal('weekly'),
    day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
    at: timeOfDay,
    tz: z.string().optional(),
  }),
  z.object({
    type: z.literal('threshold'),
    messages: z.number().int().positive(),
    max_hours: z.number().positive(),
  }),
  z.object({ type: z.literal('manual') }),
]);

// Bare shapes without defaults: per-group overrides must stay sparse so they
// only shadow the keys the user actually wrote (a defaulted schema would fill
// every key and clobber `defaults`).
const deliverShape = {
  self_dm: z.boolean(),
  group: z.boolean(),
  vault: z.boolean(),
};

const summaryShape = {
  language: z.enum(['auto', 'ru', 'en']),
  style: z.enum(['topics', 'narrative', 'action-items']),
  max_words: z.number().int().positive(),
};

export const deliverSchema = z.object({
  self_dm: deliverShape.self_dm.default(true),
  group: deliverShape.group.default(false),
  vault: deliverShape.vault.default(true),
});

export const summarySchema = z.object({
  language: summaryShape.language.default('auto'),
  style: summaryShape.style.default('topics'),
  max_words: summaryShape.max_words.default(300),
});

const deliverOverrideSchema = z.object(deliverShape).partial();
const summaryOverrideSchema = z.object(summaryShape).partial();

const defaultsSchema = z.object({
  summarizer: z.string().default('cli-claude'),
  cadence: cadenceSchema.default({ type: 'daily', at: '08:00' }),
  deliver: deliverSchema.prefault({}),
  summary: summarySchema.prefault({}),
});

const groupJid = z.string().regex(/@g\.us$/, 'expected a group JID ending in @g.us');

export const groupConfigSchema = z.object({
  jid: groupJid,
  name: z.string().optional(),
  summarizer: z.string().optional(),
  cadence: cadenceSchema.optional(),
  deliver: deliverOverrideSchema.optional(),
  summary: summaryOverrideSchema.optional(),
});

export const configSchema = z.object({
  defaults: defaultsSchema.prefault({}),
  limits: z.object({ max_sends_per_day: z.number().int().positive().default(30) }).prefault({}),
  ingest: z.object({ media: z.boolean().default(false) }).prefault({}),
  groups: z.array(groupConfigSchema).default([]),
});

export type Cadence = z.infer<typeof cadenceSchema>;
export type Deliver = z.infer<typeof deliverSchema>;
export type SummaryOptions = z.infer<typeof summarySchema>;
export type GroupConfig = z.infer<typeof groupConfigSchema>;
export type Config = z.infer<typeof configSchema>;

/** A group's config with every default from `defaults` applied. */
export interface ResolvedGroupConfig {
  jid: string;
  name: string | undefined;
  summarizer: string;
  cadence: Cadence;
  deliver: Deliver;
  summary: SummaryOptions;
}

export function resolveGroupConfig(config: Config, jid: string): ResolvedGroupConfig | undefined {
  const group = config.groups.find((g) => g.jid === jid);
  if (!group) return undefined;
  return {
    jid: group.jid,
    name: group.name,
    summarizer: group.summarizer ?? config.defaults.summarizer,
    cadence: group.cadence ?? config.defaults.cadence,
    deliver: { ...config.defaults.deliver, ...group.deliver },
    summary: { ...config.defaults.summary, ...group.summary },
  };
}

export function allowedJids(config: Config): Set<string> {
  return new Set(config.groups.map((g) => g.jid));
}
