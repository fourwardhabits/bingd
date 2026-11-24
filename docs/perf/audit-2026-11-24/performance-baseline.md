# Performance baseline (Production `32790c48` unless noted)

Every number carries its label. **No number here is a device frame or CPU measurement**: none was available. `[edge-log]` times are server-arrival or origin times from Supabase logs. They exclude device JS, render, image decode and on-device queue time, except where arrival gaps reveal the queue.

## Network and server facts that shape every journey
| Fact | Value | Label |
|---|---|---|
| Production compute | Nano (no add-on), 0.5 GB, aarch64. PostgREST pool 10; idle drop 30 s | [server] |
| Staging compute | Micro, 1 GB, 2 shared CPU. Pool 20 | [server] |
| First request after >60 s idle (Production) | p50 687–756 ms (11-01, 11-11, 11-24; n=20–46). In-burst: 38–68 ms | [edge-log] |
| Same, staging | p50 228 ms. In-burst: 22 ms | [edge-log] |
| Overall REST p50 (Production, daily, 10-21..11-24) | 32–103 ms, flat; p99 0.9–3.1 s | [edge-log] |
| Android concurrency | API: 5 per host, first in first out (one host). Images: separate Glide client, also 5 per host | [static] |
| Device round trip (Android, founder) | about 165 ms (prior estimate); Production arrival windows show slot recycling under 100 ms | [edge-log] |
| Warm SQL, title-page reads | 0.04–13 ms each | [server] |

## Journeys

| # | Journey | Measured | Labels | Cold vs warm | Notes |
|---|---|---|---|---|---|
| 1 | Cold start → Feed loaded | Launch → last Feed read, median **2.38 s** (IQR 1.59–3.64, n=28), 11-20..23; 3.19 s before #342 | [edge-log] | Every OTA forces one cold start; no persisted cache | Path: profile → follows → `feed_events` → hydrate → counts, 4 round trips after the profile [static]. `report_device_context` holds a slot for 1.2 s |
| 2 | Initial Feed | `feed_events` p50 66 ms (Production), 40–90 ms since #342 | [edge-log] | — | Unvirtualized; every card's images load at mount (P8, P9) |
| 3 | Tab switch (mounted) | No network if fresh (60 s staleTime) | [static] | Hidden tabs still re-render on invalidation | Device time unmeasured |
| 4 | Title page | Scores reach the server **0.46 s** median (p90 0.86) after the burst starts; post-#381 0.27–0.51 s after the row (n=2) | [edge-log] | Warm revisit in under 60 s: no network; 60 s–5 min: background refresh of about 17 requests | First wave 15 requests [local-bench]; Where to Watch edge call 0.4–0.7 s p50 / 1.8 s p95 |
| 5 | Log → first comparison | `log_title` → `rank_start` median **0.84 s** (max 1.35, n=20), before #378 | [edge-log] | — | After #378, `rank_start` leaves first, but the 47-request refresh lands on the first `rank_answer`: [sim] 1,195 ms if tapped at once, 345 ms at +1 s |
| 6 | Each comparison / finalize | `rank_answer` p50 87 ms, p95 344 (Production) | [edge-log] | — | Finalize sends 45 refetches [local-bench]. A title opened 400 ms later gets its row at [sim] 963 ms vs 170 |
| 7 | For You first posters | Slate server-visible about 0.57 s (prior); posters not measured | [edge-log] / gap | 4–5 dependent waves before the first poster request on a cold cache [local-bench]; images disk-cached across reloads | w342 since OTA 8 (53% fewer pixels per tile [calc]) |
| 8 | Collection open/sort/filter | Sort and filter are client-side; no network | [local-bench] | — | Open reads the full ranked set |
| 9 | Drag-to-rerank | RPC per move, plus a 45-request fan-out per move fired before the queued next move | [static][local-bench] | — | Next move or Undo waits 0.35–1.2 s [sim] |
| 10 | Search | Not separately timed | — | — | Not implicated |
| 11–12 | Seasons and episodes | Season opens 18 requests, 2 edge calls (was 20 and 3) | [local-bench] | Revisit: episodes immediate (Preview, founder report) | Fallback can wait on the enrichment chain (P19) |
| 13 | Watchlist / Watch History | Watchlist toggle: 22 requests (29 from the title page) | [local-bench] | — | — |
| 16 | Notifications | `my_notifications` p50 **236 ms**, p95 969 (Production); 85 ms of it is the per-row lateral | [edge-log][server] | — | Drifted from about 100 ms in late October |
| 19 | Leaderboard | p50 612 ms (n=6) | [edge-log] | — | 85% `taste_match` |
| — | `tmdb-adapter` (all ops) | p50 615 ms, p95 1,804 ms | [edge-log] | Cold boot 30 ms (not the cost) | Per-op timing not logged |

## Platform differences
- **Android:** the 5-per-host queue dominates its bursts (Production arrivals pack in groups of 5–10 per 100 ms) [edge-log].
- **iOS:** per-request means run higher in the Production logs (e.g. `media_items` 104–114 ms against Android 60–67) [edge-log]. Per-host concurrency was not measured (gap); iOS allows 6 concurrent image downloads [static].

## Measurement limitations
- No device render, JS or frame data.
- No image byte or timing data (image.tmdb.org is blocked from the audit host).
- No Sentry API access.
- Production traffic is low (79–20k requests a day), so pg_stat windows are thin.
- Edge-log queries are capped at about 1000 rows, which truncated five busy hours.
- Simulations assume a 165 ms round trip and the 5-slot model.

## Proposed performance budgets (Production, good Wi-Fi, warm server)
These are proposals to calibrate against the P12 spans once they exist. They are not approved requirements.

| Journey | Budget | Rationale |
|---|---|---|
| Mounted tab switch | ≤ 200 ms to content | Cached data and no network; anything above is render cost |
| Cached primary screen | ≤ 300 ms | As above |
| Title page useful content (row, personal state, both scores) | ≤ 1.0 s cold, ≤ 0.5 s warm server | 3 queue rounds at 165 ms, plus one possibly cold connection (0.7 s today, which breaks the budget until P1/P2) |
| First comparison usable after Rank | ≤ 0.5 s | `rank_start` 60–180 ms plus one round trip |
| Each further comparison | ≤ 300 ms | `rank_answer` p50 87 ms plus one round trip |
| First visible For You posters | ≤ 1.0 s on a warm cache, ≤ 1.5 s cold | 4–5 waves cold |
| Cold start → Feed first page | ≤ 2.0 s | Today 2.38 s median |

**Platform note:** Android budgets should be measured *including* queue time. iOS and Android should be reported separately, along with cold-connection status: the first request after idle, until P2 is resolved.
