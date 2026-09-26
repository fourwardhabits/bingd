# Founder TODO register

**The one list of what is left.** Opened 2026-09-26 at the product freeze, frozen application
source `9d9683a`. When an item is done, replace it with a date and a result. Do not let this
file grow into a plan: if an item needs design, it gets its own doc and a one-line pointer
here.

What is live is in [`../release/production-state.md`](../release/production-state.md). Deeper
specifications of deferred capability are in [`deferred-roadmap.md`](./deferred-roadmap.md);
this register only decides what is next.

---

## The freeze rule

**Application development is frozen as of 2026-09-26.** It reopens only for:

- a crash
- an auth or reliability problem
- a serious functional bug
- a measured performance problem
- analytics or distribution plumbing
- clear user evidence supporting a product change

Visual polish and speculative features go to this register, not into the app. A bug found
during any other task is recorded here with severity, evidence, surface and next step. It is
not fixed in passing.

**Preview is not a long-lived product branch.** A preview candidate is always: current
`origin/main` (the production application) + the preview/staging environment + the staging
backend and data + only the explicitly unreleased fix under test. Preview never accumulates
history of its own that would later have to be reconciled.

---

## CRITICAL / RELIABILITY

| Item | Severity | Evidence / surface | Next step |
|---|---|---|---|
| **Take 1.1.0 through review.** iOS 1.1.0 (15) is uploaded to App Store Connect. Android 1.1.0 (vc15) needs its manual Play upload | HIGH | [`production-state.md`](../release/production-state.md) §Store distribution | Founder: submit for review and roll out. Then run the fresh-install acceptance in [`next-binary-checklist.md`](../release/next-binary-checklist.md) §1 on each store build |
| **Until 1.1.0 is approved, fresh installs get the pre-#198 binaries.** Their first foreground return (from Mail with the sign-in code) can reload onto an empty sign-in form | HIGH during the vibeCoders window | #198; `src/lib/updates.ts` | Nothing to ship. If a sign-up stalls on the day: reopen the app and request a new code. It clears once 1.1.0 is live |
| When a 1.1.0 binary is on a store, set `SHIPPED` in `supabase/tests/legacy-client-compat.test.mjs` to `63694c3` | MEDIUM | The compat table is what proves installed binaries survive a migration | Test-only change, in its own small PR |
| **Grouped post lost on swipe-back or hardware back.** Leaving an Unranked sitting by iOS swipe-back or the Android back button skips `endSitting`, so the grouped Feed post never publishes and an orphan draft remains. Placements are saved | MEDIUM | `src/features/ranking/RankSessionScreen.tsx:150-176`; `app/_layout.tsx:322-323`; `rank_batch_finalize` is the only publisher (`20261023000100`) | Confirm on a device. Then decide: a back handler that calls `endSitting`, or a server sweep that publishes stale drafts |
| Auth email quota. The Supabase ceiling is 30/hour; the Resend plan quota has not been re-read since 2026-09-07 | MEDIUM before any push for sign-ups | `supabase/auth-templates/templates.json` `limits`; `scripts/check-auth-config.mjs` | Read the Resend plan limit. Raising 30/hr means dashboard + manifest in one change |
| Auth identity-link edge case. Google ↔ email linking can't be tested on staging; the 8 unconfirmed production users are the only way a split account could appear (0 today) | LOW | the 2026-09-22 audit | Re-run `scripts/ops/auth-identity-audit.mjs` monthly, or on a report |
| Ranking stalls: 2–4 s comparisons were seen and never attributed | LOW unless it recurs | the Diagnostics sheet (flight recorder) | Only if reported: pull the device's Diagnostics export first |
| Notifications gear on Android. #111 once reported the bell and gear merging on a physical device; the 2026-09-25 fix (plugged ring, maroon gear) has not been seen on Android hardware | LOW | PR #209 | Look once on an Android phone |

## GROWTH / DISTRIBUTION

- **Google Play developer verification (HG-2) has a hard deadline of 2026-09-30.** Confirm
  its status in Play Console.
- The landing page ranking screenshot is stale ("Too tough", the old OR). Re-shoot from
  `02 Screenshots/App Store/` with `web/shots.mjs`.
- Web analytics are one event (`record_invite_open`). Adding *Get bingd clicked* or page views
  needs the privacy policy edited first ([`web-deployment.md`](../architecture/web-deployment.md)).
