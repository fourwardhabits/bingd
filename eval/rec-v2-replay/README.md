# Recommendation V2: real-history replay

Planning evidence for the V2 rollout (reconcile branch `rec/v2-reconcile-1112`, 2026-11-13).
Nothing here ships in the app or touches a database by itself. It answers one question on
**real** histories, as a check on the synthetic A3 evaluation: with each account's most recent
Liked titles hidden, do V1 and V2 metadata find them, and what do their walls look like?

**Status: the real replay is pending.** It needs a read-only export that only the coordinator
can run. Everything below has been run end to end on a synthetic export generated from
`src/features/recommendations/evaluation/world.ts`.

## Files

| File              | What it is                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `export.sql`      | One read-only `SELECT`. Emits one JSON document, pseudonymous: random per-run account keys, media ids, days (no finer time), no names, emails, notes, comments or watch dates.                                                                                                                         |
| `export.test.mjs` | Runs `export.sql` against every migration in PGlite, in a READ ONLY transaction, over a fixture full of things that must not leak. Fails if an identifying column is selected, if a key outside the allowlist appears, or if keys repeat across runs. `node --test eval/rec-v2-replay/export.test.mjs` |
| `format.ts`       | The export's types and its validator. Every section is an exact key allowlist, so an export that grew a column is refused rather than read.                                                                                                                                                            |
| `replay.ts`       | Holdout, walls (V1 and V2 metadata through the shipped functions), metrics, report.                                                                                                                                                                                                                    |
| `synthetic.ts`    | A synthetic export in the same format, from the A3 world, with whole-show rankers.                                                                                                                                                                                                                     |
| `replay.test.ts`  | Smoke tests (always), and the runner `run.mjs` starts.                                                                                                                                                                                                                                                 |
| `run.mjs`         | The launcher. Refuses an export or output path inside the repository.                                                                                                                                                                                                                                  |

## Running the real replay (coordinator only)

1. Under an approved, **temporary, read-only** credential (never a service key), run:

   ```sql
   begin transaction read only;
   \i eval/rec-v2-replay/export.sql
   rollback;
   ```

   Save the single `replay` value (the JSON document, or the row `{ "replay": … }`) to a file
   **outside the repository**, e.g. `~/private/rec-v2-replay-export.json`. Revoke the credential.

2. Run the replay:

   ```bash
   REC_V2_REPLAY_EXPORT=~/private/rec-v2-replay-export.json node eval/rec-v2-replay/run.mjs
   ```

   It prints aggregate tables only. Add `REC_V2_REPLAY_OUT=~/private/` to also write `replay.md`.

3. Share the printed tables. **Delete the export.** Never commit it; `eval/rec-v2-replay/.gitignore` catches the
   obvious names in case one is saved here by mistake, and `run.mjs` refuses to read it there.

The synthetic proof: `node eval/rec-v2-replay/run.mjs --synthetic`.

## What the replay does

- **Holdout:** for each account with at least two Liked rankings, the last 20% of its Liked
  rankings (at least one) by ranking day, then by the account's own ranking order, are hidden
  from every input. Positions are renumbered per pool.
- **Walls:** a Films wall and a TV wall per account, three launch seeds each, V1 and V2
  metadata. Taste, profile (films, seasons and whole shows, one series one unit), anchors,
  coverage fill, scoring and the draw are the shipped functions. The server sources are
  mirrored from the export: TMDB similar lists, trending lists, followees' Liked titles
  (V1's `social_candidates`), and the catalogue windows (V2's `catalogue_candidates`).
- **Metrics:** held-out recall@20 and @50, pool recall, non-English share of the wall against
  the account's own mix, languages and genre entropy on the wall, and the share of the wall
  already seen (expected 0). Per slice: all, sparse (≤ 10 visible rankings), medium (11–30),
  heavy (> 30), and whole-show rankers (at least as many whole-show rankings as season ones).
- **V2 hybrid:** not replayed. At the current size it is **not measurable**; the report counts
  how many accounts have the two taste neighbours (Match > 55 on ≥ 5 shared series) a
  collaborative row needs at all.

## Known approximations

- Other accounts' rankings are used whole, including any made after a reader's held-out ones
  (cutting everyone at each reader's day would leave a cohort this small with nothing). This
  leaks the future equally for both engines, as the predicted-score P2 mode does.
- First launches only: no dismissals, exposure memory, filters or TMDB fills.
- With about 46 rankers, every interval is wide. Read the direction and the per-account
  distribution, not the third decimal.
