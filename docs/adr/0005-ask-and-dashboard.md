# ADR 0005: Q&A reuses the summarizer adapters; the dashboard is read-only

**Date:** 2026-09-04
**Status:** accepted

## Context

Roadmap item 8 asked for `/ask <group> <question>` over stored history and a
simple local web dashboard. Both touch the parts of the system that carry
risk: model calls cost money and the dashboard is a network listener next to
a WhatsApp session that must never send by accident.

## Decision

- **One backend interface, two prompts.** `Summarizer` gains
  `complete(system, user)`; every adapter implements only that, and
  `summarize()` is the digest prompt layered on top through a shared helper.
  `/ask` builds its own prompt (transcript plus question, "use only the
  transcript, say when the answer is not there, reply in the question's
  language") and calls `complete`. No new adapter, credential, or config key
  is needed to ask questions, and the owner-only rule for CLI adapters
  carries over unchanged.
- **Questions are not runs.** A separate `questions` table records every
  attempt with cost and status. Runs feed the scheduler's watermark logic;
  a question must never advance a watermark or look like a digest, so it
  gets its own table rather than a new `trigger` value.
- **Answers stay private.** The CLI prints them; the self-chat command
  queues a self-DM through the existing outbox (jitter and daily cap apply).
  There is no way to post an answer into a group.
- **Default window is the whole retention period.** The question the owner
  has is usually "what did we decide", not "what happened today"; the window
  token narrows it when cost matters. The docs say what a month of a busy
  group costs.
- **The dashboard only reads.** `node:http`, no dependencies, one inline HTML
  page plus `/api/*` JSON, GET only, bound to `127.0.0.1` by default, off by
  default. It cannot trigger a digest, ask a question, or change config.
  Docker binds `0.0.0.0` inside the container and publishes on the VPS
  loopback only, reached through an SSH tunnel. Adding write actions would
  require authentication first and is deliberately out of scope.
- **Same data path for both profiles.** `digest dashboard` serves the page
  from any shell against the shared database, using a scheduler with an
  idle tick for `describe()`; only the session state is missing there.

## Consequences

- `src/summarizer/summarize-via.ts` is the only place that turns a
  `Completion` into a `Summary`; adapters no longer import the digest prompt.
- Migration 004 adds `questions`; every table still carries `tenant_id`.
- `dashboard/` is the first module that listens on a port. It must stay
  read-only until a tenant-aware login exists (service direction).
- A future action-item extractor (roadmap item 9) should follow the same
  pattern: its own prompt over `complete()`, its own table if it needs one.
