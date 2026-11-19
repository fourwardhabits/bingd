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
| A. App Store refresh (P0) | Lane A worker | `claude/launch-a-store-refresh` / [#326](https://github.com/fourwardhabits/bingd/pull/326) (draft); binary config on `claude/launch-a-store-binary-1.2.0` @ `5821cb36` | Awaiting founder approval | Renderer reproduces the approved Nov-11 set byte for byte. Apple 1206×2622 and 1320×2868 sets and the Play 1080×1920 set plus feature graphic pass all 41 checks. EAS holds an admin ASC API key, so `eas submit` works. Live iOS is 1.1.0 (15); a new 1.2.0 binary is required. | (1) Card 03 capture not supplied. (2) Founder go-ahead needed for the 1.2.0 production build. (3) `api.appstoreconnect.apple.com` is not reachable from here, so the founder does the Name, screenshot upload and Submit for Review in ASC. | Founder: supply the capture and approve the build. Agent: card-03 swap, `release/2026-11-19-store-1.2.0`, build, `eas submit`. Founder: ASC entry and Submit for Review, all in one submission. |
| B. Welcome email (P0) | Lane B worker | `claude/launch-b-welcome-v2` / [#324](https://github.com/fourwardhabits/bingd/pull/324) (draft) | Awaiting founder approval | One `[TEST]` sent from `suraj@bingd.app` and delivered per Resend (id `01a1f5f0-889b-77b7-aa39-96add1b8e209`). Sent HTML matches the build byte for byte (sha256 51b310ea…); the old Beli letter is gone. Email tests 48/48, DB welcome tests 59/59. | Founder visual approval | On approval: merge #324 away from the :23 hourly run, confirm the Pages deploy serves `/email/founder-cafe-tea.jpg`, run the canary, then confirm the next cohort send shows delivered. |
| C. Recommendation quality (P1) | Lane C worker | `claude/launch-c-rec-verdict` / [#327](https://github.com/fourwardhabits/bingd/pull/327) (draft) | Awaiting founder approval | Verdict: keep V1; candidate generation is the main problem (TMDB recs for Telugu anchors are 2% Telugu; the catalogue has 35 Telugu films vs 12,341 English; TV pools of about 28 are smaller than the 50 scored). Ranking is second (the anchor term carries 0.60 of the score). Prod and staging both run `v2_engine` = v1 at 0%. Based on earlier real aggregates, today's prod catalogue totals and synthetic data. The real-history export was NOT run. | `export.sql` requires a written founder grant, a run by hand (or an explicit waiver of the agent-session rule) and a temporary read-only DB credential. | Founder: grant on #327 or run the one command yourself. Then confirm the verdict, and scope fix #1 (language-filtered `/discover` source). |
| D. Docs reconciliation (P2) | Lane D worker | `claude/launch-d-docs-reconcile` / [#325](https://github.com/fourwardhabits/bingd/pull/325) | Ready to release | Docs only, 18 files (coordinator checked). Relative links: 267 checked, 0 broken. Coordinator confirmed #305 and #301 heads are on main: #305 is live; #301 is live but off (`v2_engine` = v1). | Founder answers to the 8 ambiguities in the PR body (none blocks the merge). PR #224 may conflict in `production-state.md`. | Founder: review and merge #325. M-5 (Sentry scrubbing rules) is founder-only and still unverified. |

## Evidence log

Add dated, one-line entries that link the evidence (PR, Resend message id, ASC state).
Newest entries go first.

- 2026-11-19: Lane C opened #327. No user rows were read; the production queries covered catalogue/config totals and an `EXPLAIN` only. Benchmark tooling now separates titles that never entered the pool from titles that were in it but ranked low.
- 2026-11-19: Lane A opened #326. Live iOS is 1.1.0 (15), last submitted 2026-09-26. Live code is OTA `a3300bf0`. Play has no upload service account, so the Play upload is manual.
- 2026-11-19: Lane D opened #325. Correction to the brief: Onboarding 2.0 (#305) shipped in release 1115 even though its PR is still an open draft. Release records since 11-15 exist only on the unmerged `ops/preview-1115-records`.
- 2026-11-19: Lane B test delivered to the founder's inbox (Resend id above). Found along the way: since the founder's handle changed (saisurajkan → surajkan, 06:13Z today), the live email's "follow me" link has been dead. #324 fixes it, but the live email keeps the dead link until #324 merges.
- 2026-11-19: lanes A–D launched in isolated worktrees. Founder photo found in Drive
  (`founder-cafe-tea-square.jpg`). The Nov-19 screenshot attachments are not available to the
  cloud session.
