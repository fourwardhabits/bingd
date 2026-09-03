-- ---------------------------------------------------------------------------
-- A series you have finished leaves the watchlist.
--
-- Founder decision, 2026-09-03. The watchlist invariant of 20260815040000 is
-- deliberately exact-object: watching season 2 never touches the series entry,
-- because "I want to watch this show" stays true after one season. What that
-- shape could not express is the end of the show. A user who ranks every
-- released season has no season left to intend, and the series entry sits on
-- their watchlist forever, pointing at nothing they can still do.
--
-- The refined rule, stated once:
--
--   A series stays on the watchlist while a currently released normal season
--   remains unmet. Once every currently released normal season is met, the
--   series leaves.
--
-- Where:
--
--   * a NORMAL season is `season_number > 0`. Season 0 / Specials never blocks
--     removal and never causes it.
--   * CURRENTLY RELEASED is `release_date is not null and release_date <=
--     current_date`. An announced season with no air date, or a future one,
--     does not block removal (founder decision 4): the user has finished
--     everything there is to watch today, and when the new season airs,
--     re-adding the series is the deliberate act it always was.
--   * MET is exactly the watch signal 20260815040000 already recognises: a
--     `rankings` row, or a `user_media` row with a bucket, a watch date, or
--     `progress = 'completed'`. No new definition of watched is introduced.
--
-- What deliberately does NOT change:
--
--   * `_leave_watchlist()` is untouched. A season's own watchlist entry is
--     still governed by the exact-object rule; this file adds a peer, not a
--     replacement.
--   * The rule stays one-directional. Unranking or unlogging a season does not
--     re-add the series, for the same reason unlog does not re-add anything:
--     silently resurrecting a row the user can also manage by hand is harder
--     to reason about than a row that stays gone.
--   * There is no trigger on `watchlist` inserts. A user who has watched every
--     season and re-adds the series anyway is starting a rewatch, and that
--     later, explicit intention must not be overruled by older watch signals.
--     The rule reacts only to a season BECOMING met. (Corollary, accepted: if
--     they then log a season again, that new watch signal is a transition, the
--     state is re-read, and the series leaves again. A finished show does not
--     hold a watchlist row through further activity on it.)
--
-- **The vacuous-truth guard.** The catalogue is a cache: `media_items` holds
-- only the seasons that have been hydrated. "No released normal season remains
-- unmet" is vacuously true of a series with no released normal season rows at
-- all, and deleting on that reading would remove every unhydrated series from
-- every watchlist. So removal additionally requires that at least one released
-- normal season EXISTS (and is therefore met). A series whose catalogue entry
-- knows no released normal seasons is kept, always. Within that boundary the
-- rule trusts the catalogue, which is the founder's decision 4 generalised: a
-- metadata gap (a season TMDB has not dated, per the JJK finding) does not
-- block removal, and the season-hydration walker is what keeps the boundary
-- narrow.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The trigger function
--
-- `security definer`, for the reason `_leave_watchlist` records: `watchlist`
-- has no delete policy at all, so an invoker-rights trigger would match zero
-- rows and the invariant would stop holding silently. The only rows it can
-- reach are keyed by `new.user_id`, which the caller was already authorised to
-- write.
--
-- The relation names are schema-qualified and `pg_temp` is pinned last, same
-- as `_leave_watchlist` and for the same verified reason (CVE-2018-1058 is the
-- general form).
--
-- **The advisory lock is the load-bearing line.** Two devices completing the
-- final two released seasons at the same time each run this check under READ
-- COMMITTED, and neither transaction sees the other's uncommitted row, so each
-- finds the other's season unmet and neither removes the series. That is the
-- lost-crossing shape 20260829000200 documents for goal completion, and the
-- fix is the same: a transaction-scoped advisory lock per (user, series),
-- taken BEFORE counting. The second transaction waits for the first to commit,
-- its next statement takes a fresh snapshot, and it correctly sees every met
-- season. The removal converges no matter which transaction gets there first,
-- and never depends on trigger execution order.
--
-- Lock ordering: this key ('series-watchlist:' prefixed, so it shares a key
-- space with nothing) is acquired from AFTER-ROW triggers, i.e. after the
-- operation ledger claim, the media lock and the category lock of
-- 20260825000200's hierarchy, and nothing that holds it ever acquires another
-- lock afterwards: the only statement past it is the watchlist delete, whose
-- own deferred award trigger (20260904000100) takes `_award_lock` at commit,
-- and no holder of `_award_lock` ever asks for this key. So it is strictly
-- innermost and cannot close a cycle.
-- ---------------------------------------------------------------------------

