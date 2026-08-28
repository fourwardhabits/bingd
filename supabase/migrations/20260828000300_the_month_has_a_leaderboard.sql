-- The month has a leaderboard.
-- Founder tranche 2026-08-28 §§7-10, §26: a monthly, viewer-relative standing over
-- four metrics, global for the friend beta and network-relative later.
--
-- ===========================================================================
-- 1. WHY MONTHLY, AND WHY THAT IS A DATA DECISION RATHER THAN A COPY DECISION
--
-- The founder's reasoning is about the behaviour being measured: films and seasons are
-- low-frequency. A weekly board is mostly zeroes and is decided by whoever happened to
-- have a free Saturday; an all-time board is decided once, by whoever joined first, and
-- then never moves again. A month is the shortest window in which an ordinary viewer
-- produces a number worth comparing, and the shortest one that resets often enough for
-- second place to be worth playing for.
--
-- The window is the first day of the current month to the same day next month --
-- half-open, so a title watched on the 31st is in the old month and cannot also be in
-- the new one.
--
-- **One timezone, and it is UTC, named rather than inherited.** `watched_on` is a `date`
-- with no zone (it is a day somebody remembers, not an instant), so the only coherent
-- reading is "the calendar month by one agreed clock". A per-viewer timezone would make
-- two people disagree about who is winning, which is worse than a boundary that moves at
-- UTC midnight for somebody in Auckland — that is a known and accepted cost.
--
-- The *first* version of this file said "the server's clock" and used `current_date`,
-- which reads the **session's** TimeZone. PostgREST does not pin that, so around a
-- rollover two connections could have answered for different months and the board would
-- quietly have been two boards. Independent review caught the claim outrunning the code.
-- Both the date boundary and the `timestamptz` comparison for Reviews now say `UTC` in
-- as many words, so the two metrics cannot drift apart from each other either.
--
-- ===========================================================================
-- 2. THE FOUR METRICS, AND THE CANONICAL FACT BEHIND EACH
--
--   titles   unique rankable titles with `user_media.watched_on` inside the month
--   movies   the same, restricted to `media_items.kind = 'movie'`
--   tv       the same, restricted to `kind = 'season'`
--   reviews  `user_media.note_first_published_at` inside the month (20260828000200)
--
-- In that order, which is the founder's correction of 2026-08-28 and is also the order
-- the chips are drawn in: **Titles | Movies | TV | Reviews**. Titles is the default and
-- is the union of the two beside it, so the row reads as a total followed by its two
-- halves and then a different question -- rather than the total, a different question,
-- and then the halves, which is what the first pass had.
--
-- **The metric is called `titles` here too, and that is deliberate.** The obvious name
-- for a count over `watched_on` is `watched`, and the first draft used it; a chip
-- labelled Titles talking to a metric named `watched` is the kind of drift that survives
-- one rename and is never corrected. Nothing was deployed, so the name follows the
-- product word. `watched_on` keeps its own name, because it is a date and not a metric.
--
-- **Watch-date semantics, not logging-date semantics.** `watched_on` is what the person
-- says about when they watched; `created_at` is when the app heard about it. Logging a
-- July film in August is not an August watch, and the founder asked for the honest
-- reading where one is available. The cost is that a row with **no** date contributes
-- nothing to any month -- which is right: `20260824000100` made "I watched this and I do
-- not remember when" a first-class state, and a memory without a date cannot be
-- attributed to a month without inventing one.
--
-- **Rewatches cannot double-count, structurally rather than by a `distinct`.**
-- `user_media` is keyed `(user_id, media_item_id)`: one row per person per title, ever.
-- A rewatch updates `watched_on` in place, so it moves the title to the new month and
-- leaves nothing behind in the old one. There is no shape in which the same title
-- appears twice in one person's count.
--
-- **`series` rows are excluded and that is PRD §10, not a filter.** A series is not
-- rankable and not loggable; only movies and seasons are. The `kind in` clause states it
-- so that a catalogue row of the wrong kind cannot leak into a total.
--
-- **What is not counted, restated because the absences are the product**: the watchlist
-- (wanting is not watching), private notes (a note nobody can read is not a review),
-- comments, recommendations sent or received, awards, and reactions. None of them
-- appears below, and none of them can be reached from the two tables that do.
--
-- ===========================================================================
-- 3. VIEWER-RELATIVE, WHICH IS THE WHOLE PRIVACY ARGUMENT
--
-- Founder §26: a private account the viewer has not been approved by must not leak its
-- monthly consumption through a standing. So the population is filtered by
-- `can_view_profile(auth.uid(), subject)` -- the same predicate `rankings_read`,
-- `logged_collection` and `taste_match` use -- and the board is therefore **a different
-- list for every viewer**, by construction rather than by a post-filter.
--
-- That gate is exactly the one the founder's §19-24 discoverability change does NOT
-- touch. `20260819000100` separated identity from content: a private account is now
-- findable by name. Its monthly totals are content, so they stay behind
-- `can_view_profile`, and this function is where that distinction is enforced for the
-- leaderboard. **`can_discover_profile` deliberately does not appear in this file.**
--
-- Everything the gate already carries comes for free: a suspended account is absent, a
-- block in either direction removes both parties from each other's board, and the caller
-- always sees themselves (`viewer = subject` is true).
--
-- ### Why this is not a new disclosure for the accounts that do appear
--
-- A viewer who passes `can_view_profile` can already read that account's `rankings`, its
-- `logged_collection`, and its `feed_events` -- which are individually timestamped. The
-- count below is an aggregate over facts they may already enumerate. The one thing it
-- adds is `watched_on`, which PRD §22 classifies as always-private per title: the board
-- publishes **how many** fell in a month and never **which**, never a date, and never a
-- title. That narrowing is deliberate and is recorded in the PRD rather than left to be
-- inferred from this file.
--
-- ===========================================================================
-- 4. DEFINER, AND WHY IT IS NOT AN ORACLE
--
-- `security definer` because `user_media` is owner-only by policy (`user_media_own`,
-- 20260813000500) -- deliberately, since the row carries the note text and the exact
-- date. An invoker function would see only the caller's own row and the board would have
-- one entrant.
--
-- The rule 20260813001900 exists to enforce is that a definer function must not accept
-- *whose* perspective to answer from. This one takes a metric and a page and reads
-- `auth.uid()` for the viewer, so there is no argument to substitute and no question a
-- caller can pose about a pair of third parties.
-- ===========================================================================

