-- ---------------------------------------------------------------------------
-- T1 — the watch-event foundation.
--
-- `watch-history-and-ranking-calibration.md` §D, §M.2 row 1, §M.3.
--
-- ===========================================================================
-- THE ONE SENTENCE
--
-- **Recording time is never watch time.** `user_media.created_at` and `recorded_at`
-- say when somebody told bingd; `watch_events.watched_on` says when they watched. No
-- reader may substitute one for the other, and after this migration no writer can
-- accidentally invite them to, because the two facts finally live in different columns
-- of different tables.
--
-- ===========================================================================
-- WHAT THIS MIGRATION IS NUMBERED, AND WHY IT IS NOT 20261002000100
--
-- The PRD (§RECOMMENDED BUILD SEQUENCE) reserved `20261002000100` for this file, on
-- the day both projects stood at `20261001000100`. `20261002000100` was then taken by
-- the feed-score fix (PR #189, `a feed score that is the current one`), which merged
-- first. **This is the second time this epic has been renumbered because the head moved
-- underneath it**, which is why the PRD's own instruction is to check the applied head
-- on both projects rather than to trust the document. Checked on 2026-09-20: the local
-- head, `origin/main`'s head and every open branch's highest version are all below
-- `20261003000100`, and the three unapplied files on other branches -- `20260911000100`
-- (#118, closed as superseded), `20260911000200` (#119, the push kill switch) and
-- `20260929000200` (watch-next, parked) -- are all older still and cannot collide.
--
-- ===========================================================================
-- THE THREE CONCEPTS, AND THE ONE RULE BETWEEN THEM (§D.0)
--
--   SEEN       the `user_media` row. It already is the thing every reader uses for
--              membership; this migration makes the rule explicit rather than moving it.
--              It needs no new column and gets none.
--   WATCH      a `watch_events` row. **A seen title has >= 1 watch event.** When a title
--              becomes seen with no known timing, its one event has no date -- which is
--              "watched at some point", a true statement rather than a fabricated one.
--   RECORDING  `recorded_at` on each event, `user_media.created_at` for the seen claim.
--
-- `user_media.watched_on` is not deleted and does not change meaning for any installed
-- client: it becomes a maintained **cache of the latest known date**, which for every
-- pre-epic row is the date it already held. Null there means "no known dated viewing",
-- and it has never meant "not watched" -- the row's existence is the watch claim.
--
-- ===========================================================================
-- WHAT AN INSTALLED CLIENT SEES (§M.4)
--
-- Nothing. `log_watched`, `clear_watch_date` and `set_bucket` keep their signatures and
-- their user-visible meaning. What changes is where the date is written: through an
-- event, and the cache follows. An old client's date lands with `basis = 'unattributed'`
-- because the server genuinely cannot know whether that client defaulted it or the
-- reader chose it -- which is the honest answer, and the one §M.7's later cleanup
-- needs in order to find these rows at all.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The basis enum, and why one enum is the whole provenance model
--
-- It answers the only three questions any reader asks:
--
--   Is there a date?            `none`
--   Is it native or imported?   `diary` versus the rest
--   How much did a person actually assert it?   `reader` > `today_default` > `unattributed`
--
-- The third question is the one that separates a date somebody typed from a date a
-- sheet defaulted, and it is the difference that let §C.3.8 -- a new user entering three
-- hundred old films through Search, every one stamped Today -- go undetected for the
-- life of the product. Every in-app date that exists on the day this migration runs is
-- of unknown provenance, and `unattributed` is the word for that.
--
-- Nothing else earned a column. A separate `source` is subsumed by `basis` plus
-- `import_ref`; `declared_rewatch` is replaced by the derived rule in §D.2 (an event is
-- a rewatch if it is not the first in `(watched_on nulls first, recorded_at)`); an
-- undated event is simply `basis = 'none'` rather than a boolean `is_placeholder`; and
-- year-only precision is rejected outright (§D.8) until a past-year recap is designed.
-- ---------------------------------------------------------------------------

create type watch_date_basis as enum (
  'today_default',  -- a current-log flow offered Today and the reader kept it
  'reader',         -- the reader chose or edited this date
  'diary',          -- an authoritative imported date (Letterboxd diary "Watched Date")
  'unattributed',   -- an in-app date whose provenance was never recorded: every pre-epic
                    --   row, and every legacy-RPC write from an installed client
  'none'            -- the viewing is known; its timing is not
);

comment on type watch_date_basis is
  'Where a watch date came from, and how hard somebody asserted it. Derived classes '
  '(§D.1): native-dated = today_default|reader|unattributed, diary-dated = diary, '
  'undated = none. §L.2''s metrics matrix is written in terms of those three classes: '
  'the monthly leaderboard counts native-dated events only, the yearly goal counts '
  'native-dated and diary-dated, and time-independent metrics count all three.';


-- ---------------------------------------------------------------------------
-- 2. The ledger
-- ---------------------------------------------------------------------------

create table watch_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  media_item_id uuid not null,

  -- The local calendar date, never a timestamp. What somebody means by "last night" is
  -- a date in their own timezone; storing an instant would let the server's UTC day
  -- disagree with the day they were looking at. Null is a first-class value and means
  -- the viewing is known and its timing is not.
  watched_on    date,
  basis         watch_date_basis not null,

  -- The Letterboxd **diary entry** short link, which is issued per logged viewing and is
  -- therefore a per-viewing identity. Null for everything native. The `#prior` suffix
  -- marks the one inferred event in the whole design (§D.2's prior-viewing rule), and it
  -- is inferred from the source's own Rewatch flag rather than from anything bingd
  -- guessed.
  import_ref    text,

  -- When bingd was told. **NEVER a watch time**, and the constraint that says so is a
  -- test rather than a comment (§O.2's repository test refuses any expression that
  -- coalesces one into the other).
  recorded_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- The invariant that makes `basis` readable without also reading the date, and the
  -- date readable without also reading the basis. `none` <=> null, both ways.
  constraint watch_events_basis_matches_date
    check ((basis = 'none') = (watched_on is null)),

  -- A static bound, because a CHECK must be immutable. `imported_watches` carries the
  -- identical pair of bounds for the identical reason: the real "not in the future"
  -- rule is the writer's, which can compare against `current_date + 1`; this one only
  -- has to make `9999-12-31` impossible to store.
  constraint watch_events_plausible_date
    check (watched_on between date '1870-01-01' and date '2100-01-01'),

  -- The composite FK to the collection row, `on delete cascade`, which is the
  -- `imported_watches` precedent (20260917000100) and is what makes `unlog` and account
  -- deletion need no code here at all: `profiles -> user_media -> watch_events`.
  constraint watch_events_collection_fk
    foreign key (user_id, media_item_id)
    references user_media (user_id, media_item_id) on delete cascade
);

-- The title's own history, in the order §D.2 defines a rewatch by: undated first, then
-- by date, then by recording. Every read of the Watch History screen is this index.
create index watch_events_title
  on watch_events (user_id, media_item_id, watched_on nulls first, recorded_at);

-- The time-bound consumption readers (§L.2): the yearly goal and the monthly board.
-- Partial, because an undated event can never satisfy a dated query and indexing the
-- nulls would double the index on an account that imported a library without a diary.
create index watch_events_user_dated
  on watch_events (user_id, watched_on) where watched_on is not null;

-- What makes a second import of the same diary free, and what makes the `#prior`
-- inference idempotent. Partial, because native events carry no ref and would otherwise
-- collide with each other on null under a plain unique index -- they would not, since
-- nulls are distinct, but a partial index states the rule instead of relying on that.
create unique index watch_events_import_once
  on watch_events (user_id, import_ref) where import_ref is not null;

alter table watch_events enable row level security;

-- Owner-only `select`, and no write policy at all: every writer below is
-- `security definer`, which is the `imported_watches` construction. Watch dates are
-- private at every profile visibility (PRD §22) -- a public profile publishes a ranking,
-- never a diary.
create policy watch_events_own on watch_events for select
  using (user_id = auth.uid());

comment on table watch_events is
  'One row per viewing the reader has told us about. A seen title has at least one, '
  'possibly undated (§D.0). The rewatch indicator is DERIVED -- an event is a rewatch if '
  'it is not the first in (watched_on nulls first, recorded_at) -- so no column claims '
  'it. Notes and companions stay title-level (§D.3, §D.4); the door to per-watch ones is '
  'an additive watch_event_id on those tables later, with no rework here.';

comment on column watch_events.watched_on is
  'The local calendar date of the viewing, or null when the timing is unknown. Null is '
  'valid data and is never filled from a recording time.';

comment on column watch_events.recorded_at is
  'When bingd was told. An ENGAGEMENT fact (§L.2). Never read as a watch time, and it is '
  'also what orders two events on the same day.';

comment on column watch_events.import_ref is
  'The Letterboxd diary entry URI for a diary event, or that URI with a #prior suffix '
  'for the single inferred event in the design (§D.2''s prior-viewing rule). Null for '
  'everything native. Unique per user, which is what makes a re-import free.';


-- ---------------------------------------------------------------------------
-- 3. The cache, and the marker that keeps it from being mistaken for an act
--
-- ===========================================================================
-- WHY THE CACHE IS RECOMPUTED AND NOT ADVANCED
--
-- `watched_on = max(watch_events.watched_on)` over the title's events, from ANY basis.
-- The obvious implementation is `greatest(old, new)` on insert, and it is wrong the
-- moment anything can go down: editing a date backwards and deleting the newest event
-- both lower the maximum, and a cache that only ever advances would hold a date the
-- reader has deleted -- on the title line, in LogSheet, and in the yearly goal until T4
-- repoints it. So every write recomputes from the events.
--
-- ===========================================================================
-- THE MARKER, AND THE THREE TRIGGERS THAT MUST NOT HEAR IT
--
-- Writing the cache is not an act. Three `user_media` consumers would otherwise treat
-- it as one:
--
--   1. `_source_follows_the_watch` would flip `source` to `in_app` because `watched_on`
--      moved -- including when what moved it was a DIARY event, which is the exact
--      opposite of what provenance means. §4 below moves the flip onto the events, where
--      it can see the basis.
--   2. `user_media_update_leaves_watchlist` would clear a watchlist row because a date
--      appeared -- including a 2019 date the reader has just backdated onto a title they
--      added to the watchlist yesterday to see again. §5 gives that job to the events,
--      where §D.2's chronology rule can be applied.
--   3. `goal_on_user_media_update` counts a newly-qualifying year. That one is left
--      alone on purpose: until T4 repoints goals to events, the cache IS the goal's
--      clock, and suppressing it here would silently stop goals working for a tranche.
--
-- The marker is transaction-local and is set to `txid_current()` so that a value which
-- somehow escapes its transaction is inert -- the `_importing()` construction
-- (20260917000100), reused rather than reinvented. It is cleared immediately after the
-- update rather than left set for the rest of the transaction, so it is effectively
-- statement-scoped: a writer that legitimately changes `bucket` later in the same
-- transaction still gets its ordinary triggers.
-- ---------------------------------------------------------------------------

create or replace function _watch_caching()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('bingd.watch_cache', true), '') = txid_current()::text;
$$;

/**
 * True while `_seen_implies_a_watch` is inserting its backstop event.
 *
 * The signal that an undated event is the invariant being maintained rather than
 * somebody saying they watched something. Only the watchlist rule reads it: the cache is
 * correct either way (an undated event moves no maximum), and provenance already ignores
 * an undated event because it asserts no act.
 */
create or replace function _watch_backstopping()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('bingd.watch_backstop', true), '') = txid_current()::text;
$$;

