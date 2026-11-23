-- Rollback for 20261130001300_a_title_counted_once_on_the_board.sql
--
-- Restores `_leaderboard_counts(text, text)` to its 20261006000100 body, character for
-- character, and the comment it carried before (20260917000100's). Nothing else was
-- changed by the forward migration, so nothing else is restored: `leaderboard`,
-- `my_leaderboard_standing`, every signature, grant, table and index are untouched by
-- both files.
--
-- After a rollback the board is once again movies + seasons only (no whole shows), the
-- all-time board counts every non-imported collection row (a promoted show included),
-- and the monthly arm reads `leaderboard.monthly_from_events` again (true on staging and
-- production, so the events arm is what runs).
--
-- Run in one transaction, with the schema_migrations row:
--
--   begin;
--   <this file>
--   delete from supabase_migrations.schema_migrations where version = '20261130001300';
--   commit;

create or replace function _leaderboard_counts(p_metric text, p_timeframe text)
returns table (user_id uuid, metric_count integer)
language sql stable security definer
set search_path = public
as $$
  with bounds as (
    select _leaderboard_month_start() as from_day,
           (_leaderboard_month_start() + interval '1 month')::date as to_day
  ),
  -- Everyone the caller may read, plus everyone the caller may find (20260902000100).
  eligible as (
    select p.id
      from profiles p
     where auth.uid() is not null
       and (can_view_profile(auth.uid(), p.id) or can_discover_profile(auth.uid(), p.id))
  ),
  -- 20261006000100, R2. Distinct titles with at least one NATIVE-DATED watch event in
  -- the month. No fallback to a recording time, no credit for a diary date, and no
  -- credit for ranking or importing — none of which writes a native-dated event.
  watched_month_events as (
    select we.user_id, count(distinct we.media_item_id)::integer as n
      from watch_events we
      join eligible v on v.id = we.user_id
      join media_items m on m.id = we.media_item_id
      cross join bounds b
     where _monthly_board_from_events()
       and p_timeframe = 'month'
       and p_metric in ('titles', 'movies', 'tv')
       and we.basis in ('today_default', 'reader', 'unattributed')
       and we.watched_on >= b.from_day
       and we.watched_on <  b.to_day
       and m.kind in ('movie', 'season')
       and (p_metric <> 'movies' or m.kind = 'movie')
       and (p_metric <> 'tv'     or m.kind = 'season')
     group by we.user_id
  ),
  -- 20260917000100 and 20260903000100, transcribed, and read until the flag is flipped.
  watched_month_legacy as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
      cross join bounds b
     where not _monthly_board_from_events()
       and p_timeframe = 'month'
       and p_metric in ('titles', 'movies', 'tv')
       and um.source <> 'imported'
       and coalesce(um.watched_on, (um.created_at at time zone 'UTC')::date) >= b.from_day
       and coalesce(um.watched_on, (um.created_at at time zone 'UTC')::date) <  b.to_day
       and m.kind in ('movie', 'season')
       and (p_metric <> 'movies' or m.kind = 'movie')
       and (p_metric <> 'tv'     or m.kind = 'season')
     group by um.user_id
  ),
  watched_all as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
     where p_timeframe = 'all_time'
       and p_metric in ('titles', 'movies', 'tv')
       -- The same rule, and the sharper case: all-time is the board a new account could
       -- otherwise top on its first day (20260917000100). **Unchanged by T4**: this one
       -- is about a library arriving at once, not about when anything was watched.
       and um.source <> 'imported'
       -- No date test. `user_media` is keyed (user, title), so this is already a count
       -- of distinct titles.
       and m.kind in ('movie', 'season')
       and (p_metric <> 'movies' or m.kind = 'movie')
       and (p_metric <> 'tv'     or m.kind = 'season')
     group by um.user_id
  ),
  reviews_month as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
      cross join bounds b
     where p_timeframe = 'month'
       and p_metric = 'reviews'
       and um.note_first_published_at is not null
       and um.note_first_published_at >= (b.from_day::timestamp at time zone 'UTC')
       and um.note_first_published_at <  (b.to_day::timestamp   at time zone 'UTC')
     group by um.user_id
  ),
  reviews_all as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
     where p_timeframe = 'all_time'
       and p_metric = 'reviews'
       -- A state, not an event: the titles this account has a public review on right
       -- now. Un-sharing lowers it and re-sharing restores it.
       and um.note is not null
       and um.note_visibility = 'public'
     group by um.user_id
  )
  select * from watched_month_events
   union all
  select * from watched_month_legacy
   union all
  select * from watched_all
   union all
  select * from reviews_month
   union all
  select * from reviews_all;
$$;

comment on function _leaderboard_counts(text, text) is
  'One person, one number, for one metric and one timeframe, over exactly the accounts the caller may read OR may find -- can_view_profile or can_discover_profile, which since 20260902000100 admits an unapproved private account while still refusing a block in either direction, a suspended account and a deleted one. Since 20260917000100 the two watched metrics exclude user_media.source = ''imported'': a leaderboard records what somebody did in bingd, and a dateless imported row would otherwise be attributed to the month the import ran. Since 20260903000100 the monthly watched metrics attribute a row to coalesce(watched_on, created_at at UTC). All-time watched has no date test. Monthly reviews reads note_first_published_at, an event an edit cannot move; all-time reviews counts titles currently carrying a public note -- neither needs the import predicate, because an import writes no notes. Never returns which titles. Internal: leaderboard and my_leaderboard_standing are the callers, and both validate their arguments first.';

revoke execute on function _leaderboard_counts(text, text) from public, anon, authenticated;
