-- A leaderboard with a longer memory, and rows that say who you are looking at.
-- Founder follow-up to PR #69, 2026-08-29: This month | All time, and Match beside the
-- name.
--
-- ===========================================================================
-- 1. WHY THE FUNCTION IS RENAMED, AND WHY THE OLD NAME SURVIVES ANYWAY
--
-- `monthly_leaderboard` cannot answer an all-time question without its own name being a
-- lie, and this schema has just spent a tranche removing exactly that kind of drift
-- (`watched` → `titles`, `wall` → `poster`). So the board is `leaderboard` now, with the
-- timeframe as an argument.
--
-- **The old name stays as a delegating wrapper**, which is not tidiness — it is the
-- 20260827000900 lesson about un-relaunched phones. The beta OTA published yesterday
-- calls `monthly_leaderboard(p_metric, p_limit)`. A phone that has not picked up today's
-- update still calls it, and a dropped function is a leaderboard that returns an error
-- to somebody who did nothing wrong. The wrapper answers exactly what it always did —
-- this month — and carries no timeframe argument, so an old client cannot accidentally
-- reach the new view either.
--
-- ===========================================================================
-- 2. THE TWO TIMEFRAMES, AND WHY THEY ARE NOT THE SAME QUESTION TWICE
--
--   month     what you did in this calendar month
--   all_time  what you have done
--
-- Three of the four metrics differ only by dropping the date window. **Reviews differs
-- in kind**, and that is the founder's specification rather than an inconsistency:
--
--   month     reviews whose *first publication* fell in this month — an event
--   all_time  titles for which the account *currently has* a public review — a state
--
-- Both are uninflatable, by different mechanisms. The monthly one is stamped once and
-- never moves (20260828000200), so an edit cannot mint a review and a re-share cannot
-- buy a second. The all-time one counts what is true right now, so unsharing lowers it
-- and resharing restores it — you cannot exceed the number of titles you actually have
-- public reviews on, however many times you toggle them.
--
-- **All-time watched drops the date requirement, deliberately.** A title logged with no
-- `watched_on` is still watched — 20260824000100 made "I watched this and I do not
-- remember when" a first-class state — and with no month to attribute it to there is
-- nothing to be dishonest about. The count is then exactly the one `_award_metric` uses
-- for Movie Muncher and Season Snacker, and exactly what a profile's Movies/TV numbers
-- already show an authorised viewer. One definition of "watched", three surfaces.
--
-- ===========================================================================
-- 3. MATCH ON THE ROW
--
-- `20260826000600` part N refused to put Match on the Followers list, and the reasoning
-- was a cost argument: "a list of fifty people would be fifty of those", and there is no
-- batched form. That reasoning is unchanged and is exactly why this is allowed here —
-- `people_taste_matches` already calls `taste_match` per candidate over a set bounded to
-- thirty, and this board is bounded to a hundred with the client asking for fifty. It is
-- the same shape at the same order of magnitude, on a surface whose entire purpose is
-- social discovery, behind a minute of client staleness.
--
-- What is *not* relaxed: `taste_match` decides. It refuses the caller themselves and
-- anyone `can_view_profile` does not admit, returning the same insufficient-overlap
-- shape either way — so a row cannot disclose through Match what the board's own
-- population filter already refuses to disclose. The caller's own row carries nulls and
-- the client draws "You" there instead (founder §6: never a self-Match).
-- ===========================================================================

