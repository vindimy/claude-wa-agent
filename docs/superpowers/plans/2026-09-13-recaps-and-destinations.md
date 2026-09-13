# Recaps and Destinations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a digest be sent to named groups and phone numbers other than its source, and let several listened groups be summarized together into one scheduled recap message.

**Architecture:** `destinations:` declares outward targets once; `deliver.to` references them by name and is gated exactly like a source-group post (per scope, scheduled-only, re-checked at send time). A recap is a new scope with key `recap:<name>` that reuses the existing `summaries`, `runs`, and `deliveries` tables, keeps per-source watermarks in one new table, and runs one model call over a transcript sectioned by group.

**Tech Stack:** Node 22, TypeScript (strict), zod v4, better-sqlite3, vitest, commander. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-13-recaps-and-destinations-design.md`

## Global Constraints

- Never post into a group unless config opts that specific scope into that specific destination. `defaults.deliver.to` must be empty; `defaults.deliver.group` must be false.
- Every store row, log line, and queue item carries `tenant_id`.
- Cross-module imports go through the module's `index.ts` only.
- Errors are typed (`Result` from `src/shared/index.ts` or tagged unions), never thrown strings.
- `pnpm test`, `pnpm typecheck`, and `pnpm lint` must pass before every commit. Tests need no network and no paired device.
- Scope key: a group JID (ends in `@g.us`) or `recap:<name>`. Delivery channel for a destination: `to:<name>`.
- Outward text is headed `🤖 Digest: <scopeName> · <window> · <n messages>` and footed `_Automated digest of "<scopeName>", posted by a bot, not typed by hand._`
- Changing an architecture decision means amending or adding a file in `docs/adr/` in the same change (Task 14).

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/config/destinations.ts` (new) | destination schema, phone normalisation, `resolveDestination` |
| `src/config/schema.ts` | `deliver.to`, `destinations`, `recaps`, validation, `resolveRecapConfig`, scope helpers |
| `src/config/index.ts` | exports |
| `src/store/db.ts` | migration 006 `recap_watermarks` |
| `src/store/store.ts` | channel helpers, recap watermarks, `recordRecapRun`, `countSentSince`, `lastSentToTarget` |
| `src/delivery/render.ts` | `scopeName`, `renderDestinationText`, recap vault front matter |
| `src/delivery/deliver.ts` | destination fan-out |
| `src/delivery/types.ts` | outcome types |
| `src/delivery/outbox.ts` | `to:` rows, send-time destination gate, per-target gap |
| `src/summarizer/types.ts`, `prompt.ts`, `fake.ts` | sectioned transcript |
| `src/scheduler/run-shared.ts` (new) | `summarizerFor` shared by both runners |
| `src/scheduler/run-digest.ts` | `postOutward`, destinations |
| `src/scheduler/run-recap.ts` (new) | recap pipeline |
| `src/scheduler/scheduler.ts` | recap ticks, `describe()` entries, `/digest <recap>` |
| `src/scheduler/commands.ts` | help text lists recaps |
| `src/cli/index.ts` | outbox wiring, `findScope`, `schedule`, outcome text |
| `src/dashboard/data.ts`, `page.ts` | recap rows |
| docs, ADRs, `config.example.yaml`, `README.md` | Task 14 |

---

### Task 1: Destinations and `deliver.to` in config

**Files:**
- Create: `src/config/destinations.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/index.ts`
- Test: `src/config/destinations.test.ts`, `src/config/config.test.ts`

**Interfaces:**
- Produces: `normalizePhoneNumber(raw: string): string | undefined`; `destinationSchema`; `type DestinationConfig`; `interface ResolvedDestination { name: string; kind: 'group' | 'number'; jid: string }`; `resolveDestination(destinations: Record<string, DestinationConfig>, name: string): ResolvedDestination | undefined`; `Config['destinations']`; `Deliver.to: string[]`; `resolveScopeDestinations(config: Config, scopeKey: string): ResolvedDestination[]` (group scopes only in this task; Task 2 adds recaps).

- [ ] **Step 1: Write the failing destination tests**

`src/config/destinations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { destinationSchema, normalizePhoneNumber, resolveDestination } from './destinations.js';

describe('normalizePhoneNumber', () => {
  it('keeps digits only', () => {
    expect(normalizePhoneNumber('+1 (310) 555-1234')).toBe('13105551234');
    expect(normalizePhoneNumber('13105551234')).toBe('13105551234');
  });
  it('rejects too short, too long, or non-numeric input', () => {
    expect(normalizePhoneNumber('12345')).toBeUndefined();
    expect(normalizePhoneNumber('1234567890123456')).toBeUndefined();
    expect(normalizePhoneNumber('abc')).toBeUndefined();
    expect(normalizePhoneNumber('+1 310 555 12x4')).toBeUndefined();
  });
});

describe('destinationSchema', () => {
  it('accepts a group or a number, not both, not neither', () => {
    expect(destinationSchema.safeParse({ group: '1@g.us' }).success).toBe(true);
    expect(destinationSchema.safeParse({ number: '+1 310 555 1234' }).success).toBe(true);
    expect(destinationSchema.safeParse({ group: '1@g.us', number: '+13105551234' }).success).toBe(
      false,
    );
    expect(destinationSchema.safeParse({}).success).toBe(false);
    expect(destinationSchema.safeParse({ group: '1@s.whatsapp.net' }).success).toBe(false);
    expect(destinationSchema.safeParse({ number: '12' }).success).toBe(false);
  });
});

describe('resolveDestination', () => {
  const destinations = {
    hub: { group: '120363000000000009@g.us' },
    me: { number: '+1 (310) 555-1234' },
  };
  it('resolves a group to its JID', () => {
    expect(resolveDestination(destinations, 'hub')).toEqual({
      name: 'hub',
      kind: 'group',
      jid: '120363000000000009@g.us',
    });
  });
  it('resolves a number to a user JID', () => {
    expect(resolveDestination(destinations, 'me')).toEqual({
      name: 'me',
      kind: 'number',
      jid: '13105551234@s.whatsapp.net',
    });
  });
  it('returns undefined for an unknown name', () => {
    expect(resolveDestination(destinations, 'nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/config/destinations.test.ts`
Expected: FAIL, cannot find module `./destinations.js`.

- [ ] **Step 3: Create `src/config/destinations.ts`**

```ts
import { z } from 'zod';

export const GROUP_JID_RE = /@g\.us$/;
export const groupJid = z.string().regex(GROUP_JID_RE, 'expected a group JID ending in @g.us');

/** Digits only, 7 to 15 of them (E.164 length), or undefined if the input is not a phone number. */
export function normalizePhoneNumber(raw: string): string | undefined {
  const stripped = raw.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d{7,15}$/.test(stripped)) return undefined;
  return stripped;
}

const phoneNumber = z
  .string()
  .trim()
  .refine((v) => normalizePhoneNumber(v) !== undefined, {
    message: 'expected a phone number with 7 to 15 digits, e.g. "+13105551234"',
  });

/**
 * One outward target. Exactly one of `group` or `number`; `strictObject` so a
 * typo such as `numbr:` fails instead of silently producing an empty target.
 */
export const destinationSchema = z.union([
  z.strictObject({ group: groupJid }),
  z.strictObject({ number: phoneNumber }),
]);

export type DestinationConfig = z.infer<typeof destinationSchema>;

export interface ResolvedDestination {
  name: string;
  kind: 'group' | 'number';
  /** Group JID or `<digits>@s.whatsapp.net`. */
  jid: string;
}

export function resolveDestination(
  destinations: Record<string, DestinationConfig>,
  name: string,
): ResolvedDestination | undefined {
  const d = destinations[name];
  if (!d) return undefined;
  if ('group' in d) return { name, kind: 'group', jid: d.group };
  const digits = normalizePhoneNumber(d.number);
  if (!digits) return undefined;
  return { name, kind: 'number', jid: `${digits}@s.whatsapp.net` };
}
```

- [ ] **Step 4: Run the destination tests**

Run: `pnpm vitest run src/config/destinations.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing config tests for `deliver.to` and `destinations`**

Append to `src/config/config.test.ts` inside `describe('configSchema', …)`:

```ts
  it('accepts destinations and per-group deliver.to', () => {
    const config = configSchema.parse({
      destinations: { hub: { group: '9@g.us' }, me: { number: '+13105551234' } },
      groups: [{ jid: '1@g.us', deliver: { to: ['hub', 'me'] } }],
    });
    expect(config.defaults.deliver.to).toEqual([]);
    expect(resolveGroupConfig(config, '1@g.us')?.deliver.to).toEqual(['hub', 'me']);
  });

  it('refuses a global deliver.to', () => {
    const result = configSchema.safeParse({
      destinations: { hub: { group: '9@g.us' } },
      defaults: { deliver: { to: ['hub'] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('per group');
  });

  it('rejects an unknown destination name on a group', () => {
    const result = configSchema.safeParse({
      destinations: { hub: { group: '9@g.us' } },
      groups: [{ jid: '1@g.us', deliver: { to: ['hubb'] } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('unknown destination "hubb"');
      expect(result.error.issues[0]?.path).toEqual(['groups', 0, 'deliver', 'to', 0]);
    }
  });
```

And a new `describe`:

```ts
describe('resolveScopeDestinations', () => {
  it('resolves a group scope to its destinations in config order', () => {
    const config = configSchema.parse({
      destinations: { hub: { group: '9@g.us' }, me: { number: '+13105551234' } },
      groups: [{ jid: '1@g.us', deliver: { to: ['me', 'hub'] } }, { jid: '2@g.us' }],
    });
    expect(resolveScopeDestinations(config, '1@g.us')).toEqual([
      { name: 'me', kind: 'number', jid: '13105551234@s.whatsapp.net' },
      { name: 'hub', kind: 'group', jid: '9@g.us' },
    ]);
    expect(resolveScopeDestinations(config, '2@g.us')).toEqual([]);
    expect(resolveScopeDestinations(config, 'unknown@g.us')).toEqual([]);
  });
});
```

Add `resolveScopeDestinations` to the import from `./schema.js` at the top of the file.

- [ ] **Step 6: Run the config tests to verify they fail**

Run: `pnpm vitest run src/config/config.test.ts`
Expected: FAIL, `resolveScopeDestinations` is not exported and `to` is stripped.

- [ ] **Step 7: Modify `src/config/schema.ts`**

Replace the local `groupJid` definition with an import, add `to` to the deliver shapes, add `destinations` to the config, add the refinements, and add `resolveScopeDestinations`.

At the top:

```ts
import { z } from 'zod';
import {
  type DestinationConfig,
  destinationSchema,
  groupJid,
  type ResolvedDestination,
  resolveDestination,
} from './destinations.js';
import { PERSONALITY_PRESETS } from './personalities.js';
```

Delete the line `const groupJid = z.string().regex(/@g\.us$/, …);`.

Change the deliver shapes:

```ts
const destinationName = z.string().trim().min(1);

const deliverShape = {
  self_dm: z.boolean(),
  group: z.boolean(),
  vault: z.boolean(),
  /** Names under `destinations:`; outward, so gated like `group`. */
  to: z.array(destinationName),
};

export const deliverSchema = z.object({
  self_dm: deliverShape.self_dm.default(true),
  group: deliverShape.group.default(false),
  vault: deliverShape.vault.default(true),
  to: deliverShape.to.default([]),
});
```

Change the `defaultsSchema` refine to cover both outward keys:

```ts
const defaultsSchema = z
  .object({
    summarizer: z.string().default('cli-claude'),
    cadence: cadenceSchema.default({ type: 'daily', at: '08:00' }),
    deliver: deliverSchema.prefault({}),
    summary: summarySchema.prefault({}),
  })
  // Outward delivery is opt-in per scope, never global: a summary in the
  // wrong group is the worst failure mode of this project.
  .refine((d) => d.deliver.group === false, {
    message: 'defaults.deliver.group cannot be true; set deliver.group per group instead',
    path: ['deliver', 'group'],
  })
  .refine((d) => d.deliver.to.length === 0, {
    message: 'defaults.deliver.to cannot be set; set deliver.to per group or per recap instead',
    path: ['deliver', 'to'],
  });
```

Add `destinations` to `configSchema` right after `personalities`:

```ts
    destinations: z.record(destinationName, destinationSchema).default({}),
```

Extend the existing `superRefine` with a destination check after the personality block:

```ts
    const complainDestination = (name: string, path: (string | number)[]) =>
      ctx.addIssue({
        code: 'custom',
        path,
        message: `unknown destination "${name}"; add it under destinations: (known: ${Object.keys(config.destinations).join(', ') || 'none'})`,
      });
    config.groups.forEach((g, i) => {
      g.deliver?.to?.forEach((name, j) => {
        if (!Object.hasOwn(config.destinations, name)) {
          complainDestination(name, ['groups', i, 'deliver', 'to', j]);
        }
      });
    });
```

Add after `allowedJids`:

```ts
/**
 * Resolved outward targets for a scope (a group JID, or `recap:<name>` once
 * recaps exist). Empty for an unknown scope: the caller never guesses.
 */
export function resolveScopeDestinations(config: Config, scopeKey: string): ResolvedDestination[] {
  const names = resolveGroupConfig(config, scopeKey)?.deliver.to ?? [];
  return names
    .map((name) => resolveDestination(config.destinations, name))
    .filter((d): d is ResolvedDestination => d !== undefined);
}

export type { DestinationConfig, ResolvedDestination };
```

- [ ] **Step 8: Export from `src/config/index.ts`**

Add to the `./schema.js` export list: `type DestinationConfig`, `type ResolvedDestination`, `resolveScopeDestinations`. Add a new line:

```ts
export { normalizePhoneNumber, resolveDestination } from './destinations.js';
```

- [ ] **Step 9: Run tests, typecheck, lint**

Run: `pnpm vitest run src/config && pnpm typecheck && pnpm lint`
Expected: PASS. The existing test `applies defaults to an empty config` asserts `defaults.deliver` equals `{ self_dm: true, group: false, vault: true }`; update it to include `to: []`. Any other test that compares a full `deliver` object needs the same addition (search for `group: false, vault: true`).

- [ ] **Step 10: Commit**

```bash
git add src/config
git commit -m "feat(config): named destinations and per-group deliver.to"
```

---

### Task 2: Recaps in config

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/index.ts`
- Test: `src/config/config.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `recapConfigSchema`; `type RecapConfig`; `interface ResolvedRecapConfig { name: string; key: string; sources: Array<{ jid: string; name: string }>; summarizer: string; cadence: Cadence; deliver: { self_dm: boolean; vault: boolean; to: string[] }; summary: SummaryOptions }`; `recapScopeKey(name: string): string`; `isRecapScopeKey(key: string): boolean`; `findGroupConfig(config, ref): GroupConfig | undefined` (JID or case-insensitive name); `resolveRecapConfig(config, name): ResolvedRecapConfig | undefined` (exact, case-insensitive); `findRecapConfig(config, ref): ResolvedRecapConfig | undefined` (exact, then substring); `resolveScopeDestinations` now handles recap keys.

- [ ] **Step 1: Write the failing tests**

Append to `src/config/config.test.ts`:

```ts
describe('recaps', () => {
  const base = {
    defaults: { summarizer: 'fake', cadence: { type: 'daily', at: '08:00' } },
    destinations: { hub: { group: '9@g.us' }, me: { number: '+13105551234' } },
    groups: [
      { jid: '1@g.us', name: 'Announcements' },
      { jid: '2@g.us', name: 'Nerds', summarizer: 'cli-gemini' },
    ],
  };

  it('resolves a recap with defaults applied', () => {
    const config = configSchema.parse({
      ...base,
      recaps: [
        {
          name: 'SoCal Zouk',
          sources: ['announcements', '2@g.us'],
          cadence: { type: 'weekly', day: 'sun', at: '18:00' },
          summary: { max_words: 600, instructions: 'Lead with events.' },
          deliver: { to: ['hub', 'me'] },
        },
      ],
    });
    const recap = resolveRecapConfig(config, 'socal zouk');
    expect(recap).toEqual({
      name: 'SoCal Zouk',
      key: 'recap:SoCal Zouk',
      sources: [
        { jid: '1@g.us', name: 'Announcements' },
        { jid: '2@g.us', name: 'Nerds' },
      ],
      summarizer: 'fake',
      cadence: { type: 'weekly', day: 'sun', at: '18:00' },
      deliver: { self_dm: true, vault: true, to: ['hub', 'me'] },
      summary: {
        language: 'en',
        style: 'topics',
        max_words: 600,
        personality: 'neutral',
        instructions: 'Lead with events.',
      },
    });
    expect(resolveScopeDestinations(config, 'recap:SoCal Zouk')).toEqual([
      { name: 'hub', kind: 'group', jid: '9@g.us' },
      { name: 'me', kind: 'number', jid: '13105551234@s.whatsapp.net' },
    ]);
  });

  it('finds a recap by substring after an exact match', () => {
    const config = configSchema.parse({
      ...base,
      recaps: [
        { name: 'Zouk', sources: ['Nerds'] },
        { name: 'Zouk Weekly', sources: ['Nerds'] },
      ],
    });
    expect(findRecapConfig(config, 'zouk')?.name).toBe('Zouk');
    expect(findRecapConfig(config, 'weekly')?.name).toBe('Zouk Weekly');
    expect(findRecapConfig(config, 'nothing')).toBeUndefined();
  });

  it('rejects a recap whose source is not a configured group', () => {
    const result = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'R', sources: ['Announcements', 'Family'] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('unknown source "Family"');
      expect(result.error.issues[0]?.path).toEqual(['recaps', 0, 'sources', 1]);
    }
  });

  it('rejects a repeated source', () => {
    const result = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'R', sources: ['Announcements', '1@g.us'] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('repeated');
  });

  it('rejects a recap name that collides with a group or another recap', () => {
    const dup = configSchema.safeParse({
      ...base,
      recaps: [
        { name: 'R', sources: ['Nerds'] },
        { name: 'r', sources: ['Nerds'] },
      ],
    });
    expect(dup.success).toBe(false);
    const group = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'nerds', sources: ['Nerds'] }],
    });
    expect(group.success).toBe(false);
    if (!group.success) expect(group.error.issues[0]?.message).toContain('same name as a group');
  });

  it('rejects an unknown destination or a group key on a recap', () => {
    const unknown = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'R', sources: ['Nerds'], deliver: { to: ['nope'] } }],
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues[0]?.path).toEqual(['recaps', 0, 'deliver', 'to', 0]);
    }
    const withGroup = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'R', sources: ['Nerds'], deliver: { group: true } }],
    });
    expect(withGroup.success).toBe(false);
  });

  it('checks recap personalities like group ones', () => {
    const result = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'R', sources: ['Nerds'], summary: { personality: 'nope' } }],
    });
    expect(result.success).toBe(false);
  });
});
```

Add `findRecapConfig`, `resolveRecapConfig` to the `./schema.js` import.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/config/config.test.ts`
Expected: FAIL on missing exports.

