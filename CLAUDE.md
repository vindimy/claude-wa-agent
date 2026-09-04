# CLAUDE.md — WhatsApp Group Digest Agent

## What this is

A long-running agent that listens to selected WhatsApp groups via the owner's
personal account (linked device), stores messages locally, and produces
per-group summaries on a configurable schedule. Summaries are delivered to one
or more channels: a self-DM on WhatsApp, the source group itself (opt-in only),
and a local Markdown notes vault.

Owner: Dmitriy. Single-user system. Not a SaaS. Optimize for reliability and
low operational attention, not for scale.

## Non-negotiable constraints

1. **Listening uses the owner's personal account** via the WhatsApp multi-device
   protocol (Baileys). This is an unofficial client; ban risk is real. Behave
   like a quiet human: no bulk sends, no rapid-fire messages, no message
   scraping beyond groups explicitly allow-listed in config.
2. **Never post into a group unless `deliver.group: true` is set for that
   specific group.** Default is off. A summary posted to the wrong group is the
   worst failure mode of this project.
3. **Portable across host + Docker.** Same code runs on a Mac mini (launchd/pm2)
   and on a VPS (docker compose). No host-specific paths hardcoded; everything
   via env + config.
4. **Summaries come from locally authenticated CLIs first** (`claude`, `gemini`,
   `codex`), with API-key adapters as a fallback. Adapter choice is config, not
   code.
5. **All data stays local.** SQLite on disk, notes in a local vault directory.
   No third-party message storage.
6. Groups are multilingual (Russian + English). Summaries must preserve the
   language mix of the source unless a group config sets `summary.language`.

## Architecture

Single Node/TypeScript process, four modules with clear boundaries:

```
src/
  listener/     Baileys socket, auth state persistence, message ingestion
  store/        SQLite (better-sqlite3) — messages, groups, summaries, runs
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
- **SQLite over Postgres**: single user, single process, append-mostly workload.
- **Summarizer as adapter**: `interface Summarizer { summarize(input): Promise<Summary> }`.
  CLI adapters spawn the binary in non-interactive mode (e.g. `claude -p`,
  `gemini -p`, `codex exec`) with the prompt on stdin, parse stdout. API adapters
  call the vendor SDK. Both return the same `Summary` shape.
- **Scheduler is stateful**: every run is recorded with the message-id
  watermark, so a restart never double-summarizes or skips a window.
- **Delivery is idempotent**: a summary has a stable id; each channel records
  delivery so retries are safe.

## Per-group configuration

`config.yaml` is the source of truth. Example:

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
first), `manual` (on-demand only). On-demand trigger for any group: send
`/digest` or `/digest 3d` from the owner's own number in the self-chat.

## Deployment profiles

- **host** (Mac mini, primary): run under pm2 or launchd. CLIs are already
  authenticated in `~/.claude`, `~/.gemini`, `~/.codex`. Auth state for
  WhatsApp in `./data/auth/`.
- **docker** (VPS): `docker compose up -d`. Mount `./data` as a volume. For CLI
  adapters, bind-mount the host's CLI auth dirs read-only and install the CLIs
  in the image; if that proves brittle, flip `summarizer` to an `api-*` adapter
  via env. Document whichever path actually works in `docs/deploy.md`.

Only one instance may be linked at a time per auth state directory. Never run
host and docker profiles simultaneously against the same `data/auth`.

## Operational rules for the agent

- Sends go through a single outbound queue with a minimum 2–5 s jitter between
  messages and a daily cap (config `limits.max_sends_per_day`, default 30).
- On socket disconnect: exponential backoff reconnect; after logout (401),
  stop, log loudly, and wait for re-pairing — never loop on QR generation.
- Media is not downloaded by default (`ingest.media: false`). Captions are stored.
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
- Keep `docs/decisions.md` (ADR-lite) updated when changing an architecture
  choice listed above.

## Coding conventions

- Strict TS, no `any` outside adapter boundaries with third-party payloads.
- Every module exposes a small typed interface; cross-module imports go through
  `index.ts` only.
- Errors are typed (`Result`-style or tagged errors), not thrown strings.
- Log with pino, structured, one logger per module. Never log message bodies at
  `info` level; bodies only at `debug` and never in production config.

## Phased plan

1. **Listen + store**: pair device, ingest allow-listed groups into SQLite,
   `digest groups` lists what it sees. No sends.
2. **Summarize on demand**: `fake` and `cli-claude` adapters, `--dry-run` CLI.
3. **Deliver to self-DM + vault**: idempotent delivery, run records.
4. **Scheduler**: daily/weekly/threshold cadences, restart-safe watermarks.
5. **Group posting (opt-in)** with send queue and rate limits.
6. **Docker profile** on the VPS; document CLI-auth mounting or API fallback.
7. Nice-to-have: action-item extraction, `/ask <group> <question>` over stored
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

### Architectural consequences (apply from phase 1 onward)
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
- **Group posting stays opt-in per group**, signed as an automated digest.
- **Deployment**: the Docker profile is the service profile. Stateless app
  container(s) + persistent volume per tenant now; move to object storage for
  auth/state when we pass a handful of tenants.

### Not yet
Billing, web onboarding UI, and admin dashboard are out of scope until the
single-user agent has run reliably for a month. Do not build multi-tenant
scaffolding that the single-user path doesn't also use — same code, tenant
count of one.

## Open questions (resolve before phase 5)

- Whether unattended use of subscription CLI auth is acceptable under each
  provider's terms; if not, API adapters become the default.
- Retention policy for stored messages (default: keep forever, single user).
- Whether summaries in a group should be signed (e.g. "🤖 auto-digest") so
  members know it's not Dmitriy typing.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (vindimy/claude-wa-agent) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.