create or replace function _leave_series_watchlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_series   uuid;
  v_released integer;
  v_unmet    integer;
begin
  -- Only a season can finish a series. Movies have no parent and a series
  -- itself can never carry a watch signal (_assert_loggable refuses it), so
  -- everything else returns on one indexed read.
  select mi.parent_id into v_series
    from public.media_items mi
   where mi.id = new.media_item_id
     and mi.kind = 'season';

  if v_series is null then
    return null;
  end if;

  -- The cheap exit, and the common one: the parent is not on this user's
  -- watchlist, so there is nothing to remove and no lock worth taking. A
  -- concurrent set_watchlist(true) this snapshot cannot see is the rewatch
  -- re-add case, which the rule deliberately leaves alone.
  if not exists (
    select 1 from public.watchlist w
     where w.user_id = new.user_id
       and w.media_item_id = v_series
  ) then
    return null;
  end if;

  -- Serialise against the sibling season completing on another device. Taken
  -- before counting, so the count below is over committed truth.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'series-watchlist:' || new.user_id::text || ':' || v_series::text, 0
    )
  );

  -- One pass over the released normal seasons: how many exist, and how many
  -- are still unmet under 20260815040000's own definition of a watch signal.
  select count(*),
         count(*) filter (
           where not exists (
                   select 1 from public.rankings r
                    where r.user_id = new.user_id
                      and r.media_item_id = s.id
                 )
             and not exists (
                   select 1 from public.user_media um
                    where um.user_id = new.user_id
                      and um.media_item_id = s.id
                      and (
                        um.bucket is not null
                        or um.watched_on is not null
                        or um.progress = 'completed'
                      )
                 )
         )
    into v_released, v_unmet
    from public.media_items s
   where s.parent_id = v_series
     and s.kind = 'season'
     and s.season_number > 0
     and s.release_date is not null
     and s.release_date <= current_date;

  -- Kept while anything released is unmet, and kept on vacuous truth: a series
  -- whose catalogue entry knows no released normal season has not been
  -- finished, it has not been hydrated.
  if v_released = 0 or v_unmet > 0 then
    return null;
  end if;

  delete from public.watchlist
   where user_id = new.user_id
     and media_item_id = v_series;

  -- An AFTER ... FOR EACH ROW trigger's return value is ignored.
  return null;
end;
$$;

comment on function _leave_series_watchlist() is
  'Removes the PARENT SERIES from the watchlist once every currently released normal '
  'season (season_number > 0, release_date <= current_date) is watched or ranked by '
  'this user. Season 0 and undated or future seasons never block; a series with no '
  'released normal season rows in the catalogue is never removed. Peer of '
  '_leave_watchlist (20260815040000), which still governs the season''s own entry. '
  'Takes an advisory lock per (user, series) so two seasons completing concurrently '
  'converge on the removal. One-directional: unranking or unlogging re-adds nothing.';

