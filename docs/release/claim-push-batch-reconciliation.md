# `claim_push_batch`: reconciling #254 and #256

Status: **proposal, 2026-11-11.** Nothing here has been applied, deployed or merged, and #256's
branch has not been edited.

[#254](https://github.com/fourwardhabits/bingd/pull/254) (Affinity B1, which brings #220
forward) and [#256](https://github.com/fourwardhabits/bingd/pull/256) (IMDb import) both
redefine `claim_push_batch`, the SECURITY DEFINER function push-sender calls to lease the push
outbox. Whichever merges second would replace the other's definition. Worse, the two
definitions have different signatures, so together they leave two overloads, and then
**every push stops**, reactive ones included.

## 1. What each changes, against `main`

`main`'s definition is `claim_push_batch(p_limit integer default 20)`, last rebuilt by the
security release (`20261024000300`, the comment-excerpt rule).

**#256** (`20261111000300_an_import_from_more_than_one_place.sql`, head `42feeb4`):

- It copies main's body with **one change**:

  ```sql
  -- main
  case when n.type = 'import_completed' then n.payload end as import_counts,
  -- #256
  case when n.type in ('import_started', 'import_completed', 'import_failed')
       then n.payload end as import_counts,
  ```

- **Why.** `_import_notify` now writes `provider` into every import notification's payload.
  #256's push-sender reads `import_counts.provider` to say "IMDb import started" rather than
  "Letterboxd import started", and the same for failures. A missing provider reads as
  Letterboxd.
- It keeps main's signature, `(integer)`, through `create or replace`, and has no
  `revoke`/`grant` statements.

**#254** (`20261028000100`, rebuilt in `20261031000100` and finally `20261101000100`; head
`60827b5`):

- **The signature changes.** `20261028000100` runs `drop function if exists
  claim_push_batch(integer)`, then creates `claim_push_batch(p_limit integer default 20, p_now
  timestamptz default now())`.
- **Everything else is additive, in ten hunks.** None of them touches the `import_counts`
  line:
  1. Declarations for the proactive arrays.
  2. Lock-then-judge: every claimed proactive candidate is locked `for update skip locked`, and
     one held elsewhere is put back in the queue untouched.
  3. Proactive jobs that must not go (`_proactive_claim_reason`) are settled, as `expired` or
     `suppressed`, and dropped.
  4. The job JSON gains a `goal` key and a `proactive` key.
  5. The `goal` facts for `goal_completed`, and the `proactive` facts: type, `deliver_by`,
     actor names by affinity, and season fields.
  6. Proactive jobs go only to `_proactive_capable_token` devices.
  7. Joins to `proactive_candidates` and `account_context`.
  8. Candidates are marked `selected → sent`, and a proactive job is returned only if it was.
  9. Unchanged from main: the excerpt rule (`_can_read_comment`), the award fields,
     `import_job_id`, and the deletion of claimed-but-unreturned rows.
  10. The only other textual change is one comment.

**They do not conflict in logic.** The combined definition is #254's final body with #256's
one line. #256 cannot carry it on its own: the body locks `proactive_candidates`, which does
not exist without #254.

## 2. The combined definition

The full text is
[`claim-push-batch-combined.sql`](./claim-push-batch-combined.sql), written as a migration but
kept under `docs/release` so nothing applies it by accident. It does four things:

1. **`drop function if exists claim_push_batch(integer);`** This is a backstop. In the
   sequences below, the one-argument form should never exist by then.
2. **`create or replace function claim_push_batch(p_limit integer default 20, p_now timestamptz
   default now())`**, with #254's `20261101000100` body verbatim plus #256's `import_counts`
   line.
3. **Explicit grants.** `revoke execute … from public, anon, authenticated;` then `grant
   execute … to service_role;`.
4. **The function comment**, extended. The comment is appended to; it is not replaced.

Its version must sort **after every migration of both PRs**. It is safe without #256 as far
as push-sender goes: main's start and failure payloads are `{job_id}`, which push-sender reads
as Letterboxd. But main's `import-notifications.test.mjs` pins the start's `import_counts` as
`null`. So it lands together with #256's test change, which is one more reason it belongs to
the PR that merges second.

## 3. Which PR carries it, and the sequence

**Rule:** the PR that merges **second** carries the combined definition, and #256's own file
must never create `claim_push_batch(integer)` where the two-argument form exists.

**Recommended order: #254, then #256** (so #256 carries it). Why:

- #254 merges as reviewed, consistent with main's tests.
- #256 is still a draft, and it is already renumbering its migration.
- No environment ever has two overloads, not even for one file boundary.

### Sequence A (recommended): #254, then #256

**What #256 changes before merge** (its owner makes these; this doc does not):

1. **Rebase onto `main`** once #254 has merged. Resolve the text conflicts in
   `supabase/functions/push-sender/copy.ts`, `src/features/notifications/use-notifications.ts`
   and `app/settings/notifications.tsx` by keeping both sides:
   - in `copy.ts`, #254's `goal`/`proactive` job fields and copy alongside #256's `provider`
     naming;
   - in the two client files, #254's proactive kinds and settings alongside #256's import
     entry.
2. **Delete its `create or replace function claim_push_batch(p_limit integer …)` block.**
3. **Renumber its migration** after main's latest. With #254 merged that is `20261112000100`,
   so for example `20261113000100_…`; that way `db push` needs no `--include-all`. Its test
   and doc references to `20261111000300` are comments only.
4. **Add** `claim-push-batch-combined.sql` as the next version, for example
   `20261113000200_one_claim_for_every_push.sql`, and strip the "NOT A MIGRATION" header.
