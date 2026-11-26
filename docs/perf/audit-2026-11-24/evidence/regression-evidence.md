# REG: regression attribution, bingd Production and Preview (audit 2026-11-24/25)

Audit only. Nothing in the app, config or databases was changed. All production reads were read-only and bounded: analytics log queries at most 24 h per call, LIMIT ≤ 6000; pg_stat and cron reads ran on the read-only role. No ids, emails, JWTs, IPs or query strings are printed below. The founder's actor id was read from file into a variable and was used only inside SQL predicates.

Disposable material is in `(scratchpad) REG/`:
- query runners `q.sh`, `runq.sh`;
- daily aggregates `lq/agg_*.json`, `lq/fagg_*.json`;
- the founder's raw rows `lq/raw/*.json` (paths normalised; no ids or query strings);
- the analysers `trend.py`, `journeys.py`, `harness_an.py`;
- the jest harness `harness/zz-reg-harness.test.tsx` and its output in `harness-out/`;
- the pg_stat snapshots `snap1.json`, `snap2.json`, `pss_now.json` and the diff `pgdiff1.txt`.

The worktrees `/home/user/wt-audit-reg-before` (`a3300bf0`) and `/home/user/wt-audit-reg-after` (`32790c48`) were created, used, emptied of node_modules and removed.

---

## 1. Conclusion

**No production regression is confirmed in the server-visible part of the founder's journeys, comparing 11-12..11-19 with 11-20..11-23 (high confidence).** Over the same Android device and account, Production:
- served title pages with the same scores timing;
- reached the first ranking comparison in the same time;
- loaded the Feed faster.

Every main endpoint's server time is flat or better over the whole edge-log retention, 11-01..11-24. Two endpoints are the exceptions: `my_notifications` and the Leaderboard. Neither is on a title-page or ranking path.

**What did change, measured:**
1. **The app was relaunched about 1.8× as often per day.** This is the largest new factor found, but it is moderate and not unprecedented (supported) [edge-log]:
   - founder Android JS launches, counted as `report_device_context` calls over every day, complete: **9.25 a day on 11-20..11-23** (7, 9, 16, 5) against **5.1 a day on 11-12..11-19**;
   - the peak was 16 on 11-22, the day 6 OTAs were published. Earlier peaks reached 14 (11-09) and 11 (11-07, 11-12);
   - 16 production OTAs were published on 11-20..11-24, against 9 on 11-07..11-19;
   - each launch is a full startup with an empty React Query cache (no persister);
   - 23 of 44 sampled launches came less than 10 min after the previous request, i.e. inside a session. That share is similar in both periods;
   - the logs cannot tell an OTA foreground reload from a manual relaunch.
