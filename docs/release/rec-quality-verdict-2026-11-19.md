# For You recommendation quality: verdict, 2026-11-19

Lane C (P1) of the launch closeout. This memo makes no change to an engine, a flag, a migration
or production recommendations. **The real-history benchmark was not run.** The founder grant that
`eval/rec-benchmark/README.md` requires is not recorded anywhere (§2). This memo therefore rests on
four things:

- real-data aggregates that earlier runs recorded;
- read-only production catalogue and configuration reads made today, which touch no user table;
- a synthetic benchmark run, which validates the pipeline;
- the code.

## 1. What production runs (verified today, read-only)

| | Production `abheeqyjzekiowkztfxv` | Staging `fjxhcbowoxuzulwirzyr` |
|---|---|---|
| `recommendations.v2_engine` | `"v1"` | `"v1"` |
| `v2_allowlist` / `v2_allowlist_engine` / `v2_rollout_percent` | `[]` / `null` / `0` | `[]` / `null` / `0` |
| V2 migrations `20261122000100`, `…0200` | applied (inert) | applied (inert) |
| `catalogue_candidates`, `collaborative_candidates`, `recommendation_engine` | present; the first two return nothing under `v1` | same |
| Migration head | `20261128000100` (203 files) | `20261129000200` (205 files) |

**Every reader gets V1.** V1 is built on the device (`use-for-you.ts`, `rank.ts`):

