-- An import that keeps up: the 2,500-title scale gate (Round 3, 2026-09-13).
--
-- The founder imported twenty-four films on a preview build and it "took a while". A
-- target user has about 2,500. Measured against a real PostgreSQL 17 with every migration
-- applied (`supabase/tests/perf/import-scale.mjs`), the pipeline's own work is small —
-- about 1.1-1.7 ms of compute per row, the slowest 200-row tick under half a second — and
-- nearly all of the wall clock was the schedule around it. That is the good news. The
-- measurement also found two ways a large import loses films, and those are the reason
-- this file exists rather than a schedule string.
--
-- ===========================================================================
-- 1. THE PROVIDER GRACE WAS COUNTED FROM THE WRONG MOMENT  (release blocker)
--
-- A job may hold for the provider tier while titles it has never been asked about remain.
-- That hold was `created_at >= now() - grace`: measured from `import_create`, so staging,
-- matching and applying all spent it. At one slice a minute a 2,500-title archive is still
-- applying at minute twenty-five, and at minute thirty the job settled with every title the
-- provider had not yet reached counted as unmatched — films TMDB would have found.
-- Reproduced: 36 of 91 provider-findable films arrived; the rest were reported missing.
--
-- The hold is now measured from the provider's own activity (`provider_touched_at`, set by
-- each claim and when the job starts applying). A provider that is working keeps the job
-- open until it has asked about every title; a provider that has gone silent for the grace
-- period still ends the wait, which is what the grace was for. The 24-hour wall clock is
-- unchanged and still bounds everything.
--
-- ===========================================================================
-- 2. A PROVIDER ANSWER COULD ARRIVE AFTER ITS JOB HAD ENDED
--
-- `_import_provider_claim` handed rows out with nothing marking them as out. The hold only
-- asked whether attempts remained, so a third-attempt claim still in flight did not hold
-- the job: it settled, redacted the rows, and the late `_import_provider_resolve` then
-- wrote `matched` onto a row of a finished job that nothing would ever apply. A film the
-- provider had found, silently dropped.
--
-- Claims now carry a lease (`provider_claimed_at`, two minutes). A leased row holds its job
-- open, a resolve clears the lease, and a resolve for a job that has already ended changes
-- nothing. An invocation that dies mid-batch simply lets the lease lapse, and the rows are
-- offered again — which is also the backoff a rate-limited provider needs.
--
-- The lease also makes a faster drain safe: without it, two overlapping invocations could
-- claim the same row and spend two attempts on one search.
--
-- ===========================================================================
-- 3. A DEFINITE "NOT FOUND" WAS ASKED THREE TIMES, AND A RATE LIMIT COULD USE UP A TITLE
--
-- A null resolve kept the row retryable until its third attempt, so a film TMDB has never
-- heard of cost three searches — 879 provider calls for a 2,500-title archive where 492
-- found something. "Transient failure" and "the provider answered and had nothing" are
-- different facts. `_import_provider_resolve` takes `p_final`: the Edge Function passes
-- true only when TMDB answered with no results at all, and the row settles at once; a
-- non-empty answer that was not confident keeps the retry ladder. A thrown request never
-- reaches resolve, so it is retried when its lease lapses. The default is false, so the
-- function version already deployed keeps its old, slower semantics until it is redeployed
-- — this migration is safe to apply first.
--
-- `_import_provider_release` hands back claims TMDB was never asked about (the invocation
-- stopped at a 429) and claims refused with 429, refunding the attempt. Independent review
-- 83a found that without it three rate-limited invocations settled a findable film as
-- unmatched without one request for it.
--
-- ===========================================================================
-- 4. THE CADENCE
--
-- One slice per job per minute put a floor of about a minute under a twenty-four-film import
-- and about twenty-eight minutes under 2,500 films whose work takes five seconds.
--
--   * The drain runs every ten seconds (pg_cron >= 1.5 schedules in seconds; staging runs
--     1.6.4). Where it cannot, the installer falls back to once a minute and says so.
--   * Each tick works its claimed jobs round-robin, slice by slice, until the work is done
--     or a time budget (`import.tick_budget_ms`, default 2 seconds) is spent. Bounded, so a
--     tick's transaction and its collection locks stay short; round-robin, so a small import
--     is not queued behind a large one. More jobs are claimed per tick for the same reason.
--     The budget is checked between passes, so it bounds work, not lock waits: a slice
--     waiting on `_lock_media` behind somebody's ranking waits as long as that ranking does,
--     exactly as a single slice always has.
--   * One provider invocation at a time: the nudge is not posted while any row is leased,
--     so TMDB traffic stays at one invocation's eight-wide concurrency.
--   * The sweep and the poster nudge move to their own once-a-minute job. The nudge posts a
--     poster batch per call; running it every ten seconds would re-ask for titles whose
--     enrichment is still in flight.
--   * Each cron job's run history is pruned to seven days by the maintenance job, because a
--     ten-second schedule writes 8,640 `cron.job_run_details` rows a day and nothing else
--     trims them. Only these two jobs' rows are touched.
--
-- Nothing here changes what an import writes, how a title is matched, native-wins, the
-- trust boundary on shared matches, the silence of an import, the notifications, the
-- bounds, or retention. `supabase/tests/perf/import-scale.mjs` asserts those at every size.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table import_rows add column if not exists provider_claimed_at timestamptz;
comment on column import_rows.provider_claimed_at is
  'When the provider tier last took this row, cleared when it answers. A row claimed within the lease (two minutes) is in flight: it is not offered again and it holds its job open. Null for a row never claimed or already answered.';

