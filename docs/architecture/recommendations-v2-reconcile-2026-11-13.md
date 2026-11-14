# Recommendation V2 — reconciled with whole-show rankings (2026-11-13)

Branch `rec/v2-reconcile-1112`, a **draft, not for merge**. It brings the V2 stack (#250 A1,
#251 A2, #253 A3) onto `main` at `a228c6a5`, renumbers its two migrations, fixes the three
places V2 did not know about main's WS5 whole-show rankings, proves the flags fall back to
V1, extends the offline evaluation and the scale benchmark, and adds tooling for a replay on
real histories that the coordinator runs. **V2 stays off**: nothing here enables it anywhere.

> Every evaluation number below is **synthetic** (`evaluation/world.ts`) and every benchmark
> number comes from a throwaway local PostgreSQL. Neither is evidence about real readers.
> The real-history replay is **pending** (§7).

## 1. Stack method

`git merge --no-ff` of #253's head `dd73319b` (which contains #251 `7fac8650` and #250
`46cd6356`) onto `origin/main` `a228c6a5`: **no conflicts**. The branch's first commit is that
merge; everything after it is a separate commit.

## 2. Migrations, renumbered

Both V2 migrations sorted before production's latest (`20261115000100`), so `db push` would
have refused them. Neither was ever applied anywhere.

| Before | After (2026-11-13) | After wave-2 (2026-11-14, §11) |
|---|---|---|
| `20261111000100_a_wall_in_every_language_you_love.sql` | `20261116000100_a_wall_in_every_language_you_love.sql` | `20261122000100_a_wall_in_every_language_you_love.sql` |
| `20261111000200_people_whose_taste_you_share.sql` | `20261116000200_people_whose_taste_you_share.sql` | `20261122000200_people_whose_taste_you_share.sql` |

Neither file defines a function that any `20261112*`–`20261115*` migration defines, so moving
them after WS5 changes nothing either side creates. `20261117*` is left to the username-login
branch. References updated in the A2 migration, `recommendation-engine`, `taste-neighbours`,
`function-grants`, `moderation` and the race test, `recommendations-v2.md`, and two release
notes on main that named the old versions.

The tail of the ordered list on the branch as of 2026-11-13 (191 files; superseded by §11):

```
20261112000100_affinity_ends_at_a_block.sql
20261113000100_an_import_from_more_than_one_place.sql
20261114000100_a_show_is_a_category_of_its_own.sql
20261114000200_a_show_ranked_on_its_own.sql
20261114000300_an_update_that_knows_where_it_came_from.sql
20261114000400_a_show_counted_once.sql
20261115000100_a_reaction_from_anyone.sql
20261116000100_a_wall_in_every_language_you_love.sql
20261116000200_people_whose_taste_you_share.sql
```

**Clean apply.** Neither the Supabase CLI nor a Docker daemon is available in this session, so
`supabase db reset` could not run. Instead every migration was applied in sort order to a
fresh **real PostgreSQL 17.10** (the `test:race` embedded cluster): 191 files, no error, the
seven V2/WS5 functions present, and the V2 flags seeded `v2_engine = "v1"`, `v2_allowlist = []`,
`v2_allowlist_engine = null`, `v2_rollout_percent = 0`. PGlite (`test:db`) applies the same
list. A local `supabase db reset` before staging is still worth running once.

**Pre-push step (document only; not run anywhere).** A2 creates
`rankings_by_media_user (media_item_id, user_id)`. A plain build inside a migration blocks
ranking writes while it runs; at production's 1,826 rankings that is milliseconds, but the
habit is cheap:

```sql
create index concurrently if not exists rankings_by_media_user on rankings (media_item_id, user_id);
```

run by hand before `db push`, after which the migration's `create index if not exists` is a no-op.

## 3. The three WS5 gaps, fixed

