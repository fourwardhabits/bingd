# Predicted score: offline evaluation harness

Planning evidence only. Nothing in this folder ships in the app, touches a database, or shows
a prediction to anybody. It answers one question before anything is built: **could bingd
say roughly where an unranked title would land for a reader, well enough that a confident
wrong number is rare?**

The design comes from the 2026-09-19 feasibility study (verdict: EXPERIMENT). The amendment
from the Watch History / Ranking Calibration audit shaped the two modes below.

## The two modes, and why P2 decides today

|                      | P1 TEMPORAL: NOISY CURRENTLY                                                                                                                                              | P2 HOLDOUT: MODEL COMPARISON                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| What                 | Each ranking is predicted from the list as it stood just before its `rankings.created_at`. Everyone else's evidence is cut at the same moment.                            | A bucket-stratified fifth of each current list is held out and predicted from the rest. |
| Simulates deployment | Yes                                                                                                                                                                       | No: it leaks the future (other people's later rankings, the reader's later taste)       |
| Labels               | **Contaminated today.** Every correction resets `created_at` until T0 lands. A manual `rank_reorder` leaves no record. Undo leaves answered comparisons in `comparisons`. | Reliable. The current order _is_ the reader's current opinion.                          |
| Role                 | Reported with its contamination counted. **Cannot produce a pass** (`P1_CAN_GATE = false`).                                                                               | The primary model-comparison signal at current maturity.                                |

What P1 can detect, it flags per label:

- **re-placed:** comparisons more than 24h before `created_at` mean the title was already in
  the list, so its `created_at` was reset;
- **earlier list was missing a title:** a re-placed title's first comparison predates this
  label's moment, so the replay left out a title that was there;
- **no placement evidence:** placed into a non-empty band with no comparison recorded (Too
  tough, a dry walk, or a reset).

A manual reorder cannot be detected at all. The report says so beside the counts.

**When placement history exists** (`ranking_placements`,
`docs/product/watch-history-and-ranking-calibration.md` §E), point the export at placements
instead of `rankings.created_at` and flip `P1_CAN_GATE`. P1 then becomes the preferred gate,
because it is the only mode that simulates deployment.

## What is predicted

**Bucket probabilities plus the within-band insertion quantile q**, where q = (r − 1) / n
for a title that would land at rank r in a band that holds n titles today. It is never the
rounded score. The display score is projected once, at the end, through the app's own
`BAND_RANGE` and `scoreFor` (imported from `src/features/collection/score.ts`, not
restated). The point prediction is the **median bucket** with its q, never a mean across
buckets.

| Model | Evidence                                                                          | Population                |
| ----- | --------------------------------------------------------------------------------- | ------------------------- |
| M0    | the reader's own bucket shares, q = ½                                             | the baseline; never shown |
| M1    | public raters of the title, carried into the reader's geometry                    | `community_score`'s       |
| M2    | raters weighted by Taste Match above 50 (`taste_match`, mirrored exactly)         | `can_view_profile`'s      |
| M3    | the reader's own most similar titles, plus their own Letterboxd stars if exported | the reader only           |
| M4    | M1 + M2 + M3 pooled by evidence weight                                            | as above                  |

A prediction is shown only if the reader has at least 20 ranked titles with at least 3
outside the top band, the model's own evidence clears its minimum, M4's components agree,
the most likely bucket is at least 70% likely, and the 80% interval is at most 2.5 points
wide. The interval is cross-conformal by user and Mondrian by confidence. Every threshold
is pre-registered in `config.ts`. The report's threshold sweep is descriptive, and the
verdict never reads it.

## Verdicts

- **INSUFFICIENT:** fewer than 15 evaluable users or 300 shown Movies predictions, or a
  check that cannot be computed. **Expected at today's scale, and not a failure of the
  harness.**
- **FAIL:** enough sample, and a pre-registered P2 check failed.
- **PASS FOR SHADOW MODE:** every P2 check passed. This admits computing and logging
  predictions nobody sees. It does not admit a user-facing build. That still waits for a
  sufficient cohort, clean placement-history labels, and a prospective shadow-mode check.

## Files

