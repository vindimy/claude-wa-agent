# Deploying the digest agent

Two profiles, one codebase. Both read the same `config.yaml`, keep state in
`data/`, and write notes to `vault/`. **Only one of them may be linked to a
given `data/tenants/<tenant>/auth/` at a time**: a second linked instance
kicks the first off the session.

| | host (Mac mini) | docker (VPS) |
| --- | --- | --- |
| Process manager | pm2 or launchd | `docker compose`, `restart: unless-stopped` |
| `claude` CLI auth | already logged in on the machine | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` |
| API fallback | `SUMMARIZER=api-anthropic` + `ANTHROPIC_API_KEY` | same |
| Time zone | the OS | `TZ` in `.env`; cadences with an explicit `tz` ignore it |

## Host profile (pm2)

```bash
pnpm install
pnpm build                      # compiles to dist/, tests excluded
cp config.example.yaml config.yaml && $EDITOR config.yaml
node dist/cli/index.js run      # first run prints the QR; scan, wait for "connected", Ctrl-C
pm2 start "node dist/cli/index.js run" --name wa-digest --time
pm2 save && pm2 startup         # print the launchd/systemd line and run it
```

`pnpm dev` (tsx with hot reload) is for development only. Do not leave it
running alongside pm2: it is a second linked instance.

Upgrade: `git pull && pnpm install && pnpm build && pm2 restart wa-digest`.
Migrations run on startup.

## Docker profile

### 1. Prepare the directory on the VPS

```bash
git clone git@github.com:vindimy/claude-wa-agent.git && cd claude-wa-agent
cp config.example.yaml config.yaml && $EDITOR config.yaml
cp .env.example .env && $EDITOR .env
mkdir -p data vault && sudo chown -R 1000:1000 data vault   # container runs as uid 1000
```

Set `TZ` in `.env` to the zone you think in; cadences without their own `tz`
use it.

### 2. Pick how the summarizer authenticates

**Option A, owner's Claude subscription (headless CLI).** On any machine where
`claude` is logged in:

```bash
claude setup-token
```

Copy the token into `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`. The container's
`claude -p` uses it; nothing from `~/.claude` needs to be mounted. This is the
owner-only path (see ADR 0003): keep the token out of git and off any other
tenant's config.

Why not bind-mount `~/.claude`? On macOS the CLI keeps credentials in the
Keychain, so the directory carries no login. On Linux the file exists but is
tied to that machine's install and rotates. The token is portable and
revocable, which is what a container wants.

**Option B, API key.** Put in `.env`:

```
SUMMARIZER=api-anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

`SUMMARIZER` forces the adapter for every group, so `config.yaml` can stay
identical between profiles. The default model is `claude-opus-5`; set
`summarizers.api-anthropic.model: claude-sonnet-5` in `config.yaml` for about
a fifth of the cost per digest.

Option A can also be used on the host and option B in Docker, or the other
way round. Nothing else changes.

### 3. Build and pair

```bash
docker compose build
docker compose run --rm digest run
```

The QR prints in the terminal. Scan it from **WhatsApp → Linked devices**,
wait for `session state ... to: connected` and `synced participating groups`,
then Ctrl-C. Auth state is now in `./data/tenants/owner/auth/`.

If the QR is too dense for the terminal, make the window taller or lower the
font size; the code is a normal WhatsApp Web QR and expires after about a
minute, at which point a fresh one prints.

### 4. Run

```bash
docker compose up -d
docker compose logs -f digest
docker compose exec digest node dist/cli/index.js groups
docker compose exec digest node dist/cli/index.js schedule
docker compose exec digest node dist/cli/index.js summarize "Family" --since 2d --dry-run
```

`digest summarize` inside the container shares the database with the running
listener through the volume, exactly as on the host: vault notes are written
directly, WhatsApp sends are queued for the listener.

Upgrade: `git pull && docker compose build && docker compose up -d`. The
session survives because auth lives in the volume.

### 5. Moving between host and Docker

1. Stop the current profile (`pm2 stop wa-digest` or `docker compose down`).
2. Copy `data/` and `vault/` to the new machine (`rsync -a`). The auth
   directory is the session; the database has the watermarks, so nothing is
   summarized twice.
3. Start the new profile. Do not start the old one again until you have
   deleted or renamed its `data/tenants/owner/auth/`.

## Known failure modes

- **`logged out by WhatsApp` at `fatal` level.** The phone unlinked this
  device, or a second instance was linked. The process stops reconnecting on
  purpose. Fix: stop everything, delete `data/tenants/owner/auth/`, pair again.
- **`Not logged in` from `cli-claude` in Docker.** The token is missing or
  expired. Regenerate with `claude setup-token` and restart. Or switch to
  option B for the night: `SUMMARIZER=api-anthropic` in `.env`.
- **`EACCES` writing `data/` or `vault/`.** The bind mounts are owned by a
  different uid than 1000. Either `chown -R 1000:1000` them or add
  `user: "<uid>:<gid>"` to the service in `docker-compose.yml`.
- **Digests fire at the wrong hour.** The cadence has no `tz` and the
  container is on UTC. Set `TZ` in `.env` or `tz` on the cadence.
- **`better-sqlite3` fails to load after an upgrade.** The prebuilt binary
  did not match the Node version. `docker compose build --no-cache`; the
  build stage has the toolchain to compile it.
