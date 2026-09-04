# CLAUDE.md — WhatsApp Group Digest Agent

## What this is

A long-running agent that listens to selected WhatsApp groups via the owner's
personal account (linked device), stores messages locally, and produces
per-group summaries on a configurable schedule. Summaries are delivered to one
or more channels: a self-DM on WhatsApp, the source group itself (opt-in only),
and a local Markdown notes vault.

Owner: Dmitriy, who is the first and currently only *tenant*. Today this runs
as a single-user agent; it is built tenant-keyed from the start so it can grow
into a hosted bring-your-own-account service without a rewrite (see "Service
direction" below). Optimize for reliability and low operational attention.
Scale comes from the tenant key, not from redesigns.

## Non-negotiable constraints

1. **Listening uses the tenant's own personal account** (today: the owner's)
   via the WhatsApp multi-device protocol (Baileys). We never operate bot
   numbers. This is an unofficial client; ban risk is real and stays with the
   tenant. Behave like a quiet human: no bulk sends, no rapid-fire messages,
   no message scraping beyond groups explicitly allow-listed for that tenant.
2. **Never post into a group unless `deliver.group: true` is set for that
   specific group.** Default is off. A summary posted to the wrong group is the
   worst failure mode of this project.
3. **Portable across host + Docker.** Same code runs on a Mac mini (launchd/pm2)
   and on a VPS (docker compose). No host-specific paths hardcoded; everything
   via env + config.
4. **Adapter choice is config, not code.** The owner tenant uses locally
   authenticated CLIs first (`claude`, `gemini`, `codex`) with API-key adapters
   as a fallback (`SUMMARIZER=api-anthropic` forces it for every group). Every
   other tenant uses API-key (`api-*`) adapters only; the CLI adapters are
   owner-only and never run for another tenant.
5. **All data stays under our control.** SQLite on disk and notes in a local
   vault directory for the owner; the service profile keeps the same store on
   its own volume (object storage for auth/state later). No third-party message
   storage. No cross-tenant reads, ever.
6. Groups are multilingual (Russian + English). Summaries must preserve the
   language mix of the source unless a group config sets `summary.language`.

## Architecture

Single Node/TypeScript process running one supervised Baileys socket per
tenant. Modules with clear boundaries:

```
src/
  listener/     Baileys socket, auth state persistence, message ingestion
  store/        SQLite (better-sqlite3) — messages, groups, summaries, runs;
                every table carries tenant_id
  scheduler/    per-group cron/threshold triggers, on-demand commands
  summarizer/   adapter interface + implementations (cli-claude, cli-gemini,
                cli-codex, api-anthropic, api-openai, api-google)
  delivery/     self-dm, group-post, markdown-vault
  config/       zod-validated config loading (config.yaml + env)
  cli/          `digest run`, `digest summarize <group> --since`, `digest groups`
```

Data flow: `listener → store → scheduler decides → summarizer (adapter) →
delivery (fan-out) → store records the run`.

### Key design decisions (with reasoning)

- **Baileys over whatsapp-web.js**: speaks the multi-device protocol directly,
  no headless Chromium, far lighter in Docker.
- **TypeScript end to end**: the listener is necessarily Node; the "brain" only
  shells out to CLIs, so a second runtime buys nothing.
- **SQLite over Postgres**: tenant count of one, single process, append-mostly
  workload. Every table is keyed by `tenant_id` from its first migration, so a
  later move to Postgres is a driver swap, not a schema redesign.
- **Tenant-keyed from day one**: `tenant_id` on every table, log line, and
  queue item; auth state under `data/tenants/<tenant_id>/`. The single-user
  path uses the same code with one tenant (`tenant_id = "owner"`), so this is
  not dead scaffolding.
- **Summarizer as adapter**: `interface Summarizer { summarize(input): Promise<Summary> }`.
  CLI adapters spawn the binary in non-interactive mode (e.g. `claude -p`,
  `gemini -p`, `codex exec`) with the prompt on stdin, parse stdout. API adapters
  call the vendor SDK. Both return the same `Summary` shape.
- **Scheduler is stateful**: every run is recorded with the message-id
  watermark, so a restart never double-summarizes or skips a window.
- **Delivery is idempotent**: a summary has a stable id; each channel records
  delivery so retries are safe.

## Per-group configuration

