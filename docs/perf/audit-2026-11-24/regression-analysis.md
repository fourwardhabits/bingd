# Regression attribution

## Conclusion

**Confidence: high for what the server can see, low for device-side rendering.**

**No recent code change measurably slowed what the server sees of the founder's journeys.**

Comparison: the founder's own Production sessions (same Android device, same account, 12,091 requests), 11-12..11-19 against 11-20..11-23 [edge-log].

| Journey | 11-12..11-19 | 11-20..11-23 |
|---|---|---|
| Title page: scores reach the server (median, after the title burst starts) | 0.47 s (p90 0.85) | 0.46 s (p90 0.86) |
| `log_title` → `rank_start` (median) | 0.79 s | 0.84 s |
| Launch → last Feed read (median), faster thanks to the #342 index | 3.19 s | 2.38 s |

Server execution for title reads, scores, ranking, logging, `tmdb-adapter` and token refresh is flat over 11-01..11-24.

**What the founder is feeling is mostly long-standing cost, made visible more often:**
1. **Production's per-request overhead (standing, not new).**
   - Production runs on **Nano** compute with a 10-connection pool.
   - After 30 s idle PostgREST drops its connections, so the **first request after a pause costs about 0.7 s** (since at least 11-01).
   - Every endpoint is 2–5× slower at the edge than on staging, even though warm SQL is fast.
2. **Android's 5-requests-per-host queue (standing).** The title page's first wave is 15 requests, and every write sends 45–47 refetches. Secondary data queues behind them.
3. **More cold starts (the only measured change).**
   - The founder's app launched **9.25 times a day** on 11-20..23 against 5.1 before, peaking at 16 on 11-22, the day 6 OTAs shipped.
   - Each OTA forces a reload on the next return to the app, and with no persisted cache every launch starts empty.
   - So the slow first-open experience simply happened about twice as often.
4. **Preview runs on staging**, which adds its own differences. This was established in #378. Note that per request, staging is *faster* than Production (P1).

**Not ruled out:** device-side rendering and image cost. Server logs cannot see it. The image-heavy Feed (11-12 heroes, 11-17 rails) and the uncompiled, unvirtualized Feed (P8, P9) are plausible contributors to "For You placeholders" and sub-second hitches, but they are **unmeasured on a device**.

## Release timeline
The full 16-OTA table is in `evidence/regression-evidence.md` §2. In summary:
- **Native:** none in the window. Runtimes have been unchanged since 11-07, and `package-lock.json` is identical between `a3300bf0` and `32790c48`.
- **OTA cadence:** **16 Production OTAs on 11-20..11-24** (about 3.8 a day) against 9 on 11-07..11-19 (about 0.75 a day).
- **Request-graph changes:**
  - Additions: series title +2 (#364); Feed `feed_group_previews` (since 11-17) and comment reads (#365); post-log invalidation +1 prefix (#347).
  - Removals: the whole-cache count (#336); season `detail` per visit (#378).
- **Backend:** #342's index (faster); proactive (about 3 s/day of cron); ops-health (small); leaderboard counting (#376, slower RPC). Background busy time *fell* from about 750 to about 230 s/day.

## Controlled before/after [local-bench]
The same harness was run at `a3300bf0` (the last Production OTA before the 11-20 cluster) and at `32790c48`:

| Title type | Requests: before → after | Edge calls | Waves |
|---|---|---|---|
| Film | 18 → 17 | — | 3 → 2 |
| Series | 21 → 22 | — | — |
| Season | 20 → 18 | 3 → 2 | — |

Title-page volume did not grow. The first wave is now 15, so on Android the scores still leave in the second queue round. The post-#381 Production session shows the same thing: scores 0.27–0.51 s after the row [edge-log].

## Symptoms → mechanism
| Symptom | Mechanism | New? |
|---|---|---|
| Artwork before scores | Scores queue behind 9–15 requests (5 slots); cold connections (0.7 s) after idle | No; seen more often (P3) |
| Where to Watch late | `tmdb-adapter` 0.4–0.7 s p50 (1.8 s p95) plus the queue | No (flat all month) |
| For You placeholders | Cold cache; 4–5 dependent waves before posters; images queue behind Feed images on Android (P8); #381 made every poster a disk-cache miss **once** after OTA 8 | Mostly no; the w342 miss is new and one-off |
| First comparison sometimes slow | Before #378, `rank_start` queued behind 23–25 refetches (0.8 s median, 1.85 s max on Production). After #378, the same burst lands on the first answer (P4) | No; moved by #378, not removed |
| Seasons and episodes fill in late | Re-enrichment on every visit (fixed by #378); the episode fallback still waits for enrichment's invalidation chain (P19) | No |
| Occasional sub-second delays | Write fan-out bursts (P5); the 10-connection pool queueing app-open bursts (one burst of 21 requests took 1.5–3.1 s); cron spikes of 2–2.7 s every 15 min | No |
| "Slower recently" | About 1.8× more cold starts during the OTA burst; Preview on staging; unmeasured device rendering | Partly (cold-start frequency) |
| Not reported, but slower | `my_notifications` (+50–150 ms, P11); Leaderboard after #376 (P13) | **Yes** |

## Confirmed, suspected and refuted
- **Confirmed changes:**
  - more frequent cold starts;
  - `my_notifications` slower;
  - Leaderboard slower;
  - small request additions (Feed, series title);
  - the #381 one-off poster cache miss.
- **Suspected (device-side, unmeasured):** Feed image burst and render cost since 11-12/11-17 (P8, P9).
- **Refuted:**
  - new critical-path dependencies on title, ranking or seasons;
  - invalidation growth (+1 prefix);
  - new background load;
  - Sentry overhead (unchanged sampling; the serializer shipped after the complaints);
  - library growth;
  - token refresh as a regression;
  - any native change;
  - SQL regressions;
  - lock contention;
  - Edge Function cold starts;
  - images competing with API requests (separate clients).

## Older bottlenecks that remain
The Android 5-per-host queue (P7), write fan-out (P4, P5), the title page's first wave (P6), Nano compute and cold connections (P1, P2), `report_device_context` (P10), `tmdb-adapter` latency (P16) and the absence of a persisted cache (P3b).

## Evidence that is unavailable
| Gap | Smallest follow-up |
|---|---|
| Device JS, render and image timing, before and after | One Android session with Diagnostics on Preview at `a3300bf0` vs `32790c48`. That needs two Preview publishes, which this audit is not authorised to make. Alternatively, ship the P12 spans first |
| Whether a given relaunch was an OTA reload or manual | P12 cold-start span with a reason |
| Production memory, swap and CPU limits | Supabase dashboard Reports (founder) |
| Current per-call pg_stat means at real traffic | Re-snapshot across a busy hour |
| Only one Production session after #378/#381, and no ranking session | The next normal use, read from edge logs |
| How common grouped Feed posts are in Production | A bounded read-only aggregate (not run: the permission policy refused it) |

## Remedies that would restore responsiveness with minimal disruption
P1 + P2 (compute and idle timeout: config, no code), P3 (OTA cadence: process), then P4 and P6 (small client ordering changes) and P8 (image sizes). Details and risks are in `findings.md` and `decision-brief.md`. **None of these is implemented.**