| # | Gap | Fix | Tests |
|---|---|---|---|
| 1 | The V2 profile read films and seasons only (`profileFrom(profileEntriesFrom(movies, seasons, logged))`), so whole-show rankings were invisible to V2. | `profileEntriesFrom` reads `movies`, `tv_seasons` **and `tv_shows`**, each against its own bands, and gives every ranked entry V1's `seriesUnitWeights` weight (a new optional `ProfileEntry.weight` scales confidence). Logged-only titles share one unit per series among themselves. For ranked evidence V1 and V2 now weigh a series identically. | `tv-shows.test.ts` › *a whole show in the V2 profile* (5 tests); `for-you-engine-v2-shows.test.tsx` (through the real hook: a reader with only Korean whole-show rankings gets a Korean catalogue request; fails with the old call). |
| 2 | `_taste_matches` was a copy of **pre-WS5** `taste_match`. | Re-derived from `20261114000400_a_show_counted_once`: exact matching, one series one unit, units counted for the threshold and the shrink, weighted gap and weighted midrank correlation. Header and comments updated. | `taste-neighbours.test.mjs` › *equals taste_match when one person ranks two seasons of a show, or a show and a season* — 18 people across six shapes; asserts equal score and unit count for every pair, and that every pair shares more rows than units (so the fixture really exercises the weighting). Fails against the old function. |
| 3 | `collaborative_candidates('series')` read neighbours' `tv_seasons` only. | Reads `tv_seasons` and `tv_shows`; one opinion per neighbour per series: the **whole-show ranking where they made one**, else their best season (nothing inferred from a season when the show itself is ranked). A film wall reads neither. | `taste-neighbours.test.mjs` › *reads a neighbour's whole-show ranking*, *counts a neighbour once per series…*, *takes a neighbour's whole-show ranking as their opinion of the show over a season*. The first and third fail against the old function; the second is a guard. |

## 4. Flags and fallback (verified; no default changed)

| Case | Result | Test |
|---|---|---|
| No `recommendations.v2_*` key at all (production today) | `v1` for everybody; `catalogue_candidates` and `collaborative_candidates` answer nothing | `recommendation-engine.test.mjs` › *flags and fallback* › *is v1 for everybody when no V2 key exists at all* |
| Malformed `v2_engine` (`true`, `1`, an array, an object, `""`, wrong case, leading space, `null`) with allowlist, allowlist engine and 100% set | `v1` | › *is v1 for a malformed v2_engine…* |
| Allowlisted account | the configured engine; `v2_allowlist_engine = "v2_hybrid"` gives hybrid to the allowlist while the cohort stays on metadata | › *gives an allowlisted account the configured engine…* |
| Not allowlisted, rollout 0 / negative / null / absent | `v1`, even with `v2_engine = "v2_hybrid"` | › *is v1 for an account outside the allowlist at 0%…* |
| Client read fails or returns garbage | `v1` | existing `for-you-engine-v2.test.tsx` › *falls back to V1 when the engine read fails*; `engine-v2.test.ts` › *reads a malformed engine answer as v1* |

Seeded off by the migration; rollback is one `app_config` write (`v2_engine = "v1"`), reaching
every reader within the engine query's 30-minute stale time. Hybrid is reachable only through
`v2_allowlist_engine` or by setting `v2_engine` to it.

## 5. Offline evaluation (synthetic)

Full report: [`recommendations-v2-evaluation-results-2026-11-13.md`](./recommendations-v2-evaluation-results-2026-11-13.md).
480 test readers (the 2026-11-11 set of 400 plus 40 at three rankings and 40 at none), three
launch seeds each, 95% normal intervals. **Reproduction first:** the unchanged harness on this
branch reproduced the 2026-11-11 V2-metadata deltas to the third decimal (recall@20 −0.005,
pool recall −0.064, non-English +0.035, open languages +0.155). Hybrid moved slightly (133 vs 139
readers with collaborative rows): rater sampling pivots daily (`md5(reader ‖ current_date)`),
and the Match is now WS5's weighted formula rather than `corr` (identical on films up to rounding).

### 5.1 Headline, all 480 readers, paired against V1

