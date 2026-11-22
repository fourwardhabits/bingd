# Launch closeout — status register (2026-11-19)

The single status register for the four launch-closeout lanes. GitHub PRs are the
engineering record; this file only points at them. Coordinator branch:
`claude/gallant-dirac-sllr6o`.

Status vocabulary: Not started · In progress · Awaiting external access ·
Awaiting founder approval · Ready to release · Shipped and verified.
An open PR, green CI or a prepared upload is **not** "Shipped and verified".

#319, #321 and #328 have shipped (below). #322 is in its own device-QA round and is not part of any lane.

| Lane | Owner | Branch / PR | Status | Verified result | Blocker | Next action |
|---|---|---|---|---|---|---|
| A. App Store refresh (P0) | Coordinator | Screenshots: [#326](https://github.com/fourwardhabits/bingd/pull/326) (draft). Binary: `release/2026-11-20-store-1.2.0` / [#330](https://github.com/fourwardhabits/bingd/pull/330) (draft) @ `e76d8730` | iOS binary uploaded to ASC; Android binary built; store listing awaiting founder | Gates on `e76d8730`: CI, the release gate and Codex all clean. EAS workflow `01a1f6df` built both on EAS servers (this fixed the `GOOGLE_SERVICES_JSON` blocker). **iOS** 1.2.0 (16), build `5cde67bb-6a08-4945-83be-a284963c20b5`: EAS submission `3d4b2ae6-9235-4f29-b72f-e39a939800a0` FINISHED, upload to ASC done. **Android** 1.2.0 (16), build `a4ae52fe-3bf0-4bbd-b54c-55a6dc144ed1` (.aab). Renderer and screenshot sets as before (41/41 checks). | (1) Card 03 (Crazy Rich Asians Feed) capture not on Drive (searched again 03:05Z). (2) `api.appstoreconnect.apple.com` is blocked here, so the ASC steps are the founder's. (3) No Play upload service account. (4) What's New text unconfirmed. | Founder: supply the card-03 capture (agent swaps it into #326 and re-renders). In ASC: select build 16 for 1.2.0, set Name `bingd`, upload screenshots, What's New, then Submit for Review, all in one submission. Play: upload the .aab from the EAS build page to production. Agent merges #330 once both are live. |
| B. Welcome email (P0) | Coordinator | [#324](https://github.com/fourwardhabits/bingd/pull/324) (`e8a6ee54`), then [#329](https://github.com/fourwardhabits/bingd/pull/329) merged as `333c1a79` | Shipped (template); scheduled delivery under watch | Founder approved logo-only, photo-free. Last test (Resend `01a1f69d…`) delivered; its HTML matches `main`. `https://bingd.app/email/bingd-logo.png`: 200 image/png, sha256 `2ab4e51a…`, the same as `main`. Production dry run on `333c1a79` ([run 44664330673](https://github.com/fourwardhabits/bingd/actions/runs/44664330673)): template self-test passed, delivery enabled, 0 in the window. The worker refuses the sample postal address on any cohort send. Schedule is six slots an hour (`3,13,…,53`). | GitHub's scheduler starts this repo's scheduled runs only every 5–10 h; none ran 22:17Z–04:00Z, including five of the new slots. More cron entries do not help. Canary: GitHub Environment `production` lacks the `WELCOME_CANARY_USER` / `WELCOME_CANARY_EMAIL` secrets. | Fix shipped: [#331](https://github.com/fourwardhabits/bingd/pull/331) (`ecd03517`), production migration `20261130000300` applied with founder approval. The hourly `bingd-welcome-dispatch` job is installed and inert (`unconfigured`) until a token is stored. The GitHub schedule stays as the backup. Next, the founder: restrict the `production` environment to `main`, then create the fine-grained token and store it in production Vault. Agent then verifies the 204, the run and no duplicate sends. Founder: add the two canary secrets to enable a one-recipient live check. |
| C. Recommendation quality (P1) | Lane C worker | `claude/launch-c-rec-verdict` / [#327](https://github.com/fourwardhabits/bingd/pull/327) (draft) | Awaiting founder approval | Unchanged: keep V1; candidate generation is the main problem. The real-history export has NOT been run. | `export.sql` needs a written founder grant, a hand run (or an explicit waiver) and a temporary read-only DB credential. | Founder: grant on #327 or run the one command yourself. |
| D. Docs reconciliation (P2) | Worker A | [#325](https://github.com/fourwardhabits/bingd/pull/325), merged as `fcd478fa`. [#332](https://github.com/fourwardhabits/bingd/pull/332), merged as `2a74d74d` | Shipped and verified | PRD current-product rebuild plus a §26.0 production acceptance baseline (32 criteria). `docs/architecture/diagrams.md` holds 10 Mermaid charts, rendered with mermaid-cli 11.4.2. Release records imported from `ops/preview-1115-records` (31 files, `docs/release/release-records-index.md`). Link check across all of `docs/`: 134 files, 700 links, 0 broken. Codex clean on both final heads; both docs-only. | None | Founder: 3 product questions (Refine at launch, #328 consolidation, IMDb whole shows). |

**Also shipped and verified in production since this register opened:**

| Item | Release | Verified |
|---|---|---|
| #319 collection rerank (+ TV direct ranking) and #321 | `main` `1c24b5cd`. Migrations `20261129000100`–`000300`. OTA Android `01a1f6bf-421a-7843-b074-8a0ec05cd692`, iOS `01a1f6bf-421a-76fa-b92a-19bfb6d8118a` | Invariants after each migration; fingerprints equal the runtimes; the live manifest serves `1c24b5cd`. Record: `docs/release/production-2026-11-20-319-321.md` on `ops/preview-1115-records`. |
| #328 Feed: 30-minute first-ranking grouping window | `main` `68095e99`. Migration `20261130000200`, database-only | Production head `20261130000200` (207 versions); I/P/W invariants OK; `_ranking_is_historical` removed. **No historical consolidation** (82 posts / 11 groups pending separate authorization). Record: `docs/release/production-2026-11-20-328.md`. |
| Welcome email dispatcher ([#331](https://github.com/fourwardhabits/bingd/pull/331)) | `main` `ecd03517`. Migration `20261130000300`, database-only, founder-approved 2026-11-20 | Production head `20261130000300` (208 versions). `_dispatch_welcome_email()`: owner `postgres`, security definer, `search_path=public`, ACL `{postgres=X/postgres}` (anon, authenticated, service_role and public all denied). Exactly one `bingd-welcome-dispatch` job, `41 * * * *`, active, as `postgres`, with 6 jobs in all. Gates: env `prod`, delivery on, **0 token rows**. Probe in a rolled-back transaction returned `unconfigured` with 0 GitHub requests queued before and after. `welcome-email.yml` is still `active`, with its cron unchanged as the backup. **Rollback:** `docs/release/welcome-dispatch/rollback-20261130000300.sql` on `main` (unschedules the job, drops the function, removes the history row; any Vault secret is left for manual deletion). Stop without rollback: `select cron.unschedule('bingd-welcome-dispatch');`. |

**In founder QA:** #322 (follow-story engagement). Staging (re-read 2026-11-20 ~08:05Z): head `20261201000100`, 210 versions. That count includes #331's `20261130000300` and #334's `20261130000400`; #334 was first applied as `20261201000400` and its history row was renamed. Preview `5e5f55df`: Android `01a1f6ea-7758-7d92-8289-577aa7b5a8f5`, iOS `01a1f6ea-7758-7d86-bef5-3da925a67628`. Checklist: `docs/release/preview-2026-11-21-wsc.md`. No production change before device QA passes.


## Overnight closeout, 2026-11-20

Three workers ran in separate worktrees: A (docs), B (security) and C (reliability). The coordinator verified each claim below against `main`, GitHub or a read-only production query before recording it.

### Merged tonight (all docs-only unless noted)

| PR | What | Merge | Review |
|---|---|---|---|
| [#325](https://github.com/fourwardhabits/bingd/pull/325) | PRD, architecture and ops docs reconciled with production; Mermaid diagrams | `fcd478fa` | Codex: 2 × P2 fixed, then clean on `43b6ec03` |
| [#332](https://github.com/fourwardhabits/bingd/pull/332) | Release records imported to `main` | `2a74d74d` | Codex: 2 × P2 fixed (per-member traces summarised), then clean on `effffb5f` |
| [#317](https://github.com/fourwardhabits/bingd/pull/317) | H-1 closure evidence | `3fd9397b` | Codex clean on `1cc8eaac` |
| [#335](https://github.com/fourwardhabits/bingd/pull/335) | Security findings register 2026-11-20 | `00361a70` | Codex: 3 × P2 fixed, then clean on `17152cd3` |
| [#337](https://github.com/fourwardhabits/bingd/pull/337) | `docs/ops/background-jobs.md` and `docs/ops/reliability-2026-11-20.md` | `a7ed877c` | Codex: 1 finding fixed (stopped-job detection), then clean on `245c400f` |

### Shipped 2026-11-20 after founder approval

The founder approved #333, #334 and #336. They are shipped and verified; the record is `production-2026-11-20-333-334-336.md`.

- **#333** (`503fd75f`): secret-holding jobs run only on `main`, and every workflow gets a read-only token.
- **#334** (`6a7bfb85`): migration `20261130000400` applied at about 14:32Z. Production is at 209 versions. Each `bingd-import-maintenance` run went from 81–165 ms (with about 2 s spikes) to 8–24 ms. Rollback: `pr334/rollback-20261130000400.sql`, captured from production before the apply.
- **#336** (`e86596f2`): production OTA run `01a1f95f`. Android `01a1f964-4e35-77e9-a99d-4315a8141d06`, iOS `01a1f964-4e35-7374-af5b-c00ad4919058`. Runtimes equal the 1.1.0 (15) binaries. The live manifest serves `e86596f2`.

### Shipped 2026-11-20: #340, #341, #342 (founder-approved)

The record is `production-2026-11-20-340-341-342.md`.

- **#340:** the OTA migration-order guard. The record has been regenerated from production: head `20261130000600`, 211 versions. The guard refuses `main` with the old record, passes it with the new one, and refuses #322.
- **#341:** `bingd-ops-health` is live. Ticks run in 445–699 ms. A rolled-back production probe opened exactly one alert and closed it on recovery; nothing was committed. It is still pull-only; delivery is proposed in draft #343, Healthchecks.io, and waits for founder approval.
- **#342:** the Feed-order index is live. The real Feed plan uses it with no sort. The first real calls ran at 0.1–33.9 ms, against means of 141–366 ms before. The sample is small; re-read before deciding on the `can_i_view` rewrite.

### Shipped 2026-11-21: #350 title-page actions (founder-approved OTA)

The record is `production-2026-11-21-350.md`.

- **#350** (`1101b029`): the title row is Rank/Log rewatch · bookmark · ⋯, and the ⋯ menu is Recommend to a friend · Share off bingd · Add to list · Edit ranking / Add note · Remove from collection. Client-only.
- Production OTA run `01a1ff80`: Android `01a1ff85-256f-706d-9254-a09a0feee08c`, iOS `01a1ff85-256f-7790-a86a-3c35ddd7b5ec`. Runtimes equal the 1.1.0 (15) binaries; the live manifest serves `1101b029`. Migrations unchanged at `20261130000600` (211).
- #346 closed as superseded. #347, #348 and #322 are not in production.

### Security (register: `docs/security/findings-register-2026-11-20.md`)
- **No critical or high finding is open, and none was found.**
- Production checks (read-only):
  - all 82 tables have RLS;
  - anon reads no table, and no client role writes any table;
  - all 349 security-definer functions pin `search_path`;
  - the 163 client-callable functions match the test allow-list exactly.
- Staging cross-feature probe: 23/23. It covered blocks through grouped cards, private accounts through poster rails and Taste Match, mutual-only companions, and `pg_net` through the API. All 9 disposable accounts were deleted.
- **Medium:**
  - B-2: workflow refs; fixed by #333 together with founder check F-1.
  - B-4: the dispatcher token's scope, expiry and silent failure; handled by process, F-4.
  - M-5: Sentry dashboard rule unverified; F-3.
- **Low and info:**
  - B-3 (fixed in #333);
  - B-5 (`net` schema defaults, accepted with conditions);
  - B-6 (a blocked-pair comment notification row nobody sees; one-line fix deferred because #322 owns `_add_comment`);
  - B-7 (`npm audit`: two shipped advisories, both low impact; upgrade Expo after the 1.2.0 binary);
  - B-8 (own-data writes not rate-limited, accepted);
  - B-9 (minimum password length 6);
  - m-3 (nine historical logs show handles; cleanup plan written, nothing deleted);
  - M-5b (Sentry message content to audit);
  - B-10 (deleted handles reserved; privacy-policy wording).

### Reliability (`docs/ops/reliability-2026-11-20.md`)
- **Fixed and shipped:** the cron prune (#334), the `media_cache` count and the stale own-profile counts (#336).
- **Open, measured:**
  - The Feed page query costs more as followed history grows: prod 6,752 calls, mean 154 ms, max 3.1 s, with the per-row `can_i_view` check dominating. It needs a redesign before growth.
  - `report_device_context` takes about 1.2 s per launch (fire-and-forget).
  - There is no alerting on job failures.
  - `refetchOnReconnect` never fires on React Native.
  - The Feed is not virtualized.
  - Nothing stops an OTA that needs an unapplied migration (#322 is that case).
- **Healthy:** 0 failed cron runs in retained history, no missed runs in 7 days, queues empty.

### Release reconciliation
- **#328:** live. The one first ranking since the migration carries `groupable: true`. No two-ranking group has happened yet, so there is no production example of a grouped post. Consolidation not run.
- **#331:** live and inert. The 05:41Z run succeeded in 31 ms (`unconfigured`). Every 2026-11 signup received the welcome email: 2026-11-09 ×3 and 2026-11-11 ×2. There have been no signups since 2026-11-11, so the 13 sent is correct.
- **#322:** staging plus Preview `5e5f55df`. It merges cleanly with current `main`. Checklist: `docs/release/preview-2026-11-21-wsc.md` §Founder device QA (7 checks).
- **#327:** memo §8 addendum (`06f85e5b`). Catalogue re-read: 40 Telugu vs 13,543 English film tiles; 7.6% of film `similar` lists unexpired. The ranked backlog stands, and the real benchmark is still unrun.
- **#326/#330:** iOS 1.2.0 (16) uploaded; Android .aab built. Card 03 is still not on Drive (rechecked). Nothing was rebuilt.

## Evidence log

Add dated, one-line entries that link the evidence (PR, Resend message id, ASC state).
Newest entries go first.

- 2026-11-21 ~23:45Z: **Shipped.** #354 migration `20261130000900` applied to production (213 versions) from a clean checkout of `704a683f` (CI, races, release gate green); functions match staging; no rows written. Earlier, OTA `55db8b2b` (#347 client and #352) published and verified. Records: `production-2026-11-21-354.md`, `production-2026-11-21-347-352.md`.
- 2026-11-21 ~22:00Z: **Shipped.** #347 migration `20261130000800` applied to production under the founder's Feed fast-track approval, from a clean checkout of `f821c463` (CI, races, release gate green). Production 212 versions; bodies match staging; the review-unpresent trigger is gone; no rows written. Record: `production-2026-11-21-347-352.md`. #352 (title polish) merged as `6e940127`; its OTA follows this record.
- 2026-11-21 ~19:15Z: **Shipped.** #350 (OTA `1101b029`) with founder approval. PR CI, Codex, `main` CI and the release gate green; migration guard agrees at 211; fingerprints equal the store runtimes; live manifest verified. #346 closed as superseded.
- 2026-11-20 ~19:20Z: **Shipped.** #340, #341 (`20261130000500`) and #342 (`20261130000600`), with founder approval. Every gate on `d2803274` was green, the migration record was regenerated, the guard was validated, the alert probe passed and was rolled back, and the Feed plan uses the new index. No OTA.
- 2026-11-20 ~14:40Z: **Shipped.** #333, #334 (`20261130000400`) and #336 (OTA `e86596f2`), all with founder approval. Every gate on `e86596f2` was green. The live manifest is verified, and prune runs measured 8–24 ms after the apply. Next engineering work: job-failure alerting, a migration-order safeguard, then the Feed query long tail.
- 2026-11-20 ~08:00Z: overnight closeout recorded above. Merged: #325, #332, #317, #335, #337 (all docs). Ready for founder approval: #333, #334 (staging), #336. Production changed only by the approved #331 migration.
- 2026-11-20 ~05:40Z: **Shipped.** #331 migration `20261130000300` applied to production with founder approval, from a clean checkout of `ecd03517` (CI, races, release gate green). The script differs from the reviewed #328 script only in its expected version, and the dry run showed exactly that version pending. Verified: history, ownership, ACL, one job, and the `unconfigured` probe with no request. No token was created or stored.
- 2026-11-20 ~05:15Z: #331 merged (`ecd03517`; CI, races, release gate green; Codex clean on `dd0b265a`). Production dry run: only `20261130000300` pending. The apply was held by the session's permission check, so it waits for founder go-ahead.
- 2026-11-20 ~04:00Z: GitHub scheduled runs still not starting (none since 22:17Z). Fix in progress: a pg_cron dispatcher in production, following the push/import drain pattern. #325 ready to merge (`78570611`).
- 2026-11-20 ~03:20Z: **Shipped.** #328 migration `20261130000200` applied to production after green gates on `68095e99`, and verified. #329 merged (`333c1a79`): logo live, production dry run green. Store 1.2.0 (16): both binaries built on EAS from `e76d8730`; iOS uploaded to ASC (submission `3d4b2ae6…` FINISHED). #322 Preview `5e5f55df` published for device QA. Open: card 03, the ASC and Play steps, the canary secrets, and GitHub scheduled runs (none since 22:17Z).
- 2026-11-20 ~01:10Z: #324 merged with the founder's approval (`e8a6ee54`). bingd.app added to this cloud environment's allowed hosts (founder-approved) so the photo could be checked: it is live and byte-identical. Canary blocked on missing GitHub Environment secrets.
- 2026-11-19 23:07Z: Lane A pushed `release/2026-11-19-store-1.2.0` (`5821cb36`); release gate passed (actions run 44632916599). The production build stops before upload: EAS stores `GOOGLE_SERVICES_JSON` as a SECRET file variable, which the CLI here can't read. Nothing was built or submitted. Founder decision needed: run the two build commands locally, or make that variable Sensitive.
- 2026-11-19 ~22:55Z: founder decisions. (1) Build 1.2.0 for iOS and Android from one release commit: lane A building. (2) Welcome email approved: lane B merging #324 after the 23:23Z run, then deploy check and canary. (3) Agent may run the real-history benchmark, but there is still no way to give it a read-only DB credential (the secure form can't carry DB passwords) and the Management-API workaround was refused by the session's permission checks, so lane C is waiting on the founder.
- 2026-11-19: Lane C opened #327. No user rows were read; the production queries covered catalogue/config totals and an `EXPLAIN` only. Benchmark tooling now separates titles that never entered the pool from titles that were in it but ranked low.
- 2026-11-19: Lane A opened #326. Live iOS is 1.1.0 (15), last submitted 2026-09-26. Live code is OTA `a3300bf0`. Play has no upload service account, so the Play upload is manual.
- 2026-11-19: Lane D opened #325. Correction to the brief: Onboarding 2.0 (#305) shipped in release 1115 even though its PR is still an open draft. Release records since 11-15 exist only on the unmerged `ops/preview-1115-records`.
- 2026-11-19: Lane B test delivered to the founder's inbox (Resend id above). Found along the way: since the founder's account handle changed earlier that day, the live email's "follow me" link has been dead. #324 fixes it, but the live email keeps the dead link until #324 merges.
- 2026-11-19: lanes A–D launched in isolated worktrees. Founder photo found in Drive
  (`founder-cafe-tea-square.jpg`). The Nov-19 screenshot attachments are not available to the
  cloud session.
