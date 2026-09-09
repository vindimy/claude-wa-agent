# Configuration and commands

Read this when touching `src/config/`, per-group options, the `/digest` and
`/ask` command parsers, or anything the tenant can set.

`config.yaml` is the source of truth for the owner tenant. When the service
lands, per-tenant settings move into the store with the **same shape**; the
zod schema in `src/config/schema.ts` stays the single definition of that
shape. Unknown keys and unknown personality names fail validation.

## Per-group example

```yaml
defaults:
  summarizer: cli-claude
  cadence: { type: daily, at: "08:00", tz: "America/Los_Angeles" }
  deliver: { self_dm: true, group: false, vault: true }
  summary:
    language: en            # en | ru | pt | es | zh | ja | auto
    style: topics           # topics | narrative | action-items
    max_words: 300
    personality: neutral    # preset or a key under personalities:; tone only
    instructions: "Always call out deadlines."   # plain English; groups append to it

personalities:              # custom voices in plain English, referenced by name
  grumpy-uncle: "A grumpy but loving uncle who still gets every fact right."

groups:
  - jid: "1203630XXXXXXXX@g.us"
    name: "Zouk Atoms team"
    cadence: { type: threshold, messages: 150, max_hours: 24 }
    deliver: { group: true }        # explicit opt-in
  - jid: "1203630YYYYYYYY@g.us"
    name: "Family"
    cadence: { type: weekly, day: sun, at: "18:00" }
    summary: { language: ru, personality: friendly, instructions: "Baba is grandma." }
```

## Knobs

- **Language**: `en` by default. Groups are multilingual (Russian + English);
  a group can pin `ru`, `pt`, `es`, `zh`, `ja`, or `auto` to preserve the
  source's language mix.
- **Personality**: presets `neutral`, `dry`, `friendly`, `russian-sarcasm`,
  `executive`, `newsroom`, `butler`, `hype` (`src/config/personalities.ts`),
  or a custom key under `personalities:`. Voice and `instructions` enter the
  system prompt after the fixed rules with a guard that tone never alters
  facts.
- **Cadence**: `daily`, `weekly`, `threshold` (N messages or M hours,
  whichever first), `manual` (on-demand only).
- **Summarizer**: any adapter name per group; `SUMMARIZER=<name>` in env
  forces one adapter for every group.
- **Ingest**: `ingest.media` (default off), `ingest.describe_images`,
  `ingest.describe_links` (both off by default); `enrich.summarizer` and
  `enrich.max_per_day` (default 200 model calls per local day).
- **Retention**: `retention.days` is 30 by default; 60, 90, and 180 allowed.
- **Limits**: `limits.max_sends_per_day` (default 30) per tenant.
- **Dashboard**: `dashboard: { enabled: false, host: 127.0.0.1, port: 8787 }`,
  overridable with `DASHBOARD_PORT` / `DASHBOARD_HOST`. No auth, so loopback
  only; the page can never send, summarize, or change config.

## Self-chat commands

The tenant sends these from their own number in their self-chat. Parsing
lives in `src/scheduler/commands.ts`.

- `/digest [group] [window]` triggers an on-demand digest. The `digest
  summarize` knobs ride along as `key=value` tokens or `--flags`:
  `/digest Family 2d style=narrative lang=ru words=150 voice=dry via=api-openai`.
  On-demand digests stay private (self-DM + vault) unless `--post` is given
  and the group has `deliver.group: true`.
- `/ask <group> [window] <question>` answers from stored messages, whole
  retention window by default. Answers are self-DM only, recorded in
  `questions`, and never move a watermark.

While a reply is being produced the agent shows `composing` presence on the
self-chat only (`src/scheduler/typing.ts`, refreshed every 8 s, cleared in
`finally`). Presence is not a send: it skips the outbox and the daily cap.

## CLI equivalents

`digest summarize <group> --since 2d --dry-run` prints without delivering;
`digest ask <group> <question>`, `digest groups`, `digest schedule`,
`digest enrich [--backfill-links <group>]`. Full usage: `docs/run.md`.
