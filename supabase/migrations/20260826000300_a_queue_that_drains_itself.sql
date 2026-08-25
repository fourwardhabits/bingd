-- ---------------------------------------------------------------------------
-- A queue that drains itself
--
-- WHAT WAS ACTUALLY WRONG
--
-- `20260825000300` and `docs/architecture/push.md` both say it plainly: *nothing drains
-- `push_outbox` on a timer.* The only thing that invokes `push-sender` is a client, from
-- `src/features/notifications/push.ts`, nudging after it caused something.
--
-- For a friend beta that is defensible — the person who caused the notification is holding
-- a phone. For a public launch it is not, and the failure is quiet in the way that matters:
-- **the notification arrives in the app and the phone never buzzes.** Nobody reports it,
-- because nobody knows a push was due. The two cases are ordinary rather than exotic:
--
--   · the actor's app is killed by the OS between the write and the nudge — the nudge is a
--     `fetch` after a round trip, not part of the transaction;
--   · a notification with no client behind it at all. `invite_welcome` is written when a
--     token is redeemed, and `settle_push_batch` putting a row back to `pending` is a retry
--     nobody is holding a phone for.
--
-- Without a server-owned drain the retry path in `20260826000200` is decorative: a row goes
-- back to `pending` and waits for somebody, somewhere, to happen to cause another
-- notification.
--
-- ---------------------------------------------------------------------------
-- THE MECHANISM, AND WHY IT IS THIS ONE
--
-- `pg_cron` + `pg_net`, both first-party Supabase extensions, calling the Edge Function
-- that already exists. That is the whole design and it deliberately adds no component:
--
--   · **not a queue platform.** The outbox is the queue and it already claims atomically.
--   · **not a second Edge Function.** `push-sender` takes no input, so the scheduler has
--     nothing to say to it beyond "there may be work".
--   · **not client polling.** That is what is being replaced.
--
-- Once a minute. Delivery is not real-time by construction — the lease is five minutes and
-- the retry is a drain later — so a minute of latency on the tail case costs nothing and
-- keeps the invocation count at a number worth reading in a log.
--
-- ---------------------------------------------------------------------------
-- SECURITY
--
--   · **The service-role key is not in this file, in any migration, or in any config
--     table.** It lives in Supabase Vault and is read by one `security definer` function
--     that no client role may execute. A key in a migration is a key in the repository and
--     in every clone of it.
--   · **The function base URL is not a secret** and is deliberately not in the Vault. It is
--     `app_config['functions.base_url']`, which is not a `public.%` key, so the read policy
--     keeps it away from clients anyway. Putting a non-secret in a secret store makes the
--     secret store's contents stop meaning anything.
--   · **`_drain_push_outbox` is revoked from `anon` and `authenticated`.** A client that
--     could call it would be a client that could make the database post a service-role
--     credential somewhere, which is a far stronger primitive than nudging the sender.
--   · **Overlapping runs are safe** without a lock. `net.http_post` is asynchronous — it
--     queues and returns — and `claim_push_batch` is `for update skip locked` with a lease,
--     so two senders running at once claim disjoint work. That property is the outbox's,
--     not the scheduler's, and it is why the scheduler needs no state.
--   · **The tick does nothing when the queue is empty.** One index-free existence check
--     against a table that is empty almost always, rather than 1,440 Edge Function
--     invocations a day to be told there is nothing to do.
--
-- ---------------------------------------------------------------------------
-- WHY THE SCHEDULING IS A FUNCTION AND NOT JUST A MIGRATION STATEMENT
--
-- The local suite replays every migration in PGlite, which has no `pg_cron`, no `pg_net`
-- and no `vault`. A migration that installs them fails the entire suite, and one that fails
-- silently everywhere teaches nobody anything.
--
-- So the effect is split. This file *defines* the drain and the two operator verbs
-- unconditionally — plain plpgsql, which parses its body lazily, so a function that
-- mentions `net.http_post` creates cleanly on a database that has never heard of it. It
-- then *attempts* the install and the schedule in a guarded block that degrades to a notice.
-- `schedule_push_drain()` is what the bootstrap script calls afterwards, on a real project,
-- once the extensions are on — and it is the same call the founder makes by hand if the
-- extensions were enabled from the dashboard later.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Where the function lives
--
-- Set by `scripts/bootstrap-production.mjs`, or by hand. Not `public.%`, so `app_config`'s
-- read policy already keeps it off every client.
-- ---------------------------------------------------------------------------