revoke execute on function _leave_series_watchlist() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The triggers
--
-- Attached to the same transitions that drive the exact-object invariant, with
-- the same WHEN clauses, so the two rules cannot drift apart about what counts
-- as a watch signal, and every entry point (log_watched, set_bucket,
-- set_season_progress, rank_start's upsert, _rank_finalize's insert, and the
-- import to come) reaches the series rule by construction rather than by list.
--
-- The insert/update split is 20260815040000's, kept for the same reason: an
-- update fires only on a genuine transition (`is distinct from`), so editing a
-- note or re-selecting a stored bucket re-evaluates nothing. For this rule the
-- evaluation is a state check and re-running it is harmless, but a trigger
-- that fires on non-transitions is a trigger whose WHEN clause has stopped
-- meaning anything.
-- ---------------------------------------------------------------------------

drop trigger if exists user_media_insert_leaves_series_watchlist on user_media;
drop trigger if exists user_media_update_leaves_series_watchlist on user_media;
drop trigger if exists rankings_leaves_series_watchlist on rankings;

-- A new row that already carries a watch signal.
create trigger user_media_insert_leaves_series_watchlist
  after insert on user_media
  for each row
  when (
    new.bucket is not null
    or new.watched_on is not null
    or new.progress = 'completed'
  )
  execute function _leave_series_watchlist();

-- An existing row becoming watched.
create trigger user_media_update_leaves_series_watchlist
  after update of bucket, watched_on, progress on user_media
  for each row
  when (
    (new.bucket is distinct from old.bucket and new.bucket is not null)
    or (new.watched_on is distinct from old.watched_on and new.watched_on is not null)
    or (new.progress is distinct from old.progress and new.progress = 'completed')
  )
  execute function _leave_series_watchlist();

-- Ranking, as its own trigger, for 20260815040000's stated reason: it makes
-- the rule a property of the rankings table, true of any future writer, rather
-- than a consequence of rank_start having upserted a bucket first.
create trigger rankings_leaves_series_watchlist
  after insert on rankings
  for each row
  execute function _leave_series_watchlist();

-- ---------------------------------------------------------------------------
-- 3. Backfill
--
-- Every series entry already stranded by the old shape: on the watchlist, with
-- at least one released normal season in the catalogue and none of them
-- unmet. Founder decision 8 approves exactly this correction.
--
-- The candidate set is derived first and the delete joins against it, so what
-- was removed is reviewable from the SQL alone. The count is reported the way
-- 20260815040000's backfill reports its own. One-directional, idempotent (a
-- second run finds nothing left to match), and scoped per user: one account
-- finishing a show says nothing about another account's entry for it.
--
-- Kept, deliberately:
--   * a series whose released seasons are not all met,
--   * a series with only undated or future seasons outstanding and none
--     released and met (vacuous truth, no removal),
--   * a series where only Season 0 remains: specials are outside the rule,
--   * every movie row, untouched by construction (the join requires seasons).
-- ---------------------------------------------------------------------------

do $$
declare
  v_removed integer;
begin
  with judged as (
    select w.user_id,
           w.media_item_id as series_id,
           count(s.id) as released_seasons,
           count(s.id) filter (
             where not exists (
                     select 1 from rankings r
                      where r.user_id = w.user_id
                        and r.media_item_id = s.id
                   )
               and not exists (
                     select 1 from user_media um
                      where um.user_id = w.user_id
                        and um.media_item_id = s.id
                        and (
                          um.bucket is not null
                          or um.watched_on is not null
                          or um.progress = 'completed'
                        )
                   )
           ) as unmet_seasons
      from watchlist w
      join media_items series
        on series.id = w.media_item_id
       and series.kind = 'series'
      join media_items s
        on s.parent_id = series.id
       and s.kind = 'season'
       and s.season_number > 0
       and s.release_date is not null
       and s.release_date <= current_date
     group by w.user_id, w.media_item_id
  )
  delete from watchlist w
   using judged j
   where w.user_id = j.user_id
     and w.media_item_id = j.series_id
     and j.released_seasons > 0
     and j.unmet_seasons = 0;

  get diagnostics v_removed = row_count;
  raise notice 'series watchlist backfill: removed % row(s)', v_removed;
end;
$$;