revoke execute on function _watch_backstopping() from public, anon, authenticated;


comment on function _watch_caching() is
  'True while the watch-date cache trigger is writing user_media.watched_on. The signal '
  'that a watched_on change is bookkeeping rather than an act, for the consumers that '
  'would otherwise read it as one. Same construction as _importing().';

revoke execute on function _watch_caching() from public, anon, authenticated;


create or replace function _watch_cache_recompute(p_users uuid[], p_items uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Nothing to do, and worth the early return: the statement triggers below fire on
  -- every write to the table, and a no-op write is common during the backfill.
  if p_users is null or cardinality(p_users) = 0 then
    return;
  end if;

  perform set_config('bingd.watch_cache', txid_current()::text, true);

  update user_media um
     set watched_on = c.max_on
    from (
      select p.user_id, p.media_item_id,
             (select max(we.watched_on)
                from watch_events we
               where we.user_id = p.user_id
                 and we.media_item_id = p.media_item_id) as max_on
        -- Two parallel arrays rather than one array of pairs. Multi-argument `unnest`
        -- zips them in one pass, and a `uuid[][]` would need slicing syntax that reads
        -- as a typo the first time anybody meets it.
        from unnest(p_users, p_items) as p(user_id, media_item_id)
    ) c
   where um.user_id = c.user_id
     and um.media_item_id = c.media_item_id
     -- **The guard that makes this idempotent and quiet.** Without it every event write
     -- produces a `user_media` UPDATE whose old and new rows are identical, and each one
     -- fires the award, goal, provenance and watchlist statement triggers for nothing.
     -- The backfill alone would fire them a hundred and fifty thousand times.
     and um.watched_on is distinct from c.max_on;

  -- Cleared here rather than left to the end of the transaction, so the marker covers
  -- this statement and not whatever the caller does next.
  perform set_config('bingd.watch_cache', '', true);
end;
$$;

comment on function _watch_cache_recompute(uuid[], uuid[]) is
  'Recomputes user_media.watched_on as max(watch_events.watched_on) for each (user, '
  'media item) pair, under the bingd.watch_cache marker. Recomputed rather than advanced '
  'because an edit or a delete can lower the maximum. Writes nothing when the value is '
  'unchanged, which is what keeps the backfill from firing every user_media trigger.';

revoke execute on function _watch_cache_recompute(uuid[], uuid[]) from public, anon, authenticated;


create or replace function _watch_cache_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_users uuid[];
  v_items uuid[];
begin
  -- Statement-level with transition tables, not per row. The backfill inserts one event
  -- per collection row in a single statement, and a per-row trigger would run one
  -- aggregate per event; this runs one over the distinct pairs.
  select array_agg(t.user_id), array_agg(t.media_item_id)
    into v_users, v_items
    from (select distinct user_id, media_item_id from changed_rows) t;

  perform _watch_cache_recompute(v_users, v_items);
  return null;
end;
$$;

revoke execute on function _watch_cache_after_change() from public, anon, authenticated;

create trigger watch_events_cache_insert
  after insert on watch_events
  referencing new table as changed_rows
  for each statement execute function _watch_cache_after_change();

create trigger watch_events_cache_delete
  after delete on watch_events
  referencing old table as changed_rows
  for each statement execute function _watch_cache_after_change();

-- Two statements for UPDATE, because a transition table can be named once per alias and
-- an update can move a row between titles. In practice `edit_watch_event` (T3) changes
-- only the date, so the second fires over the same pair as the first and the
-- `is distinct from` guard makes the second a no-op.
create trigger watch_events_cache_update_new
  after update on watch_events
  referencing new table as changed_rows
  for each statement execute function _watch_cache_after_change();

create trigger watch_events_cache_update_old
  after update on watch_events
  referencing old table as changed_rows
  for each statement execute function _watch_cache_after_change();


-- ---------------------------------------------------------------------------
-- 4. A seen title has a watch event, guaranteed at commit rather than by review
--
-- ===========================================================================
-- WHY A DEFERRED CONSTRAINT TRIGGER AND NOT SEVEN REBUILT WRITERS
--
-- Seven functions can create a `user_media` row today: `set_bucket`, `log_watched`,
-- `_rank_start_impl`, `_rank_finalize`, `_import_apply_batch`, `set_season_progress`
-- and `log_title` below. Teaching each of them to create an event is seven chances to
-- forget, and an eighth writer added next year would be a silent violation of the
-- invariant with no test that names it.
--
-- A constraint trigger `deferrable initially deferred` fires at COMMIT, which is what
-- makes this a backstop rather than a race: an import or `log_title` that inserts its
-- own events first finds them already there and this does nothing, and a writer that
-- inserted none gets the undated event that says "watched, time unknown". The invariant
-- is therefore structural.
--
-- **Rankable kinds only.** `_assert_loggable` refuses a series, so in practice no series
-- row exists in `user_media` -- but `rankable_category` is asked rather than assumed,
-- because a row that cannot be ranked cannot be watched either and inventing an event
-- for one would put a phantom in `assert_watch_history_valid`'s way for ever.
-- ---------------------------------------------------------------------------

create or replace function _seen_implies_a_watch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The row may be gone by commit: logged and unlogged in one transaction, or removed by
  -- a cascade. Nothing to attach an event to, and the FK would refuse it anyway.
  if not exists (
    select 1 from user_media um
     where um.user_id = new.user_id and um.media_item_id = new.media_item_id
  ) then
    return null;
  end if;

  if (select rankable_category(m.kind) from media_items m where m.id = new.media_item_id)
     is null then
    return null;
  end if;

  if exists (
    select 1 from watch_events we
     where we.user_id = new.user_id and we.media_item_id = new.media_item_id
  ) then
    return null;
  end if;

  -- ===========================================================================
  -- THE BACKSTOP MARKS ITSELF, AND THE WATCHLIST RULE LISTENS
  --
  -- This event is bookkeeping: it exists so the invariant holds, not because anybody
  -- said they watched anything just now. The `watch_events` watchlist triggers in §6
  -- would otherwise read it as a watch signal, and `correction-is-not-a-ranking.test.mjs`
  -- caught exactly what that costs:
  --
  --   the reader puts a film on their watchlist
  --   they write a note on it -- "someone recommended it" -- and nothing else
  --   `log_watched` creates the collection row with no bucket and no date
  --   this trigger gives it an undated event
  --   §D.2's rule reads an undated event as contemporaneous, and the entry is gone
  --
  -- A note is not a watch signal and never has been (20260815040000: the `user_media`
  -- triggers fire on a bucket, a date or a completed season, and a note is none of
  -- those). The marker is what keeps that true, and it is scoped to the insert rather
  -- than to the transaction so a deliberate write later in the same transaction still
  -- gets the ordinary rule.
  --
  -- The DELIBERATE writers -- `log_title`, `log_rewatch`, `set_watch_date`,
  -- `edit_watch_event` -- set no marker, so §D.2's rule applies to them verbatim,
  -- chronology and all.
  -- ===========================================================================
  perform set_config('bingd.watch_backstop', txid_current()::text, true);

  -- ===========================================================================
  -- **THE ROW'S OWN DATE IS CARRIED INTO ITS EVENT, AND IT HAS TO BE**
  --
  -- The obvious backstop creates an undated event unconditionally. That is wrong for any
  -- writer that inserts `user_media` with a `watched_on` already on it, and the failure
  -- is silent and total: the undated event lands, the cache trigger recomputes
  -- `watched_on` as `max(events)` -- which is now null -- and **the date the writer just
  -- wrote is erased**. `leaderboard.test.mjs` and `goal-completion.test.mjs` seed rows
  -- exactly that way and caught it; so does anything a future migration backfills.
  --
  -- No writer in the tree does this after T1 -- `log_watched` writes the event and
  -- `_import_apply_batch` writes its own -- which is precisely why it had to be handled
  -- here rather than in each of them. A backstop that only works for the writers that
  -- did not need it is not a backstop.
  --
  -- The basis is `unattributed`, for the same reason `log_watched`'s is: the server did
  -- not see a reader choose this date and will not claim it did. On an IMPORTED row it
  -- is `diary`, because there the date came from the archive and calling it native would
  -- put an import on the monthly board at T4 and flip the row's provenance to `in_app`.
  --
  -- **The row's own `source` decides that, not `_importing()`.** The marker is set by
  -- the apply path and by nothing else, so a writer that creates an imported row outside
  -- it — a backfill, a repair script, a test fixture — would have its date called
  -- native. `import-pipeline.test.mjs` does exactly that and caught it: a row inserted
  -- with `source = 'imported'` was being flipped to `in_app` by its own backstop event.
  -- `source` is the durable fact; the marker is a property of one code path.
  --
  -- `recorded_at` is the collection row's own creation instant, not `now()`. At commit
  -- those are the same thing for a live write, and they are NOT the same thing for the
  -- backfill -- where the honest recording time of "they told us they had seen this" is
  -- the day the row appeared, years ago, and `now()` would claim the whole library was
  -- disclosed during a migration.
  -- ===========================================================================
  insert into watch_events (user_id, media_item_id, watched_on, basis, recorded_at)
  select um.user_id, um.media_item_id, um.watched_on,
         case
           when um.watched_on is null       then 'none'::watch_date_basis
           when um.source <> 'in_app'       then 'diary'::watch_date_basis
           else 'unattributed'::watch_date_basis
         end,
         um.created_at
    from user_media um
   where um.user_id = new.user_id and um.media_item_id = new.media_item_id;

  perform set_config('bingd.watch_backstop', '', true);

  return null;
end;
$$;

comment on function _seen_implies_a_watch() is
  'The backstop for §D.0''s invariant: a seen title has at least one watch event. '
  'Deferred to commit, so a writer that creates its own events -- log_title, the '
  'importer -- is left alone and one that creates none gets the undated event that says '
  '"watched, time unknown". Covers every row-creating writer without rebuilding any of '
  'them, including writers added later.';

revoke execute on function _seen_implies_a_watch() from public, anon, authenticated;

create constraint trigger user_media_seen_implies_a_watch
  after insert on user_media
  deferrable initially deferred
  for each row execute function _seen_implies_a_watch();


-- ---------------------------------------------------------------------------
-- 5. Provenance follows the WATCH EVENT, because only the event knows the basis
--
-- ===========================================================================
-- THE HOLE THIS CLOSES
--
-- `_source_follows_the_watch` (20260917000200) flips `source` to `in_app` when
-- `watched_on` moves. That was right while `watched_on` was written only by a native
-- act. From this migration it is written by the cache, which follows DIARY events too --
-- so importing a library would flip every row it dated to `in_app`, and `in_app` is a
-- ratchet, so the all-time leaderboard's `source <> 'imported'` exclusion would let the
-- whole import onto the board. That is §C.3.5 with the sign flipped and it would have
-- been the worst regression in this tranche.
--
-- So the `watched_on` clause moves out of that trigger and onto `watch_events`, where
-- the basis is visible and the rule can be stated exactly: **a NATIVE-DATED event
-- recorded outside an import is a native action.** A `diary` event is not. A `none`
-- event is not -- "I have seen this, I don't know when" asserts no act in bingd.
--
-- The `bucket` and `progress` clauses are transcribed unchanged; they are still native
-- signals and still live on `user_media`.
-- ---------------------------------------------------------------------------

create or replace function _source_follows_the_watch()
returns trigger
language plpgsql
-- SECURITY DEFINER for the reason 20260917000200 gave: it calls `_importing()`, whose
-- EXECUTE is revoked from `authenticated`, and it now calls `_watch_caching()` too.
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

  -- 20261003000100. The cache is bookkeeping, not an act, and it now follows diary
  -- dates as readily as native ones. The provenance flip moved to `watch_events`
  -- (`_provenance_follows_the_event` below), where the basis is visible.
  if _watch_caching() then
    return new;
  end if;

  -- A watch signal recorded in the app. `is distinct from` rather than `<>` so a
  -- transition out of null counts, and the `not null` test so that *removing* a signal --
  -- `clear_watch_date` -- is not mistaken for recording one.
  --
  -- 20261003000100: the `watched_on` clause is kept for the one case the cache marker
  -- does not cover -- a direct write by something that is not the cache trigger. There
  -- is no such writer in the tree after this migration, and leaving the clause costs
  -- nothing; removing it would silently widen the window if one ever came back.
  if (new.watched_on is not null and new.watched_on is distinct from old.watched_on)
     or (new.bucket is not null and new.bucket is distinct from old.bucket)
     or (new.progress = 'completed' and new.progress is distinct from old.progress)
  then
    new.source := 'in_app';
  end if;

  return new;
end;
$$;


create or replace function _provenance_follows_the_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Inside an import the import owns the row's provenance; the ratchet in
  -- `_source_follows_the_watch` still refuses to take a row back off `in_app`.
  if _importing() then
    return null;
  end if;

  -- Native-dated, and only native-dated. `diary` is somebody else's record of a viewing
  -- and `none` is an assertion with no act in it.
  update user_media um
     set source = 'in_app'
   where (um.user_id, um.media_item_id) in (
           select n.user_id, n.media_item_id
             from new_rows n
            where n.basis in ('today_default', 'reader', 'unattributed')
         )
     and um.source is distinct from 'in_app';

  return null;
end;
$$;

comment on function _provenance_follows_the_event() is
  'Flips user_media.source to in_app when a NATIVE-DATED watch event is recorded outside '
  'an import (§D.2). Diary and undated events never flip it: one is somebody else''s '
  'record and the other asserts no act here. This is the clause that left '
  '_source_follows_the_watch in 20261003000100, because only the event knows its basis.';

revoke execute on function _provenance_follows_the_event() from public, anon, authenticated;

create trigger watch_events_take_provenance
  after insert on watch_events
  referencing new table as new_rows
  for each statement execute function _provenance_follows_the_event();

-- ===========================================================================
-- AND ON UPDATE, BECAUSE THE LEGACY WRITER DOES NOT INSERT
--
-- `log_watched(date)` on a title that already has a viewing UPDATES that event's date
-- rather than adding one — which is exactly right, and exactly what an installed client
-- means by it. An insert-only trigger never sees it, so an imported film the reader
-- dates from an old build would stay `imported` for ever and the all-time leaderboard
-- would keep excluding a title they have genuinely watched here.
-- `import-pipeline.test.mjs` pins that behaviour and caught this.
--
-- `clear_watch_date` is an update too, and it writes `basis = 'none'` — which is not in
-- the native list, so removing a date still does not count as recording one. That
-- asymmetry is 20260917000200's own rule, preserved through the move.
-- ===========================================================================
create trigger watch_events_take_provenance_on_edit
  after update on watch_events
  referencing new table as new_rows
  for each statement execute function _provenance_follows_the_event();


-- ---------------------------------------------------------------------------
-- 6. The watchlist rule moves to the event, and gains its chronology (§D.2)
--
-- ===========================================================================
-- THE BUG THIS PREVENTS, WHICH DOES NOT EXIST YET AND WOULD HAVE ARRIVED WITH T3
--
-- "A new event clears the title's watchlist row only if
-- `coalesce(watched_on, current_date) >= watchlist.created_at::date`. A backdated entry
-- doesn't consume a fresh 'Watch again' intention." (§D.2)
--
-- Today the rule lives on `user_media`: any transition of `watched_on` out of null, or
-- into a different date, clears the watchlist row. Leave that in place and the cache
-- inherits it -- so a reader who adds a 2019 viewing from Watch History loses the
-- watchlist entry they made yesterday because they want to see it again. The date that
-- arrived is older than the intention it would cancel.
--
-- So the `watched_on` clause leaves the two `user_media` update triggers and the same
-- two functions are attached to `watch_events`, where the event's own date is available
-- to compare. `bucket` and `progress` transitions keep the rule they have had since
-- 20260815040000, unchanged and on the same table.
--
-- **Both functions are rebuilt from their true latest bodies** -- `_leave_watchlist`
-- from 20261001000100 and `_leave_series_watchlist` from 20261001000100 -- with one
-- change each: the chronology guard becomes a `case` over `tg_table_name` covering all
-- three source tables instead of an `or` covering one. Every other line is transcribed.
-- (The SQL rebuild trap, and this epic has already paid for it once.)
-- ---------------------------------------------------------------------------

/**
 * The instant, or day, a watch signal claims, for whichever table fired the trigger.
 *
 * `rankings` carries the instant of the ranking act, and 20261001000100 uses it so that
 * a correction -- which keeps the instant the ranking already had -- does not cancel a
 * watchlist entry added since. `watch_events` carries a DATE, which may be years old,
 * and §D.2 compares it against the watchlist row's own day. `user_media` carries no such
 * instant and keeps the rule as it was: no chronology, because its triggers fire only on
 * a genuine transition and that transition is always contemporaneous.
 */
create or replace function _leave_watchlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- ===========================================================================
  -- WHY THE ROW IS READ AS JSON AND NOT AS FIELDS
  --
  -- One trigger function is now attached to three tables with three different shapes.
  -- **plpgsql resolves `new.<field>` when it PARSES the statement, not when it
  -- evaluates it**, so a `case` whose `rankings` branch names `new.created_at` fails
  -- with `record "new" has no field "created_at"` the first time a `watch_events`
  -- insert reaches it -- the branch is never taken and it fails anyway. Caught by
  -- watch-events.test.mjs on the first run, which is the point of running it.
  --
  -- `to_jsonb(new)` works on any record shape, and an absent key is a null rather than
  -- an error. The branch that is not taken reads a null it never looks at.
  -- ===========================================================================
  v_new jsonb := to_jsonb(new);
  -- Whether this event is the title's FIRST viewing. See the note on the chronology
  -- guard below; only the `watch_events` branch reads it.
  v_first boolean;
begin
  -- ===========================================================================
  -- A BULK WRITE OF HISTORY IS NOT A READER WATCHING SOMETHING
  --
  -- Only for `watch_events`, and only inside an import or the T1 backfill. Replaying
  -- fifteen months of diary entries through this rule would empty every reader's
  -- watchlist, because a historical viewing is older than a watchlist entry only by
  -- accident and the chronology guard below admits the ones that are not. The importer
  -- decides the watchlist for itself -- `_import_apply_batch` writes those rows
  -- explicitly, and "watched beats wanting to watch" is already its rule.
  --
  -- Scoped to `watch_events` rather than applied to the whole function, because the
  -- `user_media` insert path DOES clear the watchlist during an import and has since
  -- 20260815040000. Widening this guard would change that behaviour silently.
  --
  -- **And the backstop event is not a watch signal either** (`_watch_backstopping`).
  -- A note written on a title nobody has watched creates a collection row, which gets
  -- an undated event from `_seen_implies_a_watch` -- and §D.2's rule reads an undated
  -- event as contemporaneous, so without this the note would clear the watchlist entry.
  -- A note has never been a watch signal. The full reasoning is on that function.
  -- ===========================================================================
  if tg_table_name = 'watch_events' and (_importing() or _watch_backstopping()) then
    return null;
  end if;

  -- ===========================================================================
  -- THE CHRONOLOGY GUARD APPLIES TO A LATER VIEWING, NOT TO THE FIRST ONE
  --
  -- §D.2 states the rule as "a new event clears the watchlist row only if
  -- `coalesce(watched_on, current_date) >= watchlist.created_at::date`", and its
  -- rationale is one sentence long: *a backdated entry doesn't consume a fresh "watch
  -- again" intention*. That rationale is about a title the reader has ALREADY watched,
  -- put back on the watchlist to see again, and then back-filled with an old viewing.
  --
  -- Applied to a title's first viewing it says something the rationale does not:
  -- `watchlist-invariant.test.mjs` adds Solaris to the watchlist and immediately logs
  -- it as watched on 1 August, and the bare rule leaves it on the watchlist -- so a
  -- reader who taps *watched it* from the watchlist and picks a past date is told
  -- nothing happened. "Watched beats wanting to watch" has been the invariant since
  -- 20260815040000 and nothing in the epic proposes changing it.
  --
  -- So the guard is applied where its own reasoning applies: **when the title already
  -- had a viewing before this one.** A first viewing clears the entry whatever its date,
  -- which is exactly what `user_media_insert_leaves_watchlist` did before T1 moved the
  -- job here. A second or later viewing is compared on its own day.
  --
  -- **This is a narrowing of §D.2 as written, and it is deliberate.** It is recorded
  -- here rather than applied quietly because it is the one place in T1 where the letter
  -- of the PRD and a pinned invariant disagreed, and the founder may prefer the letter.
  -- Reverting to it is deleting the `v_first` disjunct.
  -- ===========================================================================
  if tg_table_name = 'watch_events' then
    v_first := not exists (
      select 1 from public.watch_events we
       where we.user_id = new.user_id
         and we.media_item_id = new.media_item_id
         and we.id <> new.id
    );
  end if;

  delete from public.watchlist w
   where w.user_id = new.user_id
     and w.media_item_id = new.media_item_id
     and case tg_table_name
           -- 20261001000100, transcribed. An entry the reader put on the watchlist
           -- AFTER this ranking's instant is a newer, deliberate "I want to see this
           -- again" and outlives it.
           when 'rankings'     then w.created_at <= (v_new ->> 'created_at')::timestamptz
           -- 20261003000100, §D.2. An undated event is contemporaneous by construction:
           -- it was recorded now, and `current_date` is the honest stand-in for a
           -- viewing whose timing nobody knows. A dated one is compared on its own day.
           when 'watch_events'
             then v_first
               or coalesce((v_new ->> 'watched_on')::date, current_date) >= w.created_at::date
           -- `user_media`: the rule as it was.
           else true
         end;

  -- An AFTER ... FOR EACH ROW trigger's return value is ignored.
  return null;
end;
$$;

comment on function _leave_watchlist() is
  'Removes the title''s own watchlist entry when a watch signal is recorded. Fired by '
  'rankings (chronology: the ranking''s instant, 20261001000100), by watch_events '
  '(chronology: the event''s date, or today when undated -- §D.2, so a backdated viewing '
  'does not consume a fresh "watch again" intention) and by user_media transitions of '
  'bucket or progress (no chronology, because those are contemporaneous by construction).';


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
  v_in_time  boolean;
  -- See `_leave_watchlist`: three table shapes, one function, and plpgsql resolves
  -- `new.<field>` at parse time.
  v_new      jsonb := to_jsonb(new);
  -- And the same first-viewing narrowing of the chronology guard. Its full reasoning is
  -- on `_leave_watchlist`; a season's first viewing finishes a series as it always did.
  v_first    boolean;
begin
  -- See `_leave_watchlist`: a bulk write of history is not a reader finishing a series,
  -- and the backstop event is not a watch signal.
  if tg_table_name = 'watch_events' and (_importing() or _watch_backstopping()) then
    return null;
  end if;

  if tg_table_name = 'watch_events' then
    v_first := not exists (
      select 1 from public.watch_events we
       where we.user_id = new.user_id
         and we.media_item_id = new.media_item_id
         and we.id <> new.id
    );
  end if;

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
  --
  -- 20261003000100: the same chronology `_leave_watchlist` applies, over all three
  -- source tables. `v_in_time` is computed once and reused by the delete below, so the
  -- test that admits a candidate and the test that removes it cannot drift apart --
  -- which they could when both were spelled out twice.
  select exists (
           select 1 from public.watchlist w
            where w.user_id = new.user_id
              and w.media_item_id = v_series
              and case tg_table_name
                    when 'rankings'     then w.created_at <= (v_new ->> 'created_at')::timestamptz
                    when 'watch_events' then v_first or coalesce((v_new ->> 'watched_on')::date, current_date) >= w.created_at::date
                    else true
                  end
         )
    into v_in_time;

  if not v_in_time then
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

  delete from public.watchlist w
   where w.user_id = new.user_id
     and w.media_item_id = v_series
     and case tg_table_name
           when 'rankings'     then w.created_at <= (v_new ->> 'created_at')::timestamptz
           when 'watch_events' then v_first or coalesce((v_new ->> 'watched_on')::date, current_date) >= w.created_at::date
           else true
         end;

  -- An AFTER ... FOR EACH ROW trigger's return value is ignored.
  return null;
end;
$$;


-- The `watched_on` clause leaves both `user_media` update triggers. Everything else
-- about them -- the column list, the bucket transition, the progress transition -- is
-- transcribed from 20261001000100.
drop trigger if exists user_media_update_leaves_watchlist on user_media;

create trigger user_media_update_leaves_watchlist
  after update of bucket, progress on user_media
  for each row
  when (
    (old.bucket is null and new.bucket is not null)
    or (new.progress is distinct from old.progress and new.progress = 'completed')
  )
  execute function _leave_watchlist();

drop trigger if exists user_media_update_leaves_series_watchlist on user_media;

create trigger user_media_update_leaves_series_watchlist
  after update of bucket, progress on user_media
  for each row
  when (
    (old.bucket is null and new.bucket is not null)
    or (new.progress is distinct from old.progress and new.progress = 'completed')
  )
  execute function _leave_series_watchlist();

-- And the job those clauses did lands here, with its chronology.
--
-- **Not fired during the backfill.** The backfill sets `bingd.import_running`, and these
-- two are per-row triggers with no marker test of their own -- so the guard is the
-- statement order in §9: the backfill inserts its events with the triggers disabled for
-- the duration, exactly as it must, because replaying fifteen months of watch history
-- through a watchlist rule would empty every reader's watchlist. See §9.
create trigger watch_events_leaves_watchlist
  after insert on watch_events
  for each row execute function _leave_watchlist();

create trigger watch_events_leaves_series_watchlist
  after insert on watch_events
  for each row execute function _leave_series_watchlist();


-- ---------------------------------------------------------------------------
-- 7. The legacy writers, rebuilt from their true latest bodies (§D.5)
--
-- Every one of these keeps its exact signature and its user-visible meaning, because
-- installed iOS 1.0.1 builds and the Android beta call them and will keep calling them
-- until their next binary. What changes is that the date goes through an event.
-- ---------------------------------------------------------------------------

/**
 * `log_watched`, rebuilt from 20260825000200.
 *
 * **Old meaning:** `watched_on = coalesce(new, old)` on the collection row -- one date,
 * and a new one overwrites. Plus the note fields, which are untouched here.
 *
 * **New meaning (§D.5):** the date sets the **most recently recorded** event's date. On
 * a title with one event -- which is every title an old client has ever seen -- that is
 * exactly the old overwrite. The basis is `unattributed`, and it has to be: the server
 * cannot know whether that client defaulted the date or the reader chose it, and
 * claiming either would be the fabrication §M.7's cleanup exists to find.
 *
 * **When this call creates the collection row** there are no events yet (the deferred
 * trigger fires at commit), so it creates the event itself. Getting this wrong in the
 * other direction -- letting the deferred trigger create an undated event beside the
 * dated one -- is §O.6's "double-counted watches", and it would have been invisible
 * until somebody opened Watch History on a title logged by an old client.
 *
 * The note half is transcribed unchanged, including NR-1 and the visibility rules.
 */
create or replace function log_watched(
  p_operation_id    uuid,
  p_media_item_id   uuid,
  p_watched_on      date default null,
  p_note            text default null,
  p_note_visibility note_visibility default null,
  p_note_spoilers   boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_version timestamptz;
  v_existed boolean;
  v_target  uuid;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'log_watched') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_loggable(p_media_item_id);
  perform _assert_note_length(v_note);

  -- current_date + 1, not current_date. The server is UTC and the client sends a local
  -- date, so for the first hours of the day everywhere east of UTC the local date is
  -- already tomorrow in server terms. Comparing against today refuses a correct
  -- "I watched this tonight" for a large part of every day, depending on longitude.
  if p_watched_on is not null and p_watched_on > current_date + 1 then
    raise exception 'watch date is in the future' using errcode = '22023';
  end if;

  -- The media lock, for the same reason set_bucket takes it: this is the other writer
  -- that can create the collection row, and it must not interleave with an unlog or a
  -- finalise on the same title.
  perform _lock_media(auth.uid(), p_media_item_id);

  select exists (
    select 1 from user_media
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) into v_existed;

  -- 20261003000100. `watched_on` is no longer written here: it is a cache, maintained
  -- by the event triggers, and a direct write would put it out of step with the events
  -- until the next one landed. The insert below therefore names no date, and the event
  -- written afterwards is what puts one on the row.
  insert into user_media (
    user_id, media_item_id, note, note_visibility, note_has_spoilers
  )
  values (
    auth.uid(),
    p_media_item_id,
    v_note,
    -- NR-1. An insert always creates the note, so there is no stored visibility to
    -- preserve -- and a note whose author has not said otherwise is private.
    case when v_note is null then 'private'::note_visibility
         else coalesce(p_note_visibility, 'private'::note_visibility) end,
    coalesce(p_note_spoilers, false)
  )
  on conflict (user_id, media_item_id) do update
    set note       = coalesce(excluded.note, user_media.note),
        -- Only moves when the caller named a value, or when this call is what brings
        -- the row its first note -- and that case is now private too. An existing note
        -- keeps the visibility it already had, which is what protects a published
        -- Review from an edit that omits the field.
        note_visibility = case
          when p_note_visibility is not null then p_note_visibility
          when v_note is not null and user_media.note_updated_at is null
            then 'private'::note_visibility
          else user_media.note_visibility
        end,
        note_has_spoilers = case
          when p_note_spoilers is not null then p_note_spoilers
          when v_note is not null and user_media.note_updated_at is null then false
          else user_media.note_has_spoilers
        end
  returning note_updated_at into v_version;

  if p_watched_on is not null then
    -- The most recently recorded event, which on a one-event title is the only one.
    select we.id into v_target
      from watch_events we
     where we.user_id = auth.uid() and we.media_item_id = p_media_item_id
     order by we.recorded_at desc, we.id desc
     limit 1
     for update;

    if v_target is null then
      -- This call created the row, so the deferred trigger has not run and there is
      -- nothing to date. Creating the event here is what stops it creating an undated
      -- one beside this date at commit.
      insert into watch_events (user_id, media_item_id, watched_on, basis)
      values (auth.uid(), p_media_item_id, p_watched_on, 'unattributed');
    else
      update watch_events
         set watched_on = p_watched_on,
             basis      = 'unattributed',
             updated_at = now()
       where id = v_target
         -- Idempotence against a retry that got through the ledger, and it also keeps
         -- the cache trigger quiet for a no-op re-send.
         and (watched_on is distinct from p_watched_on or basis is distinct from 'unattributed');
    end if;
  end if;

  return jsonb_build_object('status', 'ok', 'note_version', v_version);
end;
$$;

comment on function log_watched(uuid, uuid, date, text, note_visibility, boolean) is
  'The legacy date-and-note writer, kept for installed clients. Since 20261003000100 the '
  'date sets the most recently recorded watch event''s date with basis unattributed -- on '
  'a one-event title, which is every title an old client has seen, that is exactly the '
  'overwrite it always was. user_media.watched_on is no longer written directly: it is a '
  'cache the event triggers maintain. New clients call log_title and set_watch_date.';


/**
 * `clear_watch_date`, rebuilt from 20260825000200.
 *
 * Clears the most recently recorded event's date, which sets its basis to `none`. The
 * I8 refusal is transcribed and still reads the collection row, because that is the
 * sentence installed clients show and the state it describes has not changed: a row
 * whose only watch signal is a date is un-logged rather than un-dated by this call.
 */
create or replace function clear_watch_date(
  p_operation_id  uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    record;
  v_target uuid;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'clear_watch_date') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _lock_media(auth.uid(), p_media_item_id);

  select * into v_row
    from user_media
   where user_id = auth.uid() and media_item_id = p_media_item_id
   for update;

  -- No row, or a row with no date on it. Both are the state the caller asked for, so
  -- both are success.
  if v_row.media_item_id is null or v_row.watched_on is null then
    return jsonb_build_object('status', 'ok');
  end if;

  -- I8. The date is the only thing on this row saying the title was watched, so
  -- clearing it would un-log the title rather than forget a date. A bucket is a watch
  -- signal in its own right (20260815040000), and so is a completed season.
  if v_row.bucket is null and v_row.progress is distinct from 'completed' then
    raise exception 'the watch date is the only record that this was watched'
      using errcode = '22023';
  end if;

  -- 20261003000100. The most recently recorded DATED event -- not simply the most
  -- recently recorded one. An undated event recorded after a dated one is the
  -- prior-viewing case (§D.2), and clearing it would leave the date on the row and
  -- report success, which is the shape of bug that reads as "the app ignored me".
  select we.id into v_target
    from watch_events we
   where we.user_id = auth.uid()
     and we.media_item_id = p_media_item_id
     and we.watched_on is not null
   order by we.recorded_at desc, we.id desc
   limit 1
   for update;

  if v_target is not null then
    update watch_events
       set watched_on = null, basis = 'none', updated_at = now()
     where id = v_target;
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function clear_watch_date(uuid, uuid) is
  'Forgets the exact date and keeps the watch. Since 20261003000100 it clears the most '
  'recently recorded DATED event, setting its basis to none; the viewing survives, '
  'undated, which is what "I watched this, I do not remember when" has always meant. The '
  'I8 refusal is unchanged.';


-- ---------------------------------------------------------------------------
-- 8. The new writers (§D.5)
--
-- New names, and no defaulted parameters: PostgREST resolves an overload by the argument
-- names in the body, and a defaulted parameter makes two signatures ambiguous from a
-- JSON body that omits it.
-- ---------------------------------------------------------------------------

/**
 * `log_title` — **the normal log**, and one atomic call where LogSheet made two.
 *
 * ===========================================================================
 * THE RACE THIS CLOSES, WHICH THE SHEET ITSELF DOCUMENTED AS RESIDUAL
 *
 * LogSheet taps `set_bucket`, then reads back the settled row, then stamps
 * `log_watched(today)` if the settled row has no date. Its own comment names the gap:
 * "the instant between that answer and the write -- a date recorded on another device in
 * that gap needs a server-side conditional write, which the beta accepts as a residual
 * risk". This is that conditional write. The bucket and the event are one statement pair
 * under one lock, and the condition -- **only when this call creates the seen row** -- is
 * evaluated inside it.
 *
 * On an existing row it sets the bucket and **ignores the date entirely**. That is §D.6
 * path 3 stated in the server rather than in the sheet: ranking a title that is already
 * seen says nothing about when it was watched, and T0b fixed the client half of the same
 * rule. A server that enforces it is a server an old or a future client cannot get
 * wrong.
 */
create or replace function log_title(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_bucket        taste_bucket,
  p_watched_on    date,
  p_basis         watch_date_basis
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim   record;
  v_existed boolean;
  v_event   uuid;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'log_title');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  if p_bucket is null then
    raise exception 'bucket is required' using errcode = '22023';
  end if;

  if p_basis is null or p_basis = 'diary' then
    raise exception 'basis must be today_default, reader or none' using errcode = '22023';
  end if;

  if (p_basis = 'none') <> (p_watched_on is null) then
    raise exception 'basis none means no date, and a date means a basis'
      using errcode = '22023';
  end if;

  if p_watched_on is not null and p_watched_on > current_date + 1 then
    raise exception 'watch date is in the future' using errcode = '22023';
  end if;

  perform _assert_loggable(p_media_item_id);
  perform _lock_media(auth.uid(), p_media_item_id);
  perform _assert_unranked(p_media_item_id);

  select exists (
    select 1 from user_media
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) into v_existed;

  insert into user_media (user_id, media_item_id, bucket)
  values (auth.uid(), p_media_item_id, p_bucket)
  on conflict (user_id, media_item_id) do update
    set bucket = excluded.bucket;

  -- **Only when this call creates the seen row.** The whole point of the function.
  if not v_existed then
    insert into watch_events (user_id, media_item_id, watched_on, basis)
    values (auth.uid(), p_media_item_id, p_watched_on, p_basis)
    returning id into v_event;
  end if;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'created', not v_existed, 'watch_event_id', v_event)
  );