create or replace function _leaderboard_timeframe(p_timeframe text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  v text := coalesce(nullif(btrim(coalesce(p_timeframe, '')), ''), 'month');
begin
  if v not in ('month', 'all_time') then
    raise exception 'unknown leaderboard timeframe' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

comment on function _leaderboard_timeframe(text) is
  'Validates a leaderboard timeframe and defaults an absent one to month. Raises P0002 rather than falling back, for the reason _leaderboard_metric does: a client typo must be a visible failure, not a board about the wrong question. Two values only -- week and year were ruled out by the founder and are on the deferred roadmap.';

-- ---------------------------------------------------------------------------
-- The counts, per person, per timeframe
--
-- One function still, because the visibility gate is the part that must not be written
-- twice. The four branches differ only in their predicate.
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
  -- Everyone this caller may read the content of, themselves included. `can_view_profile`
  -- already refuses a suspended account and a block in either direction. Unchanged from
  -- 20260828000300, and it is what keeps founder §26 true in both timeframes.
  visible as (
    select p.id
      from profiles p
     where auth.uid() is not null
       and can_view_profile(auth.uid(), p.id)
  ),
  watched_month as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join visible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
      cross join bounds b
     where p_timeframe = 'month'
       and p_metric in ('titles', 'movies', 'tv')
       and um.watched_on is not null
       and um.watched_on >= b.from_day
       and um.watched_on <  b.to_day
       and m.kind in ('movie', 'season')
       and (p_metric <> 'movies' or m.kind = 'movie')
       and (p_metric <> 'tv'     or m.kind = 'season')
     group by um.user_id
  ),
  watched_all as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join visible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
     where p_timeframe = 'all_time'
       and p_metric in ('titles', 'movies', 'tv')
       -- No date test. A watch without a date is still a watch, and with no month to
       -- attribute it to there is nothing to get wrong. `user_media` is keyed
       -- (user, title), so this is already a count of distinct titles.
       and m.kind in ('movie', 'season')
       and (p_metric <> 'movies' or m.kind = 'movie')
       and (p_metric <> 'tv'     or m.kind = 'season')
     group by um.user_id
  ),
  reviews_month as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join visible v on v.id = um.user_id
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
      join visible v on v.id = um.user_id
     where p_timeframe = 'all_time'
       and p_metric = 'reviews'
       -- **A state, not an event.** The titles this account has a public review on right
       -- now. Un-sharing lowers it and re-sharing restores it, so the toggle is a way of
       -- reaching a number you already earned rather than a way of exceeding it.
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
  'One person, one number, for one metric and one timeframe, over exactly the accounts can_view_profile admits to auth.uid(). Monthly watched reads user_media.watched_on (the watch date, not the logging date; a dateless row counts nowhere); all-time watched drops the date test, because a watch without a date is still a watch and there is no month to misattribute it to. Monthly reviews reads note_first_published_at, an event an edit cannot move; all-time reviews counts titles currently carrying a public note, a state a re-share cannot exceed. Never returns which titles. Internal: leaderboard and my_leaderboard_standing are the callers, and both validate their arguments first.';

-- ---------------------------------------------------------------------------
-- The board
-- ---------------------------------------------------------------------------

create or replace function leaderboard(
  p_metric    text default 'titles',
  p_timeframe text default 'month',
  p_limit     integer default 50
)
returns table (
  user_id       uuid,
  username      text,
  display_name  text,
  avatar_path   text,
  visibility    profile_visibility,
  metric_count  integer,
  rank          integer,
  is_you        boolean,
  match_percent integer,
  shared_count  integer
)
language sql stable security definer
set search_path = public
as $$
  with counted as (
    select c.user_id, c.metric_count
      from _leaderboard_counts(
             _leaderboard_metric(p_metric),
             _leaderboard_timeframe(p_timeframe)
           ) c
     where c.metric_count > 0
  ),
  page as (
    select c.user_id,
           c.metric_count,
           rank() over (order by c.metric_count desc)::integer as rnk,
           p.username, p.display_name, p.avatar_path, p.visibility
      from counted c
      join profiles p on p.id = c.user_id
     -- Ties share a rank and sort by handle, so the list is deterministic across calls
     -- without pretending the tie was broken.
     order by c.metric_count desc, p.username, c.user_id
     limit least(greatest(coalesce(p_limit, 50), 1), 100)
  )
  select page.user_id,
         page.username::text,
         page.display_name,
         page.avatar_path,
         page.visibility,
         page.metric_count,
         page.rnk,
         page.user_id = auth.uid(),
         -- Computed only for the rows actually returned, so the cost is the page rather
         -- than the population. `taste_match` refuses self and anyone can_view_profile
         -- does not admit, and returns its insufficient-overlap shape either way — so
         -- nothing here can disclose what the population filter above already refuses.
         tm.score,
         tm.common_count
    from page
    left join lateral taste_match(page.user_id) tm on true;
$$;

comment on function leaderboard(text, text, integer) is
  'The leaderboard over watched | movies | tv | reviews, for this calendar month or for all time, as far as the caller is allowed to know. Definer and takes no viewer -- auth.uid() is the perspective, so there is no third-party question to pose (20260813001900). Viewer-relative by can_view_profile in both timeframes: an unapproved private account never appears, count and all, which is founder §26 and is why a private account being *discoverable* since 20260819000100 does not put its consumption on anybody''s screen. Ties share a rank and sort by handle. People with a zero are absent. Carries match_percent and shared_count per row from taste_match, which decides for itself and returns nulls for the caller''s own row. Returns counts, never titles and never dates.';

