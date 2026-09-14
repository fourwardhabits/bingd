# Letterboxd — production promotion manifest

**Status: PREPARED, NOT EXECUTED.** Written 2026-09-14 after Round 3 physical QA passed; revised
the same day onto current main (`a9aa5ae`, after Search #154 reached production). Nothing
Letterboxd-related has been run against production (`abheeqyjzekiowkztfxv`). Execute only after
the founder's final preview QA on the current-main preview OTA and an explicit go.

**Do not `supabase db push` blindly.** Production is past these migrations' timestamps, the CLI
applies statements outside a transaction, and the files are not idempotent. Every step below
names exactly what runs, in dependency order, with its check.

---

## 0. State this manifest was written against

| Thing | Value |
|---|---|
| Production migrations | 123 applied, latest `20260919000100` (Search #154, applied 2026-09-14 by the Search session; 0 pending, 0 orphan) |
| Pending for Letterboxd | exactly the 17 files `20260917000100` … `20260917001700`, **all older than the latest applied** (so `--include-all`) |
| `origin/main` | `a9aa5ae` (Search #154, squash); newest migration `20260919000100` (already on production) |
| Function overlap with main-only migrations | none. `20260916000200` and `20260918000100` re-emit none of the 37 Letterboxd functions; `20260919000100` defines only `tmdb_put_people_index` and alters `provider_list_cache` |
| Production Edge Functions (read 2026-09-14) | `tmdb-adapter` **v13** = `a9aa5ae`'s adapter exactly, **without** the `ids` hunk; `push-sender` v4; **no** `letterboxd-import` |
| Staging (proof environment) | 141/141 incl. all 17 and `20260919000100`; `tmdb-adapter` v20 = `a9aa5ae` + `ids` hunk (the production target); `push-sender` v5; `letterboxd-import` v14; cron `bingd-import-drain` every 10 s, `bingd-import-maintenance` every minute |
| **Production client source** | `integration/letterboxd-main` at the head named in its PR (§F): current main plus the Letterboxd branches, nothing preview-only |
| Final preview source | `preview/letterboxd-main` (head and update ids in `docs/release/preview-qa-round-3.md` and the PR) = the release source plus the staging-separation overlay only (§F) |
| Owning branches | `feat/letterboxd-import` (this file), `feat/letterboxd-onboarding-step` `60cb9c2`, `fix/onboarding-score-confirmation` `f3b5acb`, `feat/comparison-memory-aids` `c88653b`, `fix/invite-share-label` `683f41b`, `fix/unranked-prompt-dismiss` `ec2f074`, `polish/final-ui-consistency` `b91b92a` |
| Store binaries | public iOS Build 12 runtime `61efbf1789da…` and Android versionCode 10 runtime `c5ad66c8b509…`, both **matched** by the release source tree (computed on `aad19b7`, 170 and 172 sources); no native build needed |

---

## A. Migrations, in apply order

All 17 are required; later files redefine functions from earlier ones, so they apply as a set
and in order. None uses `LOCK TABLE`, `CONCURRENTLY` or `SET LOCAL`. Every redefinition of a
function the **current production client** uses is additive (checked against main's newest
definitions): `claim_push_batch` (+2 jsonb keys), `_push_eligible` (+3 import types),
`_apply_notification_preference` (+import early return), `_leaderboard_counts`
(+`um.source <> 'imported'`), `_award_touch_user_media` / `_award_untouch_user_media`
(+`_importing()` guard). No return type changes; `my_notifications` is not redefined. Every new
predicate is inert until an imported row exists, so the live app is unaffected by the schema
alone.

| # | File | Purpose | Notes for production |
|---|---|---|---|
| 1 | `20260917000100_a_history_that_came_from_somewhere_else` | provenance tables (`imported_titles`, `imported_watches`, `letterboxd_matches`), the import silence triggers on `feed_events`/`notifications`, leaderboard predicate, `collection_counts()` | **index on `user_media`** (partial, non-concurrent); BEFORE INSERT triggers on hot tables |
| 2 | `…000200_a_native_action_wins` | a native action takes provenance (triggers on `user_media` update, `rankings` insert) | trivial per-row cost |
| 3 | `…000300_an_import_that_runs_itself` | the async pipeline: job/row columns, RPCs `import_create/stage/ready/status`, worker `_drain_import_jobs`, provider claim/resolve, `schedule_import_drain` | re-validates `import_rows` CHECK and unique indexes — safe because production has no import rows (verify in preflight) |
| 4 | `…000400_…keeps_only_what_it_needs` | retention, 2 MiB page bound | — |
| 5 | `…000500_starting_over_means_starting_over` | `import_discard` | — |
| 6 | `…000600_an_import_that_actually_runs_and_lets_go` | redact-on-complete trigger; **DO block installs the cron drain** (`create extension if not exists pg_net/pg_cron`, `schedule_import_drain()`) | drain goes live mid-apply; idle with no jobs; a failure is a NOTICE, not an error |
| 7 | `…000700_…whether_the_importer_is_running` | `import_drain_status()` | — |
| 8 | `…000800_an_off_switch_for_the_importer` | `unschedule_import_drain()` | the kill switch |
| 9 | `…000900_a_mapping_one_account_cannot_assert` | two-account match trust (`letterboxd_match_claims`), clears `letterboxd_matches` | the delete is a no-op on production (empty) |
| 10 | `…001000_a_summary_that_counts_what_happened` | honest settle counts | — |
| 11 | `…001100_a_ceiling_on_a_whole_import` | `import.max_job_rows` 50 000, `import.max_job_bytes` 32 MiB | — |
| 12 | `…001200_an_archive_nobody_came_back_for` | abandoned-job sweep, `import.abandoned_hours` 24 | reschedules the drain (DO block) |
| 13 | `…001300_a_trusted_mapping_that_still_has_to_agree` | read-side trust guard | — |
| 14 | `…001400_an_import_that_arrives_with_its_posters` | poster nudge → `tmdb-adapter` `enrich` with `ids` | **indexes on `user_media` (partial) and `watchlist` (full), non-concurrent**; **requires the `ids`-aware adapter first** (§B, trap) |
| 15 | `…001500_an_import_that_tells_you_how_it_went` | lifecycle notifications trigger; push eligibility; claim carries job id | **two partial unique indexes on `notifications`** (non-concurrent); drops/recreates `notifications_silent_during_import` |
| 16 | `…001600_a_profile_that_counts_what_you_watched` | `profile_title_counts(uuid)` | **the new client calls it** — must exist before the client OTA |
| 17 | `…001700_an_import_that_keeps_up` | scale gate: provider leases, `_import_provider_release`, `_import_provider_resolve(uuid,uuid,p_final default false)` (drop + create), budgeted 10-second drain + minute maintenance job, cron history pruning | seconds scheduling needs pg_cron ≥ 1.5, else falls back to one minute and says so in `import_drain_status()` |

**Lock exposure.** Five non-concurrent index builds hold a SHARE lock on `user_media` (×2),
`watchlist`, and `notifications` (×2) for the length of a scan. At current production volume this
is expected to be seconds (UNVERIFIED — count the rows in preflight). Apply in a quiet window.

**Rollback.** Migrations are forward-only (applied files are immutable). The practical rollback
is to stop the worker (§8) and ship the previous client; the schema is inert without imports.

---

## B. Edge Functions

| Function | Source for production | Secrets / config | Order |
|---|---|---|---|
| `tmdb-adapter` | **main's adapter (`a9aa5ae`, incl. Search #154) plus the Letterboxd `ids` hunk**, which is exactly `supabase/functions/tmdb-adapter` in the release source (`git diff a9aa5ae integration/letterboxd-main -- supabase/functions/tmdb-adapter` shows only `index.ts` +27/−2 and `store.ts` +20/−6). *Not* the preview-qa-r3 copy, which predates #143/#147/#151/#154 and would roll back Search. Production v13 is `a9aa5ae` without the hunk; `20260919000100` is already applied, so the Search function the adapter needs exists. The hunk: `dueForEnrichment(db, limit, only?)` in `store.ts` (empty `only` → `[]`, else `.in('id', only)`); in `index.ts` `idList(body.ids, limit)` (absent → whole backlog as before, non-array → nothing, uuids only, capped), and `remaining` counted only when `ids` is absent. Staging runs exactly this union (v20). | existing TMDB secrets | **FIRST**, before migration 14. Backward compatible: no `ids` behaves as today. |
| `push-sender` | main's `push-sender` plus the Letterboxd `copy.ts` change (`import_job_id`, `import_counts`, `importJobId`, `importContent()` for the three types) | none new | before or with the migrations; tolerates a database without the new fields. Without it, import notifications land in the inbox but send no push. |
| `letterboxd-import` | `supabase/functions/letterboxd-import/{index.ts,match.mjs}` from the release commit, with `supabase/config.toml` `[functions.letterboxd-import] verify_jwt = true` | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` (platform), `TMDB_ACCESS_TOKEN` or `TMDB_API_KEY` (without one it answers `no_provider`: imports still complete, unknown films settle unmatched) | **AFTER migration 17** (it sends `p_final`). Until deployed, the drain's POST 404s harmlessly. |

**Scheduling and config the backend needs** (read by `_import_provider_configured`, the poster
nudge and the push drain alike): `app_config.functions.base_url` and vault secret
`service_role_key`. Production's push drain already uses both, so they are expected present —
**verify in preflight**. Migrations seed every `import.*` key with `on conflict do nothing`.
There is **no `import.enabled`**; the server-side off switch is `unschedule_import_drain()`.

**Deploy from a clean clone of the release commit** (never the primary checkout, which carries
uncommitted `tmdb-adapter` edits; never a junctioned worktree).

---

## C. Notifications and deep links

- Types `import_started`, `import_completed`, `import_failed`; exactly once per job transition
  (trigger + partial unique indexes); exempt from category preferences (operational, like
  `follow_request`); push-eligible.
- Tap → `/settings/import?job=<uuid>` inside the app. **No web route, universal link, AASA or
  assetlinks change is required.** APNs/FCM unchanged.
- The current production client never sees these rows (they exist only after somebody imports
  with the new client).

---

## D. TMDB adapter delta

Exactly the `ids` narrowing in §B, on top of main. It exists so the poster nudge enriches the
titles an import brought in, by id, instead of the catalogue's whole backlog. **Trap:** once
migration 14 is applied with cron live, an adapter that ignores `ids` enriches 25 arbitrary
backlog titles a minute for every recent watchlist add or import, for three hours each, and the
intended titles never get posters. Deploy the adapter first.

---

## E. App config

None. No `EXPO_PUBLIC_*` flag, no `app.config.ts` change, no `eas.json` change, no new
`app_config` row beyond those the migrations seed. (The staging-separation branch changes
`app.config.ts` for non-production variants only and is **not** part of this release.)

---

## F. Production client source composition

**Do not ship `integration/preview-qa-r3`.** It is based on `da23d15` and lacks main's
discovery, For You V2, Search/Cast, Similar and landing work; publishing it would roll those back.

**Composed (2026-09-14): `integration/letterboxd-main`**, first-parent from `origin/main`:

1. `feat/letterboxd-import`: importer, migrations 1–17, functions, notifications, profile counts,
   posters. Conflicts: `app/onboarding/taste.tsx` and `ProfileScreen.test.tsx` keep main's
   plain-text `bingd` (#149); `src/lib/analytics.ts` keeps both event sets.
   `supabase/tests/perf/import-staging-run.mjs` is **left out**: it loads the staging QA
   cohort's `connect()` and creates `qa_bench_*` accounts.
2. `feat/letterboxd-onboarding-step` (`60cb9c2`): the optional step, final casing, help sheet,
   layout fix. Conflict: `docs/design/screens.md`.
3. `fix/onboarding-score-confirmation` (`f3b5acb`): full reveal in onboarding.
4. `feat/comparison-memory-aids` (`c88653b`): the Details sheet. Conflicts: the title page keeps
   Similar and takes `formatShortDate` from `@/lib/dates`; `RankingSheet.test.tsx` keeps both
   blocks; the analytics vocabulary is 38 names.
5. `fix/invite-share-label` (`683f41b`), `fix/unranked-prompt-dismiss` (`ec2f074`).
6. `polish/final-ui-consistency` (`b91b92a`): `Reviews (N)`, the Genres and About Match sheet
   gutters, and the design-system layout invariants.
7. Integration-only test reconciliations: the award-queue test presses the fifth reveal's Done
   (from `bda2070`); `no-community-anchor` pins the comparison card's read as
   `id, kind, title, poster_path` (`kind` feeds `comparison_info_opened`).
8. `origin/main` `a9aa5ae` (Search #154) merged last, clean. The adapter still differs from main
   only by the `ids` hunk.

**Not in the production release:** `chore/physical-staging-separation` (preview identity and
staging backend; applied only as the preview overlay, `preview/letterboxd-main`),
`chore/staging-qa-cohort` (staging-only, refuses production), the staging perf run script.
`app.config.ts`, `eas.json` and `.github/` are identical to main in the release source.

**Gates on the release source** (see the final report for numbers): typecheck, lint, full Jest
`--runInBand`, `npm run test:db` serialized, `npm run test:race`, `npm run test:config`,
`npm run test:web`, Deno `tmdb-adapter` and `push-sender`, independent read-only review, and
**fingerprints equal to `61efbf1789da…` (iOS production) and `c5ad66c8b509…` (Android beta
lane, versionCode 10)**. After the PR merges, the release-gate workflow must be green for the
merge SHA before §6.

---

## Staged rollout

### 1. Preflight — read-only, stop on any surprise

- Founder go recorded; `integration/letterboxd-main` merged to main by PR (no other commits in
  between, or re-gate); release-gate green for the merge SHA.
- `supabase migration list --project-ref abheeqyjzekiowkztfxv` → remote latest `20260919000100`;
  pending = exactly the 17 `20260917…` files; no orphans.
- On production (read-only SQL): `select count(*) from import_jobs` and `from import_rows` → 0;
  row counts of `user_media`, `watchlist`, `notifications` (lock window estimate);
  `select extversion from pg_extension where extname in ('pg_cron','pg_net')`;
  `select value from app_config where key = 'functions.base_url'` → non-null;
  `select count(*) from vault.decrypted_secrets where name = 'service_role_key'` → 1.
- `supabase secrets list --project-ref abheeqyjzekiowkztfxv` → a TMDB secret exists.
- `select jobname, schedule from cron.job;` → note the existing jobs (push drain, trending) so §5
  can tell the two new import jobs apart.
- Record the current production (iOS) and beta (Android) update group ids from
  `eas update:list --branch production` / `--branch beta` (rollback targets; last known beta group
  `23d87753…` from `5d2ac1a`, verify) and the deployed function versions (`tmdb-adapter` v13,
  `push-sender` v4, read 2026-09-14).
- Confirm a recent backup / PITR point (docs/release/backup-and-recovery.md).

### 2. Functions that must lead (backward compatible)

From a clean clone of the merged main commit:

1. `supabase functions deploy tmdb-adapter --project-ref abheeqyjzekiowkztfxv`
2. `supabase functions deploy push-sender --project-ref abheeqyjzekiowkztfxv`

Check: the new versions are v14 (`tmdb-adapter`) and v5 (`push-sender`); in-app Search still
returns grouped All results and Cast (the #154 path must survive the redeploy); an `enrich` call
without `ids` behaves as before and reports `remaining`.

### 3. Schema

1. `npx supabase db push --project-ref abheeqyjzekiowkztfxv --include-all --dry-run`. The list
   must be exactly the 17 `20260917…` Letterboxd files and nothing else. Search's
   `20260919000100` is already applied on production (2026-09-14), so it must **not** appear; if
   it does, production's state is not what §0 records, so stop and re-read §0.
2. Same command without `--dry-run`, in a quiet window.
3. If a file fails part-way: stop. Do not re-run the push (files are not idempotent); inspect
   which statements applied, finish that file by hand, then continue.

### 4. Worker

`supabase functions deploy letterboxd-import --project-ref abheeqyjzekiowkztfxv` (with
`config.toml`, `verify_jwt = true`). Only after migration 17 has applied.

Check: `supabase functions list --project-ref abheeqyjzekiowkztfxv` shows `letterboxd-import` v1
ACTIVE; `supabase secrets list` still shows a TMDB secret (the function answers `no_provider`
without one). **No new secret is added by this release**: `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are platform-provided, and the cron path reads the existing
`app_config.functions.base_url` and vault `service_role_key`.

### 5. Backend verification

- `supabase migration list --project-ref abheeqyjzekiowkztfxv` → 140 applied, 0 pending, 0 orphan.
- `select import_drain_status();` → `job` non-null, maintenance job present, schedule
  `10 seconds` (or a documented one-minute fallback when pg_cron < 1.5), `provider_ready: true`.
  Any other shape: `select unschedule_import_drain();` and stop.
- `select _push_eligible('import_completed');` → true.
- `select * from profile_title_counts('<founder user id>');` as the founder → sane Movies/TV.
- `select jobname, schedule from cron.job;` → the jobs recorded in preflight plus
  `bingd-import-drain` and `bingd-import-maintenance`, nothing else new.
- `select count(*) from cron.job_run_details where jobname like 'bingd-import%' and status <> 'succeeded' and start_time > now() - interval '10 minutes';` → 0 (idle ticks succeed).
- `npm run test:remote -- --target production` (anon smoke), if it covers the importer RPC surface.

### 6. Client OTA (only after 1–5 are green)

From the merged, gated main commit, per `docs/release/safe-update-runbook.md` and the release
script's guards (main or `release/*`, clean tree, release-gate run for the SHA):

Publish from a **clean clone** at the merge SHA with its own `npm ci` (never a junctioned
worktree), `.env` and `google-services.json` copied in, and the lane fingerprint checked
**before** publishing (it must equal the value below, from ~170/172 sources):

- **iOS production**: `APP_VARIANT=production BINGD_LANE=production npx expo-updates fingerprint:generate --platform ios`
  → `61efbf1789da…` (Build 12), then
  `node scripts/release.mjs update production --platform ios --message "Letterboxd import"`
  (there is no `update:production` npm script).
- **Android beta**: `APP_VARIANT=production BINGD_LANE=beta npx expo-updates fingerprint:generate --platform android`
  → `c5ad66c8b509…` (versionCode 10), then
  `npm run update:beta -- --platform android --message "Letterboxd import"`.

Each publish also emits an inert group for the other platform's runtime. Verify the published
runtime versions equal those values before announcing anything, and record both group ids here.
`release.mjs` publishes at 100%; there is no staged rollout percentage.

### 7. Smoke — founder, production, small real archive

1. Settings → Import from Letterboxd → a small ZIP → **started** push arrives.
2. Leave the app; **ready** push arrives; tapping it opens that job's summary.
3. Collection → Unranked shows imported titles **with posters**; Rank imported movies lands there.
4. Profile Movies counts imported watched titles once.
5. Re-import the same ZIP → "already here", new pair of notifications, nothing duplicated.
6. A fresh signup sees the optional Letterboxd step after Your First Five; Not now carries on.

### 8. Rollback / disable

| Problem | Action |
|---|---|
| Worker misbehaving (provider traffic, errors) | `select unschedule_import_drain();` — stops both jobs; jobs pause in place and resume on `select schedule_import_drain();` |
| Client defect | republish the previous update group recorded in preflight on each channel (`eas update:republish --group …`), per the runbook §4a. Last known: iOS production `f10f6124…`, Android beta `23d87753…`; verify at preflight. The schema and worker can stay: an old client never creates an import |
| Adapter regression | `select unschedule_import_drain();` first, then redeploy `a9aa5ae`'s adapter (production v13 today, no hunk). Without the hunk the poster nudge would drain arbitrary backlog, so the drain stays unscheduled until the hunk is back |
| Push copy regression | redeploy the previous `push-sender` (import notifications still reach the inbox) |
| Schema | forward-only; the schema is inert without imports. Correct with a new additive migration. |

**Known gap:** the importer's entry points (Settings row, onboarding step) have no server-side
switch. With the drain unscheduled a user who imports waits on "Importing…". If a server-side
off switch for the entry points is wanted before launch, it is new work (an `app_config` flag the
client reads).
