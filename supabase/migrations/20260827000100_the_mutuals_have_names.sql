-- ===========================================================================
-- THE MUTUALS HAVE NAMES
--
-- External-beta polish tranche, 2026-08-27. The founder reversed the naming
-- decision recorded in 20260826000500 §9a: a card saying "1 mutual" without
-- saying *who* asks the reader to follow a stranger on the strength of a
-- number, and on the physical device that read as broken rather than careful.
--
-- The privacy argument does not change, it is completed. §9a already
-- established that every edge `people_mutuals` counts is one `follows_read`
-- would admit to this caller individually -- both parties pass
-- `can_view_profile` -- so the names were always readable one query at a time.
-- What was withheld was the *aggregation*, on a fall-back-if-in-doubt
-- instruction. The founder has now resolved the doubt the other way: the
-- mutual relationship must be inspectable, showing only relationships already
-- visible to the viewer. That is exactly the set these functions draw from.
--
-- Two changes:
--
--   1. `people_mutuals` also returns `mutual_names` -- up to three display
--      names, for the card's one line ("Mutual: Abisola", "Abisola + 2 more").
--   2. `mutuals_with(p_subject)` -- the full list behind the card, as identity
--      rows for a sheet. Same predicates, so the sheet can never show a name
--      the count did not include.
--
-- A private account still cannot be *suggested* (§9a) -- but naming is gated
-- per edge here too, so neither function can ever describe an edge the caller
-- could not select.
-- ===========================================================================


-- The return type gains a column, which `create or replace` refuses.
drop function if exists people_mutuals(integer);

create function people_mutuals(p_limit integer default 10)
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
  -- The caller's own approved outgoing edges. Every one of these is a row where the
  -- caller is the follower, so `follows_read` would admit it directly.
  --
  -- `can_discover_profile` on the intermediary as well as `can_view_profile`
  -- (review 60): a block raced against the follow edge, or a suspension, must not
  -- leave the account countable — let alone *nameable* in `mutual_names` — when
  -- `mutuals_with` correctly refuses to list it. The count and the sheet must draw
  -- from the same set, and this is the predicate pair the sheet applies.
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
           -- The first three, by handle so the same graph names the same people
           -- in the same order on every call. `coalesce` because a display name
           -- is optional and a card cannot show a blank where a person goes.
           (array_agg(coalesce(nullif(mp.display_name, ''), mp.username::text)
                      order by mp.username))[1:3] as names
      from follows f
      join mine on mine.via = f.follower_id
      join profiles mp on mp.id = f.follower_id
      cross join me
     where f.state = 'approved'
       and f.followee_id <> me.id
       -- The candidate side of the same readability test. Without it this would count
       -- edges into accounts the caller may not view, and the count itself would be
       -- the disclosure.
       and can_view_profile(me.id, f.followee_id)
       -- Suspension, blocks either way, and never yourself.
       and can_discover_profile(me.id, f.followee_id)
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
   -- Most connected first, then a stable tie-break so two calls with the same graph
   -- return the same order and the list does not shuffle under a reader.
   order by c.mutuals desc, p.username, c.subject
   limit least(greatest(coalesce(p_limit, 10), 0), 30);
$$;

comment on function people_mutuals(integer) is
  'People followed by the people the caller follows, most shared connections first. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Every edge counted is one follows_read would admit to the caller individually -- both ends must pass can_view_profile, and both ends must pass can_discover_profile, the same predicate pair mutuals_with applies -- so neither the count nor the names disclose anything new, and the inline names can never disagree with the sheet. mutual_names carries at most three, for the card; mutuals_with is the full list. Excludes the caller, anyone they already follow or have asked to follow, blocks in either direction and suspended accounts on both ends.';

revoke execute on function people_mutuals(integer) from public, anon;
grant  execute on function people_mutuals(integer) to authenticated;


-- ---------------------------------------------------------------------------
-- The list behind the card.
--
-- The same edges `people_mutuals` aggregates for one subject, as identity rows.
-- The predicates are copied rather than shared through a helper deliberately:
-- each function's safety argument must be readable in its own body, and a
-- helper edited for one would silently re-derive the other.
--
-- No is-the-subject-unfollowed test here, unlike the suggestion list: the sheet
-- can legitimately stay open across the Follow it inspired, and a list that
-- empties itself at that moment looks like a crash, not a policy.
-- ---------------------------------------------------------------------------

create function mutuals_with(p_subject uuid)
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
     -- Both parties of every returned edge, same as the count.
     and can_view_profile(me.id, mine.followee_id)
     and can_view_profile(me.id, p_subject)
     -- Suspension and blocks in either direction, on both ends.
     and can_discover_profile(me.id, p_subject)
     and can_discover_profile(me.id, mine.followee_id)
   order by mp.username
   limit 30;
$$;

comment on function mutuals_with(uuid) is
  'The people the caller follows who follow p_subject -- the rows behind people_mutuals'' count, for the inspection sheet. Definer, viewer is always auth.uid(). Every returned row names an edge follows_read would admit to the caller: the caller''s own approved follow of the mutual, and the mutual''s approved follow of the subject, with can_view_profile required on both ends and can_discover_profile excluding blocks and suspension. Answers for a subject the caller already follows too, so the sheet survives the Follow it inspired. One page of 30 by handle -- the client states the truncation when the page is full (MUTUALS_WITH_PAGE), because the card''s count is not capped.';

revoke execute on function mutuals_with(uuid) from public, anon;
grant  execute on function mutuals_with(uuid) to authenticated;