create or replace function _leaderboard_month_start()
returns date
language sql stable
set search_path = public
as $$
  -- **UTC, stated rather than inherited.** `current_date` and `date_trunc('month',
  -- current_date)` both read the *session's* TimeZone, which PostgREST does not pin --
  -- so two connections with different settings could disagree about which month it is
  -- for a few hours around a rollover, and the board would quietly be two boards.
  -- Independent review caught the first version claiming a fixed server boundary that
  -- nothing enforced. `now() at time zone 'UTC'` is an explicit instant-to-wall-clock
  -- conversion and does not consult the session at all.
  select date_trunc('month', (now() at time zone 'UTC'))::date;
$$;

comment on function _leaderboard_month_start() is
  'The first day of the current calendar month in UTC. Explicitly UTC rather than the session timezone: current_date reads the connection''s TimeZone, which PostgREST does not pin, so two sessions could disagree about which month it is around a rollover. One definition so the four metrics and the caller''s own standing cannot disagree about where the month begins, and one place to change if the board ever becomes viewer-timezone-relative.';

-- ---------------------------------------------------------------------------
-- The counts, per person, for exactly the accounts this caller may read
--
-- One function rather than four, because the four differ only in a predicate and four
-- copies of the visibility gate is four places for it to be got wrong. `p_metric` is a
-- closed set, validated by the two callers before they reach this.
-- ---------------------------------------------------------------------------

create or replace function _leaderboard_counts(p_metric text)
returns table (user_id uuid, metric_count integer)
language sql stable security definer
set search_path = public
as $$
  with bounds as (
    select _leaderboard_month_start() as from_day,
           (_leaderboard_month_start() + interval '1 month')::date as to_day
  ),
  -- Everyone this caller may read the content of, themselves included. `can_view_profile`
  -- already refuses a suspended account and a block in either direction.
  visible as (
    select p.id
      from profiles p
     where auth.uid() is not null
       and can_view_profile(auth.uid(), p.id)
  ),
  titles as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join visible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
      cross join bounds b
     where p_metric in ('titles', 'movies', 'tv')
       and um.watched_on is not null
       and um.watched_on >= b.from_day
       and um.watched_on <  b.to_day
       -- PRD §10: only these two are rankable, and the metric is over rankable titles.
       and m.kind in ('movie', 'season')
       and (p_metric <> 'movies' or m.kind = 'movie')
       and (p_metric <> 'tv'     or m.kind = 'season')
     group by um.user_id
  ),
  reviews as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join visible v on v.id = um.user_id
      cross join bounds b
     where p_metric = 'reviews'
       and um.note_first_published_at is not null
       -- `::timestamptz` would interpret the date in the *session's* timezone, which is
       -- the same leak `_leaderboard_month_start` closes one function up. `at time zone
       -- 'UTC'` names the zone the boundary was computed in, so the instant this compares
       -- against is the same instant the watched metrics' date boundary describes.
       and um.note_first_published_at >= (b.from_day::timestamp at time zone 'UTC')
       and um.note_first_published_at <  (b.to_day::timestamp   at time zone 'UTC')
     group by um.user_id
  )
  select * from titles
   union all
  select * from reviews;