end;
$$;

comment on function log_title(uuid, uuid, taste_bucket, date, watch_date_basis) is
  'The normal log (§D.5). Sets the bucket and, ONLY when this call creates the seen row, '
  'creates that row''s watch event with the given date and basis. On an existing row it '
  'sets the bucket and ignores the date -- §D.6 path 3, enforced in the server: ranking '
  'a title that is already seen says nothing about when it was watched. Replaces '
  'LogSheet''s set_bucket + log_watched pair and the residual race between them.';

revoke execute on function log_title(uuid, uuid, taste_bucket, date, watch_date_basis)
  from public, anon;
grant execute on function log_title(uuid, uuid, taste_bucket, date, watch_date_basis)
  to authenticated;


/**
 * `set_watch_date` — LogSheet's When row on a title with **exactly one** event.
 *
 * It refuses when there are several, with `P0001 multiple_watches`, and the sheet then
 * shows `Watched 3 times ›` instead of a date row (§J.2). That refusal is the product
 * decision made structural: a single date control cannot honestly represent six
 * viewings, and the alternative -- silently editing "the latest one" -- is the kind of
 * write nobody can predict from the screen they are looking at.
 */
create or replace function set_watch_date(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_watched_on    date,
  p_basis         watch_date_basis
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim record;
  v_count integer;
  v_id    uuid;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'set_watch_date');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  if p_basis is null or p_basis = 'diary' then
    raise exception 'basis must be today_default, reader or none' using errcode = '22023';
  end if;

  if (p_basis = 'none') <> (p_watched_on is null) then
    raise exception 'basis none means no date, and a date means a basis'
      using errcode = '22023';
  end if;

  if p_watched_on is not null and p_watched_on > current_date + 1 then
    raise exception 'watch date is in the future' using errcode = '22023';
  end if;

  perform _lock_media(auth.uid(), p_media_item_id);

  -- Two aggregates over the same scan. `min()` has no uuid form, so the id comes back
  -- through `array_agg`, which is exact here because the count decides whether it is
  -- used at all: exactly one row means exactly one element.
  select count(*), (array_agg(we.id))[1] into v_count, v_id
    from watch_events we
   where we.user_id = auth.uid() and we.media_item_id = p_media_item_id;

  if v_count = 0 then
    raise exception 'title is not in your collection' using errcode = 'P0002';
  end if;

  if v_count > 1 then
    raise exception 'multiple_watches' using errcode = 'P0001',
      hint = 'this title has more than one watch; edit them from Watch History';
  end if;

  update watch_events
     set watched_on = p_watched_on, basis = p_basis, updated_at = now()
   where id = v_id
     and (watched_on is distinct from p_watched_on or basis is distinct from p_basis);

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'watch_event_id', v_id)
  );
