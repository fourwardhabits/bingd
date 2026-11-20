-- An alert that leaves the database (2026-11-20). DRAFT: staging only until the founder
-- approves the design in docs/ops/operator-alerts-proposal.md.
--
-- WHAT WAS ACTUALLY WRONG
--
-- 20261130000500 records every background-job incident in `ops_alerts`, transitions only,
-- and delivers nothing. It is a pull signal: an incident is found by whoever next runs the
-- query in background-jobs.md §2g. And if the database, pg_cron or the tick itself stops,
-- nothing at all is recorded, so the one failure that matters most is the one that cannot
-- say so from inside.
--
-- THE CHANGE
--
-- A new pg_cron job, `bingd-ops-alert`, at 5, 15, …, 55 (two minutes after each
-- `bingd-ops-health` tick), calls `_ops_alert_ping()`. It sends the **current state** (not
-- the change) of two things to an external dead-man's-switch provider (Healthchecks.io, the
-- hosted `hc-ping.com`), which does the edge detection, the deduplication and the email:
--
--   * `bingd-heartbeat`: success while the health tick is healthy, `/fail` when it is not
--     (its own row in `_ops_observe` is not `ok`, or it has an open `ops_alerts` row, which
--     includes a caught tick error). When pings stop arriving at all (database down, pg_cron
--     stopped, pg_net broken, egress blocked, the secret removed or wrong), the provider marks
--     the check down after its period plus grace and emails. That is the dead-man's switch,
--     and it is independent of everything in this database.
--   * `bingd-alerts`: `/fail` while any actionable incident is open, success otherwise. An
--     incident is actionable when it has been seen bad on two ticks (`last_seen_at >
--     opened_at`; a one-tick blip never emails) and stays actionable for an hour after it
--     recovers, the same hour `ops_alerts` folds relapses into one row, so a flapping job is
--     one "down" and one "up" email. `bingd-ops-health`'s own row is the heartbeat's, not
--     this check's, so one fault is one email.
--
-- The provider emails only when a check changes state (up to down, down to up). So the
-- emails are deduplicated by construction, a recovery sends one "up", and a lost ping is
-- repaired by the next one ten minutes later, because every ping carries the whole state.
--
-- THE GATES, IN ORDER (as 20261130000300)
--
--   1. `environment_name()` is `prod`. A nonprod database returns before it reads the Vault.
--      This matters more here than for the welcome dispatcher: a staging database that
--      pinged production's checks would report "healthy" while production was down.
--   2. Vault holds `ops_alert_ping_key`: the ping key of a Healthchecks project the founder
--      creates for production alone. Missing or blank: `unconfigured`, no request. Anything
--      but 16 to 64 URL-safe characters: `invalid_key`, no request (so a stray value cannot
--      change the path, and the host is a literal).
--
-- Until the founder stores the key, the job runs every ten minutes and returns
-- `unconfigured`. It is inert.
--
-- WHAT LEAVES THE DATABASE
--
-- Check names, statuses and timestamps. Never `detail`, never `last_error` (a cron error
-- message can quote a row, and that row can be a person's), never the key except in the URL
-- path, which is how the provider authenticates a ping.
--
-- THE KEY'S PRIVILEGE
--
-- It can ping, and create, checks in that one Healthchecks project, and nothing else. It
-- cannot read anything there or here. Its worst misuse is a forged ping: a false alarm, or a
-- success that hides a real failure for up to one interval (the next real ping overwrites
-- it). That is why it is kept in the Vault rather than `app_config`, which the read-only
-- Management API role and every `select * from app_config` can see.
--
-- NEVER RAISES, WITH ONE EXCEPTION
--
-- As 20261130000300: a fully configured job with no `pg_net` raises, so pg_cron records the
-- failure. Every other fault becomes a heartbeat `/fail`, or no ping at all, and the provider
-- reports both.
--
-- Inside one `do` block, so the functions are never executable by PUBLIC, anon or
-- authenticated between `create` and `revoke`. Re-applying the file is safe.
--
-- Operator notes: docs/ops/operator-alerts-proposal.md, docs/ops/background-jobs.md §2g.
-- Stop the pings (the provider then emails that the heartbeat stopped; pause both checks
-- there first):  select cron.unschedule('bingd-ops-alert');
-- Remove the key:  delete from vault.secrets where name = 'ops_alert_ping_key';
-- Rollback: docs/release/ops-alert/rollback-20261130000700.sql.

do $install$
begin

-- ---------------------------------------------------------------------------
-- 1. The state, computed without any I/O
-- ---------------------------------------------------------------------------

create or replace function _ops_alert_signal(p_at timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_at        timestamptz := coalesce(p_at, now());
  v_tick      text;
  v_tick_open boolean;
  v_open      jsonb;
  v_held      jsonb;
  v_state     text;
begin
  -- The heartbeat: the health tick's own row, and its own open alert (a caught tick error
  -- leaves pg_cron's run `succeeded` and is visible only there).
  begin
    select o.status into v_tick
      from _ops_observe(v_at) o
     where o.check_name = 'bingd-ops-health';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    return jsonb_build_object('heartbeat', 'fail', 'alerts', null,
                              'reason', 'observe_error', 'sqlstate', v_state);
  end;

  select exists (select 1 from ops_alerts a
                  where a.check_name = 'bingd-ops-health' and a.closed_at is null)
    into v_tick_open;

  -- Open and seen bad on two ticks (or a relapse folded into an older row).
  select coalesce(jsonb_agg(jsonb_build_object(
           'check', a.check_name, 'status', a.status, 'since', a.opened_at,
           'reopened', a.reopened) order by a.opened_at), '[]'::jsonb)
    into v_open
    from ops_alerts a
   where a.closed_at is null
     and a.check_name <> 'bingd-ops-health'
     and a.last_seen_at > a.opened_at;

  -- Recovered within the hour after having been actionable. Ticks are ten minutes apart,
  -- so an incident seen bad on two ticks was open for at least twenty; a one-tick blip,
  -- about ten. Muted and retired closes end the incident at once.
  select coalesce(jsonb_agg(jsonb_build_object(
           'check', a.check_name, 'recovered_at', a.closed_at) order by a.closed_at), '[]'::jsonb)
    into v_held
    from ops_alerts a
   where a.close_reason = 'recovered'
     and a.check_name <> 'bingd-ops-health'
     and a.closed_at > v_at - interval '1 hour'
     and a.closed_at <= v_at
     and a.closed_at - a.opened_at >= interval '15 minutes';

  return jsonb_build_object(
    'heartbeat', case when v_tick = 'ok' and not v_tick_open then 'ok' else 'fail' end,
    'ops_health', coalesce(v_tick, 'unknown'),
    'alerts', case when jsonb_array_length(v_open) + jsonb_array_length(v_held) > 0
                   then 'fail' else 'ok' end,
    'open', v_open,
    'recovering', v_held);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. The ping
-- ---------------------------------------------------------------------------

create or replace function _ops_alert_ping(p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_at      timestamptz := coalesce(p_at, now());
  v_key     text;
  v_signal  jsonb;
  v_base    text;
  v_ids     bigint[] := '{}';
  v_id      bigint;
begin
  -- 1. Production only, before the Vault is read.
  if environment_name() is distinct from 'prod' then
    return jsonb_build_object('status', 'not_production');
  end if;

  -- 2. The key. No Vault at all reads as no key.
  begin
    select btrim(s.decrypted_secret, E' \t\r\n') into v_key
      from vault.decrypted_secrets s
     where s.name = 'ops_alert_ping_key'
     limit 1;
  exception when others then
    v_key := null;
  end;

  if nullif(v_key, '') is null then
    return jsonb_build_object('status', 'unconfigured');
  end if;
  if v_key !~ '^[A-Za-z0-9_-]{16,64}$' then
    return jsonb_build_object('status', 'invalid_key');
  end if;

  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    raise exception 'ops alert: pg_net is not available; the ping key is set and nothing can be sent'
      using errcode = '55000',
            hint = 'Enable pg_net (Supabase dashboard, Database > Extensions).';
  end if;

  v_signal := _ops_alert_signal(v_at);
  v_base := 'https://hc-ping.com/' || v_key || '/';

  -- Asynchronous, as every pg_net post here: a slow provider cannot hold a cron slot. The
  -- answers stay in net._http_response for six hours.
  select net.http_post(
    url     := v_base || 'bingd-heartbeat' || case when v_signal ->> 'heartbeat' = 'ok' then '' else '/fail' end,
    body    := jsonb_build_object('at', v_at, 'ops_health', v_signal -> 'ops_health')
               || jsonb_strip_nulls(jsonb_build_object('reason', v_signal -> 'reason',
                                                       'sqlstate', v_signal -> 'sqlstate')),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'User-Agent', 'bingd-ops-alert'),
    timeout_milliseconds := 10000
  ) into v_id;
  v_ids := v_ids || v_id;

  -- With no observation there is no alert state to report. The heartbeat's /fail says why.
  if v_signal ->> 'alerts' is not null then
    select net.http_post(
      url     := v_base || 'bingd-alerts' || case when v_signal ->> 'alerts' = 'ok' then '' else '/fail' end,
      body    := jsonb_build_object('at', v_at, 'open', v_signal -> 'open',
                                    'recovering', v_signal -> 'recovering'),
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'User-Agent', 'bingd-ops-alert'),
      timeout_milliseconds := 10000
    ) into v_id;
    v_ids := v_ids || v_id;
  end if;

  return jsonb_build_object(
    'status', 'posted',
    'heartbeat', v_signal -> 'heartbeat',
    'alerts', v_signal -> 'alerts',
    'open', jsonb_array_length(coalesce(v_signal -> 'open', '[]'::jsonb)),
    'request_ids', to_jsonb(v_ids));
end;
$fn$;

create or replace function _ops_alert_ping()
returns jsonb
language sql
security definer
set search_path = public
as $fn$
  select _ops_alert_ping(now());
$fn$;

comment on function _ops_alert_signal(timestamptz) is
  'What bingd-ops-alert would send, as of p_at, with no I/O: heartbeat ok or fail (the bingd-ops-health check and its own open alert), alerts ok or fail (an ops_alerts row open and seen on two ticks, or recovered within the hour after being so), and the check names, statuses and times behind them, never detail. Owner only (20261130000700).';
comment on function _ops_alert_ping(timestamptz) is
  'One bingd-ops-alert run: on a prod database with the Vault secret ops_alert_ping_key set, posts the heartbeat and alert state to hc-ping.com/<key>/bingd-heartbeat and /bingd-alerts (with /fail when bad). Returns not_production, unconfigured, invalid_key or posted with the pg_net request ids. Raises only when configured and pg_net is missing. Never returns or logs the key. Owner only (20261130000700).';
comment on function _ops_alert_ping() is
  'The bingd-ops-alert call: _ops_alert_ping(now()). Owner only (20261130000700).';

revoke all on function _ops_alert_signal(timestamptz) from public, anon, authenticated, service_role;
revoke all on function _ops_alert_ping(timestamptz)   from public, anon, authenticated, service_role;
revoke all on function _ops_alert_ping()              from public, anon, authenticated, service_role;

end;
$install$;

-- ---------------------------------------------------------------------------
-- The schedule
--
-- At 5, 15, …, 55: two minutes after each bingd-ops-health tick, off the minute the other
-- jobs share and off the hour. Replaced by name, so re-applying leaves exactly one job, and
-- no other job is touched. Skipped where pg_cron is not installed; where it is, a failure to
-- schedule raises.
-- ---------------------------------------------------------------------------

do $schedule$
declare
  v_old bigint;
  v_id  bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice 'ops alert: pg_cron is not installed; bingd-ops-alert not scheduled';
    return;
  end if;

  for v_old in execute $q$ select jobid from cron.job where jobname = 'bingd-ops-alert' $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_old;
  end loop;

  execute $q$ select cron.schedule('bingd-ops-alert', '5,15,25,35,45,55 * * * *',
    'select public._ops_alert_ping()') $q$ into v_id;

  raise notice 'ops alert: bingd-ops-alert scheduled as job %', v_id;
end;
$schedule$;
