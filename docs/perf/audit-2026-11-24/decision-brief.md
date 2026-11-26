# Decision brief: why bingd feels slow, and what to do about it

This is for the founder and GPT to review. **Nothing here is implemented or approved.**

## 1. Why is bingd slow now?
Three standing costs stack on every screen, and recent weeks made you meet them more often:

1. **Production's database tier.**
   - Production runs on Supabase's smallest compute (Nano), with a 10-connection pool.
   - When the app has been quiet for more than about a minute, the first request pays about **0.7 s** to wake a connection, against about 0.2 s on staging.
   - The SQL itself is fast (most title reads take under 15 ms), but every request on Production costs 2–5× more end to end than on staging.
   - With very few users, most app opens start cold. That is exactly "artwork first, scores and counts a beat later".
2. **Android queues requests five at a time.**
   - The title page sends 15 requests at once, so the scores wait about one queue round.
   - Every write sends 45–47 refetches, and a ranking sends about 92. Whatever you tap next waits behind them.
3. **Cold starts doubled during the release burst.**
   - Sixteen production updates in four days forced reloads.
   - Your app launched about **9 times a day instead of 5** (16 on 11-22).
   - Nothing is cached across launches, so each one rebuilt every screen from scratch.

## 2. A recent regression, or older debt?
**Mostly older debt.**

- **No regression on any journey the server can see.** Your own Production sessions from before and after 11-20 show:
  - title scores at 0.47 vs 0.46 s;
  - rank to first comparison at 0.79 vs 0.84 s;
  - the Feed faster after the index (3.2 → 2.4 s).
- **What did measurably change:**
  - cold-start frequency;
  - `my_notifications` got slower;
  - the Leaderboard got slower after #376.
- **Not ruled out:** device-side rendering and image cost (the image-heavy Feed since 11-12/11-17). Server logs cannot see it, and there is no device measurement yet.

## 3. The highest-value improvements

| # | Change | Expected benefit | Correctness risk | Founder QA |
|---|---|---|---|---|
| 1 | **Upgrade Production compute to Micro (or Small)** and **keep PostgREST connections warm longer** (idle timeout about 5–10 min). Config only, no code | Removes most of the 0.7 s cold-connection penalty and doubles the pool. Should help every screen on both platforms. Measurable from edge logs within a day | **None to product behaviour.** A Postgres restart of a few minutes needs a quiet window. Cost roughly +$10/month for Micro | None |
| 2 | **Batch production OTAs** (at most one a day outside emergencies) | Halves the forced cold starts you experienced during the burst | None. Fixes reach users a little later | None |
| 3 | **One refresh per ranking, not two; defer refreshes for screens you can't see** (P4, then P5) | First comparison answer and "next screen after a write" stop waiting behind 45–92 requests: [sim] up to about 1 s saved on Android | P4: low. P5: medium, because a hidden screen may show the old value for about one round trip when you return to it | P4: none. P5: one focused Android pass (write, then switch tabs) |
| 4 | **Smaller Feed images** (rail and Trending posters at `w342`, rail tiles mounted lazily; P8) | 3–4× fewer image pixels at launch. For You's posters stop queueing behind off-screen Feed images on Android (plausible; device-unmeasured) | Low (presentation only) | A quick look at the Feed on a large phone |
| 5 | **Measure it properly: five privacy-safe journey timings**, tagged by update (P12) | Turns every future "is it slower?" into a chart; no more forensic audits | Low (privacy-checked attributes only) | None |

One smaller companion is worth bundling:
- the `report_device_context` shortcut (P10: frees a pool slot for 1.2 s at every launch; one migration).

The title-page reordering (P6) was downgraded after Codex showed the scores already sit 6th and 7th; at most one queue round remains to gain.

## 4. What not to change
- **Ranking writes stay inside the existing RPCs.** No client-side position math, parallel writes or cached-band inserts. Those protect gapless positions, band order, exactly-once retries and provisional re-ranking (I1–I7).
- **Privacy checks stay in every Feed, preview and leaderboard read.** The RLS cost is real but immaterial at this size (P15).
- **No persisted cache that isn't per-account and purged on sign-out.** Done carelessly, it could show one account's data to another.
- **Do not raise the PostgREST pool on the current Nano tier.** It adds memory pressure; upgrade first.
- **Native networking changes (Android's 5-per-host limit) only with the next store binary**, never as an emergency fix. They also change image concurrency (P7, class C).

## 5. Remedies that need your physical QA
- **#3, deferred refreshes (P5):** one Android pass. Rank a title, switch to Collection and to the Feed, and check that everything is current within a second.
- **#4, smaller Feed images (P8):** a quick look at the Feed rails on a large phone, to confirm they still look sharp.
- **The 1.2.0 binary with a raised per-host limit (P7), if approved:** Android and iOS, Feed and For You image loading.
- **Everything else** is verifiable from tests and edge logs.

## 6. Not worth addressing before more users
- Leaderboard `taste_match` cost (P13).
- RLS per-row cost (P15).
- Cron prune cost and history size (P14).
- Nested retries and offline behaviour (P20).
- Request cancellation (P21).
- Avatar, font and trace-header trimming (P23).
- FlashList for the Feed (P9c), unless device data shows render cost.

## 7. Preventing similar regressions
- **Journey timings per OTA** (P12) with the budgets in `performance-baseline.md`. Compare each release against the previous one before announcing "faster" or "slower".
- **The request-count harnesses** from this audit (title first wave, fan-out per write) promoted to CI assertions, so a PR that adds requests to a critical wave fails visibly.
- **Release cadence:** batch OTAs; one Preview publish per QA session.
- **A weekly edge-log check** of the first request after idle and the per-path p50/p95 (the queries are in `evidence/backend-evidence.md`).

## Recommended decisions for founder review
These are proposals, not approvals.

| Item | Proposal |
|---|---|
| P1 Production compute → Micro (or Small) | **Approve candidate** (config; schedule a quiet window) |
| P2 PostgREST idle timeout → 5–10 min, after P1 | **Approve candidate** |
| P3 OTA cadence: at most one Production OTA a day | **Approve candidate** (process) |
| P12 Privacy-safe journey timings by update | **Approve candidate** |
| P4 One refresh per ranking | **Approve candidate** |
| P8 Rail and Trending posters at w342 | **Approve candidate** |
| P5 Deferred invalidations for hidden screens | **Approve only with verification** (Android pass; the "stale on view for ≤1 round trip" trade-off accepted explicitly) |
| P6 Title score ordering | **Defer** (at most one queue round left after #381; Codex refuted the duplicate-read premise) |
| P10 `report_device_context` shortcut (migration) | **Approve only with verification** (migration plus pgTAP) |
| P11 `my_notifications` lateral gate (migration) | **Approve only with verification** |
| P9 Feed compiler fix and row component | **Investigate further** (needs a device render profile first) |
| P3b Persisted per-account cache | **Investigate further** (design review against §3 of `functionality-preservation.md`) |
| P16 tmdb-adapter per-op timing, P17 unknown full-table caller, P18 For You engine gate, P19 episode wait, P22 token refresh stall | **Investigate further** (measure first) |
| P7 Android per-host limit | **Defer** to the next store binary, with multi-platform QA |
| P13, P14, P15, P20, P21, P23 | **Defer** |
| Removing privacy predicates, client-side ranking writes, an unpartitioned persisted cache, raising the pool on Nano | **Reject** |