`config.yaml` is the source of truth for the owner tenant. When the service
lands, per-tenant settings move into the store with the **same shape**; the zod
schema in `config/` stays the single definition of that shape. Example:

```yaml
defaults:
  summarizer: cli-claude
  cadence: { type: daily, at: "08:00", tz: "America/Los_Angeles" }
  deliver: { self_dm: true, group: false, vault: true }
  summary:
    language: auto          # auto | ru | en
    style: topics           # topics | narrative | action-items
    max_words: 300

groups:
  - jid: "1203630XXXXXXXX@g.us"
    name: "Zouk Atoms team"
    cadence: { type: threshold, messages: 150, max_hours: 24 }
    deliver: { group: true }        # explicit opt-in
  - jid: "1203630YYYYYYYY@g.us"
    name: "Family"
    cadence: { type: weekly, day: sun, at: "18:00" }
    summary: { language: ru }
```

Cadence types: `daily`, `weekly`, `threshold` (N messages or M hours, whichever
first), `manual` (on-demand only). On-demand trigger for any group: the tenant
sends `/digest` or `/digest 3d` from their own number in their self-chat.

## Deployment profiles

- **host** (Mac mini, primary): run under pm2 or launchd. CLIs are already
  authenticated in `~/.claude`, `~/.gemini`, `~/.codex`. WhatsApp auth state
  in `./data/tenants/<tenant_id>/auth/` (owner: `./data/tenants/owner/auth/`).
