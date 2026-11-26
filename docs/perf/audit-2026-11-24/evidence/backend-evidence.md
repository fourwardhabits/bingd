# BE: backend, database and Edge Functions (audit 2026-11-24, 19:40–20:20Z)

Scope: production `abheeqyjzekiowkztfxv` (read-only; every EXPLAIN in `begin transaction read only … rollback`)
and staging `fjxhcbowoxuzulwirzyr` (read-only, plus one read-write `rank_start` that was rolled back).
Nothing was changed. Harness, raw snapshots and saved plans: `(scratchpad) BE/`
(`q.py`, `ex.py`, `logs.py`, `plans/`, `pss*_*.jsonl`, `daily_prod.jsonl`, `edge_*_1124.json`).

**Privacy note for other workers:** `GET /v1/projects/<ref>/postgrest` returns the project's `jwt_secret` in clear.
I did not record it anywhere; do not print that response.

**Logs endpoint, for the coordinator:** the new `GET …/analytics/endpoints/logs` has **one table, `logs`**, with
columns `timestamp`, `event_message`, `severity_text`, `source` and a map `log_attributes` (flattened keys such as
`log_attributes['request.path']`, `['response.origin_time']`, `['execution_time_ms']`). The dialect is ClickHouse
(`quantile(0.5)(toFloat64OrZero(…))`, `lagInFrame`). Sources: `edge_logs`, `postgrest_logs`, `postgres_logs`,
`function_edge_logs`, `function_logs`, `auth_logs`. `select *` is refused. Each call covers at most about 24 h, and
production history goes back **at least to 2026-10-21**. The endpoint is rate-limited and shared by all workers.

## Headline

Warm server execution is fast on both projects. Every title-page read takes 0.04–13 ms. The problem is the
**per-request overhead on production**, which runs on **Nano compute** (no add-on, 0.5 GB, aarch64). Staging runs
on Micro (1 GB, 2 shared CPUs). Two settings follow from compute size: production's **PostgREST pool is 10
connections** against staging's 20, and both drop idle connections after **30 s**. Production traffic is sparse
(about 1,500 REST requests a day), so most app-open bursts start on cold connections:

- **A first request after more than 60 s of idle takes 687 ms p50 on production.** Requests inside a burst take
  55 ms. On staging the same figures are 228 ms and 22 ms.
- **The same endpoints are 2–5× slower at the edge on production than on staging.** This happened although the
  same warm SQL is as fast or faster on production.

This has been true since at least 2026-11-01, so it is a standing property of production, not a regression. It
does match the founder's symptom on Production: scores, counts and metadata fill in after the artwork. Three
specific server costs add to it:

- `report_device_context` takes 1.2 s because of `pg_timezone_names`. Confirmed.
- `my_notifications` runs a proactive-social lateral on every row. Confirmed; about 80% of its time.
- `leaderboard` runs `taste_match` on every row. Confirmed; about 85% of its time.

---

## 1. Capacity, plan and data size

| | Production | Staging |
|---|---|---|
| Compute | **No compute add-on = Nano** (billing add-ons: none selected; `ci_micro` offered as an upgrade) [server] | **Micro** `ci_micro`, 2 shared CPU, 1 GB, 60 direct / 200 pooler connections [server] |
| CPU | aarch64 (Graviton class) [server] | x86_64 [server] |
| `max_connections` / reserved | 60 / 3 superuser [server] | 60 [server] |
| `shared_buffers` / `effective_cache_size` / `work_mem` / `maintenance_work_mem` | 224 MB / 384 MB / 2.1 MB / 32 MB [server] | 256 MB / 768 MB / 3.5 MB / 64 MB [server] |
| `max_wal_size` / `wal_buffers` | 1 GB / 492 × 8 kB [server] | 4 GB / 983 × 8 kB [server] |
| PostgREST pool (`postgrest_logs`: "Connection Pool initialized with a maximum size of N") | **10** [edge-log, 11-24 02:53 and 14:34] | **20** [edge-log, 11-20] |
| PostgREST `db_pool_max_idletime` / `max_lifetime` | 30 s / 1,800 s [server, Management API] | 30 s / 1,800 s |
| Supavisor | transaction mode, pool size default | same |
| Disk | gp3, 2 GB, 3,000 IOPS, 125 MiB/s; 441 MB used [server] | same volume spec |
| DB size | 135 MB [server] | 111 MB [server] |
| Cache hit, tables / indexes | 100% / 99.999%; `pg_stat_io` client-backend relation reads 2,690 lifetime against 1.16 B hits [server] | 100% / 99.997% |
| Connections at 19:42Z | 11 total: 1 PostgREST (idle), 1 pg_net, 1 exporter, 1 mgmt-api, the rest background [server, n=1 sample] | 11, same shape |
| `temp_bytes` since 07-24 | 999 GB in 236,626 files (+35 files in 20 min) [server] | 973 GB |
| Deadlocks lifetime | 4 [server] | 2 |
| `statement_timeout` | 8 s authenticated, 3 s anon (hardening review) | |

### Main tables (production, `pg_stat_user_tables`, 19:45Z) [server]

| Table | Rows | Heap / idx | Dead | Created in the last 30 d (7 d) |
|---|---|---|---|---|
| media_items | 27,629 | 18 MB / 13 MB | 410 | (no `created_at`) |
| comparisons | 9,054 | 1.2 / 1.3 MB | 1,824 | 1,975 (378) |
| media_cache | 4,847 | 5.8 MB / 0.5 MB | 134 | (none) |
| feed_events | 2,363 | 0.6 / 0.75 MB | 218 | 594 (113) |
| watch_events | 2,187 | 0.4 / 0.5 MB | 64 | (none) |
| user_media | 2,167 | 0.4 / 0.4 MB | 276 | 458 (77) |
| ranking_placements | 1,993 | 0.4 / 0.4 MB | 13 | 502 (92) |
| rankings | 1,938 | 0.25 / 0.8 MB | 0 (306 autovacuums: 102k updates from position shifts) | 468 (79) |
| watchlist | 811 | | 105 | 57 (17) |
| notifications | 319 | | 81 | 97 (35) |
| comments ("activity_comments") | 56 | | 23 | 19 (9) |
| reactions | 54 | | | 21 (7) |
| profiles | 53 | | 15 | 5 (0) |
| `cron.job_run_details` | **205,212** | 32 MB heap / 19 MB idx = **38% of the DB** | 10,237 | push-drain 122.8k since 08-31, unpruned |

