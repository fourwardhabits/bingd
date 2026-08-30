-- ---------------------------------------------------------------------------
-- A month every watch belongs to, and the seasons a series is still short of
--
-- 2026-08-30. Two corrections found during physical acceptance: one in SQL, and one
-- view the scoped season backfill drains.
--
-- 1. THE MONTHLY BOARD COUNTED A DATE HALF THE BETA HAS NOT GIVEN
--
-- The founder's report: `@silky` is followed, public, and shows two ranked films this
-- month; accounts with counts of one and two are on the Titles board; `@silky` is not.
-- Reproduced against nonprod before anything was written, and privacy was not the
-- cause -- the account is public and `leaderboard()` returns it for the all-time
-- timeframe with a count of 2.
--
-- The cause is `watched_month`, which requires `user_media.watched_on`. That column is
-- **optional by design**: `set_bucket` creates the collection row without one, the Log
-- sheet stamps a date in a second call the reader may never make, and `20260824000100`
-- made "I watched this and I do not remember when" a first-class state. On nonprod
-- today five of the twelve accounts have no dated row at all, so five people could not
-- appear on the monthly board no matter what they did. That is not a stricter metric;
-- it is a board that excludes a class of user for using an affordance the product
-- offers them.
--
-- **The month a watch belongs to is the watch date, or failing that the day the title
-- entered the collection.** `coalesce(watched_on, created_at::date)`, UTC on both
-- halves so the fallback cannot disagree with the boundary.
--
-- Why this and not the alternatives:
--
--   * *Stamping a date at write time* would put a claim in the column that the reader
--     declined to make, and it repairs nothing already written.
--   * *Counting an undated row in every month* would let one row score twelve times.
--   * *Leaving it* keeps the board honest about `watched_on` and dishonest about who is
--     competing, which is the trade the founder rejected.
--
-- `created_at` is `not null default now()` and no writer moves it -- `log_watched` and
-- `set_bucket` both `on conflict do update` a column list that excludes it -- so the
-- fallback is stable: a film logged in March and dated later stays in March until it is
-- dated, and then moves to the month it was actually watched. It is a fallback and
-- never an override, so every dated row counts exactly where it counted before.
--
-- **What this does not promise, stated because review 77 asked for it.** A row is
-- attributed to *one* month at a time and counts once on any board -- `user_media` is
-- keyed (user, title), so there is nothing to double -- but that month can **move**,
-- because the watch date is editable and correcting a date is the point of having one.
-- A title logged undated in March and dated to April in April scores on March's board
-- and then on April's.
--
-- That is not new and is not what the coalesce introduced: `log_watched` has always
-- upserted `watched_on`, so a March-dated row re-dated to April did exactly this before
-- today. Pinning a row to the first month it ever scored in would need a ledger of
-- "already counted in", which is a real mechanism with a real cost, and it is not worth
-- it against a monthly board in a friend beta: the boards it spans are consecutive, the
-- earlier one is no longer readable by anybody, and the alternative is a product that
-- refuses to believe a reader who corrects a date. Recorded here rather than left for
-- somebody to discover, and on the deferred roadmap if the cohort ever makes it matter.
--
-- All-time is untouched: it has no date test, because there is no month to get wrong.
-- Reviews are untouched: `note_first_published_at` is stamped by the writer whenever a
-- review becomes public, so that metric has no gap to fill.
--
-- 2. THE SERIES WHOSE SEASON LIST WAS WRITTEN ONCE
--
-- `season_hydration_due` below is the scoped backfill's drain. See its own comment.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The board's population, with the month restated
--
-- Restated whole because `create or replace` of a `language sql` body cannot be
-- partial. The diff against `20260902000100` is the two date comparisons in
-- `watched_month` and nothing else: the four metrics, the eligibility union, the
-- review semantics and the all-time rules are that function verbatim.
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
  -- `can_discover_profile` refuses a block in either direction, a non-active account
  -- and the caller themselves; the caller is admitted by the first branch.
  eligible as (
    select p.id
      from profiles p
     where auth.uid() is not null
       and (can_view_profile(auth.uid(), p.id) or can_discover_profile(auth.uid(), p.id))
  ),
  watched_month as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
      cross join bounds b
     where p_timeframe = 'month'
       and p_metric in ('titles', 'movies', 'tv')
       -- **The month this watch belongs to** (20260903000100). The watch date where the
       -- reader gave one, and otherwise the day the row entered their collection --
       -- a fact about them, recorded by the writer, that no later edit moves.
       --
       -- A `date` and a `timestamptz` are being reconciled, so the conversion names UTC
       -- for the reason `_leaderboard_month_start` does: `::date` on a `timestamptz`
       -- reads the session's TimeZone, which PostgREST does not pin, and a fallback that
       -- drifted with the connection would put one row in different months for two
       -- readers of the same board.
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
  select * from watched_month
   union all
  select * from watched_all
   union all
  select * from reviews_month
   union all
  select * from reviews_all;
$$;

