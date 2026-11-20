# Collection drag-to-rerank (#318)

**Status (2026-11-20): live in production.** Merged as #319 (`main` `1c24b5cd`) and released
on 2026-11-20: migrations `20261129000100`, `000200` and `000300` applied, then the production
OTA. Founder approval was an Android functional QA pass. The design, findings, QA passes and
residual risks below are the record of the build.
What is live: [`../release/production-state.md`](../release/production-state.md).
*(Earlier status line: "draft PR. Not merged, not on staging, not in production.")*
**Builds on:** [`ranking.md`](./ranking.md) §7 (manual reordering), §9 (locks), §11 (displayed score), §14 (TV pools).

The reader long-presses a ranked title in Collection (Poster or List) and drops it anywhere else
in the same ranking. Since **2026-11-19** (founder decision, `20261129000200`) that includes a place
among another rating category's titles: the drop recategorises the title and it takes that
place's score. The drop moves `rankings.position` (and, across a category, `rankings.bucket` and
`user_media.bucket`) through `rank_reorder`. Every score reflows from the new positions and band
sizes, exactly as it does after any ranking. Nothing is cosmetic and nothing stores a score.

## Phase 0 findings that change the brief

| Brief said | Repository says | Decision |
| --- | --- | --- |
| "Reuse the existing `rank_reorder`" | It exists, but **`20261004000100` revoked it from every client role**. It moves a ranking without writing a `ranking_placements` row, so placement invariant P1 ("every ranking has a placement explaining it") would have a gap. That migration's own comment says: to grant it back, teach it to write a `manual` placement first. | **One migration** (`20261129000100`). `rank_reorder` writes a `manual` placement and is granted back to `authenticated`. This is the code-level need the brief asks a migration to demonstrate. |
| "`rank_reorder` currently clamps to band" | It **refuses** a cross-band position with `22023`. It does not clamp. A same-position move returns `done` and changes nothing. | v1 kept it. **Superseded 2026-11-19:** `p_new_bucket` names the category a drop lands in, and `22023` now means "not a place in that category". |
| (not mentioned) | An absolute target position computed from a cached list can be stale. Another device may have ranked a title since, so the drop would land one place off, silently. | `rank_reorder` takes two optional guards: the position the client saw the title at, and the title it saw at the target. Either mismatch refuses with `55000` before anything moves. The client rolls back, refetches and says why. |
| "a drag-to-reorder UI is an explicit non-goal" (placement epic §Q, quoted in `20261004000100` and `function-grants.test.mjs`) | Superseded by #318's approved product intent. | Comments in the new migration and the grants test say so. |
| Feed (I7): "a pure move should not invent … a ranking activity" | A `correction` placement already updates the score on the **latest watch's existing post** (`20261016000100`, the founder's canonical rule of 2026-09-21). Watch History reads that post first. | A `manual` placement follows the same rule: the latest watch's existing post takes the new score. **No post, watch, comparison or notification is ever created.** If the drag skipped this, Watch History and the title page would disagree. A TV `manual` move is not a TV `correction` and writes no update post of its own. |

## What a move writes

All of it happens in one transaction, under the media lock and then the category lock, in the
§9 order.

- `rankings.position`: the shift described in ranking.md §7. `rankings.created_at` is unchanged, so streaks, *Recently ranked* and the watchlist triggers do not hear a move as a ranking. Only `after insert` triggers exist on `rankings`.
- One `ranking_placements` row with:
  - `kind = 'manual'`, `outcome = 'moved'`;
  - from/to bucket, position and score;
  - `comparisons = 0`, `adjustable = false`;
  - the operation id.
  Refine's `_refine_support` already counts `manual` as an explicit move (`20261019000100`).
- The latest watch's existing `title_ranked` payload score, through the existing trigger.
- `processed_operations`: a replay returns the first reply and moves nothing twice (I5).

It never writes `comparisons`, `watch_events`, `feed_events` inserts, notifications or
`user_media`. I1–I4 hold because the shift is the §7 shift inside the category lock. I6 is
untouched: no session is opened or closed.

## Where a drag is allowed

**Movies, Watched, Rating highest first, no filters**: direct long-press on a ranked title.

- Its position is its index. The client checks that the ranked rows' positions are exactly `1..n` in order. If they are not, the list is not unambiguous, and no drag starts.
- Unranked titles at the end of the list are never draggable and are never drop targets.

**Anywhere else, the wall is not mutated from a display index:**
- another sort;
- shuffle;
- any filter;
- Watchlist;
- Unranked.

