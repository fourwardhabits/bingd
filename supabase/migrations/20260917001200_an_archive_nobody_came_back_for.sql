-- An archive nobody came back for is still an archive.
--
-- Re-verification of retention across every terminal path, 2026-09-11. Three of the four
-- were already closed. This is the fourth.
--
-- ===========================================================================
-- THE PATH THAT WAS NOT COVERED
--
--   complete            `_import_settle` deletes applied and duplicate rows and redacts
--                       the rest down to name and year          (20260917000400)
--   duplicate           deleted by the same statement           (20260917000400)
--   failed / dead-letter  the completion trigger redacts whatever is left
--                                                               (20260917000600)
--   **abandoned**       nothing
--
-- A `pending` job is one the client is still staging. If the app is closed half way -- or
-- the upload drops and the person never returns -- the job stays `pending` with its rows
-- intact: film URIs, ratings, buckets, watch dates and every diary URI.
--
-- Three things were expected to catch that, and none of them does:
--
--   · `import_create` deletes an abandoned `pending` job, but only when the same person
--     starts another import. Somebody who tried once and gave up never triggers it.
--   · `import_discard` is the Start over button, which by definition was not pressed.
--   · the dead letter inside `_drain_import_jobs` does sweep any open job older than
--     twenty-four hours -- **but the tick returns before it.** `v_due` counts only jobs
--     that are `matching` or `applying`, and returns `idle` when there are none. So on a
--     quiet database, which is every database most of the time, an abandoned `pending` job
--     is never looked at again.
--
-- Contract V3 §14 says the export source is not retained indefinitely, and "for ever, on a
-- job nobody finished" is the definition of indefinitely. It is also the worst of the four
-- to get wrong: the person did not complete an import, may well have changed their mind
-- about sending us their diary at all, and is the least likely of anyone to come back and
-- clear it.
--
-- ===========================================================================
-- A SEPARATE SWEEP RATHER THAN A CHANGE TO THE TICK
--
-- The one-line fix is to widen `v_due`. That means re-emitting two hundred lines of worker
-- to change one, which is four lines of fix and a hundred and ninety-six of transcription
-- risk -- the same trade refused twice already in this tranche.
--
-- So the sweep is its own function and the cron job runs both. `schedule_import_drain` is
-- thirty lines and is re-emitted here instead.
--
-- **Marked failed rather than deleted**, so it travels the same road as every other
-- terminal job: the completion trigger redacts it, `import_jobs_one_live` is freed, and
-- there is one rule about what a finished job keeps rather than two.
-- ===========================================================================

insert into app_config (key, value) values ('import.abandoned_hours', '24'::jsonb)
  on conflict (key) do nothing;


create or replace function _import_sweep_abandoned()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hours integer;
  v_swept integer;
begin
  -- Shape-tested and clamped, like every other config read on this path. The floor of one
  -- hour is not arbitrary: `import_create` adopts a `pending` job for an hour, so a shorter
  -- window could retire a job a client is still legitimately staging onto.
  v_hours := least(greatest(coalesce(
    (select case when value #>> '{}' ~ '^\d{1,5}$' then (value #>> '{}')::integer end
       from app_config where key = 'import.abandoned_hours'),
    24), 1), 720);

  update import_jobs
     set status = 'failed',
         completed_at = now(),
         claimed_at = null,
         last_error = coalesce(last_error, 'abandoned')
   where completed_at is null
     and status = 'pending'
     and created_at < now() - make_interval(hours => v_hours);

  get diagnostics v_swept = row_count;
  return v_swept;
end;
$$;

comment on function _import_sweep_abandoned() is
  'Retires half-staged imports nobody came back to finish. A pending job holds the whole projected archive -- film URIs, ratings, buckets, watch dates, diary URIs -- and three things were expected to clear it: import_create (only if the same person imports again), import_discard (the button they did not press) and the worker''s dead letter (unreachable, because the tick returns idle unless something is matching or applying). Marked failed rather than deleted so the completion trigger redacts it down to name and year like every other terminal job, and so import_jobs_one_live is freed. Window is app_config import.abandoned_hours, default 24, floored at 1 because import_create adopts a pending job for an hour. Internal.';

revoke execute on function _import_sweep_abandoned() from public, anon, authenticated;
grant execute on function _import_sweep_abandoned() to service_role;


-- ---------------------------------------------------------------------------
-- The tick runs both
--
-- One statement rather than two, so the cron job stays a single command and either both
-- run or neither does. Re-emitted from `20260917000300` with only the command changed.
-- ---------------------------------------------------------------------------

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

  execute $q$ select cron.schedule('bingd-import-drain', $1,
    'select public._drain_import_jobs(), public._import_sweep_abandoned()') $q$
    into v_jobid
    using p_schedule;

  return jsonb_build_object('status', 'ok', 'jobid', v_jobid, 'schedule', p_schedule);
end;
$$;

comment on function schedule_import_drain(text) is
  'Installs (or replaces) the pg_cron job that drains import_jobs and sweeps abandoned ones. Idempotent by job name, for the reason schedule_push_drain is: two jobs with the same name is two workers a minute for ever. Both functions run in one statement so the job stays a single command. service_role only.';

revoke execute on function schedule_import_drain(text) from public, anon, authenticated;
grant execute on function schedule_import_drain(text) to service_role;


-- Re-install, so an existing schedule picks up the sweep rather than waiting for somebody
-- to think of it. Best-effort, exactly as `20260917000600`: the harness has no pg_cron and
-- a raise here would cost the suite.
do $bootstrap$
begin
  perform schedule_import_drain();
  raise notice 'import drain: rescheduled with the abandoned sweep';
exception when others then
  raise notice 'import drain: could not reschedule (%); call schedule_import_drain() once the extensions are on', sqlerrm;
end;
$bootstrap$;