end;
$$;

comment on function set_watch_date(uuid, uuid, date, watch_date_basis) is
  'Dates the one watch event a title has, or clears it to none. Refuses P0001 '
  'multiple_watches when there are several (§D.5) -- a single date control cannot '
  'honestly represent six viewings, and the sheet shows the Watch History entry instead.';

revoke execute on function set_watch_date(uuid, uuid, date, watch_date_basis)
  from public, anon;
grant execute on function set_watch_date(uuid, uuid, date, watch_date_basis)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 8b. The importer, rebuilt from its true latest body (20260917000300)
--
-- One block is added: after `imported_watches` is written, the same diary entries become
-- `watch_events`, and the supersede and prior-viewing rules (§D.2) are applied. Every
-- other line is transcribed, including the per-row subtransaction, the "leave a native
-- row's date alone" branch and its whole comment, and the poison handling.
--
-- ===========================================================================
-- THE THREE RULES IN THE NEW BLOCK
--
--   **Diary entries become events.** One per entry, `basis = 'diary'`, keyed on the
--   diary URI -- so a second import of the same archive adds nothing, which is the
--   property `imported_watches` was given for and is now inherited rather than
--   reimplemented.
--
--   **Supersede.** When the diary brings dated viewings to a title whose ONLY event is
--   `none`, that undated event is deleted in the same pass. The diary now accounts for
--   the viewing, and leaving both would be §O.6.3's double count: "watched at some
--   point" plus "watched on these four dates" is five viewings where there were four.
--
--   **Prior viewing, and it is the only inference in the design.** If the title's
--   earliest diary entry says `Rewatch = Yes`, the export itself asserts a viewing
--   before the diary begins. One `none` event survives (or is created), keyed
--   `<uri>#prior`. Inferred from the source's own flag, never from anything bingd
--   guessed -- which is R3.
--
-- A native date that equals a diary date yields ONE event, not two: the diary insert
-- skips a date an existing native event already holds. Same viewing, recorded twice.
-- ---------------------------------------------------------------------------

