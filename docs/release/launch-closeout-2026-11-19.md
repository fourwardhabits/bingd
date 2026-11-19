# Launch closeout — status register (2026-11-19)

The single status register for the four launch-closeout lanes. GitHub PRs are the
engineering record; this file only points at them. Coordinator branch:
`claude/gallant-dirac-sllr6o`.

Status vocabulary: Not started · In progress · Awaiting external access ·
Awaiting founder approval · Ready to release · Shipped and verified.
An open PR, green CI or a prepared upload is **not** "Shipped and verified".

Out of scope for every lane: #319 (owned by its own session), #321 (release-pending),
#322 (awaiting staging/device QA). No lane merges, deploys or edits those branches.

| Lane | Owner | Branch / PR | Status | Verified result | Blocker | Next action |
|---|---|---|---|---|---|---|
| A. App Store refresh (P0) | Lane A worker | `claude/launch-a-store-refresh` / PR pending | In progress | — | Card 03 source capture `Screenshot_20261119_160109_bingd.jpg` (and optional card 06 `…160146…`) did not reach the cloud session: not in the repo or Drive. App Store Connect access via EAS still being checked. | Founder: drop both captures into Drive or the repo. Worker: build package, validate, and set out the single-submission plan. |
| B. Welcome email (P0) | Lane B worker | `claude/launch-b-welcome-v2` / [#324](https://github.com/fourwardhabits/bingd/pull/324) (draft) | Awaiting founder approval | One `[TEST]` sent from `suraj@bingd.app` and delivered per Resend (id `01a1f5f0-889b-77b7-aa39-96add1b8e209`). Sent HTML matches the build byte for byte (sha256 51b310ea…); the old Beli letter is gone. Email tests 48/48, DB welcome tests 59/59. | Founder visual approval | On approval: merge #324 away from the :23 hourly run, confirm the Pages deploy serves `/email/founder-cafe-tea.jpg`, run the canary, then confirm the next cohort send shows delivered. |
| C. Recommendation quality (P1) | Lane C worker | `claude/launch-c-rec-verdict` / PR pending | In progress | — | Real-history run may need the data-access authorization that `eval/rec-benchmark/README.md` requires. | Reconcile #275/#301/#316, verify the prod V1/V2 state, run or stage the eval, write the decision memo. |
| D. Docs reconciliation (P2) | Lane D worker | `claude/launch-d-docs-reconcile` / PR pending | In progress | — | — | Open the docs-only PR with a list of the remaining ambiguities. |

## Evidence log

Add dated, one-line entries that link the evidence (PR, Resend message id, ASC state).
Newest entries go first.

- 2026-11-19: Lane B test delivered to the founder's inbox (Resend id above). Found along the way: since the founder's handle changed (saisurajkan → surajkan, 06:13Z today), the live email's "follow me" link has been dead. #324 fixes it, but the live email keeps the dead link until #324 merges.
- 2026-11-19: lanes A–D launched in isolated worktrees. Founder photo found in Drive
  (`founder-cafe-tea-square.jpg`). The Nov-19 screenshot attachments are not available to the
  cloud session.