A long-press on a ranked title explains this and offers **Sort by rating** (one tap clears the
filters and sets Rating, highest first). Unranked titles: a long-press says to rank it first.

**TV.** The TV wall is dragged directly, like Movies (#319, founder QA 2026-11-20). See
"TV, dragged on the wall" below. The wall is the one place TV is reordered: the Reorder
button and its TV shows / TV seasons editors were removed at the founder's final QA
(2026-11-20). The show and season rankings, their APIs and every season-specific ranking
path (ranking a season from its page, Refine, corrections) are unchanged. The "TV shows
and seasons are ranked separately" refusal is gone too.

## Across a category (founder decision, 2026-11-19)

v1 refused a drop outside the title's own band: the title sprang back and a bar said "Drag it
within that group, or use Rerank". The founder rejected that. **Any ranked title can be
dragged to any place in its own ranking**, in either direction, across either line, at any
distance.

**Where it lands.** A dropped title takes the place of the title it displaces and joins that
title's category. Drag *Heat* (I liked it, 7.6) onto a 4.x title and it is It was fine, at that
place, with that place's score from `score_for`. A drag inside one category is exactly the move
it always was. The rule needs no geometry. While dragging, crossing a line ticks once (the
"Move to …" label that also said so was removed in the 2026-11-20 QA pass).

**The line itself.** The first place of a category, reached from above, is also the last place
of the one above it: the same position, two possible categories. A drag reaches it in two steps
(drop onto the second title, then nudge up one). The accessibility actions reach it in one: at
a category's edge, **Move down into It was fine** changes the category without moving the title.

**What a cross-category move writes.** It writes the same as any move (below), plus:
- `rankings.bucket` and `user_media.bucket`, together, under the media lock and the category lock (I3);
- a `manual` placement with `from_bucket` ≠ `bucket`, scored from the band sizes after the move.

The latest watch's existing post takes the new score and category through the same trigger.
No comparison, watch, session, feed post or notification is created. Rerank (comparisons)
remains the path for re-deciding a title from scratch, and is unchanged.

**The server rule.** `rank_reorder(…, p_new_bucket)`: the target position must be a place in
that category once the title has left its own, which is `band_bounds_excluding` `lo .. lo + size`.
Anything else is `22023`. The client checks the same rule (`fits` in `rerank.ts`) before it
sends, so the server's refusal is a backstop that means the list had changed.

**Undo** names the original category explicitly, because the title now at the old place may
belong to the next category. It carries the same guards as any move.

**Pools.** The move's ranking category is the title's own, read under the lock. TV shows and TV
seasons are separate pools, and a move cannot name another pool.

**Rollback.** `docs/release/pr319/rollback-20261129000200.sql` restores the 20261129000100
function, which is same-category only. Titles already moved across a category are valid
rankings and need no data change.

## Feedback, undo, failure

- **Lift:** a `selection` haptic. The tile lifts and follows the finger. The others make room. Within about 64pt of the list's top or bottom edge, the list auto-scrolls.
- **Drop:** a `decision` haptic. The cached ladder is reordered at once, so the new order and every reflowed score appear before the server answers.
- **Success:** the bar reads `Moved “Heat” to #4 · 9.6` with **Undo** and a dismiss, across a category too: the place and the score, never the category's name (founder QA, 2026-11-20). Undo reads `Moved “Heat” back to #3`. A TV wall promotion keeps `Ranked “X” as a show · #N · score`. The relevant caches are reconciled through `invalidateAfterCollectionChange`.
- **Undo** is a second, ordinary `rank_reorder` back to the old position. It has a new operation id and the same guards. If anything moved in between, it is refused like any stale move, rather than undoing the wrong thing.
- **Failure** restores the snapshot and reconciles. A lost reply may have committed, so the refetch is the truth. The bar offers **Retry**, which resends the **same** operation id, so a move that did land is answered from the ledger rather than applied twice.
- One write is in flight at a time. One more drop meanwhile is drawn at once and sent when
  the first is answered; a third springs back. If the first fails, the rollback takes both
  back and the second is not sent.

## Where the lifted copy is drawn (Android QA, 2026-11-20)

The founder's Galaxy S25 Ultra showed the lifted poster or row away from the finger after a
scroll: "scroll down slightly, then lift Iron Man", and "scroll to Battleship, and it floats
near the bottom". The slot it left looked like an empty gap, because the copy was elsewhere.

**Root cause.** The copy's top came from `measureLayout(cell, container)`. On the new
architecture, which Expo 57 / React Native 0.86 always runs, that value is computed from the
shadow tree. The shadow tree's idea of a scroll view's offset can lag the native one after a
scroll on Android. The copy was therefore drawn up to a scroll's distance from where the
title really was.

**Fix.** The copy's top comes from the list's own numbers, synchronously at the lift:
`getFirstItemOffset() + getLayout(i).y − getAbsoluteLastScrollOffset()` (`itemTopInViewport`).
`measureLayout` now supplies only the left edge, which no vertical scroll changes. It is
measured once per screen and reused. The target under the finger is read back from the copy
on screen (`layoutYAtViewport`), so an auto-scroll, a header that changes height, or a cell
re-measured mid-gesture cannot separate the target from what the reader sees.

**Also fixed:**
- **Scrolling.** It now turns off at the lift itself. Before, it waited for the measurement
  a frame later, so Android's scroll view could take the first move.
- **The original slot.** It is hidden only once its copy is drawn, so the slot is never blank
  on its own.
- **Making room.** The titles that make room ease into place (`useMakeRoom`, 140 ms, native
  driver, off under Reduce Motion) instead of jumping.
- **Drop.** The drop writes the predicted order synchronously in the drop's own event, so
  the new order and the settled cells are one commit. Before, the drop awaited a query
  cancel first, which left a frame of the old order with no shifts.
- **Android Back.** Back while holding a title puts it back and consumes the press.

`use-lift-drag.test.tsx` drives the hook against a fake FlashList whose `measureLayout`
answers late, with a stale `y`. Six of its twelve tests fail on the previous implementation.
Native feel (touch latency, the handoff from a real scroll view, frame pacing) is verified on
the device, not in Jest.

**The "Drag it within that group" notice seen on 2026-11-20.** No code path in `bf721a9a`
produces it; that copy was removed with the cross-category change. It is `f010b51f`'s, the
previous Preview. The app applies a new update on the next cold start
(`fallbackToCacheTimeout: 0`), so attempts made before that restart ran the old bundle.
Settings → Diagnostics shows which update is running.

## Final QA refinements (founder QA, 2026-11-20, second pass)

**A. The top three stopped responding after a few drags.** Root cause: the copy's top used
FlashList's `getAbsoluteLastScrollOffset()`. That is the tracked offset plus the *current*
header height, and the tracked offset is only refreshed by a scroll event. At the top of
the list, before any scroll or after the header changed height (the notice bar, a card
appearing), it is off by the header. The copy was drawn a header's height away from #1–#3,
the target under the finger was computed from that wrong top, and the drop either went
nowhere or was refused as "not moved". The hook now tracks the list's own `contentOffset`
from `onScroll` (zero at the top, reset when the view mode changes) and never reads FlashList's.
`use-lift-drag.test.tsx` lifts #1, #2 and #3 repeatedly at offset zero with a FlashList that
misreports the header, and after scrolling down and back.

**B. The drop flashed.** After a release the copy now glides into its slot (160 ms, ease-out,
native driver; instant under Reduce Motion) and stays there over the gap until the list is
drawn in the new order. The query cache notifies on a later task than the drop, so the screen
waits for that render (`landed`) and removes the copy, the gap and the shifts in it. A
cell that changes identity is placed at once rather than animated, so a recycled cell never
slides in from another title's offset. A caller that never confirms is released after 800 ms.

**C. The floating "Move to …" label is gone.** The lifted poster keeps its lifted scale, the
one haptic tick on crossing a category stays, and the bar after the drop still
names the new category.

## TV, dragged on the wall (#319, founder QA 2026-11-20)

`tv-wall.ts`. The wall is one poster per series, scored either by the reader's explicit
`tv_shows` ranking or by the mean of their ranked seasons (`SN AVG`). Only the first kind is a
place in a ranking, so a drop is read against the **explicit shows either side of where it
lands**, and the average posters in between are passed over:

- **An explicit show** moves among the explicit shows with `rank_reorder` in `tv_shows`: to
  just below the last explicit show above the drop. A category change works as on Movies.
- **An `SN AVG` show** is promoted with `rank_promote_show`. It becomes an explicit
  `tv_shows` ranking at that same place, with the score that place has. Its seasons'
  rankings, scores and history are not read for the place and not written.
- **The category** is the one the drop lands among (the displaced poster's, an average's
  read from its score), clamped to fit between the explicit neighbours, so the server never
  has to refuse it.
- **A drag of an explicit show past averages only** changes nothing. It springs back, and
  the bar says the show is still between the same ranked shows.

**The visual-order limitation.** After the move the wall re-sorts by score, as always.
Explicit shows keep the order the reader made. An average poster stays where its average puts
it, so a moved or promoted show can sort a few posters away from the exact cell it was dropped
on, among the averages, but never past an explicit show. The copy glides to where the show
will be drawn (`landingIndex`, the wall's own comparator over the predicted scores), not just
the drop cell, so it becomes the cell in place.

**What a promotion writes** (`20261129000300`): the ranking (an insertion: the shows at and
below shift down one), the collection row's category (I3), one `manual` placement with
outcome `placed` (P4: no prior), and a server-only `show_promotions` record of the
collection row before it. It takes the media lock, then the `tv_seasons` category lock (so
no season of the show can be unranked under it, and the "has a ranked season" check is made
inside it), then the `tv_shows` one; it is idempotent on its operation id; it refuses a non-series (22023), a show
already ranked or with no ranked season (55000), a place outside the category's run (22023)
and a stale anchor (55000). **No watch event, comparison, post, notification or award.** The
watch backstop, the rankings award, the watchlist rule and the provenance flip stand aside
for the promotion's own transaction and title (`_show_promoting`). A placement is not a
watch signal, so a show still on the watchlist stays on it (a series stays there until its
released seasons are seen). W1 accepts a series' seasons'
watches as its evidence (`_show_seen_through_seasons`, the rule `_viewer_has_seen` already
reads). If those seasons later leave the collection while the show stays ranked, the show gets
the ordinary undated backstop event then. The promotion's commit-time backstop and a season
removal's commit-time check take one lock per reader and series (`_lock_series_evidence`),
so two devices removing the last two seasons cannot both pass it (Codex, PR 319; race CR11).

**Undo** is `rank_unpromote_show`. It applies only while that promotion is still the show's
latest placement, not undone, and the show is where the client last saw it (55000 otherwise,
and the bar says the ranking changed). It removes the show ranking, closes up the shows
below, removes the collection row if the promotion created it and it carries nothing of its
own (else restores its category). Seasons, watches and the watchlist are untouched.

**Accessibility.** An explicit show: **Move up** and **Move down**, one explicit show at a
time. An average poster: **Rank as a show here**, **Rank as a show, higher** and
**Rank as a show, lower**. Both views, the same planner and the same writes as a drag.

## Silent ranking updates (founder, 2026-11-20)

| Action | Feed |
|---|---|
| First ranking of a film, show or season | posts, as before |
| Rewatch / log another watch | posts by its own rule, as before |
| Update rating, manual move, change of category, correction, Refine | **nothing new** |

Until `20261129000300` a TV correction that moved its title posted a `title_ranked` marked
`update: true`. That branch is removed. The latest watch's existing post now takes a TV
correction's new score and category, exactly as a film's does (`_correction_follows_latest_watch`
no longer skips TV). Placement records, watch history and the score on earlier posts behave as
before. Historic `update: true` posts are left as they are: nothing is deleted, rewritten or
backfilled.

## Accessibility

Every draggable title carries actions:
- **Move up**, or **Move up into I liked it** at the top of a category;
- **Move down**, or **Move down into It was fine** at the bottom of a category;
- **Move to top of its group**;
- **Move to bottom of its group**.

They go through the same planner and the same write as a drag, and each result is announced.
Outside an eligible view, a ranked title carries no move actions. Tap-to-open and scrolling are
unchanged: a drag starts only on a long-press, and scrolling is disabled only while a title is
lifted.

## Lists

`app/lists/[id].tsx` already moves list items with `move_list_item`. That writes `list_items`
only. No ranking, score, comparison or placement is touched there, and the tests in
`lists.test.mjs` and `ListScreen.test.tsx` pin it. #318 does not change Lists.

## Residual risks

- **Device feel is unverified.** The gesture uses the same core responder system and `Animated` as the Lists drag, which the founder has used on both platforms, with no new native dependency. Long-press timing, auto-scroll speed and the Android back gesture still need a device pass. See the PR checklist.
- **An open Rerank session for the same title.** A drag while a Rerank session is open on another device leaves that session's prior anchor stale. The band the session searches excludes the title itself, so its order and indices are unchanged and the search still places the title correctly. It just checks a slightly wrong neighbour first.
- **Other titles' feed posts.** A move reflows the band. Like any ranking, it does not rewrite other titles' frozen posts.