create or replace function _import_apply_batch(p_job_id uuid, p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid;
  v_done  integer := 0;
  v_row   record;
  v_ranked boolean;
  v_source content_source;
  v_prior  text;
begin
  select user_id into v_user from import_jobs where id = p_job_id;
  if v_user is null then return 0; end if;

  -- The whole slice is an import. Transaction-local, and the marker is the transaction id
  -- so a value that escapes is inert (20260917000100).
  perform set_config('bingd.import_running', txid_current()::text, true);

  -- `import_rows.media_item_id` is `on delete set null`, so a catalogue row deleted between
  -- matching and applying leaves a row that is `matched` and points at nothing. The loop
  -- below cannot select it, so without this it would sit there for ever holding the job
  -- open. It is honestly unplaceable now: the title it was matched to is gone.
  update import_rows
     set status = 'unmatched'
   where job_id = p_job_id and status = 'matched' and media_item_id is null;

  for v_row in
    select id, kind, correlation, media_item_id, raw
      from import_rows
     where job_id = p_job_id
       and status = 'matched'
       and media_item_id is not null
     -- Watched first, and ordered by an explicit `case` rather than by `kind` — which
     -- would happen to work, since 'watched' sorts before 'watchlist', and would be a
     -- correctness guarantee resting on a collation nobody chose for this purpose.
     order by case when kind = 'watched' then 0 else 1 end, id
     limit greatest(coalesce(p_limit, 200), 1)
     for update skip locked
  loop
    -- ---------------------------------------------------------------------------
    -- ONE ROW'S FAILURE COSTS ONE ROW
    --
    -- A subtransaction per row. Without it any error raised below — a cast, a constraint,
    -- a foreign key to a title deleted since matching — rolls back the entire slice, and
    -- the next tick meets the same row and rolls back again until the job dead-letters
    -- having written nothing. Independent review reproduced exactly that.
    --
    -- The cost is a subtransaction per applied row, which is what `begin ... exception`
    -- means in plpgsql. At a couple of hundred rows a slice that is not a concern, and it
    -- is the difference between one lost film and a lost library.
    -- ---------------------------------------------------------------------------
    begin
    -- Serialise against a ranking or a log on the same title, exactly as every other
    -- collection writer does.
    perform _lock_media(v_user, v_row.media_item_id);

    select exists (select 1 from rankings
                    where user_id = v_user and media_item_id = v_row.media_item_id)
      into v_ranked;

    select source into v_source
      from user_media
     where user_id = v_user and media_item_id = v_row.media_item_id;

    if v_row.kind = 'watched' then
      if v_ranked then
        -- Ranked here. The strongest native state there is: not the bucket, not the date,
        -- nothing. Recorded as applied so the job's counts can say how many were kept.
        null;

      elsif v_source = 'in_app' then
        -- ---------------------------------------------------------------------------
        -- Logged here. Fill the bucket if it is empty, and **leave `watched_on` alone.**
        --
        -- Filling a null date looks like the same "fill only what is empty" rule the
        -- bucket gets, and it is not, because an empty `watched_on` is load-bearing:
        -- `_leaderboard_counts` attributes a monthly row to
        -- `coalesce(watched_on, created_at)`, so writing a 2019 date onto a film somebody
        -- logged here last week silently removes it from this month's board.
        --
        -- The locked contract says an import never counts toward the monthly leaderboard.
        -- An import that *decrements* a native row's standing is the mirror of that and
        -- was not sanctioned either, so the conservative reading wins: the import does not
        -- touch the watched state of a row somebody built here.
        --
        -- 20261003000100: the date is still not written HERE, and the diary's dates now
        -- land as `diary` watch events below instead of only as provenance. The cache may
        -- therefore move to a later diary date, which is authoritative data adding a
        -- viewing rather than an import overwriting a native one -- and the monthly board
        -- stops reading the cache at all at T4 (R2), which is what makes that safe.
        -- ---------------------------------------------------------------------------
        update user_media
           set bucket = coalesce(bucket, (v_row.raw->>'bucket')::taste_bucket)
         where user_id = v_user and media_item_id = v_row.media_item_id;

      else
        -- Absent, or previously imported. Either way the import owns it.
        insert into user_media (user_id, media_item_id, bucket, watched_on, source)
        values (v_user, v_row.media_item_id,
                (v_row.raw->>'bucket')::taste_bucket,
                (v_row.raw->>'watchedOn')::date,
                'imported')
        on conflict (user_id, media_item_id) do update
          set bucket     = coalesce(excluded.bucket, user_media.bucket),
              watched_on = coalesce(user_media.watched_on, excluded.watched_on);
      end if;

      -- Provenance, for every watched row the import knows about -- including one it left
      -- alone, because the fact that Letterboxd rated it is still true and the title page
      -- may say so. Skipped when no collection row exists, which cannot happen above but
      -- is cheap to be sure of.
      if exists (select 1 from user_media
                  where user_id = v_user and media_item_id = v_row.media_item_id) then
        insert into imported_titles (
          user_id, media_item_id, letterboxd_uri, source_name, source_year, rating
        )
        values (v_user, v_row.media_item_id, v_row.raw->>'filmUri',
                coalesce(v_row.raw->>'name', '?'), (v_row.raw->>'year')::integer,
                (v_row.raw->>'rating')::numeric)
        on conflict (user_id, media_item_id) do update
          set letterboxd_uri   = coalesce(excluded.letterboxd_uri, imported_titles.letterboxd_uri),
              source_name      = excluded.source_name,
              source_year      = excluded.source_year,
              rating           = coalesce(excluded.rating, imported_titles.rating),
              last_imported_at = now();

        -- Per-viewing provenance. `on conflict do nothing` on (user_id, diary_uri) is what
        -- makes a second import of the same diary free. **Still written during the
        -- transition** (§D.5): retiring this table is a T7 item, and until then it is the
        -- evidence a re-run of T1's backfill would rebuild from.
        insert into imported_watches (user_id, media_item_id, diary_uri, watched_on, is_rewatch)
        select v_user, v_row.media_item_id,
               w->>'diaryUri', (w->>'watchedOn')::date,
               coalesce((w->>'isRewatch')::boolean, false)
          from jsonb_array_elements(coalesce(v_row.raw->'watches', '[]'::jsonb)) w
         where w->>'diaryUri' is not null
           and (w->>'watchedOn')::date between date '1870-01-01' and date '2100-01-01'
        on conflict (user_id, diary_uri) do nothing;

        -- ---------------------------------------------------------------------------
        -- 20261003000100. The diary becomes watch history.
        -- ---------------------------------------------------------------------------

        -- One event per diary entry. The date is skipped when an existing NATIVE event
        -- already holds it: that is one viewing the reader recorded here and Letterboxd
        -- recorded there, and two events would be §O.6.3's double count.
        insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref)
        select v_user, v_row.media_item_id,
               (w->>'watchedOn')::date, 'diary', w->>'diaryUri'
          from jsonb_array_elements(coalesce(v_row.raw->'watches', '[]'::jsonb)) w
         where w->>'diaryUri' is not null
           and (w->>'watchedOn')::date between date '1870-01-01' and date '2100-01-01'
           and not exists (
             select 1 from watch_events we
              where we.user_id = v_user
                and we.media_item_id = v_row.media_item_id
                and we.import_ref is null
                and we.watched_on = (w->>'watchedOn')::date
           )
        on conflict (user_id, import_ref) where import_ref is not null do nothing;

        -- The prior viewing the source asserts, before the supersede below can delete
        -- the undated event that would otherwise be the only record of it. `#prior` on
        -- the earliest entry's URI, so a re-import finds it and adds nothing.
        select w->>'diaryUri' into v_prior
          from jsonb_array_elements(coalesce(v_row.raw->'watches', '[]'::jsonb)) w
         where w->>'diaryUri' is not null
           and coalesce((w->>'isRewatch')::boolean, false)
           and (w->>'watchedOn')::date = (
             select min((x->>'watchedOn')::date)
               from jsonb_array_elements(coalesce(v_row.raw->'watches', '[]'::jsonb)) x
              where x->>'diaryUri' is not null
           )
         order by w->>'diaryUri'
         limit 1;

        if v_prior is not null then
          insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref)
          values (v_user, v_row.media_item_id, null, 'none', v_prior || '#prior')
          on conflict (user_id, import_ref) where import_ref is not null do nothing;
        end if;

        -- Supersede. The title's only undated event was "watched at some point"; the
        -- diary has now said when, so it is deleted. The `#prior` event above is exempt
        -- because it carries an `import_ref` and this deletes only the bare one.
        delete from watch_events we
         where we.user_id = v_user
           and we.media_item_id = v_row.media_item_id
           and we.basis = 'none'
           and we.import_ref is null
           and exists (
             select 1 from watch_events d
              where d.user_id = v_user
                and d.media_item_id = v_row.media_item_id
                and d.basis = 'diary'
           );

        -- ---------------------------------------------------------------------------
        -- A dated imported row with no diary entry to account for the date.
        --
        -- `raw->>'watchedOn'` is the diary MAXIMUM the client computed, and an archive
        -- can carry it with no `watches` array behind it. Without this the row would
        -- reach commit with no event at all, the deferred trigger would give it an
        -- UNDATED one, and the cache would then recompute `watched_on` to null --
        -- **erasing a date the importer had just written**. It is the same case §M.3
        -- step 4 handles in the backfill, and it needed handling on the live path too.
        --
        -- `basis = 'diary'`: that date came from the diary, so it is authoritative, and
        -- calling it native would put an import on the monthly board at T4.
        -- ---------------------------------------------------------------------------
        insert into watch_events (user_id, media_item_id, watched_on, basis)
        select um.user_id, um.media_item_id, um.watched_on, 'diary'
          from user_media um
         where um.user_id = v_user
           and um.media_item_id = v_row.media_item_id
           and um.watched_on is not null
           and not exists (
             select 1 from watch_events we
              where we.user_id = v_user and we.media_item_id = v_row.media_item_id
           );
      end if;

    else
      -- A watchlist row. Only if the title is not already in the collection -- watched
      -- beats wanting to watch, and the watched half of this job has already run.
      --
      -- Written DIRECTLY rather than through `set_watchlist`, which writes a
      -- `watchlist_added` feed event per call. The gate would cancel those anyway; not
      -- producing them is better than producing and discarding thousands.
      if not exists (select 1 from user_media
                      where user_id = v_user and media_item_id = v_row.media_item_id) then
        insert into watchlist (user_id, media_item_id)
        values (v_user, v_row.media_item_id)
        on conflict (user_id, media_item_id) do nothing;
      end if;
    end if;

      update import_rows set status = 'applied' where id = v_row.id;

    exception
      -- A deadlock or a serialisation failure is the scheduler's problem, not the row's.
      -- Marking it terminal would silently lose a film to a race it should simply have
      -- retried, so class 40 goes back up and the slice is retried whole.
      when deadlock_detected or serialization_failure or lock_not_available then
        raise;

      when others then
        -- Poison: a constraint, a cast, a title deleted since matching. Marked so the
        -- slice makes progress and the next tick does not meet it again, and counted as
        -- unmatched — from the reader's side a row that could not be written is a film
        -- that did not arrive, which is the same sentence.
        update import_rows set status = 'unmatched', candidates = null where id = v_row.id;
    end;

    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;