5. **CI must pass**, in particular:
   - `security-before-proactive.test.mjs`: one overload at every file boundary;
   - `import-notifications.test.mjs`: the start carries `provider`;
   - `function-grants.test.mjs`;
   - the push-sender Deno tests.

**Staging, then production.** Each environment step is a founder decision, in this order:

1. **#254's migrations.**
   - Run `npx supabase migration list --linked` and confirm the environment is current with
     main.
   - Run `db push --dry-run`. It must list exactly #254's five files: `20261028000100`,
     `20261028000200`, `20261031000100`, `20261101000100` and `20261112000100`.
   - Use `--include-all` only if a newer migration, such as the Engine V2 `20261111…` files,
     is already applied.
   - Then run `db push`.
2. **push-sender from the #254 merge commit.** It must be live before
   `proactive.push_enabled` is ever turned on (#254 §S).
3. **Verify** (queries below). Expect one overload, healthy drains, and a reactive push still
   arriving.
4. **#256's migrations**, `db push --dry-run`. It must list exactly #256's two renumbered
   files, with no `--include-all`. Then run `db push`.
5. **#256's Edge Functions** (the import pipeline, per #256's own docs), then **push-sender
   from the #256 merge commit**.
6. **Verify** again, including the IMDb push copy.
7. **OTA last, Preview first.** Publish from the merged commit only after the server steps.
   Neither PR changes `package.json` `scripts` or `app.config.ts` (checked against main), so
   the native fingerprint should not move; `scripts/ota-gate.mjs` confirms it before any
   publish.

### Sequence B: #256, then #254

**What #256 changes before it merges:** it wraps its `claim_push_batch(integer)` block so the
block only runs where #254 has not replaced it:

```sql
do $guard$
begin
  if to_regprocedure('claim_push_batch(integer, timestamptz)') is null then
    execute $create$
      create or replace function claim_push_batch(p_limit integer default 20) … $$;
    $create$;
  end if;
end;
$guard$;
```

Without the guard, a fresh database applies #254's `20261028000100` (the drop) and then #256's
`20261111000300` (the re-create). That leaves two overloads until the combined file runs.
`security-before-proactive.test.mjs` fails on exactly that, and the failure was reproduced.

**What #254 changes after #256 merges:**

1. **Rebase onto `main`** and resolve the same three text conflicts.
2. **Add** the combined file as `20261112000200_one_claim_for_every_push.sql`. It sorts after
   `20261111000300` and after its own `20261112000100`.

**Applying it.**

- #254's October files are older than #256's, so its `db push` needs `--include-all`, after a
  `--dry-run` that lists exactly its six files.
- During that push there is a gap of seconds between `20261028000100` and `20261112000200`
  where import start and failure pushes say "Letterboxd" for an IMDb import. It is cosmetic,
  and there is never a second overload.
- Edge Function and OTA order is as in Sequence A, with #256 first.

### Verification queries (staging; read-only)

```sql
-- Exactly one row: claim_push_batch(integer,timestamp with time zone)
select oid::regprocedure from pg_proc where proname = 'claim_push_batch';

-- false, false, true
select has_function_privilege('authenticated', 'claim_push_batch(integer,timestamptz)', 'execute'),
       has_function_privilege('anon',          'claim_push_batch(integer,timestamptz)', 'execute'),
       has_function_privilege('service_role',  'claim_push_batch(integer,timestamptz)', 'execute');

-- Both true once the combined definition is in
select pg_get_functiondef('claim_push_batch(integer,timestamptz)'::regprocedure) like '%import_started%',
       pg_get_functiondef('claim_push_batch(integer,timestamptz)'::regprocedure) like '%proactive_candidates%';

select push_drain_status();   -- healthy, and no growing backlog
select proactive_status();    -- all four switches false, no candidates
```

**Then check the push-sender logs** for `is not unique` or `PGRST203`; there must be none.

**On a staging account, check the import pushes:**
- an IMDb import gives "IMDb import started", then "Your IMDb history is ready" (or "We
  couldn't finish your IMDb import");
- a Letterboxd import still says Letterboxd;
- a follow still produces its reactive push.

**If a second overload ever appears** in an environment, the immediate remedy is the operator
statement `drop function claim_push_batch(integer);`, after confirming the two-argument form
exists. That restores push-sender at once. A forward migration with the combined definition
then follows.

## 4. What was checked, locally (PGlite, every migration applied; nothing remote)

| Configuration | Result |
|---|---|
| #254 + #256 as they stand | Two overloads. `security-before-proactive` fails "claim_push_batch must have exactly one signature" |
| #254 + #256 with the guard + combined file at `20261112000200` (Sequence B) | One overload, service role only. **Full `test:db` 2,917/2,917** |
| #254 + #256 with its block deleted, renumbered to `20261113000100`, combined at `20261113000200` (Sequence A) | One overload, service role only. Claim, import, grant, push and excerpt suites 113/113 |
| #256 alone, with the guard | Its import, push and grant suites 78/78, with the one-argument form still created on main |
| #254 + combined file, without #256 | Passes everything except main's `import-notifications` "start carries no payload" expectation, which #256 changes. Hence "the PR that merges second carries it" |

**On privileges.** Where #254 has dropped the one-argument form, #256's `create or replace`
creates a new function rather than replacing one. Its privileges therefore come from defaults.
In this repo's migration chain the global `alter default privileges revoke execute on
functions from public` (`20260813002100`) leaves it service-role only (checked). That holds
only for objects created by the role that set it, which is why the combined file states its
grants explicitly.