- **Per-user library sizes.** 46 users have libraries. The p50 is 7 titles, p90 143, max 782. The founder has
  208 titles, 208 rankings and follows 28 accounts. The "light" account in the tests below is the largest
  account with 5–15 titles.
- **Staging.** It holds about 5× less user data (rankings 390, user_media 427, feed_events 476) and 9,220
  media_items.

## 2. pg_stat_statements

- **History.** Statistics have not been reset since 2026-08-13 (postmaster start 08-13 10:12), and
  `pg_stat_statements_info.dealloc = 8`, so some entries have been evicted at `max = 5000`. Production carries
  40,898 s of tracked time.
- **Snapshots.** I took three, at 19:42, 19:54 and 20:17Z, about 35 minutes apart.
- **The diff has no user traffic in it.** Over the 34 minutes there were essentially zero app calls. The only
  activity was cron and my own audit statements (excluded). So **the diff cannot give current RPC means**. It
  does give the background load: production cron used 6.7 s against staging's 1.5 s for the same jobs. The
  edge-log figures in §6 stand in for current means.

### Cumulative top statements, production (since 08-13) [server]

| Statement | Calls | Mean ms | Max ms | Total s | Note |
|---|---|---|---|---|---|
| cron `bingd-import-maintenance` (sweep + nudge + prune) | 102k | 241 | 12,521 | **24,614 (60% of all DB time)** | Historical. Today: p50 14.6 ms, but **2.2 s at :17** (prune), §5 |
| cron `_drain_import_jobs` (every 10 s) | 611k | 3.4 | 1,518 | 2,062 | |
| cron `release-evaluate` + prune | 6.3k | 314 | 4,175 | 1,984 | 2.0 s at :00 |
| REST `feed_events` (current-bundle first page) | 6,753 | 154 | 3,138 | 1,039 | Hardening review: about 35 ms since #342 |
| cron `_release_refresh_tick` | 1,585 | 638 | 2,776 | 1,011 | 0.9 s at :07 |
| **rpc `report_device_context`** | 505 | **1,200** | 5,392 | 606 | §3, F-BE-3 |
| rpc `tmdb_upsert_titles` (service_role) | 8,795 | 61 | 2,034 | 532 | |
| rpc `rank_answer` | 9,048 | 57 | 3,510 | 517 | |
| REST `media_cache` `select *` LIMIT/OFFSET **with an exact count over the whole table** | 4,860 | 86 | **6,985** | 416 | Not in the current app or functions code (F-BE-10) |
| rpc `my_notifications` (two shapes) | 6,768 + 860 | 46 / 191 | 2,637 | 474 | F-BE-4 |
| rpc `search_titles` | 5,330 | 56 | 4,005 | 300 | |
| rpc `log_title` | 771 | 254 | 3,459 | 195 | |
| rpc `rank_start` | 2,020 | 68 | 2,506 | 137 | |
| `SELECT name FROM pg_timezone_names` (authenticator, i.e. PostgREST's schema-cache load) | 234 | **593** | 2,128 | 139 | |
| rpc `leaderboard` | 277 | 280 | 3,066 | 78 | F-BE-6 |
| rpc `my_leaderboard_standing` | 298 | 171 | 2,108 | 51 | |
| rpc `community_score` | 7,701 | 14 | 2,059 | 109 | Max 2 s against a 5–10 ms plan: queueing or a cold connection, not the SQL |

Most app RPCs show a max of 1–3.5 s against means of 5–60 ms. That points to waiting or cold connections rather
than bad plans (see F-BE-2 and F-BE-5).

## 3. Critical-path EXPLAIN (ANALYZE, BUFFERS), production

- **Setup.** Each run is a fresh Management API backend (`backend_start` is 80–110 ms old at the first
  statement). The runs used the founder's claims with `set local role authenticated`, plus a light account.
- **Title.** The title used is the movie with the most `user_media` rows.
- **Cold and warm.** "Cold" is the first execution in a new backend. "Warm" is the third execution in the same
  transaction.
- **Plan times.** Planning time is under 1 ms for every RPC: they are SQL or plpgsql functions planned inside.
  The one exception is the first REST-shaped query in a backend, at 3–21 ms.
- **Saved plans** are in `BE/plans/`.

| Read | Founder cold | Founder warm | Light cold | Staging (heaviest user) cold |
|---|---|---|---|---|
| `media_items` row by id | 0.04 ms (plan 0.4) | | | |
| `media_cache` row (pkey) | 3.7 ms (**plan 14.2**) | 0.014 ms | | 3.3 |
| `community_score` | 9.7 / 5.2 | 4.5 | 8.0 | 9.8 |
| `following_score` | 6.6 | | 4.5 | 4.3 |
| `title_reviews_v2(…, 'helpful', 100)` | 12.9 | | 6.3 | 4.8 |
| `title_review_count` | 2.0 | | | 0.7 |
| `following_ratings` | 88 | 48 | | 16.5 |
| `title_recommendations_for_me` | 3.2 | | | |
| user_media / rankings / watchlist row, watch count | 0.04–0.39 | | | |
| Feed page (20 rows, PostgREST shape with embeds) | 20.3 (plan 3.4) | 12.3 | | 23.1 |
| `feed_group_previews(20 ids, 12)` | 53.7 | **4.9** | 9.5 | 19.3 |
| `feed_watch_scores` | 37.0 | | | |
| `activity_comment_counts` / `activity_comments` | 13.2 / 23.8 | | | |
| **`my_notifications(100)`** (78 rows) | **223** | **112** | 12.9 (3 rows) | 46 (18 rows) |
| **`leaderboard('titles','all_time',50)`** | **197** | **116** | 88 | 66 |
| `leaderboard` titles/month · reviews all/month | 71 · 50 · 20 | | | |
| `my_leaderboard_standing` titles all_time / month | 23.6 / 18.9 | | 23.9 | 14.9 |
| `_leaderboard_counts` titles all_time / month / reviews (as owner) | | **18.6 / 14.1 / 5.3** | | |
| `social_candidates(40)` | 73.5 | 14.8 | 11.2 | 12.6 |
| `search_titles('star', 20)` | 148 (84 on rerun) | **1.6** | | 5.9–7.8 |
| `starter_movies(20)` / `top_rated_titles` | 53 / 53 | | | |
| Collection: rankings ⋈ media_items, 208 rows | 17.4 (**plan 20.8**) | 6.7 | 1.0 | 2.4 |
| `logged_collection` for one user (view, `can_i_view` per row) | 9.4 | 6.6 | | |
| Watchlist with embed (57 rows) | 13.4 | | | |
| `profile_title_counts` | 5.1 | | | |
| `rank_start` reads: `band_bounds_excluding`, `_rank_band_members`, `_rank_pivot_at` (owner) | 1.2 / 1.4 / 1.2 | 0.3 / 0.3 / 0.4 | | |
| **`rank_start` full** (writes): staging only, read-write then rolled back, user with 42 rankings | | | | **64 cold / 32 warm**, 3.7–5.7k buffer hits |
| `pg_timezone_names where name = 'America/New_York'` | **820** (Function Scan materialises all 610 zones) | 56 | | 148 / 72 (1,097 zones) |

Notes:

- **Cold-backend penalty.** Prod cold-backend penalties are larger and spikier than staging's. Interleaved
  reruns, three rounds:
  - `search_titles`: production 84 → 5.0 → 4.9 ms; staging 5.9 → 6.0 → 5.9 ms.
  - `feed_group_previews`: production 42.6 → 7.6 → 7.8 ms; staging 26 → 10 → 9.7 ms.

  Production is as fast or faster once warm. Its first touch after a pause is 5–15× slower, against about 2.5×
  on staging [server].
- **CPU is not the reason.** `sum(generate_series(1,200000))`, twelve runs each: production 44–52 ms, staging
  61–62 ms. Production's CPU is faster and stable [server].
- **`catalogue_candidates` and `collaborative_candidates`** returned 0 rows with the parameters I guessed
  (languages `{en}`, decades `{2000,2010}`), so their cost is not measured (evidence gap G-6).
- **Anomaly.** One `count(*) from media_cache` took 176 ms on production; the identical rerun took 1.9 ms, and
  staging's single run took 121 ms. It is an unexplained variance spike.

## 4. RLS cost (PR #206 revisited)

- **PR #206's numbers (09-23).** `feed_events_read` evaluates `can_i_view(actor_id)` on every matched row, at
  about 500 µs per call. It named two fixes, both post-freeze: resolve the actor set once per statement (2,306 →
  26 ms at 6,150 rows), or port the visibility functions to plpgsql (504 → 66 µs).
- **Neither fix has landed.** `can_i_view`, `can_view_profile`, `can_discover_profile`, `_can_read_comment` and
  `watch_tag_visible` are all still `LANGUAGE sql STABLE SECURITY DEFINER`. Because they are SECURITY DEFINER
  with `SET search_path`, they are never inlined [server].
- **Cost per row today** [server, warm, founder]:

  | Query | Rows | Time | Per row |
  |---|---|---|---|
  | `count(*) from rankings` | 1,938 | 435 ms (10 ms with no RLS) | ~0.22 ms |
  | `feed_events` | 2,363 | 353 ms | ~0.15 ms |
  | `watchlist` | 811 | 212 ms | ~0.26 ms |

  So PR #206's per-call figure is still roughly right, at 150–260 µs on this compute.
- **Is it material now?**
  - *No* for the Feed. The #342 index (`feed_events_feed_order`) has the page examine 89 rows to return 20
    (12 ms warm). About 5.5 ms of that is the `profiles` embed's own `can_i_view` (0.275 ms × 20).
  - *Mildly* for the collection: 208 rows give about 7 ms warm.
  - *It would become material* for a read that scans other users' rows without a selective index, such as an
    unfiltered `logged_collection` (1,000 rows, 284–346 ms).
- **`auth.uid()` wrapping.** 40 of 47 policies use bare `col = auth.uid()` and none wraps it in
  `(select auth.uid())`. They are all owner-equality conditions, where the planner uses `auth.uid()` (STABLE) as
  an index condition evaluated once per scan. Not material [static + server].
- **Volatile policy functions:** none. Every policy function is STABLE [server].
- **Policy shape.** Only SELECT policies exist (47). Four catalogue caches use `true`. Everything social routes
  through `can_i_view`.

## 5. Background work and contention

Cron jobs over the last 24 h; every run succeeded (0 failed) [server]:

| Job | Schedule | Prod p50 / p95 / max (ms) | Staging p50 / p95 / max | Slow minute (prod) |
|---|---|---|---|---|
| push-drain | every min | 3.2 / 10 / 35 | 3.4 / 7 / 15 | |
| import-drain | every 10 s | 2.8 / 13 / 505 | 3.9 / 4.3 / 12 | |
| import-maintenance (+ hourly prune) | every min | 14.6 / 46 / **2,521** | 13 / 23 / 163 | **:17 → 2,177 ms avg** (staging :17 → 109 ms) |
| release-refresh | :07 | **863** / 1,209 / 1,260 | 29 / 43 / 44 | :07 |
| release-evaluate (+ prune at :00) | */15 | 49 / **2,206** / 2,754 | 19 / 113 / 170 | **:00 → 2,037 ms avg** |
| welcome-dispatch | :41 | 21 / 26 / 32 | 5 / 9 / 10 | |
| ops-health | every 10 min | **241** / 421 / 499 | 32 / 39 / 67 | All ticks 310–499 ms when slow |
| proactive-tick | :04/:19/:34/:49 | 31 / 41 / 46 | (none) | |
| ops-alert | | (none) | 5.5 | |

- **The prune.** The SELECT side of the `:17` prune takes 49 ms on production and 78 ms on staging: the same
  205k vs 187k rows, both a parallel seq scan [server]. So the extra **2 s on production is in the DELETE and
  commit**, not the scan. The cause is unknown (G-2).
- **ops-health.** Its read half, `_ops_observe(now())`, takes 15–20 ms on both projects [server], and
  `ops_alerts` is empty on both. So the 200 ms extra production pays per tick is outside the observed SQL. The
  likely candidates are pg_cron's per-run connection, which is cold, plus commit.
- **Overlap with user traffic.** These ticks hold one backend for about 2 s twice an hour and about 0.9 s once
  an hour. With 205 to 1,440 runs a day they are visible but small. None ran at the time of the one observed
  user stall (03:57:29, F-BE-5): `postgres_logs` for 03:56–03:59 shows only routine cron lines and a timed
  checkpoint at 03:57:54.
- **Locks** (snapshot at 19:5x): 21 granted locks, 0 waiting. Queues: `push_outbox` 0, open import jobs 0,
  `net.http_request_queue` 0 [server, n=1].
- **PostgREST log noise.** "Warp server error: Thread killed by timeout manager" appears in bursts 30–60 s after
  user activity (about 100 a day). It is the HTTP keep-alive reaper and benign. There were two schema-cache
  reloads today (02:53 and 14:34). Each took **1.6–2.0 s** to query on production, and requests wait during a
  reload [edge-log].

## 6. Edge logs: what production users actually wait for (`edge_logs`, `response.origin_time`)

**Production compared with staging, 2026-11-24 00:00–20:00Z** [edge-log; n per path; origin_time is gateway to
response and includes PostgREST and DB]

| Path | Prod n · p50 · p95 (ms) | Staging n · p50 · p95 |
|---|---|---|
| GET media_items | 215 · 49 · 311 | 3,780 · 21 · 69 |
| GET rankings | 130 · **120 · 973** | 132 · 23 · 65 |
| GET user_media | 86 · 93 · 320 | 87 · 24 · 67 |
| GET watchlist | 54 · 80 · 421 | 74 · 23 · 60 |
| GET feed_events | 47 · 66 · 200 | 30 · 44 · 56 |
| rpc community_score | 24 · **80 · 410** (max 3,059) | 29 · 25 · 61 |
| rpc title_reviews_v2 | 22 · 64 · 275 | 26 · 23 · 32 |
| rpc title_review_count | 22 · 66 · 197 | 26 · 20 · 30 |
| rpc following_score | 12 · 36 · 161 | 20 · 21 · 30 |
| rpc feed_group_previews | 31 · 104 · 227 | 25 · 27 · 63 |
| rpc my_notifications | 39 · **236 · 969** | 46 · 78 · 250 |
| rpc rank_answer | 25 · 87 · 344 | 10 · 34 · 64 |
| rpc rank_start | 6 · 165 · 2,398 | (n/a) |
| rpc report_device_context | 9 · **1,228 · 1,398** | 13 · 144 · 417 |
| rpc leaderboard / my_leaderboard_standing | 6 · 612 · 982 / 6 · 453 · 820 | (n/a) |
| GET profiles | 9 · 524 · 671 | 13 · 60 · 130 |
| GET award_unlocks | 16 · 96 · 755 | 8 · 20 · 24 |

**Latency by idle gap before the request** (REST and RPC, `lagInFrame` over all project traffic) [edge-log]:

| Window | gap > 60 s | 30–60 s | 5–30 s | < 5 s |
|---|---|---|---|---|
| Prod 11-24 | n=20 · **p50 687** · p90 936 | n=1 · 448 | n=32 · 93 · p90 375 | n=1,429 · 56 · p90 209 · p99 1,553 |
| Prod 11-11 | n=46 · **756** · 1,012 | n=14 · 407 | n=229 · 152 | n=17,240 · 68 · p99 1,905 |
| Prod 11-01 | n=22 · **736** · 971 | | n=25 · 85 | n=1,062 · 38 · p99 878 |
| Staging 11-24 | n=12 · **228** · 297 | n=5 · 162 | n=52 · 54 | n=5,094 · 22 · p99 127 |

Excluding `report_device_context` does not change the production row: only 9 of its calls fall in the < 5 s
bucket, and none in the > 60 s one. The first-after-idle requests are ordinary cheap reads: `media_items` by id
at 572–710 ms, `profiles` at 524–690 ms, `provider_list_cache` at 507 ms, and `my_notifications` at 501–1,121 ms.

**Daily production trend, 10-21 → 11-24** (`BE/daily_prod.jsonl`; 10-22, 10-27 and 11-03 were lost to the rate
limit) [edge-log]:

- **Overall REST p50 is flat.** It ran 32–103 ms, with no step change in November. The p90 ran 123–450 ms and the
  p99 roughly 0.9–3.1 s; the higher-traffic days (11-05, 11-09, 11-11, 11-12) have the fatter p99.
- **community_score p50:** 27–109 ms (11-24: 80).
- **rankings p50:** 31–140 ms (11-24: 122).
- **media_items p50:** 28–149 ms.
- **my_notifications p50 drifted upward:** 62–122 ms through 10-26, then mostly 140–310 ms from 11-10 (11-13:
  309; 11-22: 264; 11-24: 236). It coincides with the proactive lateral (migrations 20261031000100 and later)
  and growing notification counts (F-BE-4).
- **There is no server-side "last-known-good" window.** Production's edge latency in late October and early
  November looks like today's, apart from `my_notifications`. If the founder's "it was fast before" is real, it
  is not explained by a server or DB regression.

## 7. Edge Functions (`function_edge_logs`, `function_logs`)

| Function, 11-24 00–20Z | Prod n · p50 · p95 · max (ms) | Staging n · p50 · p95 · max |
|---|---|---|
| tmdb-adapter (POST, 200) | 35 · **615 · 1,804** · 4,204 | 60 · 468 · 1,161 · 5,718 |
| push-sender | 21 · 699 · 1,067 · 1,106 | 31 · 268 · 762 · 1,016 |

[edge-log, `execution_time_ms`]

- **Cold boots.** 22 boots for 56 production invocations; boot time p50 30 ms, max 58 ms (staging max 102 ms).
  Boots are not the cost [edge-log].
- **Per-operation detail.** The op (detail, season-episodes, watch-providers, search) is in the request body,
  not the path, and `function_logs` holds only `booted` and `shutdown` lines. Per-op p50s and TMDB upstream
  latency **are not logged** (G-4). From the DB side, `tmdb_upsert_titles` called by the adapter takes 180 ms
  p50 and 794 p95 on production, against 78 / 253 on staging [edge-log]. That is a sizeable part of each
  adapter call, and it is exposed to the same production overhead.

---

## Findings

### F-BE-1: Production runs on Nano compute with a 10-connection PostgREST pool; staging runs Micro with 20
- **Affects:** every Production read: title page, Feed, startup. It also explains Preview vs Production
  behaviour.
- **Root cause:**
  - Production has no compute add-on (Nano class, 0.5 GB). The PostgREST pool is sized by compute: 10
    connections, against staging's 20.
  - Warm SQL is as fast or faster on production: aarch64, and the CPU bench is faster.
  - But end-to-end origin time on the same endpoints is 2–5× staging, with much fatter tails (p99 1,553 vs
    127 ms).
  - The cold-backend penalty is larger (§3 note). Reading 610 tiny zoneinfo files cold takes 820 ms against
    148 ms on staging, which suggests OS page-cache eviction under memory pressure. Memory and swap are not
    observable from SQL (G-1).
- **Evidence:**
  - [server] Billing add-ons; `pg_settings`; `pg_stat_io`; CPU bench.
  - [edge-log] Per-path p50/p95 (§6, n = 6–3,780 per path, 11-24 00–20Z); PostgREST pool lines.
  - [server] Cold/warm interleaved EXPLAINs.
- **Confidence:** Strongly supported for the difference. The mechanism (memory, pool, cold connections) is part
  hypothesis.
- **User impact:** H.
- **Remedy:** Move production to Micro, or Small for launch headroom. This is a config change with no code, and
  the PostgREST pool follows the compute. Re-run the §6 queries a day later.
- **Lower-risk alternative:** None purely in config without the upgrade. Raising the PostgREST `db_pool` on Nano
  adds backends to a 0.5 GB box and could worsen memory pressure.
- **Disruption risk:** L–M. A compute change restarts Postgres, a few minutes of unavailability, so it needs a
  window. It is reversible and adds roughly $10 a month for Micro.
- **Effort:** small (structural-native-db in kind, but a dashboard change).
- **Verification burden:** Low. Re-run the gap and per-path edge queries for 24 h, then compare.
- **Invariants:** none. Session restore must survive the restart, since the auth service restarts with it.
- **Class:** **A**.

### F-BE-2: Cold connections after idle cost about 0.7 s on Production (a standing property, not a regression)
- **Affects:** first screen after launch or resume, title page secondary data, "fills in late".
- **Root cause:**
  - PostgREST closes idle pool connections after 30 s (`db_pool_max_idletime`).
  - Production traffic is sparse (1.2k–1.9k REST requests on a typical day), so an app open usually finds no
    warm connection.
  - The first requests then pay connection setup plus per-backend catalog, function-plan and file-cache warm-up.
    On production that costs 20–150 ms per first call, against about 0–20 ms on staging.
  - A cold `media_cache` read plans in 14 ms; a cold collection query plans in 21 ms.
- **Evidence:**
  - [edge-log] First request after more than 60 s idle: p50 687 / 736 / 756 ms on 11-24, 11-01 and 11-11
    (n = 20, 22, 46), against 38–68 ms within bursts. Staging: 228 against 22.
  - [server] Cold vs warm EXPLAINs.
- **Confidence:** Confirmed for the effect. The split between connection setup and catalog warm-up is a
  hypothesis.
- **User impact:** H on Production. It is smaller on Preview, which is busier and on bigger compute.
- **Remedy:**
  - F-BE-1 first.
  - Then raise `db_pool_max_idletime` (Management API `PATCH /v1/projects/<ref>/postgrest`) to about 5–10 min, so
    a returning user finds warm connections.
- **Lower-risk alternative:** The idletime change alone. It reloads PostgREST only, and idle backends cost about
  5–10 MB each (×10).
- **Disruption risk:** L.
- **Effort:** small.
- **Verification burden:** Low. Use the §6 gap query.
- **Invariants:** none. The pool holds no per-user state; PostgREST sets role and claims per transaction.
- **Class:** **A**.

### F-BE-3: `report_device_context` takes 1.2 s because of `pg_timezone_names`
- **Affects:** launch. The call is fire-and-forget, but it holds one of the **10** production pool connections
  for about 1.2 s inside the launch burst.
- **Root cause:**
  - `select name from pg_timezone_names where name = …` is a Function Scan. It enumerates and loads every zone
    file (610 on production) before filtering.
  - On a cold backend, or with the page cache evicted, that takes 820 ms [server]; warm, 56 ms.
  - PostgREST's own schema-cache load runs the same enumeration (593 ms mean, 234 calls).
- **Evidence:**
  - [server] EXPLAIN: 820 → 56 ms on production, 148 → 72 ms on staging.
  - [edge-log] Production p50 1,228 ms, p95 1,398 ms (n=9) against staging 144 / 417 (n=13).
  - [server] pg_stat_statements: 505 calls, 1,200 ms mean.
- **Confidence:** Confirmed.
- **User impact:**
  - **Today: M.** It occupies one pool slot during the burst; cumulative max 5.4 s.
  - **At a launch-day spike: H.** [calc] 50 launches within 5 s × 1.2 s = 60 connection-seconds over 10
    connections, about 6 s of a saturated pool for every other request.
- **Remedy:** In the function, skip validation when `p_timezone` equals the stored zone. That is most launches.
  Otherwise validate cheaply: test `now() at time zone p_timezone` inside an exception block, or check against a
  names table filled once by migration.
- **Lower-risk alternative:** The "unchanged, skip" shortcut alone.
- **What could break:** `at time zone` also accepts abbreviations and POSIX strings that `pg_timezone_names`
  rejects, so keep the names check for new values. Release-evaluation reads `account_context.timezone`.
- **Disruption risk:** L.
- **Effort:** small (one migration).
- **Verification burden:** Low. A pgTAP test for accepted and rejected zones, plus an edge-log p50.
- **Invariants:** proactive and release scheduling by user zone.
- **Class:** **A**.

### F-BE-4: `my_notifications` runs the proactive social lateral on every notification row
- **Affects:** Notifications list and badge.
- **Root cause:**
  - `left join lateral (… from _proactive_ranked_social_actors(pc.id, auth.uid(), now()) s) cl on pc.type = 'watchlist_social'`.
  - The `ON` condition is applied after the lateral is computed, so the function runs **once per notification
    row, loops = 78**, even where `pc` is NULL. Each call costs 1.09 ms: 85 ms of the 106 ms body for the
    founder.
  - Present since 20261031000100 (still in 20261113000100).
- **Evidence:**
  - [server] EXPLAIN of the function body as owner with the founder's claims. Saved:
    `plans/prod_x_mynotif_body_founder.txt`.
  - [server] RPC timings: founder 112 warm / 223 cold; light 13; staging 46.
  - [edge-log] Production p50 236 / p95 969 today, against about 90–120 ms in late October (daily series).
- **Confidence:** Confirmed.
- **User impact:** M, scaling with the reader's notification count (capped at the 100-row limit, so at most
  about 110 ms extra per call).