-- ---------------------------------------------------------------------------
-- 9. The backfill (§M.3), in ONE statement, under the quiet marker
--
-- ===========================================================================
-- R3: NO INFERRED REWATCHES
--
-- Only authoritative stored evidence produces a viewing. That is the Letterboxd diary --
-- one `imported_watches` row per logged viewing, each with its own URI -- and that
-- table's own `is_rewatch` flag, which is the source asserting an earlier viewing. Four
-- other fields look like rewatch evidence and none of them is:
--
--   `feed_events` duplicates      the payload has no new-watch flag, and an unrank plus
--                                 a re-rank also reposts
--   `ranking_sessions.new_watch`  sessions are deleted at finalize; survivors are
--                                 unfinished
--   `processed_operations`        `rank_again` stores no arguments and its stored result
--                                 is the session start, without `new_watch`
--   `user_media.watched_on`       one overwritten date
--
-- **Pre-epic in-app rewatches are therefore not recoverable, and history starts
-- incomplete for them.** That is the honest outcome and it is the founder's decision,
-- not an implementation shortfall.
--
-- ===========================================================================
-- WHY IT IS ONE `DO` BLOCK AND NOT NINE STATEMENTS
--
-- `bingd.import_running` is set with `set_config(..., true)`, which is TRANSACTION-local,
-- and `_importing()` compares it against `txid_current()`. The transactional runner gives
-- a migration file one transaction, so nine statements would share one txid and the
-- marker would hold -- but `supabase db push` and `supabase migration up` split a file
-- and execute the statements **outside a transaction** (`apply-staging-migrations.mjs`
-- documents this at length, and it is why that tool exists). Under those appliers a
-- marker set in statement one is dead in statement two, and the backfill would announce
-- a goal completion or an award per crossing, by migration, to a real account's
-- followers.
--
-- One block cannot be split, so the marker covers what it is written to cover whichever
-- applier runs this file. The same reasoning is why the temp snapshot below is created
-- and dropped inside the block rather than around it.
--
-- ===========================================================================
-- WHY THE PRE-BACKFILL STATE IS SNAPSHOT FIRST
--
-- **The cache trigger mutates the column steps 3 and 4 read.** Caught by
-- `watch-events-backfill.test.mjs` on its first run, against the fixture with a native
-- 2025-03-01 date and a diary entry from 2026-04-04:
--
--   step 1 inserts the diary event
--   the cache trigger recomputes `user_media.watched_on` to 2026-04-04
--   step 3 asks "is there a diary event on `um.watched_on`?" -- and now there is
--   the native viewing of 2025-03-01 is skipped, and is gone for ever
--
-- Reading a snapshot taken before any event exists makes the five steps independent of
-- their own side effects. It is also what lets the cache trigger stay ON during the
-- backfill, which is what the operator wants: the cache is then correct at every point,
-- and the final sweep is a proof rather than a repair.
-- ---------------------------------------------------------------------------

