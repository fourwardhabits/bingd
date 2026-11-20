-- ROLLBACK of 20261130000500_a_job_that_says_when_another_is_broken. STAGING ONLY unless
-- separately approved.
--
-- Removes everything the migration added: the pg_cron job `bingd-ops-health`, the functions
-- `ops_job_health()`, `ops_health_tick()`, `ops_health_tick(timestamptz)`,
-- `_ops_observe(timestamptz)` and `_ops_expected_jobs()`, the table `ops_alerts`, and the
-- `app_config` key `ops.alert_muted_checks`. Nothing else changed, so nothing else is
-- restored, and no other job is touched.
--
-- **This drops the alert history in `ops_alerts`.** To keep it, export it first:
--   select * from ops_alerts order by id;
-- To stop alerting without losing anything, unschedule instead (background-jobs.md §2g):
--   select cron.unschedule('bingd-ops-health');
--
-- Rehearsed in PGlite by supabase/tests/ops-health.test.mjs.
--
-- One transaction, so a failure leaves the migration fully in place.
begin;

do $rollback$
declare
  v_id bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice 'ops health rollback: pg_cron is not installed; no job to remove';
    return;
  end if;
  for v_id in execute $q$ select jobid from cron.job where jobname = 'bingd-ops-health' $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_id;
  end loop;
end;
$rollback$;

drop function if exists ops_health_tick();
drop function if exists ops_health_tick(timestamptz);
drop function if exists ops_job_health();
drop function if exists _ops_observe(timestamptz);
drop function if exists _ops_expected_jobs();
drop table if exists ops_alerts;
delete from app_config where key = 'ops.alert_muted_checks';

-- The migration's own record, where there is one (not in PGlite).
do $record$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute $q$ delete from supabase_migrations.schema_migrations where version = '20261130000500' $q$;
  end if;
end;
$record$;

commit;
