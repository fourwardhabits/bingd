-- An import that runs itself.
--
-- The asynchronous pipeline: a client stages normalised rows and leaves, and the database
-- matches and applies them in bounded slices until the job is done. Nothing here holds a
-- provider key, nothing here needs the client to stay open, and every step is safe to run
-- twice.
--
-- Specification: Contract V3 §10. Depends on 20260917000100, 20260917000200.
--
-- ===========================================================================
-- THE WORKER IS THE PUSH WORKER, DELIBERATELY
--
-- `20260826000300` and `20260826000700` already solved "a queue that drains itself" for
-- push: a pg_cron tick, a claim with `FOR UPDATE SKIP LOCKED`, a `claimed_at` lease that
-- expires so a dead worker cannot strand a row, an attempt counter, a dead letter, and a
-- raise when the project is unconfigured so pg_cron records a failure rather than 1,221
-- silent successes.
--
-- That is the same problem, so this is the same shape with the same numbers -- a five
-- minute lease, three failures or six attempts to the dead letter. A second queue
-- architecture would be a second set of edge cases to get wrong.
--
-- **What is different** is that the work is SQL rather than HTTP. Matching a title against
-- the local catalogue and applying a collection row are both things Postgres can do, so
-- the tick does them directly and the Edge Function is needed only for the provider tier.
-- A project with no provider configured still imports; it simply resolves fewer titles.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The job gets a lease, and the rows get a lifecycle
-- ---------------------------------------------------------------------------

alter table import_jobs add column claimed_at timestamptz;
alter table import_jobs add column attempts   integer not null default 0;
alter table import_jobs add column failures   integer not null default 0;
alter table import_jobs add column last_error text;

comment on column import_jobs.claimed_at is
  'When a worker took this job. A claim older than five minutes is reclaimable, so a worker that dies mid-slice cannot strand an import -- the same lease push_outbox uses.';
comment on column import_jobs.storage_path is
  'Unused and always null. The client parses and minimises on the device; the archive is never uploaded, so there is no stored object to point at. Kept rather than dropped because dropping a column is not worth a migration on its own.';

-- `raw` holds the NORMALISED staged row -- name, year, film URI, rating, watch date -- and
-- never CSV text. It is deleted when the job completes, which is what keeps this from
-- becoming a permanent warehouse of somebody's export.
comment on column import_rows.raw is
  'One normalised staged row, not raw CSV: the parser already discarded everything the contract excludes before anything left the device. Deleted on completion for applied and duplicate rows; retained only while a row is still unresolved.';

alter table import_rows add column kind        text;
alter table import_rows add column correlation text;

-- The provider tier's own attempt counter, separate from the job's. A title the provider
-- cannot resolve must stop being asked about without failing the job it belongs to: one
-- obscure short is not a reason to dead-letter somebody's library.
alter table import_rows add column provider_attempts integer not null default 0;

comment on column import_rows.kind is
  'watched or watchlist. The two halves apply in that order, because every watch signal fires _leave_watchlist and applying the watchlist first would have the database delete rows the import had just written.';
comment on column import_rows.correlation is
  'The intra-export (Name, Year) key the client computed. NOT a film identity -- it exists so several CSV rows about one film become one collection row, and so a diary viewing can find its title. Canonical identity is media_item_id.';

-- Widened, not replaced: two states the original set had no name for. `pending` is a row
-- nobody has tried to match yet, and `needs_provider` is one the local catalogue could not
-- resolve and the provider tier has not yet seen -- which must be distinct from `unmatched`,
-- or an unconfigured project would permanently mark titles unmatched that a provider would
-- have found.
alter table import_rows drop constraint import_rows_known_status;
alter table import_rows add constraint import_rows_known_status
  check (status in ('pending', 'needs_provider', 'matched', 'ambiguous',
                    'unmatched', 'duplicate', 'applied'));

-- One live job per account. A second import while one is running is a person tapping twice,
-- not a second intention, and two workers applying two archives to one collection is a race
-- nobody needs to reason about.
create unique index import_jobs_one_live on import_jobs (user_id)
  where completed_at is null;

-- Staging is idempotent on this: re-posting a page after a dropped connection changes
-- nothing. `kind` is in the key because a title can legitimately be both a watch and a
-- watchlist row in one archive -- the apply step is what resolves that, not the stage step.
create unique index import_rows_once on import_rows (job_id, kind, correlation);

