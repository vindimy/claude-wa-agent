# Runtime rules

How the running agent must behave. Read this when touching the listener,
outbox, scheduler, delivery, enrichment, logging, or retention. The reason
behind most of it: this is an unofficial client on the tenant's personal
account, so it behaves like a quiet human who happens to be in the group.

## Sends

- One outbound queue **per tenant**, 2–5 s jitter between messages, a
  per-tenant daily cap (`limits.max_sends_per_day`, default 30). No bursts.
- Group sends only when that group has `deliver.group: true`, only from
  scheduled runs or an explicit `--post`, and signed as an automated digest
  (e.g. "🤖 auto-digest") so members know it is not the tenant typing.
- Self-DM and vault are the default channels; `/ask` answers are self-DM only.

## Quiet client

`src/listener/quiet.test.ts` enforces these on the source:

- `markOnlineOnConnect: false`.
- Never `readMessages()` or `sendReceipt()` (no blue ticks).
- Typing presence only in the self-chat, never in groups.
- Group sends use `cachedGroupMetadata` so a send does not refetch the
  participant list.
- Ingest only groups allow-listed for that tenant; no wider scraping.

## Session lifecycle

- States are explicit (`connecting`, `pairing`, `connected`, `reconnecting`,
  `logged_out` in `src/listener/listener.ts`) and surfaced as log
  transitions, not inferred from log noise.
- Disconnect: exponential backoff reconnect with jitter, capped at 60 s.
- Logout (401): stop that tenant's socket, log at `fatal`, mark the tenant
  `logged_out`, and wait for re-pairing. Never loop on QR generation. Other
  tenants are unaffected.
- Only one instance may be linked per `data/tenants/<tenant_id>/auth/`;
  never run the host and docker profiles against the same auth directory.

## Storage and retention

- Media is not downloaded by default (`ingest.media: false`); captions are
  stored.
- With `ingest.describe_images` on for a group, photos are downloaded at
  ingest, described by `enrich.summarizer` (default `defaults.summarizer`),
  and the file is deleted unless `ingest.media` is on.
- `ingest.describe_links` fetches up to three links per message (10 s, 1 MB,
  no private or loopback addresses, no login-walled hosts) and describes
  them. Both enrichments share the `enrich.max_per_day` cap per local day.
- Messages older than `retention.days` are deleted hourly. Summaries, runs,
  questions, and vault notes are never pruned.
- Message deletions and edits update the store; summaries reflect the latest
  state.
- All data stays on disk under our control: SQLite in `data/`, notes in the
  vault directory. No third-party message storage. No cross-tenant reads.

## Logging

- pino, JSON lines on stdout, one logger per module, `tenant_id` on every
  line.
- Message bodies only at `debug`, never in production config.
- With `LOG_DIR` set (the Docker image uses `/app/data/logs`) the same lines
  also go to rolling files: `app.*` with everything, `errors.*` with warn and
  above.

## Secrets

Only via env; `.env` is gitignored. Never commit `data/`.
