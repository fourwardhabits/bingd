-- A private account is still a person, in a list.
-- Founder tranche 2026-08-28 §§19-24: identity discovery is separated from content
-- visibility on the two surfaces that had not yet been separated.
--
-- ===========================================================================
-- WHAT 20260819000100 DID, AND THE HALF IT LEFT
--
-- That migration is where this product decided that **private means "my activity is
-- private", not "nobody can find me"**. It gave `search_users` and `profile_identity` a
-- weaker predicate -- `can_discover_profile` -- so a private account is findable by name
-- and its locked shell leads somewhere a follow request can be made from.
--
-- It changed two surfaces. There are four, and the founder's device pass found the other
-- two:
--
--   * **Followers and Following.** `followers_of` / `following_of` (20260826000600 §5)
--     are `security invoker`, so `profiles_read` -- which is `can_i_view`, the *content*
--     predicate -- decides which rows can be named. A private account the viewer has not
--     been approved by is therefore **silently absent from the list**. Worse than that:
--     it is absent from the viewer's own follower list, so somebody who has followed you
--     is not on the list of people who follow you if their account is private.
--
--   * **Mutuals.** `people_mutuals` (20260826000500 §9a) applies `can_view_profile` to
--     the candidate, and its own header records the reasoning: surfacing a private
--     account would disclose that somebody the caller follows follows it.
--
-- The founder has reversed the second reasoning explicitly (§21C) and, with it, closed
-- the first. Both surfaces now show **limited identity** -- avatar, display name, handle,
-- the private marker, and the follow control -- and nothing else. This is the
-- friend-of-friend discovery an invite-only beta runs on.
--
-- ===========================================================================
-- WHAT IS DISCLOSED THAT WAS NOT, STATED PLAINLY
--
-- Exactly one new fact: **that a follow edge exists between an account the viewer may
-- read and a private account they may not.** Not the private account's rankings, watch
-- history, notes, awards, activity, Match, shared-title count or monthly standing --
-- every one of those still goes through `can_view_profile`, none of them is touched
-- here, and §25 and §26 are enforced in `taste_match` and `monthly_leaderboard`
-- respectively rather than by hope.
--
-- The two surfaces are consistent with each other by construction, which is why the
-- naming in `people_mutuals` needs no separate argument: if `following_of(X)` will now
-- name a private B that X follows, then "X is a mutual you share with B" discloses
-- nothing `following_of(X)` does not already say.
--
-- ===========================================================================
-- BLOCKS, SUSPENSION AND DELETION ARE NOT RELAXED (§23)
--
-- Everything below goes through `can_identify_profile`, which is `can_discover_profile`
-- plus the caller themselves. So: a block in either direction removes the row, a
-- suspended account is absent, and a deleted account has no `profiles` row to join. The
-- one thing added over `can_discover_profile` is that **the caller sees themselves**,
-- which is not a disclosure and is required -- you belong on your own friend's follower
-- list.
--
-- ===========================================================================
-- WHY `followers_of` AND `following_of` BECOME DEFINER
--
-- They were `security invoker` on the argument that `follows_read` "already *is* the
-- rule and a definer copy would be the copy that got it wrong". That was correct while
-- the rule was one predicate. It is no longer: the founder's contract is now **two**
-- predicates -- content for the subject whose list this is, identity for the people in
-- it -- and `follows_read` cannot express a split it has no column for.
--
-- So the rule moves into the function body where it can be read in one place, and the
-- body restates the subject gate that `follows_read` used to supply:
--
--     can_view_profile(auth.uid(), p_user_id)
--
-- A private account the caller has not been approved by yields nothing, exactly as
-- before -- its locked shell has no follower list to open, and this is what keeps that
-- true against a hand-written RPC call as well as against the client.
--
-- `auth.uid() is not null` is stated as a floor rather than left to the grant.
-- `can_view_profile(null, subject)` is true for a public account, and an anonymous
-- follower dump is not a feature.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The identity predicate
--
-- Server-only, and the revoke is the point rather than an afterthought. `20260819000200`
-- had to withdraw the client grant on `can_discover_profile` because a definer helper
-- that accepts a viewer lets any caller substitute somebody else and read the private
-- block graph pair by pair. This has the same shape and the same hazard, so it is born
-- revoked. Every caller below is `security definer` and needs no client grant to reach
-- it.
-- ---------------------------------------------------------------------------

