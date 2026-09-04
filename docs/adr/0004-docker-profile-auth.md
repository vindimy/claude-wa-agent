# ADR 0004: Docker profile authenticates the CLI with a token, not a mount

**Date:** 2026-09-04
**Status:** accepted (supersedes the "bind-mount the CLI auth dirs" plan in
the original CLAUDE.md)

## Context

Phase 6 puts the agent in a container on a VPS. The owner's summarizer is
`cli-claude`, which needs a logged-in `claude` binary. The original plan was
to bind-mount `~/.claude` read-only into the container.

## Decision

- The image installs `@anthropic-ai/claude-code` and authenticates it with
  `CLAUDE_CODE_OAUTH_TOKEN`, a long-lived token from `claude setup-token`,
  passed through `.env`. Nothing from the host's home directory is mounted.
- The API fallback is a real adapter, `api-anthropic`, selectable for every
  group at once with `SUMMARIZER=api-anthropic` in the environment so
  `config.yaml` stays identical across profiles.
- The production build excludes tests (`tsconfig.build.json`); the runtime
  image runs `node dist/cli/index.js` as the unprivileged `node` user with
  `config.yaml`, `data/`, and `vault/` bind-mounted.

## Why not the mount

- On macOS the CLI stores credentials in the Keychain; `~/.claude` holds
  settings and history but no login, so the mount would not authenticate.
- A read-only mount also blocks the CLI's own writes (session and config
  files), and a read-write mount shares mutable state between two installs.
- A token is portable, revocable, and per-deployment, which is the shape a
  container wants. It stays owner-only per ADR 0003.

## Consequences

- `docs/deploy.md` documents both auth options and how to switch between
  host and Docker without double-summarizing.
- The `api-anthropic` adapter defaults to `claude-opus-5` with server-side
  refusal fallbacks enabled; `claude-sonnet-5` is the documented cheaper
  setting.
- A future service tenant uses `api-*` adapters with their own key; the token
  path never applies to them.