- **Candidates:**
  - up to 8 anchors (the reader's Loved titles), each with its TMDB `/recommendations` page 1 (20 ids, the `similar` facet);
  - `social_candidates`, which is followees' Loved titles, capped at 40 rows shared across both media;
  - the trending lists. TV adds the day list only when the reader has no anchor.
- **Score:** anchor 0.60, genre 0.18, language 0.12, popularity 0.10. There is no era term.
- **Selection:** `selection.ts` draws the wall.

On TV, seasons roll up to their show, and one series counts as one unit.

The last recorded production OTA (`ace7c3fa`/`a228c6a5`, `parity-audit-2026-11-15.md`) predates the V2
client code (`bc43b736`). If a later OTA carries that code, it still reads `v1`, so the answer is the same.

## 2. Data used, and the authorization that is missing

- **Not run: the real-history benchmark (`eval/rec-benchmark`).** Three sources say it needs the
  founder's explicit approval:
  - the README ("AWAITING FOUNDER AUTHORIZATION");
  - PR #316;
  - `export.sql` ("never from an agent session").

  No grant is recorded in the repo, in the PR #275, #301 or #316 threads, or in the closeout
  register. Staging was not exported either: `export.sql` forbids agent-session runs whatever the
  project, and staging holds the founder's own accounts.
- **Real aggregates, recorded earlier** (no user data was re-read today):
  - **R1:** 2026-09-13, production, read-only. 31 raters and 596 rankings; only 7 film raters and 3 TV raters had ≥ 10 rankings (`docs/product/recommendations.md` §11.1).
  - **R2:** 2026-11-13, the `rec-v2-replay` export, 44 pseudonymous production accounts on an older base (`recommendations-v2-reconcile-2026-11-13.md` §10). Its authorization is not documented in the repo.
- **Production catalogue and cache, read today.** Aggregate queries over `media_items`, `media_cache`
  (`similar`), `provider_list_cache` and `app_config`. No `rankings`, `profiles`, `follows` or
  `user_media` row was read. I also ran an `EXPLAIN` of `export.sql` against production. It plans
  cleanly, which proves the schema matches, and it reads no rows.
- **Synthetic (S).** `node eval/rec-benchmark/run.mjs --synthetic`: 300 people and 1,500 titles,
  final half of 143 Movies people and 98 TV people. It reproduces the 2026-11-17 reference figures
  exactly. **S is pipeline evidence, not evidence about bingd users.**

## 3. Findings

Values are means with a 95% interval over people. Deltas are paired against V1. "Pool" is the
held-out liked titles that reached the candidate pool. "R@50" is those in the first 50.

| | Movies | TV (series) |
|---|---|---|
| **Taste ranking, V1** | R1: pairwise accuracy **0.444**, *below chance*, 7 raters / 1,319 pairs. S: 0.543 [0.504, 0.581] | R1: 3 raters, not interpretable. S: 0.567 [0.502, 0.634] |
| V2 metadata − V1, taste (S, Mode 1) | +0.019 [−0.010, +0.047] | +0.006 [−0.034, +0.047] |
| **Retrieval, V1** | R1: 18% of held-out loved films in the pool. S: pool 0.366, R@50 0.207 | S: pool 0.488 = R@50 0.488. The pool (~28 titles) is smaller than 50, so every TV miss is a retrieval miss |
| V2 metadata − V1, product | R2: **pool −0.136**. S: R@50 −0.032 [−0.064, −0.003], pool −0.108 | R2: **R@50 +0.106**. S: R@50 **−0.208** [−0.276, −0.145] |
| V2 metadata + social − V1 (S) | R@50 +0.012 [−0.002, +0.028], pool +0.016 | identical to V2 metadata (social is Films-only) |
| Non-English held-out liked titles, V1 → V2 metadata (S) | pool 0.16 → 0.26, R@50 0.08 → 0.15 | pool 0.15 → 0.30 |
| Pre-registered verdict (S only) | INSUFFICIENT_EVIDENCE | KEEP_V1 |
| V2 hybrid | NOT MEASURABLE. R2 is too small for neighbours, and S does not replay it | same |

**Candidate generation vs ranking.**

- **Language is a candidate-generation failure, and V2 does not fix it for Indian languages.**
  - **TMDB lists rarely stay in-language.** For a Telugu anchor, TMDB `/recommendations` returns 0.4 Telugu titles out of 20 (2%; 7 lists). Same-language shares:

    | Anchor language | Lists | Same-language share |
    |---|---|---|
    | Tamil | 3 | 5% |
    | Hindi | 8 | 9% |
    | Korean films | 18 | 17% |
    | Japanese films | 19 | 69% |
    | Japanese TV | 22 | 82% |

  - **The catalogue is thin.** It holds **35 Telugu film tiles** in all, 13 per recent decade, against 12,341 English ones. V2's `catalogue_candidates` draws only from that catalogue, so a Telugu reader's fill is mostly titles they have already met.
  - **Trending is mostly English:** 17 of 19 and 17 of 20 films; 10–12 of 20 shows.

  V1's language weight (0.12) can only reorder what reaches the pool. Japanese is retrievable, and
  Telugu, Tamil and Hindi are not. In S, V2 roughly doubles non-English pool recall, but S has a
  full catalogue in every language, and production does not.
- **TV is a candidate-generation failure.** The V1 TV pool is small, and in S two-thirds of its
  retrieval comes from the follow graph (0.318 of 0.488). Dropping that source (V2) costs 0.21
  R@50 in S. R2 points the other way (+0.106), on 44 accounts and an older base. **Whether V2 is
  better or worse on TV is unresolved.**
- **Films lose to both failures.** In S, 43% of the in-pool liked films miss the first 50: a
  ranking failure. R1's real data is worse:
  - loved films were *less* likely than not-loved ones to be on an anchor's TMDB list (15% vs 33%, lift 0.46);
  - yet the anchor term carries 0.60 of the score.

  TMDB lists predict what someone will watch, not what they will love.
- **Era:** R1 found that a decade term *lowered* film ordering, by −0.033 to −0.039 (7 raters, the
  intervals cross 0). V2's era term (0.07) is unproven on real data. In S, V2 matches V1 on decade
  coverage (0.94–0.98).
- **Generic and repeated items:**
  - the 50 most-recurrent titles across 981 film lists fill 6.9% of all slots, and all 50 are English;
  - repeats across launches in S: Films 0.39 (V1) vs 0.46 (V2 metadata); TV 0.72 (V1) vs 0.50 (V2 metadata);
  - R1 found First Five walls pool-limited (~85 eligible titles).
- **Sparse and cold start:** in S, V2 metadata hurts sparse Films readers (R@50 −0.144
  [−0.385, +0.046], n = 14), and V2 metadata + social recovers it. A reader with nothing Loved gets a
  popularity wall under every engine.
- **Whole-show vs season rankers:** no differential. In S both segments lose about 0.19–0.22 R@50
  under V2 on TV. V1's series roll-up treats them alike (#275 §3 fixed V2's gaps).
- **Cache freshness:** only 71 of 940 English film lists and 23 of 72 English TV lists are
  unexpired today. Anchor selection prefers cached lists and allows ≤ 6 provider fills a slate, so
  most anchors depend on a fill at slate time. The benchmark export ignores expiry, so it
  overstates V1's pool somewhat.

## 4. Verdict

- **Production runs V1 for everyone, and it should stay V1.**
  - There is no evidence for any V2 variant on real readers that clears the pre-registered rule.
  - R2's two real signals conflict: Films is worse under V2, and TV is better.
- **The main quality problem is candidate generation, not the choice of engine.**
  - Readers of Indian languages cannot get in-language picks from either V1 or V2: neither TMDB's lists nor bingd's catalogue contain those titles.
  - TV pools are too small to rank.
