# Expanded activity grouping and historical consolidation (Feed PR 2)

Founder spec 2026-11-16, §5–§7. Builds on PR 312 (poster rails). Branch `feed/expanded-grouping`.

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
- **Never grouped.** An event with a public note on its title is a review and stays standalone, as does an update, a rewatch, or an after-watch ranking.
- **Lookup:** `feed_event_presentation(event_id)` returns the visible group for a hidden id, so a stale deep link can follow it.

## Forward: first-time historical rankings from title pages (`rank_group_note`)

- **Who asks.** The title-page ranking flow calls `rank_group_note(op, media_item_id)` after a ranking completes. The Unranked flow never calls it: it keeps `rank_batch_note`, and its draft stays invisible until the sitting finishes. Old clients never call it either, so they never group. That is the safe default.
- **Server validation.** The server refuses unless all of these hold:
  - the actor's newest `title_ranked` for the title is visible, a first ranking (not `update` or `again`), and less than 30 minutes old;
  - nothing references it (the rule above);
  - there is no public note on the title;
  - the watch evidence is historical, judged from the newest watch event:
    - `basis` is `none` or `diary`; or
    - `basis` is `reader` or `unattributed` and `watched_on` is at least `feed.ranking_backfill_days` (default 7) before today.
- **Treated as after-watch or ambiguous, so standalone:** `today_default`, a recent date, or no watch event at all.
- **Under `ranking_story:<actor>`** (the lock `rank_batch_finalize` and `rank_batch_note` hold):
  - **An open group exists** (the actor's latest visible `ranking_batch` with `payload.started_at` and `now() < started_at + window`): the title joins it. Membership is added, the event is hidden, and the count grows. The group keeps its id, place and conversation.
  - **Otherwise a peer exists** (another eligible, visible `title_ranked` marked `payload.backfill`, created inside the window): a new `ranking_batch` group is created at the peer's `causal_at` with `started_at` set to the peer's `created_at`. Both events become members. No notification is written.
  - **Otherwise** the event is marked `payload.backfill = true` and stays a single card.
- **Cross-ladder.** Movies, shows and seasons share one social group. `rank_batch_finalize` drops its same-ladder test, so an Unranked sitting joins the same open group. Each title keeps its own ladder:
  - `ranking_batch_titles` returns `category` per row;
  - the sheet labels each row by its own ladder;
  - scores always use their own `band_bounds`.
- **Flag:** `feed.ranking_backfill_grouping_enabled`. It is inserted as false in production and true in nonprod.

## Retrospective consolidation (one-time, bounded, reversible)

- **Discovery.** `docs/feed/consolidation-candidates.sql` is a pure SELECT, run with `read_only` for the dry run. Bursts are found per actor and per family (watchlist singles, first-time `title_ranked`). Windows are fixed at 30 minutes from the first eligible member; a window with two or more eligible members is a group. Ineligible events stay visible where they are.
- **Execution.** `consolidate_feed_history(p_batch, p_since, p_until, p_dry_run)` runs the same predicate.
  - It creates one group per burst at the first member's `causal_at` and `created_at`, so the group is not newly posted and nobody is notified.
  - It hides the members and logs everything to `feed_consolidation_log (batch, group_event_id, member_event_id)`.
- **Rollback.** `revert_feed_consolidation(p_batch)` unhides every member of the batch.
  - It deletes a group that has no interactions.
  - It keeps a group that gained a conversation, reports it, and leaves those members hidden.
- **Not run in production** under this spec; the dry run only.

## Not changed

Scores, ladders, community scores, Watch History, Collection, the review publication path, notifications, and the Unranked draft lifecycle.
