-- Who reacted to a comment.
-- Founder tranche 2026-08-27 §18: long-pressing a comment's reaction cluster opens
-- the people behind the aggregate — each person, and which reaction they used.
--
-- ---------------------------------------------------------------------------
-- WHY AN RPC AND NOT A DIRECT SELECT
--
-- `comment_reactions` does have a read policy (`comment_reactions_read`,
-- 20260826000600), and a PostgREST select with a profiles embed — the way the feed's
-- `useReactions` reads the `reactions` table — would *almost* work. The gap is the
-- event: that policy checks the reactor is viewable and the comment exists, but not
-- that the caller may see the activity the comment hangs off. `activity_comments`
-- (20260827000500) closes that gap for the aggregate with its `event` CTE; a reactor
-- list read outside that function would reopen it — an API-level enumeration of
-- reactions under threads the caller cannot open. So the list is a definer function
-- restating exactly the aggregate's three gates, and the identities it returns are
-- precisely the set `activity_comments` already counted for this reader: the number
-- on the row and the people behind it cannot disagree.
--
-- The three gates, in `activity_comments`' own order:
--   1. the event's actor is viewable (no rows = empty list, indistinguishable from
--      "nobody reacted" — the privacy answer);
--   2. the comment's author is viewable (a comment absent from the thread cannot
--      grow a visible reactor list);
--   3. each reactor is viewable (a blocked account is absent, not anonymised).
--
-- Tombstones keep their reactions in the aggregate, so they keep them here too —
-- the client offers no entry point on a tombstone, but consistency between count
-- and list is this function's whole contract.
-- ---------------------------------------------------------------------------

create or replace function comment_reactors(p_comment_id uuid)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  kind         text
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  the_comment as (
    select c.id
      from comments c
      join feed_events e on e.id = c.feed_event_id
      cross join me
     where c.id = p_comment_id
       and can_view_profile(me.id, e.actor_id)
       and can_view_profile(me.id, c.author_id)
  )
  select cr.user_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         cr.kind
    from comment_reactions cr
    join the_comment tc on tc.id = cr.comment_id
    join profiles p on p.id = cr.user_id
    cross join me
   where can_view_profile(me.id, cr.user_id)
   -- Newest first, stably: the person who just reacted is the one the reader opened
   -- this to find. The client floats the reader's own row to the top itself, the
   -- same as the feed's list.
   order by cr.created_at desc, cr.user_id;
$$;

comment on function comment_reactors(uuid) is
  'The people behind one comment''s reaction aggregate, each with the reaction they used. Restates activity_comments'' visibility gates verbatim — viewable event actor, viewable comment author, viewable reactor — so the identities returned are exactly the set that function counted, and an unviewable thread yields an empty list indistinguishable from an unreacted comment. Definer and takes no viewer (20260813001900).';

revoke execute on function comment_reactors(uuid) from public, anon, authenticated;
grant  execute on function comment_reactors(uuid) to authenticated;
