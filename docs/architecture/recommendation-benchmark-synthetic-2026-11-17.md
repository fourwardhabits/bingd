# Recommendation benchmark: synthetic reference results, 2026-11-17

**Synthetic data only.** These results come from the A3 generator's reference world: 300 people and 1,500 titles,
produced by `node eval/rec-benchmark/run.mjs --synthetic`. They prove the benchmark runs end to end and reads
sensibly. **They say nothing about real bingd users.** Only the real-history run can, and it awaits the founder's
approval.

Values are means over people in the final half, with 95% bootstrap intervals over people. Deltas are paired per person
against V1.

## Verdicts (pre-registered rule, final half)

| Suite | Movies | TV (series units) |
| --- | --- | --- |
| A, stratified holdout | INSUFFICIENT_EVIDENCE (inconclusive) | **KEEP_V1** |
| B, forward replay (partially historical) | INSUFFICIENT_EVIDENCE (inconclusive) | **KEEP_V1** |

## Suite A, final half

| | Movies (143 people) | TV (98 people) |
| --- | --- | --- |
| M1 pairwise, V1 | 0.543 [0.504, 0.581] | 0.567 [0.502, 0.634] |
| M1 pairwise, V2 metadata − V1 | +0.019 [−0.010, 0.047] | +0.006 [−0.034, 0.047] |
| M2 Recall@50, V1 | 0.211 [0.169, 0.256] | 0.473 [0.407, 0.541] |
| M2 Recall@50, V2 metadata − V1 | **−0.032 [−0.064, −0.003]** | **−0.208 [−0.276, −0.145]** |
| M2 Recall@50, V2 metadata + social − V1 | +0.012 [−0.002, 0.028] | −0.208 (the prototype uses social on Films only) |
| M2 pool recall, V2 metadata − V1 | −0.108 [−0.143, −0.075] | −0.206 [−0.274, −0.143] |

## Diagnosis on synthetic data

- **Scoring vs. retrieval.** On taste (Mode 1), V2 scores the same held-out titles marginally better than V1 in both
  media, though no interval excludes zero. Its losses are all in **retrieval**: V2 metadata has no follow-graph source,
  and the pool-by-source table shows that source carries a large share of V1's pool recall. That share is 0.154 of 0.366
  on Films, and 0.318 of 0.488 on TV. The prototype's social source restores Films, where it is non-inferior to V1, but
  not TV, where it is not enabled.
- **The popularity baseline** has the highest offline Recall@50. That is exposure bias in the evaluation, not taste:
  people rank what they watched, and in this world they mostly watch what is popular. Its Mode 1 pairwise accuracy is
  not significantly different from V1's (Films −0.019, TV +0.023, both intervals spanning zero). It is a reference, never a verdict candidate.
- **V2 hybrid: NOT REPLAYED.** 202 of 300 synthetic people have two taste neighbours, but the collaborative source is
  not mirrored.
- **Stability across the five split seeds, Suite A:**
  - On Recall@50, V1 is ahead of V2 metadata in all five splits, in both media.
  - On pairwise accuracy, V2 metadata is ahead of V1 in four of five Films splits, and in all five TV splits.
  - Those pairwise margins are small, which is why the paired intervals include zero.

## What this implies for the real run

If real histories behave like this, the question is about **candidate sources, not taste modelling**. Before any V2
trial, V2 would need the social source on TV, or an equivalent. That is a later product decision, not part of this
closeout.