comment on table app_config is
  'Operator configuration. Only keys matching public.% are readable by clients (see the app_config_read policy); everything else -- env.name, functions.base_url -- is operator-side.';

-- ---------------------------------------------------------------------------
-- 2. The tick
--
-- `security definer` and owned by the migration role, because it reads the Vault. Nothing
-- it returns says anything about anybody: a count of due rows, and whether a request was
-- posted.
-- ---------------------------------------------------------------------------

create or replace function _drain_push_outbox()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due bigint;
  v_url text;
  v_key text;
begin
  -- Cheap, and it is the difference between a scheduler that costs an Edge Function
  -- invocation a minute for ever and one that costs nothing while nothing is happening.
  select count(*) into v_due from push_outbox;
  if v_due = 0 then
    return jsonb_build_object('status', 'idle', 'due', 0);
  end if;

  select value #>> '{}' into v_url from app_config where key = 'functions.base_url';

  begin
    select decrypted_secret into v_key
      from vault.decrypted_secrets
     where name = 'service_role_key';
  exception when others then
    -- No Vault on this database at all. Distinguished from "the secret is missing" only in
    -- the message, because the operator action is the same and the difference is not this
    -- function's to explain.
    v_key := null;
  end;

  if v_url is null or v_key is null then
    raise warning
      'push drain: not configured (functions.base_url %, vault secret service_role_key %). % rows waiting.',
      case when v_url is null then 'missing' else 'set' end,
      case when v_key is null then 'missing' else 'set' end,
      v_due;
    return jsonb_build_object('status', 'unconfigured', 'due', v_due);
  end if;

  -- Asynchronous: pg_net queues the request and a background worker sends it, so a slow or
  -- dead Edge Function cannot hold a cron slot open. The reply is discarded -- the sender's
  -- own logs are the record, and its body is deliberately uninformative to anybody but
  -- service_role.
  perform net.http_post(
    url     := v_url || '/push-sender',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_key,
                 'apikey',        v_key
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000
  );

  return jsonb_build_object('status', 'posted', 'due', v_due);
end;
$$;

comment on function _drain_push_outbox() is
  'One scheduler tick: if push_outbox has anything in it, asks push-sender to drain it. Reads the service-role key from Supabase Vault and the function URL from app_config, so neither is in this schema or in the repository. Does nothing when the queue is empty. Internal -- a client that could call this could make the database post a service-role credential.';

-- ---------------------------------------------------------------------------
-- 3. The two operator verbs
--
-- Dynamic SQL throughout, because `cron.job` does not exist on the harness and a static
-- reference to it would fail at CREATE time for `schedule_push_drain` even though nothing
-- would ever call it there.
-- ---------------------------------------------------------------------------

create or replace function schedule_push_drain(p_schedule text default '* * * * *')
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

  -- `cron.schedule` upserts on the job name in pg_cron 1.4+, but an older one duplicates,
  -- and a duplicated minute job is two nudges a minute for ever. Named, checked, replaced.
  execute $q$ select jobid from cron.job where jobname = 'bingd-push-drain' $q$ into v_jobid;
  if v_jobid is not null then
    execute $q$ select cron.unschedule($1) $q$ using v_jobid;
  end if;

  execute $q$ select cron.schedule('bingd-push-drain', $1, 'select public._drain_push_outbox()') $q$
    into v_jobid
    using p_schedule;

  return jsonb_build_object('status', 'ok', 'jobid', v_jobid, 'schedule', p_schedule);
end;
$$;

comment on function schedule_push_drain(text) is
  'Installs (or replaces) the once-a-minute pg_cron job that drains push_outbox. Idempotent by job name, because two jobs called the same thing is two nudges a minute for ever. Called by scripts/bootstrap-production.mjs after a replay. service_role only.';

