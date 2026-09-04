# claude-wa-agent

A long-running agent that listens to selected WhatsApp groups through your own
linked device, stores messages locally in SQLite, and produces per-group
summaries on a schedule using locally authenticated AI CLIs (`claude`,
`gemini`, `codex`). Summaries go to a self-DM, a local Markdown vault, and
(opt-in only) back into the group.

Self-hosted, all data stays on disk. Built tenant-keyed from the start: today
it runs with a single tenant (`owner`), so it can grow into a bring-your-own-
account service later without a rewrite (see `CLAUDE.md` and `docs/adr/`).

> **Project status: phase 3 of 7 (deliver).** The agent pairs, ingests
> allow-listed groups into SQLite, summarizes any stored window on demand, and
> delivers the result to your WhatsApp self-chat and a Markdown vault. No
> scheduling yet, and no
> outbound messages yet. See [Roadmap](#roadmap).

## Why

Busy multilingual (Russian + English) group chats are easy to fall behind on.
Instead of scrolling hundreds of messages, get a short digest per group at a
cadence you choose: daily, weekly, or "every 150 messages". The summarizer is
whatever AI CLI you are already logged into, so there is no extra API bill.

## How it works

```
WhatsApp ──▶ listener ──▶ store (SQLite) ──▶ scheduler ──▶ summarizer ──▶ delivery
             (Baileys)                       (cadence)     (adapter)      (fan-out)
                                                                            │
                                                          self-DM ◀─────────┼──▶ vault (.md)
                                                                            └──▶ group (opt-in)
```

One Node/TypeScript process, split into modules with typed boundaries:

| Module           | Responsibility                                                         | Status  |
| ---------------- | ---------------------------------------------------------------------- | ------- |
| `src/listener/`  | Baileys socket, QR pairing, auth persistence, allow-listed ingestion   | ✅ done |
| `src/store/`     | SQLite via better-sqlite3: groups, messages (edits, soft deletes)      | ✅ done |
| `src/config/`    | zod-validated `config.yaml` + env, per-group overrides over defaults   | ✅ done |
| `src/cli/`       | `digest run`, `digest groups`, `digest summarize`                      | ✅ done |
| `src/summarizer/`| Adapter interface; `fake` and `cli-claude` shipped, `cli-gemini`, `cli-codex`, `api-*` later | ✅ done |
| `src/delivery/`  | Idempotent fan-out: self-DM and Markdown vault shipped; group post in phase 5 | ✅ done |
| `src/scheduler/` | Daily / weekly / threshold triggers with restart-safe watermarks       | phase 4 |

Cross-module imports go through each module's `index.ts` only. Errors are
`Result`-style, not thrown strings. Logging is pino, one logger per module;
message bodies are never logged above `debug`.

### Key design choices

- **Baileys, not whatsapp-web.js.** Speaks the multi-device protocol directly,
  no headless Chromium, so it runs light in Docker.
- **SQLite, not Postgres.** Single user, single process, append-mostly.
- **Summarizer is an adapter.** CLI adapters shell out to `claude -p` and
  friends; API adapters call vendor SDKs. Which one runs is config, not code.
- **Everything is idempotent.** Message redelivery is ignored, runs record a
  message-id watermark, and each delivery channel records what it sent.

Full constraints, conventions, and reasoning live in [`CLAUDE.md`](CLAUDE.md).

## Getting started

Requirements: Node 20.6+ and pnpm.

```bash
git clone git@github.com:vindimy/claude-wa-agent.git
cd claude-wa-agent
pnpm install

cp config.example.yaml config.yaml   # gitignored
cp .env.example .env                 # optional, gitignored
```

Edit `config.yaml` and put the JIDs of the groups you want ingested under
`groups:`. Don't know the JIDs yet? Start with the example file as-is, pair,
and read them off `digest groups` (next step).

```bash
pnpm dev
```

On first run a QR code prints in the terminal. On your phone open
**WhatsApp → Linked devices → Link a device** and scan it. Auth state is saved
to `./data/tenants/owner/auth/`, so subsequent runs reconnect without a QR.
(An install paired before the tenant layout existed had it in `./data/auth/`;
the first `digest run` moves it into place automatically.)

Once you see `connected` and `synced participating groups` in the log, open a
second terminal:

```bash
pnpm digest groups
```

```
[✓] 120363000000000001@g.us  Zouk Atoms team  messages: 42  last: 2026-09-03 17:55
[ ] 120363000000000002@g.us  Neighbours       messages: 0   last: —

[✓] = allow-listed in config.yaml; only these groups are ingested.
```

Copy the JIDs you want into `config.yaml` and restart `pnpm dev`. Only
allow-listed groups are ever stored; everything else is dropped at the socket.

### CLI

| Command              | What it does                                                         |
| -------------------- | -------------------------------------------------------------------- |
| `pnpm dev`           | Run the listener with hot reload (`digest run` under `tsx watch`)    |
| `pnpm digest run`    | Run the listener once, no reload                                     |
| `pnpm digest groups` | List every group the account is in, with allow-list mark and counts  |

| `pnpm digest summarize <group> --since 2d` | Summarize one group's stored messages and deliver to its channels |
| `pnpm digest summarize <group> --since 2d --dry-run` | Same, but only print; nothing is delivered |

`<group>` is a JID, the `name` from `config.yaml`, or the group subject as
WhatsApp shows it. `--since` takes `30m`, `12h`, `2d`, `1w`, or an ISO date.
Flags `--adapter`, `--style`, `--language`, `--max-words`, and `--tz` override
the group's config for one run.

A summary's identity is its window: the same group, start, and last message
map to the same summary id. Re-running the same window reuses the stored text
and retries only channels that have not been delivered, so the command is safe
to repeat. Pass `--fresh` to regenerate. Every attempt is recorded in `runs`
with the last message as a watermark.

#### Delivery channels

| Channel   | How it works                                                                          |
| --------- | ------------------------------------------------------------------------------------- |
| `vault`   | Written immediately as `<vault.dir>/<group-slug>/<date>-<id>.md` with YAML front matter |
| `self_dm` | Queued in the database; the running listener (`digest run`) sends it to your own number with 2–5 s jitter and the daily cap |
| `group`   | Not implemented yet (phase 5). Even with `deliver.group: true` nothing is posted.      |

Because the self-DM goes through the listener's outbox, `digest summarize` does
not need its own WhatsApp session and never conflicts with a running `digest
run`. If the listener is not running, the message waits in the queue until it
is. Sends are retried up to five times and then marked failed.

#### Summarizer adapters

| Adapter      | What it does                                                                    |
| ------------ | ------------------------------------------------------------------------------- |
| `cli-claude` | Spawns `claude -p` with the transcript on stdin: no tools, no session files, no settings pickup. Uses your existing CLI login. |
| `fake`       | Deterministic stats-only output with no external call. For tests and plumbing. |

The prompt asks for plain WhatsApp-friendly text, keeps the transcript's
Russian/English mix unless `summary.language` pins one, and hard-caps length at
`summary.max_words`. Per-adapter `model`, `timeout_seconds`, and `bin` live
under `summarizers:` in `config.yaml`.

### Environment

| Variable      | Default         | Purpose                                      |
| ------------- | --------------- | -------------------------------------------- |
| `CONFIG_PATH` | `./config.yaml` | Path to the YAML config                      |
| `DATA_DIR`    | `./data`        | SQLite DB (`digest.db`) and WhatsApp auth    |
| `VAULT_DIR`   | `config.vault.dir` (`./vault`) | Where Markdown notes are written |
| `LOG_LEVEL`   | `info`          | pino level: `trace` … `fatal`                |

A `.env` in the working directory is loaded automatically if present.

## Configuration

`config.yaml` is the source of truth. Every group inherits `defaults` and can
override any of `summarizer`, `cadence`, `deliver`, or `summary`.

```yaml
defaults:
  summarizer: cli-claude        # fake | cli-claude
  cadence: { type: daily, at: "08:00", tz: "America/Los_Angeles" }
  deliver: { self_dm: true, group: false, vault: true }
  summary: { language: auto, style: topics, max_words: 300 }

limits:
  max_sends_per_day: 30

ingest:
  media: false          # captions are stored; media is never downloaded

groups:
  - jid: "120363000000000001@g.us"
    name: "Zouk Atoms team"
    cadence: { type: threshold, messages: 150, max_hours: 24 }
    deliver: { group: true }        # explicit opt-in to post back into the group
  - jid: "120363000000000002@g.us"
    name: "Family"
    cadence: { type: weekly, day: sun, at: "18:00" }
    summary: { language: ru }
```

Cadence types: `daily`, `weekly`, `threshold` (N messages or M hours, whichever
comes first), `manual`. Cadences are validated now but only acted on from
phase 4.

**`deliver.group` defaults to `false` and must be set per group.** Posting a
summary into the wrong group is the worst failure mode of this project, so
there is no way to enable it globally.

## Data layout

```
data/                    # gitignored, never commit
├── tenants/
│   └── owner/
│       └── auth/        # WhatsApp multi-device session (treat as a secret)
└── digest.db            # SQLite, WAL mode; every table carries tenant_id
vault/                   # Markdown notes (config vault.dir); gitignored
```

Tables: `groups`, `messages` (per-group id, sender, timestamp, kind, body,
`edited_ts`, soft `deleted` flag), `summaries` (stable id, window, watermark,
text), `runs` (every attempt with status, cost, and watermark), and
`deliveries` (one row per summary and channel: `queued`, `sent`, or `failed`).
Every query is scoped by `tenant_id`; the store has no method that reads
across tenants. Schema changes are versioned migrations in `src/store/db.ts`.

Only one process may use a given tenant auth directory at a time. Never run
the host and Docker profiles against the same directory.

## Operational behaviour

- **Quiet observer.** No presence broadcast, no read receipts. The only sends
  are self-DM digests, and they go through one per-tenant outbox with 2–5 s
  jitter and a rolling 24-hour cap (`limits.max_sends_per_day`, default 30).
- **Reconnects** use exponential backoff with jitter, capped at 60 s.
- **Session state is explicit**: `connecting → pairing → connected`, with
  `reconnecting` and `logged_out` logged as transitions.
- **Logout (401)** stops that tenant's socket and logs at `fatal`. It never
  loops on QR generation. To re-pair: stop the process, delete
  `data/tenants/owner/auth/`, run again.
- **Edits and deletions** update the stored message, so future summaries reflect
  the latest state.

This uses an unofficial client on a personal account. Ban risk is real; the
agent is built to behave like a human who is simply present in the group.

## Development

```bash
pnpm test         # vitest: config schema, store, message extraction
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome
pnpm format       # biome --write
```

Tests run without a network or a paired device. The listener's message
classification is a pure function (`src/listener/extract.ts`) tested against
fixture payloads, and the summarizer's prompt building and output parsing are
tested against a bundled bilingual transcript
(`src/summarizer/__fixtures__/team-chat.json`). The one test that calls the
real `claude` binary is opt-in:

```sh
INTEGRATION=1 pnpm test                       # uses the CLI's default model
INTEGRATION=1 INTEGRATION_MODEL=haiku pnpm test
```

A `cli-claude` summary of the 25-message fixture costs about one cent on
sonnet. The adapter passes `--strict-mcp-config` so your MCP servers' tool
definitions do not ride along on every call; without it the same request was
roughly 25× more expensive.

Stack: TypeScript (strict), Node 20+, [Baileys](https://github.com/WhiskeySockets/Baileys) 7,
better-sqlite3, zod 4, pino, commander, vitest, biome.

## Roadmap

1. ✅ **Listen + store** — pair, ingest allow-listed groups, `digest groups`
2. ✅ **Summarize on demand** — `fake` and `cli-claude` adapters, `--dry-run`
3. ✅ **Deliver** to self-DM and Markdown vault with idempotent run records
4. **Scheduler** — daily / weekly / threshold cadences, restart-safe watermarks
5. **Group posting** (opt-in) behind the send queue and rate limits
6. **Docker profile** for a VPS, with CLI-auth mounting or API fallback
7. Nice-to-have: action items, `/ask <group> <question>`, local dashboard

Open questions to settle before phase 5 are listed in `CLAUDE.md`.

## License

Personal project, not currently licensed for reuse.
