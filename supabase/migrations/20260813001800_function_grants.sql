-- Function execute privileges: default-deny, with an explicit allow-list.
-- Specification: docs/architecture/data-model.md §13, AD-4

-- ---------------------------------------------------------------------------
-- What went wrong
--
-- Postgres grants EXECUTE on a new function to PUBLIC. So this, which appears
-- throughout the earlier migrations, does not do what it looks like:
--
--     create function my_capabilities() ... ;
--     grant execute on function my_capabilities() to authenticated;
--
-- The grant is *additive*. It adds `authenticated` to a set that already
-- contains everyone. Reading it as "only authenticated may call this" is the
-- mistake, and it was made in every migration that created a function after
-- 20260813001400's revoke loop had already run.
--
-- Six functions were reachable by `anon` on the deployed database:
-- my_capabilities, assert_can_write, report, and the rank_* wrappers. Five were
-- saved by assert_can_write refusing a null caller, so nothing was exploitable —
-- but the containment came from a guard inside each function rather than from
-- the privilege system, which means the next function written without a guard
-- would have been genuinely open. my_capabilities had no guard and answered
-- strangers with ["base_free"].
--
-- Found by supabase/tests/remote-smoke.mjs, and findable no other way we had:
-- the local suite runs as the owning role, so every grant question answers yes.
--
-- ---------------------------------------------------------------------------
-- Why a sweep and not seven revokes
--
-- Naming the six would fix today and leave the trap armed. The durable fix is
-- to make PUBLIC execute stop happening by default, so a function added next
-- month is unreachable until someone grants it deliberately. Same reasoning as
-- the table-privilege revoke in 20260813001400 §3: a client-reachable write now
-- needs both a policy and a grant, and neither appears by accident.
-- ---------------------------------------------------------------------------

-- Extension-owned functions are excluded, and this is not a detail.
--
-- 20260813000100 runs `create extension citext` with no schema clause, which
-- installs it into public. citext's equality operator is implemented by a
-- function, and using an operator checks EXECUTE on that function — so a truly
-- blanket revoke would strip `anon` and `authenticated` of the ability to
-- compare a username to a string. Usernames would stop resolving, in a way that
-- would look nothing like a privilege bug.
--
-- deptype 'e' marks extension membership, which is the only reliable way to tell
-- our functions from an extension's.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid
            and d.classid = 'pg_proc'::regclass
            and d.deptype = 'e'
       )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn.signature);
  end loop;
end $$;

-- The part that makes it stick. Anything created in public from here on arrives
-- with no execute grant for a client role.
--
-- All three targets are needed. PUBLIC is Postgres's own default, and Supabase
-- additionally sets default privileges granting execute to anon and
-- authenticated — revoking from PUBLIC alone would leave those two standing, and
-- the sweep above would be a one-time cleanup rather than a rule.
--
-- Caveat for whoever installs the next extension into public: this applies to it
-- too, and the symptom will be an operator or function that mysteriously fails
-- for anon while working for the service role. Grant explicitly, or install into
-- the extensions schema.
alter default privileges in schema public
  revoke execute on functions from public;

alter default privileges in schema public
  revoke execute on functions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The allow-list
--
-- Two kinds of function need a client grant, and only two.
-- ---------------------------------------------------------------------------

-- 1. Helpers called from inside row level security policies.
--
-- A policy expression is evaluated as the *querying* role, not as the table
-- owner, so a policy that calls a function the caller cannot execute fails the
-- whole query. can_view_profile is named by policies in eight migrations; it is
-- load-bearing for nearly every read in the schema. Both are security definer,
-- so granting execute does not expose the tables they read.
grant execute on function can_view_profile(uuid, uuid) to anon, authenticated;
grant execute on function blocked_between(uuid, uuid)  to anon, authenticated;

-- 2. Functions a client is meant to call.
--
-- Retrieval by identifier, which is how an unlisted list resolves for someone
-- who holds the link and is not signed in (20260813001400 §4).
grant execute on function list_by_id(uuid)         to anon, authenticated;
grant execute on function list_items_by_list(uuid) to anon, authenticated;

-- Signed-in reads.
grant execute on function my_capabilities()               to authenticated;
grant execute on function unranked_queue(integer)         to authenticated;

-- Signed-in writes. Every one of these calls assert_can_write() first; the
-- guard stays, because a privilege grant says who may knock and the guard says
-- whether a suspended account gets in.
grant execute on function rank_start(uuid, taste_bucket)    to authenticated;
grant execute on function rank_answer(uuid, uuid)           to authenticated;
grant execute on function rank_skip(uuid)                   to authenticated;
grant execute on function rank_back(uuid)                   to authenticated;
grant execute on function rank_unrank(uuid)                 to authenticated;
grant execute on function rank_reorder(uuid, integer)       to authenticated;
grant execute on function rank_rebucket(uuid, taste_bucket) to authenticated;
grant execute on function report(report_subject, uuid, text, text) to authenticated;

-- Deliberately absent, and worth stating so their absence reads as a decision
-- rather than an oversight:
--
--   resolve_capabilities(uuid), is_over_13(uuid)   take a target user, so
--       exposing them lets anyone probe anyone. my_capabilities() is the route.
--   assert_can_write(uuid)                         called only from inside
--       definer functions, which run as owner and need no grant.
--   band_bounds, assert_ranking_valid, rankable_category, _rank_*, and the
--       _*_unguarded implementations                  internal.
--   touch_updated_at, assert_username_available, reserve_username_on_profile_delete
--       trigger functions. EXECUTE is checked when the trigger is created, not
--       when it fires, so revoking does not stop them running.

comment on function can_view_profile(uuid, uuid) is
  'The single visibility rule (AD-5). Security definer, and granted to client roles because row level security policies across the schema call it — a policy runs as the caller, so without this grant most reads fail.';
