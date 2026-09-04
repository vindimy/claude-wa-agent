# claude-wa-agent

A long-running agent that listens to selected WhatsApp groups through your own
linked device, stores messages locally in SQLite, and produces per-group
summaries on a schedule using locally authenticated AI CLIs (`claude`,
`gemini`, `codex`). Summaries go to a self-DM, a local Markdown vault, and
(opt-in only) back into the group.

Self-hosted, all data stays on disk. Built tenant-keyed from the start: today
it runs with a single tenant (`owner`), so it can grow into a bring-your-own-
account service later without a rewrite (see `CLAUDE.md` and `docs/adr/`).

> **Project status: phase 4 of 7 (scheduler).** The agent pairs, ingests
> allow-listed groups into SQLite, summarizes on a daily, weekly, or
> message-count cadence (or on demand via `/digest` in your own chat), and
> delivers to your WhatsApp self-chat and a Markdown vault. No
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
| `src/summarizer/`| Adapter interface; `fake`, `cli-claude`, `cli-gemini`, `cli-codex`, `api-anthropic`, `api-openai`, `api-google` | ✅ done |
| `src/delivery/`  | Idempotent fan-out: self-DM, Markdown vault, and opt-in group post through one outbox | ✅ done |
| `src/scheduler/` | Daily / weekly / threshold triggers, `/digest` commands, restart-safe watermarks | ✅ done |

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

### Run with Docker (fewest steps)

Prebuilt images are published to `ghcr.io/vindimy/claude-wa-agent` on every
push to `main` and on every `v*` tag. On a machine with Docker:

```bash
git clone git@github.com:vindimy/claude-wa-agent.git && cd claude-wa-agent
cp config.example.yaml config.yaml   # allow-list your groups
cp .env.example .env                 # PUID/PGID, TZ, and one summarizer auth option
mkdir -p data vault
docker compose pull
docker compose run --rm digest run   # scan the QR, wait for "connected", Ctrl-C
docker compose up -d
```

The summarizer needs either `CLAUDE_CODE_OAUTH_TOKEN` (from `claude
setup-token`, owner-only) or `SUMMARIZER=api-anthropic` with
`ANTHROPIC_API_KEY` in `.env`. Pin a version with `DIGEST_IMAGE_TAG=0.1.0`.
Everything else, including logging in to a private package, is in
[`docs/deploy.md`](docs/deploy.md).

### Run from source

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
| `pnpm digest summarize <group> --since 2d --post` | Same, and also post into the group if it has `deliver.group: true` |
| `pnpm digest schedule` | Show each group's cadence, last run, watermark, and whether it is due now |
| `pnpm digest ask <group> "<question>" [--since 1w]` | Answer a question from the group's stored messages; printed, never sent |
| `pnpm digest dashboard [--port 8787]` | Serve the read-only web dashboard from this shell |

`<group>` is a JID, the `name` from `config.yaml`, or the group subject as
WhatsApp shows it. `--since` takes `30m`, `12h`, `2d`, `1w`, or an ISO date.
Flags `--adapter`, `--style`, `--language`, `--max-words`, `--personality`,
`--instructions`, and `--tz` override
the group's config for one run.

A summary's identity is its window: the same group, start, and last message
map to the same summary id. Re-running the same window reuses the stored text
and retries only channels that have not been delivered, so the command is safe
to repeat. Pass `--fresh` to regenerate. Every attempt is recorded in `runs`
with the last message as a watermark.

#### Asking questions

`digest ask` and the `/ask` self-chat command answer a question from the
messages stored for one group. The whole retention window is used unless
`--since` (or a window token after the group name) narrows it. The model is
told to use only the transcript, to say plainly when the answer is not there,
and to reply in the language of the question; the group's `personality` and
`instructions` apply, so context like "Baba is grandma" carries over. Every
question is recorded in `questions` with cost and status. Answers are private:
printed by the CLI or queued as a self-DM, never posted into a group, and they
never move a digest watermark.

#### Delivery channels

