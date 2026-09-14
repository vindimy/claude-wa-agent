# ADR 0007: Recaps are a scope; destinations are named channels

**Date:** 2026-09-13
**Status:** accepted

## Context

Phase 14 adds two things: sending a digest somewhere other than its source
(a hub group, a phone number) and summarizing several groups together into
one message. Both had to fit the existing store (per-group summaries, runs,
watermarks, deliveries keyed by summary and channel) without a redesign, and
without weakening ADR 0002.

## Decision

- **Scope key.** `summaries.group_jid` and `runs.group_jid` hold a *scope
  key*: a group JID, or `recap:<name>` for a recap. A group JID always ends
  in `@g.us`, so the two never collide. Due decisions, summary reuse,
  retries, and delivery rows work on the key unchanged.
- **Per-source watermarks.** A recap keeps its position per source in
  `recap_watermarks` (migration 006) and never reads or writes a group's own
  digest watermark. Two recaps sharing a source do not interfere.
- **One model call.** A recap builds one transcript with a block per source
  group and asks for one recap. The alternative, stitching per-group
  summaries, cannot cross-reference groups and reads as a list.
- **Named destinations.** `destinations:` declares each outward target once;
  `deliver.to` references names. Unknown names fail at load time, like
  personalities. Each destination is a `to:<name>` delivery channel, so the
  deliveries primary key is unchanged and one summary fans out to many.
- **No global destinations.** `defaults.deliver.to` is rejected. See the
  amendment to ADR 0002.
- **Recap names are unique across recaps and groups**, so `/digest <ref>`
  resolves without ambiguity: groups first, then recaps.

## Consequences

- A recap costs one model call per run regardless of source count.
- Several groups each with their own `deliver.to` pointing at one hub trickle
  out one per `min_group_post_gap_minutes`; a recap is the way to get one
  message.
- When per-tenant settings move into the store, `destinations` and `recaps`
  keep the zod shape as their contract, like `groups`.
