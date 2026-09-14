-- One call that answers "is the importer actually working", for the runbook.
--
-- The companion to `20260917000600`. That migration installed the cron job nobody had
-- installed; this is how anybody checks, afterwards and from then on, that it is still
-- there -- because the failure it guards against is silent by construction.
--
-- **The push lane has had `push_drain_status()` since `20260826000300`, and the release
-- docs are built around it** -- `docs/release/push-operations.md` reads its `job` field to
-- decide whether anything is draining at all, and `backup-and-recovery.md` lists it among
-- the things to check after a restore. The import lane shipped with the same architecture
-- and none of that, which is how a missing cron job survived into a branch that was
-- otherwise ready.
--
-- What makes this worth its own function rather than a note in a runbook: `cron.job` is not
-- reachable through PostgREST and the dashboard's SQL editor is a different pair of hands
-- from the release script. A `security definer` function granted to `service_role` is the
-- one way an operator, a bootstrap script and a smoke test can all ask the same question.
--
-- Names nobody and returns no imported content: counts, the job's schedule, and how its
-- last run ended. The same shape as its neighbour, for the same reason.

create or replace function import_drain_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job     jsonb := null;
  v_last    jsonb := null;
  v_open    bigint;
  v_stalled bigint;
  v_failed  bigint;
begin
  select count(*) into v_open from import_jobs where completed_at is null;

  -- **The symptom of the bug 20260917000600 fixed.** An open job older than fifteen minutes
  -- means rows arrived and nothing took them: either the cron job is absent, or the worker
  -- is erroring before it can even dead-letter. Either way somebody is sitting on "Matching
  -- your films" with no buttons on the screen, and this is the number that says so.
  select count(*) into v_stalled
    from import_jobs
   where completed_at is null
     and created_at < now() - interval '15 minutes';

  select count(*) into v_failed
    from import_jobs
   where status = 'failed'
     and completed_at > now() - interval '24 hours';

  if to_regclass('cron.job') is not null then
    execute $q$
      select jsonb_build_object('jobid', jobid, 'schedule', schedule, 'active', active)
        from cron.job where jobname = 'bingd-import-drain'
    $q$ into v_job;

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
    'environment',    environment_name(),
    -- `null` here is the whole point: it means no cron job exists, so no import can ever
    -- finish. Call schedule_import_drain().
    'job',            v_job,
    'last_run',       v_last,
    'open',           v_open,
    'older_than_15m', v_stalled,
    'failed_24h',     v_failed,
    'provider_ready', _import_provider_configured()
  );
end;
$$;

comment on function import_drain_status() is
  'Whether the import drain is scheduled, how its last run ended, how many jobs are open and how many have stalled. A null "job" means no cron job exists and no import can ever finish -- call schedule_import_drain(). The counterpart of push_drain_status(), and the check that would have caught 20260917000300 shipping without an installer. Names nobody and returns no imported content. service_role only.';

revoke execute on function import_drain_status() from public, anon, authenticated;
grant execute on function import_drain_status() to service_role;
