-- A welcome that does not wait for GitHub (2026-11-20).
--
-- WHAT WAS ACTUALLY WRONG
--
-- `.github/workflows/welcome-email.yml` sends the welcome note, and its only automatic
-- trigger is a GitHub `schedule:`. GitHub starts this repository's scheduled runs every five
-- to ten hours at best. The single ':23' entry ran about three times a day from 2026-10-24 to
-- 11-19, and after six offsets an hour merged (about 02:55Z on 11-20) not one scheduled run
-- started before 04:00Z. Every run that does start succeeds. The note is meant to land about
-- 48 hours after signup, inside a window that closes at 168, so the weak link is a trigger
-- that fires when GitHub gets round to it, not the worker.
--
-- THE MECHANISM, AND WHY IT IS THIS ONE
--
-- Production Postgres already has a scheduler that runs on time (`bingd-push-drain` every
-- minute, `bingd-import-drain` every ten seconds) and a transport (`pg_net`). So once an hour
-- pg_cron asks GitHub, through the documented `workflow_dispatch` API, to run the same
-- workflow with `target=production, mode=send`, which is exactly what a scheduled run does.
-- GitHub starts a dispatched run straight away. It is only `schedule:` that it drops.
--
--   * Nothing about the send moves. The worker, the template and every guarantee stay in the
--     Action and in `20260923000100`. A dispatch only says "run main's workflow now".
--   * Extra runs are safe. The claim is a primary-key insert, so a run claims only accounts no
--     run has claimed, and the workflow's concurrency group queues production runs rather than
--     overlapping them. A dispatch and a scheduled run in the same hour send nobody twice.
--   * The GitHub `schedule:` stays, as the backup. Either trigger alone is enough.
--
-- THE GATES, IN THE ORDER THE FUNCTION CHECKS THEM
--
--   1. `environment_name()` is `prod`. Staging and every other project call themselves
--      `nonprod` (20260826000100: set once, on an empty database, and refused afterwards), and
--      a nonprod database returns here without reading the Vault at all. This gate does not
--      depend on anybody remembering where a secret was stored.
--   2. `welcome.delivery_enabled` is true in this project's `app_config`. That is the welcome
--      email's own emergency stop, so turning the email off also stops the hourly Actions runs
--      this would start.
--   3. Vault holds a non-empty `welcome_dispatch_github_token`: a fine-grained GitHub token
--      for this one repository, Actions read and write, with an expiry, stored by the founder
--      in production only. **It must never be stored on staging.** Gate 1 makes that harmless,
--      but the token starts the production send and belongs in exactly one database.
--
-- A missing gate returns a status and makes no request. pg_cron records that as `succeeded`,
-- which is honest here: an unconfigured dispatcher is not a broken email, because the GitHub
-- schedule still runs. The one failure that raises is a dispatcher that is fully configured
-- but has no `pg_net` to post with, so that case shows in `cron.job_run_details`.
--
-- SECURITY
--
--   * No parameters. It can only ever ask for production/send of `welcome-email.yml` on
--     `main`, because the URL, the ref and the inputs are literals. A canary is never
--     dispatched: the `canary` input is omitted, and it defaults to false.
--   * The token is read from Vault inside one `security definer` function that only its owner
--     may execute, and pg_cron runs it as that owner. Not `service_role` either: that key lives
--     in GitHub Actions secrets and has no reason to start Actions runs.
--   * The token goes into the Authorization header and nowhere else. No `raise`, return value
--     or notice contains it.
--   * The token can do nothing to this database. The worst a stolen one can do is run this
--     public repository's workflows, which is why it is scoped to one repository, Actions
--     only, with an expiry.
--
-- WHY THE FUNCTION IS CREATED INSIDE A `do` BLOCK
--
-- As in `20260923000100`: the Supabase CLI applies statements outside a transaction, and a new
-- function is executable by PUBLIC (and, on Supabase, by anon and authenticated through the
-- schema's default privileges) until its `revoke` runs. Inside one block nobody can call it
-- before the revoke. The schedule is a second block, guarded like the existing jobs: skipped
-- where pg_cron is absent (PGlite, a fresh database), idempotent by job name elsewhere.
--
-- Operator notes: emails/welcome/automation/README.md, "What starts a run".
-- Stop the email and the dispatches:
--   update app_config set value = 'false'::jsonb where key = 'welcome.delivery_enabled';
-- Stop only the dispatches:
--   select cron.unschedule('bingd-welcome-dispatch');
-- Rollback: docs/release/welcome-dispatch/rollback-20261130000300.sql.

do $install$
begin

create or replace function _dispatch_welcome_email()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_token   text;
  v_request bigint;
begin
  -- 1. Production only. Checked before the Vault is read, so a token stored on the wrong
  -- project by mistake is never even loaded there.
  if environment_name() is distinct from 'prod' then
    return jsonb_build_object('status', 'not_production');
  end if;

  -- 2. The welcome email's emergency stop, read the way the claim reads it.
  if not coalesce(
       (select c.value from app_config c where c.key = 'welcome.delivery_enabled') = 'true'::jsonb,
       false) then
    return jsonb_build_object('status', 'disabled');
  end if;

  -- 3. The token. No Vault at all reads as no token. Whitespace around a pasted token is
  -- trimmed, because a trailing newline is the usual paste error and GitHub would refuse it.
  begin
    select btrim(s.decrypted_secret, E' \t\r\n') into v_token
      from vault.decrypted_secrets s
     where s.name = 'welcome_dispatch_github_token'
     limit 1;
  exception when others then
    v_token := null;
  end;

  if nullif(v_token, '') is null then
    return jsonb_build_object('status', 'unconfigured');
  end if;

  -- Everything is in place except, possibly, the transport. That is a real failure, so it
  -- raises and pg_cron records it. The message names what is missing, never the token.
  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    raise exception 'welcome dispatch: pg_net is not available; the token is set and nothing can be posted'
      using errcode = '55000',
            hint = 'Enable pg_net (Supabase dashboard, Database > Extensions).';
  end if;

  -- Asynchronous: pg_net queues the request and its worker sends it, so a slow GitHub cannot
  -- hold a cron slot. GitHub answers 204 with no body; the answer lands in
  -- net._http_response under the returned id.
  select net.http_post(
    url     := 'https://api.github.com/repos/fourwardhabits/bingd/actions/workflows/welcome-email.yml/dispatches',
    body    := '{"ref":"main","inputs":{"target":"production","mode":"send"}}'::jsonb,
    headers := jsonb_build_object(
                 'Authorization',        'Bearer ' || v_token,
                 'Accept',               'application/vnd.github+json',
                 'X-GitHub-Api-Version', '2022-11-28',
                 'User-Agent',           'bingd-welcome-dispatch',
                 'Content-Type',         'application/json'
               ),
    timeout_milliseconds := 10000
  ) into v_request;

  return jsonb_build_object('status', 'posted', 'request_id', v_request);
end;
$fn$;

comment on function _dispatch_welcome_email() is
  'One hourly tick (pg_cron job bingd-welcome-dispatch). On a prod database with welcome.delivery_enabled true and the Vault secret welcome_dispatch_github_token set, asks GitHub to run .github/workflows/welcome-email.yml on main with target=production, mode=send. Returns not_production, disabled, unconfigured or posted (with the pg_net request id), and raises only when it is configured and pg_net is missing. Takes no input and never returns or logs the token. Owner only.';

revoke all on function _dispatch_welcome_email() from public, anon, authenticated, service_role;

end;
$install$;

-- ---------------------------------------------------------------------------
-- The schedule
--
-- Hourly at :41, away from the hour and from `bingd-release-refresh` at :07. Replaced by name,
-- so re-applying this file leaves exactly one job. Skipped, with a notice, where pg_cron is
-- not installed. Where it is installed, a failure to schedule raises: a migration that reports
-- success without the job would leave the primary trigger missing with nothing to say so.
-- ---------------------------------------------------------------------------

do $schedule$
declare
  v_old bigint;
  v_id  bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice 'welcome dispatch: pg_cron is not installed; bingd-welcome-dispatch not scheduled';
    return;
  end if;

  for v_old in execute $q$ select jobid from cron.job where jobname = 'bingd-welcome-dispatch' $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_old;
  end loop;

  execute $q$ select cron.schedule('bingd-welcome-dispatch', '41 * * * *',
    'select public._dispatch_welcome_email()') $q$ into v_id;

  raise notice 'welcome dispatch: bingd-welcome-dispatch scheduled as job %', v_id;
end;
$schedule$;
