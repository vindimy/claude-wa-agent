# Running the digest agent day to day

Day-2 operations for the Docker profile: starting and stopping, reading and
searching logs, changing which groups are summarized, and talking to the
agent. First-time setup (pairing, image pull, summarizer auth) is in
[deploy.md](deploy.md); this page assumes the container has paired once and
`docker compose up -d` works.

All commands run from the checkout directory on the VPS, where
`docker-compose.yml`, `config.yaml`, `.env`, `data/`, and `vault/` live.

The CLI inside the container is `node dist/cli/index.js`. Define this once
per shell and the examples below read naturally:

```bash
alias digest='docker compose exec digest node dist/cli/index.js'
```

Host-profile equivalents (pm2) are noted where they differ.

## Start, stop, restart

```bash
docker compose up -d            # start (or apply a changed image / .env)
docker compose ps               # is it running, since when, restart count
docker compose stop             # stop, keep the container
docker compose start            # start it again
docker compose restart digest   # stop + start in one step
docker compose down             # stop and remove the container (volumes stay)
```

What to expect:

- **Startup takes a few seconds.** Migrations run, then the socket connects
  using the saved session in `data/tenants/owner/auth/`. Watch for
  `session state` with `to: connected` followed by `synced participating
  groups`. No QR should appear; if one does, the session is gone (see
  "Re-pairing" below).
- **Shutdown is graceful.** SIGTERM stops the scheduler and outbox, closes the
  socket, and closes the database. Compose waits up to 20 s
  (`stop_grace_period`) so an in-flight send can finish. Do not `kill -9`
  unless it hangs past that.
- **The container restarts itself** after a crash or a host reboot
  (`restart: unless-stopped`). A deliberate `docker compose stop` sticks
  until you `start` it.
- **Only one instance per auth directory.** Never start a second container,
  a `pnpm dev`, or a host pm2 process against the same `data/`. WhatsApp
  drops the older session and the agent logs `logged out by WhatsApp`.

### Upgrade

```bash
docker compose pull && docker compose up -d
docker compose logs --since 2m digest      # confirm it came back connected
```

The session survives because the auth state lives in the volume. To pin a
release instead of tracking `latest`, set `DIGEST_IMAGE_TAG=0.1.0` in `.env`
before `up -d`. Roll back the same way with the previous tag.

### Re-pairing

Only needed after `logged out by WhatsApp` at `fatal` level, or when you
unlink the device from the phone on purpose:

```bash
docker compose down
mv data/tenants/owner/auth data/tenants/owner/auth.$(date +%Y%m%d)   # or rm -rf
docker compose run --rm digest run      # scan the QR, wait for connected, Ctrl-C
docker compose up -d
```

Watermarks and summaries are in the database, not the auth directory, so a
re-pair never re-summarizes a window that already ran.

### Host profile

`pm2 restart wa-digest`, `pm2 stop wa-digest`, `pm2 logs wa-digest`. Upgrade
is `git pull && pnpm install && pnpm build && pm2 restart wa-digest`.

## Logs

Logs go to stdout as one JSON object per line (pino). Docker keeps that
stream in five rotating 10 MB files, so about 50 MB is available through
`docker compose logs` at any time.

The container also writes the same lines to files under `data/logs/` on the
host (`LOG_DIR`, set to `/app/data/logs` in the image), which is the place to
look when scrolling the console is painful:

| File | Contents |
| --- | --- |
| `data/logs/app.<date>.<n>.log` | Everything at `LOG_LEVEL` and above |
| `data/logs/errors.<date>.<n>.log` | Only `warn`, `error`, and `fatal` |

Both roll over daily or at 20 MB, whichever comes first, and the newest 30
files of each are kept; older ones are deleted by the agent. The files are
plain JSON lines, so everything below that uses `docker compose logs
--no-log-prefix` also works with `cat data/logs/app.*.log`:

```bash
tail -f data/logs/errors.$(date +%F).*.log          # watch for problems only
cat data/logs/errors.*.log | jq -r '"\(.time/1000 | todate) \(.module) \(.msg)"'
```

Set `LOG_DIR=` (empty) in `.env` to turn the files off. On the host profile
the variable is unset by default because pm2 already keeps `~/.pm2/logs/`;
set it there too if you want the separate error file.

```bash
docker compose logs -f digest                      # follow
docker compose logs --since 1h digest              # last hour
docker compose logs --since 2026-09-04T08:00:00 digest
docker compose logs --tail 200 digest
docker compose logs -t digest                      # prefix Docker's own timestamp
```

### Reading JSON lines