- **Remedy:** Make the lateral gate itself, so the planner emits a one-time filter and never calls the function
  for other rows:
  `left join lateral (select … from _proactive_ranked_social_actors(pc.id, …) s where pc.type = 'watchlist_social') cl on true`.
  Alternatively, return early inside the function when `p_candidate is null`.
- **Lower-risk alternative:** The early return inside `_proactive_ranked_social_actors`. It changes no join
  semantics.
- **What could break:** The `watchlist_social` hide rule (`coalesce(cl.n,0) > 0`) and the cluster actors, so
  keep the existing pgTAP tests.
- **Disruption risk:** L.
- **Effort:** small (one migration).
- **Verification burden:** Low–moderate. Compare outputs for a sample of recipients.
- **Invariants:** notification visibility; `can_discover_profile` gating.
- **Class:** **A** if the badge read sits on the launch path, else **D**.

### F-BE-5: App-open bursts queue on a 10-connection pool
- **Affects:** title page and startup. Scores and counts arrive in a block after a stall.
- **Root cause:**
  - At 03:57:29Z on 11-24, 21 requests started within 10 ms of each other. They included
    `community_score`, `title_reviews_v2`, `title_review_count`, `my_notifications`, `feed_group_previews`,
    `rank_start`, and rankings, user_media and watchlist reads.
  - **All of them completed in 1.5–3.1 s**, although each executes in 0.04–15 ms warm.
  - A pool of 10 serves a burst of 20 or more in at least two waves, each wave on cold backends (F-BE-2). No DB
    event explains the floor: no schema reload and no cron prune at that minute.