$$;

comment on function _leaderboard_counts(text) is
  'One person, one number, for the current calendar month and for exactly the accounts can_view_profile admits to auth.uid(). Internal: monthly_leaderboard and my_leaderboard_standing are the two callers, and both validate the metric and add the ordering and the identity. Titles/movies/tv read user_media.watched_on (the watch date, not the logging date; a dateless row counts nowhere); reviews reads note_first_published_at, which an edit cannot move and a re-share cannot buy twice. Never returns which titles.';

-- ---------------------------------------------------------------------------
-- A closed set, refused loudly
--
-- A typo is a bug, and a bug that silently shows the Watched board is a bug nobody
-- reports. Both public functions run this first, so an unknown metric is a named
-- refusal rather than a wrong answer.
-- ---------------------------------------------------------------------------

create or replace function _leaderboard_metric(p_metric text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  v text := coalesce(nullif(btrim(coalesce(p_metric, '')), ''), 'titles');
begin
  if v not in ('titles', 'movies', 'tv', 'reviews') then
    raise exception 'unknown leaderboard metric' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

comment on function _leaderboard_metric(text) is
  'Validates a leaderboard metric and defaults an absent one to titles. Raises P0002 -- this app''s "no such thing" -- rather than falling back, so a client typo is a visible failure instead of a board about the wrong question.';

-- ---------------------------------------------------------------------------
-- The board
--
-- **`rank()` and not `row_number()`.** Two people who watched nine things each are tied
-- and the board says so; the next person is fourth. Ordering *within* a tie is by handle,
-- which is unique, so the list is deterministic across calls without pretending the tie
-- was broken.
--
-- Zeroes are absent rather than listed. A board is a list of people who did something,
-- and padding it with everybody who did not turns the sparse-beta empty state into a
-- wall of noughts.
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
  with counted as (
    select c.user_id, c.metric_count
      from _leaderboard_counts(_leaderboard_metric(p_metric)) c
     where c.metric_count > 0
  )
  select c.user_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         p.visibility,
         c.metric_count,
         rank() over (order by c.metric_count desc)::integer,
         c.user_id = auth.uid()
    from counted c
    join profiles p on p.id = c.user_id
   order by c.metric_count desc, p.username, c.user_id
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

comment on function monthly_leaderboard(text, integer) is
  'The current calendar month''s standing over titles | movies | tv | reviews, as far as the caller is allowed to know. Definer and takes no viewer -- auth.uid() is the perspective, so there is no third-party question to pose (20260813001900). Viewer-relative by can_view_profile: an unapproved private account never appears, which is founder §26 and is why a private account being *discoverable* since 20260819000100 does not put its consumption on anybody''s screen. Ties share a rank and sort by handle, so the list is deterministic. People with a zero are absent. Returns counts, never titles and never dates.';

-- ---------------------------------------------------------------------------
-- Where the caller stands, when they are past the end of the page
--
-- Separate rather than a flag on the board, because it answers a question the board
-- structurally cannot: a rank of 84 is not on a page of 50, and the client needs the
-- number to pin a "You" row rather than a second copy of a row already on screen.
-- `is_you` on the board is what tells it which of the two to draw.
--
-- `entrants` comes back too, so the pinned row can read "84 of 96" rather than a rank
-- against an unknown denominator.
-- ---------------------------------------------------------------------------

create or replace function my_leaderboard_standing(p_metric text default 'titles')
returns table (metric_count integer, rank integer, entrants integer)
language sql stable security definer
set search_path = public
as $$
  with counted as (
    select c.user_id, c.metric_count
      from _leaderboard_counts(_leaderboard_metric(p_metric)) c
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

comment on function my_leaderboard_standing(text) is
  'The caller''s own row in the same board monthly_leaderboard draws, for pinning when their rank is past the end of the page. Rank is null when they have not done the thing this month -- a person with nothing to count has no position, and 0 would claim a last place they have not earned. entrants is the size of the board this caller can see, which is viewer-relative for the same reason the board is. Always exactly one row.';

revoke execute on function _leaderboard_month_start()         from public, anon, authenticated;
revoke execute on function _leaderboard_counts(text)          from public, anon, authenticated;
revoke execute on function _leaderboard_metric(text)          from public, anon, authenticated;
revoke execute on function monthly_leaderboard(text, integer) from public, anon, authenticated;
revoke execute on function my_leaderboard_standing(text)      from public, anon, authenticated;
grant  execute on function monthly_leaderboard(text, integer) to authenticated;
grant  execute on function my_leaderboard_standing(text)      to authenticated;
