# ADR 0002: Group posting is gated three times

**Date:** 2026-09-04
**Status:** accepted

## Context

Phase 5 lets a digest be posted back into its source group. Every other
channel reaches only the tenant; this one reaches other people, and a summary
in the wrong group is the worst failure mode of this project. `deliver.group`
already defaulted to `false` per group, but a single boolean is a thin guard
once several code paths (CLI, scheduler, `/digest`) can trigger delivery.

## Decision

A group post has to pass three independent checks:

1. **Config, per group.** `deliver.group: true` on the group entry. The schema
   rejects `defaults.deliver.group: true`, so there is no global switch.
2. **Trigger.** Scheduled runs (`daily`, `weekly`, `threshold`) post. On-demand
   runs (`manual` from the CLI, `command` from the self-chat) stay private:
   `digest summarize` needs `--post`, and `/digest` never posts. The owner
   asking "what did I miss" should not surprise the group.
3. **Send time.** The outbox re-checks, just before sending, that the target is
   a group JID and that the group is still opted in. A row queued before a
   config change is dropped, not sent.

Posts use the same per-tenant outbox as self-DMs (jitter, daily cap, retries)
plus a per-group minimum gap (`limits.min_group_post_gap_minutes`, default 60).
A held post does not block self-DMs queued behind it. Every post is signed at
the top ("🤖 Auto-digest") and bottom (a footer saying a bot wrote it).

## Consequences

- Enabling posting is a two-line config change on the group plus a running
  listener; nothing else.
- A future `/digest post <group>` command could lift gate 2 for the self-chat
  if it proves useful; it is not built until asked for.
- When per-tenant settings move into the store, gate 1 becomes a per-group
  column with the same "no global default" rule.