do $backfill$
begin
  -- The whole backfill is a bulk write, and nothing it touches is news to anybody.
  perform set_config('bingd.import_running', txid_current()::text, true);

  -- The collection as it stands before any event exists. `on commit drop` is deliberate
  -- belt and braces: the explicit drop below is what normally removes it, and this is
  -- what removes it if the block raises.
  create temp table _t1_collection on commit drop as
    select um.user_id, um.media_item_id, um.watched_on, um.source, um.created_at
      from user_media um
      join media_items m on m.id = um.media_item_id
     where rankable_category(m.kind) is not null;

  -- Step 1. One `diary` event per `imported_watches` row. The diary URI is the identity,
  -- so a re-import adds nothing and this backfill is idempotent against one.
  insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref, recorded_at)
  select iw.user_id, iw.media_item_id, iw.watched_on, 'diary', iw.diary_uri, iw.imported_at
    from imported_watches iw
    join _t1_collection c
      on c.user_id = iw.user_id and c.media_item_id = iw.media_item_id
  on conflict (user_id, import_ref) where import_ref is not null do nothing;

  -- Step 2. The prior viewing the source itself asserts: the title's EARLIEST diary entry
  -- carries `Rewatch = Yes`, so Letterboxd is saying there was a viewing before the diary
  -- begins. One undated event, keyed `<uri>#prior` so a second run is free.
  insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref, recorded_at)
  select e.user_id, e.media_item_id, null, 'none', e.diary_uri || '#prior', e.imported_at
    from (
      select distinct on (iw.user_id, iw.media_item_id)
             iw.user_id, iw.media_item_id, iw.diary_uri, iw.is_rewatch, iw.imported_at
        from imported_watches iw
        join _t1_collection c
          on c.user_id = iw.user_id and c.media_item_id = iw.media_item_id
       order by iw.user_id, iw.media_item_id, iw.watched_on asc, iw.diary_uri asc
    ) e
   where e.is_rewatch
  on conflict (user_id, import_ref) where import_ref is not null do nothing;

  -- Step 3. A native date: one `unattributed` event on the same date, recorded at the day
  -- the collection row appeared. Skipped when a diary event already carries that exact
  -- date, because that is one viewing recorded twice and §O.6.3 names double-counting as
  -- a hardest failure mode.
  insert into watch_events (user_id, media_item_id, watched_on, basis, recorded_at)
  select c.user_id, c.media_item_id, c.watched_on, 'unattributed', c.created_at
    from _t1_collection c
   where c.source = 'in_app'
     and c.watched_on is not null
     and not exists (
       select 1 from watch_events we
        where we.user_id = c.user_id
          and we.media_item_id = c.media_item_id
          and we.watched_on = c.watched_on
     );

  -- Step 4. An imported row with a date but no diary evidence. That date came from the
  -- diary MAXIMUM (`_import_apply_batch`), so it is authoritative and its basis is `diary`
  -- even though no per-viewing URI survived to prove it.
  insert into watch_events (user_id, media_item_id, watched_on, basis, recorded_at)
  select c.user_id, c.media_item_id, c.watched_on, 'diary', c.created_at
    from _t1_collection c
   where c.source <> 'in_app'
     and c.watched_on is not null
     and not exists (
       select 1 from watch_events we
        where we.user_id = c.user_id and we.media_item_id = c.media_item_id
     );

  -- Step 5. Everything else: seen, time unknown. One undated event, recorded at the day
  -- the row appeared.
  insert into watch_events (user_id, media_item_id, watched_on, basis, recorded_at)
  select c.user_id, c.media_item_id, null, 'none', c.created_at
    from _t1_collection c
   where not exists (
     select 1 from watch_events we
      where we.user_id = c.user_id and we.media_item_id = c.media_item_id
   );

  drop table _t1_collection;
