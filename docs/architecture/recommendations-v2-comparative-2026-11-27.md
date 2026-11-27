# Recommendation engines: a four-way comparison, 2026-11-27

**Status: evaluation only.** Nothing here changes an engine, a weight, a migration, a flag or
Production, and no Production data was read. V1 stays the default
(`recommendations.v2_engine "v1"`, `v2_rollout_percent 0`, `v2_allowlist []`, as last recorded on
2026-11-20 in `recommendations-v2.md`; not re-read here).

Every number carries its source:

- **[real-history, prior]**: aggregates from earlier read-only runs on Production histories,
  already in the repository. **R1**: 2026-09-13, 31 raters and 596 rankings
  (`docs/product/recommendations.md` §11.1). **R2**: 2026-11-13, the `rec-v2-replay` export, 44
  pseudonymous accounts (`recommendations-v2-reconcile-2026-11-13.md` §10). **R3**: Production
  catalogue and cache aggregates read on 2026-11-19, no user table (branch
  `claude/launch-c-rec-verdict`, `docs/release/rec-quality-verdict-2026-11-19.md`, not on `main`).
- **[synthetic]**: generated worlds (`evaluation/world.ts`). They show how the engines behave
  under a stated model of taste. **They are not evidence about bingd's readers.**
- **[local-bench]**: a throwaway local PostgreSQL 17 with generated data. Not Production latency.
- **[calc]**: arithmetic on the above.

Intervals are 95% bootstrap intervals over people, `[lo, hi]`. "Δ" is paired per person against
V1 unless it says otherwise.

## 1. The four engines

| Id | Name | Candidate sources | Scorer |
|---|---|---|---|
| `v1` | V1 (Production) | Anchors' TMDB lists, followees' Liked titles (`social_candidates`, 40 rows shared by both walls), trending | V1: anchor 0.60, genre 0.18, language 0.12, popularity 0.10 |
| `v2_metadata` | V2 Metadata | Anchors (language-aware selection), trending, `catalogue_candidates` only to fill an under-served language or decade. **No follow graph.** | Behavioural profile; V1 × 0.93 plus era 0.07 |
| `v2_metadata_social` | V2 Metadata + Social | V2 Metadata **plus `social_candidates` on the Films wall only**. Its TV wall is V2 Metadata's. Server-side it is allowlist-only (`v2_allowlist_engine`); it can never reach a rollout percentage. | V2 Metadata's |
| `v2_hybrid` | V2 Hybrid | V2 Metadata plus endorsed titles from taste-compatible public accounts (`collaborative_candidates`; two neighbours at 7+ per title) | V2 Metadata × 0.85 plus a collaborative term 0.15 |

