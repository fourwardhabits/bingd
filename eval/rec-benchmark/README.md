# Recommendation quality benchmark

**Question:** does an engine understand what a person likes? Hide some of a person's real rankings,
recommend from the rest, and check the hidden ones. Repeatable, deterministic, and aggregate-only.

This extends [`../rec-v2-replay`](../rec-v2-replay/README.md). It reuses the replay's export format,
server-source mirrors and the shipped For You wall (`wall()`). It writes nothing anywhere.

```bash
node eval/rec-benchmark/run.mjs --synthetic                       # synthetic reference world (300 people)
REC_BENCHMARK_EXPORT=/outside/repo/export.json node eval/rec-benchmark/run.mjs   # real, see below
npx jest eval/rec-benchmark                                       # the tests (CI)
```

## What is measured

| | Suite A: stratified ladder holdout (primary) | Suite B: forward replay (secondary) |
| --- | --- | --- |
| Hidden | About 20% of a person's units in one medium, stratified across liked / fine / not-for-me; 5 deterministic splits | Everything first ranked after the person's 80% point in time |
| Training | The rest, ladders renumbered through the shipped scoring | Only rankings at or before the cutoff; other people's rankings cut at the cutoff day |
| Leakage-free | Yes, for the person's own data (invariants below) | **Partially historical**: catalogue, TMDB lists and trending are today's |

Each suite runs two modes.

