-- The combined Watch History + Lists hardening pass, 2026-09-20.
--
-- Forward-only, and deliberately separate from the five feature files it corrects:
-- `20261003000100`–`20261006000100` (Watch History T1–T4) and `20261010000100` (Lists v1)
-- were reviewed as they stand and are applied as one tranche with this file at the end,
-- so nothing here edits a reviewed body that a reviewer has already read.
--
-- Two findings, both from the post-foundation scalability pass over the combined
-- candidate, and both about what happens when something is used rather than about what
-- it means.
--
-- ===========================================================================
-- 1. TWO TAPS IN THE ADD-TITLES SHEET COULD COLLIDE ON ONE POSITION
--
-- `_add_list_item_unchecked` appends with `max(position) + 1`, read outside any lock.
-- `move_list_item` takes `pg_advisory_xact_lock(hashtextextended(list_id, 0))` before it
-- computes an order, and its own race file says why; the insert path never did.
--
-- The reachable case is not exotic, which is what makes this a fix rather than a note:
-- **`AddTitlesSheet` deliberately stays open and does not await its predecessor** — "the
-- row's tick lands on the tap rather than a round trip later — the sheet stays open and
-- the next tap is immediate". Two taps inside one round trip are two overlapping
-- transactions on one list. Both read the same `max`, both insert that position, and
-- because `list_items_position_unique` is `deferrable initially deferred` the collision
-- is not caught at the statement — it is caught at COMMIT, as a `23505` on the second
-- tap, for a list that is in no way full and a title that is in no way a duplicate.
--
-- The same lock also makes the double-add of the SAME title answer `already` instead of
-- raising on the primary key: the second transaction waits, and then its `exists` test
-- runs against a snapshot that contains the first row.
--
-- Rebuilt in full from `20261010000100` (its only definition; `grep "function
-- _add_list_item_unchecked"` finds the create, the revoke and nothing else), with the
-- lock added and no other line changed.
--
-- ===========================================================================
-- 2. FOUR CASCADES HAD NO INDEX TO CASCADE THROUGH
--
-- Postgres does not index the *referencing* side of a foreign key. Every `on delete`
-- action therefore runs a lookup per deleted row, and without an index that lookup is a
-- sequential scan of the referencing table:
--
--   `comparisons.placement_id`           -> `ranking_placements`  (set null)
--   `ranking_placements.watch_event_id`  -> `watch_events`        (set null)
--   `ranking_sessions.watch_event_id`    -> `watch_events`        (set null)
--   `feed_events.list_id`                -> `lists`               (cascade, 20260813000800)
--
-- `comparisons` is the largest table this app writes, and the first two are reached by
-- ordinary product actions: `delete_watch_event` is a row in the Watch History screen,
-- and `unlog` cascades `user_media` -> `watch_events` + `ranking_placements` ->
-- `comparisons`, once per deleted row. The fourth is reached by `delete_list`, which
-- Lists v1 is what makes reachable at all — the constraint has been there since
-- 20260813000800 with no writer above it.
--
-- Partial, because every one of these columns is null for most of its rows and the RI
-- lookup is always for a non-null value.
--
-- Measured before and after on a seeded 1,200-ranked-title account beside 200 background
-- accounts (`supabase/tests/perf/watch-history-lists-scale.mjs`, which reads
-- `pg_stat_xact_user_tables` so a scan inside a `security definer` body is still counted).

-- ---------------------------------------------------------------------------
-- 1. The insert path takes the list's own key
-- ---------------------------------------------------------------------------

create or replace function _add_list_item_unchecked(p_list_id uuid, p_media_item_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind  media_kind;
  v_count integer;
  v_next  integer;
begin
  -- Raises P0002 for a title that does not exist, which is the same answer every
  -- other writer in this schema gives.
  v_kind := _media_kind(p_media_item_id);

  -- Movies, seasons and whole series, and nothing else. A series is not *loggable*
  -- (AD-1) and is perfectly listable: "watch The Bear" is a thing somebody means.
  if v_kind not in ('movie', 'season', 'series') then
    raise exception 'that kind of title cannot go in a list' using errcode = '22023';
  end if;

  -- 20261011000100. Serialises this list against itself, on the **same key**
  -- `move_list_item` takes — one key per list, so an add, a move and a second add queue
  -- behind each other instead of computing positions from a snapshot the other is about
  -- to invalidate. Taken after the catalogue check above, which reads nothing about this
  -- list and needs no lock, and before every read that decides the answer.
  perform pg_advisory_xact_lock(hashtextextended(p_list_id::text, 0));

  if exists (select 1 from list_items
              where list_id = p_list_id and media_item_id = p_media_item_id) then
    return 'already';
  end if;

  select count(*) into v_count from list_items where list_id = p_list_id;
  if v_count >= _list_config('lists.max_items', 500) then
    return 'item_limit';
  end if;

  -- Appended. `position` is a stored integer with gaps; the number a reader sees is
  -- the read-time ordinal, so a removal never leaves a hole on screen (§E).
  select coalesce(max("position"), 0) + 1 into v_next
    from list_items where list_id = p_list_id;

  insert into list_items (list_id, media_item_id, "position")
  values (p_list_id, p_media_item_id, v_next);

  update lists set updated_at = now() where id = p_list_id;

  return 'added';
end;
$$;

comment on function _add_list_item_unchecked(uuid, uuid) is
  'The insert half of add_list_item, with no authorisation of its own -- both callers have already established ownership. Takes the list''s advisory key (the one move_list_item takes) before reading the order, so two taps in the Add titles sheet cannot claim one position and a double add of one title answers already rather than raising on the primary key.';

revoke execute on function _add_list_item_unchecked(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The four referencing columns
-- ---------------------------------------------------------------------------

create index if not exists comparisons_placement
  on comparisons (placement_id) where placement_id is not null;

create index if not exists ranking_placements_watch_event
  on ranking_placements (watch_event_id) where watch_event_id is not null;

create index if not exists ranking_sessions_watch_event
  on ranking_sessions (watch_event_id) where watch_event_id is not null;

create index if not exists feed_events_list
  on feed_events (list_id) where list_id is not null;
