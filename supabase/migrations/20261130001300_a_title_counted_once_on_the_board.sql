-- A title counted once on the board (Leaderboard UI & Counting Refinement, founder brief
-- 2026-11-23, §3-§4).
--
-- Rebuilds `_leaderboard_counts`, the one counting function `leaderboard` and
-- `my_leaderboard_standing` both read, from its live definition (20261006000100). Neither
-- caller is touched: their signatures, the population (`can_view_profile` or
-- `can_discover_profile`, so blocks, suspensions and deletions stay out and an unapproved
-- private account stays a minimal row), the tie ranking, the ordering, the limit and the
-- viewer-relative denominator are exactly what they were. Reviews are transcribed
-- character for character. No title and no date leaves the function, as before.
--
-- ===========================================================================
-- THE RULE
--
-- **A point is a distinct title the reader has watched, never a ranking operation.**
-- Movies, whole TV shows and TV seasons are three independently rankable units
-- (20261114000200), and each is now an independently countable one:
--
--   titles   movies + whole shows + seasons
--   movies   movies
--   tv       whole shows + seasons
--   reviews  unchanged
--
-- A show and its first season, each logged, are two; a show and three seasons, four.
-- Seasons are never collapsed into their series here: that is the Profile's TV count
-- (`profile_title_counts`, 20261120000100), a different question about a poster wall.
--
-- "Watched" is the collection row (`user_media`, the SEEN claim, 20261003000100 §D.0) —
-- not a season merely marked `watching`, which `_viewer_has_seen` has never called seen —
-- **with at least one watch event of the title's own** that is not promotion
-- bookkeeping (below). Every seen title has one (W1); the single deliberate exception is
-- a show placed on the TV wall from its seasons' average (`rank_promote_show`, #319),
-- whose collection row exists only so its explicit ranking has one (I3) and which is
-- "seen through its seasons". That row is a ranking, not a viewing, so it counts nothing
-- — and its Undo, which removes or restores the row, can therefore take nothing away.
--
-- `count(*)` over `user_media` rows, which are keyed (user, title): one title is one
-- point however many events, rankings, placements, corrections or reorders it has.
--
-- ===========================================================================
-- ALL TIME
--
-- Every watched title, dated or not, once. The import rule of 20260917000100 is kept
-- verbatim (`source <> 'imported'`): an archive arriving at once is not something
-- somebody did in bingd, and the board a new account could otherwise top on its first
-- day is this one. It is the established provenance ratchet that decides when an
-- imported title becomes native — a watch logged here, or the reader ranking it
-- (`_ranking_is_a_native_action`) — and this migration does not move it.
--
-- ===========================================================================
-- THIS MONTH (UTC, `_leaderboard_month_start`, unchanged)
--
-- Distinct watched titles with at least one **native-dated** watch event inside the
-- month: basis `today_default`, `reader` or `unattributed` (R2, 20261006000100). So:
--
--   a new watch this month                         counts
--   a rewatch this month                           counts once
--   a film imported today with last year's date    nothing (`diary`, and not this month)
--   a backlog title logged today as "Earlier"      nothing (`none`: no evidence of when)
--   an undated title, whenever it was recorded     nothing (no fallback to a recording time)
--   a ranking, a correction, a reorder, Keep Show  nothing (none of them writes an event)
--
-- **The `leaderboard.monthly_from_events` flag no longer reaches the board.** It has
-- been true on staging and production since the T4 cutover, and the branch it guarded
-- was `coalesce(watched_on, created_at)` — a recording time read as a watch time, which
-- is the one thing this board must not do. The legacy arm is deleted rather than carried
-- forward with series added to it; the flag and `_monthly_board_from_events()` stay for
-- `watch_history_repoint_diff` and anything else that reads them. Rollback is the SQL in
-- docs/release/leaderboard-counting/rollback-20261130001300.sql, which restores the
-- 20261006000100 body (flag and all).
--
-- **The documented limit.** `today_default` means the log sheet offered Today and the
-- reader kept it. A reader entering an old film through Search and leaving Today on it
-- asserts a watch today, and the board believes the assertion: the watch-history model
-- records what the reader said, and inventing a different date would be the
-- fabrication the whole epic exists to stop. What the board never does is supply a date
-- nobody gave.
--
-- ===========================================================================
-- PROMOTION BOOKKEEPING, AND HOW IT IS TOLD FROM A VIEWING
--
-- `_a_placed_show_keeps_its_evidence` (20261129000300) gives a promoted show the
-- ordinary "watched, time unknown" event if every season it was seen through later
-- leaves the collection, so W1 still holds. That event says nothing anybody did: it is
-- undated (`none`), carries no `import_ref`, and was recorded no later than the promotion
-- that created the row — its `recorded_at` is the row's own `created_at`, which is the
-- promotion's transaction time. A genuine later log of the show is recorded after the
-- promotion, so the test below cannot mistake one for the other, and a show whose row
-- existed before it was promoted (`had_row`) is not a promotion-made row at all.
--
-- No write path changes. No table, column, index, grant or signature changes.
-- ---------------------------------------------------------------------------

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
  -- 20261130001300: the kinds each watched metric counts. A whole show is its own unit,
  -- beside its seasons, never instead of them.
  kinds as (
    select k
      from unnest(case p_metric
                    when 'titles' then array['movie', 'series', 'season']::media_kind[]
                    when 'movies' then array['movie']::media_kind[]
                    when 'tv'     then array['series', 'season']::media_kind[]
                    else array[]::media_kind[]
                  end) as k
  ),
  -- 20261130001300: the watched titles, one row per (user, title). Seen, not merely in
  -- progress, and one of this metric's kinds.
  watched as (
    select um.user_id, um.media_item_id, um.source
      from user_media um
      join eligible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
      join kinds on kinds.k = m.kind
     where p_metric in ('titles', 'movies', 'tv')
       and um.progress is distinct from 'watching'
  ),
  -- Distinct titles with at least one NATIVE-DATED watch event in the UTC month (R2).
  -- No fallback to a recording time, no credit for a diary date, and no credit for
  -- ranking or importing -- none of which writes a native-dated event.
  watched_month as (
    select w.user_id, count(*)::integer as n
      from watched w
      cross join bounds b
     where p_timeframe = 'month'
       and exists (
         select 1 from watch_events we
          where we.user_id = w.user_id
            and we.media_item_id = w.media_item_id
            and we.basis in ('today_default', 'reader', 'unattributed')
            and we.watched_on >= b.from_day
            and we.watched_on <  b.to_day
       )
     group by w.user_id
  ),
  -- Every watched title once, with a watch of its own that is not promotion bookkeeping,
  -- and not an import the reader has done nothing with here (20260917000100).
  watched_all as (
    select w.user_id, count(*)::integer as n
      from watched w
     where p_timeframe = 'all_time'
       and w.source <> 'imported'
       and exists (
         select 1 from watch_events we
          where we.user_id = w.user_id
            and we.media_item_id = w.media_item_id
            and not (
              we.basis = 'none'
              and we.import_ref is null
              and exists (
                select 1 from show_promotions sp
                 where sp.user_id = we.user_id
                   and sp.media_item_id = we.media_item_id
                   and not sp.had_row
                   and we.recorded_at <= sp.created_at
              )
            )
       )
     group by w.user_id
  ),
  -- Transcribed from 20261006000100, unchanged.
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
  -- Transcribed from 20261006000100, unchanged.
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
  select * from watched_month
   union all
  select * from watched_all
   union all
  select * from reviews_month
   union all
  select * from reviews_all;
$$;

comment on function _leaderboard_counts(text, text) is
  'One person, one number, for one metric and one timeframe, over exactly the accounts the caller may read or may find (can_view_profile or can_discover_profile; blocks, suspension and deletion excluded). Since 20261130001300 the watched metrics count DISTINCT WATCHED TITLES, never ranking operations: titles = movies + whole shows + seasons, movies = movies, tv = whole shows + seasons, each title once. Watched = a user_media row not marked watching, with a watch event of its own that is not show-promotion bookkeeping (a show placed from its seasons'' average counts nothing). This month = at least one native-dated event (today_default, reader, unattributed) in the UTC month; no recording-time fallback, no diary credit, and the leaderboard.monthly_from_events flag no longer applies. All time = every watched title, dated or not, excluding source = imported (20260917000100). Reviews unchanged: monthly reads note_first_published_at, all-time counts titles currently carrying a public note. Never returns which titles or any date. Internal: leaderboard and my_leaderboard_standing are the callers, and both validate their arguments first.';

revoke execute on function _leaderboard_counts(text, text) from public, anon, authenticated;
