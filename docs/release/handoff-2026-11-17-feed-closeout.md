# Feed workstream: production close-out (2026-11-17)

The Feed engineering workstream is closed. Nothing is in flight and nothing is pending.

## In production

- **App:**
  - OTA from `0170506e` (main), both platforms: Android group `80f10846`, iOS group `7d2f3828`.
  - Release record: `manifests/production-2026-11-17-feed-rails.json`.
- **Database:** 203 migrations, head `20261128000100`.
- **Feed flags (all on):**
  - `feed.watchlist_grouping_enabled`
  - `feed.ranking_grouping_enabled`
  - `feed.ranking_backfill_grouping_enabled` (on since 01:10:40Z)
  - `feed.ranking_backfill_days` = 7
- **What readers see:**
  - Grouped watchlist and ranking posts are a poster rail. Posters open their titles; the "N titles" link opens the full list.
  - There is no "View all" text.
  - Ranking posters carry the author's score. A season pill reads "S1 - 9.8".
  - Grouped cards keep Like and Comment only.
- **History consolidated (01:20:21Z–01:20:37Z):**
  - 12 batches, `history-20261117-w01` to `w12`.
  - **115 groups** (74 ranking, 41 watchlist) from **702 posts**.
  - Visible cards went from **2,170 to 1,583, 587 fewer**.
  - Record: `manifests/production-2026-11-17-feed-consolidation.json`.
- **Verified after the run:**
  - Protected data is byte-identical: rankings, placements, watchlist, watch dates, notes and reviews, comments, reactions, notifications and award causes.
  - All 2,170 original posts keep their identity fields unchanged.
  - Group counts equal their titles, and every hidden post points at a visible group by the same author.
  - No hidden post is referenced, reviewed or a rerank.
  - Sort keys are complete and unique, so pagination is intact.
  - 0 drafts, 0 orphaned joins, no notifications sent.
  - All 10 groups over 12 titles return every title through the full list.
  - Hidden posts are unreadable under RLS.
  - Anon smoke 137/137, and the live manifest is ok.
- **Not verified:** there was no physical-device verification. A glance at a grouped post in the production app is the one check left to a person.

## Rollback (if ever needed)

| What | How |
| --- | --- |
| One history batch | `select revert_feed_consolidation('history-20261117-wNN');` |
| All history batches | `python3 scripts/ops/prod-consolidate.py revert --authorized` |
| New backfill grouping | set `feed.ranking_backfill_grouping_enabled` to false |
| App | republish OTA groups Android `b82a0376`, iOS `0c141d10` (`9d11a797`) |

- The migrations are additive and are not reverted. Reverting source does not reverse them.

## Deliberately not done (founder decisions)

- The watch-date rule is unchanged: a ranking logged with the default "Today" date counts as after-watch and is not grouped.
  - Options, if ever revisited: a `today_default` burst heuristic, or a log-sheet change.
- A border around grouped cards is optional polish, deferred.
  - It changes the card's full-bleed layout and the rail's width, so it is not a one-line change.

## Standing constraints that still apply

- H-1 remains separately tracked and open. H-2 is preserved.
- Recommendation V2, push delivery, welcome-email automation and username sign-in stay off.