| Metric | V1 | V2 metadata − V1 | V2 hybrid − V1 |
|---|---|---|---|
| Held-out recall@20 | 0.040 ± 0.009 | −0.002 ± 0.005 | −0.001 ± 0.005 |
| Held-out recall@50 | 0.076 ± 0.014 | −0.010 ± 0.008 | −0.008 ± 0.008 |
| Pool recall | 0.203 ± 0.024 | **−0.065 ± 0.015** | −0.046 ± 0.016 |
| Loved-over-disliked AUC | 0.606 ± 0.031 | +0.037 ± 0.025 | +0.043 ± 0.025 |
| Oracle utility percentile | 0.743 ± 0.005 | −0.006 ± 0.003 | −0.005 ± 0.003 |
| Non-English share of wall | 0.045 ± 0.012 | **+0.029 ± 0.005** | +0.028 ± 0.005 |
| Wall − own non-English share | −0.062 ± 0.009 | +0.032 ± 0.005 | +0.032 ± 0.005 |
| Open languages served | 0.328 ± 0.056 | **+0.140 ± 0.033** | +0.142 ± 0.033 |
| Languages on wall | 1.31 ± 0.06 | +0.30 ± 0.05 | +0.30 ± 0.05 |
| Genre entropy (bits) | 3.16 ± 0.03 | +0.08 ± 0.01 | +0.08 ± 0.01 |
| Era fit vs loved decades | 0.634 ± 0.011 | −0.045 ± 0.011 | −0.045 ± 0.011 |
| Repeat on next launch | 0.553 ± 0.012 | +0.078 ± 0.015 | +0.078 ± 0.015 |
| Seen titles on wall | 0 | 0 | 0 |

### 5.2 By slice (V2 metadata − V1, paired)

| Slice (n) | R@20 | R@50 | Pool recall | AUC | Utility | Wall − own non-En | Langs served | Era fit | Repeat |
|---|---|---|---|---|---|---|---|---|---|
| sparse ≤ 10 (55) | −0.008 ± 0.020 | −0.008 ± 0.020 | −0.028 ± 0.034 | +0.071 ± 0.158 | −0.007 ± 0.008 | +0.023 ± 0.012 | +0.078 ± 0.079 | +0.013 ± 0.018 | +0.012 ± 0.025 |
| medium 11–30 (249) | −0.003 ± 0.007 | +0.000 ± 0.013 | −0.071 ± 0.026 | +0.051 ± 0.043 | −0.000 ± 0.003 | +0.032 ± 0.007 | +0.135 ± 0.043 | +0.009 ± 0.006 | +0.017 ± 0.008 |
| heavy > 30 (56) | −0.006 ± 0.006 | −0.001 ± 0.007 | −0.057 ± 0.024 | +0.012 ± 0.042 | −0.000 ± 0.005 | +0.080 ± 0.023 | +0.284 ± 0.091 | +0.002 ± 0.010 | +0.024 ± 0.014 |
| cold, 0 rankings (40) | +0.018 ± 0.020 | −0.063 ± 0.022 | −0.065 ± 0.023 | — | −0.006 ± 0.012 | — | — | −0.280 ± 0.024 | +0.523 ± 0.022 |
| cold, 3 rankings (40) | +0.014 ± 0.018 | −0.022 ± 0.028 | −0.077 ± 0.031 | +0.026 ± 0.040 | −0.024 ± 0.012 | +0.004 ± 0.008 | +0.100 ± 0.139 | −0.190 ± 0.042 | +0.170 ± 0.050 |
| cold, First Five (40) | −0.016 ± 0.016 | −0.027 ± 0.020 | −0.080 ± 0.026 | +0.039 ± 0.038 | −0.028 ± 0.012 | +0.006 ± 0.005 | — | −0.151 ± 0.037 | +0.087 ± 0.057 |

Activity slices are non-cold readers by *visible* ranked titles. Archetype strata are in the
full report. Hybrid tracks metadata everywhere except pool recall (+0.019 over metadata, from
its source) and, in the heavy slice, pool recall +0.042 over V1.

### 5.3 Whole-show rankers (TV wall), the new slice

The same 360 non-cold readers, their titles recorded as TV three ways, through the shipped
`likedFrom`, `profileEntriesFrom` and `seriesUnitWeights`. `pre-reconcile` is V2 metadata with
the old profile (whole shows ignored).

