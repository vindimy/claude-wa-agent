# Action-item extraction as its own output (phase 13)

Status: drafted 2026-09-05 and shelved before implementation; the shape (structured, stored, per run, off by default) was agreed, the details below were not yet reviewed. Tracks GitHub issue #6.

## Goal

A digest tells the reader what happened; it does not keep track of what is
still owed. After this phase a group can opt into **action-item extraction**:
after every digest a second, structured model call pulls out the concrete
tasks in the window (who, what, by when), matches them against the items
still open from earlier runs, and stores the result. The list of open items
then shows up in four places:

1. a short **"Action items" block** appended to the digest text that goes to
   the self-chat and the vault note (never to a group post);
2. a **running checklist** in the vault, one Markdown file per group,
   rewritten after every extraction;
3. the **dashboard**, as a section of open and recently closed items;
4. **`/todo`** in the self-chat and **`digest actions`** in the shell, which
   list open items without a model call and let the owner close one by hand.

This is distinct from the existing `style: action-items`, which formats the
whole summary as decisions / actions / open questions and stores nothing.
The two compose: a group can use any style and still extract.

Extraction is a model call per digest run, so it is **off by default**.

## Config

```yaml
defaults:
  summary:
    action_items: false     # new; true turns extraction on for every group
groups:
  - jid: ...
    summary: { action_items: true }   # per-group opt-in, merged like the other summary keys
```

- `action_items` joins `summaryShape`, so it merges through `mergeSummary`
  and reaches `SummaryOptions` like `style` and `language`. The digest
  prompt ignores it.
- `/digest … actions=on|off` (aliases `action_items`, `--actions`) and
  `digest summarize --action-items` / `--no-action-items` override it for
  one run, like the other knobs. Values other than `on|off|true|false` are
  rejected before anything runs.
- No extra adapter setting: extraction uses the same adapter as the digest
  (the group's `summarizer`, or `via=` / `--adapter` for that run).

## Store

Migration 006 adds `action_items`, keyed by tenant like every other table:

| column | notes |
| --- | --- |
| `tenant_id`, `id` | primary key; `id` is a UUID |
| `group_jid` | the group the item belongs to |
| `summary_id` | the digest that created it (nullable: a `/todo add` item has none — out of scope now, column kept nullable so it can) |
| `task` | one line, ≤ 200 chars, as the model wrote it |
| `owner` | nullable; a name as shown in the transcript |
| `due` | nullable; free text as stated in the chat ("Sep 20", "before Friday") |
| `status` | `open` or `done` |
| `created_ts` | unix seconds; the run that created the item |
| `done_ts`, `done_summary_id`, `closed_by` | nullable; `closed_by` is `model` (a later digest saw it done) or `owner` (`/todo … done n`) |

Index on `(tenant_id, group_jid, status, created_ts)`.

Store methods: `insertActionItems(rows)`, `openActionItems(tenantId,
groupJid?)` (oldest first, so numbering in `/todo` is stable),
`listActionItems(tenantId, limit, { groupJid?, status? })` (newest first,
for the dashboard), `closeActionItems(tenantId, ids, { doneTs,
doneSummaryId, closedBy })`, and `deleteActionItemsForSummary(tenantId,
summaryId)` for `--fresh`. Items are never pruned by retention, like
summaries and runs.

## Extraction (`src/scheduler/action-items.ts`)

Runs inside `runDigest` after a successful `summarize()` when the resolved
`options.action_items` is true. It never runs for a reused summary (its
items already exist); `--fresh` deletes that summary's items first and
re-extracts.

1. Load the group's open items from the store.
2. Build the prompt (`src/summarizer/action-items-prompt.ts`):
   - system: "You extract action items from a WhatsApp group transcript.
     Reply with JSON only." Rules: only commitments and requests actually
     made in the transcript; owner is a name from the transcript or null;
     due is the deadline as stated or null; skip questions, opinions, and
     things already done before the window; at most 20 new items; mark an
     open item done only when the transcript shows it was completed or
     dropped. Output schema shown verbatim:
     `{"new":[{"task":"…","owner":"…"|null,"due":"…"|null}],"done":["<id>"]}`.
     Tasks are written in the digest's `summary.language` (or the chat's
     language for `auto`); the personality is **not** applied (this is
     data, not prose).
   - user: group, window, the open items as `id · task — owner · due`
     lines (or "none"), then the transcript from `formatTranscript`.
3. `complete()` with a new `CompletionPurpose` `'extract'`. Every adapter
   already passes the purpose through; nothing adapter-specific changes.
4. Parse leniently: strip code fences, take the first `{` to the last `}`,
   `JSON.parse`, validate with zod (trimmed strings, `task` non-empty and
   cut to 200 chars, `owner`/`due` nullable, `new` capped at 20, `done`
   only ids that are actually open). A parse failure is a warning in the
   log and the digest proceeds without a block; nothing is stored.
5. Not a dry run: insert new items with `summary_id` = this digest, close
   the matched ones with `closed_by: 'model'`. The extraction's `costUsd`
   is added to the run's `cost_usd` so the dashboard shows what the run
   cost in total; `durationMs` is not merged.
6. Return `{ added, closed, open }` (open = after this run, oldest first).

Dry run (`--dry-run`): extraction runs and its result is printed with the
summary, nothing is written.

Failures of the extraction call (`SummarizerError`) are logged at `warn`
with the group and adapter and never fail the digest: the summary was
produced and is delivered as usual.

