-- ROLLBACK of 20261201000200_a_welcome_that_does_not_wait_for_github. STAGING ONLY unless
-- separately approved.
--
-- Removes what the migration added: the pg_cron job `bingd-welcome-dispatch` and the function
-- `_dispatch_welcome_email()`. Nothing else changed, so nothing else is restored.
--
-- What comes back: the welcome email is started only by the GitHub `schedule:` in
-- .github/workflows/welcome-email.yml again, which GitHub runs every five to ten hours. The
-- worker, the ledger and every send already made are untouched.
--
-- Not removed: the Vault secret `welcome_dispatch_github_token`, if one was stored. Without the
-- function nothing reads it. Delete it separately, and revoke the token on GitHub, if the
-- dispatcher is not coming back:
--   delete from vault.secrets where name = 'welcome_dispatch_github_token';
--
-- Rehearsed in PGlite by supabase/tests/welcome-dispatch.test.mjs.
--
-- One transaction, so a failure leaves the migration fully in place.
begin;

do $rollback$
declare
  v_id bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice 'welcome dispatch rollback: pg_cron is not installed; no job to remove';
    return;
  end if;
  for v_id in execute $q$ select jobid from cron.job where jobname = 'bingd-welcome-dispatch' $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_id;
  end loop;
end;
$rollback$;

drop function if exists _dispatch_welcome_email();

-- The migration's own record, where there is one (not in PGlite).
do $record$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute $q$ delete from supabase_migrations.schema_migrations where version = '20261201000200' $q$;
  end if;
end;
$record$;

commit;
