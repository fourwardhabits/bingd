# Expanded activity grouping and historical consolidation (Feed PR 2)

Founder spec 2026-11-16, §5–§7. Builds on PR 312 (poster rails). Branch `feed/expanded-grouping`.

> **Status (2026-11-20).** **Live in production:** PR 2 itself. Merged as #313 (`0170506e`)
> with #312 and released on 2026-11-17: migrations `20261127000100` and `20261128000100`
> applied, `feed.ranking_backfill_grouping_enabled` turned on at 01:10:40Z. The retrospective
> consolidation **was then run** under founder authorisation (01:20Z): 12 batches
> `history-20261117-w01`…`w12`, 115 groups from 702 posts, 587 fewer visible cards, each batch
> reversible. The "Not run in production" line below records the state when this design was
> written.
>
> **Merged, production pending:** the half-hour rule for first rankings (#328, `main`
> `68095e99`, 2026-11-20, migration `20261130000200`). It is applied on staging. In production
> the head is still `20261129000300` and `feed.ranking_backfill_days` is still set (both read
> 2026-11-20), so production still runs PR 2's historical-date test: a ranking logged with the
> default *Today* stays standalone. The *Forward* section below describes #328's rule. No
> consolidation has been run under it. What is live:
> [`../release/production-state.md`](../release/production-state.md).

## One mechanism: a group presents its members

`feed_events.presented_in uuid` (nullable, FK to `feed_events(id)`).

- **Hidden members.** A row whose `presented_in` is set is a member shown through that group. The `feed_events_read` policy adds `presented_in is null`, so every PostgREST read hides it: the Feed, Profile, the conversation page, and old store binaries alike. No client filter is needed and no duplicate cards appear.
- **Nothing deleted or rewritten.** The member keeps its id, its timestamps, its type and payload, and its membership rows. Unhiding it is `presented_in = null`.
- **Group titles.** A group's titles are its own membership (`feed_ranking_titles` / `feed_watchlist_titles`) plus its hidden members' titles, deduplicated by title. These readers union the children: `ranking_batch_titles`, `watchlist_group_titles` and `feed_group_previews`.
- **Never hidden.** An event is never a member if anything references it:
  - comments or reactions;
  - a notification whose `subject_type = 'feed_event'` names it (for example `recommendation_ranked`);
  - a `proactive_cluster_actors` row;
  - `feed_event_causes`.
- **Never grouped.** An event with a public note on its title is a review and stays standalone, as does an update or a rewatch. (An after-watch ranking was excluded too until `20261130000200`; it now groups like any first ranking.)
- **Lookup:** `feed_event_presentation(event_id)` returns the visible group for a hidden id, so a stale deep link can follow it.

## Forward: first-time rankings in one half hour (`rank_group_note`)

**Founder rule, 2026-11-20 (`20261130000200`), replacing PR 2's historical-date test:** two or more eligible first-time rankings by the same person inside one fixed 30-minute window are one grouped ranking post, whatever watch date was chosen. PR 2 required "historical" watch evidence (`basis` `none`/`diary`, or a reader date at least 7 days old) and so left 184 of 199 production first rankings standalone: the log sheet offers "Today", and almost everybody keeps it. `_ranking_is_historical` and `feed.ranking_backfill_days` are removed.

- **Who asks.** The ranking sheet calls `rank_group_note(op, media_item_id)` after every first ranking (title page, the log sheet, onboarding, lists, profiles, For You): every surface but Unranked, which keeps `rank_batch_note` and its invisible draft. Old clients never call it, so they never group. That is the safe default.
- **Server validation.** The server refuses unless all of these hold:
  - the actor's newest `title_ranked` for the title is visible and less than 30 minutes old;
  - it is a first ranking: not `update`, not `again` (a rewatch is its own activity);
  - nothing references it (the rule above);
  - there is no public note on the title (a review is its own activity).
  - The watch date, and whether there is a watch event at all, plays no part.
- **Under `ranking_story:<actor>`** (the lock `rank_batch_finalize` and `rank_batch_note` hold), with the window measured from the ranking's own post time:
  - **An open group exists** (the actor's latest visible `ranking_batch` with `payload.started_at`, and the ranking's time `< started_at + window`): the title joins it. Membership is added, the event is hidden, and the count grows. The group keeps its id, place and conversation. The window is fixed from the group's first title; it does not slide.
  - **Otherwise a peer exists** (the earliest visible `title_ranked` marked `payload.groupable` by an earlier note, or `backfill` by PR 2, within one window of this ranking, re-checked under its row lock for references and reviews): a new `ranking_batch` group is created at the earlier title's `causal_at`, with `started_at` its `created_at`. Both events become members. No notification is written.
  - **Otherwise** the event is marked `payload.groupable = true` and stays a single card until a second ranking joins its window.
- **An Unranked sitting in the same half hour.** `rank_batch_finalize` joins an open group as before. With none open, the sitting's post now also presents the title-page first rankings marked `groupable` inside one window of the sitting's start (fixed from the earliest title), re-checked under lock. A title-page ranking after the sitting joins its post through `started_at`.
- **Cross-ladder.** Movies, shows and seasons share one social group. Each title keeps its own ladder:
  - `ranking_batch_titles` returns `category` per row;
  - the sheet labels each row by its own ladder;
  - every poster shows the author's current score from its own `band_bounds`, in its kind's pill.
- **Never in a ranking group:** watchlist saves (a different family), rewatches, reviews, and anything referenced. Corrections, manual moves, reranks and Refine post nothing at all (`20261129000300`), so there is nothing of theirs to group.
- **Flag:** `feed.ranking_backfill_grouping_enabled` (the kill switch keeps its name).
- **Rollback:** `docs/release/ranking-grouping-window/rollback-20261130000200.sql`, rehearsed by `supabase/tests/ranking-grouping-window-rollback.test.mjs`.

## Retrospective consolidation (one-time, bounded, reversible)

- **Discovery.** `docs/feed/consolidation-candidates.sql` is a pure SELECT, run with `read_only` for the dry run. Bursts are found per actor and per family (watchlist singles, first-time `title_ranked` whatever its watch date, since `20261130000200`). Windows are fixed at 30 minutes from the first eligible member; a window with two or more eligible members is a group. Ineligible events stay visible where they are.
- **Execution.** `consolidate_feed_history(p_batch, p_since, p_until, p_dry_run)` runs the same predicate.
  - It creates one group per burst at the first member's `causal_at` and `created_at`, so the group is not newly posted and nobody is notified.
  - It hides the members and logs everything to `feed_consolidation_log (batch, group_event_id, member_event_id)`.
- **Rollback.** `revert_feed_consolidation(p_batch)` unhides every member of the batch.
  - It deletes a group that has no interactions.
  - It keeps a group that gained a conversation, reports it, and leaves those members hidden.
- **Not run in production** under this spec; the dry run only.

## Not changed

Scores, ladders, community scores, Watch History, Collection, the review publication path, notifications, and the Unranked draft lifecycle.