comment on function _leaderboard_counts(text, text) is
  'One person, one number, for one metric and one timeframe, over exactly the accounts the caller may read OR may find -- can_view_profile or can_discover_profile, which since 20260902000100 admits an unapproved private account while still refusing a block in either direction, a suspended account and a deleted one. Since 20260903000100 the monthly watched metrics attribute a row to coalesce(watched_on, created_at at UTC): the watch date where the reader gave one, and otherwise the day the title entered their collection, so an undated watch competes in the month it was logged rather than in no month at all. All-time watched has no date test. Monthly reviews reads note_first_published_at, an event an edit cannot move; all-time reviews counts titles currently carrying a public note. Never returns which titles. Internal: leaderboard and my_leaderboard_standing are the callers, and both validate their arguments first.';


-- ---------------------------------------------------------------------------
-- 2. The series a season backfill is owed
--
-- Physical acceptance found `JUJUTSU KAISEN` showing Specials and Season 1 only. That
-- particular gap is **the provider's**: TMDB models the show as one 59-episode Season 1
-- under `/tv/95479` and publishes no Season 2 there, so no ingestion change can produce
-- one. Tracing it did find two real defects underneath, and this view exists for the
-- second.
--
--   * A series' season list is written once, by the detail enrichment that first
--     reaches it, and nothing ever asks again: the client enriched a series only when
--     it had **no** seasons at all, and `media_refresh_due` is drained by no schedule.
--     A show that gains a season after somebody first opened it stays short for good.
--     Fixed on the client, which now re-asks a series whose season list has gone stale
--     by its own seven-day window.
--
--   * Every season row on nonprod carries a null `episode_count`, because the deployed
--     adapter predates `20260820000400`'s payload. The SQL has been correct since that
--     migration and had nothing to receive, so the metadata line that should read
--     "24 episodes" has been blank on every season in the app.
--
-- Both are repaired by the same act: one series detail call rewrites the whole season
-- list, counts included, through `tmdb_upsert_seasons` -- an upsert that deletes
-- nothing, so rankings, watch state and progress stay attached to their season rows.
--
-- It deliberately does **not** offer a series with no seasons at all -- that is
-- `tmdb_enrich_due`'s job and the season picker's.
--
-- ---------------------------------------------------------------------------
-- IT IS A LIST TO WALK, NOT A QUEUE THAT EMPTIES
--
-- Independent reviews 77 and 77b both landed on the same thing from different sides, and
-- the second one is the general form: **membership of this view cannot be a proof of
-- progress.** Two rows are permanently in it however many times they are hydrated.
--
--   * A season TMDB reports as having zero episodes -- an announced season that has not
--     aired -- is stored as null by `tmdb_upsert_seasons` (`nullif(count, 0)`), so it is
--     a legitimate, permanent null.
--   * A season TMDB has *dropped* from its series detail is not named by any later
--     answer, so `tmdb_upsert_seasons` is silent about it and nothing it carries ever
--     moves. (JUJUTSU KAISEN is exactly this shape: TMDB now publishes one 59-episode
--     Season 1 where there were two seasons.)
--
-- Two earlier attempts failed on this. Defining the view on `episode_count is null`
-- alone re-offers such a series on every pass forever, spending a provider request each
-- time while a `remaining` count never falls. Bounding the population by a stored
-- instant fixed the first row above and not the second, and added a failure mode of its
-- own: a missing config row makes the comparison null, which silently reports an empty
-- backlog while the work is still outstanding.
--
-- So the view does not pretend. It is **the set of series that may be owed a re-read**,
-- and the drain walks it once, in id order, through a cursor the caller carries
-- (`hydrate-seasons`, `api.md`). Termination is a property of the walk -- a finite
-- ordered set, visited once -- rather than of the set shrinking, and re-running the
-- reconciliation is starting the walk again. No `remaining` is reported for this action,
-- because a number that cannot reach zero is worse than no number.
--
-- Ongoing freshness is a different mechanism and deliberately not this one: the client
-- re-reads a series whose season list is past `SEASON_LIST_MAX_AGE_MS`
-- (`features/title/use-enrichment.ts`), bounded per series per window, needing no
-- operator at all.
--
-- security_invoker like every other view here (api.md §10). The backfill runs as
-- service_role; a client selecting from it sees exactly what `media_items` already shows
-- them, which is all of it -- catalogue metadata is not user data.
-- ---------------------------------------------------------------------------

create view season_hydration_due with (security_invoker = true) as
select mi.id,
       mi.kind,
       mi.tmdb_id,
       mi.title,
       mi.fetched_at
  from media_items mi
 where mi.kind = 'series'
   and mi.tmdb_id is not null
   and mi.provenance = 'tmdb'
   and exists (
         select 1 from media_items s
          where s.parent_id = mi.id
            and s.kind = 'season'
            and s.episode_count is null
       );

comment on view season_hydration_due is
  'Series carrying at least one season row with no episode_count -- the set that may be owed a re-read, for the scoped season backfill (20260903000100). One detail call per series rewrites the whole season list through tmdb_upsert_seasons, which upserts and never deletes, so counts arrive and every ranking, watch state and progress stays attached. Membership is deliberately NOT a proof of progress: a season TMDB reports as having zero episodes, and one TMDB has dropped from its answer, both stay null forever. The drain therefore WALKS this list once in id order behind a cursor rather than waiting for it to empty, and reports no remaining count. Read by the tmdb-adapter hydrate-seasons action, which runs as service_role.';