end;
$backfill$;

-- The cache, proved rather than repaired. Every statement above already maintained it
-- through the trigger; this recomputes the whole table once more and must change nothing
-- -- which is exactly what `assert_watch_history_valid`'s W3 then asserts.
--
-- It is separate from the block above on purpose: the marker is gone, so if this DID
-- move a row the ordinary triggers would fire and the operator would see it, rather than
-- a silent correction hidden under an import marker.
do $cache$
declare
  v_users uuid[];
  v_items uuid[];
begin
  select array_agg(t.user_id), array_agg(t.media_item_id)
    into v_users, v_items
    from (select distinct user_id, media_item_id from watch_events) t;
  perform _watch_cache_recompute(v_users, v_items);
end;
$cache$;


-- ---------------------------------------------------------------------------
-- 10. The invariant, callable (§M.3's verification queries, as one function)
--
-- `assert_ranking_valid`'s peer. It is what the test suite calls after every fixture and
-- what the staging and production verification runs call before anybody believes the
-- backfill. It raises on the first violation and says which one, because a boolean that
-- comes back false tells an operator nothing at two in the morning.
-- ---------------------------------------------------------------------------

create or replace function assert_watch_history_valid(p_user uuid default null)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_bad integer;
  v_id  text;
begin
  -- W1. A seen title of a rankable kind has at least one watch event (§D.0).
  select count(*), min(um.media_item_id::text) into v_bad, v_id
    from user_media um
    join media_items m on m.id = um.media_item_id
   where (p_user is null or um.user_id = p_user)
     and rankable_category(m.kind) is not null
     and not exists (
       select 1 from watch_events we
        where we.user_id = um.user_id and we.media_item_id = um.media_item_id
     );
  if v_bad > 0 then
    raise exception 'W1 violated: % seen titles have no watch event (e.g. %)', v_bad, v_id
      using errcode = 'P0001';
  end if;

  -- W2. `basis = none` <=> no date. The table constraint enforces it row by row; this
  -- asks the same question of the whole table, which is what catches a constraint
  -- somebody dropped to make a migration pass.
  select count(*), min(we.id::text) into v_bad, v_id
    from watch_events we
   where (p_user is null or we.user_id = p_user)
     and (we.basis = 'none') <> (we.watched_on is null);
  if v_bad > 0 then
    raise exception 'W2 violated: % events disagree with their basis (e.g. %)', v_bad, v_id
      using errcode = 'P0001';
  end if;

  -- W3. The cache equals the maximum. The one that catches drift (§O.6.2), and the
  -- reason the cache is recomputed rather than advanced.
  select count(*), min(um.media_item_id::text) into v_bad, v_id
    from user_media um
    join media_items m on m.id = um.media_item_id
   where (p_user is null or um.user_id = p_user)
     and rankable_category(m.kind) is not null
     and um.watched_on is distinct from (
       select max(we.watched_on) from watch_events we
        where we.user_id = um.user_id and we.media_item_id = um.media_item_id
     );
  if v_bad > 0 then
    raise exception 'W3 violated: % cached dates differ from max(event) (e.g. %)', v_bad, v_id
      using errcode = 'P0001';
  end if;

  -- W4. No event belongs to a title that is not seen. The composite FK guarantees it;
  -- stating it here is what would catch the FK being dropped, which is exactly the shape
  -- of a "make the migration apply" fix.
  select count(*), min(we.id::text) into v_bad, v_id
    from watch_events we
   where (p_user is null or we.user_id = p_user)
     and not exists (
       select 1 from user_media um
        where um.user_id = we.user_id and um.media_item_id = we.media_item_id
     );
  if v_bad > 0 then
    raise exception 'W4 violated: % events have no collection row (e.g. %)', v_bad, v_id
      using errcode = 'P0001';
  end if;

  -- W5. Every diary event the import recorded is present, and none was invented.
  select count(*) into v_bad
    from imported_watches iw
    join user_media um
      on um.user_id = iw.user_id and um.media_item_id = iw.media_item_id
    join media_items m on m.id = iw.media_item_id
   where (p_user is null or iw.user_id = p_user)
     and rankable_category(m.kind) is not null
     and not exists (
       select 1 from watch_events we
        where we.user_id = iw.user_id and we.import_ref = iw.diary_uri
     );
  if v_bad > 0 then
    raise exception 'W5 violated: % diary entries have no watch event', v_bad
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function assert_watch_history_valid(uuid) is
  'W1 a seen rankable title has >= 1 watch event; W2 basis none <=> no date; W3 the '
  'user_media.watched_on cache equals max(event date); W4 no event without a collection '
  'row; W5 every imported_watches row has its diary event. Raises P0001 naming the first '
  'violation and an example. Peer of assert_ranking_valid, and the gate the staging and '
  'production verification runs call.';

revoke execute on function assert_watch_history_valid(uuid) from public, anon, authenticated;