Every line carries `level` (pino numeric: 30 info, 40 warn, 50 error,
60 fatal), `time` (epoch ms), `module`, `msg`, and `tenant_id` on anything
tenant-scoped. Use `--no-log-prefix` so the lines are valid JSON, then `jq`:

```bash
# human-readable stream
docker compose logs --no-log-prefix -f digest \
  | jq -r '"\(.time/1000 | todate) \(.level) \(.module) \(.msg)"'

# only warnings and above, with the structured fields
docker compose logs --no-log-prefix --since 24h digest \
  | jq -c 'select(.level >= 40)'

# one module
docker compose logs --no-log-prefix --since 24h digest \
  | jq -c 'select(.module == "outbox")'

# everything about one group
docker compose logs --no-log-prefix --since 7d digest \
  | jq -c 'select(.group == "1203630XXXXXXXX@g.us" or (.groups // [] | index("1203630XXXXXXXX@g.us")))'
```

Plain `grep` also works because `msg` strings are stable. If `jq` is not on
the VPS, `apt install jq`.

### Messages worth knowing

| `module` | `msg` | Meaning |
| --- | --- | --- |
| `listener` | `session state` | Transition; `to: connected` is healthy, `to: reconnecting` is transient |
| `listener` | `synced participating groups` | Group list refreshed after connect; a `digest groups` run now shows everything |
| `listener` | `disconnected, reconnecting` (warn) | Socket dropped; backoff reconnect is in progress |
| `listener` | `logged out by WhatsApp …` (fatal) | Session revoked; the tenant is paused until re-paired |
| `listener` | `owner command received` | You sent `/digest` or `/help` in the self-chat |
| `scheduler` | `scheduled digest due` | A cadence fired for a group |
| `scheduler` | `owner command` | The command was parsed; lists target groups |
| `scheduler` | `pruned old messages` | Hourly retention sweep removed rows |
| `digest` | `summarizing` / `summary generated and recorded` / `reusing stored summary` | One run; carries adapter, message count, duration, cost |
| `summarizer:*` | (info line with `model`, `messages`, `chars`) | The adapter call itself |
| `delivery` | `wrote vault note` / `queued self-DM` / `queued group post` | Fan-out after a summary |
| `delivery` | `vault write failed` (error) | Usually a permissions problem on `vault/` |
| `outbox` | `sent` | A WhatsApp message left the queue; `target` says where |
| `outbox` | `daily send cap reached, holding queue` (warn) | `limits.max_sends_per_day` hit; the queue drains after the window |
| `outbox` | `send failed` / `dropped` (warn) | Retries exhausted or the target is no longer allowed |

A healthy day looks like: a handful of `scheduled digest due` lines, each
followed within a minute or two by `summary generated and recorded`, `wrote
vault note`, `queued self-DM`, and then `sent`.

### Turning up detail

Set `LOG_LEVEL=debug` in `.env` and `docker compose up -d` (recreates the
container with the new environment). Debug adds every stored, edited, and
deleted message id and the summarizer prompt. **Debug lines contain message
bodies.** Switch back to `info` when done; the log files are on disk in
plain text.

Docker's own copy of the stream, if you need it outside `data/logs/`:

```bash
docker inspect --format='{{.LogPath}}' wa-digest
```

### Analysis across days

The rolled files are a small dataset. DuckDB reads them all at once:

```sql
select module, msg, count(*) as n
from read_json_auto('data/logs/app.*.log')
where level >= 40
group by 1, 2 order by n desc;
```

## Group configuration

`config.yaml` on the host is bind-mounted read-only into the container and
**read once at startup**. Every change below ends with a recreate, not a
restart:

```bash
docker compose up -d --force-recreate digest
```

Why recreate: editors that save by writing a new file and renaming it (vim,
most GUI editors) give `config.yaml` a new inode. The running container's
mount still points at the old one, and `docker compose restart` does not
remount. `--force-recreate` does. On the host profile a plain
`pm2 restart wa-digest` is enough.

### Validate before applying

`schedule` loads the config and exits, so a fresh one-off container is a
free syntax and schema check against the file as it is on disk:

```bash
docker compose run --rm digest schedule
```

A bad file prints `config at /app/config.yaml is invalid:` with the zod
path. The running container is untouched. Common rejections:
`defaults.deliver.group: true` (never allowed), a `jid` not ending in
`@g.us`, an `at:` that is not `HH:MM`, `retention.days` outside
30/60/90/180.

### Find a group's JID

```bash
digest groups
```

Lists every group the account participates in, with `[✓]` on the ones in
`config.yaml`, plus message counts and the last message time for those. Only
allow-listed groups are ingested; the others are listed so you can copy
their JID.

