# claude-wa-agent

A long-running agent that listens to selected WhatsApp groups through your own
linked device, stores messages locally in SQLite, and produces per-group
summaries on a schedule using locally authenticated AI CLIs (`claude`,
`gemini`, `codex`). Summaries go to a self-DM, a local Markdown vault, and
(opt-in only) back into the group.

Single-user, self-hosted, all data stays on disk. Not a SaaS.

> **Project status: phase 2 of 7 (summarize on demand).** The agent pairs,
> ingests allow-listed groups into SQLite, and can summarize any stored window
> with `digest summarize … --dry-run`. Summaries are printed only; no
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
| `src/cli/`       | `digest run`, `digest groups`                                          | ✅ done |
| `src/summarizer/`| Adapter interface; `fake` and `cli-claude` shipped, `cli-gemini`, `cli-codex`, `api-*` later | done    |
| `src/delivery/`  | Idempotent fan-out: self-DM, Markdown vault, group post               | phase 3 |
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
to `./data/auth/`, so subsequent runs reconnect without a QR.

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

| `pnpm digest summarize <group> --since 2d --dry-run` | Summarize one group's stored messages and print the result |

`<group>` is a JID, the `name` from `config.yaml`, or the group subject as
WhatsApp shows it. `--since` takes `30m`, `12h`, `2d`, `1w`, or an ISO date.
Flags `--adapter`, `--style`, `--language`, `--max-words`, and `--tz` override
the group's config for one run. Without `--dry-run` the command refuses to run
until delivery lands in phase 3.

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
├── auth/                # WhatsApp multi-device session (treat as a secret)
└── digest.db            # SQLite, WAL mode
```

Tables so far: `groups` (jid, subject, participant count, first/last seen) and
`messages` (per-group id, sender, timestamp, kind, body, `edited_ts`, soft
`deleted` flag). Schema changes are versioned migrations in `src/store/db.ts`.

Only one process may use a given `data/auth/` at a time. Never run the host
and Docker profiles against the same directory.

## Operational behaviour

- **Quiet observer.** No presence broadcast, no read receipts, no sends in
  phase 1. Later phases route all sends through one queue with 2–5 s jitter and
  a daily cap.
- **Reconnects** use exponential backoff with jitter, capped at 60 s.
- **Logout (401)** stops the listener and logs at `fatal`. It never loops on QR
  generation. To re-pair: stop the process, delete `data/auth/`, run again.
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
3. **Deliver** to self-DM and Markdown vault with idempotent run records
4. **Scheduler** — daily / weekly / threshold cadences, restart-safe watermarks
5. **Group posting** (opt-in) behind the send queue and rate limits
6. **Docker profile** for a VPS, with CLI-auth mounting or API fallback
7. Nice-to-have: action items, `/ask <group> <question>`, local dashboard

Open questions to settle before phase 5 are listed in `CLAUDE.md`.

## License

Personal project, not currently licensed for reuse.