- **Ranking is the second problem.** Real data (R1, low-N) puts V1's content ordering at or below
  chance among watched films, and the anchor term does most of the work.
- **History is too thin to settle it.**
  - R1 had 7 film raters and 3 TV raters with ≥ 10 rankings, and R2 had 44 accounts.
  - The rule needs ≥ 15 people in the final half per medium.
  - Expect Movies to be borderline, and TV to be INSUFFICIENT_EVIDENCE, even after the real run.

## 5. Recommended changes, ranked

| # | Change | Type | Expected impact | Effort | Risk |
|---|---|---|---|---|---|
| 0 | Run the real benchmark (one command, §6) and read the new candidate-generation vs ranking table | Prerequisite | Decides #3 and #4; replaces S with real numbers | 15 min once authorized | Privacy, mitigated by the workflow |
| 1 | **A language source.** TMDB `/discover` by `with_original_language` (sorted by vote count, within the reader's liked decades) for languages the reader ranks well, cached per language and stored into `media_items` so the catalogue grows. Feeds V1 directly, and `catalogue_candidates` too | Candidate generation | **High** for non-English readers (Telugu and Tamil today: about 2–5% in-language); none for English-only readers | M: adapter action, cache facet, one client source, tests | Low–Med: provider-call ceiling; popularity bias within a language |
| 2 | **Deeper TV pools.** TMDB `/recommendations` page 2 for TV anchors (`SIMILAR_SIZE` 20 → 40), and the follow-graph source kept on TV in any V2 variant | Candidate generation | Med–High on TV: every TV miss is a retrieval miss | S–M | Low: provider cost, more generic shows |
| 3 | **Re-weight the anchor term.** Down-weight list membership (0.60), or weight it by the anchor's score and by list rank. Tune on the dev half and read the final half | Ranking | Med on Films, if R1's lift of 0.46 holds at N > 7 | S (weights in `rank.ts`) | Med: unproven; needs #0 first |
| 4 | Refresh expired `similar` lists in the background for the anchors readers actually use, so selection is not limited to the few fresh lists | Candidate generation | Low–Med: fewer repeats, steadier pools | S | Low: provider budget |
| 5 | Any V2 trial uses `v2_metadata_social` (social kept), never plain `v2_metadata` | Candidate generation | Avoids R2's −0.136 Films pool loss and the S TV and sparse losses | none (it exists) | Allowlist only |
| — | Do **not** add an era term to V1; do not expand V2's | Ranking | Avoids R1's measured regression | — | — |

## 6. What needs separate approval

- **To run the real benchmark (#0).** This needs the founder's written grant, recorded on this PR
  or in the closeout register, naming three things:
  1. the production export by `eval/rec-v2-replay/export.sql`;
  2. who runs it. `export.sql` says *by hand, not from an agent session*. The founder must either run it or explicitly waive that line for an agent;
  3. a **temporary read-only database credential** (not the service key, and not the Management API's owner access).

  The one command, now in `eval/rec-benchmark/README.md`:

  ```bash
  PGOPTIONS='-c default_transaction_read_only=on' psql "$BINGD_RO_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -f eval/rec-v2-replay/export.sql > ~/private/rec-export.json \
  && REC_BENCHMARK_EXPORT=~/private/rec-export.json REC_BENCHMARK_OUT=~/private/ node eval/rec-benchmark/run.mjs; \
  rm -f ~/private/rec-export.json
  ```

  Then share only the printed aggregates, and revoke the credential.
- **Changes #1, #2 and #4** change the TMDB adapter and need an Edge Function deploy (provider
  budget). #1 and #2 also need an OTA.
- **Change #3** changes scoring for every reader, through an OTA, after #0.
- **Change #5** is an allowlist flag write, and needs the founder to name the QA accounts. No V2
  rollout is proposed.

## 7. What this PR changes in tooling

`eval/rec-benchmark/benchmark.ts` adds two secondary wall metrics, which the report prints in a
new candidate-generation vs ranking table:

- `poolRecallNonEnglish`;
- `recall50NonEnglish`.

There is no verdict-rule change and no export field. The tests cover the new table, and check that
R@50 never exceeds pool recall. The README gains the one-command form.

Checks:

| Check | Result |
|---|---|
| `npx jest eval/rec-benchmark` | 27 passed, 1 skipped |
| `node --test eval/rec-v2-replay/export.test.mjs` | 3 / 3 |
| `tsc` | 0 errors |
| eslint | clean |
