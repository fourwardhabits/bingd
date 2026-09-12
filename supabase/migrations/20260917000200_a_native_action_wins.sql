-- A native action wins.
--
-- `user_media.source` finally means something, and this migration is what makes the
-- meaning hold: **it is the provenance of the row's current watched state**, not of the
-- row. An import creates it; doing the thing here takes it over; and nothing else may move
-- it in either direction.
--
-- Specification: founder decision, 2026-09-11. Depends on 20260917000100.
--
-- ===========================================================================
-- WHY THE OBVIOUS TRIGGER IS WRONG, TWICE
--
-- The first shape anybody writes is "any update to a `user_media` row sets `source` to
-- `in_app`". The founder ruled that out and was right: a note edit, a review publication,
-- a `clear_watch_date`, or any future maintenance sweep would silently convert an imported
-- history into native watches, and every one of those would then count on a leaderboard
-- that is supposed to record what somebody did *here*.
--
-- The second shape — a BEFORE UPDATE trigger scoped to the watch-signal columns — is
-- closer and still insufficient, and the reason is specific. **Ranking a title frequently
-- produces no `user_media` UPDATE at all.** `_rank_finalize`'s upsert carries
--
--     on conflict (user_id, media_item_id) do update
--        set bucket = excluded.bucket
--      where user_media.bucket is distinct from excluded.bucket
--
-- so ranking an imported film *inside the band its imported rating already put it in* is a
-- no-op against that row. Ranking is the strongest native action there is, the founder
-- names it explicitly, and a trigger on `user_media` alone never sees it.
--
-- Hence two triggers and one ratchet, below. Together they say: provenance moves to
-- `in_app` when somebody records a watch signal here or ranks the title here, and never
-- moves back.
--
-- ===========================================================================
-- WHAT COUNTS AS DOING IT HERE
--
-- Audited against every writer of `user_media` in the migration tree rather than against
-- a list somebody remembered:
--
--   FLIPS                                     because
--   log_watched            watched_on set     a date recorded here
--   set_bucket             bucket set/changed an opinion expressed here
--   set_season_progress    progress completed a season finished here
--   _rank_finalize         rankings insert    ranked here (the second trigger)
--   recommendation accept  bucket set         same as set_bucket; it is a log
--
--   DOES NOT FLIP                             because
--   save_note / review     note only          writing about a film is not watching it
--   clear_watch_date       watched_on -> null removing a date is not recording one
--   stamp_review_published note_first_...     a trigger stamping a publication time
--   touch_updated_at       updated_at         maintenance
--   touch_note_version     note_updated_at    maintenance
--   ANY watchlist activity                    `watchlist` is a different table, and
--                                             nothing in it writes `user_media` -- the
--                                             dependency runs the other way, through
--                                             `_leave_watchlist`
--   anything under an import                  `_importing()`
--
-- The single `source` column is therefore sufficient and no schema correction is needed:
-- the false positives the founder was protecting against are all mutations of columns this
-- does not test, and the one true positive it could have missed is covered by the second
-- trigger.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The ratchet, and the flip
--
-- One BEFORE UPDATE, deliberately **not** column-scoped, because it has two jobs and the
-- second one is about `source` itself. It runs on every update of the table and does no
-- queries at all -- two field comparisons and an assignment -- so the cost is nil.
--
-- **The ratchet is the structural half.** `in_app` never becomes `imported`, whatever the
-- caller asks for. So "a re-import must not overwrite native state" stops being a rule the
-- apply path has to remember and becomes a thing the database will not do: even a buggy
-- apply, or a future one written by somebody who never read this file, cannot take a row
-- back. Native-wins is enforced at the row rather than at the writer.
-- ---------------------------------------------------------------------------

create or replace function _source_follows_the_watch()
returns trigger
language plpgsql
-- SECURITY DEFINER for the same reason its sibling below is: it calls `_importing()`,
-- whose EXECUTE is revoked from `authenticated`. Safe today without it only because
-- `user_media` carries a SELECT policy and nothing else, so every writer is already a
-- definer function — but the day anybody adds an UPDATE policy or a SECURITY INVOKER
-- writer, every update to this table would throw `permission denied for function
-- _importing`. A trigger that depends on nobody ever widening a policy is not a trigger.
security definer
set search_path = public
as $$
begin
  -- The ratchet. Applies during an import too: an import may not reclaim a row that a
  -- native action has already taken, which is exactly what a second import of the same
  -- archive would otherwise do.
  if old.source = 'in_app' then
    new.source := 'in_app';
    return new;
  end if;

  -- Inside an import, nothing else here applies: the import is allowed to write watch
  -- signals onto its own rows without that counting as having done it here.
  if _importing() then
    return new;
  end if;

  -- A watch signal recorded in the app. `is distinct from` rather than `<>` so a
  -- transition out of null counts, and the `not null` test so that *removing* a signal --
  -- `clear_watch_date` -- is not mistaken for recording one.
  if (new.watched_on is not null and new.watched_on is distinct from old.watched_on)
     or (new.bucket is not null and new.bucket is distinct from old.bucket)
     or (new.progress = 'completed' and new.progress is distinct from old.progress)
  then
    new.source := 'in_app';
  end if;

  return new;
end;
$$;

comment on function _source_follows_the_watch() is
  'Keeps user_media.source meaning "what produced the current watched state". Moves imported to in_app when a watch date, a bucket or a completed season is recorded outside an import, and refuses to move in_app back to imported ever -- so a re-import cannot reclaim a row a native action has taken, however the apply path is written. Deliberately silent about notes, reviews, cleared dates and every maintenance column: writing about a film is not watching it here.';

create trigger user_media_source_follows_the_watch
  before update on user_media
  for each row execute function _source_follows_the_watch();


-- ---------------------------------------------------------------------------
-- 2. Ranking is the signal the first trigger cannot see
--
-- AFTER INSERT on `rankings`, because `_rank_finalize` is the only writer of that table
-- and inserting a row into it is unambiguously "this person ranked this title in bingd".
--
-- The update below re-enters the trigger above, which is harmless and worth stating: that
-- call changes only `source`, so its own watch-signal test is false and it returns
-- unchanged. It does not fire `user_media_update_leaves_watchlist` or `award_on_note`
-- either -- both are scoped to columns this does not touch.
-- ---------------------------------------------------------------------------

create or replace function _ranking_is_a_native_action()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if _importing() then return null; end if;

  update user_media
     set source = 'in_app'
   where user_id = new.user_id
     and media_item_id = new.media_item_id
     and source = 'imported';

  return null;
end;
$$;

comment on function _ranking_is_a_native_action() is
  'Takes provenance for a title the moment it is ranked here. Exists because _rank_finalize''s user_media upsert is guarded by "where bucket is distinct from excluded.bucket", so ranking an imported film inside the band its imported rating already chose updates no collection row at all -- and a trigger on user_media alone would never see the strongest native action there is. Predicated on source = imported so an ordinary ranking writes nothing.';

revoke execute on function _ranking_is_a_native_action() from public, anon, authenticated;

create trigger rankings_take_provenance
  after insert on rankings
  for each row execute function _ranking_is_a_native_action();
