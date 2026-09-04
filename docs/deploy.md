# Deploying the digest agent

Two profiles, one codebase. Both read the same `config.yaml`, keep state in
`data/`, and write notes to `vault/`. **Only one of them may be linked to a
given `data/tenants/<tenant>/auth/` at a time**: a second linked instance
kicks the first off the session.

This page covers first-time setup. Once it runs, [run.md](run.md) is the
day-to-day reference. The Docker profile also runs on the Mac mini under
Colima, which is the way to have containers come back on their own after
a reboot: see [Docker profile on macOS (Colima)](#docker-profile-on-macos-colima).
Summarizer login for every adapter, on both profiles,
is in [Summarizer adapters: initialization](#summarizer-adapters-initialization)
at the end.

| | host (Mac mini) | docker (VPS) |
| --- | --- | --- |
| Process manager | pm2 or launchd | `docker compose`, `restart: unless-stopped` |
| CLI adapters (`cli-claude`, `cli-gemini`, `cli-codex`) | the CLIs are already logged in on the machine | `claude`: `CLAUDE_CODE_OAUTH_TOKEN`; `gemini` and `codex`: credential files under `./data/home/` |
| API adapters (`api-anthropic`, `api-openai`, `api-google`) | key in `.env` | same |
| Force one adapter everywhere | `SUMMARIZER=<name>` in `.env` | same |
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

Before the first scheduled run, log the summarizer in: see
[Summarizer adapters: initialization](#summarizer-adapters-initialization).
On the host that usually means the CLI you already use is logged in and
nothing else is needed.

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
mkdir -p data/home vault
```

`data/home` is the container's `HOME`: the CLI adapters keep their
credentials there (step 2).

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

`config.yaml` names an adapter per group (`defaults.summarizer`, or
`summarizer:` on a group). Each adapter has its own login; do the one(s)
you use from [Summarizer adapters: initialization](#summarizer-adapters-initialization),
Docker column. The two common shapes:

**Owner's Claude subscription (headless CLI).** On any machine where
`claude` is logged in run `claude setup-token` and put the token in `.env`
as `CLAUDE_CODE_OAUTH_TOKEN=...`. Nothing from `~/.claude` is mounted.

**API key.** In `.env`:

```
SUMMARIZER=api-anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

`SUMMARIZER` forces the adapter for every group, so `config.yaml` can stay
identical between profiles. Leave it unset to keep per-group choice.

One profile can use a CLI and the other an API key, or the other way
round. Nothing else changes.

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

## Docker profile on macOS (Colima)

The Docker profile also runs on the Mac mini, with Colima providing the Linux
VM and Docker Engine instead of Docker Desktop. The point of doing it this
way is that the whole stack comes back by itself after a reboot: launchd
starts Colima at login, the Docker daemon inside the VM restarts every
container with `restart: unless-stopped`, and nothing has to be clicked.
Docker Desktop cannot promise that without a logged-in user opening the app.

Assumed: Colima is already installed (`brew install colima`), and the
`docker` and `docker-desktop` casks are installed too. The casks stay; only
Docker Desktop the application must not be running. The `docker` CLI and the
`docker compose` plugin they ship are what Colima uses.

This is still the Docker profile, so the
[one-instance rule](#deploying-the-digest-agent) applies: do not run it
alongside pm2 against the same `data/tenants/owner/auth/`.

### 1. Keep Docker Desktop out of the way

Docker Desktop and Colima each register a Docker *context*. Whichever is
active decides where `docker` and `docker compose` send commands, and Docker
Desktop switches the context back to itself every time it launches. So:

1. Quit Docker Desktop (menu bar whale → Quit Docker Desktop).
2. In Docker Desktop → Settings → General, untick **Start Docker Desktop
   when you sign in**. Apply, then quit again.
3. Make sure nothing in your shell profile exports `DOCKER_HOST`; it
   overrides the context and points the CLI at whatever socket it names.

The casks can stay installed. If you ever uninstall them, `brew install
docker docker-compose` gives the CLI and the compose plugin back; the
compose formula prints the `cliPluginsExtraDirs` snippet to add to
`~/.docker/config.json`.

### 2. Start Colima once by hand

The first start sets the VM shape and persists it in
`~/.colima/default/colima.yaml`; every later start, including the launchd
one, reuses it.

```bash
colima start --vm-type vz --mount-type virtiofs --cpu 2 --memory 4 --disk 30
docker context use colima
docker context ls               # colima is marked with *
docker run --rm hello-world
```

`vz` (Apple's Virtualization framework) with `virtiofs` is what makes the
bind mounts safe: `data/` holds SQLite, and SQLite locking over the `sshfs`
mount that the `qemu` VM type uses is not reliable. Both are the defaults
on Apple silicon with macOS 13 or newer, but pass them anyway so a
different default in a future Colima release cannot silently change the
mount type. `colima status` shows the values in effect.

Two cores and 4 GB are plenty for one tenant: the container is a single
Node process plus the occasional CLI adapter spawn.

### 3. Prepare the checkout

Same as on the VPS, [steps 1 to 4 above](#1-prepare-the-directory-on-the-vps),
with two macOS specifics:

- **Put the checkout outside synced folders.** Not in Dropbox, iCloud
  Drive, or anything else that watches and rewrites files. The SQLite
  database is a bind mount written from inside the VM; a sync client
  touching it at the same time will corrupt it. `~/srv/claude-wa-agent` or
  similar is fine. Colima mounts your home directory into the VM by
  default, so any path under `$HOME` works as a bind mount.
- **`PUID`/`PGID` in `.env`** are still `id -u` / `id -g` on the Mac.
  Colima's VM user carries your macOS uid, and virtiofs preserves it, so
  the container writes `data/` and `vault/` as you.

If you are moving an existing session from pm2 rather than pairing fresh,
follow [Moving between host and Docker](#5-moving-between-host-and-docker):
`pm2 stop wa-digest`, copy `data/` and `vault/` into the new checkout, and
do not start pm2 again.

Then `docker compose up -d` and check with `docker compose logs -f digest`.
Published ports are forwarded to the Mac's loopback, so the optional
dashboard is at `http://127.0.0.1:8787` with no tunnel.

### 4. Make Colima start at login

```bash
colima stop
brew services start colima
colima status
```

`brew services` writes `~/Library/LaunchAgents/homebrew.mxcl.colima.plist`,
which runs `colima start -f` with `KeepAlive`, so launchd restarts the VM if
it dies. Only the `default` profile is managed this way, which is the one
the steps above created.

This is a *LaunchAgent*: it fires when your user logs in, not when the
machine boots. For an unattended Mac mini turn on automatic login (System
Settings → Users & Groups → **Automatically log in as** → your user).
Automatic login is unavailable while FileVault is on; a headless Mac mini
in a locked room is the usual trade-off. Running Colima as a root
LaunchDaemon instead (`sudo brew services start colima`) does start at
boot, but then the VM, the socket, and `~/.colima` belong to root and the
checkout has to be readable by root; avoid it unless FileVault is
non-negotiable.

Also stop the Mac from sleeping, or the listener drops off WhatsApp every
time the display does:

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10
sudo pmset -a autorestart 1          # power back on after an outage
```

### 5. Prove it survives a reboot

```bash
sudo reboot
# after the Mac is back and logged in, give it a minute
colima status                        # Running, runtime: docker
docker context show                  # colima
docker compose ps                    # digest ... Up
docker compose logs --since 5m digest | grep "session state"
```

The last line should end in `connected` without a QR being printed: the
auth directory is a bind mount, so the session survived along with the
database and its watermarks.

Upgrades and day-to-day commands are identical to the VPS:
`docker compose pull && docker compose up -d`, `docker compose exec digest
node dist/cli/index.js groups`, and so on.

## Known failure modes

- **`logged out by WhatsApp` at `fatal` level.** The phone unlinked this
  device, or a second instance was linked. The process stops reconnecting on
  purpose. Fix: stop everything, delete `data/tenants/owner/auth/`, pair again.
- **`Not logged in` from `cli-claude` in Docker.** The token is missing or
  expired. Regenerate with `claude setup-token` and restart. Or switch to
  an API key for the night: `SUMMARIZER=api-anthropic` in `.env`.
- **`Please set an Auth method … GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI,
  GOOGLE_GENAI_USE_GCA` from `cli-gemini`.** The CLI found no login. In
  Docker: `./data/home/.gemini/oauth_creds.json` is missing or
  `GOOGLE_GENAI_USE_GCA=true` is not in `.env`. On the host: run `gemini`
  once and log in.
- **`cli-codex` exits with an auth or `401` message.** `./data/home/.codex/auth.json`
  is missing or the refresh token was revoked. Run `codex login --device-auth`
  again (see below) or `codex login status` on the host.
- **`Approval mode overridden to "default" because the current folder is not
  trusted` in `cli-gemini` stderr.** Expected: the adapter runs in an empty
  temporary directory on purpose. Not an error.
- **`EACCES` writing `data/` or `vault/`.** `PUID`/`PGID` in `.env` do not
  match the owner of the bind mounts. Set them to `id -u` / `id -g`.
- **`Cannot connect to the Docker daemon` on the Mac, or containers gone
  after `docker compose ps`.** Docker Desktop started and took the context
  back. `docker context use colima`, then quit Docker Desktop and untick
  its start-at-login setting. The containers are still there in the Colima
  VM; only the CLI was looking at the wrong daemon.
- **Nothing came back after a Mac reboot.** `brew services start colima`
  installs a LaunchAgent, which runs only once a user is logged in. Turn
  on automatic login or log in once; `colima status` should then say
  `Running` and `docker compose ps` should show `digest` up. If Colima is
  running but the container is not, the compose service is missing
  `restart: unless-stopped`, or it was stopped by hand before the reboot
  (`unless-stopped` honours a manual stop).
- **`denied` on `docker compose pull`.** The package is private and you are
  not logged in to `ghcr.io`, or the token lacks `read:packages`.
- **Digests fire at the wrong hour.** The cadence has no `tz` and the
  container is on UTC. Set `TZ` in `.env` or `tz` on the cadence.
- **`better-sqlite3` fails to load after an upgrade.** The prebuilt binary
  did not match the Node version. Rebuild with the build overlay and
  `--no-cache`; the build stage has the toolchain to compile it.

## Summarizer adapters: initialization

Seven adapters, one login each. The CLI adapters (`cli-*`) ride on the
owner's subscriptions and are owner-only (ADR 0003); anyone else uses the
API adapters. Every adapter reads only its own credential, so several can be
configured at once and mixed per group.

Verify any adapter without sending anything:

```bash
# host
pnpm digest summarize "Family" --since 2d --dry-run --adapter cli-gemini
# docker
docker compose run --rm digest summarize "Family" --since 2d --dry-run --adapter cli-codex
```

The run logs `invoking <cli>` or the API call, then prints the summary. An
auth problem shows up here as a `model` error with the CLI's own message.

### `cli-claude` (default)

Spawns `claude -p`. Needs the `claude` binary and a login.

- **Host.** `npm i -g @anthropic-ai/claude-code`, then `claude` and `/login`
  once. Already done on the Mac mini.
- **Docker.** The image has the binary. On any logged-in machine:

  ```bash
  claude setup-token
  ```

  Put the printed token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...` and
  `docker compose up -d`. Why a token and not a mount of `~/.claude`: on
  macOS the directory holds no credentials (they live in the Keychain), and
  a token is portable and revocable (ADR 0004).
- **Options.** `summarizers.cli-claude.model` (alias like `sonnet` or a full
  id), `timeout_seconds`, `bin`.

### `cli-gemini`

Spawns `gemini -p` headless with JSON output, extensions off, tools
read-only, the digest system prompt in place of the CLI's coding prompt, and
an empty temporary directory as cwd. Needs the `gemini` binary and a login.

- **Host.** `npm i -g @google/gemini-cli` (or `brew install gemini-cli`),
  then run `gemini` once and pick **Login with Google**; a browser opens.
  The login lands in `~/.gemini/oauth_creds.json`. Check with:

  ```bash
  echo "Reply with OK" | gemini -p "" -o json
  ```

  Google Workspace accounts also need `GOOGLE_CLOUD_PROJECT=<project id>` in
  the environment.
- **Docker, Google account.** Two ways to get the credential file into
  `./data/home/.gemini/`:

  1. Log in from inside the container. `NO_BROWSER=true` makes the CLI
     print a URL to open elsewhere and ask for the code back:

     ```bash
     docker compose run --rm -e NO_BROWSER=true --entrypoint gemini digest
     ```

     Pick **Login with Google**, follow the URL, paste the code, then `/quit`.
  2. Copy it from a logged-in machine:

     ```bash
     mkdir -p data/home/.gemini
     scp mac-mini:~/.gemini/oauth_creds.json data/home/.gemini/
     ```

  Either way, add to `.env`:

  ```
  GOOGLE_GENAI_USE_GCA=true
  ```

  This tells the CLI to use the Google-account login without a
  `settings.json` in the container; do not copy your own `settings.json`,
  its MCP servers would load into every summary call. Workspace accounts
  add `GOOGLE_CLOUD_PROJECT=...`.
- **Docker, API key.** `GEMINI_API_KEY=...` in `.env` also works for the
  CLI, but then `api-google` is the better adapter: same key, no CLI
  overhead, and a cost figure in `runs.cost_usd`.
- **Options.** `summarizers.cli-gemini.model` (omit for the CLI's default),
  `timeout_seconds`, `bin`. Cost is recorded as null.

### `cli-codex`

Spawns `codex exec --json` ephemeral, read-only, ignoring
`~/.codex/config.toml` and `.rules`, with the prompt on stdin and an empty
temporary directory as cwd. Needs the `codex` binary and a login.

- **Host.** `npm i -g @openai/codex`, then `codex login` (browser) and
  confirm with `codex login status`. The login lands in `~/.codex/auth.json`.
- **Docker, ChatGPT plan.** Log in from inside the container with the device
  flow, which needs no browser on the VPS:

  ```bash
  docker compose run --rm --entrypoint codex digest login --device-auth
  ```

  Open the printed URL on any device, enter the code, done. The credential
  is now in `./data/home/.codex/auth.json`; nothing goes in `.env`. Or copy
  that file from a logged-in machine:

  ```bash
  mkdir -p data/home/.codex
  scp mac-mini:~/.codex/auth.json data/home/.codex/
  ```

  Check with `docker compose run --rm --entrypoint codex digest login status`.
- **Docker, API key.** `printenv OPENAI_API_KEY | codex login --with-api-key`
  works, but then `api-openai` is the better adapter for the same reasons as
  above.
- **Options.** `summarizers.cli-codex.model` (omit for the CLI's default),
  `timeout_seconds`, `bin`. The event stream does not name the model, so
  `runs.model` is the configured value or null; cost is recorded as null.

### `api-anthropic`

Calls the Anthropic Messages API directly.

- **Both profiles.** `ANTHROPIC_API_KEY=sk-ant-...` in `.env`. Optionally
  `SUMMARIZER=api-anthropic` to force it for every group.
- **Options.** `summarizers.api-anthropic.model` (default `claude-opus-5`;
  `claude-sonnet-5` is about a fifth of the cost), `timeout_seconds`.

### `api-openai`

Calls the OpenAI Responses API directly. Responses are not stored on
OpenAI's side.

- **Both profiles.** `OPENAI_API_KEY=sk-...` in `.env`. Optionally
  `SUMMARIZER=api-openai`.
- **Options.** `summarizers.api-openai.model` (default `gpt-5.6-terra`;
  `gpt-5.6-luna` is about a tenth of the cost), `timeout_seconds`.

### `api-google`

Calls the Gemini API directly.

- **Both profiles.** `GOOGLE_API_KEY=...` (or `GEMINI_API_KEY=...`) in
  `.env`. Optionally `SUMMARIZER=api-google`.
- **Options.** `summarizers.api-google.model` (default `gemini-3.8-flash`;
  `gemini-3.1-pro-preview` for the larger model), `timeout_seconds`.

### `fake`

No credential. Deterministic stats-only output for plumbing checks:
`--adapter fake` on a dry run, or `SUMMARIZER=fake` to exercise delivery
without paying anyone.

### Switching adapters

Resolution order, most specific wins: `--adapter` on a command, then
`SUMMARIZER` in `.env`, then `summarizer:` on the group, then
`defaults.summarizer`. `config.yaml` is read once at startup, so after an
edit run `pm2 restart wa-digest` on the host or
`docker compose up -d --force-recreate digest` in Docker (a plain restart
does not remount a rewritten file, see [run.md](run.md#group-configuration)).
`SUMMARIZER` and `--adapter` need no config change. The new adapter is used
from the next run.