| | Mode 1: common candidates | Mode 2: full For You replay |
| --- | --- | --- |
| What it tests | Taste modelling alone | The product: retrieval, exclusions, scoring, diversity, draw |
| Candidates | Exactly the held-out units, for every engine | The normal sources (anchors' TMDB lists, social, trending, catalogue fill) |
| Primary metric | Pairwise preference accuracy, cross-band and within-band | Recall@50 of held-out liked units |
| Also | NDCG@20 | Recall@20, candidate-pool recall by source, wall NDCG@20 over judged titles |

Mode 1 is a diagnostic. It is never the quality of the product's wall.

**Engines:**
- `popularity`, a baseline;
- `v1`, production;
- `v2_metadata`;
- `v2_metadata_social`, the allowlist prototype;
- **V2 hybrid is NOT MEASURABLE**. It is reported as neighbour coverage, never as better or worse.

**Secondary metrics:**
- held dislikes in the top 20;
- non-English share;
- coverage of the person's own top 3 languages and decades;
- genre entropy and top-genre share;
- pool size;
- repeats across launch seeds;
- latency.

**Not measurable from the export:** franchise duplication. A series cannot duplicate on the TV wall, because the wall's unit is the series.

## Ground truth

- **Buckets keep their meaning:** liked is positive, fine is neutral, and not-for-me is negative.
  **An unranked title is unknown, never a negative.** So missing rankings, unseen titles, unmatched
  imports and watchlist adds are never counted as dislikes. Wall NDCG removes unjudged titles
  (a condensed list).
- **Recall@k is hits divided by all held-out liked units**, the standard definition. The older
  replay divides by `min(liked, k)`, a capacity-normalised figure, so the two do not compare
  directly.
- **Order is the ladder position.** It uses `projectedScore`, the unrounded 0–10 projection, which orders a ladder exactly as its positions do. A within-band pair counts only when the true scores are at least 1.0 apart.
- **Movies and TV are separate experiments.** A movie split hides only movies; a TV split hides only TV. Ladders are never mixed.

### The series-level TV target (evaluation-only, never written to a ladder)

1. An explicit whole-show ranking is the series judgement, scored on the whole-show ladder.
2. Without one, the series is labelled from its ranked seasons: the mean of the seasons' projected
   scores, the bucket that mean falls in (`bucketForScore`), and the number of seasons it rests on
   (`coverage`).
3. With both, the explicit show judgement is the target.
4. One series is one unit. Five seasons are never five successes.
5. **Hiding a series hides everything about it.** That is its whole-show ranking, every season ranking, and the logged rows of either.

## Leakage invariants (checked on every split, every engine)

`assertNoLeak` throws if any of these happen:
- a held-out unit, or any season of a held-out series, is ranked or logged in training;
- a held-out unit is in the "already met" exclusion set;
- an anchor is a held-out unit.

Mode 1 also throws unless its candidates are exactly the held-out units.

Taste, the V2 profile, anchors and the social mirror's own exclusions are all computed from training
alone. Every engine sees the same splits and the same launch seeds.

The tests build deliberately leaky splits and require each one to be caught:
- a season left behind;
- a held title still logged;
- a held anchor;
- every engine in both modes.

## Statistics and the verdict

- **Intervals:** every number is a mean over people with a 95% bootstrap interval over people. Thousands of title pairs are not thousands of independent observations.
- **Paired differences:** comparisons against V1 are per person.
- **Segments:**
  - sparse (≤ 10 training rankings), medium (11–30) and heavy (more than 30);
  - non-English taste (at least 20% non-English);
  - TV whole-show rankers vs season rankers.
- **Dev and final halves:** people are split by a hash of their key. Any tuning reads **dev only**, and the verdict reads **final only**. No weights are tuned in this release.
- **The verdict, pre-registered in `verdictFor`:** one call per medium, from `KEEP_V1`, `TRIAL_V2_METADATA`, `TRIAL_V2_SOCIAL`, `TRIAL_OTHER_TESTED_ENGINE` and `INSUFFICIENT_EVIDENCE`.
  - **Candidates:** V2 Metadata and V2 Metadata + Social. The popularity baseline is a reference, never a candidate: offline recall favours popular titles because people rank what they watched (exposure bias).
  - **Winner:** an engine wins if its paired 95% interval on one primary metric is above zero, and on the other it is above −0.02.
  - **Ruled out:** a candidate whose whole interval on either primary metric is below −0.02 is worse than V1, whatever the other metric says.
  - **INSUFFICIENT_EVIDENCE:** fewer than 15 people in the final half, or either primary estimate missing or resting on fewer than 15 people for any candidate.
  - **KEEP_V1:** no winner, and every candidate is either ruled out or never more than 0.02 better on either primary metric.
  - **Otherwise:** inconclusive, which is also `INSUFFICIENT_EVIDENCE`, and V1 stays.
  - **Fixed before any real data was seen.** The ruled-out clause and the baseline exclusion were added on 2026-11-17, after the synthetic run showed the first rule calling a clear V1 win "inconclusive". No real export has been run.

## Running on real data: AWAITING FOUNDER AUTHORIZATION

Exporting real ranking histories needs the founder's explicit approval.

1. **Credential:** issue a temporary read-only credential, never a service key.
2. **Export:** run `eval/rec-v2-replay/export.sql` inside `begin transaction read only; … rollback;`.
   - The export is pseudonymous: random per-run person keys and day numbers only.
   - It has no names, emails, notes, reviews, watch dates or account ids.
   - `export.test.mjs` holds that contract.
   - **The benchmark adds no export field.**
3. **Save outside the repository**, then run:
   `REC_BENCHMARK_EXPORT=/outside/export.json REC_BENCHMARK_OUT=/outside/ node eval/rec-benchmark/run.mjs`.
   `run.mjs` refuses either path inside the repository.
4. **Share only the printed aggregate tables.** Never print the export into a chat.
5. **Delete the export, and revoke the credential.**

Steps 2–5 as one command, run by hand by whoever holds the approved credential (`BINGD_RO_URL`
is the temporary read-only connection string; `~/private` is any folder outside the repository):

```bash
PGOPTIONS='-c default_transaction_read_only=on' psql "$BINGD_RO_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
  -f eval/rec-v2-replay/export.sql > ~/private/rec-export.json \
&& REC_BENCHMARK_EXPORT=~/private/rec-export.json REC_BENCHMARK_OUT=~/private/ node eval/rec-benchmark/run.mjs; \
rm -f ~/private/rec-export.json
```

The report's **Candidate generation vs ranking** table splits each failure. A held-out liked
title that never reached the pool is a retrieval failure. One that reached the pool but not the
first 50 is a ranking failure. The table covers all titles and non-English titles separately.

A person's ranked-title set can still identify them, so:
- the export is never committed, attached or pasted;
- reports print no key, title or id, and the tests check that.

## Later: external ratings (design only, not built)

An approved personal IMDb or Letterboxd rating file could become a third ground-truth source through
a provider adapter. The adapter would emit `Unit[]` from that person's own ratings, with its own
bucket thresholds and `source: 'imdb' | 'letterboxd'`. It needs consent and accurate title matching.

These rules stand regardless:
- an IMDb community rating is never a person's rating;
- a five-star external rating is not a bingd ladder score;
- external ratings are kept apart from bingd rankings in every report;
- nothing is ever inserted into a production account.

## Before any V2 production cohort (none is authorized)

A winning verdict informs a later release decision. It does not make that decision.

1. **Compatibility:** confirm the migration and runtime compatibility. The V2 config is already inert, with the switch at `v1` and 0%.
2. **Staging:** check performance and privacy there.
3. **Cohort:** use a small allowlist, and keep a V1 comparison population.
4. **Signals to observe:**
   - For You → Watchlist;
   - opens;
   - ranking conversions;
   - subsequent activity.
5. **Guardrails:**
   - RPC error rate;
   - latency;
   - language coverage.
6. **Rollback:** the engine switch back to `v1`.
7. **Approval:** separate founder approval for any production cohort.

If movies and TV favour different engines, routing by medium is a separate, later decision.
