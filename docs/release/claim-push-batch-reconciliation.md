# `claim_push_batch`: #254 and the IMDb import

**Status (2026-11-11): decided and built; not merged, not applied, not deployed.**

- **Founder decision.** #254 (Affinity B1) is the integration base, and #256 (IMDb +
  Letterboxd import) is rebuilt on top of it as `claude/imdb-import-on-254`. That branch is
  intended to **replace #256**; #256 itself is not edited.
- **Do not merge #256 as it stands.** It would recreate `claim_push_batch(integer)` beside
  #254's function, as §1 explains.
- **This document's scope.** It is the merge and staging sequence for #254 plus the import.
  The proposal that preceded the decision is in this file's history.

## 1. The conflict

`claim_push_batch` is the SECURITY DEFINER function push-sender calls to lease the push
outbox.

- **On `main`** it is `claim_push_batch(p_limit integer default 20)`, last rebuilt by
  `20261024000300` (the comment-excerpt rule).
- **#254.** `20261028000100` drops the one-argument form and creates `claim_push_batch(p_limit
  integer default 20, p_now timestamptz default now())`, which `20261031000100` and
  `20261101000100` rebuild. Every change is additive: the proactive ledger's lock-then-judge
  with `skip locked`, settling of jobs that must not go, the `goal` and `proactive` job facts
  (`deliver_by`, actor names by affinity, season fields), capable-token devices, and
  selected → sent marking. The `import_counts` line is untouched.
- **#256 (as written against `main`)** copied main's one-argument body with **one change**:

  ```sql
  case when n.type in ('import_started', 'import_completed', 'import_failed')
       then n.payload end as import_counts,
  ```

  It replaces the `import_completed`-only line, so the start and failure pushes carry the
  payload's `provider` and push-sender can say "IMDb import started".
- **Together, unreconciled,** they leave two overloads. push-sender's
  `rpc('claim_push_batch', { p_limit })` then matches both, and **every push stops**,
  reactive ones included.

## 2. The final definition (on `claude/imdb-import-on-254`)

- **One function, `claim_push_batch(integer, timestamptz)`.** It is defined last in
  `20261113000100_an_import_from_more_than_one_place.sql`, as #254's `20261101000100` body
  with #256's one line.
- **The import migration's generator now copies it from #254's file**
  (`scripts/migration-generators/imdb-import.mjs`) and applies the same `edit`. Two checks:
  - The emitted function is byte-identical to #254's body with that edit.
  - With #256's inputs, the generator still reproduces #256's file exactly. So nothing else in
    the import migration changed in the rebuild.
- **Grants are restated:** revoked from `public`, `anon` and `authenticated`, and granted to
  `service_role`. The comment is appended, not replaced.
- **No one-argument form, and no wrapper.** Every caller passes one argument (push-sender's
  `rpc(…, { p_limit })`, and the tests' `claim_push_batch(20)`), and resolves to the
  two-argument function through its `p_now` default. Nothing in SQL or cron calls it. A
  separate `claim_push_batch(integer)` would make exactly those calls ambiguous.
- **Exactly one definition at every file boundary,** not just at the end.
  `security-before-proactive.test.mjs` applies the migrations up to each file that rebuilds
  the function and asserts one signature.

## 3. Migration order

| File | From | Notes |
|---|---|---|
| `20261028000100_a_notice_that_waits_its_turn.sql` | #254 (#220) | drops `claim_push_batch(integer)`, creates the two-argument form |
| `20261028000200_a_watchlist_worth_hearing_about.sql` | #254 (#220) | |
| `20261031000100_a_season_worth_waiting_for.sql` | #254 (#220) | rebuilds the claim |
| `20261101000100_the_excerpt_rule_on_this_branch.sql` | #254 (#220) | rebuilds the claim (the body the import copies) |
| `20261112000100_affinity_ends_at_a_block.sql` | #254 (B1) | |
| `20261113000100_an_import_from_more_than_one_place.sql` | import | **renumbered** from #256's `20261111000300` so it sorts after every #254 file |

All versions are unique and in dependency order.

**`--include-all`.** Every file above is newer than `main`'s latest (`20261024000500`), so on
an environment that is current with `main`, a plain `db push` applies all six in date order.

- If a newer-dated migration has already been applied there, the CLI refuses #254's four
  older files until `--include-all` is passed. Candidates are #249's `20261110000100` and the
  Engine V2 `20261111000100` / `20261111000200`.
- In that case, run `db push --include-all --dry-run` and confirm it lists exactly these six
  files, as in `letterboxd-production-promotion.md`.
- The import file itself never needs it relative to #254.

## 4. Merge and staging sequence

**Merge** (founder approval at each step; nothing here is approved yet):

1. Merge #254.
2. Retarget the import PR (`claude/imdb-import-on-254`) to `main`; it is based on #254's
   branch, and after #254 merges its diff is the import alone. Merge it.
3. Close #256 as superseded.
4. Before each merge, CI must be green. That includes `security-before-proactive`,
   `function-grants`, `import-*` and the push-sender Deno tests.

**Staging, then production.** The same sequence on each environment, from the import PR's
merge commit. Each step is a founder decision.

1. **Deploy the `letterboxd-import` Edge Function first.** Against the old schema it behaves
   exactly as today: a claim without `provider` takes the Letterboxd path, and resolve is
   called with the same three arguments. Deploying it after the migrations would be lossy
   for one import: the old function would title-search IMDb TV rows as movies, the database
   would refuse the kind, and those rows would settle unmatched (`imdb-import.md` §4).
2. **Apply the migrations in one push, in date order.**
   - Check the starting point: `npx supabase migration list --linked`.
   - Run `npx supabase db push --linked --dry-run`. It must list exactly the six files in §3,
     in order. Add `--include-all` only under the condition in §3.
   - Then run the same command without `--dry-run`, **once**.
   - On a large production database, build `rankings_by_media_user` (and A1's indexes, if
     they are in the same push) `concurrently` by hand first (`recommendations-v2.md`).
3. **Verify before anything else** (read-only):

   ```sql
   -- exactly one row: claim_push_batch(integer,timestamp with time zone)
   select oid::regprocedure from pg_proc where proname = 'claim_push_batch';
   -- false, false, true
   select has_function_privilege('authenticated', 'claim_push_batch(integer,timestamptz)', 'execute'),
          has_function_privilege('anon',          'claim_push_batch(integer,timestamptz)', 'execute'),
          has_function_privilege('service_role',  'claim_push_batch(integer,timestamptz)', 'execute');
   -- true, true
   select pg_get_functiondef('claim_push_batch(integer,timestamptz)'::regprocedure) like '%import_started%',
          pg_get_functiondef('claim_push_batch(integer,timestamptz)'::regprocedure) like '%proactive_candidates%';
   select proactive_status();    -- all four switches false, no candidates
   select push_drain_status();   -- healthy
   ```

4. **One combined `push-sender` deploy** from the same commit. It carries #254's goal and
   proactive copy and the import's provider naming. Then watch the push-sender logs: no
   `is not unique` and no `PGRST203`.
   - It must be live before `proactive.push_enabled` is ever turned on (#254 §S), and every
     proactive switch stays off.
   - The `goal_completed` push copy goes live at this step; it is not behind a switch.
5. **The app update.** A Preview OTA from the same commit, staging backend. Neither change
   moves `package.json` `scripts` or `app.config.ts`, so `scripts/ota-gate.mjs` should pass
   against the live runtimes.
6. **Functional checks** on staging accounts (`staging-qa-inventory.md`):
   - An IMDb import whose file holds shows. The preview shows "TV shows, not added" with its
     note. The pushes read "IMDb import started" and then "Your IMDb history is ready". The
     summary shows "TV shows matched, not added" on its own line, and nothing of the show
     reaches the collection.
   - A Letterboxd import still says Letterboxd.
   - A follow produces its reactive push.
   - The Reactions default is off for an account that never set it. This is #254's
     unswitched change.

**Rollback.**

- **Imports:** the entry switch in `letterboxd-production-promotion.md`, or
  `unschedule_import_drain()`.
- **Proactive:** every switch is already off.
- **push-sender:** redeploy the previous version. It ignores the new job keys.
- **Schema:** forward migrations only.
- **If a second `claim_push_batch` overload ever appears,** confirm that the two-argument form
  exists, then run `drop function claim_push_batch(integer);` as an operator. That restores
  push-sender at once; follow it with a forward migration.

## 5. What was checked

Local and throwaway only: PGlite and an embedded PostgreSQL 17, with every migration applied
from scratch in order. Nothing remote.

- **Exactly one `claim_push_batch`** after all migrations, `(integer, timestamp with time
  zone)`, SECURITY DEFINER, executable by `service_role` only.
- **At every file boundary,** `security-before-proactive.test.mjs` finds one signature.
- **The full suites** pass on the branch; the counts are in the PR body (`test:db`,
  `test:race`, `jest --ci`, `tsc`, `eslint .`, and push-sender `deno check` / `lint` /
  `test`).
- **`letterboxd-import`** type-checks.
- **Before the decision,** the alternatives were measured. #254 and #256 together, unchanged,
  leave two overloads and fail that test. A guarded #256 merged first would also have worked
  (full `test:db` 2,917/2,917), but it was not chosen.