- [ ] **Step 3: Add the recap schema and helpers to `src/config/schema.ts`**

After `groupConfigSchema`:

```ts
/** A recap delivers outward only through `to`; there is no single source to post back into. */
const recapDeliverOverrideSchema = z
  .strictObject({
    self_dm: deliverShape.self_dm,
    vault: deliverShape.vault,
    to: deliverShape.to,
  })
  .partial();

export const recapConfigSchema = z.object({
  name: z.string().trim().min(1),
  /** Configured groups, by JID or name. */
  sources: z.array(z.string().trim().min(1)).min(1),
  summarizer: z.string().optional(),
  cadence: cadenceSchema.optional(),
  deliver: recapDeliverOverrideSchema.optional(),
  summary: summaryOverrideSchema.optional(),
});
```

Add `recaps: z.array(recapConfigSchema).default([]),` to `configSchema` after `groups`.

Extend the `superRefine` (after the group destination check):

```ts
    const groupByRef = (ref: string) => findGroupConfig(config, ref);
    const groupNames = new Set(
      config.groups.flatMap((g) => [g.jid.toLowerCase(), g.name?.toLowerCase() ?? '']),
    );
    const seenRecapNames = new Set<string>();
    config.recaps.forEach((r, i) => {
      const lower = r.name.toLowerCase();
      if (seenRecapNames.has(lower)) {
        ctx.addIssue({
          code: 'custom',
          path: ['recaps', i, 'name'],
          message: `recap "${r.name}" is defined twice (names are case-insensitive)`,
        });
      }
      seenRecapNames.add(lower);
      if (groupNames.has(lower)) {
        ctx.addIssue({
          code: 'custom',
          path: ['recaps', i, 'name'],
          message: `recap "${r.name}" has the same name as a group; /digest could not tell them apart`,
        });
      }
      const seenSources = new Set<string>();
      r.sources.forEach((ref, j) => {
        const g = groupByRef(ref);
        if (!g) {
          ctx.addIssue({
            code: 'custom',
            path: ['recaps', i, 'sources', j],
            message: `unknown source "${ref}"; every source must be a configured group (JID or name)`,
          });
          return;
        }
        if (seenSources.has(g.jid)) {
          ctx.addIssue({
            code: 'custom',
            path: ['recaps', i, 'sources', j],
            message: `source "${ref}" is repeated`,
          });
        }
        seenSources.add(g.jid);
      });
      r.deliver?.to?.forEach((name, j) => {
        if (!Object.hasOwn(config.destinations, name)) {
          complainDestination(name, ['recaps', i, 'deliver', 'to', j]);
        }
      });
      const p = r.summary?.personality;
      if (p !== undefined && !known(p)) complain(p, ['recaps', i, 'summary', 'personality']);
    });
```

Add the types and helpers after `resolveGroupConfig`:

```ts
export type RecapConfig = z.infer<typeof recapConfigSchema>;

export interface ResolvedRecapConfig {
  name: string;
  /** Scope key used in `summaries`, `runs`, and `recap_watermarks`. */
  key: string;
  sources: Array<{ jid: string; name: string }>;
  summarizer: string;
  cadence: Cadence;
  deliver: { self_dm: boolean; vault: boolean; to: string[] };
  summary: SummaryOptions;
}

export function recapScopeKey(name: string): string {
  return `recap:${name}`;
}

export function isRecapScopeKey(key: string): boolean {
  return key.startsWith('recap:');
}

/** A configured group by JID or case-insensitive name. */
export function findGroupConfig(config: Config, ref: string): GroupConfig | undefined {
  const trimmed = ref.trim();
  const lower = trimmed.toLowerCase();
  return (
    config.groups.find((g) => g.jid === trimmed) ??
    config.groups.find((g) => g.name?.toLowerCase() === lower)
  );
}

/** A recap by exact (case-insensitive) name, with every default applied. */
export function resolveRecapConfig(config: Config, name: string): ResolvedRecapConfig | undefined {
  const lower = name.trim().toLowerCase();
  const recap = config.recaps.find((r) => r.name.toLowerCase() === lower);
  if (!recap) return undefined;
  const sources = recap.sources
    .map((ref) => findGroupConfig(config, ref))
    .filter((g): g is GroupConfig => g !== undefined)
    .map((g) => ({ jid: g.jid, name: g.name ?? g.jid }));
  return {
    name: recap.name,
    key: recapScopeKey(recap.name),
    sources,
    summarizer: recap.summarizer ?? config.defaults.summarizer,
    cadence: recap.cadence ?? config.defaults.cadence,
    deliver: {
      self_dm: recap.deliver?.self_dm ?? config.defaults.deliver.self_dm,
      vault: recap.deliver?.vault ?? config.defaults.deliver.vault,
      to: recap.deliver?.to ?? [],
    },
    summary: mergeSummary(config.defaults.summary, recap.summary),
  };
}

/** Exact name first, then the first recap whose name contains `ref`. */
export function findRecapConfig(config: Config, ref: string): ResolvedRecapConfig | undefined {
  const exact = resolveRecapConfig(config, ref);
  if (exact) return exact;
  const lower = ref.trim().toLowerCase();
  const partial = config.recaps.find((r) => r.name.toLowerCase().includes(lower));
  return partial ? resolveRecapConfig(config, partial.name) : undefined;
}
```

Replace `resolveScopeDestinations` so it understands both scope kinds:

```ts
export function resolveScopeDestinations(config: Config, scopeKey: string): ResolvedDestination[] {
  const names = isRecapScopeKey(scopeKey)
    ? (resolveRecapConfig(config, scopeKey.slice('recap:'.length))?.deliver.to ?? [])
    : (resolveGroupConfig(config, scopeKey)?.deliver.to ?? []);
  return names
    .map((name) => resolveDestination(config.destinations, name))
    .filter((d): d is ResolvedDestination => d !== undefined);
}
```

- [ ] **Step 4: Export from `src/config/index.ts`**

Add to the `./schema.js` list: `findGroupConfig`, `findRecapConfig`, `isRecapScopeKey`, `type RecapConfig`, `recapScopeKey`, `type ResolvedRecapConfig`, `resolveRecapConfig`.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm vitest run src/config && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config
git commit -m "feat(config): recaps over several source groups"
```

---

### Task 3: Store: migration 006 and recap watermarks

**Files:**
- Modify: `src/store/db.ts`
- Modify: `src/store/store.ts`
- Modify: `src/store/index.ts`
- Test: `src/store/db.test.ts`, `src/store/store.test.ts`

**Interfaces:**
- Produces: `interface RecapWatermark { sourceJid: string; watermarkTs: number; watermarkId: string }`; `Store.recapWatermarks(tenantId: string, recap: string): Map<string, { watermarkTs: number; watermarkId: string }>`; `Store.recordRecapRun(run: RunRecord, recap: string, watermarks: RecapWatermark[]): void`.

- [ ] **Step 1: Write the failing tests**

Append to `src/store/db.test.ts` inside `describe('migrations', …)`:

```ts
  it('006 adds recap_watermarks on top of an existing database', () => {
    const db = openDatabase(':memory:', 5);
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(recap_watermarks)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual([
      'tenant_id',
      'recap',
      'source_jid',
      'watermark_ts',
      'watermark_id',
      'run_id',
      'updated_ts',
    ]);
  });
```

Append to `src/store/store.test.ts` (the file's `T` constant is `'owner'`; each `describe` block owns its `store`):

```ts
describe('Store: recap watermarks', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  const run = (id: string): RunRecord => ({
    tenantId: T,
    id,
    groupJid: 'recap:Zouk',
    trigger: 'weekly',
    dryRun: false,
    sinceTs: 0,
    untilTs: 100,
    messageCount: 3,
    watermarkTs: 90,
    watermarkId: 'M9',
    summaryId: 's1',
    adapter: 'fake',
    model: null,
    status: 'ok',
    error: null,
    costUsd: null,
    durationMs: null,
    createdTs: 100,
  });

  it('records the run and one watermark per source in one go', () => {
    store.recordRecapRun(run('r1'), 'Zouk', [
      { sourceJid: 'a@g.us', watermarkTs: 80, watermarkId: 'A8' },
      { sourceJid: 'b@g.us', watermarkTs: 90, watermarkId: 'B9' },
    ]);
    expect(store.lastWatermark(T, 'recap:Zouk')).toEqual({ watermarkTs: 90, watermarkId: 'M9' });
    expect([...store.recapWatermarks(T, 'Zouk').entries()]).toEqual([
      ['a@g.us', { watermarkTs: 80, watermarkId: 'A8' }],
      ['b@g.us', { watermarkTs: 90, watermarkId: 'B9' }],
    ]);
    expect(store.recapWatermarks('acme', 'Zouk').size).toBe(0);
    expect(store.recapWatermarks(T, 'Other').size).toBe(0);
  });

  it('advances only the sources given and keeps the rest', () => {
    store.recordRecapRun(run('r1'), 'Zouk', [
      { sourceJid: 'a@g.us', watermarkTs: 80, watermarkId: 'A8' },
      { sourceJid: 'b@g.us', watermarkTs: 90, watermarkId: 'B9' },
    ]);
    store.recordRecapRun({ ...run('r2'), createdTs: 200 }, 'Zouk', [
      { sourceJid: 'b@g.us', watermarkTs: 150, watermarkId: 'B15' },
    ]);
    expect(store.recapWatermarks(T, 'Zouk').get('a@g.us')).toEqual({
      watermarkTs: 80,
      watermarkId: 'A8',
    });
    expect(store.recapWatermarks(T, 'Zouk').get('b@g.us')).toEqual({
      watermarkTs: 150,
      watermarkId: 'B15',
    });
  });

  it('does not touch the per-group digest watermark', () => {
    store.recordRecapRun(run('r1'), 'Zouk', [
      { sourceJid: 'a@g.us', watermarkTs: 80, watermarkId: 'A8' },
    ]);
    expect(store.lastWatermark(T, 'a@g.us')).toBeUndefined();
  });
});
```

Add `type RunRecord` to the import from `./store.js` if not already imported.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/store`
Expected: FAIL (no table, no methods).

- [ ] **Step 3: Add migration 006 to `src/store/db.ts`**

Append to the `MIGRATIONS` array after migration 005:

```ts
  // 006 — recaps (phase 14, ADR 0007). A recap reads each source group from
  // its own watermark and never moves the group's digest watermark in `runs`.
  `
  CREATE TABLE recap_watermarks (
    tenant_id TEXT NOT NULL,
    recap TEXT NOT NULL,
    source_jid TEXT NOT NULL,
    watermark_ts INTEGER NOT NULL,
    watermark_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    updated_ts INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, recap, source_jid)
  );
  `,
```

- [ ] **Step 4: Add the store methods in `src/store/store.ts`**

Add the type near `RunRecord`:

```ts
/** Per-source position of a recap; see `recap_watermarks`. */
export interface RecapWatermark {
  sourceJid: string;
  watermarkTs: number;
  watermarkId: string;
}
```

Add after `insertRun`:

```ts
  /**
   * Record a recap run and advance the watermark of every source it covered,
   * atomically. Sources not listed keep their previous position.
   */
  recordRecapRun(run: RunRecord, recap: string, watermarks: RecapWatermark[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO recap_watermarks (tenant_id, recap, source_jid, watermark_ts, watermark_id,
         run_id, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, recap, source_jid) DO UPDATE SET
         watermark_ts = excluded.watermark_ts, watermark_id = excluded.watermark_id,
         run_id = excluded.run_id, updated_ts = excluded.updated_ts`,
    );
    this.db.transaction(() => {
      this.insertRun(run);
      for (const w of watermarks) {
        upsert.run(
          run.tenantId,
          recap,
          w.sourceJid,
          w.watermarkTs,
          w.watermarkId,
          run.id,
          run.createdTs,
        );
      }
    })();
  }

  /** Source watermarks of a recap, keyed by source JID, in source-JID order. */
  recapWatermarks(
    tenantId: string,
    recap: string,
  ): Map<string, { watermarkTs: number; watermarkId: string }> {
    const rows = this.db
      .prepare(
        `SELECT source_jid, watermark_ts, watermark_id FROM recap_watermarks
         WHERE tenant_id = ? AND recap = ? ORDER BY source_jid`,
      )
      .all(tenantId, recap) as Array<{
      source_jid: string;
      watermark_ts: number;
      watermark_id: string;
    }>;
    return new Map(
      rows.map((r) => [r.source_jid, { watermarkTs: r.watermark_ts, watermarkId: r.watermark_id }]),
    );
  }
```

Export `type RecapWatermark` from `src/store/index.ts`.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm vitest run src/store && pnpm typecheck && pnpm lint`
Expected: PASS. If a db test asserts the exact `MIGRATION_COUNT` value, update it to 6.

- [ ] **Step 6: Commit**

```bash
git add src/store
git commit -m "feat(store): recap_watermarks table and recordRecapRun"
```

---

### Task 4: Store: destination channels, send counting, per-target last-sent

**Files:**
- Modify: `src/store/store.ts`
- Modify: `src/store/index.ts`
- Modify: `src/delivery/outbox.ts:95-100` (call site of `lastSentTs`)
- Test: `src/store/store.test.ts`

**Interfaces:**
- Produces: `type DeliveryChannel = 'self_dm' | 'vault' | 'group' | \`to:${string}\``; `destinationChannel(name: string): DeliveryChannel`; `destinationName(channel: string): string | undefined`; `Store.lastSentToTarget(tenantId: string, target: string): number | undefined`; `Store.countSentSince` now counts `to:` rows. `Store.lastSentTs` is removed.

- [ ] **Step 1: Write the failing tests**

In `src/store/store.test.ts`, replace the four `lastSentTs` assertions at the end of the existing test (around line 299) with:

```ts
    store.putDelivery({
      tenantId: T,
      summaryId: 'z',
      channel: 'to:me',
      status: 'sent',
      target: '13105551234@s.whatsapp.net',
      createdTs: 1,
      sentTs: 700,
    });
    expect(store.lastSentToTarget(T, 'g1@g.us')).toBe(300);
    expect(store.lastSentToTarget(T, 'g2@g.us')).toBe(900);
    expect(store.lastSentToTarget(T, '13105551234@s.whatsapp.net')).toBe(700);
    expect(store.lastSentToTarget(T, 'g3@g.us')).toBeUndefined();
```

Add a new test in the same `describe`:

```ts
  it('counts destination sends against the daily cap', () => {
    store.putDelivery({
      tenantId: T,
      summaryId: 'a',
      channel: 'to:hub',
      status: 'sent',
      target: 'g9@g.us',
      createdTs: 1,
      sentTs: 50,
    });
    store.putDelivery({
      tenantId: T,
      summaryId: 'a',
      channel: 'vault',
      status: 'sent',
      target: '/tmp/x.md',
      createdTs: 1,
      sentTs: 50,
    });
    expect(store.countSentSince(T, 0)).toBe(1);
  });

  it('maps destination names to channels and back', () => {
    expect(destinationChannel('hub')).toBe('to:hub');
    expect(destinationName('to:hub')).toBe('hub');
    expect(destinationName('group')).toBeUndefined();
  });
```

Import `destinationChannel`, `destinationName` from `./store.js`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/store/store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/store/store.ts`**

Replace the `DeliveryChannel` type:

```ts
/** `to:<name>` is one row per named destination; see `destinationChannel`. */
export type DeliveryChannel = 'self_dm' | 'vault' | 'group' | `to:${string}`;

export function destinationChannel(name: string): DeliveryChannel {
  return `to:${name}`;
}

/** The destination name of a `to:<name>` channel, or undefined for any other channel. */
export function destinationName(channel: string): string | undefined {
  return channel.startsWith('to:') ? channel.slice(3) : undefined;
}
```

Replace `lastSentTs` with:

```ts
  /** When this tenant last sent anything to `target` (any WhatsApp channel), if ever. */
  lastSentToTarget(tenantId: string, target: string): number | undefined {
    const r = this.db
      .prepare(
        `SELECT MAX(sent_ts) AS ts FROM deliveries
         WHERE tenant_id = ? AND target = ? AND status = 'sent' AND channel != 'vault'`,
      )
      .get(tenantId, target) as { ts: number | null };
    return r.ts ?? undefined;
  }
```

Change `countSentSince`'s WHERE clause to:

```sql
         WHERE tenant_id = ? AND status = 'sent' AND sent_ts >= ?
           AND (channel IN ('self_dm', 'group') OR channel LIKE 'to:%')
```

(keep the parameter order `tenantId, sinceTs` and update the doc comment to "self_dm, group, and destination rows").

In `src/delivery/outbox.ts` `heldUntil`, replace `store.lastSentTs(tenantId, 'group', row.target)` with `store.lastSentToTarget(tenantId, row.target)`.

Export `destinationChannel`, `destinationName` from `src/store/index.ts`.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm vitest run src/store src/delivery && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store src/delivery/outbox.ts
git commit -m "feat(store): to:<name> delivery channels, per-target last-sent, cap counts destinations"
```

---

### Task 5: Rendering: scope name, destination text, recap vault notes

**Files:**
- Modify: `src/delivery/render.ts`
- Modify: `src/delivery/index.ts`
- Modify: every `render: { groupName: … }` call site (grep `groupName:` in `src/delivery`, `src/scheduler`, `src/cli`)
- Test: `src/delivery/render.test.ts`

**Interfaces:**
- Produces: `interface RenderContext { scopeName: string; tz: string; sources?: Array<{ jid: string; name: string }> }`; `renderDestinationText(s: SummaryRecord, ctx: RenderContext): string`; `destinationSignature(scopeName: string): string`.

- [ ] **Step 1: Write the failing tests**