- `TERMS_STATUS = 'draft'` in `web/build.mjs` waits on a lawyer's read (L-1, founder roadmap
  §10).
- Acquisition and distribution work: [`founder-roadmap.md`](./founder-roadmap.md) Stages 1–3.

## USER-EVIDENCE-DRIVEN PRODUCT

Each of these waits for user evidence. None is scheduled.

- **`ranking.refine_enabled` in production.** Refine is built, on in staging, and off in
  production since 2026-09-23 pending a founder smoke. Turning it on is a flag flip, not a
  release.
- **Letterboxd Lists import**, only if acquisition evidence says importers are blocked by it
  ([`letterboxd-lists-import.md`](./letterboxd-lists-import.md)).
- **A note from the Unranked flow.** The backlog sitting asks the bucket inline and never opens
  the log sheet, so there is no note entry point there. Decide only if people ask for it.
- **Header Done vs summary Done.** Header Done opens the summary, and *Keep ranking* continues
  the same sitting. Confirm that is the intended model.
- **Frozen UX idea: TV seasons list polish.**
  - For a ranked season: the secondary line under the season title shows `#N in TV`, and the
    right side shows the normal maroon score badge.
  - For an unranked season: no "Not ranked yet"; leave the secondary line and score area
    blank.
  - Whole-series ranking semantics do not change.
- **Frozen UX idea: TV season navigation.** Evaluate later whether users can reach season-level
  ranking and logging faster from search and series title pages. Do not optimise clicks
  without first reviewing the overall TV information architecture.
- A stale code comment: `src/features/collection/filters.ts:149-154` says there is no
  watch-date axis. The behaviour is correct; fix the comment whenever that file is next touched.

## PERFORMANCE

- **Feed RLS per-row cost.** Measured 2306 ms → 26 ms with a set-based rewrite, and never
  shipped. Do it only after a fresh production measurement shows the cost (PR #206 has the
  diagnosis).
- For You and comparison latency shipped in #206. Re-measure only if users report slowness.

## OPERATIONS / BACKUP

| Item | Size | Action |
|---|---|---|
| **No cloud copy of non-Git assets.** `Documents` is not OneDrive-synced, and no backup destination is set up | about 600 MB, plus 3.5 GB of `design-references` | Pick one cloud folder and copy the list in [`../ops/disaster-recovery.md`](../ops/disaster-recovery.md) §13 |
| Credential files (`02 JSO/`, a stray Apple `.p8` in Downloads) exist only on the laptop | KB | Move them to a password manager |
| No off-platform database export. Supabase keeps 8 daily backups with PITR off, and they are deleted with the project | small | Weekly encrypted `supabase db dump` of production to that cloud folder, and before every production migration |
| PITR is off, so a bad write can cost up to a day | – | Decide whether to buy the add-on |
| `.git/info/exclude` holds the ignore rules for `02 JSO/` and `store-assets/google-play/`, so a fresh clone lacks them. **Adding lines to `.gitignore` moves every lane's runtime fingerprint** | – | Keep them local and re-create them on a new machine (DR §3), or move them into `.gitignore` only in a window that also cuts new binaries |
| `backup-and-recovery.md` and `production-environment.md` still describe the pre-production state of 2026-08-26 | – | Point both at `production-state.md` and the DR runbook, or mark them historical |
| `supabase/functions/README.md` covers only `tmdb-adapter`, not `push-sender` or `letterboxd-import` | – | Add the two sections |
| eas-cli is 21.8.0; 24.x exists | – | Upgrade only with a fingerprint parity check (DR §12) |
| About 40 old worktrees and many stale remote branches | – | Prune per [`production-state.md`](../release/production-state.md). Never `git worktree remove` one with a junctioned `node_modules` |
| The separate Fourward repo (`Documents/Fourward`, branch `wip/may9-safety-snapshot`) has 33 uncommitted changes | – | Outside bingd. Commit or copy it before relying on this laptop |

## DEFERRED / MAYBE

Specified in [`deferred-roadmap.md`](./deferred-roadmap.md); none is planned next:

- predicted score (re-run the harness at 50 users with 20+ movies each)
- unmatched import repair
- Stats / Wrapped
- Watch Next (#183 / #184, parked)
- further share cards
- further Awards
- episode-level tracking
- whole-series ranking
- the push kill switch (#119, a founder decision about its initial value)
- proactive release pushes (the shadow runs; sending is off)
