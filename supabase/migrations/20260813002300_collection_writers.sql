-- Collection writers: the six outbox-eligible operations in api.md §1.
-- Specification: docs/architecture/api.md §1 · offline-sync.md §3 §5 · PRD §11 §18
--
-- Until now the ranking engine was complete and unreachable. rank_start takes a
-- media_item_id that had to already be in user_media, and nothing could put it
-- there: user_media has a select policy and no insert, update or delete policy, by
-- design, because every write goes through a function. Those functions were
-- specified and never written. So the schema could rank a collection it had no way
-- to acquire.
--
-- All six are SECURITY DEFINER, which is what lets them write through the absent
-- policies, and all six raise standard SQLSTATEs for the edge layer to map to the
-- BGnnn codes in api.md §8.

-- ---------------------------------------------------------------------------
-- 1. The idempotency ledger gets a per-account key
--
-- 20260813000100 created processed_operations with `operation_id uuid primary key`,
-- which is what offline-sync.md §3 describes. Its first real callers arrive in this
-- migration, and a globally unique key is the wrong shape for them.
--
-- Under a global key, an id claimed by one account silences the same id sent by
-- another: the guard answers 'already_applied' and writes nothing, and the second
-- client reports success because the response says so. The row simply never appears.
--
-- Being precise about what that requires, because the obvious telling of it does not
-- hold up: harm needs the id burned *before* its owner sends it, so an attacker would
-- have to know a v4 uuid generated on someone else's device, and no API, table policy
-- or error surface exposes one. As a targeted attack it is not reachable.
--
-- What is reachable is disclosure by accident. Operation ids travel in crash reports
-- and support screenshots, and an outbox surviving an account switch on a shared
-- device carries one account's ids into another's session. Each of those is a
-- collision waiting on a coincidence rather than an adversary.
--
-- The point of the narrower key is that it stops the question from needing an answer.
-- Idempotency only ever has to hold within one device's queue, every queue belongs to
-- one account, and scoping the key that way costs nothing — so there is no need to
-- reason about which disclosure paths exist now or arrive later.
--
-- The foreign key is the other half, and brings the schema in line with
-- data-model.md §12, which has described this column as referencing profiles all
-- along. It was an unconstrained uuid, so a deleted account left its ledger behind
-- forever and nothing prevented a row naming an account that never existed.
-- ---------------------------------------------------------------------------

alter table processed_operations
  drop constraint processed_operations_pkey;

alter table processed_operations
  add constraint processed_operations_pkey primary key (user_id, operation_id);

alter table processed_operations
  add constraint processed_operations_user_fk
  foreign key (user_id) references profiles(id) on delete cascade;

-- Which RPC claimed the id. Not used for control flow; it is what makes a stuck queue
-- diagnosable, since without it a ledger row records only that *something* happened.
alter table processed_operations
  add column kind text;

comment on table processed_operations is
  'Idempotency ledger for outbox-eligible RPCs (offline-sync.md §3). Keyed per account rather than globally: ids are generated on the device, and a shared key means an id disclosed by one account can make another account''s genuine write return success without happening. Row level security is on with no policies, so only SECURITY DEFINER functions reach it.';

-- The prune the foundation migration promised does not exist yet, and its retention
-- is not a free choice: it must exceed the longest a client can hold an unsent
-- operation. An operation that exhausts its retries moves to `failed` in the device
-- outbox and waits there for a manual retry, which may be days. Prune its ledger row
-- before that retry arrives and the replay stops being a no-op, because nothing
-- remembers it ran.
comment on column processed_operations.processed_at is
  'Prune key. Any scheduled prune must retain rows longer than the maximum lifetime of a failed outbox entry, or a manual retry after the prune applies its operation a second time.';