History: A1 `v2_metadata` (#250), A2 `v2_hybrid` (#251), A3 offline evaluation (#253), the WS5
reconcile and the prototype (#275, commit `56d73312`), the staging-line reconcile (#301, draft),
all shipped dark in the integrated release #307 (merge `204da159`); the benchmark (#316, merge
`4531f0c3`). All four engine ids are on `main` (`rank.ts` `ENGINES`; `recommendation_engine()`
accepts `v2_metadata` and `v2_hybrid` as `v2_engine`, and the prototype only as
`v2_allowlist_engine`).

## 2. What existed before this work

### 2.1 Real-world evidence (all of it)

| | Films | TV | Sample | Limits |
|---|---|---|---|---|
| **R1** V1 taste ordering (pairwise, loved vs not, among watched films) | **0.444**, below chance | not interpretable | 7 film raters with ≥ 10 rankings, 1,319 pairs; 3 TV raters | 2026-09-13, before V2 existed; V1 only |
| **R1** V1 candidate recall | 18% of held-out loved films reach the pool; loved titles are *less* likely than not-loved ones to sit on an anchor's TMDB list (15% vs 33%) | — | same | low-N |
| **R2** V2 Metadata − V1, Films pool recall | **−0.136** | — | 44 accounts | No interval was recorded. No by-source split. Older harness (`rec-v2-replay`): last 20% of Liked rankings by time, recall normalised by `min(liked, k)`. **Pre-fix social mirror** (§2.3) |
| **R2** V2 Metadata − V1, TV Recall@50 | — | **+0.106** | 44 accounts, fewer with TV | Same, and the TV subset is smaller still |
| **R3** catalogue and lists | TMDB lists rarely stay in-language for Indian languages (Telugu 2%, Tamil 5%, Hindi 9% same-language; Japanese films 69%); the catalogue holds 35 Telugu film tiles against 12,341 English | Japanese TV lists 82% same-language | 3–22 lists per language | A catalogue read, not a recommendation measurement |

**Never measured on real data:** V2 Metadata + Social, V2 Hybrid (R2 reported it as not
measurable), any cold-start slice, any interval on R2, any by-source attribution of R2's Films gap.

### 2.2 Prior synthetic evidence

| Run | Size | Headline (V2 Metadata − V1) | Notes |
|---|---|---|---|
| A3, 2026-11-10/11 | 4,000 people, 400 test readers | pool −0.064 ± 0.017, R@20 −0.005 ± 0.005, non-English +0.035, open languages +0.155 | First Five utility −0.028 |
| A3, 2026-11-13 / 13b | 480 readers | pool −0.065 ± 0.015; removing `social_candidates` from V1 reproduces it; prototype pool +0.003 ± 0.003 with the whole language gain | films-only world, TV "slice" is films relabelled |
| Replay `--synthetic`, 2026-11-14 | 1,196 accounts | Films pool −0.058 ± 0.013 (all of it via social); TV R@50 −0.058 ± 0.032 | Prototype keeps +0.018 of +0.077 non-English share for sparse readers |
| Benchmark, 2026-11-17 | 300 people | Films R@50 −0.032 [−0.064, −0.003]; TV R@50 −0.208 [−0.276, −0.145] | Verdicts: Films INSUFFICIENT_EVIDENCE, TV KEEP_V1; hybrid not replayed |

### 2.3 Demonstrated vs assumed

- **Demonstrated (tests, structural):** V2 Metadata never reads the follow graph; already-seen
  titles never reach a wall; the switch defaults off and falls back to V1; the hybrid's privacy
  rules (public accounts only, two-person minimum, no person returned).
- **Demonstrated, synthetic only:** V2 Metadata raises non-English share and language coverage;
  removing the follow-graph source explains V2's Films pool-recall loss.
- **Assumptions, not evidence:** that real follows carry taste signal (the world makes 30% of
  follows same-cluster); that TMDB show lists are thin (the world gives a show about five
  similar shows; the real TMDB answer is 20); that the catalogue has titles in every language
  (R3 says it does not for Indian languages); every V2 constant.
- **R2 is weaker than it reads.** It ran before the 2026-11-14 fix to the social mirror, which had
  given each wall its own 40 followee titles and counted seasons separately. That inflated V1's
  social source on both walls [synthetic, prior: Films V1 via-social 0.080 → 0.070, TV V1 pool
  0.342 → 0.216 after the fix], so R2's Films −0.136 likely overstates the shipped gap, and its
  TV +0.106 was measured against an inflated V1.

## 3. What this work added to the harness

`eval/rec-benchmark` (#316) is the harness of record. Changes, all in `eval/`:

1. **V2 Hybrid is replayed**, not just counted. `collaborativeMirror` (`eval/rec-v2-replay/replay.ts`)
   mirrors `_refresh_taste_neighbours` (40 probe titles, 50 raters each, 200 shortlisted,
   WS5 Match, weight `(match − 55)/45 × n/(n + 10)`, best 40) and `collaborative_candidates`
   (one opinion per neighbour per series unit, whole-show ranking over a season, two endorsers,
   disputed rows as evidence, the reader's met titles excluded), **from the reader's training
   rankings only**. Scored with the shipped `v2_hybrid` weights.
2. **Every engine is scored with its own shipped weights** (`scoringEngine`). Before, every V2
   variant was scored as `v2_metadata`: harmless for the prototype (same weights), wrong for the
   hybrid.
3. **Cold-start suites C5 and C10:** a person exactly as they were after their first 5 (or 10)
   rankings in time order, in any pool, no logged titles; tested on every later unit of the
   medium. Descriptive; no verdict is pre-registered for them.
4. **New metrics:** already-met share of the wall, languages on the wall, pool recall via the
   collaborative source, neighbours and endorsed rows per person; paired differences against
   V2 Metadata for the two variants; a `with_collab_rows` segment.
5. **The hybrid's own whole-engine verdict** under the pre-registered rule, with collaborative
   coverage reported beside it: the share of final-half (person, split) pairs with an endorsed
   row. Below 50% no difference, either way, is attributed to the collaborative source. The
   original verdict (V2 Metadata, V2 Metadata + Social) is unchanged.
7. **After review** (§11): other people's ladders are renumbered when Suite B freezes them at a
   cutoff, and the collaborative segment is defined over every evaluated split
   (`with_collab_rows` in all, `no_collab_rows` in none, `mixed_collab_rows` otherwise).
6. **Scale benchmark:** follows loaded for the measured readers, so V1's `social_candidates` is
   timed beside the V2 calls, with its plan under `--plans`.

**Reproduction first.** The unchanged harness on `origin/main` `97db6883` reproduced the
2026-11-17 reference exactly (Films V2 Metadata − V1 R@50 −0.032 [−0.064, −0.003], pairwise
+0.019 [−0.010, 0.047]; prototype R@50 +0.012), and the extended harness reproduces the same
final-half figures for the three engines it already had.

**Ranking semantics (three pools since 2026-11-12).** The benchmark matches them: Movies, whole
TV shows and TV seasons are separate ladders; a TV unit is the series (explicit show ranking,
else the mean of its seasons); hiding a series hides its show, every season and their logged
rows; the TV wall excludes a show with any met season. Two gaps elsewhere, reported, not fixed:
the older `rec-v2-replay` holdout treats a Loved **season** as a liked show even when the show is
explicitly ranked lower (R2 used it), and `eval/predicted-score` (a different feature) refuses any
export that contains a `tv_shows` row (`snapshot.ts` `bad category`), so it cannot run on today's
data.

## 4. Results [synthetic]

Reference world: 300 people, 1,500 titles (`run.mjs --synthetic`). A small world of 45 people,
the size of R2's cohort, shows what the same rule can see at bingd's size. Already-met titles on
any wall: **0.000 for every engine, suite and segment** (including TV shows met by a season).

### 4.1 Films, Suite A (stratified holdout), all 281 people

| Δ vs V1 | M1 pairwise (taste) | R@20 | R@50 | Pool recall | Non-English share | Own top-3 languages on wall | Own top-3 decades | Genre entropy | Repeat across launches |
|---|---|---|---|---|---|---|---|---|---|
| V1 (level) | 0.551 | 0.096 | 0.207 | 0.366 | 0.032 | 0.627 | 0.956 | 3.25 | 0.390 |
| V2 Metadata | +0.009 [−0.010, 0.028] | −0.012 [−0.025, −0.001] | **−0.032 [−0.054, −0.012]** | **−0.111 [−0.136, −0.088]** | +0.047 [0.041, 0.053] | +0.048 | −0.016 | +0.030 | +0.066 |
| V2 Metadata + Social | +0.009 [−0.010, 0.028] | −0.002 [−0.010, 0.006] | +0.002 [−0.009, 0.013] | +0.013 [0.008, 0.019] | +0.027 [0.022, 0.031] | +0.042 | −0.004 | +0.021 | +0.012 |
| V2 Hybrid | +0.023 [0.003, 0.042] | −0.005 [−0.018, 0.008] | −0.014 [−0.038, 0.009] | −0.022 [−0.050, 0.007] | +0.042 [0.037, 0.048] | +0.047 | −0.015 | +0.043 | +0.061 |

Pool recall by source (levels): V1 = anchors 0.178 + social 0.154 + trending 0.035. V2 Metadata
= anchors 0.178 + trending 0.061 + catalogue 0.016. The anchors' contribution is identical;
**the whole gap is the follow-graph source**, partly refilled by trending and the catalogue.
Hybrid: collaborative 0.113 replaces most of social. Languages on wall: V1 1.39, Metadata 1.91,
+ Social 1.72, Hybrid 1.86.

Final-half verdicts (pre-registered): Films **INSUFFICIENT_EVIDENCE** (Suites A and B). The
hybrid's whole-engine call is **INSUFFICIENT_EVIDENCE** in both (A: pairwise +0.033 [0.003, 0.062]
but R@50 −0.009 [−0.045, 0.023] fails non-inferiority; B: R@50 −0.019 [−0.051, 0.014], and its
collaborative source fires in only 34/145 person-splits). For Films readers with an endorsed row
in every split (160 of 281), the hybrid's R@50 over V1 is +0.026 [0.006, 0.047]; for those with
none (90), it is V2 Metadata exactly, −0.071 [−0.127, −0.014].

### 4.2 TV, Suite A, 179 people (series units)

| Δ vs V1 | M1 pairwise | R@20 | R@50 | Pool recall | Non-English share | Repeat |
|---|---|---|---|---|---|---|
| V1 (level) | 0.560 | 0.396 | 0.488 | 0.488 | 0.152 | 0.724 |
| V2 Metadata (= + Social on TV) | +0.018 [−0.016, 0.051] | −0.186 | **−0.204 [−0.251, −0.158]** | −0.203 | +0.083 | −0.227 |
| V2 Hybrid | +0.061 [0.020, 0.099] | −0.021 [−0.060, 0.018] | +0.089 [0.041, 0.140] | +0.101 | +0.018 | −0.248 |

V1's TV pool recall is 0.132 anchors + **0.318 social** + 0.038 trending. In this world a show's
TMDB list holds about five shows, so the follow graph is most of V1's TV retrieval; real TMDB show
lists hold 20. **This is the assumption that decides the synthetic TV result**, and R2 points the
other way (+0.106). Whole-show and season rankers move alike (R@50 −0.168 and −0.222 under V2
Metadata; +0.109 and +0.078 under the hybrid). Verdict: TV **KEEP_V1** (A and B). Hybrid:
INSUFFICIENT_EVIDENCE in A (final half R@50 +0.038 [−0.030, 0.100]), **KEEP_V1** in B (R@50
−0.204 [−0.365, −0.052], collaborative source in 14/42 person-splits).

### 4.3 Sparse, established and non-English readers (Films, Suite A)

| Δ vs V1, R@50 | sparse ≤ 10 (34) | medium 11–30 (154) | heavy > 30 (93) | non-English taste (39) |
|---|---|---|---|---|
| V2 Metadata | **−0.131 [−0.254, −0.015]** | −0.030 [−0.057, −0.002] | −0.003 [−0.016, 0.008] | +0.040 [−0.007, 0.090] |
| V2 Metadata + Social | +0.015 [−0.026, 0.056] | +0.002 [−0.014, 0.020] | −0.004 [−0.016, 0.007] | +0.033 [0.001, 0.073] |
| V2 Hybrid | −0.131 (= Metadata: no neighbours) | −0.019 [−0.050, 0.014] | +0.031 [0.013, 0.050] | +0.041 [−0.005, 0.091] |

| Δ vs V1, non-English share | sparse | medium | heavy | non-English taste |
|---|---|---|---|---|
| V2 Metadata | +0.076 | +0.049 | +0.033 | +0.094 |
| V2 Metadata + Social | +0.018 | +0.025 | +0.033 | +0.062 |

**Social candidates do cost sparse readers most of the multilingual gain** (+0.076 → +0.018,
paired −0.058 [−0.069, −0.048] against V2 Metadata), and heavy readers nothing. That is the
trade: for a sparse reader the prototype buys back V1's recall (+0.146 R@50 over V2 Metadata) by
giving back three quarters of the language gain. Repetition across launches for sparse readers:
V2 Metadata +0.250 over V1 (a smaller pool repeats), the prototype −0.016.

### 4.4 Cold start: exactly 5 rankings (Suite C5)

45-person world (C5, Films 42 people, TV 35):

| Δ vs V1 | R@20 | R@50 | Pool recall | Non-English share | Languages on wall |
|---|---|---|---|---|---|
| Films, V1 (level) | 0.124 | 0.205 | 0.212 | 0.054 | 1.79 |
| Films, V2 Metadata | −0.017 [−0.054, 0.015] | **−0.077 [−0.119, −0.044]** | −0.082 | +0.085 | 2.99 |
| Films, V2 Metadata + Social | +0.005 [−0.009, 0.019] | −0.001 [−0.002, 0.000] | +0.002 | +0.013 | 1.95 |
| Films, V2 Hybrid | identical to V2 Metadata | | | | |
| TV, V2 Metadata (= + Social, = Hybrid) | −0.292 | −0.298 [−0.425, −0.183] | −0.298 | +0.088 | |

At 5 rankings V1's Films pool recall is 0.136 social of 0.212: a new reader's recall is mostly
their followees. **V2 Hybrid found no neighbour for any 5-ranking person in these synthetic
worlds.** That is observed, not structural (corrected after review): a neighbour needs at least
five shared series units and a Match above 55, so all five of the reader's rankings must be shared
with the same public account. Five identical judgements give a Match of 75, and a test now shows a
5-ranking reader with two such neighbours getting an endorsed title. It is rare, not impossible;
a real cohort whose new readers rank the same popular First Five titles could hit it more often.
The 300-person results are in §4.6.

### 4.5 Collaborative neighbour availability

| World | People with ≥ 2 neighbours (full histories) | Final-half person-splits with an endorsed row, Films / TV | Collaborative source measurable? | Hybrid whole-engine call, Films / TV |
|---|---|---|---|---|
| 300 people, Suite A | 202/300 | 440/715 (62%), 382/490 (78%) | yes / yes | INSUFFICIENT_EVIDENCE / INSUFFICIENT_EVIDENCE |
| 300 people, Suite B (others frozen at the cutoff) | | 34/145, 14/42 | no / no | INSUFFICIENT_EVIDENCE / KEEP_V1 |
| 45 people (R2's size), Suite A | 17/45 | 32/105, 35/80 | no / no | INSUFFICIENT_EVIDENCE / KEEP_V1 |
| 45 people, Suite B | | 2/20, 1/10 | no / no | KEEP_V1 / too few people |
| 45 and 300 people, 5 rankings (C5) | | 0/20, 0/19 and 0/143, 0/119 (observed) | no | descriptive only |

Mean neighbours kept per person, Suite A: 9.8 (Films) and 15.8 (TV) at 300 people; 1.8 and 2.5
at 45. In the 45-person world the hybrid's Films R@50 over V2 Metadata is +0.008 [−0.005, 0.023],
and over V1 −0.028 [−0.073, 0.009]. **At bingd's size the hybrid is V2 Metadata for most readers.**

### 4.6 C5 and C10 at 300 people

The reference world confirms the 45-person picture with tighter intervals.

| Δ vs V1 | Films C5 (285) R@50 | Films C5 non-English | Films C10 (252) R@50 | TV C5 (221) R@50 | TV C10 (176) R@50 |
|---|---|---|---|---|---|
| V1 (level) | 0.215 | 0.041 | 0.218 | 0.390 | 0.435 |
| V2 Metadata | **−0.092 [−0.113, −0.072]** | +0.091 | −0.063 [−0.085, −0.041] | −0.227 [−0.268, −0.187] | −0.243 [−0.297, −0.185] |
| V2 Metadata + Social | +0.005 [0.001, 0.009] | +0.019 | +0.005 [−0.005, 0.017] | = V2 Metadata | = V2 Metadata |
| V2 Hybrid | = V2 Metadata (0 neighbours) | +0.091 | −0.062 (0.28 neighbours per person) | = V2 Metadata | −0.238 |

At 5 rankings V1's Films pool recall is 0.153 social of 0.233; repetition across launches rises
+0.244 under V2 Metadata and falls −0.029 under the prototype. Taste ordering (Mode 1) does not
separate any engine at 5 or 10 rankings (all within ±0.016).

## 5. Performance and cost [local-bench]

PostgreSQL 17.10, 4 CPUs, stock memory. **The machine was shared** with two benchmark processes
and another worker, so read differences under ~30% as noise. 28 measured readers per tier; each
follows 50 ranking accounts.

| Call, p50 / p95 ms | 2,000 accounts (29k rankings) | 100,000 accounts (1.5M rankings) | Used by |
|---|---|---|---|
| `recommendation_engine()` | 0.3 / 2.6 | 0.3 / 0.8 | all V2 (V1 clients on V2 code also ask) |
| `social_candidates(40)` | 13.6 / 19.0 | **294 / 451** | V1, + Social (Films) |
| `catalogue_candidates` | 3.8 / 9.0 | 3.5 / 6.0 | all V2 |
| `collaborative_candidates('movie')`, cold / warm | 91 / 34 | 263 / 97 | Hybrid |
| `collaborative_candidates('series')`, cold / warm | 116 / 50 | 337 / 154 | Hybrid |

Per wall, the server work is: V1 one `social_candidates`; V2 Metadata one `catalogue_candidates`;
the prototype both on Films; the hybrid one catalogue and one collaborative read (cold once per 24
hours, 3 after an empty pass). Client scoring per wall [synthetic, same shared machine]: V1 1.7 ms,
V2 variants 9.2–9.7 ms (prior idle-machine figures: 1.0 and 3.8 ms).

**A V1 query-plan defect, reported, not fixed.** At 100k accounts `social_candidates` costs more
than a warm hybrid read. Its plan (`--plans`) checks "the caller has not ranked it" with an index
scan of `rankings_by_media_user` on `media_item_id` alone, filtering `user_id = me.id` afterwards:
598,766 rows read and discarded for 202 candidates in one call. The caller id comes from a CTE
(`me`), so it is not used as an index condition. Cost grows with how popular followees' loves
are. It is V1's (`20260828000500`), so it affects V1 and the prototype. Trivial at today's ~46
rankers; worth a one-line rewrite (`auth.uid()` in the anti-join) before any scale.

## 6. Trade-offs, answered

1. **What caused the V2 Metadata Films recall regression?** Removing `social_candidates`.
   [synthetic] By source, the anchors' contribution is identical (0.178 both) and the gap is
   V1's 0.154 via social, partly refilled (+0.026 trending, +0.016 catalogue). [calc, structural]
   For any reader with at most 8 Liked films (`ANCHOR_BUDGET`), both engines take every liked
   film as an anchor, scoring never removes a candidate, and the catalogue fill only adds; so V2
   Metadata's pool is V1's minus the titles only followees supplied. R2's −0.136 is consistent
   with that but was never attributed by source on real data, and was measured with the pre-fix
   mirror that inflated V1's social source.
2. **Does Metadata + Social restore useful candidates?** On Films it restores the pool in every
   synthetic suite (pool recall at or above V1's). On R@50 it is **non-inferior** (interval above
   −0.02) in Suite A (+0.002 [−0.009, 0.013]), C5 (+0.005 [0.001, 0.009]) and C10 (+0.005
   [−0.005, 0.017]) at 300 people, but **inconclusive** in Suite B (final half −0.006
   [−0.026, 0.013]) and in the 45-person world (−0.007 [−0.022, 0.006]): an interval that contains
   zero is not equivalence. Over V2 Metadata it adds +0.146 R@50 for sparse readers. It keeps V2's taste ordering (Mode 1 identical).
   It does nothing for TV, by design.
3. **Do social candidates hurt multilingual discovery for sparse users?** Yes [synthetic]: they
   keep about a quarter of V2 Metadata's non-English gain for sparse readers (+0.018 of +0.076)
   and all of it for heavy readers. At 5 rankings +0.013 of +0.085. A smaller social quota on the
   prototype is the lever; not built (it would be a weight change).
4. **Does TV genuinely improve?** Unknown. R2's +0.106 is the only real signal, on a small
   unreported TV subset, without an interval, against an inflated V1. Synthetic TV is strongly
   negative (−0.204), but it rests on the thin-show-list assumption that real TMDB data does not
   share. Neither is credible enough to decide TV.
5. **Does Hybrid help at bingd's size?** It cannot be evaluated credibly. In a dense 300-person
   world it is the strongest TV engine (+0.089 R@50) and helps heavy Films readers (+0.031); at 45
   people its collaborative source fires too rarely to attribute anything to it; at 5 rankings no
   synthetic reader had a neighbour. No gain is claimed.
6. **Diversity vs relevance.** V2 Metadata's genre and language gains come with lower recall for
   sparse readers and more repetition across launches (+0.066 Films, +0.250 sparse); the prototype
   trades some diversity back for relevance. Nothing here optimises diversity.

## 7. Decision

**Recommended candidate for a future limited pilot: V2 Metadata + Social**, allowlist-only, and
only after the real-history run in §8 passes. **It is a hypothesis to test, not a proven
winner.** It is the only V2 variant that restores V1's Films pool in every synthetic suite and is
non-inferior on R@50 in Suites A, C5 and C10 (Suite B and the 45-person world are inconclusive,
§6.2); it keeps V2's taste
ordering and part of its language gain, the server already confines it to the allowlist, and its
TV wall (V2 Metadata) is the one place real data (R2) points to a gain. **Nothing should be
activated now:** no V2 variant has real evidence that clears the pre-registered rule, and R1 says
V1's own content ordering is at chance, so the bigger lever may be candidate generation (TV
pools, Indian-language catalogue), not engine choice. V2 Hybrid stays dormant.

## 8. The real-history run still needed (read-only, pending founder approval)

Run by the founder or the coordinator, never from an agent session:

1. Issue a temporary **read-only** database role (never a service key).
2. `begin transaction read only; \i eval/rec-v2-replay/export.sql; rollback;` and save the single
   `replay` value to a file **outside the repository**. `export.test.mjs` pins the export to random
   per-run keys, media ids and days; no names, emails, notes or account ids.
3. `REC_BENCHMARK_EXPORT=/outside/export.json REC_BENCHMARK_OUT=/outside/ REC_BENCHMARK_SUITES=A,B,C5,C10 node eval/rec-benchmark/run.mjs`
4. Share only the printed aggregate tables. Delete the export; revoke the role.

What it would add: Films pool recall by source on real follows (is the gap the follow graph?);
the prototype's real Films recall and language mix; TV with intervals on the fixed mirror and the
series-unit target; the 5-ranking slice; real neighbour coverage (whether the hybrid is
measurable at all). With ~46 rankers, expect the final half to be near the 15-person minimum:
TV will probably read INSUFFICIENT_EVIDENCE; read directions and by-source tables, not verdicts.

## 9. Remaining technical blockers

1. No real-history evidence on current code (§8).
2. The synthetic world cannot speak to TV: its show lists are thin by construction.
3. Indian-language candidates do not exist upstream (R3): neither TMDB lists nor the catalogue,
   so no engine can surface them; V2's language gain is overstated for those readers.
4. The prototype's sparse-reader language dilution has no lever without a quota change.
5. Hybrid: per-reader cache for the warm read, a neighbour reputation gate, and enough readers.
6. V1 `social_candidates` plan defect at scale (§5).
7. Product decision: whether "following adds candidates but never score" fits the spec.
8. The export ignores TMDB list expiry, so offline V1 pools are somewhat optimistic (R3: 71 of
   940 English film lists unexpired on 2026-11-19).

## 10. Pilot and rollback (for founder review only; nothing here is enabled)

- **Cohort:** founder plus 2–3 QA accounts named by the founder. `v2_engine "v2_metadata"`,
  `v2_rollout_percent 0`, `v2_allowlist [those ids]`, `v2_allowlist_engine "v2_metadata_social"`.
  No reader outside the allowlist changes engine at 0%.
- **Two weeks**, side by side: each pilot account marks 10 V1 and 10 pilot walls per medium,
  title by title, *would watch / would not*; plus `for_you_slate_shown` (`engine`,
  `wall_languages`), Watchlist saves and rank-from-For-You by engine.
- **Stop if:** RPC error rate above V1's, a wall with an already-seen title, or pilot walls judged
  worse on Films by a majority of the accounts.
- **Rollback:** one `app_config` write, `v2_engine "v1"`; every client is back on V1 within one
  30-minute engine re-read (`use-engine.ts`), no release needed.
- Any percentage rollout is a separate founder decision, after the real-history run.

## 11. Independent review (Codex, PR #392)

Review of `e543d867`. Five findings, all accepted; the affected suites were re-run.

| # | Finding | Resolution |
|---|---|---|
| P1 | Suite B froze other people at the cutoff but kept their old ladder positions, so `scoresOf` scored survivors against band sizes they no longer had, corrupting the hybrid's Match and opinions | `frozenWorld` renumbers each account's surviving ladders per pool; test with a ladder ranked bottom-up. Suite B re-run: hybrid Films R@50 −0.020 → −0.019, coverage 32 → 34/145; V1, V2 Metadata and the prototype are unchanged (they never read others' positions) |
| P2 | Low collaborative coverage suppressed the hybrid's whole-engine verdict, hiding evidence of harm | The whole-engine call is always reported; coverage is a separate statement about attribution. Suite B TV and the 45-person world now read KEEP_V1 for the hybrid |
| P2 | The collaborative segment and coverage came from the first split only | Coverage counts every (person, split); segments are all / none / mixed over the evaluated splits |
| P2 | "Zero neighbours at 5 rankings, by construction" is false (five identical judgements give a Match of 75) | Restated as observed in these worlds; a positive five-ranking test added |
| P2 | Suite B Films interval for the prototype (−0.006 [−0.026, 0.013]) does not establish non-inferiority | §6.2 and §7 now say non-inferior in A, C5 and C10, inconclusive in B and at 45 people; the prototype is a hypothesis to test |

Also aligned with the SQL: the hybrid mirror caps each probe title's rater sample before dropping
the reader (no measurable change).