- **docker** (VPS): `docker compose up -d`. Mount `./data`, `./vault`, and
  `config.yaml`. This is also the service profile: stateless app container(s)
  plus a persistent volume. The image installs the `claude` CLI; the owner
  authenticates it headlessly with `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) rather than by mounting `~/.claude`, which on macOS
  holds no credentials (they live in the Keychain). Fallback: `SUMMARIZER=
  api-anthropic` plus `ANTHROPIC_API_KEY` via env. Details in `docs/deploy.md`.

Only one instance may be linked at a time per tenant auth directory. Never run
host and docker profiles simultaneously against the same
`data/tenants/<tenant_id>/auth`.

## Operational rules for the agent

- Sends go through one outbound queue **per tenant** with a minimum 2–5 s
  jitter between messages and a per-tenant daily cap (config
  `limits.max_sends_per_day`, default 30). No bursts.
- On socket disconnect: exponential backoff reconnect; after logout (401),
  stop that tenant's socket, log loudly, mark the tenant `logged_out`, and wait
  for re-pairing — never loop on QR generation. Other tenants are unaffected.
- Session state (`pairing`, `connected`, `reconnecting`, `phone_offline`,
  `logged_out`) is explicit and surfaced, not inferred from log noise.
- Every log line carries `tenant_id`.
- Media is not downloaded by default (`ingest.media: false`). Captions are stored.
- Messages older than `retention.days` (30 by default; 60/90/180 allowed) are
  deleted hourly. Summaries, runs, and vault notes are never pruned.
- Message deletions/edits update the store; summaries reflect the latest state.
- Secrets only via env (`.env` is gitignored). Never commit `data/`.

## Development workflow

- `pnpm dev` — run with hot reload against a real linked session (pair once via
  QR in terminal).
- `pnpm test` — vitest. Summarizer adapters are tested against fixture
  transcripts with a `fake` adapter; real CLI/API calls are behind
  `INTEGRATION=1`.
- `pnpm digest summarize <group> --since 2d --dry-run` prints the summary
  without delivering. Use this constantly; prefer dry runs to live sends.
- Lint/format: biome. Types must pass `tsc --noEmit` before commit.
- Keep `docs/adr/` (ADR-lite, one file per decision) updated when changing an
  architecture choice listed above.

## Coding conventions

- Strict TS, no `any` outside adapter boundaries with third-party payloads.
- Every module exposes a small typed interface; cross-module imports go through
  `index.ts` only.
- Errors are typed (`Result`-style or tagged errors), not thrown strings.
- Log with pino, structured, one logger per module. Never log message bodies at
  `info` level; bodies only at `debug` and never in production config.

## Phased plan

1. **Listen + store**: pair device, ingest allow-listed groups into SQLite,
   `digest groups` lists what it sees. No sends. *(shipped)*
2. **Summarize on demand**: `fake` and `cli-claude` adapters, `--dry-run` CLI.
   *(shipped)*
3. **Tenant retrofit + deliver to self-DM + vault**: phases 1–2 shipped before
   the service direction was written (`data/auth`, no `tenant_id`). Retrofit
   them first while the schema is cheap to change: `tenant_id` on `groups` and
   `messages`, auth under `data/tenants/owner/auth/`, tenant on the logger.
   Then idempotent delivery and run records, tenant-keyed from the start.
4. **Scheduler**: daily/weekly/threshold cadences, restart-safe watermarks.
   *(shipped)*
5. **Group posting (opt-in)** with send queue and rate limits. Scheduled runs
   post; on-demand runs (`digest summarize`, `/digest`) stay private unless
   `--post` is given. *(shipped)*
6. **Docker profile** on the VPS (doubles as the service profile); headless
   CLI auth via token or the `api-anthropic` fallback via env. *(shipped)*
7. **OpenAI and Gemini adapters**: `api-openai` and `api-google` behind the
   same `Summarizer` interface, keyed by `OPENAI_API_KEY` / `GOOGLE_API_KEY`,
   configured under `summarizers:` and selectable per group via
   `summarizer:` like the existing adapters. Tracked in GitHub issue #1.
   *(shipped)*
8. Nice-to-have: action-item extraction, `/ask <group> <question>` over stored
   history, simple local web dashboard.

## Service direction (multi-tenant, BYO account)

Beyond the single-user agent, the long-term goal is a hosted service where
each customer links **their own** WhatsApp account to our backend (QR / pairing
code), and we summarize the groups they already belong to. We never operate
bot numbers and never read a group a tenant is not a member of.

### Why this direction
- Meta's official Groups API only covers groups the business itself creates
  (invite-link, OBA-only). It cannot join existing groups, so it does not fit
  "summarize the chats you already have."
- Dedicated bot numbers put ban risk on *our* numbers and scale with SIM cards.
- BYO account keeps the account risk with the tenant. This is an unofficial
  client path and a WhatsApp ToS gray zone; the product must say so plainly
  during onboarding, and the architecture must make a per-tenant logout
  harmless.

### Architectural consequences (apply from now on)
- **Tenant is a first-class key.** Every table, every log line, every queue
  item carries `tenant_id`. No cross-tenant reads, ever. Auth state lives in
  `data/tenants/<tenant_id>/auth/`, one Baileys socket per tenant, supervised.
- **Session lifecycle is a product feature, not an error path.** Pairing,
  reconnect, logout (401), and "phone offline" are explicit states surfaced to
  the tenant. A logged-out tenant pauses cleanly; nothing else is affected.
- **Human-like send discipline per tenant** (jitter, daily cap, no bursts) —
  the queue limits move from global to per-tenant.
- **Summarizer adapters become API-key based** (`api-*`) for the service;
  the personal CLI adapters stay owner-only and are never used for tenants.
- **Data handling**: encrypt auth state and message bodies at rest, tenant-
  configurable retention (default 30 days for the service), one-click export
  and delete. Assume EU tenants: GDPR-grade consent to summarize, a privacy
  policy, and a DPA before any paid tier.
- **Group posting stays opt-in per group**, signed as an automated digest
  (e.g. "🤖 auto-digest") so members know it is not the tenant typing.
- **Deployment**: the Docker profile is the service profile. Stateless app
  container(s) + persistent volume per tenant now; move to object storage for
  auth/state when we pass a handful of tenants.

### Not yet
Billing, web onboarding UI, and admin dashboard are out of scope until the
single-user agent has run reliably for a month. Do not build multi-tenant
scaffolding that the single-user path doesn't also use — same code, tenant
count of one.

## Resolved questions (2026-09-04, see `docs/adr/0003-*`)

- **Unattended use of subscription CLI auth**: acceptable for the owner's
  personal use only, with this automation never exposed to anyone else
  (OpenClaw sets the precedent). This is why CLI adapters are owner-only;
  every other tenant uses `api-*` adapters.
- **Retention for the owner tenant**: 30 days of messages by default,
  configurable to 60, 90, or 180 (`retention.days`). Summaries, run records,
  and vault notes are kept. The scheduler prunes hourly.
- **Encryption at rest**: not needed now. In Docker the auth state is a
  read-only mount, and the stored bodies come from groups whose content is
  already visible to every member. Revisit before the first non-owner tenant.

## Open questions

- None blocking phase 6.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (vindimy/claude-wa-agent) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.