create or replace function unschedule_push_drain()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobid bigint;
begin
  if to_regclass('cron.job') is null then
    return jsonb_build_object('status', 'absent');
  end if;

  execute $q$ select jobid from cron.job where jobname = 'bingd-push-drain' $q$ into v_jobid;
  if v_jobid is null then
    return jsonb_build_object('status', 'absent');
  end if;

  execute $q$ select cron.unschedule($1) $q$ using v_jobid;
  return jsonb_build_object('status', 'ok', 'jobid', v_jobid);
end;
$$;

comment on function unschedule_push_drain() is
  'Stops the push drain. The rollback half of schedule_push_drain, and the first thing to reach for if the sender is misbehaving -- notifications keep arriving in-app, only the phone stops buzzing. service_role only.';

-- ---------------------------------------------------------------------------
-- 4. Is it actually running?
--
-- The question a runbook asks, answerable without the dashboard. Names no person and
-- returns no push content: a job row, a schedule, and how the last run ended.
-- ---------------------------------------------------------------------------

create or replace function push_drain_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job     jsonb := null;
  v_last    jsonb := null;
  v_queued  bigint;
  v_stalled bigint;
begin
  select count(*) into v_queued from push_outbox;
  select count(*) into v_stalled
    from push_outbox
   where created_at < now() - interval '15 minutes';

  if to_regclass('cron.job') is not null then
    execute $q$
      select jsonb_build_object('jobid', jobid, 'schedule', schedule, 'active', active)
        from cron.job where jobname = 'bingd-push-drain'
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
    'environment',   environment_name(),
    'job',           v_job,
    'last_run',      v_last,
    'queued',        v_queued,
    -- Non-zero here for more than a drain interval is the symptom: rows arriving and
    -- nothing taking them. It is the number the runbook alerts on.
    'older_than_15m', v_stalled,
    'base_url_set',  (select count(*) > 0 from app_config where key = 'functions.base_url')
  );
end;
$$;

comment on function push_drain_status() is
  'Whether the push drain is scheduled, how its last run ended, and how much is waiting. The one call a runbook needs; names nobody and returns no push content. service_role only.';

-- ---------------------------------------------------------------------------
-- 5. Privileges
-- ---------------------------------------------------------------------------

revoke execute on function _drain_push_outbox()          from public, anon, authenticated;
revoke execute on function schedule_push_drain(text)     from public, anon, authenticated;
revoke execute on function unschedule_push_drain()       from public, anon, authenticated;
revoke execute on function push_drain_status()           from public, anon, authenticated;

grant execute on function schedule_push_drain(text) to service_role;
grant execute on function unschedule_push_drain()   to service_role;
grant execute on function push_drain_status()       to service_role;
-- `_drain_push_outbox` is granted to nobody. pg_cron runs it as the job owner, which is the
-- role that ran this migration, and that role owns the function.

-- ---------------------------------------------------------------------------
-- 6. Best-effort install, for a database that can take it
--
-- Everything above exists on any Postgres. This block is the part that only works on
-- Supabase, and it is written to *notice* rather than to fail: the harness has none of
-- these extensions and the bootstrap script re-runs `schedule_push_drain()` explicitly, so
-- a notice here costs nothing and a raised exception would cost the entire test suite.
-- ---------------------------------------------------------------------------

do $bootstrap$
begin
  begin
    execute 'create extension if not exists pg_net';
  exception when others then
    raise notice 'push drain: pg_net unavailable (%), scheduler not installed', sqlerrm;
    return;
  end;

  begin
    execute 'create extension if not exists pg_cron';
  exception when others then
    raise notice 'push drain: pg_cron unavailable (%), scheduler not installed', sqlerrm;
    return;
  end;

  begin
    perform schedule_push_drain();
    raise notice 'push drain: scheduled every minute';
  exception when others then
    raise notice 'push drain: could not schedule (%); call schedule_push_drain() once the extensions are on', sqlerrm;
  end;
end;
$bootstrap$;
