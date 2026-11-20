# Workstream B: Feed grouping (#310 to #313) checked against production

Read-only. Checked 2026-11-19 at about 05:55Z. Production is `abheeqyjzekiowkztfxv` and staging is `fjxhcbowoxuzulwirzyr`.

Nothing was written, no flag was changed, nothing was published or pushed, and no consolidation was run. All SQL went through the Management API with `read_only: true`.

The saved Supabase management token first returned 401 (Invalid access token). It was re-entered through the secure credential form, and all queries after that succeeded.

In this report, "actor_h" is the first 8 hex characters of md5(actor_id), and "ev" is the first 8 hex characters of the feed_events id.

## 1. Migrations

Each PR merge was mapped to the migration it adds with `git diff <merge>^1 <merge> -- supabase/migrations`.

| PR | Merge | Migration | Production | Staging |
|---|---|---|---|---|
| #310 watchlist session | aa812a8f | 20261125000100_a_watchlist_session_is_one_post | applied | applied |
| #311 backlog half hour | 9d11a797 | 20261126000100_a_backlog_half_hour_is_one_post | applied | applied |
| #312 poster rails | 3f127568 | 20261127000100_a_group_shown_as_its_posters | applied | applied |
| #313 presents its members | 0170506e | 20261128000100_a_group_that_presents_its_members | applied | applied |

- **Production:** 203 migrations, head `20261128000100`.
- **Staging:** identical, 203 migrations with the same head.
- **`20261129000100_a_move_you_make_yourself`:** this is the #318/#319 branch. It is not on main and is not applied anywhere.

## 2. Flags (`app_config`, keys `feed.%`)

