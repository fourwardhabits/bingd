-- The storage sweep cannot exist, and the deployed database is the only place that says so.
-- Specification: two-user acceptance run against bingd-nonprod, 2026-08-17.
--
-- ===========================================================================
-- WHAT HAPPENED
--
-- `delete_account` (20260817000600) deleted any surviving rows from
-- `storage.objects` before deleting the auth user. Every local test passed — PGlite has
-- no storage schema, so the guarded block was inert — and every review passed, because
-- the code is correct SQL and the reasoning behind it was sound.
--
-- Against the real project it fails outright:
--
--     42501  Direct deletion from storage tables is not allowed.
--            This prevents accidental data loss from orphaned objects.
--
-- Supabase has a trigger that refuses it, for exactly the reason independent review 14
-- raised as a Blocker: deleting the row leaves the file. They have made the unsafe
-- thing impossible rather than merely discouraged, which is the right call and which
-- this migration should have discovered by reading their documentation rather than by
-- running the deletion.
--
-- The statement is not wrapped in the exception block that guards the auth delete, so
-- it took the whole function down. **Nobody could delete their account**, and the only
-- thing that found it was two real accounts signing in and trying to leave. Neither the
-- 620-test local suite nor four rounds of review could have: the failure exists only on
-- a database with a storage schema, and the local one has none.
--
-- ===========================================================================
-- WHAT REPLACES IT
--
-- Nothing, and that is the point. There is no legal way to remove a storage object from
-- SQL, so the Storage API call the client already makes is not the *first* of two steps
-- — it is the only step. `deleteAllAvatars` was already doing the work; the sweep was
-- doing nothing but adding a way to fail.
--
-- What is left in its place is a **count**, which is a read and is permitted. The
-- function now reports how many objects are still sitting under the caller's folder
-- when it runs, and the client says so to the person leaving. That turns an
-- unenforceable guarantee into an honest one: not "your pictures are gone" asserted by
-- a statement that cannot run, but "your pictures are gone" when the number is zero and
-- a plain sentence when it is not.
--
-- The count also answers the other half of the original reasoning. 20260813002200 warns
-- that a foreign key without ON DELETE CASCADE blocks `delete from auth.users` and
-- names `storage.objects` as the usual culprit. The sweep existed partly to clear that
-- path. It cannot, so the exception handler around the auth delete is what covers it
-- now — and it already did, raising rather than swallowing, which is why an account
-- whose objects genuinely blocked the delete would be told rather than told wrongly.
--
-- ===========================================================================
-- WHY THE COUNT IS NOT A REFUSAL
--
-- Refusing to delete an account because an object store did not answer would be the
-- worse outcome by a wide margin: somebody who wants to leave, cannot, for a reason
-- that is not about them. The deletion proceeds and the person is told. An object with
-- no metadata reachable through the API and no account referencing it is unreachable in
-- every sense that matters to them; it occupies bytes until an operator prunes it, and
-- that is recorded as debt rather than presented as done.
-- ===========================================================================

create or replace function delete_account(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_username  citext;
  v_remaining integer := 0;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select p.username into v_username from profiles p where p.id = v_user;

  -- Already gone. Not an error: a retry after a dropped response must not report a
  -- failure for an account that no longer exists. Nothing is deleted on this path,
  -- including the auth user -- an authenticated caller with no profile is mid-signup,
  -- and `create_profile` owns that state.
  if v_username is null then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if lower(btrim(coalesce(p_confirmation, ''))) is distinct from lower(v_username::text) then
    raise exception 'type your username to confirm' using errcode = '22023';
  end if;

  -- A count, not a delete. Supabase refuses direct deletion from storage tables with
  -- 42501; the Storage API call the client makes before this is the only mechanism
  -- there is. What this reports is whether that call finished the job, so the client
  -- can tell somebody the truth rather than a sentence a failed statement made false.
  --
  -- Guarded, because the storage schema is Supabase's rather than ours and the test
  -- harness has none. On a database without it this reads zero, which is accurate:
  -- there are no objects.
  if to_regclass('storage.objects') is not null then
    execute format(
      'select count(*) from storage.objects
        where bucket_id = %L
          and (storage.foldername(name))[1] = %L',
      'avatars', v_user::text
    ) into v_remaining;
  end if;

  -- The whole deletion. Everything in 20260817000600's inventory follows from this one
  -- statement through foreign keys that were each given a deliberate rule.
  --
  -- Raised rather than swallowed, for the reason `create_profile` gives about the age
  -- gate: returning success when the delete did not happen would tell somebody we
  -- removed their account while keeping it, and that is the one statement this function
  -- must never make falsely. It is also what now covers the case the storage sweep was
  -- partly there for -- an object blocking the delete surfaces here, loudly.
  begin
    delete from auth.users where id = v_user;
  exception when others then
    raise exception 'account deletion failed: %', sqlerrm using errcode = 'P0001';
  end;

  if exists (select 1 from profiles where id = v_user) then
    raise exception 'account deletion did not remove the profile' using errcode = 'P0001';
  end if;

  return jsonb_build_object('status', 'ok', 'avatars_remaining', v_remaining);
end;
$$;

comment on function delete_account(text) is
  'Permanently deletes the caller''s account: the auth user, from which every cascade in the schema follows. Requires the caller''s own handle as confirmation. Reports how many avatar objects are still in storage -- it cannot remove them, because Supabase refuses direct deletion from storage tables, so the client''s Storage API call is the only mechanism and this is what tells the person whether it finished. Deliberately does not call assert_can_write: a suspended account may still leave. Idempotent by nature rather than by operation id, because the ledger that would record the claim is deleted by the operation itself. Moderation reports and actions are retained and are not anonymous, so that a reported account cannot erase the record by closing itself. The full inventory is in the header of 20260817000600.';
