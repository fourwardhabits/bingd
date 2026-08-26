-- ---------------------------------------------------------------------------
-- A drain that says when it is broken
--
-- WHAT ACTUALLY HAPPENED, MEASURED ON 2026-08-26
--
-- `bingd-push-drain` (job #2) ran **1,221 times, every one of them `succeeded`**, over
-- twenty hours, and in that entire window `net._http_response` was **empty**. Not one
-- HTTP request had ever left this database. `push_drain_status()` answered `job: active`,
-- `last_run: succeeded`, `base_url_set: true` throughout, and a probe row sat `pending,
-- attempts = 0` for three and a half minutes underneath all of it.
--
-- The cause was one missing row: `vault.secrets` held **nothing at all**, so
-- `_drain_push_outbox()` took its `unconfigured` branch, raised a `warning` nobody was
-- reading, and returned a jsonb object. pg_cron saw a function that returned one row and
-- wrote `succeeded`, which is the only thing it can conclude from a function that does not
-- raise.
--
-- So the pipeline was dead for a day in a way that every observable called healthy. That
-- is the defect this migration is about. The missing secret was an operator action and is
-- already fixed; **a health check that could not see it is a code defect and is fixed
-- here.**
--
-- ---------------------------------------------------------------------------
-- TWO CHANGES, AND THEY FAIL CLOSED IN DIFFERENT PLACES
--
-- 1. **`_drain_push_outbox()` raises instead of returning, when it has work it cannot
--    do.** A tick that found rows and could not post is not a tick that succeeded, and
--    `cron.job_run_details` is the one record an operator reads without being told where
--    to look. It stays silent when the queue is empty, so a project that has not been
--    bootstrapped yet does not manufacture an alarm out of an idle scheduler — the alarm
--    is for *work that is not being done*, which is the thing anybody cares about.
--
-- 2. **`push_drain_status()` reports every dependency, and summarises them.** It checked
--    `functions.base_url` and never the Vault secret, which is precisely the input that
--    was missing. It now answers `vault_secret_set`, a `problems` array naming each
--    failure by a stable string, and one `healthy` boolean that is false if any of them
--    is set — so the answer to "is push working" is a field and not an interpretation.
--
-- `healthy` is **false on a database where the drain is not installed at all**, including
-- the PGlite harness. That is deliberate and it is what fail-closed means here: a
-- database that cannot drain its outbox is not a healthy one, whatever the reason, and a
-- check that returned `true` for "not applicable" is the check that just cost a day.
--
-- ---------------------------------------------------------------------------
-- WHAT IS STILL NOT SAID
--
-- **No secret value, ever, in any branch.** `vault_secret_set` is a boolean derived from
-- `nullif(decrypted_secret, '') is not null` and nothing else leaves the function; the
-- exception message in `_drain_push_outbox` names *which input* is missing and never what
-- either input contains. A status function that leaked a service-role key to whoever ran
-- the health check would be a worse defect than the one being fixed.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The tick, rebuilt in full from `20260826000300`
--
-- Rebuilt rather than patched, per `20260819000500`: the only behavioural change is the
-- `unconfigured` branch, and it is easier to see that in a whole body than in a diff of
-- one.
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
  -- It is also what keeps the raise below from firing on an idle unconfigured project.
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

  if nullif(v_url, '') is null or nullif(v_key, '') is null then
    /**
     * **Raise, and this is the whole point of the migration.**
     *
     * This was `raise warning` followed by a normal return, and pg_cron recorded
     * `succeeded` 1,221 times over a pipeline that had never sent a single request. A
     * warning goes to the Postgres log, where nobody was looking; the return value went
     * nowhere at all, because `cron.job_run_details` keeps `return_message`, which for a
     * function that returns cleanly is the string `1 row`.
     *
     * An exception is the only thing pg_cron can record as a failure, and a failed run is
     * the only thing that makes `push_drain_status().last_run` tell the truth.
     *
     * Naming which input is missing and never its value: an operator needs to know whether
     * to set `app_config` or the Vault, and nobody needs the key echoed into a job log.
     */
    raise exception
      'push drain: not configured — functions.base_url is %, vault secret service_role_key is %; % row(s) waiting and none can be sent',
      case when nullif(v_url, '') is null then 'MISSING' else 'set' end,
      case when nullif(v_key, '') is null then 'MISSING' else 'set' end,
      v_due
      using errcode = '55000',
            hint = 'Set functions.base_url in app_config, and/or store the service-role key: select vault.create_secret(''<service role key>'', ''service_role_key''). See docs/release/push-operations.md.';
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
  'One scheduler tick: if push_outbox has anything in it, asks push-sender to drain it. Reads the service-role key from Supabase Vault and the function URL from app_config, so neither is in this schema or in the repository. Silent when the queue is empty; RAISES when the queue is not empty and either input is missing, because a tick that could not send is not a tick that succeeded and cron.job_run_details is where that has to show. Internal -- a client that could call this could make the database post a service-role credential.';

-- ---------------------------------------------------------------------------
-- 2. The readout, rebuilt in full
--
-- Same shape as before plus three fields. Nothing was removed: `push_drain_status()` is
-- read by `scripts/bootstrap-production.mjs` and quoted in four runbooks, and a health
-- check that changes its own keys is a health check that reads as broken on the day it
-- gets better.
-- ---------------------------------------------------------------------------

create or replace function push_drain_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job      jsonb := null;
  v_last     jsonb := null;
  v_queued   bigint;
  v_stalled  bigint;
  v_url      boolean;
  v_secret   boolean := false;
  v_vault    boolean := false;
  v_net      boolean := false;
  v_proc     regprocedure;
  v_problems text[] := array[]::text[];
begin
  select count(*) into v_queued from push_outbox;
  select count(*) into v_stalled
    from push_outbox
   where created_at < now() - interval '15 minutes';

  -- Present *and* non-empty. An `app_config` row holding `""` set the old boolean true and
  -- would have sent the tick to `v_url || '/push-sender'` — a POST to `/push-sender`,
  -- relative to nothing.
  select exists (
    select 1 from app_config
     where key = 'functions.base_url' and nullif(value #>> '{}', '') is not null
  ) into v_url;

  /**
   * The field whose absence is the reason this migration exists.
   *
   * Dynamic, and guarded by `to_regclass`, for the same reason every `cron.` read in this
   * file is: the local suite replays into PGlite, which has no `vault` schema, and a
   * static reference would plan and fail the moment this branch was reached there.
   *
   * `v_vault` and `v_secret` are separate because they are different operator actions —
   * enable the extension, or store the secret — and collapsing them would send somebody
   * to the dashboard to look for a secret in a Vault that is not switched on.
   */
  if to_regclass('vault.decrypted_secrets') is not null then
    v_vault := true;
    begin
      execute $q$
        select exists (
          select 1 from vault.decrypted_secrets
           where name = 'service_role_key' and nullif(decrypted_secret, '') is not null
        )
      $q$ into v_secret;
    exception when others then
      -- Readable by the owner and by nobody else; if this function's owner cannot read it,
      -- the honest answer is "cannot confirm", and the honest answer fails closed.
      v_secret := false;
    end;
  end if;

  /**
   * The transport, which is a dependency exactly as much as the scheduler and the secret
   * are — review 46b.
   *
   * `_drain_push_outbox()` ends in `net.http_post`. If `pg_net` is disabled or dropped, a
   * project with an active job, a good URL, a stored secret and an empty queue answered
   * `healthy: true` while being completely unable to send the next push; the truth only
   * surfaced later, as an undefined-function error on the first tick that had work. That is
   * the same "healthy until somebody needs it" shape as the incident above.
   *
   * **The exact signature the tick binds to, and executable by this function's owner** —
   * review 46c, which caught the first attempt matching on the name alone. A stray
   * `net.http_post(text)` left behind by anything at all would have satisfied that, and so
   * would a `net.http_post` whose EXECUTE had been revoked; in both cases the drain still
   * cannot post and the summary still said it could.
   *
   * `to_regprocedure` resolves the one overload `perform net.http_post(url := …, headers :=
   * …, body := …, timeout_milliseconds := …)` actually binds to, and returns null rather
   * than raising when the schema, the function or that signature is absent. Pinning the
   * signature means this check goes red on the same day the drain does if pg_net ever
   * changes it, which is the correct coupling: they have to agree or one of them is lying.
   */
  v_proc := to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)');
  v_net := v_proc is not null and has_function_privilege(v_proc, 'execute');

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

  -- ---------------------------------------------------------------------------
  -- Every reason this pipeline could be dead, named. The strings are an interface:
  -- runbooks and `push-drain-acceptance.mjs` match on them, so they are stable and
  -- lowercase and say the thing rather than a grade.
  -- ---------------------------------------------------------------------------
  if v_job is null then
    v_problems := v_problems || 'scheduler_not_installed'::text;
  elsif not coalesce((v_job ->> 'active')::boolean, false) then
    v_problems := v_problems || 'scheduler_inactive'::text;
  end if;

  if not v_url then
    v_problems := v_problems || 'base_url_missing'::text;
  end if;

  -- The transport. Without it the tick cannot post, whatever else is in place.
  if not v_net then
    v_problems := v_problems || 'pg_net_unavailable'::text;
  end if;

  if not v_vault then
    v_problems := v_problems || 'vault_unavailable'::text;
  elsif not v_secret then
    v_problems := v_problems || 'vault_service_role_key_missing'::text;
  end if;

  /**
   * A run that ended any way other than `succeeded`, including the new raise above — and,
   * separately, **no run at all**.
   *
   * Independent review 46 was right that the second one is not a detail. A scheduled job
   * that has never executed has demonstrated nothing, and `last_run = null` on a job that
   * has been active for more than a minute is a real and already-documented failure:
   * pg_cron installed but not running jobs, which is what happens when the extension was
   * enabled in the wrong database. Treating "no evidence" as "fine" is the same mistake as
   * treating `succeeded` as "delivered", one layer up.
   *
   * It self-clears within a minute of a genuine install, and
   * `scripts/bootstrap-production.mjs` — the one caller that knows it has *just* scheduled
   * the job — downgrades this single problem to a note for exactly that reason. Nothing
   * else does.
   */
  if v_job is not null and v_last is null then
    v_problems := v_problems || 'last_run_missing'::text;
  elsif v_last is not null and coalesce(v_last ->> 'status', '') <> 'succeeded' then
    v_problems := v_problems || 'last_run_not_succeeded'::text;
  end if;

  -- Rows arriving and nothing taking them. This was already the number the runbook alerted
  -- on; it is now also a reason `healthy` is false, rather than a figure beside a `true`.
  if v_stalled > 0 then
    v_problems := v_problems || 'outbox_stalled'::text;
  end if;

  return jsonb_build_object(
    'environment',    environment_name(),
    'job',            v_job,
    'last_run',       v_last,
    'queued',         v_queued,
    'older_than_15m', v_stalled,
    'base_url_set',   v_url,
    -- Boolean, never the value, and never its length either: a length is a fingerprint of
    -- which key it is.
    'pg_net_available', v_net,
    'vault_available',  v_vault,
    'vault_secret_set', v_secret,
    'problems',       to_jsonb(v_problems),
    -- The one field a caller should branch on. False unless every dependency above is
    -- present and the last run and the queue both look right.
    'healthy',        cardinality(v_problems) = 0
  );
end;
$$;

comment on function push_drain_status() is
  'Whether the push drain is scheduled, configured, and keeping up: job, last run, queue depth, base URL, and whether the Vault holds service_role_key -- as booleans, never values. `problems` names each failure with a stable string and `healthy` is false if any is set, because the previous version reported base_url and not the Vault secret and therefore called a pipeline healthy that had never sent a request. Names nobody and returns no push content. service_role only.';

-- ---------------------------------------------------------------------------
-- 3. Privileges, restated
--
-- `create or replace` keeps the existing grants, and restating them is cheap next to
-- discovering that a rebuild somewhere had not.
-- ---------------------------------------------------------------------------

revoke execute on function _drain_push_outbox() from public, anon, authenticated;
revoke execute on function push_drain_status()  from public, anon, authenticated;
grant  execute on function push_drain_status()  to service_role;
