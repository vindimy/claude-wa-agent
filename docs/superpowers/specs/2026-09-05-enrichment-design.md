# Image and link enrichment (phase 10)

Status: approved design, 2026-09-05. Tracks GitHub issue #3.

## Goal

Photos and links are a large share of many groups, and today the transcript
shows them as `[photo]` or a bare URL. After this phase a stored message can
carry a short English description of its image and of each link it contains,
and the summarizer sees those descriptions in the transcript.

Descriptions are produced by a model call per image and per fetched link, so
everything here is **off by default** and capped per day.

## Config

```yaml
ingest:
  media: false              # existing; now also means "keep image files on disk"
  describe_images: false    # new, global default
  describe_links: false     # new, global default
enrich:
  summarizer: cli-claude    # adapter for descriptions; defaults to defaults.summarizer
  max_per_day: 200          # model calls for descriptions, per tenant, local day
groups:
  - jid: ...
    ingest: { describe_images: true, describe_links: true }   # sparse per-group override
```

- `ingest` on a group is a partial override of the global `ingest` block,
  merged the same way `deliver` and `summary` are (sparse: only the keys the
  user wrote shadow the defaults). `media` may also be overridden per group.
- `enrich.summarizer` must be a registered adapter name, validated like
  `defaults.summarizer`. `SUMMARIZER=` from the environment overrides it too,
  so a forced API adapter in Docker applies to descriptions as well.
- `ResolvedGroupConfig` gains `ingest: { media, describe_images, describe_links }`.

## Store

Migration 005:

- `messages` gains `media_description TEXT` (nullable) and `links TEXT`
  (nullable JSON array of `{ url, title, description }`; `description` is
  `null` for a link that was not fetched).
- New table `enrichments`, keyed by tenant like every other table:

  | column | notes |
  | --- | --- |
  | `tenant_id`, `id` | primary key; `id` is `<message_id>:image` or `<message_id>:link:<n>` so a re-enqueue is a no-op |
  | `group_jid`, `message_id` | the message to update |
  | `kind` | `image` or `link` |
  | `payload` | file path for `image`, the URL for `link` |
  | `status` | `queued`, `done`, `failed`, `skipped` |
  | `attempts`, `next_attempt_ts` | backoff bookkeeping |
  | `error` | last error text, for the dashboard and logs |
  | `created_ts`, `updated_ts` | unix seconds |

  Index on `(tenant_id, status, next_attempt_ts)` for the worker's poll and on
  `(tenant_id, group_jid, status)` for the pre-digest drain.

Store methods: `enqueueEnrichment` (insert-or-ignore), `claimDueEnrichments`
(queued rows with `next_attempt_ts <= now`, oldest first, limit N),
`completeEnrichment`, `failEnrichment` (bumps attempts, sets the next attempt
or `failed`), `skipEnrichment`, `setMediaDescription`, `setLinks`,
`countEnrichmentCallsSince(tenantId, sinceTs)` for the daily cap, and
`pendingEnrichments(tenantId, groupJid)` for the drain. `MessageRow` gains
`mediaDescription: string | null` and `links: LinkInfo[]` (parsed).

`pruneMessagesBefore` also deletes `enrichments` rows for pruned messages and
unlinks their media files; the file path is in `payload`.

## Listener

At insert time, for a message from an allow-listed group:

- If `kind === 'image'` and the group's `describe_images` is on: download the
  bytes with Baileys `downloadMediaMessage`, write them to
  `data/tenants/<tenant>/media/<group_jid>/<message_id>.<ext>` (extension from
  the mime type; jpeg, png, webp, gif), and enqueue an `image` job whose
  payload is that path. A download failure is logged at `warn` with the
  message id and skipped; the caption still stands.
- If the body contains URLs and the group's `describe_links` is on: extract up
  to three distinct `http(s)` URLs in order of appearance and enqueue one
  `link` job each.
- Edits do not re-enqueue; deletes leave the queue alone (the worker skips a
  job whose message is deleted).

Media must be downloaded here because the media keys live in the raw message,
which is not stored. Links can be fetched at any later time.

## Enrichment worker (`src/enrich/`)

Runs inside `digest run` next to the scheduler, started by the CLI with the
same tenant, config, store, and data dir. `digest enrich` runs the same worker
once from the shell and exits when the queue is drained.

- Polls every 10 s; processes claimed jobs one at a time. Backoff after a
  failure: 1 m, 5 m, 30 m, then `failed`.
