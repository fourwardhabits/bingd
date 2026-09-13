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
--
-- And nothing else moves. Top Ranked, scores, leaderboards, streaks, feed activity,
-- community score and Taste Match all read `rankings` and still do; none of them is touched
-- here. `usePublicProfile` keeps reading the ranked counts for the Taste Match line.
--
-- ===========================================================================
-- WHY A FUNCTION, AND WHY INVOKER
--
-- `user_media` is own-read only, and a count of somebody else's watched films has to come
-- through the gate a profile's collection already comes through: `logged_collection`, the
-- `can_i_view` view the awards shelf reads (20260827000400). `rankings` has the same gate as
-- its policy. So this is `security invoker` over exactly those two, and it can reveal
-- nothing a viewer could not already count row by row. A private account the viewer may
-- not see answers zero, which is what the ranked count answered before.
--
-- The union is over `media_item_id`, which is what makes a ranked title that is also in
-- `user_media` one title rather than two. `user_media` is unique per (user, title), and a
-- ranking of a title nobody logged still counts, which is how the old number worked.
-- ===========================================================================

create or replace function profile_title_counts(p_user uuid)
returns table (movies integer, tv integer)
language sql
stable
security invoker
set search_path = public
as $$
  with titles as (
    select lc.media_item_id from logged_collection lc where lc.user_id = p_user
    union
    select r.media_item_id from rankings r where r.user_id = p_user
  )
  select (count(*) filter (where mi.kind = 'movie'))::integer,
         (count(*) filter (where mi.kind = 'season'))::integer
    from titles t
    join media_items mi on mi.id = t.media_item_id;
$$;

comment on function profile_title_counts(uuid) is
  'The profile stat row''s Movies and TV: distinct watched titles, native or imported, united with ranked titles so a ranked title with no log still counts and a ranked-and-logged one counts once. Seasons count as TV. Invoker over logged_collection and rankings, both can_i_view-gated, so it reveals nothing a viewer could not count row by row. Does not feed Top Ranked, scores, leaderboards, streaks, community score or Taste Match, which read rankings.';

revoke all on function profile_title_counts(uuid) from public, anon;
grant execute on function profile_title_counts(uuid) to authenticated;
