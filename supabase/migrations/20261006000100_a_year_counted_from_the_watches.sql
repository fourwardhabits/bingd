-- ---------------------------------------------------------------------------
-- T4 — the readers repoint.
--
-- `watch-history-and-ranking-calibration.md` §L.2, §M.5, PR N5, founder decision R2.
--
-- ===========================================================================
-- TWO READERS, AND THEY WERE WRONG IN OPPOSITE DIRECTIONS
--
--   **The yearly goal** counts `user_media.watched_on`, which is ONE date per title. A
--   film watched in 2025 and rewatched in 2026 counts in 2026 and **stops counting in
--   2025** — the rewatch moved the only date there was. `goals.ts` has carried that
--   defect in its own header since 2026-08-16 ("accepted rather than fixed: the
--   alternative is a watch-history table"). The watch-history table now exists, so the
--   goal counts **distinct titles with at least one event dated in the year**, and both
--   years are true at once.
--
--   **The monthly leaderboard** is the ONLY server code that falls back from watching to
--   recording: `coalesce(watched_on, created_at at UTC)`, added deliberately by
--   20260903000100 because five of twelve accounts had no dates at all. That fallback
--   credits an undated in-app row to the month it was created, and a ranked import to
--   the month the import ran (§C.3.5). **R2 removes it**: the monthly board counts
--   distinct titles with at least one NATIVE-DATED event in the month, and nothing else.
--
-- ===========================================================================
-- WHY BOTH ARE BEHIND FLAGS, AND WHY BOTH DEFAULT TO OFF
--
-- §M.2: "Goal repoint: client **first**, then the server trigger — the reverse order
-- announces completions the bar doesn't show." That is an ordering constraint between a
-- migration and an OTA, and a comment is not a mechanism for one.
--
-- So this migration is **inert on the day it applies**. Every number it can change is
-- behind a flag that starts false:
--
--   `goals.count_watch_events`        the goal, client and trigger
--   `leaderboard.monthly_from_events` the monthly board
--
-- The sequence is: apply this, ship the client OTA, run the per-account diff
-- (`scripts/ops/watch-history-diff.mjs`), then flip the flags — and flip them back in
-- one statement if the diff was read wrong. §M.5 expects the numbers to move and names
-- the direction; the diff is what turns "expected" into "enumerated before anybody saw
-- it".
--
-- **The old code paths are kept, not deleted**, and read when the flag is off. That is
-- what makes the rollback a flag rather than a forward migration written at speed.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The flags
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  ('goals.count_watch_events',        'false'::jsonb),
  ('leaderboard.monthly_from_events', 'false'::jsonb)
on conflict (key) do nothing;

create or replace function _goals_from_events()
returns boolean
language sql stable
set search_path = public
as $$
  select coalesce((select (value)::boolean from app_config
                    where key = 'goals.count_watch_events'), false);
$$;

revoke execute on function _goals_from_events() from public, anon, authenticated;

create or replace function _monthly_board_from_events()
returns boolean
language sql stable
set search_path = public
as $$
  select coalesce((select (value)::boolean from app_config
                    where key = 'leaderboard.monthly_from_events'), false);
$$;

revoke execute on function _monthly_board_from_events() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. The yearly goal (§L.2)
--
-- **Distinct titles with at least one event dated in the year.** Both native-dated and
-- diary-dated count: the goal contract is that a genuine date counts, and a Letterboxd
-- diary date is genuine — it is the authoritative record of a viewing, from the reader's
-- own archive. Undated events count for nothing, which is rule 2 unchanged.
--
-- `count(distinct media_item_id)`, and the `distinct` is now load-bearing rather than
-- documentary. `goals.ts`'s rule 4 predicted this in as many words: "it is where the
-- rule is *written down*, so that a later watch-history table cannot quietly turn a goal
-- of 52 into a goal of 52 viewings". Three rewatches of one film in one year are one
-- film.
-- ---------------------------------------------------------------------------

create or replace function _goal_qualifying_count(
  p_user     uuid,
  p_year     integer,
  p_category ranking_category
)
returns integer
language sql stable
set search_path = public
as $$
  select case when _goals_from_events() then (
    -- 20261006000100, and the whole point of the tranche: a title counts in EVERY year
    -- it has a dated viewing in, so a 2025 watch and a 2026 rewatch are two true facts
    -- rather than one overwritten one.
    select count(distinct we.media_item_id)::integer
      from watch_events we
      join media_items m on m.id = we.media_item_id
     where we.user_id = p_user
       and we.watched_on is not null
       and extract(year from we.watched_on) = p_year
       and rankable_category(m.kind) = p_category
  ) else (
    -- 20260829000200, transcribed, and read until the flag is flipped.
    select count(*)::integer
      from user_media um
      join media_items m on m.id = um.media_item_id
     where um.user_id = p_user
       and um.watched_on is not null
       and extract(year from um.watched_on) = p_year
       and rankable_category(m.kind) = p_category
  ) end;
$$;

comment on function _goal_qualifying_count(uuid, integer, ranking_category) is
  'Distinct titles with at least one watch event dated in the year (native or diary), '
  'once goals.count_watch_events is true; the pre-epic cache-based count until then. A '
  'series belongs to no goal (rankable_category is null). An undated viewing counts for '
  'nothing: guessing "this year" is the fabrication the whole epic exists to stop.';


-- ---------------------------------------------------------------------------
-- 3. The goal triggers follow the events
--
-- Today the crossing is detected by two statement triggers on `user_media`. Once goals
-- count events, a rewatch dated this year can complete a goal without touching
-- `user_media` at all -- the cache does not move, because the rewatch is not the latest
-- date -- so the crossing would be counted by nobody and announced by nobody.
--
-- The two existing triggers are left in place and taught to stand down when the flag is
-- on, rather than dropped. A dropped trigger is a rollback that needs a migration; a
-- trigger that reads a flag is a rollback that needs a statement.
-- ---------------------------------------------------------------------------

create or replace function _goal_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  -- 20261006000100. The watch_events triggers below own this once goals count events.
  if _goals_from_events() then
    return null;
  end if;

  for r in
    select n.user_id                                    as who,
           extract(year from n.watched_on)::integer     as yr,
           rankable_category(m.kind)                    as cat,
           count(*)::integer                            as added,
           -- 20260901000100: the titles whose dates carried the count over, so the
           -- completion can find the activity that caused it (§20260902000100's
           -- causal_at adoption). Lost on the first transcription of this function in
           -- 20261006000100, and the celebration went back to sorting at its own
           -- moment rather than under the ranking that earned it.
           array_agg(n.media_item_id)                   as items
      from new_rows n
      join media_items m on m.id = n.media_item_id
     where n.watched_on is not null
       and rankable_category(m.kind) is not null
     group by 1, 2, 3
     -- Deterministic order, so two statements touching the same several groups take the
     -- advisory locks below in the same sequence and cannot deadlock against each other.
     order by 1, 2, 3
  loop
    perform _maybe_goal_completion(r.who, r.yr, r.cat, r.added, r.items);
  end loop;
  return null;
end;
$$;

create or replace function _goal_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if _goals_from_events() then
    return null;
  end if;

  for r in
    select n.user_id                                as who,
           extract(year from n.watched_on)::integer as yr,
           rankable_category(m.kind)                as cat,
           count(*)::integer                        as added,
           -- 20260901000100. See `_goal_after_insert`.
           array_agg(n.media_item_id)               as items
      from new_rows n
      -- `user_media` is keyed (user_id, media_item_id), so this pairs each updated row
      -- with its own previous state.
      join old_rows o on o.user_id = n.user_id and o.media_item_id = n.media_item_id
      join media_items m on m.id = n.media_item_id
     where n.watched_on is not null
       and rankable_category(m.kind) is not null
       -- Newly qualifying for *this* year: it either had no date, or had one in a
       -- different year. A date corrected from March to April is not a new title.
       and (o.watched_on is null
            or extract(year from o.watched_on) <> extract(year from n.watched_on))
     group by 1, 2, 3
     order by 1, 2, 3
  loop
    perform _maybe_goal_completion(r.who, r.yr, r.cat, r.added, r.items);
  end loop;
  return null;
end;
$$;


/**
 * A dated event arrived, or an edit moved one into a year.
 *
 * **"Newly qualifying" is a different question here**, and getting it wrong is the
 * difference between a celebration and silence. On `user_media` a title had one date, so
 * "it moved into this year" was the whole test. A title can have six events, and a
 * seventh dated in a year it already counted in adds nothing to a goal that counts
 * distinct titles.
 *
 * So the test is: **is this the only event of this title dated in this year?** If yes,
 * the title is new to the year and `added` counts it once. If no, the year already had
 * it and the count did not move.
 *
 * `_maybe_goal_completion` is still the only thing that decides whether a crossing
 * happened, under its own advisory lock, and it refuses anything that is not a
 * transition. This function's job is only to say which groups to ask about, and by how
 * much they grew.
 */
create or replace function _goal_after_watch_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if not _goals_from_events() then
    return null;
  end if;

  -- An import or the T1 backfill writes thousands of dated events, and every one of them
  -- could look like a crossing. The quiet marker is what `_no_activity_while_importing`
  -- already uses; asking here as well means the work is skipped rather than done and
  -- discarded.
  if _importing() then
    return null;
  end if;

  for r in
    select n.user_id                                as who,
           extract(year from n.watched_on)::integer as yr,
           rankable_category(m.kind)                as cat,
           count(distinct n.media_item_id)::integer as added,
           -- The titles that carried it over, so the celebration sorts under the
           -- activity that earned it rather than at its own moment (20260902000100).
           array_agg(distinct n.media_item_id)      as items
      from new_rows n
      join media_items m on m.id = n.media_item_id
     where n.watched_on is not null
       and rankable_category(m.kind) is not null
       -- The only event of this title in this year, so the title is new to the year.
       and (
         select count(*) from watch_events we
          where we.user_id = n.user_id
            and we.media_item_id = n.media_item_id
            and we.watched_on is not null
            and extract(year from we.watched_on) = extract(year from n.watched_on)
       ) = 1
     group by 1, 2, 3
     -- Deterministic order, for the same deadlock reason 20260829000200 gives.
     order by 1, 2, 3
  loop
    perform _maybe_goal_completion(r.who, r.yr, r.cat, r.added, r.items);
  end loop;
  return null;
end;
$$;

revoke execute on function _goal_after_watch_events() from public, anon, authenticated;

create trigger goal_on_watch_events_insert
  after insert on watch_events
  referencing new table as new_rows
  for each statement execute function _goal_after_watch_events();

-- An edit that moves a date into a year is the same event for a goal as one arriving
-- there. A DELETE needs no trigger: `_maybe_goal_completion` only ever fires on a
-- transition upward, and a count going down is not one.
create trigger goal_on_watch_events_update
  after update on watch_events
  referencing new table as new_rows
  for each statement execute function _goal_after_watch_events();


-- ---------------------------------------------------------------------------
-- 4. The monthly leaderboard (R2, §L.2, §M.5)
--
-- Rebuilt from 20260917000100. The `watched_month` branch is replaced; `watched_all`,
-- `reviews_month` and `reviews_all` are transcribed character for character.
--
-- ===========================================================================
-- WHAT LEAVES, AND WHAT IT COSTS
--
--   **`coalesce(watched_on, created_at at UTC)`** — gone. It is the only place in the
--   server that reads a recording time as a watch time, and §O.2's repository test now
--   fails on any expression of that shape. Accounts whose rows were credited by their
--   creation date lose that credit: that is R2's intended effect, it is what the diff
--   enumerates per account, and it is the difference between a board that says what
--   people watched this month and one that says who used the app this month.
--
--   **`source <> 'imported'`** — gone from the monthly branch only, because the basis
--   filter subsumes it and states the rule better. `diary` events never count, so an
--   import cannot reach this board whatever its row's provenance; and a title that WAS
--   imported and has since been watched natively has a `today_default` or `reader` event
--   and should count, which the old filter would have refused. **The all-time board
--   keeps its `source <> 'imported'` exclusion**, unchanged: that one is about a library
--   arriving at once, which is a different rule for a different reason (20260917000100).
--
--   **`count(distinct media_item_id)`** — distinct titles, not viewings. Three rewatches
--   of one film in one month is one title, which is what the board has always meant and
--   what `user_media`'s primary key used to guarantee for free.
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


-- ---------------------------------------------------------------------------
-- 5. The diff, callable, so the flip is decided from data rather than from hope
--
-- §M.5's "diffed per account first". `scripts/ops/watch-history-diff.mjs` calls this and
-- prints it; having the arithmetic in the database means staging and production are
-- asked the identical question, and that the operator cannot accidentally diff against a
-- stale client-side copy of either rule.
--
-- It is a READ. It changes nothing, it can be run at any time, and it is the gate for
-- flipping either flag.
-- ---------------------------------------------------------------------------

create or replace function watch_history_repoint_diff()
returns table (
  user_id        uuid,
  metric         text,
  period         text,
  before_count   integer,
  after_count    integer,
  delta          integer
)
language sql stable security definer
set search_path = public
as $$
  with years as (
    select distinct wg.user_id, wg.year, wg.category
      from watch_goals wg
  ),
  goal_before as (
    select y.user_id, y.year, y.category,
           (select count(*)::integer
              from user_media um join media_items m on m.id = um.media_item_id
             where um.user_id = y.user_id
               and um.watched_on is not null
               and extract(year from um.watched_on) = y.year
               and rankable_category(m.kind) = y.category) as n
      from years y
  ),
  goal_after as (
    select y.user_id, y.year, y.category,
           (select count(distinct we.media_item_id)::integer
              from watch_events we join media_items m on m.id = we.media_item_id
             where we.user_id = y.user_id
               and we.watched_on is not null
               and extract(year from we.watched_on) = y.year
               and rankable_category(m.kind) = y.category) as n
      from years y
  ),
  goals as (
    select b.user_id,
           'goal:' || b.category::text as metric,
           b.year::text as period,
           b.n as before_count,
           a.n as after_count,
           a.n - b.n as delta
      from goal_before b
      join goal_after a
        on a.user_id = b.user_id and a.year = b.year and a.category = b.category
  ),
  bounds as (
    select _leaderboard_month_start() as from_day,
           (_leaderboard_month_start() + interval '1 month')::date as to_day
  ),
  board_before as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join media_items m on m.id = um.media_item_id
      cross join bounds b
     where um.source <> 'imported'
       and coalesce(um.watched_on, (um.created_at at time zone 'UTC')::date) >= b.from_day
       and coalesce(um.watched_on, (um.created_at at time zone 'UTC')::date) <  b.to_day
       and m.kind in ('movie', 'season')
     group by um.user_id
  ),
  board_after as (
    select we.user_id, count(distinct we.media_item_id)::integer as n
      from watch_events we
      join media_items m on m.id = we.media_item_id
      cross join bounds b
     where we.basis in ('today_default', 'reader', 'unattributed')
       and we.watched_on >= b.from_day
       and we.watched_on <  b.to_day
       and m.kind in ('movie', 'season')
     group by we.user_id
  ),
  board as (
    select coalesce(bb.user_id, ba.user_id) as user_id,
           'board:titles' as metric,
           to_char((select from_day from bounds), 'YYYY-MM') as period,
           coalesce(bb.n, 0) as before_count,
           coalesce(ba.n, 0) as after_count,
           coalesce(ba.n, 0) - coalesce(bb.n, 0) as delta
      from board_before bb
      full join board_after ba on ba.user_id = bb.user_id
  )
  select * from goals where delta <> 0
   union all
  select * from board where delta <> 0
   order by 1, 2, 3;
$$;

comment on function watch_history_repoint_diff() is
  'Every account whose yearly goal or monthly board standing CHANGES when T4''s flags '
  'are flipped, and by how much. Rows with no change are omitted, so an empty result '
  'means the repoint is invisible. §M.5 expects goals to RISE (a title with an earlier '
  'native date plus a rewatch this year now counts in both years) and the monthly board '
  'to FALL (undated in-app rows credited by created_at, and ranked imports credited the '
  'same way). A delta in the other direction is the signal to stop and read it.';

revoke execute on function watch_history_repoint_diff() from public, anon, authenticated;
