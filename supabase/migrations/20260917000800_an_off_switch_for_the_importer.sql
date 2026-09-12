-- The off switch the import drain shipped without.
--
-- Second pass of the independent review, 2026-09-11. `20260917000600` gave the importer a
-- way to be started; this gives it a way to be stopped.
--
-- ===========================================================================
-- WHY A ROLLBACK HALF IS NOT OPTIONAL HERE
--
-- The push lane ships both halves and always has: `schedule_push_drain()` and
-- `unschedule_push_drain()` (`20260826000300`), the second granted to `service_role` and
-- named in `docs/release/backup-and-recovery.md` as **the first thing to reach for** if the
-- sender misbehaves. The import lane shipped the installer alone, so the only way to stop a
-- drain that was doing damage was a raw `cron.unschedule` as a superuser, from the
-- dashboard, by somebody who knew the job's name.
--
-- This repo has paid for a missing switch before: `push.delivery_enabled` existed as a row
-- nothing read, which meant the answer to "stop sending" was a deploy. The lesson taken then
-- was that an operator needs a lever that works at three in the morning without a release,
-- and it applies here for a sharper reason -- the import worker spends provider requests and
-- writes `letterboxd_matches`, which is shared across every account. A drain misbehaving is
-- not only slow, it is expensive and it is contagious.
--
-- **What stopping does and does not do.** Nothing is lost and nothing is rolled back: jobs
-- stay exactly where they are, `pending` or `matching` or `applying`, and resume when
-- `schedule_import_drain()` is called again. What it costs is that anybody mid-import sits
-- on "Matching your films" until then -- which is the same thing an absent job costs, and is
-- why `import_drain_status()` reports a null job as the headline.
--
-- The 24-hour dead letter also stops, because it lives inside `_drain_import_jobs`. So a
-- drain left off for a day leaves jobs that will settle as `failed` shortly after it is
-- turned back on, rather than while it is off.
-- ===========================================================================

create or replace function unschedule_import_drain()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobid bigint;
begin
  -- Absent is a success, not an error. An operator reaching for this in a hurry must not
  -- have to care whether somebody already pulled it, and a runbook step that fails when it
  -- is already satisfied is a step people learn to skip.
  if to_regclass('cron.job') is null then
    return jsonb_build_object('status', 'absent');
  end if;

  execute $q$ select jobid from cron.job where jobname = 'bingd-import-drain' $q$ into v_jobid;
  if v_jobid is null then
    return jsonb_build_object('status', 'absent');
  end if;

  execute $q$ select cron.unschedule($1) $q$ using v_jobid;
  return jsonb_build_object('status', 'ok', 'jobid', v_jobid);
end;
$$;

comment on function unschedule_import_drain() is
  'Stops the import drain. The rollback half of schedule_import_drain, and the first thing to reach for if the importer is misbehaving -- it spends provider requests and writes the cross-account letterboxd_matches cache, so a bad drain is expensive and contagious rather than merely slow. Nothing is lost: jobs stay where they are and resume when it is scheduled again, though anybody mid-import waits on "Matching your films" until then. Idempotent -- a job that is already gone answers "absent". service_role only.';

revoke execute on function unschedule_import_drain() from public, anon, authenticated;
grant execute on function unschedule_import_drain() to service_role;
