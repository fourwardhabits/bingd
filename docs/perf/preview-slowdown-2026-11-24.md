# Preview slowdown, 2026-11-24

**What made the Android Preview feel slow on 2026-11-23, measured rather than assumed, and the
three fixes in this PR.** The founder's report: slower startup, title pages populating in waves
(artwork first, scores and watched state later), slow TV seasons and episode lists, slow For You
posters, the ranking sheet pausing at *Working out what to ask…*, and similar delays elsewhere.

**Short answer.** No PR in the window added a request or a serial dependency on a critical path,
and the staging backend is not slower than production in any way that matters here. The
journeys that felt slow were **request-ordering problems that Android amplifies**: React
Native's Android networking sends at most **five requests per host at a time** (OkHttp's default
`maxRequestsPerHost`, which React Native does not change), first in, first out. Any burst of
requests therefore queues, and whatever is asked for *last* waits for the whole burst. Three
places put the request the reader is waiting for at the back of such a queue, or behind work it
did not need. They are fixed here, JavaScript-only, native fingerprint unchanged.

---

## How it was measured

- **The founder's own session, from the server side.** The staging edge logs (Management API
  `analytics/endpoints/logs`) hold every request the Android Preview (`okhttp`) and the iOS
  Preview (`CFNetwork`) made between 02:08 and 02:42 UTC on 2026-11-24 — 637 Android requests.
  Only method, status, path and timestamp were read; query strings and ids were stripped before
  anything was looked at. Edge-log timestamps are when the request reached Supabase, so the gap
  between two requests is the client's time between sending them.
- **Server execution time, staging vs production, same user shape.** `EXPLAIN (ANALYZE)` of each
  journey RPC as the most active account on each project, inside
  `begin transaction read only … rollback`, three runs each. No ids are printed anywhere.
  `rank_start` writes, so it was timed on **staging only**, in a rolled-back read-write
  transaction.
- **`pg_stat_statements`** on both projects (staging recording since 2026-08-31, production
  since 2026-08-13), aggregated by RPC or table name.
- **Round trips.** Warm-connection PostgREST timings to both projects with the public anon key,
  from this container (us-east, through a proxy).
- **Replays.** A Node script that sends real requests to staging PostgREST (anon, public
  `media_items` reads) through a FIFO dispatcher with OkHttp's cap of five, to reproduce each
  queueing pattern before and after the fix on the same backend and the same queries.
- **Static request graphs** of the hooks behind each journey, and `git diff 646a4021..1807514a`
  over the data layer.

Not measurable from here: on-device JavaScript time, image transfer (image.tmdb.org is not
reachable from this container), and anything before the app's first request on launch. The
device steps at the end cover those.

---

## Environment