alter table import_jobs add column if not exists provider_touched_at timestamptz;
comment on column import_jobs.provider_touched_at is
  'The last moment the provider tier did anything for this job -- a claim -- or when it started applying. The provider grace (import.provider_grace_minutes) is measured from here, not from created_at, so a long import is not cut off while the provider is still working through it.';

create index if not exists import_rows_provider_due
  on import_rows (job_id, provider_attempts, id)
  where status = 'needs_provider';

insert into app_config (key, value) values ('import.tick_budget_ms', '2000'::jsonb)
  on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- The provider tier's two ends
-- ---------------------------------------------------------------------------

create or replace function _import_provider_claim(p_limit integer default 50)
returns table (row_id uuid, name text, year integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with ranked as (
    -- Round-robin across jobs: every job's first unasked title before any job's second, so
    -- one person's 2,500 films do not hold somebody else's twenty-four behind them.
    select r.id,
           row_number() over (partition by r.job_id order by r.provider_attempts, r.id) as turn
      from import_rows r
      join import_jobs j on j.id = r.job_id
     where r.status = 'needs_provider'
       and r.provider_attempts < 3
       and j.completed_at is null
       and (r.provider_claimed_at is null or r.provider_claimed_at < now() - interval '2 minutes')
  ),
  due as (
    -- The eligibility test is repeated on the locking scan itself. Under READ COMMITTED a
    -- row another invocation claimed between `ranked` and this lock is re-checked here
    -- against its new version and skipped; the `in` list alone would not be re-evaluated.
    select r.id
      from import_rows r
     where r.id in (select k.id from ranked k order by k.turn, k.id
                     limit greatest(coalesce(p_limit, 50), 1))
       and r.status = 'needs_provider'
       and r.provider_attempts < 3
       and (r.provider_claimed_at is null or r.provider_claimed_at < now() - interval '2 minutes')
       for update skip locked
  ),
  claimed as (
    update import_rows r
       set provider_attempts = r.provider_attempts + 1,
           provider_claimed_at = now()
      from due
     where r.id = due.id
    returning r.id, r.job_id, r.raw->>'name' as title, (r.raw->>'year')::integer as released
  ),
  touchable as (
    -- Skipped rather than waited for when a tick holds the job row: the tick is the job
    -- making progress, and the next claim touches it again.
    select j.id from import_jobs j
     where j.id in (select c.job_id from claimed c)
       for update skip locked
  ),
  touched as (
    update import_jobs j set provider_touched_at = now()
      from touchable t where j.id = t.id
    returning j.id
  )
  select c.id, c.title, c.released from claimed c;
end;
$$;

comment on function _import_provider_claim(integer) is
  'Hands the provider worker a bounded batch of titles the local catalogue could not place: round-robin across jobs, never a row already in flight (leased within two minutes), never past three attempts. Spends the attempt, leases the row, and marks the job as having provider activity. for update skip locked, with the eligibility re-checked on the lock, so overlapping invocations take different rows. service_role only.';

revoke execute on function _import_provider_claim(integer) from public, anon, authenticated;
grant execute on function _import_provider_claim(integer) to service_role;


-- ---------------------------------------------------------------------------
-- Handing back what was never asked (independent review 83a, BLOCKER)
--
-- The attempt is spent at claim time, and the Edge Function claims a batch and then works
-- through it eight at a time. When TMDB answers 429 it stops — correctly — and the rest of
-- the batch was never requested at all. Before this, those rows kept their spent attempt,
-- so three rate-limited invocations settled a film TMDB would have found as unmatched,
-- without a single request for it. Pre-existing, and made more reachable by a faster drain.
--
-- So the function hands back every claim it did not get an answer for through no fault of
-- the title: never dispatched, or refused with 429. The attempt is refunded and the lease
-- cleared, so the next invocation offers it again as if this one had not happened. A request
-- that was dispatched and failed any other way keeps its spent attempt, which is what bounds
-- a title that genuinely breaks the provider.
-- ---------------------------------------------------------------------------

create or replace function _import_provider_release(p_row_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer;
begin
  update import_rows
     set provider_attempts = greatest(provider_attempts - 1, 0),
         provider_claimed_at = null
   where id = any(coalesce(p_row_ids, '{}'))
     and status = 'needs_provider'
     and provider_claimed_at is not null;
  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

comment on function _import_provider_release(uuid[]) is
  'Hands leased provider rows back unasked: refunds the attempt their claim spent and clears the lease. For claims the Edge Function never dispatched or that TMDB refused with 429 -- a rate limit must not use up a title''s attempts. Only rows still waiting and still leased. service_role only.';

revoke execute on function _import_provider_release(uuid[]) from public, anon, authenticated;
grant execute on function _import_provider_release(uuid[]) to service_role;


-- A new signature, so the old one goes first. PostgREST resolves by argument name, so the
-- deployed Edge Function's two-argument call reaches this one through the default.
drop function if exists _import_provider_resolve(uuid, uuid);

create or replace function _import_provider_resolve(
  p_row_id uuid,
  p_media_item_id uuid,
  p_final boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job     uuid;
  v_uri     text;
  v_year    integer;
  v_user    uuid;
begin
  -- Only a row still waiting, of a job still running. An answer that arrives after its job
  -- settled has nothing to act on: the row was redacted and nothing will apply it, and
  -- writing `matched` onto it would only make a finished summary disagree with its rows.
  select r.job_id, r.raw->>'filmUri', (r.raw->>'year')::integer, j.user_id
    into v_job, v_uri, v_year, v_user
    from import_rows r
    join import_jobs j on j.id = r.job_id
   where r.id = p_row_id
     and r.status = 'needs_provider'
     and j.completed_at is null
     for update of r;

  if v_job is null then return; end if;

  if p_media_item_id is not null then
    update import_rows
       set media_item_id = p_media_item_id, status = 'matched', candidates = null,
           provider_claimed_at = null
     where id = p_row_id;

    -- The provider's match is a claim, never an assertion: the same bar and the same
    -- promotion path as 20260917000900. A film only, dated, and agreeing on the year.
    if v_uri is not null and v_year is not null then
      perform _import_promote_match(v_uri, p_media_item_id, v_user, 'provider')
        from media_items mi
       where mi.id = p_media_item_id
         and mi.release_date is not null
         and abs(extract(year from mi.release_date)::integer - v_year) <= 1;
    end if;

  else
    -- `p_final`: the provider answered with no results at all. Asking again would send the
    -- same query and get the same answer. (A non-empty answer that was not confident keeps the
    -- retry ladder; independent review 83a.) Without it, the old ladder: retryable until the
    -- third attempt, which is what a caller that cannot tell the two apart still gets.
    update import_rows
       set status = case when p_final or provider_attempts >= 3 then 'unmatched' else 'needs_provider' end,
           provider_claimed_at = null
     where id = p_row_id;
  end if;
end;
$$;

comment on function _import_provider_resolve(uuid, uuid, boolean) is
  'Records what the provider worker found for one leased row. A media item matches the row and records a provider claim (shared only once other accounts agree). Null with p_final settles the row unmatched at once -- the provider answered and had nothing confident; null without it keeps the row retryable until its third attempt. Clears the lease either way. Does nothing for a row no longer waiting or a job that has already ended. service_role only.';

revoke execute on function _import_provider_resolve(uuid, uuid, boolean) from public, anon, authenticated;
-- Explicit, as 20260917000600 made it for the old signature: the Edge Function calls this with
-- the service key, and a grant that only survived on default privileges is a silent outage.
grant execute on function _import_provider_resolve(uuid, uuid, boolean) to service_role;


-- ---------------------------------------------------------------------------
-- The tick
-- ---------------------------------------------------------------------------

create or replace function _drain_import_jobs(p_jobs integer default 8, p_slice integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due       integer;
  v_job       record;
  v_ids       uuid[];
  v_live      boolean[];
  v_moved     integer[];
  v_waiting   boolean[];
  v_failed    boolean[];
  v_status    text;
  v_slice     integer;
  v_passes    integer := 0;
  v_progress  boolean;
  v_posted    integer := 0;
  v_url       text;
  v_key       text;
  v_provider  boolean;
  v_grace     integer;
  v_budget    integer;
  v_started   timestamptz := clock_timestamp();
  i           integer;
begin
  select count(*) into v_due
    from import_jobs
   where completed_at is null and status in ('matching', 'applying');

  if v_due = 0 then
    return jsonb_build_object('status', 'idle', 'due', 0);
  end if;

  v_provider := _import_provider_configured();

  -- Both shape-tested before the cast and clamped, for the reason 20260917000300 gives: an
  -- operator typo in one config row must not raise here, outside every handler.
  v_grace := least(greatest(coalesce(
    (select case when value #>> '{}' ~ '^\d{1,5}$' then (value #>> '{}')::integer end
       from app_config where key = 'import.provider_grace_minutes'),
    30), 1), 1440);
  v_budget := least(greatest(coalesce(
    (select case when value #>> '{}' ~ '^\d{1,6}$' then (value #>> '{}')::integer end
       from app_config where key = 'import.tick_budget_ms'),
    2000), 100), 20000);

  -- ---------------------------------------------------------------------------
  -- Dead letter, unchanged: settle what only ever waited, fail what is exhausted.
  -- ---------------------------------------------------------------------------
  for v_job in
    select j.id from import_jobs j
     where j.completed_at is null
       and j.status <> 'pending'
       and (j.failures >= 3 or j.attempts >= 6 or j.created_at < now() - interval '24 hours')
       and not exists (
         select 1 from import_rows r
          where r.job_id = j.id
            and (r.status = 'pending'
                 or (r.status = 'matched' and r.media_item_id is not null)))
     order by j.created_at
     limit greatest(coalesce(p_jobs, 8), 1)
     for update skip locked
  loop
    begin
      perform _import_settle(v_job.id);
    exception when others then
      update import_jobs set last_error = left(sqlerrm, 300) where id = v_job.id;
    end;
  end loop;

  update import_jobs
     set status = 'failed', completed_at = now(), claimed_at = null,
         last_error = coalesce(last_error, 'exhausted')
   where completed_at is null
     and (failures >= 3 or attempts >= 6 or created_at < now() - interval '24 hours');

  -- ---------------------------------------------------------------------------
  -- Claim, under the same five-minute lease.
  -- ---------------------------------------------------------------------------
  with due as (
    select id, created_at from import_jobs
     where completed_at is null
       and status in ('matching', 'applying')
       and failures < 3 and attempts < 6
       and (claimed_at is null or claimed_at < now() - interval '5 minutes')
     order by created_at
     limit greatest(coalesce(p_jobs, 8), 1)
     for update skip locked
  ),
  claimed as (
    update import_jobs j
       set claimed_at = now(), attempts = j.attempts + 1
      from due
     where j.id = due.id
    returning j.id, due.created_at
  )
  select coalesce(array_agg(id order by created_at), '{}') into v_ids from claimed;

  if coalesce(array_length(v_ids, 1), 0) > 0 then
    v_live    := array_fill(true,  array[array_length(v_ids, 1)]);
    v_moved   := array_fill(0,     array[array_length(v_ids, 1)]);
    v_waiting := array_fill(false, array[array_length(v_ids, 1)]);
    v_failed  := array_fill(false, array[array_length(v_ids, 1)]);

    -- -------------------------------------------------------------------------
    -- ROUND-ROBIN SLICES UNTIL THE WORK OR THE BUDGET RUNS OUT
    --
    -- One slice per job per pass, so every claimed job moves before any job moves twice. A
    -- job leaves the rotation when it settles, when it has nothing it can do this tick, or
    -- when a slice raises. The budget is checked between passes, so a tick overruns it by
    -- at most one pass of bounded slices.
    -- -------------------------------------------------------------------------
    loop
      v_passes := v_passes + 1;
      v_progress := false;

      for i in 1 .. array_length(v_ids, 1) loop
        continue when not v_live[i];

        begin
          select status into v_status from import_jobs where id = v_ids[i];
          v_slice := 0;

          if v_status = 'matching' then
            v_slice := _import_match_batch(v_ids[i], p_slice);

            -- The phase advances on what is left, not on what the slice returned: a zero
            -- can mean another worker holds the rest.
            if not exists (select 1 from import_rows
                            where job_id = v_ids[i] and status = 'pending') then
              update import_jobs
                 set status = 'applying',
                     provider_touched_at = coalesce(provider_touched_at, now())
               where id = v_ids[i];
              -- Straight on to applying in the next pass.
              v_slice := greatest(v_slice, 1);
            elsif v_slice = 0 then
              v_live[i] := false;
            end if;

          elsif v_status = 'applying' then
            v_slice := _import_apply_batch(v_ids[i], p_slice);

            if v_slice = 0 then
              -- Nothing left this job can apply now. Either it is finished, or it is holding
              -- for the provider.
              v_live[i] := false;

              -- -------------------------------------------------------------------
              -- WAITING ON THE PROVIDER IS A WAIT, NOT A STALL
              --
              -- Two reasons to hold, and only two:
              --   a row the provider has in hand right now (leased), whatever its attempt
              --     -- its answer must not arrive at a finished job;
              --   a row the provider has not finished asking about, while the provider has
              --     done something for this job within the grace period.
              -- -------------------------------------------------------------------
              v_waiting[i] := v_provider and exists (
                select 1
                  from import_rows r
                  join import_jobs j on j.id = r.job_id
                 where r.job_id = v_ids[i]
                   and r.status = 'needs_provider'
                   and (
                     r.provider_claimed_at > now() - interval '2 minutes'
                     or (r.provider_attempts < 3
                         and coalesce(j.provider_touched_at, j.created_at)
                             >= now() - (v_grace || ' minutes')::interval)
                   ));

              if not v_waiting[i]
                 and not exists (select 1 from import_rows
                                  where job_id = v_ids[i]
                                    and (status = 'pending'
                                         or (status = 'matched' and media_item_id is not null)))
              then
                perform _import_settle(v_ids[i]);
              end if;
            end if;

          else
            v_live[i] := false;
          end if;

          v_moved[i] := v_moved[i] + v_slice;
          if v_slice > 0 then v_progress := true; end if;

        exception when others then
          v_live[i] := false;
          v_failed[i] := true;
          update import_jobs
             set failures = failures + 1, claimed_at = null,
                 last_error = left(sqlerrm, 300)
           where id = v_ids[i];
        end;
      end loop;

      exit when not v_progress
             or clock_timestamp() - v_started >= (v_budget || ' milliseconds')::interval;
    end loop;

    -- -------------------------------------------------------------------------
    -- Release the claims. A tick that moved rows, or held for the provider, is progress and
    -- clears both counters (20260917000300 §6); one that did neither leaves them standing.
    -- -------------------------------------------------------------------------
    for i in 1 .. array_length(v_ids, 1) loop
      continue when v_failed[i];
      if v_moved[i] > 0 or v_waiting[i] then
        update import_jobs
           set claimed_at = null, attempts = 0, failures = 0
         where id = v_ids[i] and completed_at is null;
      else
        update import_jobs
           set claimed_at = null
         where id = v_ids[i] and completed_at is null;
      end if;
    end loop;
  end if;

  -- ---------------------------------------------------------------------------
  -- The provider nudge: only for rows nobody has in hand, and **only while no invocation is**
  -- (independent review 83a). One invocation at a time is what bounds TMDB traffic to its
  -- own eight-wide concurrency; without it, a ten-second tick beside a slow invocation, or two
  -- drains at once, would each start another. A crashed invocation holds its leases for two
  -- minutes and the nudge waits that out, which is slower and never wrong.
  -- ---------------------------------------------------------------------------
  select count(*) into v_posted
    from import_rows r join import_jobs j on j.id = r.job_id
   where r.status = 'needs_provider'
     and r.provider_attempts < 3
     and (r.provider_claimed_at is null or r.provider_claimed_at < now() - interval '2 minutes')
     and j.completed_at is null;

  if v_posted > 0 and v_provider
     and not exists (select 1 from import_rows
                      where status = 'needs_provider'
                        and provider_claimed_at > now() - interval '2 minutes')
  then
    select value #>> '{}' into v_url from app_config where key = 'functions.base_url';
    begin
      select decrypted_secret into v_key
        from vault.decrypted_secrets where name = 'service_role_key';
    exception when others then
      v_key := null;
    end;

    -- Guarded, for the reason 20260917000300 gives: a missing or changed pg_net must not roll
    -- back the tick's work.
    if nullif(v_url, '') is not null and nullif(v_key, '') is not null
       and to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is not null
    then
      begin
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
      exception when others then
        null;
      end;
    end if;
  end if;

  return jsonb_build_object(
    'status', 'worked', 'due', v_due,
    'jobs', coalesce(array_length(v_ids, 1), 0),
    'passes', v_passes,
    'elapsed_ms', round(extract(epoch from clock_timestamp() - v_started) * 1000),
    'awaiting_provider', v_posted);
end;
$$;

comment on function _drain_import_jobs(integer, integer) is
  'One tick of the import worker: dead-letter what is exhausted, claim up to eight jobs under a five-minute lease, then work them round-robin a bounded slice at a time until the work is done or import.tick_budget_ms is spent; settle a job whose rows have all landed and which is not holding for a provider that is still working (a leased row, or unasked rows with provider activity inside the grace). Errors are recorded against the job rather than raised. Nudges the provider tier only for rows nobody has in hand. service_role only.';

revoke execute on function _drain_import_jobs(integer, integer) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Maintenance, once a minute
-- ---------------------------------------------------------------------------

create or replace function _import_prune_cron_history()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  if to_regclass('cron.job_run_details') is null or to_regclass('cron.job') is null then
    return 0;
  end if;
  -- These two jobs only. Other jobs' history is somebody else's to keep.
  execute $q$
    delete from cron.job_run_details d
     using cron.job j
     where j.jobid = d.jobid
       and j.jobname in ('bingd-import-drain', 'bingd-import-maintenance')
       and d.end_time < now() - interval '7 days'
  $q$;
  get diagnostics v_deleted = row_count;
  return v_deleted;
exception when others then
  -- Housekeeping. It must never be the reason the sweep or the poster nudge did not run.
  return 0;
end;
$$;

comment on function _import_prune_cron_history() is
  'Trims cron.job_run_details for the import drain and its maintenance job to seven days. A ten-second schedule writes 8,640 rows a day and nothing else trims them. Never raises. Internal.';

revoke execute on function _import_prune_cron_history() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- The installer, the off switch and the status call, for two jobs
-- ---------------------------------------------------------------------------

create or replace function schedule_import_drain(p_schedule text default '10 seconds')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobid   bigint;
  v_old     bigint;
  v_maint   bigint;
  v_used    text := p_schedule;
  v_note    text := null;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed on this database'
      using errcode = '55000',
            hint = 'Enable pg_cron and pg_net (Supabase dashboard, Database > Extensions), then call this again.';
  end if;

  -- Idempotent by name, for both jobs.
  for v_old in execute $q$
    select jobid from cron.job where jobname in ('bingd-import-drain', 'bingd-import-maintenance')
  $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_old;
  end loop;

  begin
    execute $q$ select cron.schedule('bingd-import-drain', $1, 'select public._drain_import_jobs()') $q$
      into v_jobid
      using p_schedule;
  exception when others then
    -- A pg_cron older than 1.5 cannot schedule in seconds. A drain once a minute is slower
    -- and still correct; no drain at all is neither.
    if p_schedule ~* 'second' then
      execute $q$ select cron.schedule('bingd-import-drain', '* * * * *', 'select public._drain_import_jobs()') $q$
        into v_jobid;
      v_used := '* * * * *';
      v_note := left('seconds schedule refused, fell back to one minute: ' || sqlerrm, 300);
    else
      raise;
    end if;
  end;

  execute $q$ select cron.schedule('bingd-import-maintenance', '* * * * *',
    'select public._import_sweep_abandoned(), public._import_enrich_nudge(), public._import_prune_cron_history()') $q$
    into v_maint;

  return jsonb_build_object('status', 'ok', 'jobid', v_jobid, 'schedule', v_used,
                            'maintenance_jobid', v_maint, 'note', v_note);
end;
$$;

comment on function schedule_import_drain(text) is
  'Installs (or replaces) the two pg_cron jobs behind the importer: bingd-import-drain (_drain_import_jobs, every ten seconds by default, falling back to once a minute where pg_cron cannot schedule in seconds) and bingd-import-maintenance (the abandoned-job sweep, the poster nudge and cron history pruning, once a minute). Idempotent by job name. service_role only.';

revoke execute on function schedule_import_drain(text) from public, anon, authenticated;
grant execute on function schedule_import_drain(text) to service_role;


create or replace function unschedule_import_drain()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[] := '{}';
  v_id  bigint;
begin
  if to_regclass('cron.job') is null then
    return jsonb_build_object('status', 'absent');
  end if;

  for v_id in execute $q$
    select jobid from cron.job where jobname in ('bingd-import-drain', 'bingd-import-maintenance')
  $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_id;
    v_ids := v_ids || v_id;
  end loop;

  if array_length(v_ids, 1) is null then
    return jsonb_build_object('status', 'absent');
  end if;
  return jsonb_build_object('status', 'ok', 'jobids', to_jsonb(v_ids));
end;
$$;

comment on function unschedule_import_drain() is
  'Stops the importer: both the drain and its maintenance job. Nothing is lost -- jobs stay where they are and resume when schedule_import_drain() is called again. Idempotent: nothing scheduled answers "absent". service_role only.';

revoke execute on function unschedule_import_drain() from public, anon, authenticated;
grant execute on function unschedule_import_drain() to service_role;


create or replace function import_drain_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job     jsonb := null;
  v_maint   jsonb := null;
  v_last    jsonb := null;
  v_open    bigint;
  v_stalled bigint;
  v_failed  bigint;
  v_leased  bigint;
begin
  select count(*) into v_open from import_jobs where completed_at is null;

  select count(*) into v_stalled
    from import_jobs
   where completed_at is null
     and created_at < now() - interval '15 minutes';

  select count(*) into v_failed
    from import_jobs
   where status = 'failed'
     and completed_at > now() - interval '24 hours';

  select count(*) into v_leased
    from import_rows
   where status = 'needs_provider'
     and provider_claimed_at > now() - interval '2 minutes';

  if to_regclass('cron.job') is not null then
    execute $q$
      select jsonb_build_object('jobid', jobid, 'schedule', schedule, 'active', active)
        from cron.job where jobname = 'bingd-import-drain'
    $q$ into v_job;
    execute $q$
      select jsonb_build_object('jobid', jobid, 'schedule', schedule, 'active', active)
        from cron.job where jobname = 'bingd-import-maintenance'
    $q$ into v_maint;

    if v_job is not null and to_regclass('cron.job_run_details') is not null then
      execute $q$
        select jsonb_build_object('status', status, 'ended', end_time, 'message', left(return_message, 200))
          from cron.job_run_details
         where jobid = ($1 ->> 'jobid')::bigint
         order by start_time desc limit 1
      $q$ into v_last using v_job;
    end if;
  end if;

  return jsonb_build_object(
    'environment',       environment_name(),
    'job',               v_job,
    'maintenance',       v_maint,
    'last_run',          v_last,
    'open',              v_open,
    -- With a working drain nothing under 2,500 films is open this long; see import-scale.mjs.
    'older_than_15m',    v_stalled,
    'failed_24h',        v_failed,
    'provider_in_flight', v_leased,
    'provider_ready',    _import_provider_configured()
  );
end;
$$;

comment on function import_drain_status() is
  'Whether the import drain and its maintenance job are scheduled, how the drain''s last run ended, how many jobs are open, stalled or failed, and how many provider lookups are in flight. A null "job" means no drain exists and no import can finish -- call schedule_import_drain(). Names nobody and returns no imported content. service_role only.';

revoke execute on function import_drain_status() from public, anon, authenticated;
grant execute on function import_drain_status() to service_role;


-- ---------------------------------------------------------------------------
-- Reschedule a drain that is already running, onto the new shape.
--
-- Only one that is running, for the reason 20260917001400 gives: an operator who stopped it
-- stopped it on purpose. The default one-minute schedule moves to ten seconds; a schedule
-- somebody chose deliberately is kept.
-- ---------------------------------------------------------------------------
do $bootstrap$
declare
  v_schedule text;
  v_result   jsonb;
begin
  if to_regclass('cron.job') is null then
    raise notice 'import drain: pg_cron is not installed; nothing rescheduled';
    return;
  end if;
  execute $q$ select schedule from cron.job where jobname = 'bingd-import-drain' $q$ into v_schedule;
  if v_schedule is null then
    raise notice 'import drain: not scheduled, so left unscheduled';
    return;
  end if;
  v_result := schedule_import_drain(case when v_schedule = '* * * * *' then '10 seconds' else v_schedule end);
  raise notice 'import drain: rescheduled %', v_result;
exception when others then
  raise notice 'import drain: could not reschedule (%); call schedule_import_drain() once the extensions are on', sqlerrm;
end;
$bootstrap$;
