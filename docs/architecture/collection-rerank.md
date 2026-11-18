# Collection drag-to-rerank (#318)

**Status:** draft PR. Not merged, not on staging, not in production.
**Builds on:** [`ranking.md`](./ranking.md) §7 (manual reordering), §9 (locks), §11 (displayed score), §14 (TV pools).

The reader long-presses a ranked title in Collection (Poster or List) and drops it somewhere else
**in the same rating band**. The drop moves `rankings.position` through `rank_reorder`. Every score in
that band reflows from the new positions, exactly as it does after any ranking. Nothing is
cosmetic and nothing stores a score.

## Phase 0 findings that change the brief

| Brief said | Repository says | Decision |
| --- | --- | --- |
| "Reuse the existing `rank_reorder`" | It exists, but **`20261004000100` revoked it from every client role**. It moves a ranking without writing a `ranking_placements` row, so placement invariant P1 ("every ranking has a placement explaining it") would have a gap. That migration's own comment says: to grant it back, teach it to write a `manual` placement first. | **One migration** (`20261129000100`). `rank_reorder` writes a `manual` placement and is granted back to `authenticated`. This is the code-level need the brief asks a migration to demonstrate. |
| "`rank_reorder` currently clamps to band" | It **refuses** a cross-band position with `22023`. It does not clamp. A same-position move returns `done` and changes nothing. | Kept. The client never sends either: a cross-band drop is refused locally with feedback, and a no-op drop sends nothing. The server refusal is the backstop. |
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

## Same band only (v1)

The drop target is computed live, and a drop outside the subject's band is **not applied**.
- The title springs back.
- A bar says which band it is in, and offers **Open title** for **Rerank**, the existing path that changes a band through comparisons.
- Crossing a band is never a silent bucket change.

## Feedback, undo, failure

- **Lift:** a `selection` haptic. The tile lifts and follows the finger. The others make room. Within about 64pt of the list's top or bottom edge, the list auto-scrolls.
- **Drop:** a `decision` haptic. The cached ladder is reordered at once, so the new order and every reflowed score appear before the server answers.
- **Success:** the bar reads `Moved “Heat” to #4 · 9.6` with **Undo**. The relevant caches are reconciled through `invalidateAfterCollectionChange`.
- **Undo** is a second, ordinary `rank_reorder` back to the old position. It has a new operation id and the same guards. If anything moved in between, it is refused like any stale move, rather than undoing the wrong thing.
- **Failure** restores the snapshot and reconciles. A lost reply may have committed, so the refetch is the truth. The bar offers **Retry**, which resends the **same** operation id, so a move that did land is answered from the ledger rather than applied twice.
- One move is in flight at a time. A second drag waits for it.

## Accessibility

Every draggable title carries actions:
- **Move up**;
- **Move down**;
- **Move to top of band**;
- **Move to bottom of band**.

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