| Channel   | How it works                                                                          |
| --------- | ------------------------------------------------------------------------------------- |
| `vault`   | Written immediately as `<vault.dir>/<group-slug>/<date>-<id>.md` with YAML front matter |
| `self_dm` | Queued in the database; the running listener (`digest run`) sends it to your own number with 2–5 s jitter and the daily cap |
| `group`   | Opt-in per group. Queued like a self-DM, posted by the listener, signed "🤖 Auto-digest" with a footer saying a bot wrote it |

Because WhatsApp sends go through the listener's outbox, `digest summarize` does
not need its own WhatsApp session and never conflicts with a running `digest
run`. If the listener is not running, the message waits in the queue until it
is. Sends are retried up to five times and then marked failed.

#### Group posting

A summary posted into the wrong group is the worst thing this project can do,
so posting is gated three times:

1. **Config, per group.** `deliver.group: true` must be set on the group
   itself. Setting it under `defaults:` is a config error.
2. **Trigger.** Scheduled runs (daily, weekly, threshold) post. On-demand runs
   stay private: `digest summarize` needs `--post`, and `/digest` from the
   self-chat never posts. A quick check should not surprise the group.
3. **Send time.** The outbox re-checks the group's opt-in and that the target
   is a group JID before every post, so a queued post is dropped if you turn
   the flag off and restart.

Posts share the daily send cap with self-DMs and the same 2–5 s jitter. Two
posts into the same group are spaced by `limits.min_group_post_gap_minutes`
(default 60); a held post does not block self-DMs behind it.

### Scheduling

`digest run` evaluates every configured group once a minute:

| Cadence     | Fires when                                                                 |
| ----------- | -------------------------------------------------------------------------- |
| `daily`     | The `at` time in `tz` has passed and no scheduled run exists for that occurrence |
| `weekly`    | Same, for the given `day`                                                  |
| `threshold` | At least `messages` new messages since the watermark, or any new messages and `max_hours` elapsed |
| `manual`    | Never; only `digest summarize` or `/digest`                                |

The decision is made from the database, not from memory: each run records the
last message it covered as a watermark, and the next window starts right after
it. A restart cannot double-summarize, and a process that was down at 08:00
catches up when it comes back. A group first seen after today's slot waits for
tomorrow's. If the summarizer fails, the slot is retried after 30 minutes, up
to three times. Empty windows are recorded too, so they do not re-fire.

### Commands in your own chat

Send these to yourself (the "You" chat in WhatsApp) while `digest run` is up:

```
/digest                 every group since its last digest
/digest 3d              every group over the last 3 days
/digest Family          one group since its last digest
/digest "Zouk team" 12h one group, explicit window
/ask Family when is the dacha trip?      answer from everything stored
/ask Family 2w who is bringing the cake? answer from the last two weeks
/help                   list commands and groups
```

Replies always come back as a self-DM, even for groups with `self_dm: false`,
and neither `/digest` nor `/ask` ever posts into the group. Only live messages you send are
treated as commands; history sync is ignored.

#### Summarizer adapters

| Adapter      | What it does                                                                    |
| ------------ | ------------------------------------------------------------------------------- |
| `cli-claude` | Spawns `claude -p` with the transcript on stdin: no tools, no session files, no settings pickup. Uses your existing CLI login. Owner-only. |
| `cli-gemini` | Spawns `gemini -p` headless with JSON output: no extensions, read-only tools, the digest system prompt replaces the CLI's own via `GEMINI_SYSTEM_MD`, neutral cwd so no `GEMINI.md` leaks in. Uses your Google-account login (or `GEMINI_API_KEY`). Owner-only. |
| `cli-codex`  | Spawns `codex exec --json` ephemeral and read-only, ignoring `~/.codex/config.toml` and `.rules`, prompt on stdin. Uses your ChatGPT login (`codex login`). Owner-only. |
| `api-anthropic` | Calls the Anthropic Messages API with `ANTHROPIC_API_KEY`. Default model `claude-opus-5`; set `summarizers.api-anthropic.model` to `claude-sonnet-5` for a cheaper run. Server-side refusal fallbacks are on. |
| `api-openai` | Calls the OpenAI Responses API with `OPENAI_API_KEY`. Default model `gpt-5.6-terra`; `gpt-5.6-luna` is about a tenth of the cost, `gpt-5.6-sol` the flagship. Responses are not stored on OpenAI's side. |
| `api-google` | Calls the Gemini API with `GOOGLE_API_KEY` (or `GEMINI_API_KEY`). Default model `gemini-3.8-flash`; `gemini-3.1-pro-preview` for the larger model. Thinking tokens are billed as output and counted in the cost estimate. |
| `fake`       | Deterministic stats-only output with no external call. For tests and plumbing. |