create index import_jobs_due on import_jobs (created_at)
  where completed_at is null;


-- ---------------------------------------------------------------------------
-- 2. Creating and staging — the only two things a client does
-- ---------------------------------------------------------------------------

create or replace function import_create()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform assert_can_write();

  -- A live job is reused rather than refused. The client that lost its connection
  -- mid-stage should be able to carry on, and `import_rows_once` makes re-posting the
  -- pages it already sent free.
  select id into v_id
    from import_jobs
   where user_id = auth.uid() and completed_at is null
   order by created_at desc
   limit 1;

  if v_id is not null then return v_id; end if;

  insert into import_jobs (user_id, status) values (auth.uid(), 'pending')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function import_create() is
  'Opens an import job for the caller, or returns the one already open. Never refuses: a second call is a client retrying, and import_rows_once makes re-staging idempotent.';

grant execute on function import_create() to authenticated;


create or replace function import_stage(p_job_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner  uuid;
  v_status text;
  v_staged integer;
begin
  perform assert_can_write();

  select user_id, status into v_owner, v_status
    from import_jobs where id = p_job_id;

  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'no such import' using errcode = 'P0002';
  end if;
  if v_status <> 'pending' then
    raise exception 'this import is no longer accepting rows' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;
  -- A page, not a library. The client loops; this bounds one statement.
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'too many rows in one page' using errcode = '22023';
  end if;

  insert into import_rows (job_id, kind, correlation, raw, status)
  select p_job_id,
         r->>'kind',
         r->>'correlation',
         -- Only the fields the contract keeps. Anything else the client sent is dropped
         -- here rather than stored and ignored, so the staging table cannot quietly become
         -- a channel for data this import does not import.
         jsonb_strip_nulls(jsonb_build_object(
           'name',       r->>'name',
           'year',       (r->>'year')::integer,
           'filmUri',    r->>'filmUri',
           'rating',     (r->>'rating')::numeric,
           'bucket',     r->>'bucket',
           'watchedOn',  (r->>'watchedOn')::date,
           'watches',    r->'watches'
         )),
         'pending'
    from jsonb_array_elements(p_rows) r
   where r->>'correlation' is not null
     and r->>'kind' in ('watched', 'watchlist')
  on conflict (job_id, kind, correlation) do nothing;

  get diagnostics v_staged = row_count;

  return jsonb_build_object('status', 'ok', 'staged', v_staged);
end;
$$;

comment on function import_stage(uuid, jsonb) is
  'Stages one page of normalised rows onto the caller''s own open job. Idempotent through import_rows_once, so a retried page after a dropped connection stages nothing twice. Projects the payload field by field: whatever else the client sends is discarded rather than stored, so this table cannot become a side channel for the files the import refuses to read.';

grant execute on function import_stage(uuid, jsonb) to authenticated;


create or replace function import_ready(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_rows  integer;
begin
  perform assert_can_write();

  select user_id into v_owner from import_jobs where id = p_job_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'no such import' using errcode = 'P0002';
  end if;

  select count(*) into v_rows from import_rows where job_id = p_job_id;

  update import_jobs
     set status = 'matching',
         counts = counts || jsonb_build_object('staged', v_rows)
   where id = p_job_id and status = 'pending';

  return jsonb_build_object('status', 'ok', 'staged', v_rows);
end;
$$;

comment on function import_ready(uuid) is
  'Hands a fully staged job to the worker. After this the client may close: everything else happens on a pg_cron tick. Idempotent -- a second call against a job already matching changes nothing.';

grant execute on function import_ready(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Matching, against the local catalogue
--
-- Identity discipline, which is the whole of this section:
--
--   T0  the FILM uri, through letterboxd_matches   exact, shared, free
--   T1  squashed title + year within one           heuristic, local, free
--   T1b squashed title, catalogue row undated      heuristic, local, free
--   ..  anything left goes to needs_provider, and the provider tier decides
--
-- A diary-entry URI can never enter `letterboxd_matches`, because the only URI staged on a
-- row is `filmUri`, and the client's parser reads the diary's URI column into the per-
-- viewing payload and never into that field. The cache is global and unattributed, so one
-- account's bad row would otherwise be every later importer's bad row.
--
-- **Ambiguity is left unresolved rather than guessed.** Two catalogue rows with the same
-- squashed title and a year within one of each other is a remake, and picking the popular
-- one would put a film somebody did not watch into their collection with a rating they
-- gave to a different film.
-- ---------------------------------------------------------------------------

create or replace function _import_match_batch(p_job_id uuid, p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done integer := 0;
begin
  with due as (
    select id, raw->>'name' as name, (raw->>'year')::integer as year, raw->>'filmUri' as uri
      from import_rows
     where job_id = p_job_id and status = 'pending'
     order by id
     limit greatest(coalesce(p_limit, 200), 1)
     for update skip locked
  ),
  resolved as (
    select d.id,
           d.uri,
           -- T0. An exact, previously confirmed film.
           (select m.media_item_id from letterboxd_matches m where m.letterboxd_uri = d.uri) as t0,
           -- T1 / T1b. Exactly one catalogue movie whose squashed title matches and whose
           -- year is within one -- or which has no release date at all, which is how an
           -- announced-but-undated title is still findable.
           (select array_agg(mi.id)
              from media_items mi
             where mi.kind = 'movie'
               and mi.sort_key_squashed = media_squash(d.name)
               and (
                 d.year is null
                 or mi.release_date is null
                 or abs(extract(year from mi.release_date)::integer - d.year) <= 1
               )) as local
      from due d
  )
  update import_rows r
     set media_item_id = case
           when x.t0 is not null then x.t0
           when array_length(x.local, 1) = 1 then x.local[1]
           else null
         end,
         status = case
           when x.t0 is not null then 'matched'
           when array_length(x.local, 1) = 1 then 'matched'
           when array_length(x.local, 1) > 1 then 'ambiguous'
           else 'needs_provider'
         end,
         candidates = case
           when x.t0 is null and array_length(x.local, 1) > 1
             then to_jsonb(x.local)
           else null
         end
    from resolved x
   where r.id = x.id;

  get diagnostics v_done = row_count;

  -- Every confirmed local match teaches the shared cache, so the next importer of the same
  -- film resolves it at T0 for nothing. Only a FILM uri is ever written here.
  insert into letterboxd_matches (letterboxd_uri, media_item_id)
  select distinct r.raw->>'filmUri', r.media_item_id
    from import_rows r
   where r.job_id = p_job_id
     and r.status = 'matched'
     and r.media_item_id is not null
     and r.raw->>'filmUri' is not null
  on conflict (letterboxd_uri) do nothing;

  return v_done;
end;
$$;

comment on function _import_match_batch(uuid, integer) is
  'One bounded slice of local matching: the shared film-URI cache first, then exactly-one squashed title with a year within one. Two or more survivors is ambiguous and stays unresolved -- a remake picked by popularity is a film the person did not watch, carrying a rating they gave to a different one. Anything unresolved becomes needs_provider rather than unmatched, so an unconfigured project does not permanently condemn titles a provider would have found. Internal.';

revoke execute on function _import_match_batch(uuid, integer) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. Applying
--
-- Three rules, and all three are the contract made mechanical:
--
--   **Watched before watchlist.** Every watch signal fires `_leave_watchlist`, so the other
--   order has the database delete rows the import just wrote.
--
--   **Native wins.** A ranked title is not touched at all; an `in_app` row has its nulls
--   filled and nothing else. The ratchet in 20260917000200 is the backstop -- even if this
--   function were wrong, `source` cannot go back.
--
--   **Silence.** The whole slice runs under `bingd.import_running`, so the award and goal
--   triggers skip their per-row work and the gate cancels any feed event or notification
--   that something else tries to write.
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
begin
  select user_id into v_user from import_jobs where id = p_job_id;
  if v_user is null then return 0; end if;

  -- The whole slice is an import. Transaction-local, and the marker is the transaction id
  -- so a value that escapes is inert (20260917000100).
  perform set_config('bingd.import_running', txid_current()::text, true);

  for v_row in
    select id, kind, correlation, media_item_id, raw
      from import_rows
     where job_id = p_job_id
       and status = 'matched'
       and media_item_id is not null
     -- Watched first. `kind` sorts 'watched' after 'watchlist' alphabetically, so the
     -- ordering is stated explicitly rather than inherited from the collation.
     order by case when kind = 'watched' then 0 else 1 end, id
     limit greatest(coalesce(p_limit, 200), 1)
     for update skip locked
  loop
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
        -- Logged here. Fill what is empty and touch nothing that is not.
        update user_media
           set watched_on = coalesce(watched_on, (v_row.raw->>'watchedOn')::date),
               bucket     = coalesce(bucket, (v_row.raw->>'bucket')::taste_bucket)
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
        -- makes a second import of the same diary free.
        insert into imported_watches (user_id, media_item_id, diary_uri, watched_on, is_rewatch)
        select v_user, v_row.media_item_id,
               w->>'diaryUri', (w->>'watchedOn')::date,
               coalesce((w->>'isRewatch')::boolean, false)
          from jsonb_array_elements(coalesce(v_row.raw->'watches', '[]'::jsonb)) w
         where w->>'diaryUri' is not null
           and (w->>'watchedOn')::date between date '1870-01-01' and date '2100-01-01'
        on conflict (user_id, diary_uri) do nothing;
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
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

comment on function _import_apply_batch(uuid, integer) is
  'One bounded slice of apply, under the import marker so nothing announces. Watched rows before watchlist rows, because every watch signal fires _leave_watchlist. Never touches a ranked title, fills only nulls on a natively logged one, and writes the watchlist directly rather than through set_watchlist so no watchlist_added events are produced. Writes no rankings and no scores: this function has no statement that could. Internal.';

revoke execute on function _import_apply_batch(uuid, integer) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. Settling, and cleaning up
--
-- The award ledger is evaluated once, here, with the marker still set -- so the tiers an
-- imported history genuinely crosses are recorded and nobody is told in a burst. The
-- thirteen collection tracks only: `queue-dragon` was never skipped, because
-- `_award_touch_watchlist` is deliberately unguarded (20260917000100).
--
-- Then the staging rows go. `applied` and `duplicate` are deleted outright; `ambiguous` and
-- `unmatched` are kept, because they are the only record of what could not be placed and
-- the repair surface reads them. Nothing here retains CSV.
-- ---------------------------------------------------------------------------

create or replace function _import_settle(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid;
  v_counts jsonb;
begin
  select user_id into v_user from import_jobs where id = p_job_id;
  if v_user is null then return '{}'::jsonb; end if;

  perform set_config('bingd.import_running', txid_current()::text, true);

  perform _maybe_award_unlocks(v_user,
    array['movie-muncher','season-snacker','scream-snack','lol-mode',
          'softie-hours','space-brain','boom-club','toon-bloom',
          'truth-worm','passport-mode','time-hopper','genre-gremlin',
          'two-screen-life']);

  select jsonb_build_object(
           'applied',    count(*) filter (where status = 'applied'),
           'ambiguous',  count(*) filter (where status = 'ambiguous'),
           'unmatched',  count(*) filter (where status in ('unmatched', 'needs_provider')),
           'watched',    (select count(*) from user_media
                           where user_id = v_user and source = 'imported'),
           'watchlist',  (select count(*) from watchlist w
                           where w.user_id = v_user
                             and exists (select 1 from import_rows ir
                                          where ir.job_id = p_job_id
                                            and ir.kind = 'watchlist'
                                            and ir.media_item_id = w.media_item_id)),
           'viewings',   (select count(*) from imported_watches where user_id = v_user)
         )
    into v_counts
    from import_rows where job_id = p_job_id;

  -- The retention rule. A staging table is not a warehouse: what has landed is deleted,
  -- and only what is still unresolved survives, for the repair surface to read.
  delete from import_rows
   where job_id = p_job_id and status in ('applied', 'duplicate');

  update import_jobs
     set status = 'done',
         completed_at = now(),
         claimed_at = null,
         counts = counts || v_counts
   where id = p_job_id;

  return v_counts;
end;
$$;

comment on function _import_settle(uuid) is
  'Ends a job: evaluates the thirteen collection award tracks once, silently, under the marker; writes the counts the summary screen reads; deletes every applied and duplicate staging row; and leaves only the unresolved ones behind for the repair surface. Internal.';

revoke execute on function _import_settle(uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5b. The provider tier's two ends
--
-- The Edge Function holds the provider key and does the lookup; these two functions are
-- everything about it that can be reasoned about in SQL, which is the claim and the
-- accounting. Split that way so the backoff, the attempt ceiling and the terminal states
-- are testable without a provider, and the function is thin enough to read.
--
-- **Three attempts, then the row is honestly unmatched.** A title the provider cannot
-- place is not a failure of the job: an import of two thousand films with one obscure
-- short in it must finish, and say it placed 1,999.
-- ---------------------------------------------------------------------------

create or replace function _import_provider_claim(p_limit integer default 50)
returns table (row_id uuid, name text, year integer)
language sql
security definer
set search_path = public
as $$
  with due as (
    select r.id
      from import_rows r
      join import_jobs j on j.id = r.job_id
     where r.status = 'needs_provider'
       and r.provider_attempts < 3
       and j.completed_at is null
     order by r.id
     limit greatest(coalesce(p_limit, 50), 1)
     for update skip locked
  )
  update import_rows r
     set provider_attempts = r.provider_attempts + 1
    from due
   where r.id = due.id
  returning r.id, r.raw->>'name', (r.raw->>'year')::integer;
$$;

comment on function _import_provider_claim(integer) is
  'Hands the provider worker a bounded batch of titles the local catalogue could not place, incrementing each row''s own attempt counter as it goes. Rows past three attempts are not returned, so one unplaceable title cannot be asked about for ever. for update skip locked, so two workers take different rows. service_role only.';

revoke execute on function _import_provider_claim(integer) from public, anon, authenticated;


create or replace function _import_provider_resolve(p_row_id uuid, p_media_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uri text;
begin
  if p_media_item_id is not null then
    update import_rows
       set media_item_id = p_media_item_id, status = 'matched', candidates = null
     where id = p_row_id
    returning raw->>'filmUri' into v_uri;

    -- The shared cache learns from the provider too, and only ever a FILM uri: `filmUri`
    -- is the only URI staged on a row, and the client's parser never reads the diary's
    -- URI column into it.
    if v_uri is not null then
      insert into letterboxd_matches (letterboxd_uri, media_item_id)
      values (v_uri, p_media_item_id)
      on conflict (letterboxd_uri) do nothing;
    end if;

  else
    -- Not found this time. Terminal only once the attempts are spent, so a transient
    -- provider failure is retried and a genuinely unknown film eventually settles.
    update import_rows
       set status = case when provider_attempts >= 3 then 'unmatched' else 'needs_provider' end
     where id = p_row_id;
  end if;
end;
$$;

comment on function _import_provider_resolve(uuid, uuid) is
  'Records what the provider worker found for one row, or that it found nothing. A null media item leaves the row retryable until its third attempt and then settles it as unmatched -- a transient provider failure and an unknown film must not look the same. A resolved row teaches letterboxd_matches, film URIs only. service_role only.';

revoke execute on function _import_provider_resolve(uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. The tick
--
-- `_drain_push_outbox`'s shape, including the parts that look like paranoia and are not:
-- an idle short-circuit so an empty queue costs nothing, and a **raise** when the project
-- cannot do the work, because pg_cron records a failure and nothing else it can see.
--
-- Unlike push, the common path needs no HTTP at all. The Edge Function is called only when
-- rows are waiting on the provider tier, and a project with no provider configured still
-- finishes the job -- those rows simply end `unmatched`.
-- ---------------------------------------------------------------------------

create or replace function _drain_import_jobs(p_jobs integer default 3, p_slice integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due     integer;
  v_job     record;
  v_worked  integer := 0;
  v_posted  integer := 0;
  v_url     text;
  v_key     text;
begin
  select count(*) into v_due
    from import_jobs
   where completed_at is null and status in ('matching', 'applying');

  if v_due = 0 then
    return jsonb_build_object('status', 'idle', 'due', 0);
  end if;

  -- Dead letter first, on the same thresholds push uses. A job that has failed three times
  -- or been attempted six is not going to succeed by being tried again, and leaving it
  -- claimed for ever would block the account's next import behind `import_jobs_one_live`.
  update import_jobs
     set status = 'failed', completed_at = now(), claimed_at = null,
         last_error = coalesce(last_error, 'exhausted')
   where completed_at is null
     and (failures >= 3 or attempts >= 6);

  for v_job in
    with due as (
      select id from import_jobs
       where completed_at is null
         and status in ('matching', 'applying')
         and failures < 3 and attempts < 6
         and (claimed_at is null or claimed_at < now() - interval '5 minutes')
       order by created_at
       limit greatest(coalesce(p_jobs, 3), 1)
       for update skip locked
    )
    update import_jobs j
       set claimed_at = now(), attempts = j.attempts + 1
      from due
     where j.id = due.id
    returning j.id, j.status
  loop
    begin
      if v_job.status = 'matching' then
        if _import_match_batch(v_job.id, p_slice) = 0 then
          update import_jobs set status = 'applying' where id = v_job.id;
        end if;
      else
        if _import_apply_batch(v_job.id, p_slice) = 0 then
          perform _import_settle(v_job.id);
        end if;
      end if;

      v_worked := v_worked + 1;

      update import_jobs
         set claimed_at = null, failures = 0
       where id = v_job.id and completed_at is null;

    exception when others then
      -- One job's failure is not the tick's. Record it and carry on: the lease expiry and
      -- the attempt counter are what eventually stop a job that cannot progress.
      update import_jobs
         set failures = failures + 1, claimed_at = null,
             last_error = left(sqlerrm, 300)
       where id = v_job.id;
    end;
  end loop;

  -- The provider tier, and only if there is anything for it. Same configuration and the
  -- same raise-when-unconfigured rule as the push drain -- except that here an unconfigured
  -- project is not broken, so this asks rather than insists.
  select count(*) into v_posted
    from import_rows r join import_jobs j on j.id = r.job_id
   where r.status = 'needs_provider'
     and r.provider_attempts < 3
     and j.completed_at is null;

  if v_posted > 0 then
    select value #>> '{}' into v_url from app_config where key = 'functions.base_url';
    begin
      select decrypted_secret into v_key
        from vault.decrypted_secrets where name = 'service_role_key';
    exception when others then
      v_key := null;
    end;

    if nullif(v_url, '') is not null and nullif(v_key, '') is not null then
      perform net.http_post(
        url     := v_url || '/letterboxd-import',
        headers := jsonb_build_object(
                     'Content-Type',  'application/json',
                     'Authorization', 'Bearer ' || v_key,
                     'apikey',        v_key
                   ),
        body    := jsonb_build_object('action', 'resolve'),
        timeout_milliseconds := 20000
      );
    end if;
  end if;

  return jsonb_build_object('status', 'worked', 'due', v_due,
                            'jobs', v_worked, 'awaiting_provider', v_posted);
end;
$$;

comment on function _drain_import_jobs(integer, integer) is
  'One tick of the import worker: dead-letter what is exhausted, claim up to a few jobs under a five-minute lease, do one bounded slice of matching or applying, and settle a job whose rows have all landed. Errors are recorded against the job rather than raised, so one bad import cannot stop the queue. Posts to the Edge Function only when rows are waiting on the provider tier; a project with no provider still completes every job. service_role only.';

revoke execute on function _drain_import_jobs(integer, integer) from public, anon, authenticated;


create or replace function schedule_import_drain(p_schedule text default '* * * * *')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobid bigint;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed on this database'
      using errcode = '55000',
            hint = 'Enable pg_cron and pg_net (Supabase dashboard, Database > Extensions), then call this again.';
  end if;

  execute $q$ select jobid from cron.job where jobname = 'bingd-import-drain' $q$ into v_jobid;
  if v_jobid is not null then
    execute $q$ select cron.unschedule($1) $q$ using v_jobid;
  end if;

  execute $q$ select cron.schedule('bingd-import-drain', $1, 'select public._drain_import_jobs()') $q$
    into v_jobid
    using p_schedule;

  return jsonb_build_object('status', 'ok', 'jobid', v_jobid, 'schedule', p_schedule);
end;
$$;

comment on function schedule_import_drain(text) is
  'Installs (or replaces) the pg_cron job that drains import_jobs. Idempotent by job name, for the reason schedule_push_drain is: two jobs with the same name is two workers a minute for ever. service_role only.';

revoke execute on function schedule_import_drain(text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 7. What the client watches
-- ---------------------------------------------------------------------------

create or replace function import_status(p_job_id uuid)
returns table (status text, counts jsonb, created_at timestamptz, completed_at timestamptz)
language sql stable security invoker
set search_path = public
as $$
  select j.status, j.counts, j.created_at, j.completed_at
    from import_jobs j
   where j.id = p_job_id;
$$;

comment on function import_status(uuid) is
  'One job''s progress, for the screen that draws it. SECURITY INVOKER: import_jobs_own already restricts this to the owner, so RLS answers whose job it is and this does not have to. Deliberately omits last_error, which is operator detail rather than something a person can act on.';

grant execute on function import_status(uuid) to authenticated;