### Add a group

Append to `groups:` in `config.yaml`. Only `jid` is required; everything
else inherits from `defaults`:

```yaml
groups:
  - jid: "120363012345678901@g.us"
    name: "Dance planning"                     # used in notes, replies, and as a command alias
    cadence: { type: weekly, day: fri, at: "17:00", tz: "America/Los_Angeles" }
    summary: { language: en, style: action-items, max_words: 200 }
```

Then validate and recreate. Ingestion starts when the new container
connects. WhatsApp may replay some recent history on reconnect and the
agent stores it, but do not count on a backfill: the first digest covers
what arrives from now on. The first scheduled run for a new group uses the
cadence's own window (one day for `daily`, one week for `weekly`, the
`max_hours` span for `threshold`).

### Change a group

Edit the entry, validate, recreate. Things that carry over safely:

- **Cadence changes** do not re-summarize. The watermark (last summarized
  message) stays, and the next run picks up from it.
- **Renaming** (`name:`) changes the vault folder for future notes
  (`vault/<slug>/…`), the header of self-DM and group posts, and the alias
  you type in `/digest <name>`. Old notes stay where they are.
- **Switching the summarizer** takes effect on the next run. See
  "Summarizer adapters" below.

### Opt a group into posting

```yaml
  - jid: "120363012345678901@g.us"
    name: "Dance planning"
    deliver: { group: true }
```

This is the one setting to double-check before recreating. With it,
scheduled digests are posted into that group signed `🤖 Auto-digest`. It
cannot be set in `defaults`, on-demand runs (`/digest`, `digest summarize`)
still stay private unless `--post` is given, posts into the same group are
spaced by `limits.min_group_post_gap_minutes`, and every send counts toward
`limits.max_sends_per_day`. Confirm with `digest schedule`, which prints
`deliver: … GROUP POST` for the group.

### Remove a group

Delete its entry, validate, recreate. From then on its messages are ignored
and its cadence no longer fires. Rows already stored are pruned by the
normal retention sweep (`retention.days`, 30 by default); summaries, run
records, and vault notes are kept. To silence a group without dropping its
history, set `cadence: { type: manual }` instead.

### Check the schedule

```bash
digest schedule
```

Per group: the effective cadence, delivery channels, last run with trigger
and status, the watermark, pending message count for `threshold` cadences,
and whether a digest is due right now with the reason. This is the first
thing to run when "the digest did not arrive".

## Talking to the agent

### From WhatsApp (self-chat)

Open your own chat in WhatsApp (the "You" contact) and send, while the
container is up:

| Message | Effect |
| --- | --- |
| `/digest` | Every allow-listed group since its last digest |
| `/digest 3d` | Every group over the last 3 days |
| `/digest Family` | One group since its last digest |
| `/digest "Zouk team" 12h` | One group, explicit window (`30m`, `12h`, `2d`, `1w`, or an ISO date) |
| `/help` | The command list and the configured groups |

The group can be its JID, its configured `name` (case-insensitive), or any
unique substring of the name. Replies come back in the same self-chat
through the outbox, so expect a few seconds of jitter, and a run that takes
a while (large window, slow adapter) answers when it finishes. A group with
nothing new replies `<group>: no new messages`. Commands never post into a
group. Only messages you type live count; history sync is ignored.

Each `/digest` reply is also written to the vault and recorded as a run
with trigger `command`, so it advances the watermark like a scheduled run.

### From the shell

```bash
digest summarize "Family" --since 2d --dry-run          # print only; stored, not delivered
digest summarize "Family" --since 2d                    # deliver to the group's configured channels
digest summarize "Family" --since 2d --fresh            # regenerate even if this window was summarized
digest summarize "Family" --since 12h --style action-items --language en --max-words 150
digest summarize "Family" --since 2d --adapter api-anthropic
digest summarize "Dance planning" --since 1w --post     # also post into the group (needs deliver.group: true)
```

`<group>` accepts a JID, the configured name, or the WhatsApp subject.
`--dry-run` still stores the summary, so a later real run over the same
messages reuses it (`--fresh` overrides). Vault notes are written directly
by the command; WhatsApp sends are queued for the running container to
deliver, and the output says which happened per channel.

### Fetching summaries you already have

Three places hold every summary; pick by convenience.

**The vault** is the intended archive. One Markdown file per summary with
front matter (group, window, adapter, message count):

```
vault/<group-slug>/<YYYY-MM-DD>-<summary-id>.md
```