-- ---------------------------------------------------------------------------
-- 2. The guard, as a function
--
-- Written once rather than copied into six bodies. Returns true when the caller
-- should proceed and false when this operation has already been applied, so each
-- function's first two lines read as the specification does.
--
-- Note the interaction with assert_can_write(): each function calls that first, so a
-- suspended account is refused before anything is recorded. Order does not affect
-- correctness — a raised exception rolls the ledger insert back with everything else
-- — but recording work that was refused would make the ledger lie.
-- ---------------------------------------------------------------------------

create or replace function _claim_operation(p_operation_id uuid, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_operation_id is null then
    raise exception 'operation_id is required' using errcode = '22023';
  end if;

  insert into processed_operations (user_id, operation_id, kind)
  values (auth.uid(), p_operation_id, p_kind)
  on conflict (user_id, operation_id) do nothing;

  return found;
end;
$$;

comment on function _claim_operation(uuid, text) is
  'Idempotency guard for outbox-eligible RPCs. Returns false when the operation was already applied, which the caller reports as success (offline-sync.md §3).';

-- ---------------------------------------------------------------------------
-- 3. The note gets its own version
--
-- offline-sync.md §5 detects a note conflict by comparing the version the edit was
-- based on against the stored one, and the first draft of this migration used
-- user_media.updated_at for that. It cannot be used, and the reason is worth keeping:
-- touch_updated_at advances updated_at on *every* update of the row, so a bucket
-- change, a watch date, or a progress change all move the note's version without the
-- note changing.
--
-- That is not a corner case, it is the ordinary flow. Offline, a user taps a bucket
-- and then writes a note on the same film — the natural order of the core interaction.
-- The queue drains in creation order, set_bucket advances updated_at, and save_note
-- then arrives carrying the base captured before the drain. Guaranteed conflict, on a
-- note nothing else touched, presented as "this changed on another device". Two of the
-- user's own offline note edits collide the same way.
--
-- A mechanism built to prevent silent data loss would instead manufacture a dialog
-- often enough to teach people to dismiss it, which is exactly when it needs to be
-- believed.
--
-- So the version tracks the note and nothing else.
-- ---------------------------------------------------------------------------

alter table user_media
  add column note_updated_at timestamptz;

comment on column user_media.note_updated_at is
  'Version for the offline-sync.md §5 note conflict rule. Advances only when note changes, unlike updated_at, which every write to the row advances — using that one made an unrelated bucket tap invalidate a queued note edit. Null means no note has ever been stored, in which case there is nothing to overwrite and no conflict to detect.';

-- Insert as well as update. log_watched can create the row with a note already in it,
-- and a null version means "nothing stored, nothing to lose" — so an update-only
-- trigger would leave every note written at creation time freely overwritable by a
-- stale queued edit, which is the failure this column exists to prevent.
create or replace function touch_note_version()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.note is not null then
      new.note_updated_at = now();
    end if;
  elsif new.note is distinct from old.note then
    new.note_updated_at = now();
  end if;
  return new;
end;
$$;

create trigger user_media_touch_note_version
  before insert or update on user_media
  for each row execute function touch_note_version();

-- Backfill, so an existing note is not treated as never-written and therefore freely
-- overwritable. updated_at is the best available approximation of when it was last
-- touched, and is correct for any row whose last write was the note itself.
update user_media set note_updated_at = updated_at where note is not null;

-- The cap lives on the column as well as in the functions, the way reports.note's does.
-- The functions raise 22023 so the client gets a field error rather than an invariant
-- violation; the constraint is what still holds if user_media ever gains a write policy.
alter table user_media
  add constraint user_media_note_length
  check (note is null or char_length(note) <= 2000);

-- ---------------------------------------------------------------------------
-- 4. Refusing a ranked title
--
-- offline-sync.md §3 and api.md §1: set_bucket and unlog are queueable, and both
-- are ranking mutations when the title is ranked. Changing the bucket of a ranked
-- title moves it between bands and renumbers; unlogging it deletes a position and
-- closes the gap, discarding dozens of comparisons. Queued, either applies silently
-- on reconnect.
--
-- The rule this expresses, which generalizes to every RPC added later: a function is
-- queueable only if it is queueable for every state its target row can be in. The
-- allowlist reasons about names and cannot see row state, so the function refuses.
-- ---------------------------------------------------------------------------

create or replace function _assert_unranked(p_media_item_id uuid)
returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from rankings
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) then
    raise exception 'title is ranked; use the online-only path'
      using errcode = '55000',
            hint = 'rank_rebucket to change the rating, unrank before removing';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Media item existence and kind