| | Staging | Production |
|---|---|---|
| Compute | **Micro** (`ci_micro`, 2 shared CPUs, 1 GB) — billing add-ons | **No compute add-on** (Nano-class: `shared_buffers` 224 MB, `effective_cache_size` 384 MB, vs staging's 256 MB / 768 MB). So production is *smaller* than staging. |
| CPU | x86_64 | aarch64 |
| Postgres | 17.6 | 17.6 |
| Warm PostgREST round trip from here | median 74 ms (p90 106) | median 97 ms (p90 111) |
| pg_cron load (24 h) | light: largest average job 40 ms | heavier: `release-evaluate` avg 565 ms, max 2.6 s |

Per query, staging executes the Feed RPCs about **1.3–2× slower than production** despite having
a fifth of the data (for example `feed_events` page 13.0 ms vs 6.7 ms, `my_notifications` 49 ms
vs 25 ms), consistent with the older x86 Micro host. In absolute terms that is **5–25 ms per
hop**, against a device round trip of roughly 170 ms. It is real and it is not what the founder
felt.

### Server execution, staging vs production (ms, three runs)

| RPC | Staging | Production |
|---|---|---|
| `community_score` | 12.5 12.4 12.5 | 10.5 10.5 10.5 |
| `following_score` | 7.6 7.6 7.8 | 7.6 7.9 7.7 |
| `title_reviews_v2` | 12.8 12.6 12.8 | 11.6 9.5 9.5 |
| `title_review_count` | 5.4 5.4 5.4 | 4.1 4.6 4.3 |
| `title_recommendations_for_me` | 4.4 4.4 4.4 | 3.3 3.7 3.3 |
| `feed_events` page (20, as PostgREST filters it) | 13.1 13.0 13.0 | 6.7 7.1 6.6 |
| `public_scores` | 22.7 22.6 22.5 | 20.0 20.1 19.1 |
| `public_notes` | 19.6 19.3 19.5 | 13.5 15.3 17.0 |
| `feed_watch_scores` | 20.8 19.8 19.9 | 12.4 10.6 10.5 |
| `activity_comment_counts` | 18.4 18.5 18.2 | 9.7 10.6 9.6 |
| `feed_group_previews` | 24.9 26.1 24.7 | 19.3 18.9 21.5 |
| `follow_activity_people` | 16.9 16.8 16.9 | 8.3 8.1 7.7 |
| `my_notifications(100)` | 49.0 49.1 48.8 | 27.4 25.5 25.0 |
| `recommendations_to_me_page` | 12.2 12.2 15.8 | 6.1 5.9 5.8 |
| `social_candidates` | 15.6 15.6 15.7 | 18.4 17.7 21.4 |
| `leaderboard` (#376) | 32.1 34.0 33.6 | 113.0 111.2 118.9 |
| `my_leaderboard_standing` (#376) | 19.0 18.7 18.6 | 18.9 20.1 16.9 |
| `ranking_backlog` | 12.2 12.0 12.0 | 28.4 21.7 20.3 |
| `refine_candidates` | 6.7 6.7 5.8 | 1.7 1.8 1.7 |
| `rank_start` (movie / season / series) | 72–79 / 57–61 / 57–58 | not run (writes) |
| `pg_timezone_names` lookup inside `report_device_context` | 72 72 73 | 817 61 56 |

Some of these include the small subquery that picks the event ids; it is the same on both sides.

---

## Evidence table

Device times are from the founder's Android session in the staging edge logs. "Gap" is the time
between two requests reaching the server, which is client time: waiting in the queue, the round
trip of whatever came before, and JavaScript.

| Journey | Observed / estimated time | Primary bottleneck | Evidence | Class | Proposed fix |
|---|---|---|---|---|---|
| **5. Rank to first comparison** | **1.68 s and 2.67 s** from `log_title` to `rank_start` reaching the server; `rank_start` itself executes in 57–79 ms | The Log sheet's post-log refresh (45 and ~60 refetches across every mounted tab) was asked for *before* the ranking sheet sent `rank_start`. With five requests per host, `rank_start` went out last | Device log: `log_title` 02:09:06.97 → 40-odd reads → `rank_start` 02:09:09.64; again 02:10:00.05 → 45 reads → 02:10:01.73. The 45 reads went out at ≈30/s, which is five slots × one ≈165 ms round trip. Replay: 670 ms → 67 ms | Existing debt, Android-amplified. **Confirmed** | **Fixed** (commit 1): the refresh is held until the first answer |
| **3. TV season → episodes** | Every season visit called `tmdb-adapter` `detail`: 448–470 ms at the edge (eight serial hops: auth, two catalogue reads, a charge, TMDB, three writes), the episode rail waiting behind it, then six refetches of the page | `isThin` asked a season for a runtime, which a season row never has, so every season was thin, on every visit | 1,833 of 1,833 staging seasons and 2,359 of 2,359 production seasons have `runtime_minutes` null; the adapter's `fromSeasonDetail` writes none. Device log: `detail` on a repeat visit at 02:10:31.94–32.41 followed by six refetches (credits, trailers, title row, personal ×3) | Existing debt. **Confirmed** | **Fixed** (commit 2) |
| **2. Feed → title page (first visit)** | Second wave of reads reached the server **0.17 s, 1.7 s, 2.1 s and 3.1 s** after the first on four visits | Scores, reviews, review count, watch count, credits and trailers keyed on the *title row's* id, so they left only after the row came back — and then queued behind the edge calls the row had started | `useCredits(titleId)` etc. with `titleId = data?.title?.id`. Device log 02:09:32.95 (row) → 02:09:36.09 / 37.87 / 38.67 (reviews, count, scores), with `tmdb-adapter` calls interleaved | Existing debt. **Confirmed** | **Fixed** (commit 3): they key on the route id and leave with the row |
| 2. Title page, repeat visit | Instant from cache inside 60 s; stale-while-revalidate to 5 min; full reload after 5 min idle | `staleTime` 60 s default, `gcTime` 5 min default, no persisted cache | `src/lib/query.ts`; no persister anywhere | Existing debt | P2: a persisted query cache (larger change, not in this PR) |
| 1. Cold launch → Feed | Server-visible part **0.9 s** (Android) / **1.9 s** (iOS) from the token refresh to the last Feed read; 0.8 s without a refresh | After an idle hour, `auth/v1/token` first, then **0.5 s (Android) / 0.9 s (iOS) before the profile read** — the refreshed session being written to SecureStore in chunks before `getSession` resolves; then follows → `feed_events` → hydrate, three serial waves | Device log 02:08:16.55 token → 17.05 profiles → 17.92 last Feed read; iOS 02:11:16.42 → 17.30 → 18.35 | Existing debt | P2: answer `getSession` from the in-memory mirror before the SecureStore write settles (auth-sensitive; separate change) |
| 1. Launch, expo-updates | Not blocking | `fallbackToCacheTimeout: 0`; the launch check is background | `app.config.ts` `updates` | Hypothesis **refuted** | — |
| 1. Launch, repeated | Android launched twice 10 s apart (02:08:16, 02:08:26); iOS three times in 11 s (02:11:16, :22, :27), each a full startup and an empty cache | Consistent with the foreground reload in `src/lib/updates.ts` applying a newly published Preview update — there were three Preview publishes on 2026-11-23 — or with manual relaunches. The logs cannot tell which | Edge logs | **Staging-only / environment**, unverified | Founder step 1 below tells them apart |
| Build type | Release | `preview` profile has no `developmentClient`; Android `buildType: apk` is a release build | `eas.json` | Hypothesis **refuted** | — |
| All journeys, backend | 5–25 ms more per hop on staging than production | x86 Micro vs aarch64 production | Table above | **Staging-only** | Founder decision, below — not needed for these symptoms |
| 4. For You slate | **0.57 s** server-visible, first request to `note_recommendations_shown` | Not the bottleneck | Device log 02:09:02.57 → 03.14 | — | — |
| 4. For You posters | Unmeasured transfer | 20 tiles a page at TMDB `w500` for tiles about 116 pt wide (≈305–350 px at the founder's density); `w342` is 53% fewer pixels | `posterUri(item.posterPath, 'card')` in `app/(tabs)/recommendations.tsx` (since 2026-11-06) | Unverified hypothesis | P2: `w342` for the wall, once device timing (step 4) shows it matters |
| 6. Notifications → focused thread | `my_notifications` 49 ms staging / 25 ms production; `activity_comments` ~57 ms on both | `useActivityEvent` reads presentation → event → hydrate in series; #374 added nothing on the path (the inbox row already carries the comment id) | Device log (iOS) `my_notifications` → `activity_comments` | Existing debt, minor | — |
| Feed rendering (#368/#370/#373) | — | Font metrics are constants (`FeedHeadline.tsx`), no TTF parsing; `EngagementRow` re-renders once after `onLayout` | Source | Hypothesis **refuted** | — |
| `report_device_context` on every launch | 222 ms mean on staging, 1,201 ms on production (`pg_stat_statements`) | `pg_timezone_names` reads the zone database from disk: 72 ms warm, 817 ms cold | Table above | Existing debt, off the critical path (fire and forget) | P2: validate the zone without scanning the view |

Nothing in `git diff 646a4021..1807514a` changes the data layer of the title page, For You,
seasons, ranking, auth or `src/lib`. The only new reads are #374's notification-to-comment
lookups, which are not on a critical path.

---

## Priorities

**P1 (fixed here)**

1. *Working out what to ask…* — `rank_start` queued behind the post-log refresh.
2. Season pages re-enriched on every visit, with the episode list behind it.
3. Title pages filling in two waves because the title-scoped reads waited for the row.

**P2 (recommended, not in this PR)**

4. A wider per-host request limit on Android (native, needs a build — founder decision below).
5. A persisted query cache, so a cold launch draws the last Feed and title pages at once.
6. Token-refresh startup: resolve the session from memory before the SecureStore write settles.
7. For You wall at `w342` if the device timing shows the posters are transfer-bound.
8. `report_device_context` without the `pg_timezone_names` scan.
9. Invalidation storms in general: a collection change refetches every mounted tab's queries at
   once. Each is correct; on Android, together, they delay whatever comes next.

**Staging-only**

- Staging's per-query CPU is 1.3–2× production's (x86 Micro). Worth 5–25 ms a hop.
- Frequent Preview publishes: each first foreground return after a publish reloads the app.

---

## The fixes

### 1. `rank_start` before the refresh

`src/features/ranking/open-first.ts` holds a task until the next ranking session's first answer.
The Log sheet hands it its post-log `invalidateAfterCollectionChange` when it is about to open
the comparisons (`holdUntilRankingOpens`); the ranking sheet releases it when `rank_start`
settles, or when it unmounts. A 4 s ceiling releases it if nothing else does — longer than the
slowest first answer measured (2.67 s). The task always runs, exactly once, and the refresh is
the same refresh. Nothing it refreshes is on screen during the comparison: the sheet covers the
page, and the pivot card is seeded from the band already cached. A Log sheet with no `onRank`
refreshes at once, as before. Invalidation keys and authorisation are unchanged.

| Replay, staging, cap of five, 45-request burst (9 runs) | Median | Min | Max |
|---|---|---|---|
| Before: `rank_start` after the burst | **670 ms** | 635 | 875 |
| After: `rank_start` first | **67 ms** | 61 | 375 |
| For reference: no cap (iOS-like) | 101 ms | 88 | 426 |

The replay's round trip is about 65 ms; the device's is about 165 ms, and the same arithmetic
gives the observed 1.7–2.7 s before and about 0.2 s after.

### 2. Seasons are not thin for want of a runtime

`isThin` now asks a film, not a season, for a runtime. A season missing its artwork or overview
is still enriched, and a season never asked about trailers and credits is still enriched once
(the existing videos-facet reason). For a filled-in season, a visit is now:

| Per visit to a filled-in season | Before | After |
|---|---|---|
| `tmdb-adapter` `detail` (TMDB read + charge + three writes) | 1 (448–470 ms at the edge) | 0 |
| Refetches triggered by the enrichment | 6 | 0 |
| Episode list | waits for `detail` | its own read at once (`season-episodes`, cached for an hour) |

Counts are from the device log and the hook's tests (`use-enrichment.test.ts`).

### 3. Title-scoped reads leave with the row

Credits, trailers, the watch count, reviews (both sorts), the review count and both scores now
key on the route id. The row is read by that same id, so every query key — and every
invalidation that names one — is unchanged; only the moment the request leaves moves. Reads
that need the row's content (season list, episodes, Similar, enrichment) still wait for it.

| Replay, staging, time until both scores are back (9 runs, median) | Before | After |
|---|---|---|
| No cap (iOS-like) | 142 ms | **75 ms** |
| Cap of five, with the three edge calls the row starts | 249 ms | **191 ms** |
| Cap of five, no edge calls | 189 ms | 189 ms |

On the device the saving is the measured gap between the waves: 0.17 s on a quiet link, up to
3.1 s on a busy one, because the scores no longer queue behind the edge calls.

**Native fingerprint:** unchanged. All three are JavaScript; the preview-lane fingerprint
computed here is identical before and after for both platforms, so the Preview binary (Android
`f4062003…`, iOS `bf0ce597…`) takes this as an update.

---

## Founder decisions

1. **A wider request limit on Android (P2, needs a build).** A config plugin that installs an
   `OkHttpClientFactory` raising `dispatcher.maxRequestsPerHost` from 5 (to, say, 16) would
   remove the queueing these fixes work around, everywhere at once. It is native, so it moves
   the fingerprint and every tester needs a new binary.
2. **Staging compute.** Upgrading staging from Micro to Small would bring per-query times
   toward production's. Not needed for these symptoms.
3. **Preview update cadence.** Each publish reloads the app on the next safe foreground return,
   which looks like a slow launch and empties every cache. Publishing fewer, batched Preview
   updates during a QA session avoids it. Changing the foreground-reload policy itself is
   JavaScript, but the copy in the embedded bundle decides a fresh install's first reload, so a
   change only fully lands with a new build.

---

## Device timing, for the founder

Settings → **Diagnostics** (under the build details at the bottom) opens a sheet that records the last
30 network operations with their start and end times (`rpc:<name>`, `rest:<table>`; an edge
function shows as `other`), plus app mounts and the release line (update id, embedded or
update). It records names only, never ids or content. Open it straight after each step, before
doing anything else, because the ring keeps only 30 entries.

1. **Reloads.** When a launch feels slow, open Diagnostics at once. If the update id differs
   from the one before, or an app mount appears that you did not cause by swiping the app away,
   it was an over-the-air reload rather than a slow cold start.
2. **Rank to first comparison.** Open a film you have not logged, tap *I liked it*, and time from
   the tap to the two posters. Before this update: about 2 s on Android. After: well under
   0.5 s. In Diagnostics, `rpc:rank_start` should now start right after `rpc:log_title` ends,
   with the `rest:` refreshes after it rather than between them.
3. **A season page.** Open a season, go back, open it again. The second visit should draw the
   episode rail at once, and Diagnostics should show no `other` (edge function) call for it.
4. **A title page.** Open a film from the Feed. `rpc:community_score` and `rpc:title_reviews_v2`
   should start within a few milliseconds of `rest:media_items`, not after it ends.
5. **For You posters.** Cold start, open For You and time until every visible poster is drawn —
   on Wi-Fi, then on mobile data. If mobile data is much slower, the `w342` change (P2.7) is
   worth making.