- **Daily cap**: before each model call, count calls since local midnight
  (the scheduler's time zone). At the cap, the job is not consumed; it is
  rescheduled to the next local midnight and the worker logs once per day.
- **Image job**: look up the adapter from `enrich.summarizer`. If it lacks
  `describeImage`, mark `skipped`. Otherwise call it with the file path and
  mime type, store the text via `setMediaDescription`, then delete the file
  unless the group's `ingest.media` is on.
- **Link job**:
  1. Login-walled hosts (`instagram.com`, `facebook.com`, `fb.com`, `x.com`,
     `twitter.com`, `tiktok.com`, `linkedin.com`, and subdomains) are stored
     as `{ url, title: null, description: null }` with no fetch and no model
     call. The transcript shows the URL as today.
  2. Otherwise fetch with a 10 s timeout, at most 5 redirects, a 1 MB body
     cap, a plain browser-like `User-Agent`, and `Accept: text/html,
     text/plain`. Anything other than HTML or plain text yields a URL-only
     entry with the final URL's title guessed from the path.
  3. **SSRF guard**: resolve the host before every request in the redirect
     chain and refuse loopback, private (10/8, 172.16/12, 192.168/16),
     link-local, and unique-local IPv6 addresses, plus `localhost`. The
     worker runs on the owner's LAN and a group member can post any URL.
  4. Strip the HTML to `title`, `meta[name=description]` or `og:description`,
     and the first ~2000 characters of visible text (scripts, styles, and
     navigation removed). Call `complete()` with `purpose: 'describe'` for a
     one-line (≤ 30 words) English description. Store via `setLinks`,
     merging by URL so three jobs for one message do not clobber each other.
  5. Fetch failures retry with the backoff; after the last attempt the entry
     is stored URL-only with `description: null` and the job is `failed`.
- Descriptions are derived from group content and follow the body rule: never
  logged at `info`, only at `debug`.

## Adapters

`Summarizer` gains an optional method:

```ts
describeImage?(req: ImageRequest): Promise<Result<Completion, SummarizerError>>;
interface ImageRequest {
  tenantId: string;
  groupJid: string;
  system: string;
  user: string;
  image: { path: string; mimeType: string };
}
```

`CompletionPurpose` gains `'describe'`.

| adapter | image path |
| --- | --- |
| `api-anthropic` | base64 image content block |
| `api-openai` | `input_image` with a data URL |
| `api-google` | `inlineData` part |
| `cli-codex` | `codex exec -i <path>` |
| `cli-claude` | enable only the `Read` tool for this call and tell the model to read the file |
| `cli-gemini` | reference `@<path>` in the prompt; its read-only mode already allows reads |
| `fake` | returns `[fake image description]` so the worker can be tested |

The two CLI paths marked in the risks section are verified behind
`INTEGRATION=1`; if either does not work in practice, that adapter simply
omits `describeImage` and images are `skipped` for it.

The image prompt asks for ≤ 60 words in English covering what the picture
shows and any legible text (dates, prices, names, addresses), and forbids
guessing identities of people.

## Pre-digest drain

A `/digest` from the self-chat calls `worker.drain(groupJid, 30_000)` for each
target group before running it. `drain` processes that group's queued jobs
whose next attempt is due, until the queue is empty or the deadline passes,
and returns how many remain. The scheduler logs the remainder and runs the
digest regardless. Scheduled and CLI runs do not drain; they have hours of
slack and the worker keeps up on its own. The `SchedulerOptions` gain an
optional `enrichment?: { drain(groupJid, deadlineMs): Promise<number> }` so
tests can pass a stub.

## Transcript

In `formatTranscript`:

- image with description: `[photo: <description>] <caption>`; without one,
  `[photo] <caption>` as today.
- each link with a description: the URL stays in the body and
  ` (link: <description>)` is appended after the message text, one per link,
  in order. Links without a description add nothing.

## CLI and dashboard

- `digest enrich`: run the worker until the queue is empty, print counts.
- `digest enrich --backfill-links <group> --since 2d`: enqueue link jobs for
  stored messages in the window (images cannot be backfilled). Prints how
  many were queued and exits; `digest enrich` or `digest run` processes them.
- Dashboard status JSON and page gain `enrichment: { queued, failed, doneToday }`.

## Errors

Typed `EnrichError`: `download`, `fetch`, `blocked-address`, `unsupported-adapter`,
`model`, `cap`. Every log line carries `tenant_id`, `group`, `message_id`, and
`kind`. A single job failure never stops the worker.

## Testing

- Store: migration 005 applies on an existing database; queue methods; prune
  removes enrichment rows and media files.
- `links.test.ts`: URL extraction (three max, distinct, trailing punctuation
  trimmed), login-wall skip list, HTML stripping against fixture pages, size
  cap, redirect limit, SSRF guard with a stubbed resolver and fetch.
- `worker.test.ts`: image and link jobs with the fake adapter; backoff and
  `failed` after three attempts; daily cap reschedules to midnight; file
  deleted unless `ingest.media`; `drain` honours the deadline.
- Adapters: `describeImage` for the three API adapters with SDK mocks and for
  `cli-codex` with the fake-binary harness; `cli-claude` and `cli-gemini`
  behind `INTEGRATION=1`.
- Listener: `extract.test.ts` covers URL extraction from bodies; the download
  itself is behind `INTEGRATION=1`.
- Prompt: new line formats.
- Scheduler: `/digest` calls `drain` for the target group before running.

## Docs

ADR 0006 (enrichment: at-ingest download, off-path worker, daily cap, SSRF
guard), README adapter table and config section, `docs/run.md` (commands,
dashboard field, cost note), `config.example.yaml`.

## Out of scope

Video, audio, and document description. Re-describing on edit. OCR beyond
what the vision model reads. Fetching behind logins. Per-group daily caps.

## Risks

- `claude -p --tools Read` and `gemini -p` with `@file` reading an image are
  unverified until the integration test runs; fallback is `skipped`.
- Vision cost: at the default cap of 200 calls a day the worst case is well
  under a dollar a day on current API pricing, and zero on subscription CLIs.
- Media keys can expire before download on a slow reconnect; those images stay
  caption-only, which is today's behaviour.
