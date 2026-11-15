# Taste Score, Recommendation Engine V2, Affinity notifications — gap analysis

Written 2026-11-10 against `main` at `cf52810` and draft PR #220 at `e4ff43a`, for the
founder spec of the same date (the spec is the source of truth; its product decisions are
settled and are not re-argued here). Three columns per area: what **exists**, what must be
**modified**, what is **new**. "Ships in" names the work package from spec §8.

Nothing here has been applied to any live database, deployed, or published.

## 1. Taste Score

| | |
|---|---|
| **Exists** | `taste_match(uuid)` (`20260827001000`): common ranked titles via `band_bounds`/`score_for`; proximity `100·(1 − mean gap/7)`; midrank Spearman blended in with weight `0.25·clamp((n−8)/12)`; shrunk toward 50 by `n/(n+5)`; refuses self and anyone `can_view_profile` refuses. Shown only at ≥5 exact shared ranked titles. `people_taste_matches(int)` (`20260912000100`) for discovery. |
| **Modify** | **Nothing in the calculation.** The spec says to preserve it unless comparative evidence says otherwise, and none exists. |
| **New** | A set-based pair function equal to `taste_match` for batch use (A2), proven equal by test. Bounded neighbour retrieval and a cache (A2), because recommendations must not compute Taste against every account. |
| **Scale gap** | `people_taste_matches` scans every ranking that shares any of the caller's titles before limiting — unbounded in title popularity (§7). Not changed here; recorded as a risk with a measured boundary in the benchmarks. |

## 2. Recommendations (For You)

| Spec requirement | Exists (V1, on-device, `rank.ts` + `use-for-you.ts`) | Gap | Ships in |
|---|---|---|---|
| Language from behaviour, ranking strength, no English assumption, several languages | `tasteFrom`: Σ `max(0.1, score/10)` per language ÷ the largest. Rankings only. | Volume-normalised, so the majority language owns the scale; every ranking is positive; logged-but-unranked titles say nothing. | A1 `profile.ts` |
| Watched-but-unranked at lower confidence | — | Not read at all. | A1 |
| Language improves **candidate generation** | Candidates come only from anchors' TMDB `similar` lists, follow-based `social_candidates`, English-heavy trending. | Nothing is generated *for* a language; anchor selection covers genres only. | A1 language anchors + `catalogue_candidates` |
| Era: smoothed decades, exposure ≠ preference, classics kept, movies vs TV | — | No era term. (A plain decade term *lowered* ordering on the 2026-09-13 real-data held-out eval, `docs/product/recommendations.md` §11.1.) | A1, relative-to-exposure, small weight |
| Genre negative evidence | Positive only. | Disliked genres still add affinity. | A1 |
| Explainability / fallback | `Explanation.lead`, `headlineFor`, `popularityOnly`. | Must not claim a neutral term as the reason. | A1 (lead on excess over neutral) |
| Following alone gives no boost | `social_candidates` adds followees' loved titles to the pool. | A pool source keyed on following *is* a boost. | A1 (V2 drops it); A2 replaces it with taste-compatible evidence |
| Taste-compatible strangers, bounded, confidence-weighted, negatives, no exposure of restricted rankings, server-side | — | No collaborative source. | A2 |
| Reproducible comparison, versioned configs, flag, rollout | `quality.test.ts` (structural, seed catalogue); §11.1 offline eval doc. No engine switch. | No harness comparing engines; no flag. | A1 flag; A3 harness + results |
| §7 scale | On-device scoring over a bounded pool. | `top_rated_titles` aggregates all rankings per call (not on the For You path). | Benchmarked in A3 |

## 3. Affinity Score and proactive friend notifications

PR #220 (draft) carries the proactive-notification system. Its branch sits on the
security work that is now in `main`, no migration has landed on `main` since its base, and
a trial merge of `e4ff43a` onto `cf52810` is clean with its 184 DB tests passing. It is
brought forward on a new branch (B1); #220 itself is not touched.

| Spec requirement | Exists in #220 | Gap | Ships in |
|---|---|---|---|
| Affinity: 90-day lookback, 30-day half-life, interaction families | `_proactive_affinity(reader, friend, now)` exactly so, computed on demand, never stored or exposed. | Reuse as is. Notion's open item: the blocked-user edge case is not covered by an explicit test. | B1 (audit + tests) |
| High-affinity threshold from the distribution | — (affinity only orders clusters and picks which two names) | No threshold; no distribution measured. | B1 ships the *actual*-distribution read (`proactive_affinity_distribution`, service role); choosing the threshold, and any simulated distribution, is B2 |
| Mutual follow mandatory; high affinity without mutual never qualifies; mutual alone insufficient | `watchlist_social` counts mutual friends; affinity plays no part in qualifying. | "Qualifying friend" = mutual ∧ affinity ≥ threshold is new. | B1/B2 |
| Type A: one qualifying friend watches/ranks a title on the recipient's Watchlist | Needs **two** mutual friends. | One qualifying friend suffices; copy "Ravi watched Dune. It's on your Watchlist." | B2 |
| Type B: ≥2 distinct qualifying friends within a configurable window, no Watchlist needed | — | New trigger and cluster. | B2 |
| A+B combine; no generic per-friend push; revalidate; expiry; title cooldowns | Ledger, revalidation (`_proactive_invalid`), expiry, 7-day title cooldown. | Combine A+B per (recipient, title). | B2 |
| ≤2 per rolling 7 days, ≤1 per local day, **no consecutive local days**, no more for higher affinity | Daily cap 1, weekly cap 2, type cooldown 72 h. | No-consecutive-days rule. | B2 |
| Don't modify Feed ordering; Affinity never in recs | Affinity not read outside proactive selection. | Keep so; test it. | B2 test |
| No synchronous high-degree fanout in user-facing writes | Social cluster writes happen in the ranking transaction's trigger, per mutual friend who saved the title. | Move qualifying friend-activity work off the write path. | B2 |
| Telemetry: reasons, suppression, coarse affinity band, handoff ≠ acceptance, opens, follow-on actions, opt-outs; nothing pairwise to third parties | Ledger, `notification_opens`, `proactive_summary`, `proactive_attribution`; `sent` documented as handoff. | Coarse affinity band; opt-out/fatigue counts. | B3 |
| §6 timing: no predictive model; instrumentation for a future one; fixed fallback | Fixed 17:00–20:00 local window. | Record local hour of activity for a future model. | B3 |

## 4. Reusable for the concurrent reaction-UI work

The reaction-summary PR (another agent) wants "the highlighted name uses Affinity with
recency fallback". `_proactive_affinity(reader, friend, now)` is that lookup; it is
server-only and must stay so (never in an RPC result). B1 did **not** add a batch form
(status 2026-11-11): it guards `_proactive_affinity` against blocked and inactive pairs, so
a caller that loops over a bounded candidate list gets the right answer. A batch form is
left to whichever PR first needs one.

## 5. What this analysis does not claim

- Synthetic evaluation (A3) is evidence about mechanics on synthetic readers, not proof of
  improvement for real readers.
- The affinity threshold derived from a simulated distribution (B1) is a starting value
  for staging, to be re-derived from the real distribution before rollout.
- Predicted Score (spec §10) is a separate, tabled project and is not touched.
