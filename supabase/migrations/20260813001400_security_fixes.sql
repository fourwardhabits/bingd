-- Row level security corrections.
-- Specification: docs/architecture/data-model.md §15 · PRD §22, §24
--
-- Five defects found by independent review on 2026-08-13, each reproduced by a
-- failing test in supabase/tests/rls.test.mjs before being fixed here.
--
-- They shared one cause worth stating plainly, because it is the reason the test
-- suite was green while the holes were open: **every query in the suite ran as
-- the table owner, and Postgres skips row security for an owner.** The policies
-- were compiled and never evaluated. The suite would have passed with all of
-- them deleted. The harness now switches into the real `anon` and
-- `authenticated` roles, so a policy defect fails a test.

-- ---------------------------------------------------------------------------
-- 1. date_of_birth was readable by anyone who could see the profile
--
-- The column carried a comment promising it was "never returned by any API,
-- including the owner's own". That is not something a policy can deliver:
-- **row level security is row-level.** `profiles_read` admits a row, and a
-- readable row is a readable row in every column, date of birth included. Any
-- signed-in user could select the exact birth date of every public account.
--
-- So the guarantee moves out of prose and into the schema. The column lives in
-- its own table with RLS enabled and **no policy at all**, which denies every
-- client including the owner. The only route to it is `is_over_13`, which is
-- SECURITY DEFINER and answers a boolean.
--
-- Splitting a single column into its own table is not something to do lightly.
-- It earns its place here because the alternative — a column privilege — is
-- revocable by any later `grant all on profiles`, and because this makes the
-- documented promise true as written rather than approximately true.
-- ---------------------------------------------------------------------------

create table profile_private (
  profile_id    uuid primary key references profiles(id) on delete cascade,
  date_of_birth date not null
);

comment on table profile_private is
  'Reachable only through SECURITY DEFINER functions. RLS is enabled with no policy, so every client is denied, the owner included. PRD §22.';

insert into profile_private (profile_id, date_of_birth)
select id, date_of_birth from profiles;

alter table profiles drop column date_of_birth;

alter table profile_private enable row level security;
-- Deliberately no policy. Absence of a policy means no access.

-- Reads from the new location. Still the only way to learn anything about a
-- birth date, and still a boolean.
create or replace function is_over_13(target uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select date_of_birth <= (current_date - interval '13 years')
    from profile_private where profile_id = target;
$$;

-- ---------------------------------------------------------------------------
-- 2. SECURITY DEFINER helpers were callable by any client for any user
--
-- Postgres grants EXECUTE to PUBLIC on every function it creates, and Supabase
-- grants it to `anon` and `authenticated` as well. A SECURITY DEFINER function
-- runs as its owner and therefore bypasses RLS. Those two facts together mean
-- **every definer function is an open API endpoint unless it is revoked**, and
-- several of these take a target user as an argument.
--
-- The consequences ranged from a privacy leak to a broken ranking:
--
--   resolve_capabilities(uuid)  any user could read anyone's entitlements
--   is_over_13(uuid)            any user could probe anyone's age gate
--   _rank_finalize(uuid)        reachable directly, placing a title without
--                               answering a single comparison
--   _rank_pivot_at(...)         exposed the insertion search's internal state
--
-- `can_view_profile` is the exception and must stay executable: it is called
-- from inside policy expressions, which are evaluated with the privileges of
-- the querying role rather than the policy owner's. Revoking it would deny
-- every read in the schema. It is also the safest of the set, since it returns
-- a boolean a viewer can already determine by looking.
-- ---------------------------------------------------------------------------

-- Revoked by rule rather than by listing signatures. Two reasons: a signature
-- list rots the first time an argument changes, and the rule is the thing worth
-- writing down. Any future helper named with a leading underscore is locked down
-- on creation, which is what the corresponding test asserts.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (
         p.proname like '\_%'
         or p.proname in (
           'resolve_capabilities',   -- takes a target user; my_capabilities() is the client route
           'is_over_13',             -- would let anyone probe anyone's age gate
           'band_bounds',            -- ranking internals
           'assert_ranking_valid'    -- expensive, and a whole-collection scan
         )
       )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn.signature);
  end loop;
end $$;

-- What a client is actually allowed to ask: its own capabilities, never
-- anyone else's. No argument, so there is nothing to tamper with.
create or replace function my_capabilities()
returns text[]
language sql stable security definer
set search_path = public
as $$
  select resolve_capabilities(auth.uid());
$$;

comment on function my_capabilities is
  'Client-facing capability read. resolve_capabilities takes a target and is server-only, because a definer function with a user argument is an open endpoint.';

grant execute on function my_capabilities() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Client roles held INSERT, UPDATE, and DELETE on every table
--
-- Supabase grants these to `anon` and `authenticated` by default. AD-4 says
-- every write goes through a SECURITY DEFINER function, and that held — but it
-- held on RLS denying by default and nothing else, because no write policy
-- exists. One carelessly added `for insert` policy anywhere would have opened a
-- direct write path.
--
-- The schema test that was supposed to catch this passed for the wrong reason:
-- the roles did not exist in the old harness, so it queried an empty set and
-- asserted the empty set was empty.
--
-- Revoking gives a second, independent layer. A write path now needs both a
-- policy and a grant, and neither appears by accident.
-- ---------------------------------------------------------------------------

revoke insert, update, delete on all tables in schema public from anon, authenticated;

alter default privileges in schema public
  revoke insert, update, delete on tables from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. 'link' lists were indistinguishable from public
