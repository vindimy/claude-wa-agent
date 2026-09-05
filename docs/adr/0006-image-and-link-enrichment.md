# ADR 0006: Image and link descriptions are produced off the ingest path, capped per day, behind an SSRF guard

**Date:** 2026-09-05
**Status:** accepted

## Context

Photos and links are a large share of many groups, and the transcript showed
them as `[photo]` or a bare URL. Phase 10 (GitHub issue #3) adds a short
English description of each image and each fetched link to the stored
message so the summarizer can refer to them. Every description is a model
call, and every link is a URL a group member chose, fetched from inside the
owner's network.

## Decision

- **Download at ingest, describe later.** The media keys that decrypt a
  WhatsApp image exist only in the raw message, which is not stored. So the
  listener downloads the bytes the moment the message arrives (only for
  groups with `describe_images: true`), writes them under
  `data/tenants/<tenant>/media/<group>/`, and queues a job. Links are only
  URLs and are queued without fetching. A separate worker (`src/enrich/`)
  polls the queue every 10 s inside `digest run`; `digest enrich` runs the
  same worker from a shell. Descriptions never block ingest, and a model or
  network failure never loses a message.
- **A queue table, tenant-keyed like everything else.** `enrichments`
  carries one row per job with `status`, `attempts`, `next_attempt_ts`, and
  the last error. Job ids are `<message>:image` and `<message>:link:<n>`, so
  a redelivered message or a repeated backfill is a no-op. Retries back off
  1 m, 5 m, 30 m; the fourth failure is final. Retention prunes the rows and
  media files together with their messages.
- **Off by default and capped.** `ingest.describe_images` and
  `ingest.describe_links` default to false globally and can be turned on per
  group. `enrich.max_per_day` (default 200) counts model calls per tenant
  since the scheduler zone's local midnight; at the cap, jobs are deferred
  to the next midnight without consuming an attempt. The adapter is
  `enrich.summarizer`, falling back to `defaults.summarizer`, and the
  `SUMMARIZER` environment override applies to it too.
- **Adapters see images through an optional method.** `Summarizer` gains
  `describeImage?()`. The three API adapters send the file inline
  (Anthropic base64 block, OpenAI `input_image` data URL, Gemini
  `inlineData`); `cli-codex` passes `-i <path>`; `cli-claude` runs with only
  the `Read` tool enabled and is told to read the file; `cli-gemini` uses
  `@<path>`. An adapter without the method (or a CLI path that turns out not
  to work) leads to `skipped` image jobs, never to a failed digest. The two
  CLI paths are verified only behind `INTEGRATION=1`.
- **Links are fetched like a cautious browser, never from the LAN.** A
  10 s timeout, five redirects, a 1 MB body cap, and a browser-like user
  agent. Before every hop the host is resolved and refused if any address is
  loopback, RFC 1918, CGNAT, link-local, unspecified, or the IPv6
  equivalents, or the host is `localhost`. Login-walled hosts (Instagram,
  Facebook, X/Twitter, TikTok, LinkedIn) are never fetched. A blocked or
  non-HTML link is stored URL-only. The resolver check and the actual fetch
  are separate lookups, so DNS rebinding between them is a known gap; the
  worker runs on a home LAN with nothing listening that a GET could damage,
  and this is revisited before any non-owner tenant.
- **`/digest` waits briefly; scheduled runs do not.** A self-chat `/digest`
  drains the target group's due jobs for up to 30 s so a photo posted a
  minute ago is described in the answer. Scheduled digests have hours of
  slack, and the worker keeps up on its own.
- **Descriptions follow the body rule.** They are derived from group content
  and are logged only at `debug`.

## Consequences

- Two new columns on `messages` (`media_description`, `links` as JSON) and
  the `enrichments` table (migration 005). `MessageRow` carries both parsed.
- The transcript shows `[photo: <description>] <caption>` and appends
  ` (link: <description>)` per described link; undescribed items render as
  before.
- Cost is bounded by `enrich.max_per_day`; at the default cap the worst case
  is well under a dollar a day on API pricing and zero on subscription CLIs.
- `digest enrich --backfill-links <group> --since 2d` can queue link jobs
  for existing messages; images cannot be backfilled.
- The dashboard status shows the queue (`queued`, `failed`, `doneToday`).