--
-- P0002 for a missing title, per the api.md §8 mapping to BG404. media_items is
-- world-readable, so there is no visibility question to conflate with existence
-- here — unlike profiles and lists, where the two are deliberately indistinguishable.
--
-- Kind matters. PRD §10 forbids ranking a whole series, and the collection is what
-- feeds ranking, so what may be *logged* is a movie or a season. A series may still
-- be watchlisted: wanting to watch a show is a coherent statement, while having
-- watched one is ambiguous about which seasons.
-- ---------------------------------------------------------------------------

create or replace function _media_kind(p_media_item_id uuid)
returns media_kind
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_kind media_kind;
begin
  select kind into v_kind from media_items where id = p_media_item_id;

  if v_kind is null then
    raise exception 'no such title' using errcode = 'P0002';
  end if;

  return v_kind;
end;
$$;

-- A note is owner-private, so an unbounded one is storage abuse rather than a vector
-- pointed at anyone. It still gets a bound, for the reason reports.note got one: a
-- column with no limit is a column a modified client can put a megabyte in, per title.
-- 2000 characters is an engineering choice and not a product decision; nothing in the
-- PRD specifies a length, and if the founder wants a different one this is where it
-- lives.
create or replace function _assert_note_length(p_note text)
returns void
language plpgsql immutable
as $$
begin
  if p_note is not null and char_length(p_note) > 2000 then
    raise exception 'a note is limited to 2000 characters' using errcode = '22023';
  end if;
end;
$$;

create or replace function _assert_loggable(p_media_item_id uuid)
returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if _media_kind(p_media_item_id) = 'series' then
    raise exception 'a series cannot be logged; log a season'
      using errcode = '22023',
            hint = 'PRD §10: series are not rankable, and the collection feeds ranking';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. log_watched
--
-- Upsert rather than insert. Logging a title already logged is not an error — it is
-- a user correcting a watch date or adding a note — and returning 23505 would make
-- the client distinguish a real conflict from a benign repeat.
--
-- coalesce on update, so a call that omits watched_on does not erase one already
-- stored. Clearing a watch date is not an operation the API offers; if it becomes
-- one it needs its own function, because "absent" and "explicitly cleared" cannot be
-- told apart in a single nullable parameter.
-- ---------------------------------------------------------------------------