--
-- The read policy admitted `visibility in ('public','link')`, so any client
-- could run `select * from lists where visibility = 'link'` and enumerate every
-- unlisted list belonging to every visible owner. A link-visibility list is
-- supposed to require *holding the link*, and enumeration is exactly the thing
-- that is not supposed to be possible.
--
-- Possession of an identifier cannot be expressed as a policy predicate: a
-- policy filters rows, and it cannot know whether the caller named the row or
-- discovered it. So the policy narrows to what is genuinely discoverable —
-- public lists and your own — and link retrieval moves to a function that takes
-- the id as an argument, which makes possession the gate by construction.
-- ---------------------------------------------------------------------------

drop policy lists_read on lists;

create policy lists_read on lists for select
  using (
    owner_id = auth.uid()
    or (visibility = 'public' and can_view_profile(auth.uid(), owner_id))
  );

drop policy list_items_read on list_items;

create policy list_items_read on list_items for select
  using (exists (
    select 1 from lists l
     where l.id = list_id
       and (
         l.owner_id = auth.uid()
         or (l.visibility = 'public' and can_view_profile(auth.uid(), l.owner_id))
       )
  ));

-- Retrieval by identifier. 'link' is permitted here and nowhere else, which is
-- the whole difference between unlisted and public. Owner visibility still
-- applies, so a link to a private list resolves to nothing, and a link belonging
-- to someone who has blocked the caller resolves to nothing.
create or replace function list_by_id(target uuid)
returns table (
  id          uuid,
  owner_id    uuid,
  title       text,
  description text,
  visibility  list_visibility,
  created_at  timestamptz
)
language sql stable security definer
set search_path = public
as $$
  select l.id, l.owner_id, l.title, l.description, l.visibility, l.created_at
    from lists l
   where l.id = target
     and (
       l.owner_id = auth.uid()
       or (l.visibility in ('public', 'link') and can_view_profile(auth.uid(), l.owner_id))
     );
$$;

comment on function list_by_id is
  'The only read path for a link-visibility list. Taking the id as an argument is what makes possession of the link the gate; a policy cannot distinguish a named row from a discovered one.';

grant execute on function list_by_id(uuid) to anon, authenticated;

-- Items of a list reached by link, on the same terms.
create or replace function list_items_by_list(target uuid)
-- "position" is quoted because POSITION is a reserved keyword and cannot appear
-- unquoted as a column name in a RETURNS TABLE signature, even though it is
-- perfectly legal in the CREATE TABLE that defines it.
returns table (
  media_item_id uuid,
  "position"    integer,
  added_at      timestamptz
)
language sql stable security definer
set search_path = public
as $$
  select li.media_item_id, li.position, li.added_at
    from list_items li
   where li.list_id = target
     and exists (select 1 from list_by_id(target))
   order by li.position;
$$;

grant execute on function list_items_by_list(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. A block did not hide a watch tag from either party
--
-- The policy read `tagger_id = auth.uid() or tagged_id = auth.uid() or (...)`.
-- Both of those branches short-circuit before the visibility helper is reached,
-- so a block between the two people in a tag changed nothing: the blocked
-- tagger kept seeing the tag, and the blocker kept seeing rows naming the person
-- they had blocked.
--
-- PRD §22 requires a block to take effect across feed, leaderboard, discovery,
-- match, tagging, and the public pages at once. Tagging was the one place it did
-- not, and it is the most personal of them.
--
-- The tag disappears for both sides rather than only for the blocker. Hiding it
-- one way would leave the blocked party able to see they had been unblocked, or
-- to keep a record of someone who wanted no contact. The tagger's own log entry
-- is untouched — `watch_tags` has never had any reach into a collection.
-- ---------------------------------------------------------------------------

-- A policy cannot query `blocks` directly and get the right answer, which is a
-- trap worth stating because it is invisible on inspection. A policy expression
-- is evaluated with the caller's privileges, so a subquery against `blocks`
-- picks up `blocks_read` — and that policy shows a block only to the person who
-- made it. The blocked party would therefore never see the block that is
-- supposed to be hiding the row from them, and the check would pass for exactly
-- the user it exists to stop.
--
-- SECURITY DEFINER is what makes the check see both sides. This is the same
-- reason can_view_profile is a definer function rather than inline SQL.
create or replace function blocked_between(a uuid, b uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from blocks
     where (blocker_id = a and blocked_id = b)
        or (blocker_id = b and blocked_id = a)
  );
$$;

comment on function blocked_between is
  'True when either party has blocked the other. Must be SECURITY DEFINER: blocks_read hides a block from the person it was made against, so an inline subquery in a policy returns false for precisely the caller who should be denied.';

grant execute on function blocked_between(uuid, uuid) to anon, authenticated;

drop policy watch_tags_read on watch_tags;

create policy watch_tags_read on watch_tags for select
  using (
    not blocked_between(tagger_id, tagged_id)
    and (
      tagger_id = auth.uid()
      or tagged_id = auth.uid()
      or (not removed_by_tagged and can_view_profile(auth.uid(), tagger_id))
    )
  );

-- ---------------------------------------------------------------------------
-- 6. The projection api.md §12 already specified
--
-- Documented as existing and never created. security_invoker is essential: a
-- view defaults to running as its owner, which would bypass RLS on profiles and
-- publish every private account to anyone who selected from the view.
-- ---------------------------------------------------------------------------

create view public_profiles with (security_invoker = true) as
select id, username, display_name, avatar_url, visibility, created_at
  from profiles;

comment on view public_profiles is
  'Always-public profile fields. Excludes invited_by, which is growth provenance rather than profile data. date_of_birth is not here because it is no longer in profiles at all.';

grant select on public_profiles to anon, authenticated;
