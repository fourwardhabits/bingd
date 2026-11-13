# Recommendation Engine V2 — offline evaluation (A3)

> **SYNTHETIC DATA.** Everything measured here comes from a generated world. It shows how the
> three engines behave under an explicit model of readers and titles. It is **not** evidence
> that any engine is better for real bingd readers, and nothing below should be quoted as a
> real-world improvement.

Founder spec 2026-11-10, §4 A3. Code: `src/features/recommendations/evaluation/` and
`scripts/rec-eval/collaborative.mjs`. Results of the run recorded here:
[`recommendations-v2-evaluation-results-2026-11-11.md`](./recommendations-v2-evaluation-results-2026-11-11.md)
(the engines as fixed after the 2026-11-11 independent review; the 2026-11-10 run on the
first submission is kept beside it). Server capacity on real PostgreSQL is a separate
document: [`recommendations-v2-scale-benchmark.md`](./recommendations-v2-scale-benchmark.md).

## 1. Why synthetic

bingd has no offline export of real rankings that an agent may use, and this work may not
touch a live database. Real held-out evaluation needs a consented, access-controlled export
(or an in-database evaluation job) that does not exist yet; §6 lists what it should measure.
Until then, this harness answers a narrower question: *given a model of taste in which the
spec's concerns are real (non-English readers, era preferences, sparse overlap, disliked
genres, popularity skew), do the engines do what they were built to do, and what do they
cost?*

## 2. What runs

```bash
RUN_REC_EVAL=1 npx jest src/features/recommendations/evaluation/evaluation.test.ts --testTimeout=3600000
```

About 9 minutes on 4 cores; writes `report.json` and `report.md` to `$REC_EVAL_OUT`
(default the OS temp directory). It is deliberately not an `npm run` alias: `package.json`
`scripts` is an input to the Expo runtime fingerprint, so a new key would strand the live
binaries' over-the-air updates (`config/push.cjs`). The smoke version (a small
world, four assertions) runs in the normal `jest` suite.

- **The world** (`world.ts`, version `rec-eval-world-2026-11-10.1`, seed 20261110): 4,000
  titles and 4,000 people. Titles have a language (English half, then 13 others down to 1%),
  a decade, genres and latent factors; popularity is biased towards English, recent and good
  titles, like TMDB's. People belong to six archetypes (mainstream, polyglot, minority-
  language, non-English, classic, niche); exposure is popularity-driven, so what people watch
  is not the same as what they like. Ground truth is a hidden utility; people rank 65% of what
  they watched into loved/fine/not-for-me by that utility, bucket 15% and merely log 20%. The
  follow graph is mostly random (30% same-cluster).
- **Test readers** (`chooseTestReaders`): 400, stratified — mainstream 100, polyglot 60,
  minority 80, non-English 40, classic 40, niche 40, cold start 40. A quarter of each reader's
  ranked titles (at least three) is held out of every input. Cold-start readers keep five.
- **The pipeline** (`pipeline.ts`) is the For You hook's query function with the shipping
  modules (`selectAnchors`, `candidateIdsFrom`, `coverageFill`, `scoreSlate`, `drawSlate`),
  with the network replaced by mirrors of the RPCs over the world.
- **The collaborative source is the real SQL**: `collaborative.mjs` loads the world into
  PGlite with every migration, sets `v2_hybrid`, and calls `collaborative_candidates` as each
  test reader. Its rows feed the hybrid variants.
- **Variants** (`variants.ts`, config `rec-eval-config-2026-11-10.1`): the three engines;
  six ablations; seven weight sweeps. Every wall is drawn at three launch seeds.
- **Metrics** (`evaluate.ts`): held-out recall@20 and nDCG@20 on the first wall; pool recall
  (held-out titles anywhere in the candidate pool); oracle utility percentile of the wall;
  non-English share; share of a reader's open languages served; era share for era readers;
  disliked-genre share; distinct genres; popularity percentile; client scoring time. Means
  with a 95% normal interval, and paired differences against V1 and against V2 metadata.

No weight was tuned on these results. The sweeps are reported, not acted on.

## 3. Results (synthetic)

Paired differences against V1, all 400 readers (mean ± 95% interval):

| | Held-out recall@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share | Popularity pct |
|---|---|---|---|---|---|---|---|
| V2 metadata (A1) | −0.005 ± 0.005 | **−0.064 ± 0.017** | −0.004 ± 0.003 | **+0.035 ± 0.006** | **+0.155 ± 0.036** | +0.009 ± 0.006 | +0.002 ± 0.003 |
| V2 hybrid (A2) | −0.003 ± 0.006 | **−0.045 ± 0.018** | −0.003 ± 0.003 | **+0.035 ± 0.006** | **+0.158 ± 0.037** | +0.009 ± 0.006 | +0.005 ± 0.003 |

(2026-11-11 re-run on the reviewed engines. Within noise of the 2026-11-10 run on the first
submission; no weight was changed between them.)

What the model says, in order of confidence:

1. **Language coverage works as designed.** Non-English share rises for every stratum that
   watches non-English titles (+0.069 polyglot, +0.058 minority, +0.077 non-English readers)
   and the share of a reader's open languages served rises by 0.14–0.20, without lowering the
   wall's oracle utility for those readers (non-English stratum −0.000 ± 0.009, polyglot
   +0.000 ± 0.006). Non-English titles enter the pool *and* reach the wall.
2. **Following has no effect under V2 — by construction here, by test elsewhere.** A
   different random follow graph per reader changed 0/400 walls under V2 hybrid and 115/400
   under V1. The 0 is structural, not a measurement: the pipeline gives V2 no social source
   and `collaborative.mjs` loads no follows, so nothing could change. What shows it of the
   shipped code is the DB test (a followed neighbour weighs exactly what an unfollowed one
   does, `taste-neighbours.test.mjs`) and the hook test (`social_candidates` is never called
   under V2, `for-you-engine-v2.test.tsx`). The 115/400 is the real finding: under V1,
   following moves the wall.
3. **It is not free.** Held-out recall is flat to slightly lower and pool recall is clearly
   lower. In this world V1's follow-graph candidates carry some signal (30% of follows are
   same-cluster), and V2 deliberately stops using following; catalogue and language anchors
   take those pool slots. Whether real follows carry more or less taste signal than this is
   unknown.
4. **Cold start is worse under V2** (oracle utility −0.028 ± 0.012, popularity +0.029): with
   five rankings the behavioural profile is mostly prior, and the catalogue fill leans
   popular.
5. **The collaborative source helps the pool modestly** (+0.019 ± 0.007 pool recall over V2
   metadata) and reached 139/400 readers (mean 3.4 neighbours): overlap in this world is
   sparse, as it will be in early real data. The scoring term alone moves little at the
   shipped weight; at 0.25–0.35 held-out recall and utility rise slightly while popularity
   rises and language coverage dips. Not acted on (no tuning to synthetic data).
6. **Ablations: in this world the language gain comes from the scorer, not from candidate
   generation.** Removing the language anchors changes open languages served by only −0.011,
   and removing the catalogue fill by −0.002 (pool recall −0.004), against a total gain of
   +0.155. The synthetic world's similar-title lists already carry plenty of each reader's
   languages, so there is little for generation to add. **This evaluation therefore does not
   show the spec's candidate-generation requirement working.** What shows it is narrower: the
   hook test, where a reader whose only evidence is Japanese gets Japanese titles into the pool
   and onto the wall only through the catalogue fill. Whether real TMDB lists are as
   accommodating as the world's is a staging question (`for_you_slate_shown.wall_languages`
   by engine). The era term moves era share and little else. Negative evidence still has no measurable effect on disliked-genre share in this
   world, even after the review fix that lets a disliked genre lower multi-genre titles: the
   world's disliked genres are rare on the walls under every engine (≈5.5%), so there is
   little for the term to remove. That is a limit of the world, not evidence the term works.
7. **Cost:** client scoring 1.0 ms (V1), 3.8 ms (V2 metadata), 3.9 ms (V2 hybrid) per slate
   on an otherwise idle machine (2026-11-10; the 2026-11-11 re-run shared the machine with the
   scale benchmark and reads 1.6 / 5.8 / 5.5 ms). Server cost on real PostgreSQL, up to 1M
   synthetic accounts, is in
   [`recommendations-v2-scale-benchmark.md`](./recommendations-v2-scale-benchmark.md).

## 4. Rollout readiness

| Engine | Status | Why |
|---|---|---|
| `v1` | Shipping default | Unchanged. |
| `v2_metadata` (A1) | **Candidate for a staged, measured rollout** (allowlist → small percentage), not a default | Does what the spec asked (language and era coverage, following inert) at a cost in pool recall and in cold start that only real telemetry can price. Watch `for_you_slate_shown.wall_languages`, open/add/rank rates by cohort, and readers with fewer than ten rankings. |
| `v2_hybrid` (A2) | **Experimental** (allowlist / dogfood only) | Its benefit depends on real taste overlap, which a synthetic world cannot establish; its constants are unvalidated. Before anything beyond the allowlist it also needs a per-reader cache of the collaborative read (most of its database time at scale, per the scale benchmark) and a reputation gate on neighbours (`recommendations-v2.md` §2.6). |

Neither V2 engine is switched on by anything in these PRs; `recommendations.v2_engine` seeds
`"v1"`.

## 5. Limits of this evaluation

- Every effect depends on the world model. A different language mix, exposure model or
  follow-graph assumption would move the numbers; the direction of findings 1–2 is
  structural, the size of 3–5 is not.
- Held-out titles are titles the reader *ranked*, which over-represents what they were
  exposed to; recall@20 rewards the popular.
- One world and one seed per configuration; intervals are over readers, not worlds.
- PGlite timings are not production timings.

## 6. What a real evaluation needs (not built)

An in-database job, run by the service role on staging or production, that holds out the
latest quarter of each sampled reader's rankings, runs the server half of each engine, and
writes only aggregate metrics (the same columns as §3), never per-reader rows. Plus the
online signals already instrumented: `for_you_slate_shown.engine` and `.wall_languages`, and
the existing open/add/rank events split by engine.