The prompt asks for plain WhatsApp-friendly text, writes in English unless
`summary.language` says otherwise (`ru`, or `auto` to keep the transcript's
Russian/English mix), and hard-caps length at `summary.max_words`. Per-adapter `model`, `timeout_seconds`, and `bin` live
under `summarizers:` in `config.yaml`. `SUMMARIZER=<adapter>` in the
environment forces one adapter for every group without editing the file.

#### Voice and instructions

Two more `summary` keys shape the text without touching the facts:

- `personality` picks a voice. Presets: `neutral` (default), `dry`, `friendly`,
  `russian-sarcasm` (deadpan Moscow-kitchen irony, written in English),
  `executive`, `newsroom`, `butler`, `hype`. Define your own in plain English
  under a top-level `personalities:` map and reference it by name; a custom
  entry with a preset's name replaces that preset. An unknown name is a config
  error at startup, listed with the available names.
- `instructions` is free-form plain-English guidance ("always flag deadlines",
  "Baba is grandma"). The `defaults` text applies to every group and a group's
  own text is appended to it, so global rules survive per-group additions.

Both go into the system prompt after the fixed rules, with a guard that tone
never changes, omits, or exaggerates a fact. `digest summarize --personality
<name> --instructions "<text>" --dry-run --fresh` previews a voice on real
messages (`--fresh` because a stored summary for the same window is reused).

### Dashboard

A read-only page for "is it healthy, is anything stuck, what did it cost".
It shows the session state, the send budget for the day, every configured
group with its schedule, stored message count, activity over the last two
weeks and whether a digest is due, then recent runs, summaries with their
delivery status, questions, and the outbox. It refreshes itself every 30 s.

Off by default. Turn it on with `dashboard.enabled: true` in `config.yaml`
or `DASHBOARD_PORT=8787` in the environment, restart `digest run`, and open
`http://127.0.0.1:8787`. `digest dashboard` serves the same page from any
shell against the shared database without restarting the listener; the
session state then reads "not available". There is no login and nothing on
the page can send, summarize, or change config, so keep it on loopback (the
default) or behind an SSH tunnel: `ssh -L 8787:127.0.0.1:8787 vps`.

### Environment