2. **A few small, real additions to request graphs** [static] [local-bench]:
   - series title pages gained reviews and a review count (#364, `ca4e89d2`, 11-22);
   - the Feed gained `feed_group_previews` (since 11-17, used on most loads since 11-21) and the notification `comment-shapes` reads (#365);
   - the post-log invalidation gained one prefix (`feed-group-reviews`, #347).

   Each adds one or two requests to an Android 5-slot queue. None is on the scores or ranking critical path, and none moves the measured timings.
3. **Two server paths got slower**, both off the founder's main symptoms [edge-log] [server]:
   - `my_notifications`: Android mean 282 → 359 ms; pg_stat 168 ms per call since 02:32Z against 55 ms all-time; no migration changed it;
   - the Leaderboard after #376 (`7877a79a`, 11-24): 530 ms per call against 256 ms all-time, n=5.

**The founder's symptoms are long-standing request-ordering and cold-cache costs**, documented by #378 and still present, which more frequent cold starts made visible far more often:
- artwork before scores;
- Where to Watch late;
- seasons filling in progressively;
- For You placeholders.

The "slower recently" impression most plausibly comes from four things together:
- (a) more cold starts during intensive QA with 16 OTAs, about 1.8× the earlier rate (supported);
- (b) the Preview running on staging's slower Micro host, which is Preview only (established by #378);
- (c) the specific season, rank and title-wave defects #378 fixed, which existed long before 11-20 (confirmed);
- (d) device-side render or image cost that server logs cannot see (unmeasured; an evidence gap).

**What would overturn this:** device timings (JS, render, image) showing a step change between a pre-11-20 bundle and the current one on the same device. Edge logs cannot see those. See §9.

---

## 2. Release timeline (production OTAs, both platforms, from `eas update:view`)

Runtimes never changed (Android `ec79e181…`, iOS `8ea562b7…` throughout, from 11-07). **No native change is in the window**, so the OkHttp 5-per-host behaviour is identical before and after. `package-lock.json` is byte-identical between `a3300bf0` and `32790c48`. Non-test JS source grew 5.18 MB → 5.43 MB (+4.8%) [static].

| # | Published (UTC) | Commit | PRs | Request/sequencing | RQ keys / invalidation | Mount / nav / render | Images | Backend / migrations | Startup / auth / Sentry / cron | Journeys |
|---|---|---|---|---|---|---|---|---|---|---|
| – | 11-07 22:13 | `f0f6d26e` | season page | – | – | episode rail | – | – | – | season |
| – | 11-09 19:31 | `19362af9` | #239 | – | – | – | trailer stills | – | – | title |
| – | 11-12 18:16 | `ace7c3fa` | TV rankings | ranking | – | – | – | 12 migrations, adapter | – | rank, title |
| – | 11-15 19:41 | `357bb126` | 1115 release | title +3 hooks (useLoggedCollection/useMyScores/useWatchlistToggle; cached collection reads) | – | Keep Show, Sent to You | – | 10 migrations, incl. `community_score` eligibility (20261119000100) | – | title, rank |
| – | 11-15 20:52 | `979e3c21` | Polish A | – | – | copy | – | – | – | – |
| – | 11-16 07:17 | `fb44d469` | #308 | – | – | 85% sheets | – | – | – | WH |
| – | 11-16 08:25 | `9d11a797` | #310/#311 | – | – | – | – | Feed grouping | – | Feed |
| – | 11-17 01:08 | `0170506e` | #312/#313 | Feed: `feed_group_previews` per grouped post | +`feed-group-previews` | poster rails | rail posters | grouping backfill | – | Feed |
| – | 11-19 09:04 | `a3300bf0` | #320/#323 | – | – | EngagementRow | – | – | – | Feed |
| 1 | 11-20 02:18 | `1c24b5cd` | #319/#321 | drag rerank (new journey) | rerank → full post-log invalidation | drag wall | – | 3 ranking migrations | – | Collection |
| 2 | 11-20 14:37 | `e86596f2` | #336/#328/#334 | title: **removed** the whole-cache count | follow → profile counts | – | – | half-hour grouping; **cron prune hourly** (less load) | – | title, Feed |
| 3 | 11-21 19:11 | `1101b029` | #350 | – | – | title actions row | – | job health (cron 12, new); **Feed index** (#342, faster) | ops cron +0.2 s per 10 min | title, Feed |
| 4 | 11-21 23:07 | `55db8b2b` | #347/#352 | – | +`feed-group-reviews` | – | – | reviewed-ranking grouping | – | Feed, log |
| 5 | 11-22 00:26 | `8e66e9ca` | #354 | session posts | preview key version | – | – | activity sessions (trigger logic on log path) | – | Feed, log |
| 6 | 11-22 04:22 | `42236e5f` | #357/#358 | – | – | PosterWall | – | two posts per window | – | Feed |
| 7 | 11-22 05:49 | `f942a716` | #362 | – | – | StatRow | – | – | – | Profile |
| 8 | 11-22 06:57 | `0aa2677e` | #363 | – | – | StatRow | – | – | – | Profile |
| 9 | 11-22 20:17 | `ca4e89d2` | #364/#365 | **series title +reviews, +count**; notifications `comment-shapes` (1–2 chained reads after `my_notifications` on Feed) | – | CommentThread | – | – | – | title(series), Feed |
| 10 | 11-22 21:24 | `41e6fcb5` | #366/#367/#368 | – | – | **3:2 hero** (taller frame; same URL size), FeedHeadline | same buckets | proactive (cron 13, about 30 ms per 15 min) | – | Feed |
| 11 | 11-23 01:20 | `3d950174` | #370/#372/#373 | – | – | heading system | – | – | – | all |
| 12 | 11-23 02:25 | `b11136d5` | #371 | For You: no new read | +2 invalidations on dismiss | Sent to You | – | 001200 | – | For You |
| 13 | 11-24 03:35 | `7877a79a` | #376 | Leaderboard selection | – | Leaderboard | – | **001300 `_leaderboard_counts`** (slower; §4.3) | – | Leaderboard |
| 14 | 11-24 04:48 | `03b4769d` | #374 | focused thread `useGroupPreviews` | – | **draggable sheet** | – | – | – | comments |
| 15 | 11-24 06:48 | `0de804e2` | #378 | rank_start first; title reads on route id; no season re-enrich | same keys | – | – | – | – | title, rank, season |
| 16 | 11-24 07:24 | `32790c48` | #380/#381 | Where to Watch observed early | `retryOnMount:false` | – | **For You w500→w342** (one disk-cache miss per poster), first-screen priority | – | Sentry Metro Debug-ID serializer | For You, title |

**OTA count [calc]:**
- 11-20..11-24: 16 OTAs in about 4.2 days, ≈ 3.8 a day (11-20: 2, 11-21: 2, 11-22: 6, 11-23: 2, 11-24: 4).
- 11-07..11-19: 9 OTAs in 12 days, ≈ 0.75 a day.

**Reload policy** (`app.config.ts` `updates.fallbackToCacheTimeout: 0`; `src/lib/updates.ts`, unchanged since 09-21) [static]:
- The launch check never blocks.
- On every foreground return, the app checks, downloads, and calls `reloadAsync()` if `isSafeToReload` (signed in, outside `(auth)`/`onboarding`).
- So the first foreground return after each publish restarts JS. It re-runs the whole startup burst, including `report_device_context` at 1.2 s, and empties every in-memory query.
- The expo-image disk cache survives a reload, so poster and backdrop bytes are not refetched. Only the decoded memory cache is lost.

---

## 3. Production edge-log evidence (the key new evidence)

**Source.** Management API `GET /v1/projects/abheeqyjzekiowkztfxv/analytics/endpoints/logs`:
- table `logs`, with `source='edge_logs'` and `source='function_edge_logs'`;
- `log_attributes` is a ClickHouse `Map(String,String)`;
- keys used: `request.path`, `request.method`, `request.headers.user_agent`, `response.origin_time`, `response.status_code`, `request.sb.jwt.authorization.payload.subject`, and for functions `execution_time_ms`.

**Limits.**
- Each call is capped at about 24 h of window and about 1000 returned rows.
- Retention reaches at least 11-01, so it covers the whole period before the 11-20 cluster.
- Traffic is low: 79–20,273 requests a day.

**Platform.** `okhttp` means Android; `CFNetwork` means iOS; "other" covers edge functions and scripts.

### 3.1 Server-side time per endpoint, trend by day [edge-log]

The table gives the founder's Android account, `response.origin_time` p50 in ms (n in brackets). The founder holds 50–90% of Android production traffic on most days.

| Endpoint | 11-07 | 11-12 | 11-15 | 11-19 | 11-20 | 11-21 | 11-22 | 11-23 | 11-24 |
|---|---|---|---|---|---|---|---|---|---|
| GET `media_items` | 39 (123) | 33 (279) | 28 (172) | 32 (61) | 27 (73) | 28 (438) | 29 (251) | 47 (25) | 39 (19) |
| `community_score` | 34 (40) | 36 (36) | 31 (56) | 37 (21) | 42 (8) | 38 (112) | 35 (53) | 45 (4) | 34 (3) |
| `rank_start` | 56 (7) | 81 (12) | 65 (8) | 303 (2) | 61 (1) | 69 (29) | 49 (7) | 55 (1) | – |
| `rank_answer` | 56 | 65 | 55 | 87 | 59 | 83 | 60 | 50 | – |
| `log_title` | 179 | 214 | 176 | 754 (2) | 192 | 176 | 149 | 172 | – |
| GET `feed_events` | 477 | 604 | 578 | 462 | 508 | **39** | **55** | **68** | **94** |
| `my_notifications` | 72 | 230 | 170 | 228 | 177 | 169 | **305** | **271** | **414** |
| `report_device_context` | 1283 | 1282 | 1336 | 1428 | 1355 | 1149 | 1320 | 1314 | 1193 |
| `tmdb-adapter` (exec ms, function log) | – | 432 | 494 | 716 | 620 | 504 | 426 | 606 | 501 |

Window means across all mobile users, 11-01..11-19 against 11-20..11-24 (n):

| Endpoint | Android, before | Android, after | iOS, before | iOS, after |
|---|---|---|---|---|
| `media_items` | 67 (1970) | 60 (847) | 114 (3623) | 104 (187) |
| `community_score` | 61 (485) | 88 (193) | 217 | 214 |
| `title_reviews_v2` | 69 | 67 | 236 | 154 |
| `rank_start` | 127 | 76 | 402 | 459 (n=10) |
| `log_title` | 331 | 266 | 440 | 272 |
| `feed_events` | 478 | **141** | 496 | **152** |
| `my_notifications` | 282 | **359** | 406 | 402 |
| `report_device_context` | 1394 | 1322 | 1490 | 1236 |
| auth token refresh (anon-signed, all users) | 720 | 675 | 738 | 615 |
| `leaderboard` | 518 (17) | **799 (16)** | 543 | 549 |
| `feed_group_previews` | 54 (**16**) | 81 (**192**) | 255 | 187 |

**Reading.**
- Title, ranking and catalogue reads are flat. The Android `community_score` mean rises on its tail; the founder's p50 is flat at 31–45 ms.
- `feed_events` got 3–10× faster on 11-21. That is #342's index, in `1101b029`'s backend window.
- `my_notifications` and the Leaderboard are the only endpoints that are slower.
- `tmdb-adapter` (Where to Watch, enrichment) executes at 0.4–0.7 s p50, unchanged all month.
- `feed_group_previews` is a request the Feed now makes on most loads.

### 3.2 The founder's production sessions, reconstructed [edge-log]

**Sample.** 27 founder-active hours on Android, 11-12..11-24: 12,091 rows, 11,659 of them Android. Five busy hours were truncated at 1000 rows, so each holds only its first 1000 requests.

**Periods** (each assigned by publication time; a device adopts an OTA only at its next safe foreground return or cold start, so the boundaries are approximate):
- P1: 11-12..11-19;
- P2: 11-20..11-23;
- P3: after #378/#381 (one session, 11-24 16:11Z).

| Journey (server-visible) | P1 | P2 | P3 |
|---|---|---|---|
| **Launch → last Feed read.** A launch is each `report_device_context`, which fires once per JS run; the clock starts at the first request of that burst. | median **3.19 s**, IQR 2.24–3.73 (n=15) | median **2.38 s**, IQR 1.59–3.64 (n=28) | 2.03 s (n=1) |
| Launch → `feed_events` | 1.47 s | 1.46 s | 1.53 s |
| **Title burst start → `community_score`.** The burst is the requests in a run with gaps under 400 ms that includes the title row. | median **0.47 s**, p90 0.85 (n=141) | median **0.46 s**, p90 0.86 (n=84) | 0.39 s (n=2; 0.51 and 0.27) |
| Requests sent before `community_score` inside that burst | 17 | 17.5 | 10 |
| **`log_title` → `rank_start`** (rank to first comparison) | median **0.79 s**, max 1.85 (n=25); 23 requests in between | median **0.84 s**, max 1.35 (n=20); 25 in between | no sample (no logs in production after OTA 7) |
| **Launches per day**: founder Android `report_device_context`, all hours (`agg_*.json`), not just the sampled hours | 5.1 a day (41 in 8 days) | **9.25 a day** (37 in 4 days; 16 on 11-22) | 6 on 11-24 |

**Observations.**
- **No step change in any journey at 11-20.** Feed launch got faster (index). Title scores and rank-to-comparison are statistically indistinguishable between P1 and P2.
- **Production rank-to-comparison is 0.8 s median, not the 1.7–2.7 s seen on staging.** It is the same queueing mechanism #378 describes: 23–25 refresh requests before `rank_start`. Production's shorter round trips and faster host shrink it. It is old: it is present in 11-12 sessions.
- **Concurrency.** Android arrivals do pack in groups; there were 1,597 100-ms windows with exactly 5 arrivals and 750 with 7. The windows go up to 10 arrivals per 100 ms, which means slots recycle in under 100 ms on the founder's link. So the 5-slot cap costs roughly one round trip per 5 queued requests, as #378 modelled.
- **Example post-#381 session** (11-24 16:11Z, relative times; the founder's only production session after OTA 8):
  - Launch: `profiles` at 0, then `report_device_context` at +0.60 s (988 ms origin). The Feed burst is 20 requests, the last at +2.03 s.
  - Open For You: +4.29 s → +5.19 s.
  - First title open (a season): row read at +6.13 s; `community_score` sent 0.51 s after the row, 9th–13th in the burst.
  - Repeat title opens: the same 12–15 requests, with scores 0.27 s after the first.
  - Every title read executed in 17–60 ms. **Scores still wait on the 5-slot queue behind the row, the collection reads and the facet reads**, even after #378. The reason is that #378 moved them into the *first* wave alongside 14 other requests, rather than ahead of them (§5).
- **Relaunch pattern.** In the sampled hours, 23 of 44 launches had less than 10 min of silence before them, so the app was being restarted mid-session. Examples:
  - 11-22 06:01 and 06:41Z: 2 and 3 launches 12–53 min after `f942a716` was published;
  - 11-23 01:20Z: a launch in the minute `3d950174` was published.
  The same pattern exists in P1 (11-12 18:41–18:45Z: 7 launches 25–29 min after `ace7c3fa`). The edge log cannot say whether a given relaunch is an OTA reload or a manual one.

---

## 4. Server measurements

### 4.1 pg_stat_statements, 30-minute diff on production [server]

Taken 19:42:23Z and 20:14:05Z on 11-24 (`snap1.json`, `snap2.json`, `pgdiff1.txt`).

**Zero app RPC or table calls in the window.** Production had no user traffic, so the diff measures only background work. That is itself a finding: per-call app means cannot be measured in a 30–45 min window at this traffic level.

| Statement | Calls in window | Window mean | All-time mean (since 08-13) |
|---|---|---|---|
| `_release_evaluate` (+ prune), every 15 min | 2 | **951 ms** | 314 ms |
| `ops_health_tick`, every 10 min | 4 | 231 ms | 189 ms |
| `_release_refresh_tick`, hourly | 1 | 555 ms | 638 ms |
| `_import_sweep_abandoned` (+ nudge, prune), every minute | 32 | 18 ms | 241 ms |
| `_drain_import_jobs`, every 10 s | 189 | 3.2 ms | 3.4 ms |
| `_proactive_tick` (pilot), every 15 min | 2 | 31 ms | 26 ms |

### 4.2 Longer pg_stat diff: 11-24 02:32Z (#378's saved snapshot `pss_prod.tsv`) → 11-24 ~20:05Z [server]

About 17.5 h, grouped by role and RPC/table exactly as #378 did. The window covers the founder's 02:00, 05:00 and 16:00 sessions and other users. **The counts are small; read these as directional.**

| Label | Calls | Window mean | All-time mean at 02:32Z |
|---|---|---|---|
| rest `rankings` | 101 | 22.4 | 22.6 |
| rest `media_items` | 76 | 4.7 | 3.7 |
| rest `feed_events` | 39 | **17.3** | 157.6 |
| rest `media_cache` | 38 | 2.8 | 22.2 |
| `public_scores` / `feed_watch_scores` | 37 / 37 | 14.6 / 16.5 | 21.9 / 22.9 |
| **`my_notifications`** | 30 | **167.7** | 55.2 |
| `feed_group_previews` | 24 | 51.7 | 51.2 |
| `title_reviews_v2` | 19 | 16.9 | 23.9 |
| **`community_score`** | 19 | **75.4** | 14.0 (EXPLAIN 10.5 ms, #378) |
| `rank_answer` | 19 | 72.6 | 53.2 |
| `rank_start` | 5 | 180.8 | 54.7 |
| `log_title` | 5 | 223.2 | 253.7 |
| **`leaderboard`** / `my_leaderboard_standing` | 5 / 5 | **530 / 376** | 256 / 166 |
| `report_device_context` | 5 | 1093 | 1201 |

**Interpretation.**
- **`my_notifications`** is about 3× its all-time mean and agrees with the edge-log rise (founder p50 170 → 270–414 ms from 11-22). No migration redefined it after `20261101000100`. The likely causes are inbox growth, more comment and proactive rows, or a plan change with data volume. That is a Hypothesis; the backend worker should EXPLAIN it.
- **`community_score`'s** window mean is inflated, against a flat founder edge p50 of 34–45 ms. The likely cause is cold buffers on a Nano instance (`shared_buffers` 224 MB) after idle hours, plus a few heavy titles. Hypothesis.
- **The Leaderboard** is slower since #376 / 001300.

### 4.3 Background (pg_cron) workload by day, from `cron.job_run_details` [server]

| Job | 11-17..11-20 | 11-21..11-24 |
|---|---|---|
| import maintenance (job 8), every minute | avg 241–433 ms, busy 347–624 s a day | **avg 52–55 ms, busy 65–79 s a day** |
| release-evaluate (job 10), every 15 min | avg 419–486 ms, p95 2.2–2.5 s | avg 527–570 ms, p95 2.1–2.3 s, max 2.75 s |
| release-refresh (job 9), hourly | 713–955 ms | 866–913 ms |
| ops-health (job 12), from 11-20 | – | about 180–213 ms per 10 min, 25–27 s a day |
| proactive (job 13), from 11-22 | – | about 30 ms per 15 min, 3 s a day |
| **Total busy** | **≈ 750 s a day (11-19)** | **≈ 230 s a day (11-23)** |

**Background load fell by about two-thirds after 11-21.** The new jobs (ops-health, proactive) are small. The new backend workloads did not make production busier. One spike remains: `release-evaluate` holds a core for 2–2.7 s at :00/:15/:30/:45. This is a Hypothesis for occasional sub-second hiccups on a 2-core shared Nano; it is not new.

---

## 5. Controlled before/after request graph [local-bench]

**Harness.** A disposable jest test was run at `a3300bf0` (the last production OTA before the 11-20 cluster) and at `32790c48`, with identical mocks:
- every Supabase response delayed 40 ms;
- the real `use-enrichment` and `tmdb-adapter`, with `functions.invoke` recorded;
- a catalogued title with its credits, videos and similar facets present.

**Output.** A wave is one 40 ms step of dependency depth. The film's 660 ms gap in the earlier run is the title-layout hydration timer in the test environment, not a network dependency.

| Open | `a3300bf0` | `32790c48` |
|---|---|---|
| **Film** | **18 requests**, 1 edge. Wave 0: 7 (row + collection reads). Wave 1: 9 (scores, reviews, count, videos, similar…). Wave 2: credits | **17 requests**, 1 edge. **Wave 0: 15** (row, collection reads, both scores, reviews, count, credits, videos, watch-providers edge call, watch_events). Wave 1: 2 |
| **Series** | 21 requests, 2 edge (watch-providers, `detail`). No reviews for a whole show | 22 requests, 2 edge. **+`title_reviews_v2` +`title_review_count`** (#364); −`media_cache` head count (#336). Wave 0: 15 |
| **Season** | 20 requests, **3 edge** (watch-providers, **`detail` on every visit**, season-episodes); 3–4 waves | 18 requests, **2 edge**; 2 waves |

**Reading.**
- Title-page request volume did not grow over the window. It fell for films and seasons and rose by one net request for whole shows. Dependency depth went from three waves to two.
- With Android's 5-slot FIFO, the first wave of 15 means the scores, at positions 9–10, still leave in the second slot round, and the Where to Watch edge call (0.4–0.7 s execution) holds a slot for its whole duration. That fits the post-#381 production session, where scores reached the server 0.27–0.51 s after the row.
- A Feed-open and post-log fan-out harness was not run (bounded scope). That fan-out belongs to the client worker. Static diff `a3300bf0..32790c48` of `invalidateAfterCollectionChange`: 21 → 22 prefixes (+`feed-group-reviews`). The production edge logs show 23 vs 25 requests between `log_title` and `rank_start` (§3.2).

---

## 6. Symptoms → mechanism

| Symptom | Mechanism | New since 11-20? | Evidence |
|---|---|---|---|
| Artwork before scores and secondary info | The title row and the image draw first; scores queue behind 9–15 requests in Android's 5 slots, and before #378 they waited for the row | **No.** Same 0.47 / 0.46 s median in P1/P2; occurs on every cold start, and cold starts became about 1.8× more frequent | [edge-log] §3.2, [local-bench] §5 |
| Where to Watch late | A `tmdb-adapter` `watch-providers` edge call: 0.4–0.7 s execution plus the hops and the queue; before #381 it only left once the block mounted | No (execution flat all month) | [edge-log] function logs; [static] #381 |
| For You placeholders | Images load from TMDB per tile, and a reload loses the memory cache. #381 changed every URL (w500 → w342), so **every poster is a disk-cache miss once after OTA 8** | Partly. The w342 miss is new and one-off; the rest is old | [static]; device timing unmeasured |
| First ranking comparison sometimes slow | `rank_start` queued behind the post-log refresh: 23–25 requests, 0.8 s median and up to 1.85 s in production; 1.7–2.7 s on staging | No (P1 0.79 s against P2 0.84 s). Fixed by #378 | [edge-log] |
| Seasons and episodes fill in progressively | `isThin` re-enriched every season visit (`detail` edge call, then 6 refetches) | No (as old as the rule). Fixed by #378 | [local-bench] 3 → 2 edge calls; #378 |
| Occasional sub-second delays | Queue bursts; `report_device_context` holding a connection about 1.2 s at every launch; cron spikes of 2–2.7 s every 15 min on a shared 2-core host | No | [edge-log], [server] |
| "It became slower recently" (Prod + Preview) | More cold starts (16 OTAs; launches 9.25 a day against 5.1 a day); Preview on the slower staging host; intensive QA attention | **Partly: the launch frequency rose about 1.8×** | [edge-log] §3.2, [calc] §2 |
| Feed / notifications slowish (not in the founder's list) | `my_notifications` +50–150 ms server-side; Leaderboard about 2× after #376 | **Yes, both** | [edge-log], [server] |

---

## 7. Hypotheses, each evaluated

| Hypothesis | Verdict | Evidence |
|---|---|---|
| New request dependencies on critical paths | **Refuted** for title, rank and seasons: the request count is flat or lower and the depth is lower. **Minor, confirmed** for whole-show title pages (+2, #364) and for the Feed (`feed_group_previews`, `comment-shapes`) | [local-bench] §5, [edge-log] |
| Existing contention exposed (Android 5/host) | **Confirmed as the mechanism, not new.** Identical native runtime throughout; the P1 journeys show the same queueing | [edge-log], [static] |
| Invalidation fan-out grew | **Refuted as a regression** (+1 prefix; 23 → 25 requests before `rank_start`). Still a live old bottleneck | [static], [edge-log] |
| Cold caches after frequent OTAs | **Supported** as the largest *new* factor, but moderate: launch rate about 1.8× (5.1 → 9.25 a day; 16 on 11-22); half the launches mid-session in both periods. Each launch costs about 2–3 s to a loaded Feed, plus cold title pages | [edge-log], [calc] |
| Poster URL change (#381, w342) | **Confirmed, one-off**: one disk-cache miss per For You poster, after 11-24 07:24 only. It cannot explain anything reported before 11-24 | [static] |
| New backend workloads (proactive cron, leaderboard counting, feed grouping) | **Refuted for load.** Cron busy time fell from about 750 to about 230 s a day; proactive about 3 s a day. **Confirmed narrowly**: the Leaderboard RPC is slower after 001300 | [server] |
| Session/token refresh | Refuted as a regression (refresh 600–800 ms, flat). Still an old startup cost when it happens | [edge-log] |
| Sentry overhead | **Refuted.** `monitoring.ts` is unchanged in the window; `tracesSampleRate` 0.2 throughout; the Metro serializer only shipped at 07:24 on 11-24, after the complaints | [static] |
| New mount/render work (#368 3:2 hero, #374 sheet, #370–#373) | **Unverifiable here.** Server logs cannot see JS/render. Hero URL buckets are unchanged (taller frame only); #378 found no font parsing. **Evidence gap** | [static] |
| Network variability | Not separable from the logs. Server-side origin times are flat, so any network change would be on the client side. Evidence gap | – |
| Library size growth | Refuted as material. Paged `rankings`/`user_media` reads per launch are steady and their per-call times flat (22 ms) | [edge-log], [server] |
| Staging vs production | **Confirmed Preview-only amplifier** (#378: staging 1.3–2× per query, and a longer RTT). Production rank-to-comparison is 0.8 s, against 1.7–2.7 s on staging | prior [edge-log], §3.2 |
| `feed_events` slow (old) | **Fixed** 11-21 (#342 index): 500 → 40–90 ms | [edge-log] |

---

## 8. Candidate findings

### F-REG-1. Cold starts became more frequent during the OTA burst
- **Affected journey:** every journey's first visit after a launch.
- **Root cause:**
  - `src/lib/updates.ts` reloads on the first safe foreground return after each OTA;
  - 16 OTAs were published 11-20..11-24;
  - there is no persisted query cache;
  - so every reload re-pays the whole startup and every title page is cold.
- **Evidence:**
  - founder Android launch rate 5.1 a day (11-12..19) against 9.25 a day (11-20..23), peak 16 on 11-22 [edge-log, complete daily counts];
  - 23 of 44 sampled launches were mid-session [edge-log];
  - 16 against 9 OTAs [calc];
  - the server-visible startup costs about 2.4 s median to a loaded Feed [edge-log];
  - the share caused by OTA reloads rather than manual relaunches is unknown.
- **Confidence:** Supported for the rate increase; the share of the felt slowdown it explains is a Hypothesis.
- **User impact:** H for testers and the founder during release bursts; L for ordinary users who see about 1 OTA per visit.
- **Proposed remedy:**
  - batch production OTAs, one a day or less, outside a QA session;
  - and/or a persisted React Query cache (#378 P2) so that a reload draws the last Feed and title pages at once.
- **Lower-risk alternative:** a release-cadence rule only; no code.
- **Disruption risk:** L for cadence; M for persistence (cross-account leakage; a stale ranking shown before a refetch).
- **Effort:** small (cadence) / moderate (persistence).
- **Verification burden:** Diagnostics "app mounts" against update id, on the device.
- **Invariants touched:** none for cadence. Persistence touches auth/privacy (no cross-account cache) and Rankings (no stale band driving a comparison).
- **Class:** A (cadence) / B (persistence).

### F-REG-2. Title scores are still queued behind the first wave after #378
- **Affected journey:** title page, scores and Where to Watch.
- **Root cause:**
  - #378/#381 moved the scores into wave 0, but wave 0 is now 15 requests: the row, 6 collection reads, the facets, the reviews, the count, the watch-providers edge call and `watch_events`;
  - with 5 FIFO slots, the scores (positions 9–10) still wait a round;
  - the edge call holds a slot 0.4–0.7 s.
- **Evidence:** wave 0 = 15 at `32790c48` [local-bench]; post-#381 production session, scores 0.27–0.51 s after the row, execution 17–60 ms [edge-log]; `tmdb-adapter` p50 430–720 ms [edge-log].
- **Confidence:** Strongly supported.
- **User impact:** M.
- **Proposed remedy:** issue order inside wave 0 — scores and the row first; collection reads that are cached app-wide (rankings, user_media, watchlist) served from the existing cache rather than refetched on mount; the watch-providers edge call last. Or the native per-host limit (#378 P2.4).
- **Lower-risk alternative:** reorder hook calls in `app/title/[id].tsx` only, keeping the keys unchanged.
- **Disruption risk:** L (order) / M (native).
- **Effort:** small / structural-native.
- **Verification burden:** the `mockAsked` order test plus a Diagnostics ring on the device.
- **Invariants touched:** none (same keys and the same invalidations).
- **Class:** A.

### F-REG-3. `my_notifications` server time roughly doubled since about 11-22
- **Affected journey:** Feed tab mount (badge), the notifications inbox.
- **Root cause:** unknown. No migration changed it; candidates are data growth (comment and proactive rows) and plan drift.
- **Evidence:**
  - founder edge p50 170 → 271–414 ms (11-22..24) [edge-log];
  - Android mean 282 → 359 ms [edge-log];
  - pg_stat window mean 168 ms against 55 ms all-time (n=30) [server].
- **Confidence:** Strongly supported that it is slower; cause a Hypothesis.
- **User impact:** L–M. It is in the Feed startup burst and holds a slot for about 0.3–0.5 s.
- **Proposed remedy:** EXPLAIN ANALYZE as the founder in a rolled-back transaction (backend worker), then index or limit it.
- **Lower-risk alternative:** defer the badge read until after the first Feed page.
- **Disruption risk:** L.
- **Effort:** small–moderate.
- **Verification burden:** pg_stat delta.
- **Invariants touched:** notifications correctness and RLS.
- **Class:** D.

### F-REG-4. The Leaderboard is slower since #376 (`20261130001300`)
- **Affected journey:** Feed → Leaderboard.
- **Root cause:** the per-title `_leaderboard_counts` counting.
- **Evidence:** pg_stat window 530 ms against 256 ms (n=5); `my_leaderboard_standing` 376 against 166 [server]; Android edge mean 518 → 799 ms (n 17 → 16) [edge-log]; #378 EXPLAIN 113 ms on production against 33 ms on staging.
- **Confidence:** Strongly supported (small n).
- **User impact:** L.
- **Proposed remedy:** the backend worker to EXPLAIN it; consider a covering index or a materialised monthly count.
- **Lower-risk alternative:** a longer `staleTime` on the board.
- **Disruption risk:** L–M.
- **Effort:** moderate.
- **Verification burden:** EXPLAIN plus the leaderboard tests.
- **Invariants touched:** the leaderboard "a title counted once" rule.
- **Class:** D.

### F-REG-5. Whole-show title pages gained two requests (#364), and the Feed gained `feed_group_previews` and `comment-shapes`
- **Affected journey:** series title, Feed startup.
- **Root cause:** new features add reads to existing Android-queued bursts.
- **Evidence:** series 21 → 22 net requests (+reviews +count) [local-bench]; `feed_group_previews` calls 16 → 192 per period on Android [edge-log]; `comment-shapes` is 1–2 chained reads after `my_notifications` [static].
- **Confidence:** Confirmed (that they exist); impact a Hypothesis (no measured journey moved).
- **User impact:** L.
- **Proposed remedy:** the review count only once the tab is visible; previews after the first page.
- **Lower-risk alternative:** none needed now.
- **Disruption risk:** L.
- **Effort:** small.
- **Verification burden:** the request-order tests.
- **Invariants touched:** feed grouping display.
- **Class:** D.

### F-REG-6. The #381 poster URL change makes For You cold once
- **Affected journey:** For You, after OTA 8.
- **Root cause:** the expo-image disk cache is keyed by URL; w500 → w342 changes every key.
- **Evidence:** [static]; no device timing.
- **Confidence:** Confirmed (mechanism).
- **User impact:** L (one-off per poster).
- **Proposed remedy:** none (self-healing). Avoid size-bucket churn in OTAs during QA.
- **Lower-risk alternative:** –.
- **Disruption risk:** L.
- **Effort:** –.
- **Verification burden:** –.
- **Invariants touched:** none.
- **Class:** D.

### F-REG-7. The `release-evaluate` cron burns a core for 2–2.7 s every 15 min on a shared 2-core host
- **Affected system:** backend; possibly occasional hiccups.
- **Root cause:** `_release_evaluate` plus pruning.
- **Evidence:** p95 2.1–2.5 s, max 2.75 s per day; 951 ms mean in the 19:42–20:14Z window [server].
- **Confidence:** Hypothesis that it affects users; no correlation measured.
- **User impact:** L.
- **Proposed remedy:** profile it; move it off :00/:15 alignments; make the pruning cheaper.
- **Lower-risk alternative:** leave it.
- **Disruption risk:** L.
- **Effort:** moderate.
- **Verification burden:** cron history.
- **Invariants touched:** release notifications.
- **Class:** F.

### F-REG-8. Old bottlenecks confirmed still present on production (not regressions)
- `report_device_context`: 1.15–1.43 s p50 every day since 11-01, once per launch. Because F-REG-1 multiplies launches, it multiplies this too [edge-log].
- Post-log refresh before `rank_start` on production: 0.8 s median, up to 1.85 s. It predates 11-20; fixed by #378, but no production measurement exists yet after the fix [edge-log].
- `tmdb-adapter` 0.4–0.7 s p50 (Where to Watch, enrichment) [edge-log].
- Token refresh about 0.6–0.8 s at startup after idle [edge-log].
- Unvirtualised Feed `ScrollView` (hardening review) [static].
- **Class:** see the owning workers. Listed here only to separate "old" from "new".

---

## 9. Evidence gaps (and the smallest follow-up)

1. **Device-side time is invisible to edge logs:** JS work, render (#368 hero, #374 sheet), image decode and transfer. Smallest follow-up:
   - the founder's Diagnostics ring (#378 steps 2–5) on Production now;
   - optionally, one cold start on a device pinned to an earlier bundle via a rollback-free side Preview channel. Do not republish production.
2. **OTA reload against manual relaunch.** The logs cannot distinguish them. Smallest follow-up: Diagnostics "app mount" and update id at the next slow launch. Or, preventively, a breadcrumb or analytics event on `reloadAsync`. That is a code change, so not done here.
3. **No production samples after #378 for rank-to-comparison, and only one session after #381** (11-24 16:11Z, 87 requests). Smallest follow-up: rerun `journeys.py` on the next founder session, same queries.
4. **pg_stat 30–45 min diff:** production had zero app calls in the window, so current per-call app means are not measurable that way at this traffic level. The 17.5 h diff against #378's snapshot (n 5–101 per statement) is the best available. Recommend a dated snapshot before the launch push (as the hardening review says).
5. **Network variability on the founder's device** (Wi-Fi against mobile) cannot be separated. The edge timestamp gaps include it.
6. **Five busy hours were truncated at 1000 rows** (11-12 23Z, 11-15 20Z, 11-21 15Z and 21Z, 11-22 17Z). These are samples, not complete sessions.
7. **Preview (staging) logs were not re-pulled for 11-24 after #378/#381.** The founder's post-#378 Preview report is the only evidence there [device, reported].

---

## 10. Minimal remedies (findings only; not implemented)

1. **Release cadence (F-REG-1, class A).** No more than one production OTA a day while the founder is QA-ing, batched. Each publish is a forced cold start for every active user. No code.
2. **Title wave 0 order (F-REG-2, class A).** Scores and the row first; the edge call last; cached collection reads served from cache. JS only, same keys.
3. **Persisted query cache (F-REG-1, class B).** Removes the cold-start penalty that frequent OTAs expose. Must namespace by account and must never feed a ranking comparison from persisted data.
4. **EXPLAIN `my_notifications` and `leaderboard` as the founder (F-REG-3/4, class D).** Backend worker.
5. **`report_device_context` without the `pg_timezone_names` scan** (old, #378 P2.8). It costs more now that launches are frequent.