-- ---------------------------------------------------------------------------
-- The old name, delegating
--
-- Un-relaunched phones (20260827000900). Same two arguments, same eight columns, same
-- answer: this month. It cannot reach the all-time view, because it has nowhere to say
-- so — which is the right shape for a compatibility surface.
-- ---------------------------------------------------------------------------

create or replace function monthly_leaderboard(
  p_metric text default 'titles',
  p_limit  integer default 50
)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility,
  metric_count integer,
  rank         integer,
  is_you       boolean
)
language sql stable security definer
set search_path = public
as $$
  select l.user_id, l.username, l.display_name, l.avatar_path, l.visibility,
         l.metric_count, l.rank, l.is_you
    from leaderboard(p_metric, 'month', p_limit) l;
$$;

comment on function monthly_leaderboard(text, integer) is
  'This month''s board, in the eight-column shape the 2026-08-28 beta OTA calls. Kept as a delegating wrapper over leaderboard() so a phone that has not taken today''s update still works (the 20260827000900 rule about un-relaunched clients). Carries no timeframe argument and no Match columns, so an old client can neither reach the all-time view nor be surprised by a wider row.';

-- ---------------------------------------------------------------------------
-- Where the caller stands
-- ---------------------------------------------------------------------------

create or replace function my_leaderboard_standing(
  p_metric    text default 'titles',
  p_timeframe text default 'month'
)
returns table (metric_count integer, rank integer, entrants integer)
language sql stable security definer
set search_path = public
as $$
  with counted as (
    select c.user_id, c.metric_count
      from _leaderboard_counts(
             _leaderboard_metric(p_metric),
             _leaderboard_timeframe(p_timeframe)
           ) c
     where c.metric_count > 0
  ),
  ranked as (
    select user_id, metric_count, rank() over (order by metric_count desc)::integer as r
      from counted
  )
  select coalesce(me.metric_count, 0),
         me.r,
         (select count(*)::integer from counted)
    from (select 1 as one) o
    left join ranked me on me.user_id = auth.uid();
$$;

comment on function my_leaderboard_standing(text, text) is
  'The caller''s own row in the same board leaderboard() draws, for pinning when their rank is past the end of the page. Rank is null when they have not done the thing in this timeframe -- a person with nothing to count has no position, and 0 would claim a last place they have not earned. entrants is the size of the board this caller can see, viewer-relative for the same reason the board is. Always exactly one row. Gained p_timeframe on 20260829000100; the single-argument form is unreachable because the default fills it, so no compatibility overload is needed.';

revoke execute on function _leaderboard_timeframe(text)                from public, anon, authenticated;
revoke execute on function _leaderboard_counts(text, text)             from public, anon, authenticated;
revoke execute on function leaderboard(text, text, integer)            from public, anon, authenticated;
revoke execute on function monthly_leaderboard(text, integer)          from public, anon, authenticated;
revoke execute on function my_leaderboard_standing(text, text)         from public, anon, authenticated;
grant  execute on function leaderboard(text, text, integer)            to authenticated;
grant  execute on function monthly_leaderboard(text, integer)          to authenticated;
grant  execute on function my_leaderboard_standing(text, text)         to authenticated;

-- ---------------------------------------------------------------------------
-- The two superseded signatures, dropped rather than left beside their replacements
--
-- PostgREST resolves by argument *name*, so a client calling
-- `my_leaderboard_standing({p_metric})` against both a one-argument and a two-argument
-- form is the ambiguity 20260817000600 records as the reason `save_profile` replaced its
-- two predecessors rather than joining them. With the old one gone, that same call
-- resolves to the new function and `p_timeframe` takes its default — so yesterday's OTA
-- keeps working without a wrapper, which is why this one does not need the treatment
-- `monthly_leaderboard` gets above.
--
-- `_leaderboard_counts(text)` is internal and now has no caller at all. Left in place it
-- would be a second definition of the monthly metrics, which is exactly the drift the
-- one-function-four-branches shape exists to prevent.
-- ---------------------------------------------------------------------------
drop function if exists my_leaderboard_standing(text);
drop function if exists _leaderboard_counts(text);
