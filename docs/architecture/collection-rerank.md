# Collection drag-to-rerank (#318)

**Status:** draft PR. Not merged, not on staging, not in production.
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

**TV.** The TV wall is one poster per series, and the score is either the explicit show
ranking or the mean of the ranked seasons. That wall has no single ladder, so it is never
dragged directly. A long-press there offers the pool editors instead.
- **Reorder** in the count row opens **Reorder TV shows** or **Reorder TV seasons**, each with its ranked count.
- The editor draws that pool's ranked titles in position order, in Poster or List, each labelled with its rank (`#3`).
- Only explicitly ranked units appear. A series scored only by its seasons' average is not in the shows pool. A footnote says to rank the show from its page to add it.
- **Done** leaves the editor.

## Across a category (founder decision, 2026-11-19)

v1 refused a drop outside the title's own band: the title sprang back and a bar said "Drag it
within that group, or use Rerank". The founder rejected that. **Any ranked title can be
dragged to any place in its own ranking**, in either direction, across either line, at any
distance.

**Where it lands.** A dropped title takes the place of the title it displaces and joins that
title's category. Drag *Heat* (I liked it, 7.6) onto a 4.x title and it is It was fine, at that
place, with that place's score from `score_for`. A drag inside one category is exactly the move
it always was. The rule needs no geometry, and the screen says it while dragging: crossing a
line ticks once and the lifted copy reads **Move to It was fine**.

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
seasons are separate pools, edited in their own Reorder editors, and a move cannot name
another pool.

**Rollback.** `docs/release/pr319/rollback-20261129000200.sql` restores the 20261129000100
function, which is same-category only. Titles already moved across a category are valid
rankings and need no data change.

## Feedback, undo, failure

- **Lift:** a `selection` haptic. The tile lifts and follows the finger. The others make room. Within about 64pt of the list's top or bottom edge, the list auto-scrolls.
- **Drop:** a `decision` haptic. The cached ladder is reordered at once, so the new order and every reflowed score appear before the server answers.
- **Success:** the bar reads `Moved “Heat” to #4 · 9.6` with **Undo**, or `Moved “Heat” to It was fine · #14 · 4.6` across a category. The relevant caches are reconciled through `invalidateAfterCollectionChange`.
- **Undo** is a second, ordinary `rank_reorder` back to the old position. It has a new operation id and the same guards. If anything moved in between, it is refused like any stale move, rather than undoing the wrong thing.
- **Failure** restores the snapshot and reconciles. A lost reply may have committed, so the refetch is the truth. The bar offers **Retry**, which resends the **same** operation id, so a move that did land is answered from the ledger rather than applied twice.
- One move is in flight at a time. A second drag waits for it.

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
