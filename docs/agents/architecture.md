# Architecture

Single Node/TypeScript process running one supervised Baileys socket per
tenant. Read this before adding a module, crossing a module boundary, or
changing where state lives.

## Modules

```
src/
  listener/     Baileys socket, auth state persistence, message ingestion
  store/        SQLite (better-sqlite3): messages, groups, summaries, runs,
                questions; every table carries tenant_id
  scheduler/    per-group cron/threshold triggers, /digest and /ask commands,
                typing indicator, retention pruning
  summarizer/   adapter interface + implementations (cli-claude, cli-gemini,
                cli-codex, api-anthropic, api-openai, api-google, fake)
  delivery/     self-dm, group-post, markdown-vault
  dashboard/    read-only local web page + JSON endpoints (node:http, no deps)
  enrich/       image + link descriptions: ingest-time download, queue worker,
                guarded link fetch
  config/       zod-validated config loading (config.yaml + env), personalities
  shared/       logger, Result type, tenant helpers
  cli/          digest run | summarize | groups | ask | dashboard | schedule | enrich
```

Data flow: `listener → store → scheduler decides → summarizer (adapter) →
delivery (fan-out) → store records the run`.

## Decisions and why

Full records live in `docs/adr/`. The short form:

- **Baileys over whatsapp-web.js**: speaks the multi-device protocol directly,
  no headless Chromium, far lighter in Docker.
- **TypeScript end to end**: the listener is necessarily Node; the "brain"
  only shells out to CLIs, so a second runtime buys nothing.
- **SQLite over Postgres**: tenant count of one, single process, append-mostly
  workload. Every table is keyed by `tenant_id` from its first migration, so a
  later move to Postgres is a driver swap, not a schema redesign (ADR-0001).
- **Tenant-keyed from day one**: `tenant_id` on every table, log line, and
  queue item; auth state under `data/tenants/<tenant_id>/`. The single-user
  path is the same code with `tenant_id = "owner"`, so this is not dead
  scaffolding.
- **Summarizer as adapter**: `interface Summarizer { summarize(input); complete(req) }`.
  CLI adapters spawn the binary non-interactively (`claude -p`, `gemini -p`,
  `codex exec`) with the prompt on stdin and parse stdout. API adapters call
  the vendor SDK. Both return the same `Summary` shape. `complete` sends any
  system+user prompt through the backend; `summarize` is the digest prompt on
  top of it, `/ask` is the question prompt on top of it (ADR-0005).
- **Scheduler is stateful**: every run is recorded with the message-id
  watermark, so a restart never double-summarizes or skips a window.
- **Delivery is idempotent**: a summary has a stable id; each channel records
  delivery so retries are safe.
- **Group posting is gated three times** (ADR-0002): per-group
  `deliver.group: true`, scheduled runs only unless `--post`, and the
  per-tenant outbox cap.
- **Enrichment runs off the ingest path**, capped per day, behind an SSRF
  guard (ADR-0006).

## Deployment profiles

Same code, two profiles; everything host-specific comes from env and
`config.yaml`, never from hardcoded paths.

- **host** (Mac mini, primary): pm2 or launchd. CLIs are already logged in
  under `~/.claude`, `~/.gemini`, `~/.codex`.
- **docker** (VPS, also the future service profile): `docker compose up -d`
  with `./data`, `./vault`, and `config.yaml` mounted. The image installs the
  CLIs; `claude` authenticates headlessly with `CLAUDE_CODE_OAUTH_TOKEN`
  (ADR-0004). Fallback: `SUMMARIZER=api-anthropic` plus `ANTHROPIC_API_KEY`.

WhatsApp auth state lives in `./data/tenants/<tenant_id>/auth/`. Only one
instance may be linked per auth directory; a second linked instance kicks
the first off the session. Setup steps and known failure modes:
`docs/deploy.md`. Day-2 operations: `docs/run.md`.

## Keeping this current

When changing any decision above, add or amend a file in `docs/adr/`
(ADR-lite, one file per decision) in the same change.