| Key (source) | Production | Staging |
|---|---|---|
| feed.watchlist_grouping_enabled (#310) | true | true |
| feed.watchlist_group_minutes (#310) | 30 | 30 |
| feed.ranking_grouping_enabled (#311) | true | true |
| feed.ranking_group_minutes (#311) | 30 | 30 |
| feed.ranking_backfill_grouping_enabled (#313) | true | true |
| feed.ranking_backfill_days (#313) | 7 | 7 |

- #312 adds no flag.
- The other feed keys are also the same on both: rewatch_posts=true, rewatch_post_days=7, follow_aggregation_minutes=60, follow_story_max_people=50.
- The client has no grouping flag of its own, because it cannot read `app_config`.

## 3. Production OTA (`release-manifest live production`: "ok")

| Platform | Commit | Update id | Group | Runtime | Created |
|---|---|---|---|---|---|
| android | 0170506e | 01a1e70c-cdc5-760e-96af-6c7d92f4e471 | 80f10846 | ec79e181 | 2026-11-17T01:08:58Z |
| ios | 0170506e | 01a1e70c-cdc5-7fc4-a858-2e5e4e534210 | 7d2f3828 | 8ea562b7 | 2026-11-17T01:08:58Z |

- **Ancestry:** all four merges (aa812a8f, 9d11a797, 3f127568, 0170506e) are ancestors of the OTA commit (`git merge-base --is-ancestor`). The OTA is the #313 merge itself.
- **Main has moved on:** main is now 13 commits ahead (#314 to #316). The closeout records say those merges touch no app code.
- **Live confirmation:** the #313 client function `groupBackfillRanking` calls `rank_group_note`.
  - Production has 14 such calls, the first at 2026-11-17 04:38:51Z.
  - 14 of the 15 rankings made after the OTA triggered a call.
  - The one exception was at 2026-11-17 02:57Z, about 2 hours after publish. That device had most likely not yet applied the update.

## 4. Grouped posts in production

How groups are stored, from the migrations:

- **Ranking groups** are `ranking_batch` rows with a payload `count`. Members are in `feed_ranking_titles` and/or are `title_ranked` rows hidden behind the group through `presented_in`.
- **Watchlist groups** are `watchlist_added` rows with payload `count` > 1. Members are in `feed_watchlist_titles` and/or are hidden `watchlist_added` rows.

feed_events totals: 2,271 rows, of which 1,610 are visible and 661 are hidden.

**Ranking groups**

- 78 visible `ranking_batch` rows:
  - 74 come from the history consolidation (`origin = history`).
  - 4 are Unranked sittings from 2026-09-25 to 2026-10-01, with counts 3, 1, 7 and 2.
- That makes **77 multi-title ranking groups**.
- **No new ranking group has been created recently:** 0 in the last 7 days and 0 since 2026-11-17.
  - No `origin = title` (forward title-page) group has ever been created.
  - `rank_group_note` has run 14 times and all 14 were `skipped` with reason `after_watch`.
- No `rank_batch_*` operation has run since 2026-10-01 (17 ever), so the Unranked flow has not been used in production since then.
- 0 drafts.

**Watchlist groups**

- **41 multi-title watchlist groups**, all from the consolidation. Each carries `consolidation_batch`.
- By `created_at`, 2 fall in the last 7 days. Both are from batch w12, and a group takes the time of its first post.
- 0 new multi-title watchlist groups since 2026-11-17.
- Three posts have been written since the OTA. Each has `{count: 1}` and one member: 11-17 01:50Z, 11-18 17:48Z and 11-19 04:30Z.
  - The 11-18 save sequence was add, remove, re-add of the same title. It produced one post, as the "announced once" rule intends.

## 5. Historical consolidation in production

Production matches the records exactly. The records are consol-apply.log, consol-verify-after.json, the feed-closeout handoff and manifests/production-2026-11-17-feed-consolidation.json.

**`feed_consolidation_log`**

- 776 rows across 12 batches, `history-20261117-w01` to `w12`, logged 2026-11-17 01:20:22Z to 01:20:37Z.
- No other batch exists, and nothing has been reverted.
- 115 group rows:
  - 74 ranking groups created by the run (`created_group`).
  - 41 watchlist groups formed by promoting an existing post (`prior_payload` kept).
- 661 member rows.

**Rows per batch (groups/members), equal to consol-apply.log**

| Batch | Groups/members |
|---|---|
| w01 | 2/8 |
| w02 | 10/36 |
| w03 | 12/40 |
| w04 | 23/84 |
| w05 | 20/244 |
| w06 | 10/78 |
| w07 | 13/83 |
| w08 | 4/20 |
| w09 | 1/5 |
| w10 | 2/6 |
| w11 | 11/35 |
| w12 | 7/22 |

**feed_events**

- 115 rows carry `payload.consolidation_batch`: 74 `ranking_batch` and 41 `watchlist_added`.
- Their counts add up to **702**, and the largest group has 49 titles.
- **Hidden rows:**
  - 661 rows are hidden: 562 `title_ranked` and 99 `watchlist_added`.
  - All 661 are still behind the group their log row names.
  - 0 hidden rows are missing from the log.
  - 0 hidden members or groups have been commented on or reacted to since.
- **Visible cards:**
  - After the run: 1,583, which is 2,170 minus 661 plus 74, so **587 fewer**.
  - Now: 1,610, because 27 posts were added since (15 rankings, 3 watchlist, 5 follows, 4 awards).
- **Staging:** no consolidation batches, 0 hidden rows, and no `rank_group_note` calls.

## 6. Why older ranking bursts are still separate cards

**The rules.** These come from `consolidate_feed_history` and `rank_group_note` in 20261128000100.

- **Which posts count:** only first-time `title_ranked` posts are candidates, meaning posts that are not updates or rewatches. A candidate must also:
  - have nothing pointing at it: no comment, reaction, notification, proactive item or award cause;
  - be for a title with no published review;
  - be "historical" under `_ranking_is_historical`:
    - the newest watch event has basis `none` or `diary`; or
    - it has basis `reader` or `unattributed` with a date at least 7 days old;
    - `today_default` counts as after-watch;
    - no watch event at all counts as "not decidable", so not historical.
- **The window:** it is fixed at 30 minutes from the first post that counts, per actor. Ranking posts and watchlist posts are grouped separately, but movies, shows and seasons can share a ranking group.
- **Minimum size:** a window needs at least 2 posts that count, or nothing is grouped.
- **Date range:** the history run covered 2026-08-14 to 2026-11-17 00:00Z, in 8-day batches.

**What is left.** 1,143 visible `title_ranked` posts still sit within 30 minutes of another visible ranking by the same actor. They form 143 bursts across 29 actors; 57 bursts have 5 or more posts (911 posts). By reason:

| Reason a post was left alone | Posts | Actors |
|---|---|---|
| after-watch: `today_default`, date 0 to 1 day old | 412 | 13 |
| after-watch: `unattributed` (an in-app date from before 2026-10-03, origin never recorded), 0 to 1 day old | 650 | 18 |
| has a comment, reaction or notification | 41 | 14 |
| title has a published review | 14 | 3 |
| update or rewatch, not a first ranking | 7 | 3 |
| no watch event | 1 | 1 |
| would count, but no other post in its window does | 12 | 7 |
| after the run's range (2026-11-19, forward path skipped as after-watch) | 6 | 1 |

- 97 of the 143 bursts are entirely after-watch.
- **Nothing was missed on window edges.** No two qualifying visible posts remain within 30 minutes of each other, so neither the fixed window nor the 8-day batch edges dropped anything.
- The 11 qualifying posts that sit right next to an existing group are left for two reasons. 10 have a comment, reaction or notification, and 1 has no watch event.
- **Watchlist leftovers are small:** 5 single watchlist posts are in a burst. Each one's only neighbour has a comment, reaction or notification, so it could not reach the 2-post minimum.

**Examples**

- **A. Today-dated rankings.** actor_h 6559bfdb, 2026-11-11 05:33:55Z to 06:27:54Z.
  - 94 cards: 85 movies and 9 seasons.
  - Ranked one title at a time: 92 separate placement sessions, not an Unranked sitting.
  - Every watch event has basis `today_default` with the ranking day as its date (46 the same UTC day, 48 the previous UTC day, which is the local date). Each was recorded less than 2 minutes before its ranking.
  - Nothing references these posts.
  - Excluded by the after-watch rule.
- **B. Pre-provenance unattributed dates.** actor_h 7330bcc4, 2026-09-09 00:02:49Z to 01:12:50Z.
  - 66 cards: 56 movies and 10 seasons.
  - 65 have basis `unattributed` with a date one UTC day earlier (the same local day). That is less than 7 days old, so they count as after-watch.
  - The one post that qualifies (ev f8b10e49, basis `none`) has no qualifying partner, so it fails the 2-post minimum.
  - The same actor has another burst on 2026-09-12 22:41Z to 23:30Z: 52 cards, all excluded for the same reason.
- **C. Referenced posts break a burst.** actor_h cfee0fde, 2026-09-17 03:36:42Z to 03:37:14Z.
  - 3 movies, all basis `none`, so all historical.
  - ev f573df60 and ev 77c4124a have comments, reactions or notifications, which leaves 1 qualifying post, below the minimum.
  - A similar case: actor_h fb638ab3 on 2026-09-15. History group 85f43394 (w05) covers 20:54:21Z to 21:19:35Z.
    - ev 1b41b77d (20:54:12Z) stays outside it because it has a comment or reaction and a notification.
    - ev 597d66b3 (20:55:16Z) stays outside because it has no watch event.
- **New posts after the OTA (D).** actor_h c21c9061, 2026-11-19 02:57:32Z to 02:58:39Z.
  - 6 title-page rankings (seasons and a show) in 67 seconds.
  - `rank_group_note` ran for each one and returned `after_watch` (`today_default`) every time.

## 7. Recommendations (nothing below has been done)

1. **#310 to #313 are fully deployed.** Migrations, flags and the OTA all match, and the consolidation matches its records exactly. No corrective action is needed.
2. **The after-watch rule decides the rest.** It excludes 1,062 of the 1,143 leftover burst posts.
   - The closeout records the `today_default` decision. It does not say that the larger share, 650 posts, is pre-2026-10-03 `unattributed` dates.
   - If the founder revisits the rule, two options:
     - Group `today_default`/`unattributed` first-time rankings when a burst has 3 or more rankings in 30 minutes and each watch event was recorded within about 2 minutes of its ranking. That is the "logged and ranked in one go" pattern every example shows.
     - Or treat `unattributed` dates as unreliable for history only.
   - Either change means a new migration and a staging dry run. After that, a production dry run (`p_apply = false` inside `begin transaction read only ... rollback`), then a new authorized batch with a new tag. The upper bound is about 1,062 posts in about 120 bursts; posts with comments, reactions, reviews or reranks stay excluded.
3. **Forward grouping will rarely fire under the current rule.** All 14 calls so far were skipped as after-watch, and the Unranked sitting path has not been used since 2026-10-01. Large backlog sessions (for example the 94-card one) come through one-at-a-time ranking.
   - Keep watching `processed_operations` for `kind = 'rank_group_note'` and its reason counts.
   - If after-watch stays at nearly 100%, consider either the burst rule above or steering backlog ranking toward Unranked.
4. **Keep the reference and review exclusions.** They cover 41 + 14 + 7 posts and protect conversations.
5. **One open check: nobody has looked at a grouped post on a physical device.** The closeout already lists this as the one check left for a person.
6. **Staging cannot test history consolidation yet.** It has no batches and no `rank_group_note` traffic. Any future rule change should be seeded and dry-run there first.
