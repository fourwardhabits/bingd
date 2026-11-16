# Feed poster rails (PR 312) and expanded grouping (PR 2): state and records

## PR 312: poster rails, ready for the founder's visual check

- **Head and review:** `e94589b6`. Codex found no issues; CI is green, including the concurrency suite.
- **Database:** `20261127000100` (`feed_group_previews`, read-only) is applied on staging, byte-identical to the file.
- **Staging check:** `scripts/staging-checks/rails-staging.mjs` passes 10/10 (order, scores per ladder, unranked, block, private, anon).
- **Preview:** both platforms serve `e94589b6` (Android group `d2c7190b`, iOS group `d09bbb7e`). The live read-back is ok, staging only.
- **Demo account:** `@qa_fx_rails_demo` (public, marked `rails-demo-v1`) has a watchlist group of 6 and a sitting of 6 (4 movies and 2 seasons).
- **Production prerequisites:**
  1. Apply `20261127000100`. It is read-only and needs no flag.
  2. Then CI, the release gate, the OTA check and the OTA publish on the merged SHA.
- **Rollback:** revert the OTA. The function is safe to leave in place.

### Founder checklist

Follow `@qa_fx_rails_demo` from a staging QA account, then on Android and iOS check:
1. Both posts show a rail: about three posters and a peek, no captions.
2. A drag scrolls the rail without opening anything, and the vertical Feed still scrolls.
3. Tapping a poster opens that title.
4. The ranking rail shows maroon score pills, and the seasons show `S1 - x.x`.
5. "View all 6" opens the full list.
6. The card has Like and Comment only: no Save or Share, and the subline shows just the time.

## PR 2: expanded grouping

Branch `feed/expanded-grouping`; design in `docs/feed/expanded-grouping.md`.

- **What's built:**
  - `presented_in` hiding, enforced by the policy.
  - Union readers.
  - `rank_group_note` for title-page backfill rankings.
  - Cross-ladder sittings.
  - Consolidation and revert, operator-only.
  - A read-only dry-run query.
- **Tests:** `presentation-grouping` 10/10, `ranking-grouping` 16/16, client 6327 passing.

### Production dry run (read-only), 2026-11-09 to 2026-11-16

Full report: `2026-11-16-consolidation-dryrun-production.json`.

- **Scanned:** 22 watchlist posts and 203 rankings.
- **Would group:** 4 watchlist groups (14 posts) and 3 ranking groups (12 posts). That removes 19 cards across 5 actors.
- **Excluded:**

  | Reason | Count |
  | --- | --- |
  | Has comments | 3 |
  | Has reactions | 3 |
  | Any reference (all reasons) | 5 |
  | Has a review | 6 |
  | Rewatch or update | 4 |
  | After-watch or ambiguous | 188 |
- **Integrity:** no watchlist post lacks its membership, and there are no duplicate first rankings. The largest group would hold 7.
- **Records:** no ranking or watchlist record changes. The plan touches only `feed_events` visibility, plus new group rows.

### Founder decision required: what counts as "historical"

- **The evidence:** of 199 first-time rankings in the window, 184 have watch evidence `today_default` (123 dated the same day, 61 one to six days earlier). The reader kept the "Today" date the log sheet offered. 14 are undated (`none`), and 1 is `unattributed`.
- **The current rule:** the spec forbids inferring "historical" from bursts alone, so the safe rule treats `today_default` as after-watch. Under it, most of the Nov 15–16 ranking bursts stay individual.
- **The options:**
  - (a) Keep the safe rule. Grouping then applies to undated or explicitly older watches only.
  - (b) Treat a burst of `today_default` first rankings as backfill. This is a heuristic the spec currently disallows.
  - (c) Change the log sheet so backfill is recorded as such. This is a product change.

### PR 2 status (PR 313)

- **PR and review:** [fourwardhabits/bingd#313](https://github.com/fourwardhabits/bingd/pull/313), a draft with base #312. Codex review requested.
- **Staging migration:** `20261128000100` is applied (203 migrations). Backfill grouping is on in staging.
- **Staging integration:** `scripts/staging-checks/pr2-staging.mjs` passes 21/21 with disposable accounts, all deleted afterwards.
- **Equivalence:** on staging, `consolidate_feed_history` in dry-run mode and `docs/feed/consolidation-candidates.sql` produce the same plan: 3 ranking and 2 watchlist groups, 56 members.
- **Local gates:** test:db 3297 pass, then allow-lists fixed (38/38). Races 209/209, including RG5. Client 6327 pass.
- **Preview:** left on PR 312 (`e94589b6`) for the founder's rail check. A Preview of PR 2 would replace it, so it is published only on request or after that check.
- **Production prerequisites, when authorized:**
  1. Release #312 first.
  2. Pre-insert `feed.ranking_backfill_grouping_enabled = false` in production.
  3. Apply `20261128000100`, then CI, the release gate and the OTA on the merged SHA.
  4. Enable the flag.
  5. Run the consolidation only with a separate authorization and the batch name recorded: read-only dry run, then `consolidate_feed_history(batch, since, until, true)`; revert with `revert_feed_consolidation(batch)`.