| `whole_show` (every TV title ranked whole) | R@20 | R@50 | Pool recall | AUC | Non-English | Langs served |
|---|---|---|---|---|---|---|
| V1 | 0.035 ± 0.012 | 0.062 ± 0.017 | 0.218 ± 0.031 | 0.625 ± 0.042 | 0.059 ± 0.015 | 0.370 ± 0.061 |
| V2 metadata − V1 | −0.004 ± 0.006 | −0.001 ± 0.010 | −0.063 ± 0.019 | +0.045 ± 0.035 | +0.038 ± 0.006 | +0.155 ± 0.036 |
| V2 hybrid − V1 | −0.003 ± 0.006 | +0.002 ± 0.010 | −0.036 ± 0.021 | +0.051 ± 0.035 | +0.038 ± 0.006 | +0.157 ± 0.037 |
| V2 metadata − pre-reconcile | −0.003 ± 0.004 | −0.002 ± 0.004 | +0.003 ± 0.003 | **+0.050 ± 0.034** | +0.007 ± 0.002 | +0.007 ± 0.013 |

**No regression against V1 on held-out relevance** for whole-show rankers after the fix
(R@20 −0.004 ± 0.006, R@50 −0.001 ± 0.010). The fix's own effect is mostly on *ordering*: with
whole-show evidence in the profile, V2 ranks a reader's held-out loved shows above their
held-out disliked ones more often (+0.050 AUC). `by_season` and `show_and_seasons` give the
same V2 − V1 picture; for them the pre-reconcile profile is identical, as expected (seasons
were already read, and a show beside two seasons shares one unit either way).

### 5.4 The cold-start and pool-recall regressions: investigated, attributed, not a defect

The 2026-11-11 run reported both. Three diagnostic variants (not shipped configurations)
move exactly one thing each:

| Paired against V1, all readers | R@50 | Pool recall | Utility | Era fit | Repeat |
|---|---|---|---|---|---|
| **V1 − social source** | −0.012 ± 0.005 | **−0.069 ± 0.014** | −0.005 ± 0.002 | −0.057 ± 0.010 | +0.072 ± 0.015 |
| V2 metadata (as shipped) | −0.010 ± 0.008 | −0.065 ± 0.015 | −0.006 ± 0.003 | −0.045 ± 0.011 | +0.078 ± 0.015 |
| **V2 metadata + social source** | +0.000 ± 0.007 | **+0.003 ± 0.003** | −0.002 ± 0.002 | +0.006 ± 0.004 | +0.003 ± 0.007 |

| First Five, paired against V1 | R@20 | Pool recall | Utility |
|---|---|---|---|
| V1 − social source | −0.017 ± 0.018 | −0.084 ± 0.029 | −0.024 ± 0.012 |
| V2 metadata | −0.016 ± 0.016 | −0.080 ± 0.026 | −0.028 ± 0.012 |
| V2 metadata + social source | +0.001 ± 0.007 | +0.000 ± 0.000 | −0.008 ± 0.007 |

At **zero** rankings V2 metadata is *identical* to V1 without social (no profile, no anchors).

**Cause:** V2 removes `social_candidates` — what followees loved — by the spec's rule that
following alone is no evidence about taste. In this world follows are weakly homophilous, so
followees' loves are a real source of held-out titles, most of all for a reader with nothing
else to go on. Removing that source from V1 reproduces V2's pool-recall and cold-start deltas;
putting it back into V2 erases them. The profile, catalogue fill and scorer account for at
most a −0.008 ± 0.007 utility residue at the First Five. **Not a clear defect, so nothing was
changed.** It is a product decision with a cost the founder should see (§9). The era-fit and
repeat deltas have the same cause. A V2-compatible way to recover it would be a source that
does not depend on the follow graph (the hybrid's taste neighbours already recover +0.019 pool
recall and +0.042 for heavy readers); not built here.

### 5.5 What this evaluation cannot show

The same caveats as 2026-11-10/11: synthetic people, exposure-biased held-out evidence, no
dismissals or exposure memory (repeats are between first launches with different seeds), no
TMDB fills, and the TV slice is the film world relabelled (§`TvShape`). A V2 gain in languages
served is the model's assumption that people are open to languages they rarely watch.

