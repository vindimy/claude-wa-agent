# Deploying the digest agent

Two profiles, one codebase. Both read the same `config.yaml`, keep state in
`data/`, and write notes to `vault/`. **Only one of them may be linked to a
given `data/tenants/<tenant>/auth/` at a time**: a second linked instance
kicks the first off the session.

This page covers first-time setup. Once it runs, [run.md](run.md) is the
day-to-day reference.

| | host (Mac mini) | docker (VPS) |
| --- | --- | --- |
| Process manager | pm2 or launchd | `docker compose`, `restart: unless-stopped` |
| `claude` CLI auth | already logged in on the machine | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` |
| API fallback | `SUMMARIZER=api-anthropic` + `ANTHROPIC_API_KEY` (or `api-openai` + `OPENAI_API_KEY`, `api-google` + `GOOGLE_API_KEY`) | same |
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

Prebuilt multi-arch images (amd64, arm64) are published to
`ghcr.io/vindimy/claude-wa-agent` by `.github/workflows/docker.yml`:

| Git ref | Image tags |
| --- | --- |
| push to `main` | `latest`, `sha-<short sha>` |
| tag `v1.2.3` | `1.2.3`, `1.2`, `latest` |

Cut a release with `git tag v0.2.0 && git push origin v0.2.0`. Pin the VPS to
it with `DIGEST_IMAGE_TAG=0.2.0` in `.env`; leave it unset to track `latest`.

### 1. Prepare the directory on the VPS

```bash
git clone git@github.com:vindimy/claude-wa-agent.git && cd claude-wa-agent
cp config.example.yaml config.yaml && $EDITOR config.yaml
cp .env.example .env && $EDITOR .env
mkdir -p data vault
```

In `.env` set `PUID`/`PGID` to your uid and gid (`id -u`, `id -g`) so the
container writes `data/` and `vault/` as you, and `TZ` to the zone you think
in (cadences without their own `tz` use it).

While the GitHub repository is private its packages are private too, so log
in once with a personal access token that has `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u vindimy --password-stdin
```

Make the package public in GitHub → Packages → `claude-wa-agent` → Package
settings if you would rather skip the login.

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

### 3. Pull and pair

```bash
docker compose pull
docker compose run --rm digest run
```

The QR prints in the terminal. Scan it from **WhatsApp → Linked devices**,
wait for `session state ... to: connected` and `synced participating groups`,
then Ctrl-C. Auth state is now in `./data/tenants/owner/auth/`.

If the QR is too dense for the terminal, make the window taller or lower the
font size; the code is a normal WhatsApp Web QR and expires after about a
minute, at which point a fresh one prints.

To build from the checkout instead of pulling (for local changes), add the
overlay to every compose command:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### 4. Run

```bash
docker compose up -d
docker compose logs -f digest           # or: tail -f data/logs/errors.*.log
docker compose exec digest node dist/cli/index.js groups
docker compose exec digest node dist/cli/index.js schedule
docker compose exec digest node dist/cli/index.js summarize "Family" --since 2d --dry-run
```

`digest summarize` inside the container shares the database with the running
listener through the volume, exactly as on the host: vault notes are written
directly, WhatsApp sends are queued for the listener.

Optional dashboard: set `DASHBOARD_PORT=8787` in `.env`, uncomment the
`ports:` block in `docker-compose.yml`, and `docker compose up -d`. The
compose file binds the dashboard to `0.0.0.0` inside the container and
publishes it on `127.0.0.1` of the VPS only, so reach it through an SSH
tunnel (`ssh -L 8787:127.0.0.1:8787 vps`). It is read-only and has no login;
do not publish it on a public interface.

Upgrade: `docker compose pull && docker compose up -d`. The session survives
because auth lives in the volume; migrations run on startup.

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
- **`EACCES` writing `data/` or `vault/`.** `PUID`/`PGID` in `.env` do not
  match the owner of the bind mounts. Set them to `id -u` / `id -g`.
- **`denied` on `docker compose pull`.** The package is private and you are
  not logged in to `ghcr.io`, or the token lacks `read:packages`.
- **Digests fire at the wrong hour.** The cadence has no `tz` and the
  container is on UTC. Set `TZ` in `.env` or `tz` on the cadence.
- **`better-sqlite3` fails to load after an upgrade.** The prebuilt binary
  did not match the Node version. Rebuild with the build overlay and
  `--no-cache`; the build stage has the toolchain to compile it.
