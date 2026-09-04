# ADR 0003: CLI auth, retention, and encryption for the owner tenant

**Date:** 2026-09-04
**Status:** accepted

## Context

`CLAUDE.md` carried three open questions that had to be settled before the
Docker profile (phase 6): whether the summarizer may use the owner's
subscription CLI logins unattended, how long the owner tenant keeps raw
messages, and when auth state and message bodies get encrypted at rest.

## Decisions

1. **Unattended subscription CLI auth is acceptable for personal use.** The
   owner's `claude`, `gemini`, and `codex` logins may be driven by this agent
   as long as the automation is never exposed to anyone else. OpenClaw sets
   the precedent. This is the reason the CLI adapters are owner-only: any
   other tenant uses `api-*` adapters with their own keys.

2. **The owner tenant keeps raw messages for 30 days by default**, with 60,
   90, or 180 days allowed (`retention.days`). The scheduler deletes older
   `messages` rows once an hour. Groups, summaries, run records, deliveries,
   and vault notes are never pruned: the digests are the product and outlive
   their sources. This matches the 30-day default already chosen for service
   tenants, so the single-user path and the service path share one rule.

3. **No encryption at rest for now.** In the Docker profile the auth state is
   a read-only bind mount of the host directory, and the stored message
   bodies come from groups whose content every member can already read.
   Encryption is revisited before the first non-owner tenant, as the service
   direction already requires.

## Consequences

- Phase 6 may bind-mount the owner's CLI auth directories into the container.
- A summary window can reach back at most `retention.days`; `--since 1y` is
  answered from what is still stored.
- Retention is a config value with a closed set of choices, so a later move
  of tenant settings into the store keeps the same validation.