Append to `src/delivery/render.test.ts` (reuse the file's existing `SummaryRecord` fixture; if it is named differently, adapt the variable name):

```ts
describe('renderDestinationText', () => {
  it('heads with the scope name and window and signs at the bottom', () => {
    const text = renderDestinationText(summary, { scopeName: 'SoCal Zouk', tz: 'UTC' });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^🤖 Digest: SoCal Zouk · 2025-09-0\d(?: → 2025-09-0\d)? · 2 messages$/);
    expect(lines[lines.length - 1]).toBe(
      '_Automated digest of "SoCal Zouk", posted by a bot, not typed by hand._',
    );
    expect(text).toContain('\nhello\n');
  });
});

describe('renderVaultMarkdown for a recap', () => {
  it('lists sources instead of a group', () => {
    const md = renderVaultMarkdown(
      { ...summary, groupJid: 'recap:SoCal Zouk' },
      {
        scopeName: 'SoCal Zouk',
        tz: 'UTC',
        sources: [
          { jid: '1@g.us', name: 'Announcements' },
          { jid: '2@g.us', name: 'Nerds' },
        ],
      },
    );
    expect(md).toContain('recap: "SoCal Zouk"');
    expect(md).toContain('sources:\n  - { name: "Announcements", jid: "1@g.us" }\n  - { name: "Nerds", jid: "2@g.us" }');
    expect(md).not.toContain('\ngroup:');
    expect(md).not.toContain('\njid:');
    expect(md).toContain('# SoCal Zouk — ');
  });
});
```

Update every existing `{ groupName: 'Team', tz: 'UTC' }` in this test file to `{ scopeName: 'Team', tz: 'UTC' }` and import `renderDestinationText`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/delivery/render.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/delivery/render.ts`**

```ts
export interface RenderContext {
  /** The group's name or the recap's name. */
  scopeName: string;
  tz: string;
  /** Set for a recap; drives the vault front matter. */
  sources?: Array<{ jid: string; name: string }>;
}
```

Replace every `ctx.groupName` in the file with `ctx.scopeName`.

Add after `renderGroupPostText`:

```ts
/** Footer on every message sent to a destination (a group or a number that is not the source). */
export function destinationSignature(scopeName: string): string {
  return `_Automated digest of "${scopeName}", posted by a bot, not typed by hand._`;
}

/**
 * Text for a destination. Unlike a post back into the source, the reader
 * may not know which chat this covers, so the scope name leads.
 */
export function renderDestinationText(s: SummaryRecord, ctx: RenderContext): string {
  const n = s.messageCount === 1 ? '1 message' : `${s.messageCount} messages`;
  return [
    `🤖 Digest: ${ctx.scopeName} · ${windowLabel(s, ctx.tz)} · ${n}`,
    '',
    s.text,
    '',
    destinationSignature(ctx.scopeName),
  ].join('\n');
}
```

In `renderVaultMarkdown`, replace the two lines `group: …` and `jid: …` with a spread:

```ts
    ...(ctx.sources
      ? [
          `recap: ${yamlStr(ctx.scopeName)}`,
          'sources:',
          ...ctx.sources.map((g) => `  - { name: ${yamlStr(g.name)}, jid: ${yamlStr(g.jid)} }`),
        ]
      : [`group: ${yamlStr(ctx.scopeName)}`, `jid: ${yamlStr(s.groupJid)}`]),
```

Export `destinationSignature` and `renderDestinationText` from `src/delivery/index.ts`.

- [ ] **Step 4: Rename call sites**

Run: `grep -rn "groupName:" src --include='*.ts' | grep -i "render\|tz:"` and change each `RenderContext` literal from `groupName:` to `scopeName:` (expected: `src/delivery/deliver.test.ts`, `src/scheduler/run-digest.ts` line with `render: { groupName, tz }` becomes `render: { scopeName: groupName, tz }`). Leave `SummaryInput.groupName` untouched.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "feat(delivery): destination text and recap vault notes; RenderContext.scopeName"
```

---

### Task 6: Delivery fan-out to destinations

**Files:**
- Modify: `src/delivery/deliver.ts`
- Modify: `src/delivery/types.ts`
- Test: `src/delivery/deliver.test.ts`

**Interfaces:**
- Consumes: `ResolvedDestination` (Task 1), `destinationChannel` (Task 4), `renderDestinationText` (Task 5).
- Produces: `DeliverArgs.deliver: { self_dm: boolean; vault: boolean; group: boolean }` (a full `Deliver` still type-checks); `DeliverArgs.destinations?: ResolvedDestination[]`; `DeliveryOutcome` gains `{ channel: 'to'; name: string; outcome: 'queued'; target: string }`, `{ channel: 'to'; name: string; outcome: 'already'; status: 'queued' | 'sent' }`, `{ channel: 'to'; name: string; outcome: 'skipped'; reason: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/delivery/deliver.test.ts` inside `describe('deliverSummary', …)`:

```ts
  const hub = { name: 'hub', kind: 'group' as const, jid: '120363000000000009@g.us' };
  const me = { name: 'me', kind: 'number' as const, jid: '13105551234@s.whatsapp.net' };

  it('queues one row per destination with the resolved target', () => {
    const outcomes = deliverSummary({
      store,
      summary,
      deliver: { self_dm: false, vault: false, group: false },
      destinations: [hub, me],
      vaultDir,
      render: { scopeName: 'Team', tz: 'UTC' },
      nowTs: 1_756_990_200,
    });
    expect(outcomes).toEqual([
      { channel: 'to', name: 'hub', outcome: 'queued', target: hub.jid },
      { channel: 'to', name: 'me', outcome: 'queued', target: me.jid },
    ]);
    const rows = store.queuedDeliveries('owner');
    expect(rows.map((r) => [r.channel, r.target])).toEqual([
      ['to:hub', hub.jid],
      ['to:me', me.jid],
    ]);
    expect(rows[0]?.text).toContain('🤖 Digest: Team');
    expect(rows[0]?.text).toContain('Automated digest of "Team"');
  });

  it('does not requeue a destination that is already queued or sent', () => {
    const args = {
      store,
      summary,
      deliver: { self_dm: false, vault: false, group: false },
      destinations: [hub],
      vaultDir,
      render: { scopeName: 'Team', tz: 'UTC' },
      nowTs: 1_756_990_200,
    };
    deliverSummary(args);
    expect(deliverSummary(args)).toEqual([
      { channel: 'to', name: 'hub', outcome: 'already', status: 'queued' },
    ]);
    store.markDeliverySent('owner', 'abc', 'to:hub', hub.jid, 1_756_990_300);
    expect(deliverSummary(args)).toEqual([
      { channel: 'to', name: 'hub', outcome: 'already', status: 'sent' },
    ]);
    expect(deliverSummary({ ...args, force: true })).toEqual([
      { channel: 'to', name: 'hub', outcome: 'queued', target: hub.jid },
    ]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/delivery/deliver.test.ts`
Expected: FAIL (type error on `destinations`, outcomes mismatch).

- [ ] **Step 3: Extend `src/delivery/types.ts`**

Append to the `DeliveryOutcome` union:

```ts
  | { channel: 'to'; name: string; outcome: 'queued'; target: string }
  | { channel: 'to'; name: string; outcome: 'already'; status: 'queued' | 'sent' }
  | { channel: 'to'; name: string; outcome: 'skipped'; reason: string };
```

- [ ] **Step 4: Extend `src/delivery/deliver.ts`**

Change the imports and `DeliverArgs`:

```ts
import type { ResolvedDestination } from '../config/index.js';
import { createLogger } from '../shared/index.js';
import { destinationChannel, type Store, type SummaryRecord } from '../store/index.js';
import {
  type RenderContext,
  renderDestinationText,
  renderGroupPostText,
  renderVaultMarkdown,
  renderWhatsAppText,
  vaultRelativePath,
} from './render.js';
```

```ts
export interface DeliverArgs {
  store: Store;
  summary: SummaryRecord;
  deliver: { self_dm: boolean; vault: boolean; group: boolean };
  /**
   * Outward targets, already filtered by the trigger gate. Each gets its own
   * `to:<name>` row; the outbox re-checks the name against config at send time.
   */
  destinations?: ResolvedDestination[];
  vaultDir: string;
  render: RenderContext;
  nowTs: number;
  /** Redo every channel even if already delivered (used by `--fresh`). */
  force?: boolean;
}
```

Append before `return outcomes;`:

```ts
  for (const dest of args.destinations ?? []) {
    const channel = destinationChannel(dest.name);
    const existing = force ? undefined : store.getDelivery(tenantId, summaryId, channel);
    if (existing && existing.status !== 'failed') {
      outcomes.push({ channel: 'to', name: dest.name, outcome: 'already', status: existing.status });
      continue;
    }
    store.putDelivery({
      tenantId,
      summaryId,
      channel,
      status: 'queued',
      target: dest.jid,
      text: renderDestinationText(summary, render),
      createdTs: nowTs,
    });
    log.info({ summaryId, destination: dest.name, target: dest.jid }, 'queued destination send');
    outcomes.push({ channel: 'to', name: dest.name, outcome: 'queued', target: dest.jid });
  }
```

(Destructure `destinations` is not needed; `args.destinations` is fine.)

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm vitest run src/delivery && pnpm typecheck && pnpm lint`
Expected: PASS. `src/cli/index.ts` `formatOutcome` will fail typecheck because the switch is not exhaustive; add a temporary case now:

```ts
    case 'to':
      if (o.outcome === 'queued')
        return `to ${o.name}: queued for ${o.target} — the listener (\`digest run\`) sends it`;
      if (o.outcome === 'already')
        return o.status === 'sent' ? `to ${o.name}: already sent` : `to ${o.name}: already queued`;
      return `to ${o.name}: skipped — ${o.reason}`;
```

- [ ] **Step 6: Commit**

```bash
git add src/delivery src/cli/index.ts
git commit -m "feat(delivery): fan a summary out to named destinations"
```

---

### Task 7: Outbox: send-time destination gate and per-target gap

**Files:**
- Modify: `src/delivery/outbox.ts`
- Test: `src/delivery/outbox.test.ts`

**Interfaces:**
- Consumes: `destinationName` (Task 4), `Store.getSummary`, `Store.lastSentToTarget`.
- Produces: `OutboxOptions.isDestinationAllowed?: (scopeKey: string, name: string, target: string) => boolean` (default: never).

- [ ] **Step 1: Write the failing tests**

In `src/delivery/outbox.test.ts`, extend the `queue` helper's channel type to `string` cast and add a summary fixture and a `start` option:

```ts
  const HUB = '120363000000000009@g.us';
  const ME = '13105551234@s.whatsapp.net';

  const storeSummary = (id: string, scope = G) =>
    store.upsertSummary({
      tenantId: 'owner',
      id,
      groupJid: scope,
      sinceTs: 0,
      untilTs: 10,
      watermarkTs: 10,
      watermarkId: 'M',
      messageCount: 1,
      adapter: 'fake',
      model: null,
      text: 'x',
      createdTs: 10,
    });

  const queueTo = (id: string, name: string, target: string) =>
    store.putDelivery({
      tenantId: 'owner',
      summaryId: id,
      channel: `to:${name}`,
      status: 'queued',
      text: `msg ${id}`,
      target,
      createdTs: Math.floor(clock / 1000),
    });
```

Change `start` to accept an `allowDestination` callback:

```ts
  const start = (
    transport: Transport,
    maxSendsPerDay = 30,
    allowGroup = false,
    allowDestination: (scope: string, name: string, target: string) => boolean = () => false,
  ) => {
    handle = startOutbox({
      tenantId: 'owner',
      store,
      transport,
      maxSendsPerDay,
      isGroupPostAllowed: () => allowGroup,
      isDestinationAllowed: allowDestination,
      minGroupPostGapMs: 3_600_000,
      pollMs: 1_000_000,
      jitterMs: [2000, 5000],
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      random: () => 0.5,
    });
    return handle;
  };
```

Add tests:

```ts
  describe('destinations', () => {
    it('sends a destination row to a number when config still allows it', async () => {
      const t = fakeTransport();
      storeSummary('s1');
      queueTo('s1', 'me', ME);
      const h = start(t, 30, false, (scope, name, target) =>
        scope === G && name === 'me' && target === ME,
      );
      expect(await h.drainOnce()).toEqual({ kind: 'sent', summaryId: 's1', channel: 'to:me' });
      expect(t.sent).toEqual([{ jid: ME, text: 'msg s1' }]);
      expect(store.getDelivery('owner', 's1', 'to:me')?.status).toBe('sent');
    });

    it('drops a destination row the config no longer allows', async () => {
      const t = fakeTransport();
      storeSummary('s1');
      queueTo('s1', 'hub', HUB);
      const h = start(t, 30, false, () => false);
      expect(await h.drainOnce()).toMatchObject({ kind: 'failed', channel: 'to:hub', permanent: true });
      expect(t.sent).toEqual([]);
      expect(store.getDelivery('owner', 's1', 'to:hub')?.error).toContain('not allowed');
    });

    it('drops a destination row whose summary is gone', async () => {
      const t = fakeTransport();
      queueTo('orphan', 'hub', HUB);
      const h = start(t, 30, false, () => true);
      expect(await h.drainOnce()).toMatchObject({ kind: 'failed', permanent: true });
      expect(store.getDelivery('owner', 'orphan', 'to:hub')?.error).toContain('summary');
    });

    it('drops a destination row whose target is not a WhatsApp JID', async () => {
      const t = fakeTransport();
      storeSummary('s1');
      queueTo('s1', 'hub', 'not-a-jid');
      const h = start(t, 30, false, () => true);
      expect(await h.drainOnce()).toMatchObject({ kind: 'failed', permanent: true });
      expect(t.sent).toEqual([]);
    });

    it('spaces two outward sends to the same target and lets a self-DM through', async () => {
      const t = fakeTransport();
      storeSummary('s1');
      storeSummary('s2');
      queueTo('s1', 'hub', HUB);
      queueTo('s2', 'hub', HUB);
      queue('s3');
      const h = start(t, 30, false, () => true);
      expect(await h.drainOnce()).toEqual({ kind: 'sent', summaryId: 's1', channel: 'to:hub' });
      expect(await h.drainOnce()).toEqual({ kind: 'sent', summaryId: 's3', channel: 'self_dm' });
      expect(await h.drainOnce()).toEqual({ kind: 'held', count: 1 });
      clock += 3_600_000;
      expect(await h.drainOnce()).toEqual({ kind: 'sent', summaryId: 's2', channel: 'to:hub' });
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/delivery/outbox.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/delivery/outbox.ts`**

Imports:

```ts
import { createLogger } from '../shared/index.js';
import { type DeliveryRow, destinationName, type Store } from '../store/index.js';
import { isGroupJid } from './deliver.js';
import type { Transport } from './types.js';

/** A group or a user JID; the only two things a destination may resolve to. */
const OUTWARD_TARGET_RE = /^\d+@(g\.us|s\.whatsapp\.net)$/;
```

Add to `OutboxOptions` after `isGroupPostAllowed`:

```ts
  /**
   * Send-time check that `scopeKey` (a group JID or `recap:<name>`) still
   * lists destination `name` and that `name` still resolves to `target`.
   * Defaults to "never", so an outbox without it drops every destination row.
   */
  isDestinationAllowed?: (scopeKey: string, name: string, target: string) => boolean;
```

Destructure `isDestinationAllowed = () => false,` in `startOutbox`.

Update `resolveTarget`:

```ts
  function resolveTarget(row: DeliveryRow): string | undefined {
    if (row.channel === 'self_dm') return transport.selfJid();
    if (row.channel === 'group' || destinationName(row.channel) !== undefined) {
      return row.target ?? undefined;
    }
    return undefined;
  }
```

Update `rejectReason`:

```ts
  function rejectReason(row: DeliveryRow): string | undefined {
    if (row.channel === 'vault' || !row.text) return 'not an outbox channel';
    if (row.channel === 'group') {
      if (!row.target || !isGroupJid(row.target)) return 'group target is not a group JID';
      if (!isGroupPostAllowed(row.target)) return `group posting not enabled for ${row.target}`;
    }
    const name = destinationName(row.channel);
    if (name !== undefined) {
      if (!row.target || !OUTWARD_TARGET_RE.test(row.target)) {
        return `destination ${name} target is not a WhatsApp JID`;
      }
      const summary = store.getSummary(tenantId, row.summaryId);
      if (!summary) return `summary ${row.summaryId} not found for destination ${name}`;
      if (!isDestinationAllowed(summary.groupJid, name, row.target)) {
        return `destination ${name} not allowed for ${summary.groupJid} (config changed?)`;
      }
    }
    return undefined;
  }
```

Update `heldUntil` so it covers every outward row:

```ts
  function heldUntil(row: DeliveryRow, nowS: number): number | undefined {
    const outward = row.channel === 'group' || destinationName(row.channel) !== undefined;
    if (!outward || !row.target || minGroupPostGapMs <= 0) return undefined;
    const last = store.lastSentToTarget(tenantId, row.target);
    if (last === undefined) return undefined;
    const until = last + Math.ceil(minGroupPostGapMs / 1000);
    return until > nowS ? until : undefined;
  }
```

Update the doc comment on `startOutbox` to say "Group and destination rows are the channels that can reach other people".

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm vitest run src/delivery && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/delivery
git commit -m "feat(outbox): gate destination rows at send time; per-target gap for all outward rows"
```

---

### Task 8: Sectioned transcript in the summarizer

**Files:**
- Modify: `src/summarizer/types.ts`
- Modify: `src/summarizer/prompt.ts`
- Modify: `src/summarizer/fake.ts`
- Modify: `src/summarizer/index.ts`
- Test: `src/summarizer/prompt.test.ts`, `src/summarizer/fake.test.ts`

**Interfaces:**
- Produces: `interface SummarySection { groupJid: string; groupName: string; messages: MessageRow[] }`; `SummaryInput.sections?: SummarySection[]`.

- [ ] **Step 1: Write the failing prompt tests**

Append to `src/summarizer/prompt.test.ts` (reuse the file's `row` and `input` helpers):

```ts
describe('buildPrompt with sections (recap)', () => {
  const a = [row({ id: 'A1', body: 'party saturday', ts: 1_756_890_000 })];
  const b = [
    row({ id: 'B1', body: 'which shoes', ts: 1_756_893_600, senderName: 'Bob' }),
    row({ id: 'B2', body: 'suede', ts: 1_756_893_700 }),
  ];
  const recap = input([...a, ...b], {
    groupJid: 'recap:Zouk',
    groupName: 'Zouk',
    sections: [
      { groupJid: 'a@g.us', groupName: 'Announcements', messages: a },
      { groupJid: 'b@g.us', groupName: 'Nerds', messages: b },
    ],
  });

  it('names the recap and lists groups with counts', () => {
    const { user } = buildPrompt(recap);
    expect(user).toContain('Recap: Zouk');
    expect(user).toContain('Groups: Announcements (1), Nerds (2)');
    expect(user).toContain('3 messages');
  });

  it('renders one transcript block per group in order', () => {
    const { user } = buildPrompt(recap);
    const first = user.indexOf('=== Announcements (1 message) ===');
    const second = user.indexOf('=== Nerds (2 messages) ===');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(user.slice(first, second)).toContain('party saturday');
    expect(user.slice(second)).toContain('which shoes');
  });

  it('adds the multi-group rule to the system prompt', () => {
    expect(buildPrompt(recap).system).toContain('several groups of one community');
    expect(buildPrompt(input(a)).system).not.toContain('several groups');
  });
});
```

Append to `src/summarizer/fake.test.ts` (reuse its way of building a `SummaryInput`; if it has none, build one with the same shape as `prompt.test.ts`'s `input` helper):

```ts
  it('names the sections when summarizing a recap', async () => {
    const rows = loadFixtureTranscript('a@g.us').slice(0, 4);
    const result = await createFakeSummarizer().summarize({
      tenantId: 'owner',
      groupJid: 'recap:Zouk',
      groupName: 'Zouk',
      messages: rows,
      sections: [
        { groupJid: 'a@g.us', groupName: 'Announcements', messages: rows.slice(0, 2) },
        { groupJid: 'b@g.us', groupName: 'Nerds', messages: rows.slice(2) },
      ],
      sinceTs: rows[0]?.ts ?? 0,
      untilTs: (rows[3]?.ts ?? 0) + 1,
      tz: 'UTC',
      options: { language: 'en', style: 'topics', max_words: 300, personality: 'neutral', instructions: '' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toContain('2 groups: Announcements, Nerds');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/summarizer/prompt.test.ts src/summarizer/fake.test.ts`
Expected: FAIL (type error on `sections`, missing strings).

- [ ] **Step 3: Extend `src/summarizer/types.ts`**

```ts
/** One source group's slice of a recap transcript. */
export interface SummarySection {
  groupJid: string;
  groupName: string;
  /** Non-deleted messages in the window, oldest first. */
  messages: MessageRow[];
}
```

Add to `SummaryInput` after `messages`:

```ts
  /**
   * Set for a recap: `messages` is every section flattened, and the prompt
   * renders one transcript block per section in this order.
   */
  sections?: SummarySection[];
```

Export `type SummarySection` from `src/summarizer/index.ts`.

- [ ] **Step 4: Extend `src/summarizer/prompt.ts`**

In `buildSystemPrompt`, after the `LANGUAGE_INSTRUCTIONS` line push:

```ts
  if (input.sections && input.sections.length > 0) {
    lines.push(
      '- The transcript covers several groups of one community, one block per group. Write a single recap: a short section per group in the given order (plain-text heading line with the group name, then bullets), skip a group with nothing of substance, and name the group when a topic spans several.',
    );
  }
```

Replace `buildUserPrompt` and `buildPrompt`:

```ts
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
    return [`Recap: ${input.groupName}`, `Groups: ${groups}`, window, '', 'Transcript:', transcript].join(
      '\n',
    );
  }
  return [`Group: ${input.groupName}`, window, '', 'Transcript:', transcript].join('\n');
}

/** One block per section, each headed by the group name and its message count. */
export function formatSectionedTranscript(sections: SummarySection[], tz: string): string {
  return sections
    .map((s) => `=== ${s.groupName} (${count(s.messages.length)}) ===\n${formatTranscript(s.messages, tz)}`)
    .join('\n\n');
}

export function buildPrompt(input: SummaryInput): Prompt {
  const transcript =
    input.sections && input.sections.length > 0
      ? formatSectionedTranscript(input.sections, input.tz)
      : formatTranscript(input.messages, input.tz);
  return { system: buildSystemPrompt(input), user: buildUserPrompt(input, transcript) };
}
```

Import `SummarySection` from `./types.js`. Export `formatSectionedTranscript` from `src/summarizer/index.ts`.

Note: the existing test that checks `Window: … , 3 messages` may have asserted the old wording `, 3 messages` — the new `count()` output is identical for plural; for a single message it now reads `1 message`. Fix any test that asserted `1 messages`.

- [ ] **Step 5: Extend `src/summarizer/fake.ts`**

In `summarize`, change the first text line:

```ts
      const sectionNote = input.sections?.length
        ? ` · ${input.sections.length} groups: ${input.sections.map((s) => s.groupName).join(', ')}`
        : '';
      const text = [
        `[fake summary · ${input.options.style} · ${input.options.language}${sectionNote}]`,
```

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `pnpm vitest run src/summarizer && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/summarizer
git commit -m "feat(summarizer): sectioned transcript and recap rule for multi-group input"
```

---

### Task 9: Digest runner: `postOutward` and destinations

**Files:**
- Create: `src/scheduler/run-shared.ts`
- Modify: `src/scheduler/run-digest.ts`
- Modify: `src/scheduler/index.ts`
- Modify: `src/cli/index.ts` (the `postToGroup` call site and `--post` help)
- Test: `src/scheduler/run-digest.test.ts`

**Interfaces:**
- Consumes: `resolveScopeDestinations` (Task 2), `DeliverArgs.destinations` (Task 6).
- Produces: `summarizerFor(config: Config, adapterName: string, factory?: DigestRequest['summarizerFactory']): Result<Summarizer, UnknownAdapterError>` in `run-shared.ts`; `DigestRequest.postOutward?: boolean` (replaces `postToGroup`).

- [ ] **Step 1: Write the failing tests**

Append to `src/scheduler/run-digest.test.ts`:

```ts
describe('runDigest destinations', () => {
  const HUB = '120363000000000009@g.us';
  const withDest = {
    destinations: { hub: { group: HUB }, me: { number: '+13105551234' } },
    groups: [{ jid: G1, name: 'Team', deliver: { to: ['hub', 'me'] } }],
  };

  it('queues destination rows on a scheduled run', async () => {
    const { config, store, base } = setup(withDest);
    const { resolveGroupConfig } = await import('../config/index.js');
    const group = resolveGroupConfig(config, G1);
    if (!group) throw new Error('group missing');
    const result = await runDigest({ ...base, group, dryRun: false, trigger: 'daily' });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'ok') throw new Error('unexpected');
    expect(result.value.outcomes).toContainEqual({
      channel: 'to',
      name: 'hub',
      outcome: 'queued',
      target: HUB,
    });
    expect(result.value.outcomes).toContainEqual({
      channel: 'to',
      name: 'me',
      outcome: 'queued',
      target: '13105551234@s.whatsapp.net',
    });
    expect(store.queuedDeliveries('owner').map((r) => r.channel).sort()).toEqual([
      'self_dm',
      'to:hub',
      'to:me',
    ]);
  });

  it('keeps an on-demand run private unless postOutward is set', async () => {
    const { config, store, base } = setup(withDest);
    const { resolveGroupConfig } = await import('../config/index.js');
    const group = resolveGroupConfig(config, G1);
    if (!group) throw new Error('group missing');
    const quiet = await runDigest({ ...base, group, dryRun: false, trigger: 'manual' });
    if (!quiet.ok || quiet.value.kind !== 'ok') throw new Error('unexpected');
    expect(quiet.value.outcomes.filter((o) => o.channel === 'to')).toEqual([
      { channel: 'to', name: 'hub', outcome: 'skipped', reason: expect.stringContaining('--post') },
      { channel: 'to', name: 'me', outcome: 'skipped', reason: expect.stringContaining('--post') },
    ]);
    expect(store.queuedDeliveries('owner').map((r) => r.channel)).toEqual(['self_dm']);

    const posted = await runDigest({ ...base, group, dryRun: false, trigger: 'manual', postOutward: true });
    if (!posted.ok || posted.value.kind !== 'ok') throw new Error('unexpected');
    expect(store.queuedDeliveries('owner').map((r) => r.channel).sort()).toEqual([
      'self_dm',
      'to:hub',
      'to:me',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/scheduler/run-digest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/scheduler/run-shared.ts`**

```ts
import type { Config } from '../config/index.js';
import type { Result } from '../shared/index.js';
import {
  createSummarizer,
  type Summarizer,
  type UnknownAdapterError,
} from '../summarizer/index.js';

export type SummarizerFactory = (
  name: string,
  opts: Parameters<typeof createSummarizer>[1],
) => Result<Summarizer, UnknownAdapterError>;

/** Build the adapter named `adapterName` with its `summarizers.<name>` options. */
export function summarizerFor(
  config: Config,
  adapterName: string,
  factory: SummarizerFactory = createSummarizer,
): Result<Summarizer, UnknownAdapterError> {
  const adapterCfg = config.summarizers[adapterName] ?? {};
  return factory(adapterName, {
    bin: adapterCfg.bin,
    model: adapterCfg.model,
    timeoutMs: adapterCfg.timeout_seconds ? adapterCfg.timeout_seconds * 1000 : undefined,
  });
}
```

- [ ] **Step 4: Modify `src/scheduler/run-digest.ts`**

Replace the `postToGroup` field in `DigestRequest`:

```ts
  /**
   * Deliver outward (post into the group when it has `deliver.group: true`,
   * and send to its `deliver.to` destinations). Defaults to true for
   * scheduled triggers and false for on-demand ones (`manual`, `command`),
   * so a quick check from the CLI or the self-chat stays private unless the
   * caller asks otherwise (`digest summarize --post`).
   */
  postOutward?: boolean;
```

Replace the `summarizerFactory` field's type with `summarizerFactory?: SummarizerFactory;` and import `type SummarizerFactory, summarizerFor` from `./run-shared.js`. Replace the adapter construction block:

```ts
  const adapterName = req.adapter ?? group.summarizer;
  const summarizer = summarizerFor(config, adapterName, req.summarizerFactory);
  if (!summarizer.ok) return err(summarizer.error);
```

Import `resolveScopeDestinations` from `../config/index.js`. Replace the delivery block at the end:

```ts
  const outward = req.postOutward ?? isScheduledTrigger(trigger);
  const destinations = resolveScopeDestinations(config, group.jid);
  const outcomes = deliverSummary({
    store,
    summary,
    deliver: {
      vault: group.deliver.vault,
      self_dm: group.deliver.self_dm || Boolean(req.forceSelfDm),
      group: group.deliver.group && outward,
    },
    destinations: outward ? destinations : [],
    vaultDir,
    render: { scopeName: groupName, tz },
    nowTs: Math.floor(now() / 1000),
    force: Boolean(req.fresh),
  });
  if (!outward) {
    const reason = 'on-demand runs stay private; scheduled runs deliver outward, or pass --post';
    if (group.deliver.group) outcomes.push({ channel: 'group', outcome: 'skipped', reason });
    for (const d of destinations) {
      outcomes.push({ channel: 'to', name: d.name, outcome: 'skipped', reason });
    }
  }
  return ok({ kind: 'ok', summary, reused, stats, outcomes });
```

Remove the now-unused `createSummarizer`, `Summarizer`, `UnknownAdapterError` imports if nothing else in the file uses them (keep `Summarizer` if the `DigestRequest` type still references it).

- [ ] **Step 5: Rename the call site**

Run `grep -rn "postToGroup" src`. In `src/cli/index.ts` change `postToGroup: Boolean(opts.post)` to `postOutward: Boolean(opts.post)` and change the `--post` option description to `'also deliver outward: post into the group (if deliver.group: true) and send to its deliver.to destinations'`. Fix any test that passes `postToGroup`.

Export `type SummarizerFactory`, `summarizerFor` from `src/scheduler/index.ts`.

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. The existing "on-demand runs stay private" wording changed; update any test asserting the old reason text.

- [ ] **Step 7: Commit**

```bash
git add src/scheduler src/cli/index.ts
git commit -m "feat(digest): deliver to destinations behind the same outward gate as group posts"
```

---

### Task 10: Recap runner

**Files:**
- Create: `src/scheduler/run-recap.ts`
- Modify: `src/scheduler/index.ts`
- Test: `src/scheduler/run-recap.test.ts`

**Interfaces:**
- Consumes: `ResolvedRecapConfig`, `resolveScopeDestinations` (Task 2); `Store.recapWatermarks`, `Store.recordRecapRun` (Task 3); `deliverSummary` with `destinations` (Task 6); `SummarySection` (Task 8); `summarizerFor`, `SummarizerFactory` (Task 9); `DigestResult`, `DigestError`, `describeSummarizerError`, `isScheduledTrigger` from `run-digest.ts`; `defaultLookbackS` from `cadence.ts`.
- Produces:

```ts
export interface RecapRequest {
  tenantId: string; store: Store; config: Config; recap: ResolvedRecapConfig;
  untilTs: number; trigger: RunTrigger; tz: string; vaultDir: string;
  /** Explicit window start for every source (`--since`); otherwise each source's own watermark. */
  sinceTs?: number;
  dryRun?: boolean; fresh?: boolean; adapter?: string; summaryOptions?: Partial<SummaryOptions>;
  forceSelfDm?: boolean; postOutward?: boolean; now?: () => number; summarizerFactory?: SummarizerFactory;
}
export function recapSummaryId(tenantId: string, key: string, sections: SummarySection[]): string;
export async function runRecap(req: RecapRequest): Promise<Result<DigestResult, DigestError>>;
```

- [ ] **Step 1: Write the failing tests**

`src/scheduler/run-recap.test.ts`:

```ts
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema, resolveRecapConfig } from '../config/index.js';
import { ok } from '../shared/index.js';
import { Store } from '../store/index.js';
import { loadFixtureTranscript } from '../summarizer/fixtures.js';
import type { Summarizer, SummaryInput } from '../summarizer/index.js';
import { runRecap } from './run-recap.js';

const A = '120363000000000001@g.us';
const B = '120363000000000002@g.us';
const HUB = '120363000000000009@g.us';

function setup(extra: Record<string, unknown> = {}) {
  const store = new Store(':memory:');
  const a = loadFixtureTranscript(A).slice(0, 6);
  const b = loadFixtureTranscript(B).slice(6, 10);
  for (const g of [A, B]) store.upsertGroup({ tenantId: 'owner', jid: g, subject: g, seenTs: 1 });
  for (const r of [...a, ...b]) store.insertMessage(r);
  const lastTs = Math.max(...[...a, ...b].map((r) => r.ts));
  const config = configSchema.parse({
    defaults: { summarizer: 'fake', cadence: { type: 'daily', at: '08:00' } },
    destinations: { hub: { group: HUB } },
    groups: [
      { jid: A, name: 'Announcements' },
      { jid: B, name: 'Nerds' },
    ],
    recaps: [{ name: 'Zouk', sources: ['Announcements', 'Nerds'], deliver: { to: ['hub'] } }],
    ...extra,
  });
  const recap = resolveRecapConfig(config, 'Zouk');
  if (!recap) throw new Error('recap missing');
  const seen: SummaryInput[] = [];
  const capturing: Summarizer = {
    name: 'fake',
    async summarize(input) {
      seen.push(input);
      return ok({
        text: 'recap text',
        adapter: 'fake',
        model: null,
        messageCount: input.messages.length,
        inputChars: 1,
        durationMs: 1,
        costUsd: 0,
      });
    },
    async complete() {
      return ok({ text: 'x', model: null, durationMs: 1, costUsd: 0 });
    },
  };
  const vaultDir = mkdtempSync(join(tmpdir(), 'vault-'));
  const base = {
    tenantId: 'owner',
    store,
    config,
    recap,
    untilTs: lastTs + 1,
    trigger: 'weekly' as const,
    tz: 'UTC',
    vaultDir,
    summarizerFactory: () => ok(capturing),
  };
  return { store, config, recap, seen, base, a, b, vaultDir };
}

describe('runRecap', () => {
  it('summarizes every source in one call, sectioned in config order', async () => {
    const { seen, base, a, b } = setup();
    const result = await runRecap(base);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'ok') throw new Error('unexpected');
    expect(seen).toHaveLength(1);
    const input = seen[0];
    expect(input?.groupJid).toBe('recap:Zouk');
    expect(input?.groupName).toBe('Zouk');
    expect(input?.sections?.map((s) => [s.groupName, s.messages.length])).toEqual([
      ['Announcements', a.length],
      ['Nerds', b.length],
    ]);
    expect(input?.messages).toHaveLength(a.length + b.length);
    const ts = input?.messages.map((m) => m.ts) ?? [];
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);
    expect(result.value.summary.groupJid).toBe('recap:Zouk');
    expect(result.value.summary.messageCount).toBe(a.length + b.length);
  });

  it('records a run under the recap key and one watermark per source', async () => {
    const { store, base, a, b } = setup();
    await runRecap(base);
    const runs = store.recentRuns('owner', 'recap:Zouk', 0);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('ok');
    const wm = store.recapWatermarks('owner', 'Zouk');
    expect(wm.get(A)?.watermarkId).toBe(a[a.length - 1]?.id);
    expect(wm.get(B)?.watermarkId).toBe(b[b.length - 1]?.id);
    expect(store.lastWatermark('owner', A)).toBeUndefined();
  });

  it('reads each source from its own watermark and skips empty sources', async () => {
    const { store, base, seen, b } = setup();
    await runRecap(base);
    // Only B gets new messages after the first recap.
    const extra = loadFixtureTranscript(B).slice(10, 12).map((r, i) => ({ ...r, ts: base.untilTs + 10 + i }));
    for (const r of extra) store.insertMessage(r);
    const second = await runRecap({ ...base, untilTs: base.untilTs + 100 });
    if (!second.ok || second.value.kind !== 'ok') throw new Error('unexpected');
    expect(second.value.reused).toBe(false);
    expect(seen[1]?.sections?.map((s) => s.groupName)).toEqual(['Nerds']);
    expect(seen[1]?.messages).toHaveLength(2);
    expect(store.recapWatermarks('owner', 'Zouk').get(B)?.watermarkId).toBe(extra[1]?.id);
    expect(store.recapWatermarks('owner', 'Zouk').get(A)?.watermarkId).toBe(
      loadFixtureTranscript(A).slice(0, 6).at(-1)?.id,
    );
    expect(b.length).toBeGreaterThan(0);
  });

  it('returns empty when no source has messages', async () => {
    const { base } = setup();
    const result = await runRecap({ ...base, sinceTs: base.untilTs + 1 });
    expect(result).toEqual({ ok: true, value: { kind: 'empty' } });
  });

  it('reuses the stored summary for the same messages', async () => {
    const { base, seen } = setup();
    await runRecap({ ...base, sinceTs: 0 });
    const again = await runRecap({ ...base, sinceTs: 0 });
    if (!again.ok || again.value.kind !== 'ok') throw new Error('unexpected');
    expect(again.value.reused).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('delivers outward on a scheduled run and privately on demand', async () => {
    const { store, base } = setup();
    const scheduled = await runRecap(base);
    if (!scheduled.ok || scheduled.value.kind !== 'ok') throw new Error('unexpected');
    expect(scheduled.value.outcomes).toContainEqual({
      channel: 'to',
      name: 'hub',
      outcome: 'queued',
      target: HUB,
    });
    expect(store.queuedDeliveries('owner').map((r) => r.channel).sort()).toEqual(['self_dm', 'to:hub']);

    const fresh = setup();
    const manual = await runRecap({ ...fresh.base, trigger: 'manual' });
    if (!manual.ok || manual.value.kind !== 'ok') throw new Error('unexpected');
    expect(manual.value.outcomes).toContainEqual({
      channel: 'to',
      name: 'hub',
      outcome: 'skipped',
      reason: expect.stringContaining('--post'),
    });
    expect(fresh.store.queuedDeliveries('owner').map((r) => r.channel)).toEqual(['self_dm']);
  });

  it('writes the vault note under the recap slug with sources in the front matter', async () => {
    const { base, vaultDir } = setup();
    await runRecap(base);
    const files = readdirSync(join(vaultDir, 'zouk'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(vaultDir, 'zouk', files[0] ?? ''), 'utf8');
    expect(md).toContain('recap: "Zouk"');
    expect(md).toContain(`jid: "${A}"`);
  });

  it('dry run stores the summary but moves no watermark', async () => {
    const { store, base } = setup();
    const result = await runRecap({ ...base, dryRun: true });
    if (!result.ok || result.value.kind !== 'ok') throw new Error('unexpected');
    expect(store.getSummary('owner', result.value.summary.id)).toBeDefined();
    expect(store.recapWatermarks('owner', 'Zouk').size).toBe(0);
    expect(store.queuedDeliveries('owner')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/scheduler/run-recap.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create `src/scheduler/run-recap.ts`**

```ts
import { createHash, randomUUID } from 'node:crypto';
import {
  type Config,
  mergeSummary,
  personalityNames,
  type ResolvedRecapConfig,
  resolvePersonality,
  resolveScopeDestinations,
  type SummaryOptions,
} from '../config/index.js';
import { deliverSummary } from '../delivery/index.js';
import { createLogger, err, ok, type Result } from '../shared/index.js';
import type { MessageRow, RecapWatermark, RunTrigger, Store, SummaryRecord } from '../store/index.js';
import type { SummarySection } from '../summarizer/index.js';
import { defaultLookbackS } from './cadence.js';
import {
  type DigestError,
  type DigestResult,
  type DigestStats,
  describeSummarizerError,
  isScheduledTrigger,
} from './run-digest.js';
import { type SummarizerFactory, summarizerFor } from './run-shared.js';

export interface RecapRequest {
  tenantId: string;
  store: Store;
  config: Config;
  recap: ResolvedRecapConfig;
  untilTs: number;
  trigger: RunTrigger;
  tz: string;
  vaultDir: string;
  /** Explicit window start for every source (`--since`); otherwise each source's own watermark. */
  sinceTs?: number;
  dryRun?: boolean;
  /** Regenerate and re-deliver even if this message set was summarized before. */
  fresh?: boolean;
  adapter?: string;
  summaryOptions?: Partial<SummaryOptions>;
  /** Always send to the self-chat (used for `/digest` replies). */
  forceSelfDm?: boolean;
  /** Send to `deliver.to`. Defaults to true for scheduled triggers, false on demand. */
  postOutward?: boolean;
  now?: () => number;
  summarizerFactory?: SummarizerFactory;
}

/**
 * Stable id for a recap: the same set of messages across the same sources
 * maps to the same id, so a rerun reuses the stored text.
 */
export function recapSummaryId(tenantId: string, key: string, sections: SummarySection[]): string {
  const parts = [tenantId, key];
  for (const s of sections) {
    const first = s.messages[0];
    const last = s.messages[s.messages.length - 1];
    if (!first || !last) continue;
    parts.push(s.groupJid, String(first.ts), first.id, String(last.ts), last.id);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * The recap pipeline: read every source from its own watermark, summarize
 * the sectioned transcript once, record the run plus per-source watermarks,
 * deliver. Mirrors `runDigest`; the scope key is `recap.key`.
 */
export async function runRecap(req: RecapRequest): Promise<Result<DigestResult, DigestError>> {
  const { tenantId, store, config, recap, untilTs, trigger, tz, vaultDir } = req;
  const now = req.now ?? Date.now;
  const log = createLogger('recap', { tenant_id: tenantId });
  const dryRun = Boolean(req.dryRun);

  const watermarks = store.recapWatermarks(tenantId, recap.name);
  const sections: SummarySection[] = [];
  let sinceTs = untilTs;
  for (const source of recap.sources) {
    const wm = watermarks.get(source.jid);
    const since =
      req.sinceTs ?? (wm ? wm.watermarkTs + 1 : untilTs - defaultLookbackS(recap.cadence));
    const messages = store.messagesSince(tenantId, source.jid, since).filter((m) => m.ts <= untilTs);
    if (messages.length === 0) continue;
    sections.push({ groupJid: source.jid, groupName: source.name, messages });
    sinceTs = Math.min(sinceTs, since);
  }
  if (sections.length === 0) return ok({ kind: 'empty' });

  const messages: MessageRow[] = sections.flatMap((s) => s.messages).sort((a, b) => a.ts - b.ts);
  const newest = messages[messages.length - 1];
  if (!newest) return ok({ kind: 'empty' });

  const adapterName = req.adapter ?? recap.summarizer;
  const summarizer = summarizerFor(config, adapterName, req.summarizerFactory);
  if (!summarizer.ok) return err(summarizer.error);

  const sid = recapSummaryId(tenantId, recap.key, sections);
  let summary = req.fresh ? undefined : store.getSummary(tenantId, sid);
  let reused = true;
  let stats: DigestStats | undefined;

  if (summary) {
    log.info({ recap: recap.name, summaryId: sid, trigger }, 'reusing stored recap');
  } else {
    reused = false;
    const options: SummaryOptions = mergeSummary(recap.summary, req.summaryOptions);
    const personality = resolvePersonality(config, options.personality);
    if (personality === undefined) {
      return err({
        tag: 'unknown-personality',
        name: options.personality,
        available: personalityNames(config),
      });
    }
    log.info(
      {
        recap: recap.name,
        adapter: adapterName,
        sources: sections.map((s) => s.groupJid),
        messages: messages.length,
        trigger,
        dryRun,
      },
      'summarizing recap',
    );
    const result = await summarizer.value.summarize({
      tenantId,
      groupJid: recap.key,
      groupName: recap.name,
      messages,
      sections,
      sinceTs,
      untilTs,
      tz,
      options,
      personality,
    });
    const createdTs = Math.floor(now() / 1000);
    const runBase = {
      tenantId,
      id: randomUUID(),
      groupJid: recap.key,
      trigger,
      dryRun,
      sinceTs,
      untilTs,
      messageCount: messages.length,
      watermarkTs: newest.ts,
      watermarkId: newest.id,
      createdTs,
    };
    if (!result.ok) {
      store.recordRecapRun(
        {
          ...runBase,
          summaryId: null,
          adapter: adapterName,
          model: null,
          status: 'error',
          error: describeSummarizerError(result.error),
          costUsd: null,
          durationMs: null,
        },
        recap.name,
        [],
      );
      return err({ tag: 'summarize', error: result.error });
    }
    const s = result.value;
    summary = {
      tenantId,
      id: sid,
      groupJid: recap.key,
      sinceTs,
      untilTs,
      watermarkTs: newest.ts,
      watermarkId: newest.id,
      messageCount: messages.length,
      adapter: s.adapter,
      model: s.model,
      text: s.text,
      createdTs,
    } satisfies SummaryRecord;
    store.upsertSummary(summary);
    const advanced: RecapWatermark[] = dryRun
      ? []
      : sections.map((sec) => {
          const last = sec.messages[sec.messages.length - 1] as MessageRow;
          return { sourceJid: sec.groupJid, watermarkTs: last.ts, watermarkId: last.id };
        });
    store.recordRecapRun(
      {
        ...runBase,
        summaryId: sid,
        adapter: s.adapter,
        model: s.model,
        status: 'ok',
        error: null,
        costUsd: s.costUsd,
        durationMs: s.durationMs,
      },
      recap.name,
      advanced,
    );
    stats = {
      adapter: s.adapter,
      model: s.model,
      messages: s.messageCount,
      inputChars: s.inputChars,
      words: s.text.split(/\s+/).length,
      durationMs: s.durationMs,
      costUsd: s.costUsd,
    };
    log.info({ recap: recap.name, summaryId: sid, ...stats }, 'recap generated and recorded');
  }

  if (dryRun) return ok({ kind: 'ok', summary, reused, stats, outcomes: [] });

  const outward = req.postOutward ?? isScheduledTrigger(trigger);
  const destinations = resolveScopeDestinations(config, recap.key);
  const outcomes = deliverSummary({
    store,
    summary,
    deliver: {
      vault: recap.deliver.vault,
      self_dm: recap.deliver.self_dm || Boolean(req.forceSelfDm),
      group: false,
    },
    destinations: outward ? destinations : [],
    vaultDir,
    render: { scopeName: recap.name, tz, sources: recap.sources },
    nowTs: Math.floor(now() / 1000),
    force: Boolean(req.fresh),
  });
  if (!outward) {
    for (const d of destinations) {
      outcomes.push({
        channel: 'to',
        name: d.name,
        outcome: 'skipped',
        reason: 'on-demand runs stay private; scheduled runs deliver outward, or pass --post',
      });
    }
  }
  return ok({ kind: 'ok', summary, reused, stats, outcomes });
}
```

Export `type RecapRequest`, `recapSummaryId`, `runRecap` from `src/scheduler/index.ts`. `DigestStats` must be exported from `run-digest.ts` (it already is).

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm vitest run src/scheduler && pnpm typecheck && pnpm lint`
Expected: PASS. If the fixture transcript has fewer than 12 rows, lower the slice bounds in the test's `setup` (`a` = first 6, `b` = next 4, `extra` = two rows after that) to fit; the assertions only depend on counts derived from those arrays.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler
git commit -m "feat(recap): runRecap summarizes several sources into one digest with per-source watermarks"
```

---

### Task 11: Scheduler: recap ticks, `describe()` entries, `/digest <recap>`

**Files:**
- Modify: `src/scheduler/scheduler.ts`
- Modify: `src/scheduler/commands.ts` (`helpText`)
- Modify: `src/scheduler/index.ts`
- Modify: `src/dashboard/data.ts:20-27` (type of `describeSchedule`, minimal change so typecheck passes; Task 13 does the rest)
- Test: `src/scheduler/scheduler.test.ts`, `src/scheduler/commands.test.ts`

**Interfaces:**
- Consumes: `resolveRecapConfig`, `findRecapConfig`, `ResolvedRecapConfig` (Task 2); `runRecap` (Task 10).
- Produces:

```ts
export type ScheduleEntry =
  | { kind: 'group'; group: ResolvedGroupConfig; state: GroupScheduleState; decision: DueDecision }
  | { kind: 'recap'; recap: ResolvedRecapConfig; state: GroupScheduleState; decision: DueDecision };
export interface TickOutcome { scope: string; decision: DueDecision; result?: 'ok' | 'empty' | 'error' | 'reused' }
SchedulerHandle.describe(): ScheduleEntry[]
```

- [ ] **Step 1: Write the failing tests**

In `src/scheduler/scheduler.test.ts`, first rename every `o.groupJid` in existing assertions to `o.scope` (search `groupJid ===`). Then extend the config in `beforeEach` and add tests:

```ts
    config = configSchema.parse({
      defaults: { summarizer: 'fake', cadence: { type: 'daily', at: '08:00', tz: LA } },
      destinations: { hub: { group: '120363000000000009@g.us' } },
      groups: [
        { jid: G1, name: 'Team' },
        {
          jid: G2,
          name: 'Family',
          cadence: { type: 'threshold', messages: 10, max_hours: 24 },
          deliver: { self_dm: false },
        },
      ],
      recaps: [
        {
          name: 'Both',
          sources: ['Team', 'Family'],
          cadence: { type: 'daily', at: '09:00', tz: LA },
          deliver: { to: ['hub'] },
        },
      ],
    });
```

```ts
  describe('recaps', () => {
    it('runs a due recap over both sources and queues its destination', async () => {
      seed(store, G1, NOW - 600);
      seed(store, G2, NOW - 300, 5);
      const s = start();
      const outcomes = await s.tick();
      expect(outcomes.find((o) => o.scope === 'recap:Both')).toMatchObject({
        decision: { due: true },
        result: 'ok',
      });
      expect(store.recentRuns('owner', 'recap:Both', 0)).toHaveLength(1);
      expect(store.recapWatermarks('owner', 'Both').size).toBe(2);
      expect(store.queuedDeliveries('owner').some((r) => r.channel === 'to:hub')).toBe(true);
      const again = await s.tick();
      expect(again.find((o) => o.scope === 'recap:Both')?.decision.due).toBe(false);
    });

    it('records an empty run for a recap with no messages so it does not re-fire', async () => {
      // A source must have been seen, or the cadence reports "group not seen yet".
      store.upsertGroup({ tenantId: 'owner', jid: G1, subject: 'Team', seenTs: NOW - 3 * 86_400 });
      const s = start();
      await s.tick();
      const runs = store.recentRuns('owner', 'recap:Both', 0);
      expect(runs.map((r) => r.status)).toEqual(['empty']);
    });

    it('describes recaps next to groups', () => {
      const s = start();
      const entries = s.describe();
      expect(entries.map((e) => e.kind)).toEqual(['group', 'group', 'recap']);
      const recap = entries.find((e) => e.kind === 'recap');
      if (recap?.kind !== 'recap') throw new Error('no recap entry');
      expect(recap.recap.name).toBe('Both');
    });

    it('/digest <recap> runs the recap privately and replies only on failure or empty', async () => {
      seed(store, G1, NOW - 600);
      const s = start();
      await s.handleCommand('/digest both 2d');
      const queued = store.queuedDeliveries('owner');
      expect(queued.map((r) => r.channel)).toEqual(['self_dm']);
      expect(queued[0]?.text).toContain('🤖 Digest: Both');
      expect(store.recentRuns('owner', 'recap:Both', 0)[0]?.trigger).toBe('command');
    });
  });
```

Note: the recap in `describe` above relies on `firstSeenTs` for the "first occurrence" catch-up rule, which `seed` sets three days back; the recap therefore fires on the first tick.

In `src/scheduler/commands.test.ts`, add:

```ts
  it('lists recaps in the help text', () => {
    const config = configSchema.parse({
      groups: [{ jid: '1@g.us', name: 'Team' }],
      recaps: [{ name: 'Weekly', sources: ['Team'] }],
    });
    const text = helpText(config);
    expect(text).toContain('Recaps:');
    expect(text).toContain('- Weekly (Team)');
  });
```

(import `configSchema` from `../config/index.js` if not already).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/scheduler/scheduler.test.ts src/scheduler/commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/scheduler/scheduler.ts`**

Imports: add `findRecapConfig`, `type ResolvedRecapConfig`, `resolveRecapConfig` from `../config/index.js`, and `runRecap` from `./run-recap.js`.

Replace `TickOutcome` and add `ScheduleEntry`:

```ts
export interface TickOutcome {
  /** A group JID or `recap:<name>`. */
  scope: string;
  decision: DueDecision;
  result?: 'ok' | 'empty' | 'error' | 'reused';
}

export type ScheduleEntry =
  | { kind: 'group'; group: ResolvedGroupConfig; state: GroupScheduleState; decision: DueDecision }
  | { kind: 'recap'; recap: ResolvedRecapConfig; state: GroupScheduleState; decision: DueDecision };
```

Change `describe()` in `SchedulerHandle` to return `ScheduleEntry[]`.

Add after `groups()`:

```ts
  const recaps = (): ResolvedRecapConfig[] =>
    config.recaps
      .map((r) => resolveRecapConfig(config, r.name))
      .filter((r): r is ResolvedRecapConfig => r !== undefined);

  function stateForRecap(recap: ResolvedRecapConfig, nowTs: number): GroupScheduleState {
    const watermarks = store.recapWatermarks(tenantId, recap.name);
    const firstSeen = recap.sources
      .map((s) => store.getGroup(tenantId, s.jid)?.firstSeenTs)
      .filter((t): t is number => t !== undefined);
    const pending =
      recap.cadence.type === 'threshold'
        ? recap.sources.reduce((sum, s) => {
            const wm = watermarks.get(s.jid);
            return sum + store.countMessages(tenantId, s.jid, wm ? wm.watermarkTs + 1 : 0);
          }, 0)
        : 0;
    return {
      runs: store.recentRuns(tenantId, recap.key, nowTs - RUN_HORIZON_S),
      watermark: store.lastWatermark(tenantId, recap.key),
      firstSeenTs: firstSeen.length > 0 ? Math.min(...firstSeen) : undefined,
      pendingMessages: pending,
    };
  }

  async function runRecapScope(
    recap: ResolvedRecapConfig,
    trigger: DigestRequest['trigger'],
    extra: Partial<RecapRequest> = {},
  ): Promise<TickOutcome['result']> {
    const nowTs = Math.floor(now() / 1000);
    const recapTz = 'tz' in recap.cadence && recap.cadence.tz ? recap.cadence.tz : tz;
    const result = await runRecap({
      tenantId,
      store,
      config,
      recap,
      untilTs: nowTs,
      trigger,
      tz: recapTz,
      vaultDir,
      now,
      summarizerFactory: opts.summarizerFactory,
      ...extra,
    });
    if (!result.ok) {
      log.error({ recap: recap.name, trigger, error: result.error }, describeDigestError(result.error));
      return 'error';
    }
    if (result.value.kind === 'empty') return 'empty';
    return result.value.reused ? 'reused' : 'ok';
  }
```

Import `type RecapRequest` from `./run-recap.js`.

In `tick()`, change `const outcome: TickOutcome = { groupJid: group.jid, decision };` to `{ scope: group.jid, decision }`, and add after the groups loop (still inside `try`):

```ts
      for (const recap of recaps()) {
        if (stopped) break;
        const state = stateForRecap(recap, nowTs);
        const decision = decideDue(recap.cadence, state, nowTs, tz);
        const outcome: TickOutcome = { scope: recap.key, decision };
        if (decision.due) {
          log.info({ recap: recap.name, reason: decision.reason }, 'scheduled recap due');
          const trigger = recap.cadence.type === 'manual' ? 'manual' : recap.cadence.type;
          outcome.result = await runRecapScope(recap, trigger);
          if (outcome.result === 'empty') {
            store.insertRun({
              tenantId,
              id: randomUUID(),
              groupJid: recap.key,
              trigger,
              dryRun: false,
              sinceTs: nowTs - defaultLookbackS(recap.cadence),
              untilTs: nowTs,
              messageCount: 0,
              watermarkTs: null,
              watermarkId: null,
              summaryId: null,
              adapter: recap.summarizer,
              model: null,
              status: 'empty',
              error: null,
              costUsd: null,
              durationMs: null,
              createdTs: nowTs,
            });
          }
        }
        outcomes.push(outcome);
      }
```

Import `defaultLookbackS` from `./cadence.js`.

In `handleCommand`, replace the group lookup block:

```ts
    let targets = groups();
    let recapTarget: ResolvedRecapConfig | undefined;
    if (cmd.groupRef) {
      const g = findGroup(cmd.groupRef);
      if (g) targets = [g];
      else {
        recapTarget = findRecapConfig(config, cmd.groupRef);
        if (!recapTarget) {
          return queueReply(`🤖 Unknown group or recap "${cmd.groupRef}". Send /help to list them.`);
        }
        targets = [];
      }
    }
```

And after the `log.info(… 'owner command')` line, inside `withTyping`, before the `for (const group of targets)` loop:

```ts
      if (recapTarget) {
        if (opts.enrichment) {
          for (const src of recapTarget.sources) {
            await opts.enrichment.drain(src.jid, DRAIN_BEFORE_COMMAND_MS);
          }
        }
        const r = await runRecapScope(recapTarget, 'command', {
          sinceTs: since,
          forceSelfDm: true,
          adapter,
          summaryOptions,
        });
        if (r === 'empty') lines.push(`${recapTarget.name}: no new messages in any source`);
        else if (r === 'error') lines.push(`${recapTarget.name}: failed, see logs`);
      }
```

Replace `describe()`:

```ts
  function describe(): ScheduleEntry[] {
    const nowTs = Math.floor(now() / 1000);
    const groupEntries: ScheduleEntry[] = groups().map((group) => {
      const state = stateFor(group, nowTs);
      return { kind: 'group', group, state, decision: decideDue(group.cadence, state, nowTs, tz) };
    });
    const recapEntries: ScheduleEntry[] = recaps().map((recap) => {
      const state = stateForRecap(recap, nowTs);
      return { kind: 'recap', recap, state, decision: decideDue(recap.cadence, state, nowTs, tz) };
    });
    return [...groupEntries, ...recapEntries];
  }
```

- [ ] **Step 4: Update `helpText` in `src/scheduler/commands.ts`**

```ts
export function helpText(config: Config): string {
  const groups = config.groups.map((g) => `- ${g.name ?? g.jid}`).join('\n');
  const recaps = config.recaps.map((r) => `- ${r.name} (${r.sources.join(', ')})`).join('\n');
  return [
    '🤖 Commands (send here, in your own chat):',
    '/digest — summarize every group since its last digest',
    '/digest 3d — every group over the last 3 days',
    '/digest <group|recap> [12h|2d|1w] — one group, or one recap over all its sources',
    'Options after that, key=value or --flag value: style=topics|narrative|action-items lang=en|ru|auto words=<n> voice=<personality> via=<adapter> note="extra guidance"',
    '/ask <group> [12h|2d|1w] <question> — answer from stored messages',
    'Replies come here only; nothing is posted into a group or sent to a destination.',
    '',
    'Groups:',
    groups || '(none configured)',
    ...(recaps ? ['', 'Recaps:', recaps] : []),
  ].join('\n');
}
```

- [ ] **Step 5: Keep the dashboard and CLI compiling**

Export `type ScheduleEntry` from `src/scheduler/index.ts`. In `src/dashboard/data.ts` change the `describeSchedule` type to `() => ScheduleEntry[]` (import from `../scheduler/index.js`) and, in `groupsView`, change `src.describeSchedule().map(({ group, state, decision }) => {` to:

```ts
  return src
    .describeSchedule()
    .flatMap((e) => (e.kind === 'group' ? [e] : []))
    .map(({ group, state, decision }) => {
```

In `src/cli/index.ts` `schedule` command, change `for (const { group, state, decision } of scheduler.describe())` to iterate entries and skip recaps for now:

```ts
      for (const entry of scheduler.describe()) {
        if (entry.kind !== 'group') continue;
        const { group, state, decision } = entry;
```

(Task 12 replaces this with full output.)

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/scheduler src/dashboard/data.ts src/cli/index.ts
git commit -m "feat(scheduler): tick recaps, describe them, and run them from /digest"
```

---

### Task 12: CLI: destination gate wiring, `summarize <recap>`, `schedule`, outcome text

**Files:**
- Modify: `src/cli/index.ts`
- Test: `src/cli/format.test.ts` (new, for the pure helpers) — move `describeDeliver` and `formatOutcome` into `src/cli/format.ts` so they can be tested without commander.

**Interfaces:**
- Consumes: `resolveScopeDestinations`, `findRecapConfig`, `findGroupConfig` (Tasks 1–2); `runRecap` (Task 10); `ScheduleEntry` (Task 11).
- Produces: `src/cli/format.ts` exporting `describeDeliver(d: { self_dm: boolean; vault: boolean; group?: boolean; to: string[] }): string` and `formatOutcome(o: DeliveryOutcome): string`.

- [ ] **Step 1: Write the failing tests**

`src/cli/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { describeDeliver, formatOutcome } from './format.js';

describe('describeDeliver', () => {
  it('lists channels and destinations', () => {
    expect(describeDeliver({ self_dm: true, vault: true, group: false, to: [] })).toBe(
      'self-DM, vault',
    );
    expect(describeDeliver({ self_dm: false, vault: false, group: true, to: ['hub', 'me'] })).toBe(
      'GROUP POST, → hub, → me',
    );
    expect(describeDeliver({ self_dm: false, vault: false, to: [] })).toBe('nothing');
  });
});

describe('formatOutcome', () => {
  it('describes destination outcomes', () => {
    expect(formatOutcome({ channel: 'to', name: 'hub', outcome: 'queued', target: '9@g.us' })).toBe(
      'to hub:   queued for 9@g.us — the listener (`digest run`) sends it',
    );
    expect(formatOutcome({ channel: 'to', name: 'hub', outcome: 'already', status: 'sent' })).toBe(
      'to hub:   already sent',
    );
    expect(formatOutcome({ channel: 'to', name: 'hub', outcome: 'skipped', reason: 'private' })).toBe(
      'to hub:   skipped — private',
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/cli/format.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create `src/cli/format.ts`**

Move `formatOutcome` and `describeDeliver` out of `src/cli/index.ts` into this file:

```ts
import type { DeliveryOutcome } from '../delivery/index.js';

export function describeDeliver(d: {
  self_dm: boolean;
  vault: boolean;
  group?: boolean;
  to: string[];
}): string {
  const on = [
    d.self_dm && 'self-DM',
    d.vault && 'vault',
    d.group && 'GROUP POST',
    ...d.to.map((name) => `→ ${name}`),
  ].filter(Boolean);
  return on.length > 0 ? on.join(', ') : 'nothing';
}

export function formatOutcome(o: DeliveryOutcome): string {
  switch (o.channel) {
    case 'vault':
      if (o.outcome === 'written') return `vault:    wrote ${o.path}`;
      if (o.outcome === 'already')
        return `vault:    already written${o.path ? ` (${o.path})` : ''}`;
      return `vault:    FAILED — ${o.message}`;
    case 'self_dm':
      if (o.outcome === 'queued') return 'self-DM:  queued — the listener (`digest run`) sends it';
      return o.status === 'sent' ? 'self-DM:  already sent' : 'self-DM:  already queued';
    case 'group':
      if (o.outcome === 'queued')
        return `group:    queued for ${o.target} — the listener (\`digest run\`) posts it`;
      if (o.outcome === 'already')
        return o.status === 'sent' ? 'group:    already posted' : 'group:    already queued';
      return `group:    skipped — ${o.reason}`;
    case 'to': {
      const label = `to ${o.name}:`.padEnd(10);
      if (o.outcome === 'queued')
        return `${label}queued for ${o.target} — the listener (\`digest run\`) sends it`;
      if (o.outcome === 'already')
        return o.status === 'sent' ? `${label}already sent` : `${label}already queued`;
      return `${label}skipped — ${o.reason}`;
    }
  }
}
```

Import both into `src/cli/index.ts` from `./format.js` and delete the local definitions.

- [ ] **Step 4: Wire the outbox destination gate in `src/cli/index.ts`**

In the `startOutbox({...})` call inside the `run` command add:

```ts
      // Re-checked at send time: the destination must still exist, still
      // resolve to the same JID, and still be listed by the summary's scope.
      isDestinationAllowed: (scopeKey, name, target) =>
        resolveScopeDestinations(config, scopeKey).some((d) => d.name === name && d.jid === target),
```

Import `resolveScopeDestinations`, `findRecapConfig`, `type ResolvedRecapConfig` from `../config/index.js` and `runRecap` from `../scheduler/index.js`.

- [ ] **Step 5: Let `summarize` accept a recap**

Add next to `findGroup`:

```ts
type Scope = { kind: 'group'; group: ResolvedGroupConfig } | { kind: 'recap'; recap: ResolvedRecapConfig };

/** A group (JID, configured name, or subject) first; then a recap by name. */
function findScope(config: Config, store: Store, ref: string): Scope | undefined {
  const group = findGroup(config, store, ref);
  if (group) return { kind: 'group', group };
  const recap = findRecapConfig(config, ref);
  return recap ? { kind: 'recap', recap } : undefined;
}
```

In the `summarize` action, replace `const group = findGroup(config, store, groupRef); if (!group) {…}` with:

```ts
        const scope = findScope(config, store, groupRef);
        if (!scope) {
          const known = [
            ...config.groups.map((g) => `  ${g.jid}  ${g.name ?? ''}`),
            ...config.recaps.map((r) => `  recap: ${r.name}  (${r.sources.join(', ')})`),
          ].join('\n');
          console.error(
            `Unknown or non-allow-listed group or recap "${groupRef}". Configured:\n${known}`,
          );
          process.exit(1);
        }
```

Replace the `cadenceTz` line and the `runDigest({...})` call with:

```ts
        const cadence = scope.kind === 'group' ? scope.group.cadence : scope.recap.cadence;
        const cadenceTz = 'tz' in cadence ? cadence.tz : undefined;
        const tz = opts.tz ?? cadenceTz ?? systemTimeZone();
        const shared = {
          tenantId,
          store,
          config,
          untilTs: nowTs,
          trigger: 'manual' as const,
          tz,
          vaultDir,
          dryRun: opts.dryRun,
          fresh: opts.fresh,
          postOutward: Boolean(opts.post),
          adapter: opts.adapter,
          summaryOptions,
        };
        const result =
          scope.kind === 'group'
            ? await runDigest({ ...shared, group: scope.group, sinceTs: since.value })
            : await runRecap({ ...shared, recap: scope.recap, sinceTs: since.value });
        const scopeName = scope.kind === 'group' ? (scope.group.name ?? scope.group.jid) : scope.recap.name;
```

and change the empty message to use `scopeName`: ``console.log(`No messages in ${scopeName} since ${opts.since}.`)``.

Update the `summarize` argument help: `.argument('<group>', 'group JID, configured name, or subject; or a recap name')`.

- [ ] **Step 6: Full `schedule` output**

Replace the loop body in the `schedule` command:

```ts
      for (const entry of scheduler.describe()) {
        const { state, decision } = entry;
        const last = state.runs[0];
        const lastStr = last ? `${fmtTs(last.createdTs)} ${last.trigger}/${last.status}` : 'never';
        const wm = state.watermark ? fmtTs(state.watermark.watermarkTs) : '—';
        const due = decision.due ? `DUE (${decision.reason})` : `not due: ${decision.reason}`;
        if (entry.kind === 'group') {
          const { group } = entry;
          console.log(`${group.name ?? group.jid}`);
          console.log(`  cadence:   ${describeCadence(group.cadence)}`);
          console.log(`  deliver:   ${describeDeliver(group.deliver)}`);
        } else {
          const { recap } = entry;
          console.log(`${recap.name} (recap)`);
          console.log(`  sources:   ${recap.sources.map((s) => s.name).join(', ')}`);
          console.log(`  cadence:   ${describeCadence(recap.cadence)}`);
          console.log(`  deliver:   ${describeDeliver(recap.deliver)}`);
        }
        console.log(`  last run:  ${lastStr}`);
        console.log(`  watermark: ${wm}`);
        const cadence = entry.kind === 'group' ? entry.group.cadence : entry.recap.cadence;
        if (cadence.type === 'threshold')
          console.log(`  pending:   ${state.pendingMessages} messages`);
        console.log(`  status:    ${due}`);
      }
```

Update the `schedule` description: `'show each group’s and recap’s cadence, last run, and whether a digest is due now'`.

- [ ] **Step 7: Run tests, typecheck, lint, and a smoke run**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

Smoke (no network): create a temporary config with `defaults.summarizer: fake`, one group, one destination, one recap, and run `pnpm digest schedule` against it via the `CONFIG_PATH`/`DATA_DIR` environment the CLI already reads (see `docs/run.md`). Expected: both the group and the recap are listed with `deliver:` lines showing `→ hub`.

- [ ] **Step 8: Commit**

```bash
git add src/cli
git commit -m "feat(cli): recap-aware summarize and schedule; wire the send-time destination gate"
```

---

### Task 13: Dashboard: recap rows

**Files:**
- Modify: `src/dashboard/data.ts`
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/page.ts`
- Modify: `src/dashboard/index.ts`
- Test: `src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: `ScheduleEntry` (Task 11).
- Produces: `interface RecapView { name: string; sources: string[]; summarizer: string; cadence: string; cadenceType: string; deliver: { self_dm: boolean; vault: boolean; to: string[] }; watermarkTs: number | null; pendingMessages: number; lastRun: GroupView['lastRun']; due: DueDecision }`; `recapsView(src: DashboardSource): RecapView[]`; endpoint `/api/recaps`.

- [ ] **Step 1: Write the failing test**

In `src/dashboard/server.test.ts`, extend the config used in `beforeEach` with `destinations: { hub: { group: '120363000000000009@g.us' } }` and `recaps: [{ name: 'Both', sources: [<the two configured group names or JIDs>], deliver: { to: ['hub'] } }]`, then add:

```ts
  it('serves recaps', async () => {
    const res = await get('/api/recaps');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string; sources: string[]; deliver: { to: string[] } }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.name).toBe('Both');
    expect(body[0]?.sources).toHaveLength(2);
    expect(body[0]?.deliver.to).toEqual(['hub']);
  });

  it('keeps recaps out of /api/groups', async () => {
    const body = (await (await get('/api/groups')).json()) as Array<{ jid: string }>;
    expect(body.every((g) => g.jid.endsWith('@g.us'))).toBe(true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/dashboard/server.test.ts`
Expected: FAIL, 404 on `/api/recaps`.

- [ ] **Step 3: Add `recapsView` to `src/dashboard/data.ts`**

```ts
export interface RecapView {
  name: string;
  sources: string[];
  summarizer: string;
  cadence: string;
  cadenceType: ResolvedRecapConfig['cadence']['type'];
  deliver: ResolvedRecapConfig['deliver'];
  personality: string;
  language: string;
  style: string;
  watermarkTs: number | null;
  pendingMessages: number;
  lastRun: GroupView['lastRun'];
  due: DueDecision;
}

export function recapsView(src: DashboardSource): RecapView[] {
  return src
    .describeSchedule()
    .flatMap((e) => (e.kind === 'recap' ? [e] : []))
    .map(({ recap, state, decision }) => {
      const last = state.runs[0];
      return {
        name: recap.name,
        sources: recap.sources.map((s) => s.name),
        summarizer: recap.summarizer,
        cadence: describeCadence(recap.cadence),
        cadenceType: recap.cadence.type,
        deliver: recap.deliver,
        personality: recap.summary.personality,
        language: recap.summary.language,
        style: recap.summary.style,
        watermarkTs: state.watermark?.watermarkTs ?? null,
        pendingMessages: state.pendingMessages,
        lastRun: last
          ? {
              createdTs: last.createdTs,
              trigger: last.trigger,
              status: last.status,
              error: last.error,
              costUsd: last.costUsd,
            }
          : null,
        due: decision,
      };
    });
}
```

Import `type ResolvedRecapConfig` from `../config/index.js`. Also make `runsView`'s `groupName` resolve recap keys: replace the local `groupName` helper with

```ts
function scopeName(config: Config, key: string): string {
  if (isRecapScopeKey(key)) return `${key.slice('recap:'.length)} (recap)`;
  return resolveGroupConfig(config, key)?.name ?? key;
}
```

(import `isRecapScopeKey`; update the one call site). Apply the same helper in `summariesView` if it labels summaries by group name.

Export `type RecapView`, `recapsView` from `src/dashboard/index.ts`. In `src/dashboard/server.ts` add `'/api/recaps': () => recapsView(opts),` to the route table.

- [ ] **Step 4: Render recaps in `src/dashboard/page.ts`**

In `load()`, fetch `/api/recaps` alongside the others (add `recaps` to the destructured array and `get('/api/recaps')` to the `Promise.all`). Extend `deliverText`:

```js
  const deliverText = (d) => {
    const parts = [];
    if (d.self_dm) parts.push('self-DM');
    if (d.vault) parts.push('vault');
    if (d.group) parts.push(pill('posts to group', 'post'));
    for (const name of d.to || []) parts.push(pill('→ ' + esc(name), 'post'));
    return parts.length ? parts.join(', ') : '<span class="muted">nothing</span>';
  };
```

After the `table('groups', …)` call add:

```js
    if (recaps.length) {
      table('recaps', ['Recap', 'Sources', 'Schedule', 'Delivers to', 'Since last recap', 'Last run'], recaps.map((r) => {
        const dueText = r.due.due ? pill('due: ' + r.due.reason, 'warn') : '<span class="muted">' + esc(r.due.reason) + '</span>';
        const lr = r.lastRun;
        const lastRun = lr ? fmtTs(lr.createdTs) + ' ' + pill(lr.status) + '<span class="sub">' + esc(lr.trigger) + (lr.costUsd != null ? ' · ' + usd(lr.costUsd) : '') + (lr.error ? ' · ' + esc(lr.error) : '') + '</span>' : '<span class="muted">never</span>';
        const pending = r.cadenceType === 'threshold' ? n(r.pendingMessages) + ' messages' : (r.watermarkTs ? ago(r.watermarkTs, now) : '<span class="muted">no recap yet</span>');
        return '<tr><td><span class="name">' + esc(r.name) + '</span><span class="sub">' + esc(r.summarizer) + ' · ' + esc(r.style) + ' · ' + esc(r.language) + '</span></td>'
          + '<td>' + r.sources.map(esc).join(', ') + '</td>'
          + '<td>' + esc(r.cadence) + '<span class="sub">' + dueText + '</span></td>'
          + '<td>' + deliverText(r.deliver) + '</td>'
          + '<td>' + pending + '</td>'
          + '<td>' + lastRun + '</td></tr>';
      }), 'No recaps configured.');
    }
```

Add a `<section>` with `id="recaps"` and a heading "Recaps" to the HTML template right after the groups section, following the exact markup the groups section uses (same wrapper, same `table` target element). If the page's `table()` helper requires the section to exist even when hidden, render it always and let the empty-state text show.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard
git commit -m "feat(dashboard): recaps table and /api/recaps"
```

---

### Task 14: Docs, ADRs, example config, roadmap

**Files:**
- Modify: `config.example.yaml`
- Modify: `docs/agents/config.md`
- Modify: `docs/agents/operations.md`
- Modify: `docs/agents/architecture.md`
- Modify: `docs/adr/0002-group-posting-gates.md`
- Create: `docs/adr/0007-recaps-and-destinations.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-13-recaps-and-destinations-design.md` (status line)

- [ ] **Step 1: `config.example.yaml`**

After the `personalities:` block add:

```yaml
# Outward targets other than your self-chat: a group you are in, or a phone
# number (a saved contact, or your own second number; DMing strangers from an
# unofficial client is a spam signal). Referenced by name from `deliver.to`
# on a group or a recap. Never under `defaults:`.
destinations:
  zouk-hub: { group: "120363000000000009@g.us" }
  me: { number: "+13105551234" }
```

After the `groups:` block add:

```yaml
# A recap summarizes several groups together, in one model call, on its own
# schedule. Each source keeps its own watermark for the recap, separate from
# the group's own digest. A group that should only appear in a recap sets
# `cadence: { type: manual }`.
recaps:
  - name: SoCal Zouk
    sources: ["Example group", "Family"]      # configured group names or JIDs
    cadence: { type: weekly, day: sun, at: "18:00", tz: "America/Los_Angeles" }
    summary: { max_words: 600, instructions: "Lead with events and deadlines." }
    # self_dm and vault default from `defaults.deliver`; `to` is per recap only.
    deliver: { to: [zouk-hub, me] }
```

And on the example group, add a commented line under the `deliver: { group: true }` comment:

```yaml
    # Send this group's own digest onward as well:
    # deliver: { to: [me] }
```

- [ ] **Step 2: `docs/agents/config.md`**

Extend the per-group example with the `destinations:` and `recaps:` blocks from Step 1 (shortened), and add a Knobs bullet:

```markdown
- **Destinations and recaps**: `destinations:` names outward targets
  (`{ group: <jid> }` or `{ number: <phone> }`); `deliver.to: [names]` on a
  group or a recap sends there, gated like `deliver.group` (per scope, never
  under `defaults`, scheduled runs only unless `--post`, re-checked at send
  time). A recap (`recaps:`) has `name`, `sources` (configured groups),
  and the same `cadence`, `summarizer`, `summary`, and `deliver` keys as a
  group minus `deliver.group`. Recap names must not collide with group
  names: `/digest <ref>` and `digest summarize <ref>` try groups first,
  then recaps (exact name, then substring).
```

In "Self-chat commands" change the `/digest` bullet to mention `/digest <group|recap>` and that recaps run over every source from each source's recap watermark.

- [ ] **Step 3: `docs/agents/operations.md`**

Under "Sends" replace the group bullet with:

```markdown
- Outward sends (a post back into the source group, or a `to:<name>`
  destination row for a group or a number) happen only when that scope's
  config lists the target, only from scheduled runs or an explicit `--post`,
  and only after the outbox re-resolves the target against current config
  at send time. Every outward message is signed as an automated digest.
- Two outward sends to the same target JID are spaced by
  `limits.min_group_post_gap_minutes`, whichever scope produced them. A held
  row does not block self-DMs behind it.
```

- [ ] **Step 4: `docs/agents/architecture.md`**

In the module table, change the scheduler and delivery lines:

```
  scheduler/    per-group and per-recap cron/threshold triggers, /digest and
                /ask commands, typing indicator, retention pruning
  delivery/     self-dm, group-post, named destinations (groups and numbers),
                markdown-vault
```

Under "Decisions and why" add:

```markdown
- **Recaps are a scope, not a group** (ADR-0007): `summaries.group_jid` and
  `runs.group_jid` hold a scope key, either a group JID or `recap:<name>`;
  per-source recap positions live in `recap_watermarks`. Destinations are
  `to:<name>` delivery channels, so one summary fans out under the existing
  deliveries key.
```

Update the "Group posting is gated three times" bullet to say "Outward delivery (group posts and destinations) is gated three times".

- [ ] **Step 5: Amend `docs/adr/0002-group-posting-gates.md`**

Append a section:

```markdown
## Amendment (2026-09-13, phase 14)

The same three gates now cover every **outward** row, not only a post back
into the source group. Outward means a `group` row or a `to:<name>` row for a
destination declared under `destinations:` (a group JID or a phone number).

1. **Config, per scope.** `deliver.to` is set on the group or on the recap.
   `defaults.deliver.to` is rejected for the same reason as
   `defaults.deliver.group`: a global destination would route a family chat's
   digest into a community hub.
2. **Trigger.** Unchanged. `--post` now lifts the gate for destinations too.
3. **Send time.** The outbox re-resolves each `to:` row: the name must still
   exist, still resolve to the exact JID on the row, and still be listed by
   the summary's scope. The target must be a group or user JID.

The per-target gap applies to all outward rows by target JID. See ADR 0007
for recaps and scope keys.
```

- [ ] **Step 6: Create `docs/adr/0007-recaps-and-destinations.md`**

```markdown
# ADR 0007: Recaps are a scope; destinations are named channels

**Date:** 2026-09-13
**Status:** accepted

## Context

Phase 14 adds two things: sending a digest somewhere other than its source
(a hub group, a phone number) and summarizing several groups together into
one message. Both had to fit the existing store (per-group summaries, runs,
watermarks, deliveries keyed by summary and channel) without a redesign, and
without weakening ADR 0002.

## Decision

- **Scope key.** `summaries.group_jid` and `runs.group_jid` hold a *scope
  key*: a group JID, or `recap:<name>` for a recap. A group JID always ends
  in `@g.us`, so the two never collide. Due decisions, summary reuse,
  retries, and delivery rows work on the key unchanged.
- **Per-source watermarks.** A recap keeps its position per source in
  `recap_watermarks` (migration 006) and never reads or writes a group's own
  digest watermark. Two recaps sharing a source do not interfere.
- **One model call.** A recap builds one transcript with a block per source
  group and asks for one recap. The alternative, stitching per-group
  summaries, cannot cross-reference groups and reads as a list.
- **Named destinations.** `destinations:` declares each outward target once;
  `deliver.to` references names. Unknown names fail at load time, like
  personalities. Each destination is a `to:<name>` delivery channel, so the
  deliveries primary key is unchanged and one summary fans out to many.
- **No global destinations.** `defaults.deliver.to` is rejected. See the
  amendment to ADR 0002.
- **Recap names are unique across recaps and groups**, so `/digest <ref>`
  resolves without ambiguity: groups first, then recaps.

## Consequences

- A recap costs one model call per run regardless of source count.
- Several groups each with their own `deliver.to` pointing at one hub trickle
  out one per `min_group_post_gap_minutes`; a recap is the way to get one
  message.
- When per-tenant settings move into the store, `destinations` and `recaps`
  keep the zod shape as their contract, like `groups`.
```

- [ ] **Step 7: `README.md`**

- In the delivery channels table add a row: `| \`to:<name>\` | A named destination under \`destinations:\` (a group or a phone number). Queued like a group post, gated the same three ways, headed with the source name and signed. |`
- Rename "Group posting" heading to "Outward delivery: group posts and destinations" and adjust the three gates text as in the ADR amendment.
- In the config reference, add the `destinations:` and `recaps:` example blocks and one paragraph: recaps summarize several groups in one model call on their own cadence, keep per-source watermarks, and can be run on demand with `/digest <recap>` or `digest summarize <recap> --since 1w`.
- In the CLI table, note that `summarize <group>` also accepts a recap name.
- Roadmap: add `14. ✅ **Recaps and destinations** — one recap over several groups, delivered to named groups and numbers behind the posting gates` and keep item 13 as is.
- Update the storage sentence about `deliveries` to "one row per summary and channel, where a destination is its own `to:<name>` channel".

- [ ] **Step 8: Spec status line**

Change the spec's status line to `Status: implemented 2026-09-13 (phase 14).`

- [ ] **Step 9: Verify docs build nothing stale**

Run: `pnpm test && pnpm typecheck && pnpm lint && grep -rn "postToGroup\|lastSentTs\|groupName: " src --include='*.ts' | grep -v "SummaryInput\|groupName: string\|groupName,\|groupName:" ; true`
Expected: tests pass; the grep prints nothing for the removed identifiers.

- [ ] **Step 10: Commit**

```bash
git add config.example.yaml docs README.md
git commit -m "docs: recaps and destinations (phase 14), ADR 0007, ADR 0002 amendment"
```

---

## Self-review notes

- Spec coverage: config (T1, T2), store (T3, T4), delivery and rendering (T5, T6), gates and gap (T7), prompt (T8), runners (T9, T10), scheduler/commands (T11), CLI (T12), dashboard (T13), docs/ADRs (T14). The spec's "empty recap records an `empty` run" is in T11; "dry run touches no watermark" in T10; "`/help` lists recaps" in T11; "`--post` help text mentions destinations" in T9.
- Type consistency: `RenderContext.scopeName` (T5) is used by T6, T9, T10. `destinationChannel`/`destinationName` (T4) are used by T6, T7. `ScheduleEntry` (T11) is used by T12, T13. `SummarizerFactory` (T9) is used by T10. `postOutward` (T9) is used by T10, T12.
- Deliberate leftovers: `GroupScheduleState` keeps its name although recaps use it too; renaming it is churn without benefit.