## 6. Scale benchmark, before and after the WS5 changes

`scripts/rec-eval/scale-bench.mjs`, local PostgreSQL 17.10, 4 CPUs, same machine, same
workload for both sides. The workload now includes whole-show rankings beside seasons (an
account can rank both for one show), and each reader also times the TV read. *Before* is the
merge commit `fc15f87` (stack as submitted) with the new bench script; *after* is this branch.
One run each, 28 measured readers: read differences under ~20% as noise. These numbers are
from a faster container than the 2026-11-11 document's and are not comparable with it.

| Call (ms), p50 / p95 | 100k before | 100k after | 1M before | 1M after |
|---|---|---|---|---|
| `recommendation_engine()` | 0.3 / 0.4 | 0.3 / 0.4 | 0.3 / 0.5 | 0.3 / 0.5 |
| `catalogue_candidates` | 2.2 / 3.3 | 2.4 / 3.0 | 2.2 / 3.1 | 2.5 / 2.9 |
| `collaborative_candidates('movie')`, cold (includes the refresh) | 161 / 384 | 193 / 452 | 156 / 303 | 167 / 366 |
| `collaborative_candidates('movie')`, warm | 67 / 87 | 65 / 88 | 68 / 94 | 74 / 116 |
| `collaborative_candidates('series')`, cold | 158 / 349 | 229 / 514 | 154 / 309 | 211 / 402 |
| `collaborative_candidates('series')`, warm | 71 / 89 | 103 / 150 | 76 / 112 | 117 / 154 |
| `people_taste_matches(10)` (existing, unchanged, not For You) | 366 / 2,235 | 397 / 2,350 | 4,249 / 16,952 | 4,249 / 17,585 |
| Concurrency: 8 sessions, 32 cold refreshes | 25.4/s, p95 457 | 17.8/s, p95 576 | 37.8/s, p95 317 | 28.5/s, p95 439 |
| Writers during refreshes, insert p95 | 12.3 | 8.0 | 12.0 | 11.7 |

Workload: 100k accounts → 1.54M rankings; 1M accounts → 16.2M rankings (4.4 GB), head title
247k raters. A2 index build: 851 ms plain / 1,014 ms concurrently at 100k; 9.2 s plain / 12.5 s concurrently at 1M (production today: 1,826 rankings).

**Reading.** The film-wall warm read is unchanged within noise (67 → 65 ms at 100k, 68 → 74 ms
at 1M). The TV warm read costs about 45–55% more (71 → 103 ms, 76 → 117 ms p50) because it now
scores the neighbours' whole-show rankings beside their seasons (a second `_scored_rankings`
pass), and cold refreshes cost about 10–20% more on films and 35–45% more on TV, paying for
WS5's unit join and weighted moments in `_taste_matches`. Concurrent refresh throughput falls
accordingly (37.8 → 28.5/s at 1M); writers were never blocked (insert p95 ≤ 12 ms throughout). `catalogue_candidates`
and `recommendation_engine()` are untouched. The 2026-11-11 conclusion stands: **the hybrid's
warm read needs a per-reader result cache before it goes past the allowlist**; metadata's RPCs
stay in single-digit milliseconds.

## 7. Real-history replay: tooling ready, **run pending**

`eval/rec-v2-replay/` (README there). No database was accessed from this session.

- `export.sql`: one read-only `SELECT`; random per-run account keys; media ids; ranking day and
  per-account ordinal only; no user id, username, display name, email, bio, note, comment,
  watch date or sub-day time. `export.test.mjs` runs it against every migration in a READ ONLY
  transaction and fails on any identifying column, any key outside the allowlist, or keys that
  repeat across runs, and proves it fails when a username is added.
- `run.mjs`: reads the export from `REC_V2_REPLAY_EXPORT` (refuses any path inside the
  repository), holds out the last 20% of each account's Liked rankings by time, draws V1 and
  V2 metadata Films and TV walls through the shipped functions, prints aggregate tables only.
  A `v2_metadata+social` diagnostic attributes any gap the same way as §5.4.