| File                 | What                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `export.sql`         | The read-only, pseudonymised snapshot export. Founder-run.                               |
| `snapshot.ts`        | Snapshot types, parsing (raw JSON, SQL editor JSON or CSV) and validation.               |
| `geometry.ts`        | Band geometry, insertion truth, projection to display units.                             |
| `tasks.ts`           | P1 and P2 task construction and the P1 label flags.                                      |
| `evidence.ts`        | Populations, as-of opinions, Taste Match, content similarity, stars.                     |
| `models.ts`          | M0 to M4 and the aggregator.                                                             |
| `confidence.ts`      | Abstention and cross-conformal intervals.                                                |
| `metrics.ts`         | Every metric, and the user-clustered bootstrap.                                          |
| `run.ts`             | Orchestration, segments, sensitivity grid, sweep, verdicts.                              |
| `report.ts`          | The aggregate-only markdown report.                                                      |
| `config.ts`          | Every pre-registered number.                                                             |
| `synthetic.ts`       | Seeded synthetic cohorts, including one shaped like the 2026-09-13 production aggregate. |
| `*.test.ts`          | Jest suites (part of `npm test`).                                                        |
| `export.test.mjs`    | `export.sql` against every migration in PGlite, in a READ ONLY transaction.              |
| `mutation-check.mjs` | Removes each leakage and insertion protection. The named tests must fail.                |
| `run-report.mjs`     | Writes a report into `.agent-workflow/eval/`.                                            |

## Commands

```
npx jest eval/predicted-score                                  # unit, leakage and end-to-end suites
node --test eval/predicted-score/export.test.mjs               # export.sql against the real schema (run alone)
node eval/predicted-score/mutation-check.mjs                   # 15 mutants, all must be killed
node eval/predicted-score/run-report.mjs --synthetic production-like
node eval/predicted-score/run-report.mjs --synthetic           # rich synthetic cohort
node eval/predicted-score/run-report.mjs --snapshot .agent-workflow/eval/snapshot-YYYY-MM-DD.json
```

Reports land in `.agent-workflow/eval/`, which is gitignored.

## Running the export (founder, by hand)

The agent never runs this. It reads production.

1. **Make a salt, and do not save it anywhere.**
   `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
2. **Copy `export.sql` outside the repository**, for example to
   `%TEMP%\predicted-score-export.sql`. In the copy, replace
   `REPLACE_WITH_A_RANDOM_SALT_OF_24_OR_MORE_CHARACTERS` with the salt. Leave
   `include_letterboxd_stars` as `false` unless you have decided that a reader's own stars
   are in scope as evidence for that reader's own predictions. They are never used for
   anyone else.
3. **Run it against production, read-only.** Use one of these:
   - **psql** (enforces read-only for the session). The connection string is in the
     Supabase dashboard under Connect → Session pooler:
     ```
     psql "<connection string>" -X -q -v ON_ERROR_STOP=1 -At -c "set default_transaction_read_only = on" -f "%TEMP%\predicted-score-export.sql" > .agent-workflow\eval\snapshot-YYYY-MM-DD.json
     ```
   - **Supabase dashboard → SQL Editor.** Paste the salted copy and Run. It is one SELECT
     and cannot write. The result is one row with one column, `snapshot`. Download it
     (JSON or CSV) into `.agent-workflow\eval\` in the repository. The harness reads the raw
     document, the editor's JSON download and its CSV download. If a copy-paste truncates
     the cell, the harness refuses the file rather than evaluating half of it.
4. **Delete the salted copy** of the SQL.
5. **Run the report** from a checkout of this branch (or main, once merged):
   `node eval/predicted-score/run-report.mjs --snapshot .agent-workflow/eval/snapshot-YYYY-MM-DD.json`
   The runner refuses a snapshot anywhere inside the repository except `.agent-workflow/`.
6. **Read `.agent-workflow/eval/predicted-score-report-<date>-snapshot.md`, then delete the
   snapshot.** The report holds aggregates only and can be kept. Any segment drawn from
   fewer than three people is suppressed.

The snapshot holds salted keys, never ids or names. It is pseudonymised, not anonymised:
anyone holding both the file and the salt could re-identify accounts. Never commit it.
