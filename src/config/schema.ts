import { z } from 'zod';
import { PERSONALITY_PRESETS } from './personalities.js';

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
  /** A preset name or a key under `personalities:`; checked in configSchema. */
  personality: z.string().trim().min(1),
  /** Plain-English guidance for the model. Group text is appended to the default text. */
  instructions: z.string().trim(),
};

export const deliverSchema = z.object({
  self_dm: deliverShape.self_dm.default(true),
  group: deliverShape.group.default(false),
  vault: deliverShape.vault.default(true),
});

export const summarySchema = z.object({
  // English by default; `auto` keeps the chat's own Russian/English mix.
  language: summaryShape.language.default('en'),
  style: summaryShape.style.default('topics'),
  max_words: summaryShape.max_words.default(300),
  personality: summaryShape.personality.default('neutral'),
  instructions: summaryShape.instructions.default(''),
});

const deliverOverrideSchema = z.object(deliverShape).partial();
const summaryOverrideSchema = z.object(summaryShape).partial();

const defaultsSchema = z
  .object({
    summarizer: z.string().default('cli-claude'),
    cadence: cadenceSchema.default({ type: 'daily', at: '08:00' }),
    deliver: deliverSchema.prefault({}),
    summary: summarySchema.prefault({}),
  })
  // Posting into a group is opt-in per group, never global: a summary in the
  // wrong group is the worst failure mode of this project.
  .refine((d) => d.deliver.group === false, {
    message: 'defaults.deliver.group cannot be true; set deliver.group per group instead',
    path: ['deliver', 'group'],
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

/** Options for one summarizer adapter, keyed by adapter name under `summarizers:`. */
export const summarizerOptionsSchema = z.object({
  bin: z.string().optional(),
  model: z.string().optional(),
  timeout_seconds: z.number().positive().optional(),
});

/** Message retention in days. Summaries and run records are kept regardless. */
export const retentionDays = z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(180)]);

/** Custom voices, keyed by name. A name that matches a preset overrides it. */
const personalitiesSchema = z.record(z.string().trim().min(1), z.string().trim().min(1));

export const configSchema = z
  .object({
    defaults: defaultsSchema.prefault({}),
    personalities: personalitiesSchema.default({}),
    retention: z.object({ days: retentionDays.default(30) }).prefault({}),
    summarizers: z.record(z.string(), summarizerOptionsSchema).default({}),
    vault: z.object({ dir: z.string().default('./vault') }).prefault({}),
    limits: z
      .object({
        max_sends_per_day: z.number().int().positive().default(30),
        /** Minimum spacing between two posts into the same group. */
        min_group_post_gap_minutes: z.number().nonnegative().default(60),
      })
      .prefault({}),
    ingest: z.object({ media: z.boolean().default(false) }).prefault({}),
    // Read-only local web dashboard, off by default. Bound to loopback; in
    // Docker set host 0.0.0.0 (or DASHBOARD_HOST) and publish the port to
    // the VPS loopback only.
    dashboard: z
      .object({
        enabled: z.boolean().default(false),
        host: z.string().trim().min(1).default('127.0.0.1'),
        port: z.number().int().min(1).max(65535).default(8787),
      })
      .prefault({}),
    groups: z.array(groupConfigSchema).default([]),
  })
  // Every personality named anywhere must exist, so a typo fails at load
  // time rather than silently producing a neutral digest.
  .superRefine((config, ctx) => {
    const known = (name: string) =>
      Object.hasOwn(config.personalities, name) || Object.hasOwn(PERSONALITY_PRESETS, name);
    const complain = (name: string, path: (string | number)[]) =>
      ctx.addIssue({
        code: 'custom',
        path,
        message: `unknown personality "${name}"; add it under personalities: or use one of ${Object.keys(PERSONALITY_PRESETS).join(', ')}`,
      });
    if (!known(config.defaults.summary.personality)) {
      complain(config.defaults.summary.personality, ['defaults', 'summary', 'personality']);
    }
    config.groups.forEach((g, i) => {
      const p = g.summary?.personality;
      if (p !== undefined && !known(p)) complain(p, ['groups', i, 'summary', 'personality']);
    });
  });

export type Cadence = z.infer<typeof cadenceSchema>;
export type Deliver = z.infer<typeof deliverSchema>;
export type SummaryOptions = z.infer<typeof summarySchema>;
export type SummarizerOptions = z.infer<typeof summarizerOptionsSchema>;
export type GroupConfig = z.infer<typeof groupConfigSchema>;
export type DashboardConfig = Config['dashboard'];
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
    summary: mergeSummary(config.defaults.summary, group.summary),
  };
}

/**
 * Group keys shadow defaults, except `instructions`, which layer: the default
 * text applies to every group and the group's own text is appended, so a
 * global rule such as "always flag deadlines" survives per-group additions.
 */
export function mergeSummary(
  base: SummaryOptions,
  override: Partial<SummaryOptions> | undefined,
): SummaryOptions {
  return {
    ...base,
    ...override,
    instructions: joinInstructions(base.instructions, override?.instructions),
  };
}

export function joinInstructions(...parts: (string | undefined)[]): string {
  return parts
    .map((p) => p?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

export function allowedJids(config: Config): Set<string> {
  return new Set(config.groups.map((g) => g.jid));
}
