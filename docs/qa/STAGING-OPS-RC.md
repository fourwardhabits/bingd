# Staging ops for the founder QA release candidate (#263 + #265)

**Scope:** the founder QA release candidate on `qa/founder-rc-2026-11-11`, draft PR #266: #263 (`1f3a4ea4`) plus #265 (`c9b42bf1`), merged `--no-ff`. **This replaces the earlier seven-migration plan** (#263 §7 and `docs/release/claim-push-batch-reconciliation.md` §4) for this build. Do not mix the two.

**Rules for every step**
- **Each numbered step is a separate founder approval.** Run nothing ahead of its approval. Stop at the first failed check and report it; do not improvise a fix on staging.
- **Staging only:** project `fjxhcbowoxuzulwirzyr` (`STAGING_REF` in `config/backends.cjs`). Never production. Check the ref on every command.
- **Flags stay off throughout.** No step sets any `proactive.*` key, `push.delivery_enabled`, `release.push_enabled` or any other `app_config` value. Turning one on is a separate decision after QA.
- **Secrets: names only.** Never print, copy, paste or set a secret value. Setting one is its own approval (step 4c).
- **Source commit.** Everything runs from a clean checkout of the RC.
  - **Build-source commit:** `460a9809d9ec5658a1328fd7aae9339e039d1de0` (`460a980`, the IMDb copy fix of 2026-11-11). It is the last commit that changes app, database or function source.
  - **Docs only after it:** every later commit on the branch changes `docs/` only. The branch head named in the latest `HANDOFF-COMPLETE` comment on #266 is therefore equivalent for every step here. Check with:
    ```bash
    git diff --stat 460a980 HEAD -- . ':!docs'
    ```
    It must print nothing.
  - **On the OTA release branch (`release/2026-11-11-rc266-ota`, #267):** two later commits change source: `d6cd6e9` (the photo-permission string, `app.config.ts`) and the self-reaction reversal (`20261115000100`, reaction client code and tests). Migration 12 in step 2 comes from the reversal; run steps 2–3 from a checkout that contains it.
  - **Moving from `47eef0c`:** the earlier head changed only by `460a980`, which touches `src/features/import/*` (copy, a comment and tests) and `docs/product/imdb-import.md`. No migration, Edge Function or `supabase/config.toml` changed. `git diff 47eef0c 460a980 -- supabase` is empty.

## Step 0: gate (read-only)

**Do**
1. CI on the RC head is green on #266: **Typecheck, lint, test, database**, and **Concurrency suite (real PostgreSQL)**. Cloudflare Pages is a preview only.
2. Check out the RC head and confirm `git rev-parse HEAD` equals the SHA in the latest `HANDOFF-COMPLETE`, that `git status` is clean, and that the docs-only check above prints nothing.
3. Link the staging project, then read its state:
   ```bash
   npx supabase link --project-ref fjxhcbowoxuzulwirzyr
   npx supabase migration list --linked
   npx supabase secrets list --project-ref fjxhcbowoxuzulwirzyr
   npx supabase functions list --project-ref fjxhcbowoxuzulwirzyr
   ```
4. Record the current flag values; step 3 compares against them:
   ```sql
   select key, value from app_config
    where key like 'proactive.%' or key in ('push.delivery_enabled', 'release.push_enabled')
    order by key;
   ```

**Expected**
- `migration list`: everything applied remotely is a **prefix of the 12 files in step 2**, in order. A target with none of them (production) has `20261024000500` as its latest. Staging already has the first 11 (#267: applied 2026-11-11), so its latest is `20261114000400` and step 2 must show `20261115000100` alone. If anything else newer is applied (for example an Engine V2 `20261111…` file), **stop**: the push would need `--include-all` or a repair, and that is a separate decision (`claim-push-batch-reconciliation.md` §3).
- `secrets list`, **names only**: `TMDB_ACCESS_TOKEN` or `TMDB_API_KEY` is present (`tmdb-adapter` and `letterboxd-import` read either). If neither is, step 4c applies. The platform's `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present.
- `functions list`: note each function's current version so it can be rolled back.
- Flag read: `push.delivery_enabled` and `release.push_enabled` as they are today. No `proactive.*` rows exist yet, because they arrive with `20261028000100`.

**Rollback:** nothing to roll back; this step only reads.

## Step 1: deploy `letterboxd-import`

> **Status (2026-11-11):** being run separately by the founder's operator, **from `47eef0c`**.
> - **No redeploy is needed:** the function's source at `47eef0c` and at `460a980` (and the RC head) is **identical**. `supabase/functions/letterboxd-import` is the same git tree, `be6b5299fbcdd39acc23dc3db5749669664346e5`, at both, and `supabase/config.toml` is unchanged.
> - Record the deployed version from `functions list` for rollback.

**Why first:** against the old schema it behaves exactly as today. A claim without `provider` takes the Letterboxd path, and resolve is called with the old arguments. Deploying it *after* the migrations would leave one window where IMDb TV rows are title-searched as movies and settle unmatched (`docs/product/imdb-import.md` §4).

**Do**
```bash
npx supabase functions deploy letterboxd-import --project-ref fjxhcbowoxuzulwirzyr
```
`supabase/config.toml` keeps `[functions.letterboxd-import] verify_jwt = true`.

**Verify**
- `functions list` shows a new version.
- One Letterboxd import on a staging account (for example `bingdtest2`) still completes and still reads "Letterboxd".

**Rollback:** redeploy the previous version from the commit it was built from (step 0 recorded it).

## Step 2: `db push --dry-run` (read-only)

**Do**
```bash
npx supabase db push --linked --dry-run
```

**Expected: exactly these 12 files, in this order, and nothing else** — or, where step 0 found the first N already applied (staging), exactly files N+1 to 12. On staging with the first 11 applied, that is **`20261115000100` alone**. `--include-all` must not be needed.

| # | File | From | Purpose |
|---|---|---|---|
| 1 | `20261028000100_a_notice_that_waits_its_turn.sql` | #254 | Proactive ledger, caps and the kill switch (all seeded **false**). Drops `claim_push_batch(integer)` and creates the two-argument claim. |
| 2 | `20261028000200_a_watchlist_worth_hearing_about.sql` | #254 | Watchlist-social and resurfacing candidates, gated by the generation switch (off). |
| 3 | `20261031000100_a_season_worth_waiting_for.sql` | #254 | Season-premiere awareness, gated by its own switch (off). Rebuilds the claim. |
| 4 | `20261101000100_the_excerpt_rule_on_this_branch.sql` | #254 | Puts remediation's comment-excerpt rule onto the two-argument claim. |
| 5 | `20261110000100_a_reaction_comes_from_somebody_else.sql` | #249 | Refuses a reaction to your own post or comment. **Reversed by 12**; already applied on staging, and applied as is everywhere (it is never edited). |
| 6 | `20261112000100_affinity_ends_at_a_block.sql` | #254 | A block ends proactive affinity. |
| 7 | `20261113000100_an_import_from_more_than_one_place.sql` | #261 | IMDb import (provider column, IMDb matcher and applier); claim carries the provider. Whole TV shows stay *unsupported*. |
| 8 | `20261114000100_a_show_is_a_category_of_its_own.sql` | #265 | Adds `tv_shows` to `ranking_category`, in a file of its own. |
| 9 | `20261114000200_a_show_ranked_on_its_own.sql` | #265 | Series rank in `tv_shows`; series no longer refused by `_assert_loggable`; same-pool comparison guard; profile counts (Candidate A); no show goals. |
| 10 | `20261114000300_an_update_that_knows_where_it_came_from.sql` | #265 | Update Show provenance (`linked_placement_id`); re-signed `rank_again` / `rank_rebucket` / internals; TV update posts. |
| 11 | `20261114000400_a_show_counted_once.sql` | #265 | `taste_match`, `people_taste_matches` and `group_picks` count one series once. |
| 12 | `20261115000100_a_reaction_from_anyone.sql` | founder decision 2026-11-11 | **Reverses 5:** an author can react to their own post and comment again. Removes only the 42501 refusal from `set_reaction` and `_set_comment_reaction`; an author is still never notified of their own reaction. Grants unchanged. |

**Stop if** the list differs in any way: count, names, order, or an `--include-all` prompt.

**Rollback:** nothing to roll back; this step only reads.

## Step 3: apply the 12 migrations (on staging, whichever of them remain)

**Do:** one push, after a fresh dry-run shows the same files as step 2 (production: all 12; staging with 1–11 applied: `20261115000100` only).
```bash
npx supabase db push --linked
```
- **Use `db push` only.** It applies each file in its own transaction, which `20261114000100` needs: a new enum value cannot be used in the transaction that added it. Never concatenate the files or apply them with `psql -1`. Verified locally: an all-in-one transaction fails at `20261114000200` with `unsafe use of new value "tv_shows"`.
- If the push stops at `20261114000200` for that reason, `000100` has committed on its own. That is harmless, and a second `db push` continues from `000200`.

**Verify (read-only), straight after:**
```sql
-- 1. Applied: the remote head is 20261115000100
--    (npx supabase migration list --linked shows all 12 as applied)

-- 2. Exactly one row: claim_push_batch(integer,timestamp with time zone)
select oid::regprocedure from pg_proc where proname = 'claim_push_batch';
-- false, false, true
select has_function_privilege('authenticated', 'claim_push_batch(integer,timestamptz)', 'execute'),
       has_function_privilege('anon',          'claim_push_batch(integer,timestamptz)', 'execute'),
       has_function_privilege('service_role',  'claim_push_batch(integer,timestamptz)', 'execute');

-- 3. Flags: no proactive switch on, and the two push flags exactly as recorded in step 0
select key, value from app_config where key like 'proactive.%' and value = 'true'::jsonb;  -- 0 rows
select key, value from app_config where key in ('push.delivery_enabled', 'release.push_enabled');
select proactive_status();   -- every switch false, no candidates
select push_drain_status();  -- healthy

-- 4. TV ranking is in place, and nothing was backfilled into it
select 'tv_shows' = any (enum_range(null::ranking_category)::text[]);  -- true
select rankable_category('series');                                     -- tv_shows
select count(*) from rankings where category = 'tv_shows';              -- 0

-- 5. Re-signed RPCs: only the new forms exist, and clients can call them
select oid::regprocedure from pg_proc where proname in ('rank_again', 'rank_rebucket');
-- rank_again(uuid,taste_bucket,uuid,boolean,uuid,uuid), rank_rebucket(uuid,taste_bucket,uuid,uuid)
select has_function_privilege('authenticated', 'rank_again(uuid,taste_bucket,uuid,boolean,uuid,uuid)', 'execute'),
       has_function_privilege('authenticated', '_assert_linked_show_update(uuid,uuid,uuid)', 'execute');
-- true, false

-- 6. Self-reactions are accepted again (20261115000100), with the grants as they were
select proname, prosrc like '%cannot react to your own%' as refuses
  from pg_proc where proname in ('set_reaction', '_set_comment_reaction');
-- set_reaction false, _set_comment_reaction false
select has_function_privilege('authenticated', 'set_reaction(uuid,uuid,text)', 'execute'),
       has_function_privilege('anon',          'set_reaction(uuid,uuid,text)', 'execute'),
       has_function_privilege('authenticated', '_set_comment_reaction(uuid,text)', 'execute'),
       has_function_privilege('authenticated', 'set_comment_reaction(uuid,uuid,text)', 'execute');
-- true, false, false, true
```

**Lock and backfill notes:** these are small at staging's size; for production they are listed in the PR body.
- Non-concurrent index builds: `watchlist_by_title` (#254), `media_items_imdb` (#261, partial; empty at build) and `ranking_placements_linked` (#265, partial; empty at build).
- New check constraints scan their tables once under an exclusive lock: `import_jobs`, `media_items`, `imported_titles` and `import_rows`.
- Column adds are nullable or use constant defaults, so they are metadata-only.
- The only backfills are the defaults `import_jobs.provider = 'letterboxd'` and `imported_titles.providers = '{letterboxd}'`. There are no other updates of existing rows.

**Rollback:** forward migrations only. Nothing in the 12 files deletes user data.
- **Proactive (1–4, 6):** every switch is already off. That is the rollback.
- **#249 (5) and its reversal (12):** together they leave `set_reaction` / `_set_comment_reaction` as they were before #249. Refusing self-reactions again would be a new forward migration and a new founder decision; it is not a rollback of this release.
- **#261 (7):** the import entry switch in `letterboxd-production-promotion.md`, or `unschedule_import_drain()`.
- **#265 (8–11):** `tv_shows` cannot be removed from the enum. A forward migration restores the previous `rankable_category` / `_assert_loggable` (series refused again) and the previous `_rank_*` / `rank_again` / `rank_rebucket` / `_correction_follows_latest_watch` / `taste_match` / `people_taste_matches` / `group_picks` definitions. Before that, decide whether to `rank_unrank` any `tv_shows` rows written meanwhile.
- **If a second `claim_push_batch` overload ever appears:** confirm the two-argument form exists, then an operator runs `drop function claim_push_batch(integer);` and follows it with a forward migration.

## Step 4: Edge Function deploys, one at a time

#265 changes no Edge Function: `git diff 1f3a4ea4 <RC head> -- supabase/functions` is empty. Two functions change against what staging runs, besides `letterboxd-import` (step 1). **Deploy each one on its own approval, and verify it before the next.**

### 4a. `push-sender`

**Do**
```bash
npx supabase functions deploy push-sender --project-ref fjxhcbowoxuzulwirzyr
```
This one deploy carries #254's goal and proactive copy, #261's provider naming and #263 §5's import-completion copy.

**Verify**
- The push-sender logs show no `is not unique` and no `PGRST203`, and `push_drain_status()` is healthy.
- A follow between two staging accounts produces its reactive push.
- The `goal_completed` copy goes live at this step; it is not behind a switch.

**Rollback:** redeploy the previous version (step 0). It ignores the new job keys.

### 4b. `tmdb-adapter` (#262)

**Do**
```bash
npx supabase functions deploy tmdb-adapter --project-ref fjxhcbowoxuzulwirzyr
```

**Verify**
- An actor page's sorts work, and "Highest rated (TMDB)" honours its thresholds.
- Search still returns titles.
- About 31 extra catalogue rows over time is expected (#262).

**Rollback:** redeploy the previous version (step 0).

### 4c. TMDB key: only if step 0 found neither name

Do this only if step 0 found neither `TMDB_ACCESS_TOKEN` nor `TMDB_API_KEY`. It is a separate founder approval, and the founder sets the value. It is never typed into a chat or a file in this repository.
```bash
npx supabase secrets set TMDB_ACCESS_TOKEN --project-ref fjxhcbowoxuzulwirzyr   # value entered by the founder
```

**Verify:** `secrets list` shows the name. An IMDb import's provider tier resolves a title that is not in the catalogue.

**Rollback:** `npx supabase secrets unset TMDB_ACCESS_TOKEN --project-ref fjxhcbowoxuzulwirzyr`.

## Step 5 (final): internal Preview build, Android and iOS

**Why a build and not an OTA:** #241's photo-permission string changes the native fingerprint.
- At `460a980` (and so at the RC head): Android `0e89d2907c2d…` and iOS `464f06a54d7d…`, the same as at `47eef0c`, #263 and #265. The copy fix is JS only.
- Against `58c2de7`, the only differing fingerprint source is `expoConfig`, and that is the permission string.
- An OTA to the existing Preview binary would be refused on runtime.

**Do:** from the RC head (equivalent to `460a980`; see Rules), clean tree, one build per platform, internal distribution.
```bash
npm run build:preview -- --platform android
```
```bash
npm run build:preview -- --platform ios
```

**Verify**
- Each build's runtime version equals the fingerprint above.
- The build's backend is staging; the environment badge says Preview.
- Install on the founder's Android phone and iPhone, then run `docs/qa/FOUNDER-QA-CHECKLIST-RC.md`.

**Rollback:** keep the previous Preview install. A build changes nothing server-side.

**Not in this plan:** turning on any flag, any production step, a Beta or Production build, an OTA, a store action, and merging any PR.