- **Evidence:** [edge-log] `BE/edge_slow_1124.json` (44 requests over 900 ms today; 21 of them in that one
  burst). [server] Plan timings.
- **Confidence:** Strongly supported for queueing. Why the floor was 1.5 s rather than about 0.2–0.7 s is
  unexplained (G-3).
- **User impact:** H when it happens. It also inflates every RPC's max in pg_stat_statements (2–3.5 s).
- **Remedy:**
  - F-BE-1, which doubles the pool, together with F-BE-2.
  - On the client, the existing critical-first ordering (#378/#381) matters more on Production than on Preview.
    Coordinate with the client worker.
- **Lower-risk alternative:** F-BE-2 alone.
- **Disruption risk:** L.
- **Effort:** small.
- **Verification burden:** Moderate. It needs a founder session window matched against edge logs.
- **Invariants:** none.
- **Class:** **A** (bundled with F-BE-1 and F-BE-2).

### F-BE-6: `leaderboard` runs `taste_match` on every displayed row; the cost grows with users and libraries
- **Affects:** Leaderboard screen.
- **Root cause:**
  - `leaderboard` = `_leaderboard_counts` (18.6 ms) + rank + `left join lateral taste_match(user_id)` for every
    shown row (46 rows, about 100 ms).
  - `taste_match` against the largest library (782) alone costs 13.8 ms.
  - `_leaderboard_counts` (migration 001300) is cheap today. It evaluates `can_view_profile` and
    `can_discover_profile` per profile, and scans all non-watching `user_media` joined to `watch_events`.
- **Evidence:**
  - [server] Warm leaderboard 115 ms. `taste_match` over all 53 profiles: 100 ms. `_leaderboard_counts`:
    18.6 / 14.1 / 5.3 ms.
  - [edge-log] Production p50 612 ms (n=6). `my_leaderboard_standing` p50 453 ms (n=6), although its SQL takes
    24 ms, so most of it is F-BE-2.
- **Confidence:** Confirmed.
- **User impact:** L today (276 calls in total).
- **Scaling** [calc]:
  - Shown rows cap at 100: 100 × ~5 ms (median-library `taste_match`) is about 0.5 s.
  - `_leaderboard_counts` scales linearly with total `user_media` (2.2k rows → 18 ms) and profiles (×
    ~0.1–0.2 ms each).
  - At ~750k user_media (5k users × 150 titles) it reaches about 6 s, near the 8 s `statement_timeout`.
  - `my_leaderboard_standing` computes the same full count on every call.
- **Remedy:** Compute `taste_match` only for `viewable` rows, set-based over the page in one query.
  Materialise counts per user (for example a nightly or trigger-maintained table) before user_media passes
  about 100k.
- **Lower-risk alternative:** Skip `taste_match` for rows where `viewable` is false; they discard it anyway.
- **Disruption risk:** L (alternative) / M (materialisation).
- **Effort:** small / moderate.
- **Verification burden:** Moderate. Ranking ties and counts must be identical.
- **Invariants:** leaderboard visibility (`can_view_profile`, `can_discover_profile`); "a title counted once"
  (001300).
- **Class:** **D** now, **Preventive** for scale.

### F-BE-7: Hourly cron prunes take 2 s on production against 0.1 s on staging; cron history is 38% of the DB
- **Affects:** background work; it holds one backend at :00, :07 and :17.
- **Root cause:**
  - The prunes delete roughly an hour's worth of rows from a 205k-row, 51 MB `cron.job_run_details`.
  - The scan costs 49 ms; the DELETE and commit take the other ~2 s on production, against about 100 ms total
    on staging with the same data shape.
  - `bingd-push-drain` history (122.8k rows since 08-31) and 9,277 orphan rows are never pruned (hardening
    review).
  - ops-health takes 241 ms against 32 ms, with an identical 15–20 ms read part. release-refresh takes 863 ms
    against 29 ms.
- **Evidence:** [server] `job_run_details` percentiles by minute; EXPLAIN of the prune scan on both projects.
- **Confidence:** Confirmed for the timings. The cause of the production write slowness is unknown (G-2).
- **User impact:** L. Each prune holds about 1–2 of the backends for about 2 s twice an hour.
- **Remedy:** As in the hardening review: one retention prune for every `bingd-*` job and the orphans (for
  example 7 days), run in small batches by `runid`, off the :00 boundary.
- **Lower-risk alternative:** A one-off cleanup of the push-drain history and the orphans.
- **Disruption risk:** L.
- **Effort:** small.
- **Verification burden:** Low.
- **Invariants:** ops-health reads cron history (keep at least its lookback window).
- **Class:** **D**.

### F-BE-8: Feed and profile RLS cost per row (PR #206): still present, not material at this size
- **Affects:** Feed, collections of other users, profiles.
- **Root cause:** `can_i_view` costs about 150–260 µs a row (SQL, SECURITY DEFINER, not inlined). Neither PR #206
  fix landed.
- **Evidence:** [server] §4 counts. The Feed page takes 12 ms warm (89 rows examined, 20 returned).
- **Confidence:** Confirmed.
- **User impact:** L now. **Preventive:** a Feed whose followees post rarely relative to the global stream
  examines more rows per page.
- **Scaling** [calc]: about 0.2 ms × rows examined. At 10× history (Feed about 900 examined rows per page in the
  worst case), roughly 180 ms.
- **Remedy:** PR #206's per-statement actor-set policy (2.3 s → 26 ms measured then).
- **Lower-risk alternative:** The plpgsql port (504 → 66 µs).
- **Disruption risk:** M (RLS).
- **Effort:** moderate.
- **Verification burden:** High. The seven visibility edge cases, a second viewer, and anon.
- **Invariants:** auth and privacy RLS; Feed visibility; blocks.
- **Class:** **D / Preventive**.

### F-BE-9: Edge Functions: tmdb-adapter takes about 0.6 s p50 and 1.8 s p95 on production; no per-op visibility
- **Affects:** Where to Watch, season and episode fill, For You fills (`cacheSimilar`).
- **Root cause:**
  - The adapter's own time is upstream TMDB plus its DB upserts.
  - `tmdb_upsert_titles` is 180 ms p50 and 794 ms p95 on production against 78 / 253 on staging, so the
    production DB overhead (F-BE-1, F-BE-2) is inside each adapter call.
  - Cold boots are negligible (30 ms).
- **Evidence:** [edge-log] n=35 production, n=60 staging; 22 boots.
- **Confidence:** Strongly supported for the DB share. The TMDB share is unmeasured (G-4).
- **User impact:** M (secondary title data, For You placeholders).
- **Remedy:** Add a structured log line per op with upstream ms and DB ms. This is an observability change, not
  behaviour. F-BE-1 also helps.
- **Lower-risk alternative:** Time a sample of ops from outside, with curl against the function on staging.
- **Disruption risk:** L.
- **Effort:** small.
- **Verification burden:** Low.
- **Invariants:** none.
- **Class:** **F** (needs the measurement), with F-BE-1 as the actionable part.

### F-BE-10: Unknown authenticated caller: `media_cache select *` with an exact count over the whole table
- **Affects:** DB load only.
- **What it is:** 4,860 calls, 86 ms mean, 7.0 s max [server]. It is not in the current `src/` or
  `supabase/functions/` [static], and it had no calls during the 34-minute window. Possibly an old binary, a
  script, or a probe.
- **Confidence:** Hypothesis (origin).
- **User impact:** L.
- **Remedy:** Identify the caller from edge logs: `GET /rest/v1/media_cache` with `Prefer: count=exact` and no
  filter.
- **Class:** **F**.

### F-BE-11: Observability: pg_stat_statements is blended and lossy
- **What it is:** Statistics were never reset since 08-13 and 8 deallocations have occurred. With production's
  traffic, a 30-minute diff contains no user calls at all. The edge-log daily query (`BE/daily.sql`) is the
  better regression instrument: it has per-day p50/p90/p99 back to 10-21.
- **Class:** **D**. Save the daily query and the gap query as the day-2 check.

---

## Refuted hypotheses
- **"The database is too big or misses cache."** Refuted. It is 135 MB, with a 100% hit ratio and 2,690
  relation reads by client backends in four months [server].
- **"Title-page SQL is slow."** Refuted. Warm: community 4.5–10 ms, following 4.5–7, reviews 6–13, count 2, row
  reads under 0.4 ms [server]. The delay is outside SQL (F-BE-1, F-BE-2, F-BE-5).
- **"`rank_start` or comparison reads are slow on the server."** Refuted. Its reads take 0.3–1.4 ms on
  production [server], and the full `rank_start` takes 32 ms warm and 64 ms cold on staging [server, rolled
  back]. The first comparison's slowness on Production is F-BE-2 and F-BE-5: edge `rank_start` p50 165 ms, max
  3.1 s, inside the 03:57 burst.
- **"A server or DB regression since early or mid November."** Refuted at the edge. Daily REST p50 has been
  flat at 32–103 ms from 10-21 to 11-24, and the about-0.7 s after-idle penalty already existed on 11-01. The one
  drift is `my_notifications` (F-BE-4).
- **"`_leaderboard_counts` (001300) is expensive."** Refuted for now: 5–19 ms. It is preventive at scale
  (F-BE-6).
- **"Lock contention or blocking."** Refuted: 0 waiting locks, empty queues, 4 deadlocks lifetime [server, one
  snapshot].
- **"Production CPU is weaker."** Refuted. Production is faster and stable: 44–52 ms against 61 ms [server].
- **"Volatile or un-wrapped `auth.uid()` RLS is a material cost."** Refuted. Every policy function is STABLE,
  and bare `auth.uid()` appears only in indexable owner-equality policies [server].
- **"Edge Function cold starts."** Refuted as a material cost: 30 ms p50 boot [edge-log].
- **"The 999 GB of temp writes are user-facing."** Largely refuted. Statements tracked by pg_stat_statements
  that spill are monitoring and `pg_stat_statements` reads (about 7 MB each); app RPCs write no temp blocks
  [server]. The rate is about 2k files a day.
- **"Connections are near 60."** Refuted: 11 in use. The effective limit is the PostgREST pool of 10
  (F-BE-1, F-BE-5).

## Evidence gaps (smallest follow-up)
- **G-1: memory, swap, EBS burst balance and CPU credits on production.** Not readable from SQL
  (`pg_read_file` is denied). Follow-up: Dashboard → Reports → Database (memory, swap, disk IO, CPU) for
  production and staging over 24 h, or the privileged metrics endpoint.
- **G-2: why the production DELETE and commit is about 20× staging's** (prune, ops-health, release-refresh).
  Follow-up: the G-1 disk IO chart at :00 and :17, plus one staging-vs-production `pg_stat_wal` read taken
  before and after the :17 tick.
- **G-3: what set the 1.5 s floor in the 03:57:29 burst.** Follow-up: match a founder session's request
  timestamps to edge logs (`trace_id` / `request_id`) and to `pg_stat_activity` samples taken every second
  during a scripted app open on Production, read-only.
- **G-4: tmdb-adapter per-op latency and the TMDB upstream share.** Not logged. Follow-up: one log line per op
  (observability change), or timed curl calls against staging.
- **G-5: current pg_stat_statements means.** There was no user traffic in the 19:42–20:17Z window. Follow-up:
  snapshot before and after a founder session.
- **G-6: For You candidate RPCs** (`catalogue_candidates`, `collaborative_candidates`). They returned 0 rows
  with guessed parameters. Follow-up: rerun with a real anchor set from the app's request.
- **G-7: the caller of the unfiltered `media_cache` count** (F-BE-10).

## Scaling estimates [calc]
- **PostgREST pool (10).** With a burst of 20–40 requests per app open and about 50 ms per request warm, one
  pool handles roughly 200 requests per second warm. That is about 5–10 app opens per second before queueing,
  and far less when connections are cold (F-BE-2). Micro's pool of 20 doubles it. This is **the first limit at
  launch**, ahead of `max_connections` = 60.
- **`report_device_context`.** 1.2 s × launches per second ÷ 10 connections is the share of the pool it
  occupies. At 8 launches per second it fills the pool alone (F-BE-3).
- **`can_i_view` RLS.** About 0.2 ms × rows examined. The Feed is bounded by its index; own-collection reads are
  about 0.03 ms × library rows (2,000 rankings is about 70 ms).
- **`leaderboard`.** About 0.5 s at 100 shown rows with median libraries, plus counts linear in total
  `user_media`. It reaches the 8 s timeout at around 750k rows (F-BE-6).
- **`my_notifications`.** Up to about 110 ms extra at the 100-row cap until F-BE-4 is fixed, then bounded.
- **Feed grouping** (`feed_group_previews`). 5–10 ms warm for 20 ids. It grows with group size × 12-preview
  limit, not with history. Not a near-term limit.
- **Nano memory (0.5 GB).** With shared_buffers at 224 MB, PostgREST, auth and the pooler share the rest.
  Likely the first *hidden* limit; unverified (G-1).

## Staging vs Production: why Preview behaves differently
- **Compute:** Micro 1 GB on x86, against Nano 0.5 GB on ARM.
- **PostgREST pool:** 20 against 10.
- **WAL:** `max_wal_size` 4 GB against 1 GB.
- **`work_mem`:** 3.5 MB against 2.1 MB.
- **Traffic:** staging is about 3–4× busier at the edge (5.1k against 1.5k REST requests on 11-24, much of it
  automated or founder Preview), so its pool stays warmer.
- **Data:** about 5× less user data on staging (rankings 390 against 1,938; heaviest user 42 rankings against
  208 for the founder). That makes per-row RLS and `taste_match` cheaper on Preview.
- **Same everywhere:** cron schedule, `cron.job_run_details` size (187k against 205k), disk spec, Postgres
  17.6, 30 s PostgREST idle timeout.
- **Net effect:** Preview is a faster environment than Production for every request outside warm SQL. Founder
  checks on Preview after #378 will look better than Production will, and Production-only symptoms (late scores
  and counts) are expected until F-BE-1 and F-BE-2 are addressed.
