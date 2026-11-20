-- Rollback for 20261130000400_a_history_pruned_once_an_hour, captured from PRODUCTION before apply (2026-11-20).
-- Restores the two zero-argument prune functions exactly as they were, then drops the one-argument forms
-- and the migration record. No schedule changes in either direction.
begin;
CREATE OR REPLACE FUNCTION public._import_prune_cron_history()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public._release_prune_cron_history()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_deleted integer := 0;
begin
  if to_regclass('cron.job_run_details') is null or to_regclass('cron.job') is null then
    return 0;
  end if;
  execute $q$
    delete from cron.job_run_details d
     using cron.job j
     where j.jobid = d.jobid
       and j.jobname in ('bingd-release-refresh', 'bingd-release-evaluate')
       and d.end_time < now() - interval '14 days'
  $q$;
  get diagnostics v_deleted = row_count;
  return v_deleted;
exception when others then
  return 0;
end;
$function$;

drop function if exists public._import_prune_cron_history(timestamptz);
drop function if exists public._release_prune_cron_history(timestamptz);
delete from supabase_migrations.schema_migrations where version = '20261130000400';
commit;
