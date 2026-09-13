# Recaps and destinations (phase 14)

Status: designed 2026-09-13, approved in chat, awaiting implementation plan.

## Goal

Today every digest covers one group and can reach three places: the tenant's
self-chat, the vault, and (opt-in) the group it came from. This phase adds two
things:

1. **Destinations.** A digest can also be sent to a named group or phone
   number that is not its source. Declared once, referenced by name.
2. **Recaps.** Several listened groups can be summarized together, on their
   own cadence, by one model call, into one message. The motivating case is a
   community split across an announcements group, a nerds group, and a
   general chat: one weekly recap of all three, posted into a hub group and
   DMed to the owner's other number.

Per-group digests, `/ask`, self-DMs, and the vault keep working unchanged. A
group that should only appear in a recap sets `cadence: { type: manual }`.

## Vocabulary

- **Destination**: a named outward target under `destinations:`, either a
  group JID or a phone number. Reaches people other than the tenant, so it is
  gated like a group post.
- **Recap**: a scheduled digest over several source groups. Has a name,
  sources, cadence, summary options, summarizer, and delivery.
- **Scope**: the thing a summary, run, or watermark belongs to. Either a
  group (key: its JID) or a recap (key: `recap:<name>`). A group JID always
  ends in `@g.us`, so the two never collide.
- **Outward row**: a delivery row that reaches someone other than the tenant:
  channel `group` (post back into the source) or `to:<destination>`.

## Config

```yaml
destinations:
  zouk-hub: { group: "120363xxxxxxxxxx@g.us" }
  me:       { number: "+13105551234" }

groups:
  - { jid: "...@g.us", name: Zouk Announcements, cadence: { type: manual } }
  - { jid: "...@g.us", name: Zouk Nerds,         cadence: { type: manual } }
  - jid: "...@g.us"
    name: Zouk Chat                       # keeps its own daily self-DM digest
  - jid: "...@g.us"
    name: Board
    deliver: { to: [me] }                 # a single group's digest routed onward

recaps:
  - name: SoCal Zouk
    sources: [Zouk Announcements, Zouk Nerds, Zouk Chat]
    cadence: { type: weekly, day: sun, at: "18:00", tz: America/Los_Angeles }
    summary: { max_words: 600, instructions: "Lead with events and deadlines." }
    deliver: { self_dm: true, vault: true, to: [zouk-hub, me] }
```

### Schema

- `destinations`: record keyed by name (trimmed, non-empty). Each value is
  exactly one of `{ group: <jid ending @g.us> }` or `{ number: <string> }`.
  Numbers may contain `+`, spaces, dashes, and parentheses; they are
  normalised to digits (7 to 15 of them) and resolve to
  `<digits>@s.whatsapp.net`. Resolved shape:
  `{ name, kind: 'group' | 'number', jid }`.
- `deliverShape` gains `to: string[]` (default `[]`). It merges like the
  other deliver keys: a group's `to` shadows the default. Because
  `defaults.deliver.to` must be empty (below), in practice a group's list is
  the whole list.
- `recaps`: array of `{ name, sources, cadence?, summarizer?, summary?,
  deliver? }`. `sources` is a non-empty array of group names or JIDs.
  `deliver` for a recap is `{ self_dm?, vault?, to? }` and has no `group`
  key. Resolution mirrors `resolveGroupConfig`: `resolveRecapConfig(config,
  name)` returns `{ name, key, sources: { jid, name }[], summarizer, cadence,
  deliver: { self_dm, vault, to }, summary }` with defaults applied and
  `summary` merged through `mergeSummary`.

### Validation (load time, `superRefine`, same style as personalities)

- `defaults.deliver.to` must be empty. Reason: a global destination would
  route every listened group, including a family chat, into the same hub.
  This is ADR 0002 gate 1 applied to destinations.
- Every name in any `deliver.to` (group or recap) must exist under
  `destinations:`.
- Recap names are unique case-insensitively and must not equal any group
  name or JID. Otherwise `/digest <name>` and `digest summarize <name>` are
  ambiguous.
- Every source resolves to exactly one configured group (by JID, or by name
  case-insensitively) and no source repeats.
