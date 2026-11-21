# Activity sessions: one post per half hour (20261130000900)

Founder spec, 2026-11-21. Builds on the half-hour rule for first rankings (#328,
`20261130000200`) and reviewed first rankings in groups (#347, `20261130000800`).

> **Status (2026-11-21).** Applied on **staging** (`20261130000900`, one transaction with its
> `schema_migrations` row). **Not applied to production.** The historical consolidation has
> **not** been run anywhere but PGlite; the production numbers below are a read-only dry run.

## The rule

A person's eligible first-time rankings (reviewed ones included) and watchlist additions
inside one fixed 30-minute window are **one Feed post**, in whatever order they interleave.

    3:00 rank A · 3:07 save B, C · 3:12 rank D   ->   one post, four titles, D leading

- **The window** is `feed.ranking_group_minutes` (30) from the session's first eligible event,
  recorded once as `payload.started_at`. It never slides or restarts. An event at or after
  `started_at + 30:00` starts the next session; one at 29:59 joins.
- **Eligible:** a first-time `title_ranked` that nothing references (noted by the ranking
  sheet's `rank_group_note`, as before), every first-ever save (`set_watchlist`), and an
  Unranked sitting's placements.
- **Unchanged:** rewatches, TV updates, corrections, reranks and other event types keep their
  own posts (or none). A referenced event (comments, reactions, notifications, proactive items,
  award causes) is never hidden, and a hidden one that gains a reference gets its card back
  (`_unpresent_on_reference`). Review and note edits are not session events.
- **No notification** is written when a session grows: a session grows by `UPDATE`, and only
  inserts notify.

## The post

A session is an ordinary `feed_events` row of an existing type, so every client can draw it:

| Holds | Type | `media_item_id` |
|---|---|---|
| saves only | `watchlist_added` (as 20261125000100) | the newest save |
| at least one ranking | `ranking_batch` | the newest title |

A watchlist post that gains a ranking becomes a `ranking_batch` **in place**: same id,
reactions, comments, notification references and deep links. The reverse happens only if every
ranking later leaves it (a hidden member restored by a reference), and only when the newest
save can carry a watchlist post without breaking `feed_events_watchlist_once`.

**Payload** (additive; older bundles ignore it):

| Key | Meaning |
|---|---|
| `session` | `true`: written by the session model; the new client draws the session sentence |
| `started_at` | the window anchor, immutable |
| `last_activity_at` | the newest activity, the time the card prints; never moves backwards |
| `count` | distinct titles (a saved-then-ranked title counts once) |
| `ranked`, `saved` | the split of `count`; a saved-then-ranked title is ranked |
| `lead_action` | `ranked` or `saved`: what was done to the newest title |

`created_at` never moves. A single unengaged card that becomes a group is hidden behind a new
group row, as since #313; a link to it resolves through `feed_event_presentation`.

## Functions

| Function | Change |
|---|---|
| `_lock_activity_session(actor)` | new: `ranking_story:<actor>` then `watchlist_story:<actor>`, the one order every session writer uses |
| `_open_session(actor, at, family, strict)` | new: the actor's open session for an event at `at` (either family when sessions are on) |
| `_group_members(event)` | new: every title a post shows, with its `action` and `acted_at`, from its own membership and the posts it presents, on any post type |
| `_group_titles(event)` | same signature, now over `_group_members` (type-agnostic) |
| `_session_refresh(event)` | new: recomputes count, split, newest title, type, `last_activity_at`, and moves `causal_at` forward |
| `rank_group_note` | joins the open session of either family; same answers |
| `_post_watchlist_activity` | joins the open session of either family, or pairs with a marked first ranking, or starts a watchlist post |
| `rank_batch_note`, `rank_batch_finalize` | session keys; a sitting joins either family; a published sitting presents the unreferenced watchlist posts of its window |
| `_unpresent` | refreshes a session post instead of re-picking its representative |
| `ranking_batch_titles`, `feed_group_previews` | newest first; two trailing columns, `action` and `acted_at`; a saved member has no standing or score |
| `watchlist_group_titles` | newest first |
| `_watchlist_group_keeps_its_post` | counts members as every reader does |
| `consolidate_feed_sessions`, `revert_feed_session_consolidation`, `_session_consolidation_plan` | new, operator-only and inert (below) |

Kill switch: `feed.activity_sessions_enabled` false: rankings and saves group only with their
own family (the #347 behaviour) and a growing post no longer moves. Formed posts stay formed.

## Ordering: `causal_at` moves forward

**Decision: bump `causal_at`, the Feed's existing keyset column, to the session's newest
activity; no new ordering column.**

- Every client in the field already orders by `(causal_at desc, causal_step desc, id)`, so the
  move reaches old bundles too, with no client change and no new index.
- `feed_events_feed_order` (#342) is that key, column for column, so it stays the plan's
  index. On staging (470 events) the planner picks a sequential scan for the largest reader
  (4 follows): page 1 69 ms, a keyset page 60 ms. Forced onto the index, the same statements
  walk `feed_events_feed_order` in 21 ms and 11 ms. The plan choice is the planner's at this
  size, unchanged by this migration (no predicate, policy or index changed).
- `causal_step` is set to 0 when `causal_at` moves. An award or goal row caused by a hidden
  member keeps the member's own `causal_at`, as before.

**Pagination analysis.** `_session_refresh` only ever moves `causal_at` forward
(`v_last > causal_at`), and nothing else in this migration lowers it.

- *A card already read* (above the reader's cursor) that moves stays above the cursor, so a
  later page never serves it again. No duplicate.
- *A card not yet read* (below the cursor) that moves past the cursor is not served by later
  pages of that scroll. It is not lost: it sits at the top on the next pull-to-refresh or
  revisit. Nothing else changes position, so no other card is skipped or repeated.
- *Across a refresh*, `trimFeedToFirstPage` re-reads page 1 and `feedItems` dedupes by id,
  so the moved card is drawn once.
- The only writer that lowers `causal_at` is `revert_feed_session_consolidation`, an operator
  rollback.
- Tests: `activity-sessions.test.mjs` ("recency and pagination") drives the keyset across a
  move; `ActivitySessions.test.tsx` checks the client draws a duplicate id once.

**No real-time jumps.** The Feed has no realtime subscription and no focus refetch
(`refetchOnWindowFocus: false`). The order and the rails change only when the Feed's rows are
re-read: pull-to-refresh, a revisit that remounts, or the reader's own write (a save or a
ranking already invalidates their Feed, as it did before sessions). The preview cache key
includes the session's version (`count:last_activity_at`), so a session whose newest title
changed without its count changing is re-read on that refresh. Until the new read lands the
rail keeps its previous posters (`lastPreview`) rather than flashing to placeholders.

## Presentation (new client)

**Sentence** (`sessionSentence`, `activitySentence`, shared by the Feed, both profiles and the
conversation page):

    Suraj ranked Kaiju No. 8 + 15 more             12m ago · 9 ranked · 7 saved
    Suraj saved Dune + 3 more                      4m ago · 2 ranked · 2 saved
    Suraj ranked Kaiju No. 8 + 6 more              12m ago
    Suraj added Dune + 4 more to their watchlist   3m ago

Why: the verb is the newest action's and governs only the title it names, which is true by
construction. "+ 15 more" is a count, not a second verb, so the sentence claims nothing about
what was done to the others; a mixed session states the exact split on the line under it, and
every poster carries its own mark. A session of saves alone keeps "to their watchlist",
because there every title was. "+ 15 more" opens the complete list.

**Rail.** Newest first. A ranked title carries the author's current score on its own ladder
(movie, show and season pills unchanged); a saved title carries a Maroon bookmark mark on the
raised surface in the same corner ("added to watchlist" in its spoken label). A title saved
and then ranked in one session is one poster, ranked. The "Review" label stays on ranked
titles only.

**Sheet.** The ranking sheet lists every member newest first. A saved row reads "Added to
watchlist" with a bookmark and no standing or score; reviews are read for ranked rows only
(a save is not a watch). The sheet is titled "Ranked and saved" when it holds both.

**Time.** A session prints `last_activity_at`; every other post its `created_at`.

## Compatibility: what an older bundle shows

The production OTA (runtimes `ec79e181` / `8ea562b7`) and the pending 1.2.0 binary (until it
receives this OTA) see the server change without the new JS. Nothing they call changes
signature; every new field is additive; nothing crashes.

| Session | Older bundle draws |
|---|---|
| saves only | "Ada added Dune and 4 others to their watchlist", rail of posters, its sheet; newest first (the named title is the newest) |
| rankings only | "Ada ranked 7 titles" over the rail with scores; "ranked Kaiju No. 8 and 6 more" if the rail read fails |
| mixed | as a ranking group: "Ada ranked 16 titles". A saved poster has no score badge; the sheet ("Ranked in this sitting") lists saved titles with no standing or score. The verb overstates "ranked"; no wrong score, no private data, no crash |
| a watchlist post gains a ranking | the same post (id, likes, comments) reads as a ranking group from the next refresh |
| time label | `created_at`, the session's first post, at most about 30 minutes older than its newest activity, while the card sits at its newest activity's place |
| rail after a refresh | its preview key is `id#count`; a session whose newest title changed without its count changing re-reads its rail on pull-to-refresh, which already refetches every rail |

Old bundles call `rank_group_note` after first rankings, so their rankings join sessions;
`set_watchlist` groups saves on the server for every client.

## Release order

1. `20261130000800` (#347) to production (the coordinator's step in progress).
2. **`20261130000900` to production**, recorded in `config/production-migrations.json`. Old
   bundles degrade as in the table above from this moment.
3. **The production OTA** with this PR's JS. `scripts/production-migrations.mjs` and
   `ota-gate.mjs` refuse a production OTA whose migrations are not applied and recorded, so
   step 2 must precede it. No native dependency is added; the fingerprint is unchanged.
4. Verify in production (a mixed session on a test account, the sentence, the rail marks,
   refresh-only reordering), then the historical consolidation below.

The 1.2.0 binary picks up the OTA after its release; until then it shows the older-bundle
rendering above.

## Rollback

`docs/release/activity-sessions/rollback-20261130000900.sql`, rehearsed by
`supabase/tests/activity-sessions-rollback.test.mjs`. It restores every writer verbatim, drops
the helpers, the setting and the session consolidation, and keeps the readers (a superset of
the old ones), so a session formed meanwhile still reads as one card with all of its titles.
It unhides, re-dates and deletes nothing. It refuses while a session-consolidation batch is
logged. The `schema_migrations` row is the operator's to delete in the same transaction.

## Historical consolidation (approved to run after production verification)

Folds recent posts that the session rule would have made one post: already-grouped ranking
groups, watchlist groups, standalone first rankings and single saves, per author, in fixed
30-minute windows from each window's first activity (a group joins while its newest member is
inside the window).

**Dry run** (read-only, works where `20261130000900` is not applied):
`docs/feed/session-consolidation-candidates.sql`, with `:'since'`, `:'until'`,
`:'include_reviewed'` and `:'actor'` substituted, run with `"read_only": true`. It reports
aggregates, per-author ordinals (never ids, names or handles) and each planned session's event
ids. `consolidate_feed_sessions(..., p_apply => false)` returns the same plan once the
migration is applied (`session-consolidation.test.mjs` holds the two to each other).

**Production dry run, 2026-11-13 22:00Z to 2026-11-21 22:00Z** (read-only, aggregates only):

| | Reviewed rankings left alone (default) | Reviewed rankings folded (founder flag) |
|---|---|---|
| sessions planned | 9 | 11 |
| authors | 3 | 3 |
| posts folded (cards before) | 32 | 41 |
| cards after | 9 | 11 |
| fewer visible cards | 23 | 30 |
| of which first rankings | 24 | 31 |
| single saves | 4 | 5 |
| ranking groups / watchlist groups | 2 / 2 | 3 / 2 |
| mixed sessions (rankings and saves) | 6 | 7 |
| largest session (titles) | 8 | 18 |
| referenced posts used as the session post | 0 | 0 |

Per author (default): author 1, 5 sessions from 14 posts (9 fewer cards); author 2, 1 from 6
(5 fewer); author 3, 3 from 12 (9 fewer). With the flag, author 1 is 7 sessions from 23 posts
(16 fewer). The window of 2026-11-21 15:14Z holds a ranking group and a watchlist group (the
founder's screenshot); with the flag, the reviewed first ranking beside them joins too (the
18-title session).

Left alone in the range: 1 post with comments, 6 with reactions, 2 with notification
references, 0 with proactive items, 0 award causes, 4 rewatches or TV updates, and 10
unreferenced reviewed first rankings (11 reviewed in all) unless the founder flag is set.

**Decision for the founder: reviewed posts.** #347 kept history's reviewed rankings out of
consolidation ("forward-only"). The procedure keeps them out by default and folds them only
with `p_include_reviewed => true`; the review itself is unaffected either way (read live
through `public_notes`, shown in the sheet).

**The procedure** (`consolidate_feed_sessions`, inert until an operator calls it):

- **Exclusions:** a ranking with comments, reactions, notification references, proactive
  items or award causes is never a unit (keeps its card); a referenced group or save may be a
  session's post but is never hidden; rewatches and TV updates are never units; reviewed first
  rankings only with the founder flag.
- **The post:** the referenced unit if any (others stay as they are), else the largest group,
  else the earliest save, else a new ranking group at the window's first activity. Every other
  unit is hidden behind it; a hidden group's own hidden members are re-pointed to the post, so
  every old deep link resolves in one hop (`feed_event_presentation`). No row is deleted, no
  notification written, and visibility is the author's own (`can_view_profile`), so privacy
  and blocks are unchanged.
- **Bounds:** at most 8 days per call, at most `p_max_sessions` (25) sessions per call, and
  `p_actor` for one author.
- **Log:** every changed row goes to `feed_consolidation_log` (`kind = 'session'`) with its
  prior type, title, payload, `causal_at`, `causal_step` and `presented_in`.
- **Rollback:** `revert_feed_session_consolidation(batch)` restores every row exactly (rehearsed
  in PGlite). A post the batch created that has since gained a conversation is kept, with its
  members behind it, and reported.

**Running it** (operator, production, after step 4 of the release order):

```sql
-- 1. Dry run for one author (no writes): compare with the read-only file's numbers.
select consolidate_feed_sessions('sessions-20261122-a01', :since, :until, false, :'author_uuid');
-- 2. First small batch: one author's recent activity.
select consolidate_feed_sessions('sessions-20261122-a01', :since, :until, true, :'author_uuid');
--    Check the Feed as a follower; if anything is wrong:
select revert_feed_session_consolidation('sessions-20261122-a01');
-- 3. Expand: everyone, one range of at most 8 days per batch, 25 sessions per call
--    (re-run with a new batch name until applied_sessions is 0).
select consolidate_feed_sessions('sessions-20261122-w01', :since, :until, true);
```

Add `p_include_reviewed => true` only on the founder's ruling.

## Staging smoke (2026-11-21)

One transaction that ends in an exception, so nothing it wrote survives (disposable accounts,
no catalogue rows, no fixture account touched; 0 left afterwards). 17 / 17:

- rank A (solo), save B and C, rank D: one post for the follower, `ranking_batch`, D leading,
  count 4 (2 ranked, 2 saved), `lead_action` ranked; rail D, C, B, A with their own actions,
  scores on the ranked two only; the sheet lists all four, saves without a standing; a stale
  link to A resolves to the session;
- the commented and liked session gains a save: same post, count 5, lead saved, comment and
  reaction kept, no new notification;
- a save at 30:00 after the start starts a new session; one at 29:59 joins;
- a title saved and then ranked in one session is one member, ranked;
- a private author: a stranger sees no post and no rail, the approved follower sees both
  posts; after a block the follower sees no post and no sheet.

## Tests

- `supabase/tests/activity-sessions.test.mjs`: every order, the reviewed ranking, the window's
  edges (29:59, 30:00, no sliding), saved-then-ranked, rewatches, references and restored
  cards, the kill switch, engagement and notifications, stale links, privacy and blocks,
  recency, and pagination while times change.
- `supabase/tests/session-consolidation.test.mjs`: the dry-run SQL against the function, the
  first scoped batch, exclusions, one-hop links, the founder flag, and the exact revert.
- `supabase/tests/activity-sessions-rollback.test.mjs`: the rollback rehearsal.
- Races RS1 to RS4 (`supabase/tests/concurrency/races/activity-sessions.mjs`) and mutant 20.
- `src/features/feed/ActivitySessions.test.tsx`: the sentence, the split, the marks, the
  sheet, refresh-only reordering, the client dedupe, and the older bundle's card and sheet row.