create or replace function can_identify_profile(viewer uuid, subject uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when viewer is null then false
    -- The one difference from can_discover_profile. "Discovery" excludes yourself
    -- because a You row in a list of people to follow is a control that cannot exist;
    -- a list of somebody's followers is not that list, and you belong on it.
    when viewer = subject then
      coalesce((select status = 'active' from profiles where id = subject), false)
    else can_discover_profile(viewer, subject)
  end;
$$;

comment on function can_identify_profile(uuid, uuid) is
  'Whether one account may be *named* to another in a list: can_discover_profile, plus the caller themselves. Identity only -- avatar, display name, handle, private marker -- and deliberately weaker than can_view_profile, which still governs every content read. Blocks in either direction and suspension both remove the row. SERVER-ONLY: revoked from clients for the reason 20260819000200 revoked can_discover_profile, since a definer helper taking a viewer is a block-graph oracle.';

revoke execute on function can_identify_profile(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Followers and Following
--
-- Two predicates, said once each. Everything else -- the approved-only edge state, the
-- in-list search that never reaches the directory, the name ordering, the offset paging
-- over a unique sort -- is 20260826000600 §5 unchanged, and is repeated in full rather
-- than patched because `create or replace` over a body nobody re-read is how
-- `_assert_operation_rate` lost its advisory lock invisibly.
-- ---------------------------------------------------------------------------

create or replace function followers_of(
  p_user_id uuid,
  p_query   text default null,
  p_limit   integer default 50,
  p_offset  integer default 0
)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility
)
language sql stable security definer
set search_path = public
as $$
  select p.id, p.username::text, p.display_name, p.avatar_path, p.visibility
    from follows f
    join profiles p on p.id = f.follower_id
   where auth.uid() is not null
     -- Whose list this is: content visibility, because a follower list is something a
     -- private account keeps behind approval. True for the caller's own.
     and can_view_profile(auth.uid(), p_user_id)
     and f.followee_id = p_user_id
     and f.state = 'approved'
     -- Who may be named in it: identity only, which is the founder's §21B change. A
     -- private account the caller has not been approved by appears as itself and
     -- nothing more; the client draws the locked shell when the row is tapped.
     and can_identify_profile(auth.uid(), p.id)
     and p.status = 'active'
     and (
       p_query is null
       or btrim(p_query) = ''
       or p.username::text ilike '%' || btrim(p_query) || '%'
       or coalesce(p.display_name, '') ilike '%' || btrim(p_query) || '%'
     )
   order by coalesce(p.display_name, p.username::text), p.username
   limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function followers_of(uuid, text, integer, integer) is
  'The accounts following the given person, as far as the caller is allowed to know. Two predicates since 20260828000400: can_view_profile on the *subject*, because whose followers these are is content a private account keeps behind approval; can_identify_profile on each *listed* account, because a private account is a person who can be named in a list even when nothing they wrote can be read (founder §21B). Definer, and the viewer is always auth.uid() -- there is no argument to substitute. Blocked in either direction and suspended accounts are absent from the list rather than counted in it. p_query searches display name and username within this list only; there is no path from here to the directory. Never returns a taste match.';

create or replace function following_of(
  p_user_id uuid,
  p_query   text default null,
  p_limit   integer default 50,
  p_offset  integer default 0
)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility
)
language sql stable security definer
set search_path = public
as $$
  select p.id, p.username::text, p.display_name, p.avatar_path, p.visibility
    from follows f
    join profiles p on p.id = f.followee_id
   where auth.uid() is not null
     and can_view_profile(auth.uid(), p_user_id)
     and f.follower_id = p_user_id
     and f.state = 'approved'
     and can_identify_profile(auth.uid(), p.id)
     and p.status = 'active'
     and (
       p_query is null
       or btrim(p_query) = ''
       or p.username::text ilike '%' || btrim(p_query) || '%'
       or coalesce(p.display_name, '') ilike '%' || btrim(p_query) || '%'
     )
   order by coalesce(p.display_name, p.username::text), p.username
   limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function following_of(uuid, text, integer, integer) is
  'The accounts the given person follows, as far as the caller is allowed to know. The same two predicates followers_of applies and for the same reasons: content visibility on the subject, identity on each listed account. Searches within the list only, never the directory, and never returns a taste match -- one correlation per row is what 20260826000600 part N forbids.';