| Variable      | Default         | Purpose                                      |
| ------------- | --------------- | -------------------------------------------- |
| `CONFIG_PATH` | `./config.yaml` | Path to the YAML config                      |
| `DATA_DIR`    | `./data`        | SQLite DB (`digest.db`) and WhatsApp auth    |
| `VAULT_DIR`   | `config.vault.dir` (`./vault`) | Where Markdown notes are written |
| `LOG_LEVEL`   | `info`          | pino level: `trace` … `fatal`                |
| `LOG_DIR`     | unset (Docker: `/app/data/logs`) | Also write rolling JSON log files: `app.*` (all) and `errors.*` (warn+) |
| `SUMMARIZER`  | from config     | Force one adapter for every group (`cli-claude`, `cli-gemini`, `cli-codex`, `api-anthropic`, `api-openai`, `api-google`, `fake`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | Headless login for `cli-claude`, from `claude setup-token`. Owner-only. |
| `GOOGLE_GENAI_USE_GCA` | unset | `true` makes `cli-gemini` use the Google-account login in `~/.gemini/oauth_creds.json` (Docker: `./data/home/.gemini/`). Owner-only. |
| `ANTHROPIC_API_KEY` | unset     | Key for `api-anthropic`                       |
| `OPENAI_API_KEY` | unset        | Key for `api-openai`                          |
| `GOOGLE_API_KEY` | unset        | Key for `api-google` (`GEMINI_API_KEY` also works) |
| `TZ`          | system          | Fallback time zone for cadences without `tz` (set it in Docker) |
| `DASHBOARD_PORT` | unset        | Turns the dashboard on and sets its port (overrides `dashboard.port`) |
| `DASHBOARD_HOST` | `dashboard.host` (`127.0.0.1`) | Bind address; the Docker profile sets `0.0.0.0` inside the container |

A `.env` in the working directory is loaded automatically if present.

## Configuration

`config.yaml` is the source of truth. Every group inherits `defaults` and can
override any of `summarizer`, `cadence`, `deliver`, or `summary`.

```yaml
defaults:
  summarizer: cli-claude        # fake | cli-claude | cli-gemini | cli-codex | api-anthropic | api-openai | api-google
  cadence: { type: daily, at: "08:00", tz: "America/Los_Angeles" }
  deliver: { self_dm: true, group: false, vault: true }
  summary:
    language: en                # auto keeps the chat's mix
    style: topics
    max_words: 300
    personality: neutral        # or dry | friendly | russian-sarcasm | executive | newsroom | butler | hype
    instructions: "Always call out deadlines and money."

personalities:                  # custom voices, plain English, referenced by name
  grumpy-uncle: "A grumpy but loving uncle who gets every fact right anyway."

limits:
  max_sends_per_day: 30

ingest:
  media: false          # captions are stored; media is never downloaded

dashboard:
  enabled: false        # read-only web page; DASHBOARD_PORT=8787 also turns it on
  host: 127.0.0.1
  port: 8787

groups:
  - jid: "120363000000000001@g.us"
    name: "Zouk Atoms team"
    cadence: { type: threshold, messages: 150, max_hours: 24 }
    deliver: { group: true }        # explicit opt-in to post back into the group
  - jid: "120363000000000002@g.us"
    name: "Family"
    cadence: { type: weekly, day: sun, at: "18:00" }
    summary: { language: ru, personality: friendly, instructions: "Baba is grandma." }
```

Cadence types: `daily`, `weekly`, `threshold` (N messages or M hours, whichever
comes first), `manual`.

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
text), `runs` (every attempt with status, cost, and watermark),
`deliveries` (one row per summary and channel: `queued`, `sent`, or `failed`),
and `questions` (every `/ask` with its answer, cost, and status).
Every query is scoped by `tenant_id`; the store has no method that reads
across tenants. Schema changes are versioned migrations in `src/store/db.ts`.

Raw messages are kept for `retention.days` (30 by default; 60, 90, or 180
allowed) and pruned hourly by the running scheduler. Summaries, run records,
and vault notes are never pruned, so the digests outlive their sources.

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

## Deployment

Two profiles run the same code:

- **host** (Mac mini, primary): `pnpm build` then run `node dist/cli/index.js run`
  under pm2 or launchd. The `claude`, `gemini`, and `codex` CLIs are already
  logged in, so the `cli-*` adapters work as-is.
- **docker** (VPS, also the future service profile): `docker compose up -d`
  pulls `ghcr.io/vindimy/claude-wa-agent` and mounts `./data`, `./vault`, and
  `config.yaml`. The image installs the `claude`, `gemini`, and `codex`
  CLIs; authenticate `claude` with `CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token`, the other two through credentials in `./data/home/`,
  or set `SUMMARIZER=api-anthropic` plus `ANTHROPIC_API_KEY` to skip the
  CLIs entirely. CI builds amd64 and arm64 images on every push to `main` and
  tags them by version on `v*` tags.

Never run both profiles against the same `data/` directory. Step-by-step
instructions, pairing inside the container, and the failure modes we know
about are in [`docs/deploy.md`](docs/deploy.md). Day-2 operations (start,
stop, upgrade, log search, editing groups, commands, fetching past
summaries) are in [`docs/run.md`](docs/run.md).

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
4. ✅ **Scheduler** — daily / weekly / threshold cadences, `/digest`, restart-safe watermarks
5. ✅ **Group posting** (opt-in) behind the send queue and rate limits
6. ✅ **Docker profile** for a VPS, with headless CLI auth or the `api-anthropic` fallback
7. ✅ **OpenAI and Gemini adapters** — `api-openai` and `api-google`, then `cli-gemini` and `cli-codex`, mixable per group
8. ✅ **Q&A and dashboard** — `/ask <group> <question>` over stored history, read-only local web dashboard
9. Nice-to-have: action-item extraction as its own output

Design decisions are recorded in `docs/adr/`.

## License

Personal project, not currently licensed for reuse.