- A destination may also be a listened group, and a recap may deliver into
  one of its own sources. Both are legitimate ("post the weekly recap into
  the general chat").

## Store

### Migration 006: `recap_watermarks`

| column | notes |
| --- | --- |
| `tenant_id`, `recap`, `source_jid` | primary key; `recap` is the recap name |
| `watermark_ts`, `watermark_id` | last message of that source included in a recap |
| `run_id` | the run that set it |
| `updated_ts` | unix seconds |

A recap reads each source from its own watermark and never reads or writes
the per-group digest watermark in `runs`, the same way `/ask` never does.
Two recaps sharing a source keep separate watermarks.

New store methods: `recapWatermarks(tenantId, recap)` returning a map keyed
by source JID, and `recordRecapRun(run, watermarks)` which inserts the run
row and upserts the watermark rows in one transaction.

### Reuse of `summaries` and `runs`

`summaries.group_jid` and `runs.group_jid` hold the scope key. For a recap
that is `recap:<name>`. `getSummary`, `recentRuns`, `lastWatermark`,
`insertRun`, `listRuns`, and the due decision all work on that string without
change. A recap run row stores the maximum source watermark in
`watermark_ts` / `watermark_id`, which is informational; windows come from
`recap_watermarks`.

Summary id for a recap: sha256 over the tenant, the scope key, and for each
source that had messages, in config order: JID, first ts, first id, last ts,
last id. Same messages, same id, so re-running reuses the stored text.

### Deliveries

No migration. A destination gets channel `to:<name>`, so one summary can have
one row per destination under the existing `(tenant_id, summary_id, channel)`
key. `DeliveryChannel` becomes `'self_dm' | 'vault' | 'group'` plus the
template type for `to:` names; helpers `destinationChannel(name)` and
`destinationName(channel)` hide the string format.

- `countSentSince` counts `self_dm`, `group`, and `to:%` rows.
- `lastSentTs(tenantId, channel, target)` becomes `lastSentToTarget(tenantId,
  target)`: the newest sent row for that target on any outbox channel. The
  per-target gap below uses it.

## Delivery

`deliverSummary` takes, in addition to `deliver: { self_dm, vault, group }`,
a `destinations: ResolvedDestination[]` list already filtered by the trigger
gate. For each destination it enqueues a `to:<name>` row with `target` set to
the resolved JID and `text` from `renderDestinationText`. Idempotent per
channel like the other rows; `force` redoes them.

`RenderContext.groupName` is renamed `scopeName` (the group's name or the
recap's name) and gains optional `sources: { jid, name }[]` for recaps.

Rendering:

- Self-DM: unchanged, `🤖 Digest: <scopeName>` header.
- Source-group post: unchanged.
- Destination text: `🤖 Digest: <scopeName> · <window> · <n messages>`, the
  summary, then the footer
  `_Automated digest of "<scopeName>", posted by a bot, not typed by hand._`
  Used for groups and numbers alike.
- Vault: group notes unchanged. A recap note lives under the recap's slug and
  its front matter has `recap:` and `sources:` (name and JID per source)
  instead of `group:` and `jid:`; every other key is the same.

`DeliveryOutcome` gains
`{ channel: 'to'; name; outcome: 'queued'; target }` and
`{ channel: 'to'; name; outcome: 'already'; status }`.

## Posting gates (ADR 0002, amended)

Outward rows reach other people, so destinations and numbers pass the same
three gates as a source-group post:

1. **Config, per scope.** `deliver.to` is set on the group or recap, never
   under `defaults`. Names must resolve at load time.
2. **Trigger.** Scheduled runs deliver outward. `digest summarize` and
   `/digest` stay private (self-DM and vault) unless `--post` is given. The
   `postToGroup` request flag becomes `postOutward` and gates both `group`
   and `to`.
3. **Send time.** The outbox re-resolves every `to:` row against the current
   config: the destination name must still exist, must still resolve to the
   exact JID stored on the row, and the summary's scope must still list that
   name in its resolved `deliver.to`. The scope comes from
   `store.getSummary(summaryId).groupJid`; a row whose summary is missing is
   dropped. The target must be a group JID or a `@s.whatsapp.net` JID.
   Failing any check marks the row failed with a reason, never sends.

Wiring: `OutboxOptions` gains `isDestinationAllowed(scopeKey, name, target)`,
default "never", alongside the existing `isGroupPostAllowed`. The CLI passes
a closure over the loaded config.

Rate limits: the per-target gap (`limits.min_group_post_gap_minutes`)
applies to every outward row by target JID, so a hub group or a number is
never hit twice inside the gap regardless of which scope produced the
message. A held row does not block self-DMs behind it. The daily cap counts
outward rows. Several groups with their own `deliver.to` pointing at one hub
therefore trickle out one per gap; a recap is the intended way to get one
message.

Caution for the docs: DMing a number that is not a saved contact from an
unofficial client is a known spam-detection trigger. A number destination
should be a contact or the owner's own second number.

## Pipeline

### Recap runner (`src/scheduler/run-recap.ts`)

Mirrors `runDigest`. Request: tenant, store, config, resolved recap,
`untilTs`, trigger, tz, vault dir, `dryRun`, `fresh`, `adapter`,
`summaryOptions`, `forceSelfDm`, `postOutward`, optional `sinceTs` override,
`now`, and the summarizer factory seam.

1. For each source, window start is the override if given, else that
   source's recap watermark plus one, else `untilTs` minus the cadence's
   default lookback. Read `messagesSince` and cap at `untilTs`.
2. Sources with no messages are left out of the transcript, the summary id,
   and the watermark update. If every source is empty the result is
   `{ kind: 'empty' }`.
3. Compute the recap summary id; reuse the stored summary unless `fresh`.
4. Otherwise build `SummaryInput` with `groupJid` = scope key, `groupName` =
   recap name, `messages` = all sources flattened and sorted by ts, and
   `sections` = one entry per non-empty source in config order. Call
   `summarize` once.
5. Record via `recordRecapRun`: a run row under the scope key plus one
   watermark per non-empty source, in one transaction. Dry runs record the
   run row only, like `runDigest`, and touch no watermark.
6. Deliver through `deliverSummary` with `group: false` and `destinations`
   gated by `postOutward`.

Shared with `runDigest`: adapter construction from `config.summarizers`,
personality resolution, and the outward gate. These move into small helpers
both runners import; no other refactor.

### Prompt (`src/summarizer/prompt.ts`)

`SummaryInput.sections?: { groupJid; groupName; messages }[]`. When present:

- User prompt: `Recap: <name>`, a `Groups:` line with each name and message
  count, the window line, then one block per section headed
  `=== <groupName> (<n> messages) ===` followed by that section's transcript.
- System prompt adds one rule: the transcript covers several groups of one
  community; write a single recap with a short section per group in the
  given order, skip groups with nothing of substance, and name the group when
  a topic spans several. `instructions` may ask for a different layout and
  takes precedence as today.

The fake adapter names the sections in its first line so tests can assert
the multi-source path.

## Scheduler, commands, CLI, dashboard

- `startScheduler` resolves recaps next to groups. `stateForRecap` builds the
  same `GroupScheduleState` shape: runs and watermark under the scope key,
  `firstSeenTs` = earliest first-seen among sources, `pendingMessages` (for
  threshold cadences) = sum over sources of messages after that source's
  recap watermark. `decideDue` is unchanged. `tick` evaluates groups, then
  recaps; an empty recap records an `empty` run so it does not re-fire.
- `TickOutcome` identifies the scope key rather than assuming a group JID.
- `describe()` returns both kinds, tagged `kind: 'group' | 'recap'`; the CLI
  `schedule` command and the dashboard schedule table render both, showing
  sources for a recap where a group shows its JID.
- `/digest <ref>` and `digest summarize <ref>` resolve a group first, then a
  recap by exact name, then by substring. `/digest` with no ref still runs
  every group and no recap. On-demand recap runs are private unless `--post`.
  `/help` lists recaps.
- `--post` help text and the outcome formatter mention destinations.

## Tests (vitest, no network)

- Schema: destinations parse and normalise; bad numbers and two-key entries
  fail; `defaults.deliver.to` rejected; unknown destination name; duplicate
  or group-colliding recap name; unknown or repeated source; resolved recap
  config with defaults.
- Store: migration 006 applies on a fresh and an existing database;
  `recordRecapRun` is atomic; `countSentSince` counts `to:` rows;
  `lastSentToTarget` across channels.
- Delivery: one row per destination, idempotent, `force` redoes, destination
  text and footer, recap vault front matter.
- Outbox: `to:` row sent to a number JID; dropped when the name is unknown,
  the JID changed, or the scope no longer lists it; per-target gap holds a
  second outward row to the same JID; self-DMs not blocked.
- Recap runner: per-source windows and watermarks, empty sources skipped,
  all-empty result, summary id stable across reruns, on-demand run has no
  outward rows, `--post` adds them, dry run touches no watermark.
- Prompt and fake adapter: sectioned transcript and system rule.
- Scheduler: recap due on weekly cadence, threshold sums sources, `/digest
  <recap>` runs privately, `describe()` includes recaps.
- CLI: `describeDeliver` shows destinations; `findScope` order.

## Docs in the same change

- `docs/agents/config.md`: destinations, recaps, gates, name resolution.
- `docs/agents/operations.md`: outward sends and the per-target gap.
- `README.md`: delivery channels table, group posting section, config
  reference, roadmap phase 14.
- `config.example.yaml`: commented `destinations:` and `recaps:` blocks.
- `docs/adr/0002-group-posting-gates.md`: amended to cover outward rows.
- `docs/adr/0007-recaps-and-destinations.md`: recaps as a scope, the
  `recap:<name>` key, per-source watermarks, `to:<name>` channels, and why
  `defaults.deliver.to` is rejected.

## Out of scope

- Stitching separate per-group summaries into one message (the recap
  replaces that need).
- A per-destination gap or cap; the tenant-wide limits apply.
- `/digest post` or any command that lifts gate 2 from the self-chat.
- Moving recap and destination settings into the store for other tenants;
  the zod shape is the contract, as with groups today.