revoke execute on function followers_of(uuid, text, integer, integer) from public, anon;
grant  execute on function followers_of(uuid, text, integer, integer) to authenticated;
revoke execute on function following_of(uuid, text, integer, integer) from public, anon;
grant  execute on function following_of(uuid, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Mutuals, with private accounts in them
--
-- One line changes in each function: `can_view_profile` on the *candidate* becomes
-- `can_identify_profile`. The intermediary keeps `can_view_profile`, because a mutual is
-- somebody the caller follows and whose following list they are effectively reading --
-- and because that predicate is what makes the edge one the caller already owns.
--
-- **`mutual_names` stays**, and needs no new argument. The names are the
-- *intermediaries'*, all of whom still pass `can_view_profile`; the only claim the line
-- makes about the private candidate is that an edge exists, which `following_of` above
-- now says in as many words. Withholding it here while stating it there would be an
-- inconsistency rather than a protection.
-- ---------------------------------------------------------------------------

create or replace function people_mutuals(p_limit integer default 10)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility,
  mutual_count integer,
  mutual_names text[]
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  -- The caller's own approved outgoing edges. Every one is a row where the caller is the
  -- follower, so `follows_read` would admit it directly. Both predicates stay on this
  -- side: a mutual is named, and a name is a claim about a person the caller can read.
  mine as (
    select f.followee_id as via
      from follows f, me
     where f.follower_id = me.id
       and f.state = 'approved'
       and can_view_profile(me.id, f.followee_id)
       and can_discover_profile(me.id, f.followee_id)
  ),
  candidates as (
    select f.followee_id as subject,
           count(*)::integer as mutuals,
           (array_agg(coalesce(nullif(mp.display_name, ''), mp.username::text)
                      order by mp.username))[1:3] as names
      from follows f
      join mine on mine.via = f.follower_id
      join profiles mp on mp.id = f.follower_id
      cross join me
     where f.state = 'approved'
       and f.followee_id <> me.id
       -- Identity, not content (founder §21C). A private account with a real social
       -- reason to be suggested is suggested, and the row carries `visibility` so the
       -- card offers Request rather than Follow and the tap lands on the locked shell.
       and can_identify_profile(me.id, f.followee_id)
       -- Already followed, or already asked. Neither is a suggestion.
       and not exists (
         select 1 from follows own
          where own.follower_id = me.id and own.followee_id = f.followee_id
       )
     group by f.followee_id
  )
  select c.subject, p.username::text, p.display_name, p.avatar_path, p.visibility,
         c.mutuals, c.names
    from candidates c
    join profiles p on p.id = c.subject
   order by c.mutuals desc, p.username, c.subject
   limit least(greatest(coalesce(p_limit, 10), 0), 30);
$$;

comment on function people_mutuals(integer) is
  'People followed by the people the caller follows, most shared connections first. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Since 20260828000400 a *private* account can be suggested -- founder §21C reversed 20260826000500 §9a -- because identity discovery and content visibility are separate contracts: the row carries handle, name, avatar and the private marker, the card offers Request, and the tap lands on the locked shell. The intermediaries whose names appear still pass can_view_profile, and the edge the names assert is one following_of now states directly. Excludes the caller, anyone they already follow or have asked to follow, blocks in either direction and suspended accounts on both ends.';

create or replace function mutuals_with(p_subject uuid)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id)
  select mp.id, mp.username::text, mp.display_name, mp.avatar_path, mp.visibility
    from follows mine
    join follows theirs on theirs.follower_id = mine.followee_id
                       and theirs.followee_id = p_subject
    join profiles mp on mp.id = mine.followee_id
    cross join me
   where mine.follower_id = me.id
     and mine.state = 'approved'
     and theirs.state = 'approved'
     and p_subject <> me.id
     -- The mutual is named, so the content predicate stays on them.
     and can_view_profile(me.id, mine.followee_id)
     and can_discover_profile(me.id, mine.followee_id)
     -- The subject may be a private account this sheet was opened from, which is the
     -- one line 20260828000400 changes here. Nothing about them is returned.
     and can_identify_profile(me.id, p_subject)
   order by mp.username
   limit 30;
$$;

comment on function mutuals_with(uuid) is
  'The people the caller follows who follow p_subject -- the rows behind people_mutuals'' count, for the inspection sheet. Definer, viewer is always auth.uid(). Every returned row names a mutual the caller can read (can_view_profile) and an edge follows_read would admit to them. Since 20260828000400 the *subject* need only pass can_identify_profile, so the sheet opens on a private suggestion; the subject''s own identity is not in the result and nothing they wrote is reachable from here. Answers for a subject the caller already follows too, so the sheet survives the Follow it inspired. One page of 30 by handle.';

revoke execute on function people_mutuals(integer) from public, anon;
grant  execute on function people_mutuals(integer) to authenticated;
revoke execute on function mutuals_with(uuid) from public, anon;
grant  execute on function mutuals_with(uuid) to authenticated;