## Rendering

`renderActionItemsBlock({ added, closed, open }, cap = 12)` in
`src/delivery/render.ts` produces WhatsApp-friendly plain text:

```
Action items (3 open):
- Dima: send the costume deposit — by tomorrow (new)
- Lena: fix the poster date — tonight (new)
- Sasha: bring the speaker to Lena's at 10:30
Done: Marco sent the final mix to the organizers
…and 2 more: /todo Dance team
```

Owner first when known; `— due` when known; `(new)` on items from this
run; `Done:` lines for items closed this run; the overflow line only when
open items exceed the cap. When nothing is open and nothing was closed the
block is `Action items: none open.` so the reader knows extraction ran.

- **Self-DM**: `renderWhatsAppText` appends the block after a blank line.
- **Vault digest note**: `renderVaultMarkdown` appends `## Action items`
  with the same lines as Markdown bullets.
- **Group post**: unchanged. Items name people and the group post is the
  channel with the least room for surprise.
- **Checklist**: `<group-slug>/action-items.md`, rewritten from the store
  after every extraction and after `/todo … done`: front matter (group,
  jid, tenant, updated), `## Open` as `- [ ] task — owner · due _(added
  YYYY-MM-DD)_`, `## Done` with the 30 most recent as `- [x] … _(done
  YYYY-MM-DD)_`. Written through `writeVaultNote`; not recorded in
  `deliveries` (it is derived state, safe to rewrite).

`deliverSummary` gains an optional `actionItems` argument (the block's
input); when present the self-DM text and vault note include it and the
checklist is rewritten. Idempotency is unchanged: the block is part of the
text that is queued once.

## Commands

Self-chat (`src/scheduler/commands.ts`, `kind: 'todo'`):

| Message | Effect |
| --- | --- |
| `/todo` | Open items for every configured group, grouped by group, numbered per group |
| `/todo Family` | Open items for one group, numbered oldest first |
| `/todo Family done 2` | Close item 2 of that listing (`closed_by: 'owner'`), reply with the updated list |

Replies are self-DM only, need no model call, and never move a watermark.
An unknown group or a number out of range replies with the usual
`🤖 …` message. `/help` lists `/todo`.

Shell: `digest actions [group] [--done] [--close <n>]` prints the same
listing (`--done` adds the recent closed items; `--close n` closes one and
rewrites the checklist). `digest summarize` prints the block after the
summary when extraction ran.

## Dashboard

`/api/actions?limit=` → `{ open: ActionItemView[], done: ActionItemView[] }`
(each with `groupName`), open oldest first, done newest first. The page gets
an "Action items" section between Questions and Outbox: group, task, owner,
due, added, and for done rows when and by whom (model or owner). Read-only
like everything else there.

## Errors

- `DigestResult` (kind `ok`) gains `actionItems?: { added, closed, open }`
  and `actionItemsError?: string` so the CLI can say "extraction failed:
  …" after printing the summary.
- New tagged errors live in `action-items.ts`: `{ tag: 'parse'; raw }` and
  `{ tag: 'complete'; error: SummarizerError }`; both are logged, neither
  propagates out of `runDigest`.

## Testing

- `config.test.ts`: `action_items` defaults to false, merges per group,
  rejects non-booleans.
- `store.test.ts`: insert, open (ordering), list, close (only open rows,
  sets `done_*`), delete-for-summary, tenant isolation.
- `action-items-prompt.test.ts`: system prompt carries the schema and the
  rules; user prompt lists open items with ids or "none".
- `action-items.test.ts`: parser cases (clean JSON, fenced, leading prose,
  unknown `done` id ignored, over-cap truncated, garbage → parse error).
- `fake` adapter: `purpose: 'extract'` returns a deterministic JSON body
  (one new item per message that contains "please" or "will", and closes
  every open item whose task appears verbatim in the transcript) so
  `run-digest.test.ts` can assert: off → no extraction call; on → items
  stored, block in the self-DM text, checklist written, cost merged into
  the run; reuse → no second extraction; `--fresh` → items replaced; dry
  run → nothing stored; a failing extraction leaves the digest delivered.
- `render.test.ts`: block formatting, cap and overflow line, "none open".
- `commands.test.ts` / `scheduler.test.ts`: `/todo`, `/todo Family`,
  `/todo Family done 2`, bad number, unknown group.
- `server.test.ts`: `/api/actions` shape and empty state.

## Docs

README (feature list, config example, self-chat table, roadmap item 13 ✅),
`docs/run.md` (config, `/todo`, `digest actions`, cost note),
`config.example.yaml`, CLAUDE.md (per-group config, phase list), and ADR
0007: extraction is a second structured call rather than parsing the prose
summary, items are matched across runs by the model against the stored
open list, and the group post never carries them.

## Out of scope

- Reminders or notifications when a due date approaches.
- Editing an item's text, owner, or due date; adding items by hand
  (`/todo add`) — the nullable `summary_id` leaves room for it.
- Linking an item to the message ids that produced it.
- Extraction on `/ask` answers or on messages outside a digest run.

## Risks

- **Cost**: doubles the model calls for a group that opts in. Off by
  default and visible in `runs.cost_usd`.
- **Drift**: the model may re-add an item it already has under different
  wording. The prompt shows open items with ids and says to prefer closing
  or leaving them over restating; `/todo … done n` is the manual fix.
- **Stale items**: nothing auto-expires. The checklist and `/todo` keep
  them visible, and closing by hand is one message.