```bash
ls -t vault/family/ | head                       # newest first
grep -ril "visa" vault/                          # full-text across all groups
find vault -name '2026-09-*.md' | sort           # one month, all groups
```

Point Obsidian or any Markdown tool at `vault/` for browsing.

**The self-chat** in WhatsApp keeps every self-DM digest and command reply
in the normal message history, searchable with WhatsApp's own search.

**The database** answers "what ran, when, and what did it cost". The image
does not ship a `sqlite3` binary, so query from the host against the volume.
The database is in WAL mode, so reads while the container runs are safe;
open it read-only anyway:

```bash
sqlite3 -readonly -header -column data/digest.db "
  SELECT datetime(created_ts,'unixepoch') AS at, group_jid, adapter, model,
         message_count AS msgs, substr(text,1,80) AS preview
  FROM summaries ORDER BY created_ts DESC LIMIT 10;"

sqlite3 -readonly -header -column data/digest.db "
  SELECT datetime(created_ts,'unixepoch') AS at, group_jid, trigger, status,
         round(cost_usd,4) AS usd, duration_ms, error
  FROM runs ORDER BY created_ts DESC LIMIT 20;"

sqlite3 -readonly -header -column data/digest.db "
  SELECT channel, target, status, attempts, error, datetime(created_ts,'unixepoch') AS at
  FROM deliveries WHERE status != 'sent' ORDER BY created_ts DESC;"
```

The full text is in `summaries.text`; the last query shows anything stuck
in the outbox. Never write to the database by hand while the container is
running.

### Asking the agent questions

Not available yet. Today the agent only produces digests; there is no
`/ask <group> <question>` over stored history. The nearest substitute is a
dry run with a narrower style and window:

```bash
digest summarize "Family" --since 3d --style action-items --dry-run
```

Q&A over history is on the roadmap (see the README).

## Summarizer adapters

Five adapters exist today:

| Adapter | Auth in Docker | Notes |
| --- | --- | --- |
| `cli-claude` | `CLAUDE_CODE_OAUTH_TOKEN` in `.env` | Default. Owner-only (ADR 0003) |
| `api-anthropic` | `ANTHROPIC_API_KEY` in `.env` | Default model `claude-opus-5`; `claude-sonnet-5` is about a fifth of the cost |
| `api-openai` | `OPENAI_API_KEY` in `.env` | Default model `gpt-5.6-terra`; `gpt-5.6-luna` is about a tenth of the cost |
| `api-google` | `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) in `.env` | Default model `gemini-3.8-flash`; `gemini-3.1-pro-preview` for the larger model |
| `fake` | none | Deterministic stats; for plumbing checks |

All three API adapters run the same prompt, honour `summary.language`
(English by default), respect `summary.max_words`, and write a cost estimate into
`runs.cost_usd` from the vendor's published per-token prices (null for a
model not in the table). The config loader rejects an unknown adapter name
at the first run with `unknown summarizer "…" (available: fake, cli-claude,
api-anthropic, api-openai, api-google)`.

### Choosing an adapter per group

Adapters can already be mixed across groups. Resolution order, most
specific wins:

1. `--adapter <name>` on a `digest summarize` command (that run only).
2. `SUMMARIZER=<name>` in `.env`: forces one adapter for **every** group and
   ignores the per-group setting. This is the Docker fallback switch; leave
   it unset when you want per-group choice.
3. `summarizer:` on the group entry.
4. `defaults.summarizer`.

```yaml
defaults:
  summarizer: cli-claude

summarizers:                     # per-adapter options; all keys optional
  cli-claude:
    model: sonnet                # CLI alias or full model id
    timeout_seconds: 180
  api-anthropic:
    model: claude-sonnet-5
    timeout_seconds: 180

groups:
  - jid: "1203630XXXXXXXX@g.us"
    name: "Zouk Atoms team"      # inherits cli-claude
  - jid: "1203630YYYYYYYY@g.us"
    name: "Family"
    summarizer: api-anthropic    # this group pays per token instead
```

All auth variables can be present in `.env` at the same time; each adapter
reads only its own. `api-openai` and `api-google` slot into the same
`summarizers:` map and `summarizer:` key with `OPENAI_API_KEY` and
`GOOGLE_API_KEY`, so a group can be moved between vendors by changing one
line.

## When something is off

Run these three before reading logs:

```bash
docker compose ps                 # running? restart count climbing?
digest schedule                   # is the group due, when did it last run, what status?
docker compose logs --no-log-prefix --since 24h digest | jq -c 'select(.level >= 40)'
```

Known failure modes and their fixes are listed at the end of
[deploy.md](deploy.md).
