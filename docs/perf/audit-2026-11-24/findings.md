# Findings register

**This is an audit register, not an implementation queue.** Nothing here is approved. Each row needs a founder decision (see `decision-brief.md`).

**Where the evidence comes from.** Four independent investigations, filed under `evidence/`:

| Prefix | Investigation | File |
|---|---|---|
| REG | Regression attribution | `evidence/regression-evidence.md` |
| CLI | Client networking, cache, data propagation | `evidence/client-evidence.md` |
| BE | Backend, database, Edge Functions | `evidence/backend-evidence.md` |
| RND | Rendering, images, startup/OTA, observability | `evidence/render-evidence.md` |

Codex's independent pass is in `codex-review.md`. Source finding IDs (F-REG-n, F-CLI-n, F-BE-n, F-RND-n) are kept in the evidence column so every claim can be traced back.

## Evidence labels
- **[device]:** physical device, from existing logs or reports.
- **[edge-log]:** Supabase API or edge logs. On Production these include the founder's own sessions, aggregated.
- **[server]:** pg_stat or EXPLAIN, read-only and rolled back.
- **[local-bench]:** jest harness.
- **[sim]:** queue simulation, 5 slots and 165 ms round trip.
- **[calc]:** calculated.
- **[static]:** code reading.

## Rating scales
- **Confidence:** Confirmed (C), Strongly supported (S), Hypothesis (H), Preventive (P).
- **Impact, disruption risk:** H, M, L.
- **Effort:**
  - S: small patch.
  - M: moderate.
  - X: structural, native or database.
  - Ext: external or provider change.
- **Verification:**
  - Auto: automated tests are enough.
  - Dev1: focused device QA.
  - Dev2: multi-platform device QA.
  - Ext: extensive regression.
- **Class:**
  - A: high impact, low disruption.
  - B: high impact, moderate disruption.
  - C: high impact, high disruption.
  - D: low impact, low disruption.
  - E: low impact, high disruption.
  - F: insufficient evidence.

## Register