- **Hybrid:** reported as *not measurable at current scale* with a coverage count (accounts
  with ≥ 2 taste neighbours at Match > 55 on ≥ 5 shared series).
- **Synthetic proof:** `node eval/rec-v2-replay/run.mjs --synthetic` (1,200 generated accounts
  from `world.ts`, every fourth title a show, a third of accounts ranking shows whole) ran end to
  end. It is a pipeline proof only; its numbers are not evidence. One pattern in it is
  worth the coordinator's attention on the real run: on the **TV wall** V2 metadata was well
  below V1 (recall@50 −0.161 ± 0.043, pool 20 vs 43 titles), and `v2_metadata+social` erased
  the gap (+0.006 ± 0.015). The synthetic export gives each show a thin TMDB list (only the
  shows among a title's 20 similar titles, about five), so the follow-graph source carried most
  of V1's TV pool. Whether real TV walls look like that depends on how full real TMDB show lists
  are, which is what the real replay measures. On the Films wall V2 matched V1 on recall
  (+0.003 ± 0.011 R@50) with +0.048 non-English share.

## 8. Risks

- **Pool recall and cold start** are lower under V2 by design (§5.4). For a new reader whose
  only signal is who they follow, V2's first walls are less likely to hold what they turn out
  to love.
- **TV walls where TMDB lists are thin** may lean on the follow-graph source in V1 more than
  film walls do; under V2 that source is gone and only anchors and the catalogue fill remain.
  The synthetic replay shows the failure mode (§7); the real replay will show whether it is real.
- **TV read cost** rises with whole-show rankings (§6). Fine at today's size; the per-reader
  cache is a prerequisite for the hybrid past the allowlist regardless.
- **The A2 index** blocks writes while built inside the migration; trivial now (§2 pre-step).
- **Small cohort.** At ~46 rankers any real replay or A/B is directional only.
- **Synthetic TV slice** relabels films as shows; real TV lists, season counts and show/season
  mixing are not modelled.
- `test:race` R5 (*a block that lands first leaves nothing to release*, recommendation
  requests, not V2 code) failed once under heavy machine load with an unhandled rejection and
  passed 3/3 alone and in the full rerun.

## 9. Staged, reversible rollout

1. **Land the migrations inert.** Flags seeded off (`v2_engine = "v1"`): every reader on V1;
   the V2 RPCs answer nothing. Run the index pre-step first.
2. **Staging.** Allowlist the founder and 2–3 QA accounts on `v2_metadata`. Side by side,
   10 V1 and 10 V2 walls per account, each title marked *would watch / wouldn't*.
3. **Production allowlist**, the same accounts.
4. **`v2_rollout_percent` 10 → 50 → 100**, watching `for_you_slate_shown` (`engine`,
   `wall_languages`), save-to-Watchlist and rank-from-For-You rates per engine, and RPC error
   rate. **Rollback at any step:** `v2_engine = "v1"` (one write, ≤ 30 min to reach everyone).
5. **Hybrid stays allowlist-only** until a per-reader cache exists and there are enough
   readers for neighbours to exist.

### Decisions for the founder

| Decision | Recommended default |
|---|---|
| Ship V2 metadata first, hybrid dormant | **Yes** |
| Land the A2 migration now (inert) or hold it | **Land it inert**: it is off, tested, and holding it means renumbering again later |
| Accept V2's lower pool recall / cold start as the cost of "following is not taste" | **Yes for the allowlist and staged rollout, watched**; revisit with the real replay and the rank-from-For-You rate before 100% |
| QA allowlist accounts | Founder plus 2–3 QA accounts, named by the founder |

## 10. Follow-up: the Films pool-recall gap in the real replay (2026-11-13)

**What the real replay showed** (run by the coordinator on 44 pseudonymous production
accounts; reported to this branch as aggregates, not committed): V2 metadata's **Films pool
recall was −0.136** against V1, while its **TV Recall@50 was +0.106**. The question: is
dropping the follow-graph source (`social_candidates`) what costs relevant films, and can it
be kept for films without giving up the TV gain?

### 10.1 Attribution: pool recall split by source

Both the replay (`eval/rec-v2-replay`) and the A3 harness now split pool recall by the source
that put each held-out positive in the pool — the anchors' TMDB lists, then followees
(`social`), then trending, then the catalogue fill (and collaborative in A3) — so the parts
sum to pool recall and a gap reads off by source. Two diagnostics rule the other suspects in
or out: `v2_metadata+social` (follow graph on both walls) and `v2_metadata+v1_anchors` (V2 with
V1's anchor selection).

**Synthetic replay** (1,196 generated accounts; a pipeline result, not evidence):

| Films wall, all accounts | Pool recall | via anchors' lists | via social | via trending | via catalogue |
|---|---|---|---|---|---|
| V1 | 0.200 ± 0.020 | 0.088 ± 0.014 | 0.080 ± 0.014 | 0.032 ± 0.009 | 0.000 |
| V2 metadata − V1 | −0.067 ± 0.014 | −0.000 ± 0.000 | **−0.080 ± 0.014** | +0.007 ± 0.004 | +0.006 ± 0.003 |
| V2 metadata + V1 anchor selection − V1 | −0.067 ± 0.014 | +0.000 | −0.080 ± 0.014 | +0.007 | +0.006 |
| **`v2_metadata_social` (prototype) − V1** | **+0.005 ± 0.002** | −0.000 | +0.000 | +0.000 | +0.005 ± 0.002 |

The whole Films gap is the social source: the anchors' lists reach exactly the same held-out
films under both engines, and V1-style anchor selection changes nothing (most collections are
smaller than the anchor budget, so both selections take every liked title). The catalogue fill
and trending recover a little (+0.013). **The real export will say whether production looks the
same**: the coordinator's next run prints this table on the 44 accounts (§10.4).

A3 (synthetic, 480 readers, follows weakly homophilous):

| Paired vs V1, all readers | Pool recall | via anchors' lists | via social | via catalogue | via trending | R@50 | Non-English | Languages served | Era fit | Repeat next |
|---|---|---|---|---|---|---|---|---|---|---|
| V2 metadata | −0.065 ± 0.015 | −0.000 | **−0.081 ± 0.015** | +0.004 ± 0.002 | +0.012 ± 0.005 | −0.010 ± 0.008 | +0.029 ± 0.005 | +0.140 ± 0.033 | −0.045 ± 0.011 | +0.078 ± 0.015 |
| **prototype** | **+0.003 ± 0.003** | −0.000 | +0.000 | +0.003 ± 0.003 | +0.000 | +0.000 ± 0.007 | **+0.029 ± 0.005** | **+0.140 ± 0.033** | +0.006 ± 0.004 | +0.003 ± 0.007 |

| First Five, paired vs V1 | R@20 | R@50 | Pool recall | Utility | Era fit | Repeat next |
|---|---|---|---|---|---|---|
| V2 metadata | −0.016 ± 0.016 | −0.027 ± 0.020 | −0.080 ± 0.026 | −0.028 ± 0.012 | −0.151 ± 0.037 | +0.087 ± 0.057 |
| **prototype** | +0.001 ± 0.007 | +0.005 ± 0.013 | +0.000 | −0.008 ± 0.007 | −0.021 ± 0.014 | −0.034 ± 0.026 |

In A3 (a films-only world) the prototype closes the pool gap **and keeps V2's whole language
gain** (+0.029 non-English, +0.140 open languages served, identical to V2 metadata), and it
removes most of V2's First Five regression. The synthetic replay kept only part of the language gain
(§10.3); the two worlds disagree on that, which is one more reason the real run decides.
Full report: `recommendations-v2-evaluation-results-2026-11-13b.md`.

### 10.2 The prototype: `v2_metadata_social`

A separate engine id, so nothing about `v2_metadata` changes:

- **Same as `v2_metadata`** in weights, behavioural profile (with whole shows), language-aware
  anchors, catalogue fill and scorer. Following adds no score term: social ids only join the
  pool, and the V2 scorer decides on the reader's own evidence.
- **Plus `social_candidates` on the Films wall only** (`SOCIAL_SOURCE` / `asksSocial` in
  `rank.ts`). Its **TV wall is `v2_metadata`'s exactly**, so the real replay's TV gain cannot
  move: proven title for title through the real hook (`for-you-engine-v2-shows.test.tsx`) and
  metric for metric in both harnesses.
- **Allowlist-only on the server.** `recommendation_engine()` accepts it only as
  `recommendations.v2_allowlist_engine`; as `v2_engine` it is an unknown engine and therefore
  `v1` for everybody, so it can never reach a rollout percentage. `v2_engine = "v1"` still
  turns it off for the allowlist. It gets the catalogue source and no collaborative evidence.
  Tests: `recommendation-engine.test.mjs` › *serves the v2_metadata_social prototype to the
  allowlist only…*, *gives the prototype the catalogue source and no collaborative evidence*.
- Telemetry carries `engine: "v2_metadata_social"`, so an allowlisted comparison against
  `v2_metadata` reads straight off `for_you_slate_shown`.

### 10.3 What it may cost: part of V2's multilingual gain on films

In A3 nothing (§10.1). In the synthetic replay, Films wall, paired against V1:

| Slice | Engine | R@50 | Pool recall | Non-English | Languages on wall | Genre entropy |
|---|---|---|---|---|---|---|
| all | V2 metadata | +0.003 ± 0.011 | −0.067 ± 0.014 | +0.048 ± 0.003 | +0.68 ± 0.05 | +0.063 ± 0.008 |
| all | **prototype** | +0.005 ± 0.008 | +0.005 ± 0.002 | +0.027 ± 0.003 | +0.33 ± 0.03 | +0.047 ± 0.006 |
| sparse ≤ 10 | V2 metadata | +0.012 ± 0.043 | −0.055 ± 0.042 | +0.085 ± 0.009 | +1.45 ± 0.13 | +0.108 ± 0.026 |
| sparse ≤ 10 | **prototype** | +0.017 ± 0.028 | +0.000 | +0.016 ± 0.005 | +0.25 ± 0.07 | +0.102 ± 0.013 |
| heavy > 30 | V2 metadata | +0.006 ± 0.009 | −0.054 ± 0.017 | +0.039 ± 0.005 | +0.45 ± 0.06 | +0.043 ± 0.009 |
| heavy > 30 | **prototype** | +0.005 ± 0.009 | +0.008 ± 0.004 | +0.037 ± 0.005 | +0.42 ± 0.05 | +0.039 ± 0.008 |

Followees' loves are mostly popular English films, and they compete for the same wall. Heavy
readers keep almost all of V2's language gain (their own evidence outweighs the extra
candidates); sparse readers give most of it back. If that matters more than the recovered
films, the next lever is a smaller social quota under the prototype (V1 takes 40) — not built,
because the real attribution should decide whether it is needed.

### 10.4 For the coordinator's next real run

Same command, same export format (`node eval/rec-v2-replay/run.mjs`). It now replays five
engines (V1, V2 metadata, the prototype, and the two diagnostics) and prints **Pool recall by
source** for both walls. What to read:

1. **Films, `v2_metadata − v1`, "via social"**: if it is close to −0.136, the follow graph is the
   whole gap, as in the synthetic runs; if "via anchors' lists" also moves, something else is
   at work too (the `+v1_anchors` row then says whether it is anchor selection).
2. **Films, prototype − V1**: pool recall and R@50 back to V1's, and how much of the
   non-English / languages gain survives.
3. **TV, prototype − V2 metadata**: zero by construction (the +0.106 R@50 is kept).

### 10.5 Decisions this adds for the founder

| Decision | Recommended default |
|---|---|
| Allowlist the prototype beside `v2_metadata` (founder + QA accounts split between them) | **Yes, once the real attribution confirms the gap is the follow graph** |
| Is "following adds candidates but never score" acceptable under the spec's "following alone has no effect"? | **Founder's call.** It is a narrower reading than the spec's; the prototype exists so the cost of the strict reading is measured, not assumed |
| If the prototype becomes the V2 default for films, cap its social quota to protect sparse readers' language mix | Decide after the real run's language columns |

V1 stays the production default; `v2_metadata` and the prototype are both allowlist/rollout
controlled and off by default; the hybrid stays allowlist-only.
