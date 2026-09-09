# CLAUDE.md — WhatsApp Group Digest Agent

Long-running Node/TypeScript agent that listens to allow-listed WhatsApp
groups through the tenant's own linked account (Baileys), stores messages in
SQLite, and delivers per-group summaries to a self-DM, a Markdown vault, and
(opt-in) the group itself. Owner and only tenant today: Dmitriy (`owner`).
Tenant-keyed from day one so it can become a hosted BYO-account service.
Optimize for reliability and low operational attention.

## Commands

- `pnpm test` (vitest, no network needed), `pnpm typecheck`, `pnpm lint`
- `pnpm digest summarize <group> --since 2d --dry-run` before any live send

## Hard rules

1. **Never post into a group unless that group has `deliver.group: true`.**
   A summary in the wrong group is the worst failure mode of this project.
2. Listen only through the tenant's personal account, only in allow-listed
   groups, and behave like a quiet human: no bulk or rapid-fire sends, no
   read receipts, no presence outside the self-chat.
3. `tenant_id` on every table, log line, and queue item. No cross-tenant
   reads. CLI adapters (`cli-*`) run for the owner only; other tenants use
   `api-*`.
4. Adapter, cadence, language, and delivery are config, never code.
5. Same code on the Mac mini (pm2/launchd) and in Docker: paths and secrets
   come from env and `config.yaml` only.
6. Data stays under our control: SQLite and vault on disk, nothing sent to
   third-party storage.

## Where to look

- Adding a module, crossing a module boundary, or changing where state
  lives: `docs/agents/architecture.md`
- Per-group options, `/digest` and `/ask` parsing, personalities, zod
  schema: `docs/agents/config.md`
- Outbox, session states, logging, retention, enrichment, quiet-client
  rules: `docs/agents/operations.md`
- Code style, tests, dev loop, ADR upkeep: `docs/agents/conventions.md`
- Anything touching tenancy, auth state, or the multi-tenant roadmap:
  `docs/agents/service-direction.md`
- Recorded decisions: `docs/adr/`. Domain vocabulary: `docs/agents/domain.md`
- Deploy and day-2 ops: `docs/deploy.md`, `docs/run.md`. Roadmap: `README.md`
- Issues: GitHub via `gh`, see `docs/agents/issue-tracker.md`; labels in
  `docs/agents/triage-labels.md`
