-- A profile that counts what you watched.
--
-- Physical QA on staging, 2026-09-12: after importing roughly twenty-five watched films from
-- Letterboxd, the profile still said "Movies: 5". The stat row counted `rankings`, and an
-- import writes no rankings by design, so a whole imported history was invisible there.
--
-- ===========================================================================
-- THE DECISION (founder, locked 2026-09-12)
--
-- The profile's Movies and TV are the account's watched collection, not its rankings:
--
--   * an imported watched film counts in Movies
--   * an imported watched season would count in TV (the importer brings films only today)
--   * a native ranking counts exactly as before
--   * a title that is both ranked and imported counts once
--   * a film logged as watched here and not ranked counts too, because it is watched
--   * a season still in progress (`progress = 'watching'`) does not: it is not watched yet
--
-- And nothing else moves. Top Ranked, scores, leaderboards, streaks, feed activity,
-- community score and Taste Match all read `rankings` and still do; none of them is touched
-- here. `usePublicProfile` keeps reading the ranked counts for the Taste Match line.
--
-- ===========================================================================
-- WHY DEFINER, GATED ONCE
--
-- `user_media` is own-read only, and a count of somebody else's watched films has to pass
-- the gate a profile's collection already passes: `can_i_view(owner)`, the rule behind both
-- `logged_collection` (20260827000400) and the `rankings` policy. The first version was
-- invoker over those two, which applied the gate once per row: about ten thousand plpgsql
-- calls to draw one header after a large import (independent review). This asks
-- `can_i_view` once for the account and then counts, which is the same rule and the same
-- answer: a viewer who could not see the account gets zeros, as the ranked count gave them.
--
-- Definer is also what lets it read `progress`, which the view does not expose.
--
-- The union is over `media_item_id`, which is what makes a ranked title that is also in
-- `user_media` one title rather than two. `user_media` is unique per (user, title), and a
-- ranking of a title nobody logged still counts, which is how the old number worked.
-- ===========================================================================

create or replace function profile_title_counts(p_user uuid)
returns table (movies integer, tv integer)
language sql
stable
security definer
set search_path = public
as $$
  with titles as (
    select um.media_item_id
      from user_media um
     where um.user_id = p_user
       and um.progress is distinct from 'watching'
    union
    select r.media_item_id from rankings r where r.user_id = p_user
  )
  select (count(*) filter (where mi.kind = 'movie'))::integer,
         (count(*) filter (where mi.kind = 'season'))::integer
    from titles t
    join media_items mi on mi.id = t.media_item_id
   where can_i_view(p_user);
$$;

comment on function profile_title_counts(uuid) is
  'The profile stat row''s Movies and TV: distinct watched titles, native or imported, united with ranked titles so a ranked title with no log still counts and a ranked-and-logged one counts once. Seasons count as TV; a season still being watched does not. Definer, gated once by can_i_view(p_user), the rule behind logged_collection and the rankings policy, so it reveals nothing a viewer could not count row by row. Does not feed Top Ranked, scores, leaderboards, streaks, community score or Taste Match, which read rankings.';

revoke all on function profile_title_counts(uuid) from public, anon;
grant execute on function profile_title_counts(uuid) to authenticated;