create or replace function log_watched(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_watched_on    date default null,
  p_note          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_version timestamptz;
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
  -- One day of slack accepts a genuinely-tomorrow date from a determined client, which
  -- costs nothing, and stops refusing real ones.
  if p_watched_on is not null and p_watched_on > current_date + 1 then
    raise exception 'watch date is in the future' using errcode = '22023';
  end if;

  insert into user_media (user_id, media_item_id, watched_on, note)
  values (auth.uid(), p_media_item_id, p_watched_on, v_note)
  on conflict (user_id, media_item_id) do update
    set watched_on = coalesce(excluded.watched_on, user_media.watched_on),
        note       = coalesce(excluded.note,       user_media.note)
  returning note_updated_at into v_version;

  -- The note version comes back here too, since this is the other function that can
  -- write one. A client that logged with a note has no server version for it until
  -- something hands one over, and a base version must always be one the server issued
  -- — never a locally invented timestamp, which would read as a conflict.
  return jsonb_build_object('status', 'ok', 'note_version', v_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. set_bucket
--
-- Creates the user_media row when absent. A bucket is a statement about a title the
-- user has seen, so bucketing implies logging, and requiring two round trips to
-- express one tap would put a window between them in which the title is watched with
-- no opinion attached — a state the UI never asks for.
--
-- Deliberately separate from rank_start (api.md §1). Setting a bucket is a
-- low-conflict write that queues offline; opening a comparison session needs the
-- server. A user who buckets offline gets a Logged title and can rank it later,
-- which is the two-state model in PRD §11.
--
-- Known and not closed here: the unranked check and the upsert are two statements with
-- no lock spanning them, so one account's rank_start committing between them leaves
-- user_media.bucket disagreeing with rankings.bucket — an I3 violation. It needs the
-- same account writing from two devices in the same instant, and costs one desynced
-- bucket. Closing it properly means the ranking RPCs taking the same advisory lock on
-- (user_id, media_item_id), which is a change to seven functions in another migration
-- and not something to bundle in here. Recorded in open-questions.md.
-- ---------------------------------------------------------------------------

create or replace function set_bucket(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_bucket        taste_bucket
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_bucket') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if p_bucket is null then
    raise exception 'bucket is required' using errcode = '22023';
  end if;

  perform _assert_loggable(p_media_item_id);
  perform _assert_unranked(p_media_item_id);

  insert into user_media (user_id, media_item_id, bucket)
  values (auth.uid(), p_media_item_id, p_bucket)
  on conflict (user_id, media_item_id) do update
    set bucket = excluded.bucket;

  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. unlog
-- ---------------------------------------------------------------------------

create or replace function unlog(
  p_operation_id  uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'unlog') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_unranked(p_media_item_id);

  delete from user_media
   where user_id = auth.uid() and media_item_id = p_media_item_id;

  get diagnostics v_deleted = row_count;

  -- offline-sync.md §5: an operation targeting something already gone fails and
  -- leaves the queue, rather than retrying against a row that will never return.
  if v_deleted = 0 then
    raise exception 'not in your collection' using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. set_watchlist
--
-- The one collection write that accepts a series, for the reason in §4.
-- ---------------------------------------------------------------------------

create or replace function set_watchlist(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_present       boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_watchlist') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if p_present is null then
    raise exception 'present is required' using errcode = '22023';
  end if;

  -- Existence is checked even for a removal, so a call naming a title that does not
  -- exist is a clear P0002 rather than a silent success.
  perform _media_kind(p_media_item_id);

  if p_present then
    insert into watchlist (user_id, media_item_id)
    values (auth.uid(), p_media_item_id)
    on conflict (user_id, media_item_id) do nothing;
  else
    delete from watchlist
     where user_id = auth.uid() and media_item_id = p_media_item_id;
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. set_season_progress
-- ---------------------------------------------------------------------------

create or replace function set_season_progress(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_progress      season_progress
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_season_progress') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if p_progress is null then
    raise exception 'progress is required' using errcode = '22023';
  end if;

  if _media_kind(p_media_item_id) <> 'season' then
    raise exception 'progress applies to seasons only' using errcode = '22023';
  end if;

  insert into user_media (user_id, media_item_id, progress)
  values (auth.uid(), p_media_item_id, p_progress)
  on conflict (user_id, media_item_id) do update
    set progress = excluded.progress;

  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. save_note
--
-- The only write here with a conflict rule beyond last-one-wins. A note is the only
-- free text a user writes, so losing one to a silent overwrite is a real loss
-- (offline-sync.md §5). When the client supplies the version its edit was based on and
-- that no longer matches, the write is refused and the user chooses.
--
-- The refusal carries the server's version and *not* the server's text. The client can
-- read its own note — it owns the row — and Postgres writes an exception's DETAIL into
-- the database log at default settings, so putting note text there would deposit a
-- field PRD §22 classifies as always-private into operator-visible logs every time a
-- conflict fires. One extra read on a rare path is a better trade.
--
-- The comparison is truncated to milliseconds, which is not fussiness. Postgres keeps
-- timestamps to microseconds; JavaScript's Date holds milliseconds. Any client path
-- that parses the timestamp into a Date and serializes it again — the ordinary thing
-- to do — loses the microseconds, and compared exactly that mismatch reads as a
-- conflict, so every note edit would demand the user resolve a divergence between a
-- text and itself.
--
-- The cost is a one-millisecond window in which a genuine second write is not seen as
-- one. Two edits landing that close are two transactions, not one, so the window is
-- real and accepted rather than absent: it takes a second device writing inside the
-- same millisecond as the base it is racing, and losing that is a smaller harm than
-- making every ordinary edit look like a conflict.
--
-- Returns the new version, so a client draining several edits to one note can carry
-- the base forward instead of colliding with its own previous write.
-- ---------------------------------------------------------------------------

create or replace function save_note(
  p_operation_id     uuid,
  p_media_item_id    uuid,
  p_note             text,
  p_base_updated_at  timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_current user_media;
  v_version timestamptz;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'save_note') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_note_length(v_note);

  select * into v_current
    from user_media
   where user_id = auth.uid() and media_item_id = p_media_item_id;

  if not found then
    raise exception 'not in your collection' using errcode = 'P0002';
  end if;

  -- A null stored version means no note has ever been written here, so there is
  -- nothing a stale edit could destroy and nothing to ask the user about.
  if p_base_updated_at is not null
     and v_current.note_updated_at is not null
     and date_trunc('milliseconds', v_current.note_updated_at)
      <> date_trunc('milliseconds', p_base_updated_at) then
    raise exception 'the note changed elsewhere'
      using errcode = '55000',
            detail  = jsonb_build_object(
              'conflict',       'note',
              'server_version', v_current.note_updated_at
            )::text;
  end if;

  update user_media
     set note = v_note
   where user_id = auth.uid() and media_item_id = p_media_item_id
  returning note_updated_at into v_version;

  return jsonb_build_object('status', 'ok', 'note_version', v_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Privileges
--
-- 20260813001800 made execute default-deny with an explicit allow-list, and
-- 20260813002100 issued the global form so new functions arrive with no PUBLIC
-- grant. The six public entry points are granted; the five helpers are not, because
-- _assert_unranked and _media_kind would each answer a question about a row the
-- caller may not be entitled to ask about, and _claim_operation called directly
-- would let a client burn an operation id to make a later real write disappear.
-- (touch_note_version is a trigger function and never callable as an RPC.)
-- ---------------------------------------------------------------------------

grant execute on function log_watched(uuid, uuid, date, text)          to authenticated;
grant execute on function set_bucket(uuid, uuid, taste_bucket)         to authenticated;
grant execute on function unlog(uuid, uuid)                            to authenticated;
grant execute on function set_watchlist(uuid, uuid, boolean)           to authenticated;
grant execute on function set_season_progress(uuid, uuid, season_progress) to authenticated;
grant execute on function save_note(uuid, uuid, text, timestamptz)     to authenticated;

comment on function log_watched(uuid, uuid, date, text) is
  'Marks a title watched. Outbox-eligible. Upserts, so a repeat with a corrected date is not a conflict. Returns note_version when a note was written, since that is the value a later save_note must send as its base. Accepts a watch date up to tomorrow, because the server is UTC and a client east of it sends a local date a day ahead for the first hours of its day.';
comment on function set_bucket(uuid, uuid, taste_bucket) is
  'Sets the bucket without starting comparisons, creating the collection row if absent. Refuses a ranked title with 55000: for a ranked title this is a band move, which PRD §18 forbids queuing.';
comment on function unlog(uuid, uuid) is
  'Removes a title from the collection. Refuses a ranked title with 55000, since queuing it would discard ranking work silently on reconnect.';
comment on function save_note(uuid, uuid, text, timestamptz) is
  'Updates the private note and returns the new note_version. The base version is compared against note_updated_at, which only a note change advances, so an unrelated bucket or date write cannot invalidate a queued edit. When it is stale, raises 55000 carrying the server version but not the server text, which stays out of the database log; the client reads its own note to show the choice. Comparison is truncated to milliseconds because JavaScript Date cannot carry the microseconds Postgres stores.';
