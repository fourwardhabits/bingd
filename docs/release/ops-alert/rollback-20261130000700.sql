-- ROLLBACK of 20261130000700_an_alert_that_leaves_the_database. STAGING ONLY unless
-- separately approved.
--
-- Removes everything the migration added: the pg_cron job `bingd-ops-alert`, the functions
-- `_ops_alert_ping()`, `_ops_alert_ping(timestamptz)` and `_ops_alert_signal(timestamptz)`,
-- and the column `ops_alerts.signalled_at`. The rest of `ops_alerts` (every row),
-- `bingd-ops-health` and every other job are untouched: 20261130000500 keeps recording, as a
-- pull signal again.
--
-- It does not touch the Vault. Where the founder stored the key, remove it separately:
--   delete from vault.secrets where name = 'ops_alert_ping_key';
-- and, on the provider, pause or delete the two checks first, or the heartbeat check emails
-- that its pings stopped (docs/ops/operator-alerts-proposal.md, "Rollback").
--
-- Rehearsed in PGlite by supabase/tests/ops-alert.test.mjs.
--
-- One transaction, so a failure leaves the migration fully in place.
begin;

do $rollback$
declare
  v_id bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice 'ops alert rollback: pg_cron is not installed; no job to remove';
    return;
  end if;
  for v_id in execute $q$ select jobid from cron.job where jobname = 'bingd-ops-alert' $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_id;
  end loop;
end;
$rollback$;

drop function if exists _ops_alert_ping();
drop function if exists _ops_alert_ping(timestamptz);
drop function if exists _ops_alert_signal(timestamptz);
do $column$
begin
  if to_regclass('public.ops_alerts') is not null then
    alter table ops_alerts drop column if exists signalled_at;
  end if;
end;
$column$;

-- The migration's own record, where there is one (not in PGlite).
do $record$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute $q$ delete from supabase_migrations.schema_migrations where version = '20261130000700' $q$;
  end if;
end;
$record$;

commit;