| ID | Journey / system | Root cause | Evidence | Conf. | Impact | Proposed remedy | Lower-risk alternative | Risk | Effort | Verify | Invariants touched | Class | Decision |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **P1** | Every Production read (title, Feed, startup) | Production runs on **Nano** compute (no add-on). PostgREST pool is **10** connections (staging Micro: 20). Warm SQL is fast (0.04–13 ms), but edge time on Production is 2–5× staging, with fat tails (p99 1,553 vs 127 ms) | F-BE-1, F-BE-5 [server][edge-log] | S (difference C; mechanism partly H) | **H** | Move Production to Micro, or Small for launch headroom (dashboard; Postgres restarts) | None in config alone. Raising the pool on Nano could worsen memory pressure | L–M (a short restart; needs a window) | Ext | Auto (re-run the edge-log queries) | Session restore survives the restart | **A** | Founder |
| **P2** | First screen after launch or resume; "scores fill in late" | PostgREST drops idle connections after 30 s. With sparse traffic, the first request after more than 60 s idle costs **687–756 ms p50** (staging 228). This has held since at least 11-01 | F-BE-2 [edge-log] (n=20/22/46) | C (effect) | **H** | After P1, raise `db_pool_max_idletime` to about 5–10 min (PostgREST config) | The idletime change alone | L | Ext | Auto (gap query) | None (the pool holds no per-user state) | **A** | Founder |
| **P3** | Every cold start; "slower recently" | Each OTA forces a reload on the next foreground return (`src/lib/updates.ts`). There is no persisted query cache, so every launch is empty. 16 OTAs went out on 11-20..24; the founder's launches rose from 5.1 to **9.25 a day** (16 on 11-22) | F-REG-1, F-RND-3, F-CLI-11 [edge-log][static] | S | M | **Process:** batch Production OTAs to at most one a day outside emergencies | The process change alone, which changes no code | L | S | none | None | **A** | Founder |
| P3b | Cold starts | The same root cause: no persisted cache | F-CLI-11 [static] | S | M–H | A per-account persisted cache, on an allowlist, restored as stale (guarantees in `functionality-preservation.md` §3) | `placeholderData` from list caches (title header) | **M** (privacy, account isolation) | M | Dev2 | Auth/privacy; no cross-account leakage | **B** | Founder |
| **P4** | Log → first comparison; ranking | The post-log refresh held by #378 (24 queries / **47 requests**) is released at `rank_start`, so it occupies the Android slots when the first `rank_answer` is sent. Finalize then sends a second, near-identical **45**: **about 92 requests per ranking**. **Added after Codex pass 2:** when the first opponent card is not in the cached band, `Comparison` fetches `media_items` (`RankingSheet.tsx:1347–1367`, `pivot-card.ts:75–100`) *after* the hold is released, so the refresh can delay the first comparison becoming usable, not only the first answer | F-CLI-1 [local-bench][sim: first answer 1,195 ms if tapped at once vs 218 uncapped] | S (mechanism C; tap timing on device unmeasured) | M | Skip the held refresh when the session places (finalize covers it); keep it for cancel and failure | Release the hold on `placed` or unmount instead of `rank_start` | L | S | Auto + Dev1 | No stale state after writes (cancel and fail paths must still refresh); I1–I7 untouched (read-only) | **A** | — |
| **P5** | After every write (finalize, drag/Undo, note edit, history edit, Watchlist) | `invalidateAfterCollectionChange` refetches about 35 prefixes across every visited tab (45–47+ requests) right before the next critical request. In `use-rerank.ts` the burst goes out *before* the queued move | F-CLI-2, F-RND-5 [local-bench][sim: title row 963 vs 170 ms 400 ms after finalize] | C (mechanism) / S (device) | M–H | Split into essential-now and deferred (`refetchType:'none'`, refetch on focus). In `use-rerank`, send the queued move first. Optionally `freezeOnBlur` | Keep every key, but fire the deferred set after the next screen's critical reads; order the essential set first | **M** | M | Auto + Dev1 | "No stale cross-screen state" becomes "on view, within one round trip"; award revocation; spoiler unmask (`watched`) | **B** | — |
| P6 | Title page | The first wave is 15 requests; the scores are 6th and 7th (after the row, 3 personal reads and credits), so on Android they leave in the second queue round. **Corrected after Codex pass 2:** no duplicate personal read runs on an ordinary open (`useLogState` mounts only inside an open `LogSheet`, and reads `user_media` and `rankings` only). After #381 the scores already precede Where to Watch, watch count and reviews | F-CLI-7 (partly refuted), F-REG-2 [local-bench][edge-log: founder P3 scores 0.27–0.51 s after the row]; Codex pass 2 [static] | S (queue position) | L–M | At most one round: send both scores ahead of `credits`, or ahead of personal reads the screen does not need yet. The real gain comes from P1/P2/P7 | None needed beyond this | L | S | Auto + Dev1 | Rank/bucket gating needs the personal reads | **D** | — |
| P7 | All Android journeys | OkHttp `maxRequestsPerHost = 5`, first in first out, on the single Supabase host (confirmed from node_modules). Images use a separate Glide client with the same cap | F-CLI-3 [static][sim] | C | M–H | A config plugin to raise the per-host limit (e.g. 16) | Client request scheduling (P4–P6) | M (it also affects image concurrency; native) | X (native, new binary) | Dev2 | None | **C** | Founder (next binary) |
| **P8** | Feed → For You placeholders; data use | Rails mount all ≤12 posters at `w500` for 84 pt tiles (3.9× the needed pixels); Trending is `w500` (3.3×); every Feed card's images load at mount (unvirtualized). On Android, For You's posters queue behind them on Glide's 5-per-host queue. Image-heavy cards date from 11-12 (heroes) and 11-17 (rails) | F-RND-2 [calc][static] | C (over-fetch) / H (symptom link) | M–H | Rails and Trending to `w342`; mount rail tiles beyond the first ~4 lazily | The size change only (2 call sites) | L | S | Auto + Dev1 | None (presentation) | **A** | — |
| P9 | Feed responsiveness | The React Compiler skips `FeedScreen` (`reactionFor` declared after `return`), and the list is an unvirtualized `ScrollView`. One count change re-renders every card (10/30/60 of 10/30/60; commit about 18–47 → about 100 jest-ms) | F-RND-1 [static][local-bench] | C (mechanism) / H (device) | M | (a) make it compilable, (b) a per-row component, (c) FlashList | (a) alone | L / L–M / M–H | S / M / M–X | Auto / Dev1 / Dev2 | Feed grouping and visibility, reactions, comments, spoiler masking | **A** (a+b) / **B** (c) | — |
| P10 | Launch | `report_device_context` takes **1.2 s** because of `pg_timezone_names` (820 ms cold, 56 ms warm) and holds 1 of the 10 pool slots during the launch burst | F-BE-3, F-CLI-8 [server][edge-log] | C | M (H at a launch spike [calc]) | Skip validation when the zone is unchanged; otherwise validate cheaply | The "unchanged, skip" shortcut | L | S (**migration**) | Auto | Proactive and release scheduling by zone | **A** | Founder (migration) |
| P11 | Notifications, badge | `my_notifications` runs `_proactive_ranked_social_actors` laterally **on every row** (loops = 78; 85 of 106 ms for the founder). Edge p50 drifted from about 100 to 236 ms | F-BE-4, F-REG-3 [server][edge-log] | C | M | Gate the lateral (`where pc.type = 'watchlist_social'` inside it) | An early return inside the function when the candidate is null | L | S (**migration**) | Auto | Notification visibility; `watchlist_social` hide rule | **A/D** | Founder (migration) |
| **P12** | Diagnosability of every journey | No per-journey or per-OTA view in Production. The Sentry `release` is the binary's; there are no journey spans or image timing; the Diagnostics recorder is off in production | F-RND-4, F-BE-11; Codex Q4 [static] | C | **H** (it blocks every regression question) | Five fixed-name journey spans (cold start, title useful, For You first posters, first comparison usable, Feed first page), tagged by `eas_update_id`, with an outcome; privacy-safe | First read what exists (navigation p75 by `eas_update_id`) | L | S (OTA) | Auto + one staging trace | Privacy (no ids or route params) | **A** | — |
| P13 | Leaderboard | `taste_match` runs per displayed row (about 85% of the time). `_leaderboard_counts` is cheap now but grows linearly (≈8 s timeout near 750k `user_media` [calc]); about 2× slower since #376 at the edge (n=5–6) | F-BE-6, F-REG-4 | C / P | L | Compute the match lazily or for the visible top N; precompute counts at scale | Defer | L–M | M (migration) | Auto | Leaderboard counting rules (#376) | **D** | Defer |
| P14 | Cron and DB hygiene | Prunes take 2 s on Production against 0.1 s on staging, cause unknown; cron history is 38% of the DB; `release-evaluate` spikes 2–2.7 s every 15 min | F-BE-7, F-REG-7 [server] | C (cost) / H (user effect) | L | Prune `cron.job_run_details`; investigate the delete cost | Defer | L | S | Auto | Operational logs (do not delete without approval) | **D** | Founder (retention) |
| P15 | Feed and profile RLS (#206) | Per-row `can_view_profile` / `can_discover_profile` cost, 0.15–0.26 ms per row; neither #206 fix landed | F-BE-8 [server] | C (cost) / P | L now | Revisit when the Feed exceeds about 10k visible rows | — | M (privacy) | X | Ext | RLS, privacy | **D** (Preventive) | Defer |
| P16 | Where to Watch, enrichment | `tmdb-adapter` p50 615 ms, p95 1.8 s; no per-operation or TMDB-upstream timing; cold boots are not the cost | F-BE-9 [edge-log] | C (latency) / F (cause) | M | Log the op and upstream time per call, then decide | — | L | S | Auto | — | **F** | Measure |
| P17 | Unknown caller | Something runs `media_cache select *` with an exact count over the whole table (7 s max). It is not in current code; plausibly the old embedded bundle of the 1.1.0 binary, or an old build | F-BE-10 [server] | H | L–M | Identify it by user agent and build in the edge logs | — | L | S | — | — | **F** | Measure |
| P18 | For You | The slate waits on the `recommendation_engine` read (#307) even when V1 is selected, as one more request in the first wave. For You needs 4–5 waves before its first poster request on a cold cache | Codex Q1; F-CLI-11 [static] | C (code) / H (impact) | L–M | Fold the engine choice into the slate response, or assume V1 while it is pending | — | M (rollback semantics of V2) | M | Auto | Rec V2 rollback guarantees (`use-engine.ts`) | **F** | Measure |
| P19 | Seasons and episodes | Episodes wait for enrichment to settle, and enrichment awaits several invalidation refetches before settling. Where nothing is seeded, the fallback is delayed | Codex Q3 [static] (`use-enrichment.ts:109–124`) | S | L–M | Settle the "enriching" flag after the seed write, before the invalidation promises | — | L–M (could double-fetch) | S | Auto | No double TMDB requests (the #378 guard) | **F** | Measure |
| P20 | Offline and flaky links | postgrest-js retries GETs 3× under TanStack's 2×, so an offline GET makes 12 attempts over about 24 s. There is no `onlineManager`, so `refetchOnReconnect` is inert | F-CLI-6 [static][calc] | C | L–M | Wire `onlineManager` to NetInfo; drop one retry layer | — | L | S | Auto | — | **D** | — |
| P21 | Cancellations | No queryFn passes TanStack's AbortSignal, so unmounted or cancelled reads keep their Android slot | F-CLI-5 [static] | C | L | Pass `signal` through `requestWithDeadline` | — | L | S–M | Auto | — | **D** | — |
| P22 | Token refresh | At about 90 s before expiry, every request waits for refresh *plus* the chunked SecureStore write. This happens at cold start after idle (0.5–0.9 s, prior [edge-log]) and about hourly in use (unmeasured) | F-CLI-9 [static] | S (mechanism) / F (frequency) | M? | Resolve requests after the token is in memory, before the durable write completes | — | **M–H** (session safety; the revision checks must stay) | M | Ext | Auth: no stale credentials after an account change | **F** | Measure |
| P23 | Minor client waste | `goals` ×2 per invalidation; the title bookmark reads the watchlist ×2; image `cachePolicy` disk-only, no memory-disk; no blurhash data; 512 px avatars at 32 pt; 18 Inter weights bundled; trace headers | F-CLI-4, F-RND-6/8/9/10 | C | L | Small cleanups | — | L | S | Auto | — | **D** | Opportunistic |

## Duplicates merged
- **P1:** F-BE-1 and F-BE-5.
- **P3:** F-REG-1, F-RND-3 and F-CLI-11.
- **P5:** F-CLI-2 and F-RND-5.
- **P6:** F-CLI-7, F-REG-2 and the client side of F-BE-5.
- **P10:** F-BE-3 and F-CLI-8.
- **P11:** F-BE-4 and F-REG-3.
- **P12:** F-RND-4, F-BE-11 and Codex Q4.
- **P13:** F-BE-6 and F-REG-4.
- **P14:** F-BE-7 and F-REG-7.

## Historical findings, re-validated
| Finding | Status now |
|---|---|
| #378 `rank_start` queued behind the refresh | **Fixed for `rank_start`**, but moved to the first `rank_answer` (P4) |
| #378 season re-enrichment | **Fixed** (3 → 2 edge calls [local-bench]) |
| #378 title second wave | **Fixed in depth** (3 waves → 2), but the first wave is now 15 (P6) |
| #342 Feed index | **Confirmed effective**: `feed_events` 500 → 40–90 ms [edge-log] |
| #206 Feed RLS | **Still present, not material** at this size (P15) |
| #381 w342 For You | **One-off disk-cache miss per poster**, then fewer bytes; the earlier claim that For You was "w500 since 11-06" is wrong (it was w500 in September) [static] |
