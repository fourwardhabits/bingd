-- A job that says when another is broken (2026-11-20).
--
-- WHAT WAS ACTUALLY WRONG
--
-- Nothing alerts (docs/ops/reliability-2026-11-20.md §1.6, background-jobs.md §2g). Every
-- signal about the six pg_cron jobs is pull-only: `cron.job_run_details`, and four status
-- functions (`import_drain_status`, `push_drain_status`, `release_status`,
-- `proactive_status`) that nothing calls on a schedule. `pg_net` keeps HTTP answers for six
-- hours. A job that stopped, or failed for an hour overnight and recovered, was found by
-- whoever next looked, and a failure that had already recovered was not found at all once
-- its run history was pruned.
--
-- THE CHANGE
--
--   * `ops_job_health()`: one row per thing that should be happening, with a status of `ok`,
--     `late`, `failing` or `missing` (and `info` for the one informational row). It covers
--     the six jobs and this migration's own, the push outbox's oldest row, the import queue's
--     stalled jobs, and the welcome dispatcher's last GitHub answer. It is computed live, so
--     it does not depend on the tick below, which is what makes it the self-check too: if
--     `bingd-ops-health` stops, its own row reads `missing` or `late`.
--   * `bingd-ops-health`, a pg_cron job every ten minutes (at 3, 13, …, 53), calls
--     `ops_health_tick()`. It records **transitions only** in `ops_alerts`: a row is opened
--     when a check goes bad and closed when it recovers, one open row per check at most
--     (a partial unique index), and a check that goes bad again within an hour of
--     recovering reopens the same row rather than writing a new one. So a flapping job is
--     one row, not six an hour.
--   * `ops.alert_muted_checks` in `app_config`, an empty array by default, names checks that
--     are still reported but never open an alert. A muted check's open alert is closed as
--     `muted`.
--
-- WHY NOT A PUSH TO THE OPERATOR
--
-- The brief preferred one, through the existing outbox. It cannot carry an operator message
-- safely from the database alone:
--
--   * `push_outbox`'s primary key is a notification id, so a push needs a `notifications`
--     row, and the type has to be one the table, `_push_eligible` and the client know;
--   * `push-sender` composes the words itself (`copy.ts`). An actorless type it does not
--     know returns null, and the job is settled as **delivered with nothing sent**. So a new
--     type needs an Edge Function deploy, and until that deploy every alert would be
--     recorded as delivered and never arrive, the exact "healthy while broken" defect
--     20260826000700 was written against;
--   * the in-app inbox drops an actorless row it does not know (`use-notifications.ts`), so
--     the alert would also need a client release.
--
-- That is three coordinated releases (migration, Edge Function, OTA), not one small change.
-- `ops_alerts` is shaped so a later delivery can read it. Until then the operator check is one
-- query, in background-jobs.md §2g.
--
-- COST
--
-- `cron.job_run_details` has one index, its primary key, and #334 (20261130000400) has just
-- removed 62 full scans an hour of it. The tick reads the **last 5,000 runids** by that key
-- (about ten hours at production's rate: 492 rows an hour), never the whole table, and every
-- other read is a primary-key or `created_at` index lookup on a small table. Measured on
-- staging: background-jobs.md §2g.
--
-- NEVER RAISES
--
-- What the tick observes never makes it raise. If it fails internally, it records an open
-- `bingd-ops-health` alert with the SQLSTATE and returns `{"status": "error"}`; the next tick
-- that works closes it.
--
-- ROLLBACK
--
-- docs/release/ops-health/rollback-20261130000500.sql. Nothing else reads these objects.
--
-- Inside one `do` block, as in 20260923000100: the CLI applies statements outside a
-- transaction, and a new function or table is reachable by PUBLIC, anon and authenticated
-- (Supabase's default privileges) until its `revoke` runs. Every statement is idempotent, so
-- re-applying the file is safe.

do $install$
begin

-- ---------------------------------------------------------------------------
-- 1. The alert log
-- ---------------------------------------------------------------------------

create table if not exists ops_alerts (
  id            bigint generated always as identity primary key,
  check_name    text not null,
  -- The latest bad status seen while open.
  status        text not null check (status in ('late', 'failing', 'missing')),
  opened_at     timestamptz not null,
  last_seen_at  timestamptz not null,
  closed_at     timestamptz,
  close_reason  text check (close_reason in ('recovered', 'muted', 'retired')),
  -- Times it went bad again within an hour of recovering, folded into this row.
  reopened      integer not null default 0,
  -- The latest observation: what the check said, never a secret.
  detail        jsonb not null default '{}'::jsonb,
  check ((closed_at is null) = (close_reason is null))
);

comment on table ops_alerts is
  'One row per background-job incident, written by ops_health_tick() (pg_cron bingd-ops-health) on transitions only: opened when a check in ops_job_health() goes late, failing or missing, closed when it recovers. At most one open row per check. Server-only (20261130000500).';

create unique index if not exists ops_alerts_one_open on ops_alerts (check_name) where closed_at is null;
create index if not exists ops_alerts_recent on ops_alerts (check_name, closed_at desc);

alter table ops_alerts enable row level security;
revoke all on table ops_alerts from public, anon, authenticated;
revoke all on sequence ops_alerts_id_seq from public, anon, authenticated;

insert into app_config (key, value) values ('ops.alert_muted_checks', '[]'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The observation
-- ---------------------------------------------------------------------------

create or replace function _ops_observe(p_at timestamptz)
returns table (
  check_name           text,
  kind                 text,
  status               text,
  muted                boolean,
  max_interval         interval,
  last_run             timestamptz,
  last_success         timestamptz,
  consecutive_failures integer,
  detail               jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
#variable_conflict use_column
declare
  v_at       timestamptz := coalesce(p_at, now());
  v_muted    text[];
  v_floor    bigint;
  v_count    bigint;
  v_oldest   timestamptz;
  v_stalled  bigint;
  v_token    boolean;
  v_delivery boolean;
  v_dispatch text;
  v_github   jsonb;
begin
  select coalesce(array(select jsonb_array_elements_text(c.value)), '{}')
    into v_muted
    from app_config c
   where c.key = 'ops.alert_muted_checks' and jsonb_typeof(c.value) = 'array';
  v_muted := coalesce(v_muted, '{}');

  -- -------------------------------------------------------------------------
  -- The scheduled jobs. Allowed gaps are the schedule plus slack: the tick runs every ten
  -- minutes, so nothing tighter than that is observable anyway.
  -- -------------------------------------------------------------------------
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    return query
      select e.check_name, 'cron'::text, 'missing'::text, e.check_name = any(v_muted), e.max_interval,
             null::timestamptz, null::timestamptz, 0, jsonb_build_object('reason', 'pg_cron_unavailable')
        from _ops_expected_jobs() e order by e.ord;
  else
    -- The window: the last 5,000 runs by primary key. max(runid) is one index probe, and
    -- the bound is a constant by the time the query below is planned.
    execute $q$ select coalesce(max(runid), 0) - 5000 from cron.job_run_details $q$ into v_floor;

    return query execute $q$
      with expected as (select * from public._ops_expected_jobs()),
      jobs as (
        select j.jobid, j.jobname, j.active, j.schedule
          from cron.job j
         where j.jobname in (select e.check_name from expected e)),
      named as (
        select jobname, bool_or(active) as active, min(schedule) as schedule
          from jobs group by jobname),
      w as (
        select j.jobname, d.runid, d.status, coalesce(d.start_time, d.end_time) as at, d.return_message
          from cron.job_run_details d join jobs j on j.jobid = d.jobid
         where d.runid > $1),
      ok_run as (
        select jobname, max(runid) as runid from w where status = 'succeeded' group by jobname),
      per as (
        select w.jobname,
               count(*)::int as runs,
               max(w.at) as last_run,
               max(w.at) filter (where w.status = 'succeeded') as last_success,
               -- Failed runs since the last success in the window. With no success in the
               -- window, every failure in it: a lower bound.
               count(*) filter (where w.status = 'failed' and w.runid > coalesce(o.runid, 0))::int as consecutive,
               (array_agg(w.status order by w.runid desc)
                  filter (where w.status in ('succeeded', 'failed')))[1] as last_status,
               (array_agg(left(w.return_message, 200) order by w.runid desc)
                  filter (where w.status = 'failed'))[1] as last_error
          from w left join ok_run o on o.jobname = w.jobname
         group by w.jobname)
      select e.check_name, 'cron'::text,
             case when n.jobname is null or not n.active then 'missing'
                  when coalesce(p.consecutive, 0) > 0 then 'failing'
                  when p.last_run is null or p.last_run < $2 - e.max_interval then 'late'
                  else 'ok' end,
             e.check_name = any($3),
             e.max_interval, p.last_run, p.last_success, coalesce(p.consecutive, 0),
             jsonb_strip_nulls(jsonb_build_object(
               'reason', case when n.jobname is null then 'not_scheduled'
                              when not n.active then 'inactive' end,
               'schedule', n.schedule,
               'runs_in_window', coalesce(p.runs, 0),
               'last_status', p.last_status,
               'last_error', case when coalesce(p.consecutive, 0) > 0 then p.last_error end))
        from expected e
        left join named n on n.jobname = e.check_name
        left join per p on p.jobname = e.check_name
       order by e.ord
    $q$ using v_floor, v_at, v_muted;
  end if;

  -- -------------------------------------------------------------------------
  -- The push outbox: a row older than 15 minutes is stalled, as push_drain_status() says.
  -- The drain never reads push-sender's answer, so this is the only place a 401 or 500
  -- there shows. Index on created_at.
  -- -------------------------------------------------------------------------
  select count(*), min(o.created_at) into v_count, v_oldest from push_outbox o;
  return query select
    'push-outbox'::text, 'queue'::text,
    case when v_oldest < v_at - interval '15 minutes' then 'late' else 'ok' end,
    'push-outbox' = any(v_muted), interval '15 minutes', null::timestamptz, null::timestamptz, 0,
    jsonb_strip_nulls(jsonb_build_object(
      'queued', v_count,
      'oldest_age_s', floor(extract(epoch from v_at - v_oldest))::bigint));

  -- -------------------------------------------------------------------------
  -- The import queue: an open job older than 15 minutes is not moving (import_drain_status).
  -- -------------------------------------------------------------------------
  select count(*), count(*) filter (where j.created_at < v_at - interval '15 minutes')
    into v_count, v_stalled
    from import_jobs j where j.completed_at is null;
  return query select
    'import-queue'::text, 'queue'::text,
    case when v_stalled > 0 then 'late' else 'ok' end,
    'import-queue' = any(v_muted), interval '15 minutes', null::timestamptz, null::timestamptz, 0,
    jsonb_build_object('open', v_count, 'older_than_15m', v_stalled);

  -- -------------------------------------------------------------------------
  -- The welcome dispatcher's gates and its last GitHub answer. Informational: an
  -- unconfigured dispatcher is not a broken email, because the GitHub schedule still runs.
  -- The token is counted by name in vault.secrets and never decrypted.
  -- -------------------------------------------------------------------------
  v_delivery := coalesce(
    (select c.value from app_config c where c.key = 'welcome.delivery_enabled') = 'true'::jsonb, false);
  if to_regclass('vault.secrets') is not null then
    begin
      execute $q$ select exists (select 1 from vault.secrets where name = 'welcome_dispatch_github_token') $q$
        into v_token;
    exception when others then
      v_token := null;
    end;
  end if;
  v_dispatch := case
    when environment_name() is distinct from 'prod' then 'not_production'
    when not v_delivery then 'disabled'
    when not coalesce(v_token, false) then 'unconfigured'
    else 'configured' end;

  -- GitHub's answers are the only ones with an x-github-request-id header. The header test
  -- is applied before the limit, so other posts (the push drain, the import nudge) cannot
  -- crowd the dispatcher's answer out. The read is bounded by pg_net's own six-hour TTL, by
  -- the index on created, and stops at the newest match.
  if to_regclass('net._http_response') is not null then
    begin
      execute $q$
        select jsonb_build_object('status_code', r.status_code, 'at', r.created,
                                  'timed_out', r.timed_out, 'errored', r.error_msg is not null)
          from net._http_response r
         where r.created > $1 - interval '6 hours'
           and jsonb_typeof(r.headers) = 'object'
           and exists (select 1 from jsonb_object_keys(r.headers) k where lower(k) = 'x-github-request-id')
         order by r.created desc limit 1
      $q$ into v_github using v_at;
    exception when others then
      v_github := null;
    end;
  end if;

  return query select
    'welcome-dispatch-github'::text, 'info'::text, 'info'::text,
    'welcome-dispatch-github' = any(v_muted), null::interval, null::timestamptz, null::timestamptz, 0,
    jsonb_strip_nulls(jsonb_build_object('dispatcher', v_dispatch, 'last_github_answer', v_github));
end;
$fn$;

-- The jobs that should exist, and the longest gap each is allowed. Changed by migration.
create or replace function _ops_expected_jobs()
returns table (check_name text, max_interval interval, ord integer)
language sql
immutable
set search_path = public
as $fn$
  values
    ('bingd-import-drain',       interval '2 minutes',  1),  -- every 10 s
    ('bingd-import-maintenance', interval '5 minutes',  2),  -- every minute
    ('bingd-push-drain',         interval '5 minutes',  3),  -- every minute
    ('bingd-release-evaluate',   interval '20 minutes', 4),  -- */15
    ('bingd-release-refresh',    interval '75 minutes', 5),  -- 7 * * * *
    ('bingd-welcome-dispatch',   interval '75 minutes', 6),  -- 41 * * * *
    ('bingd-ops-health',         interval '25 minutes', 7)   -- every 10 minutes: itself
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The readout an operator runs
-- ---------------------------------------------------------------------------

create or replace function ops_job_health()
returns table (
  check_name           text,
  kind                 text,
  status               text,
  muted                boolean,
  max_interval         interval,
  last_run             timestamptz,
  last_success         timestamptz,
  consecutive_failures integer,
  alert_open_since     timestamptz,
  detail               jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
#variable_conflict use_column
declare
  v_state text;
  v_msg   text;
begin
  -- _ops_observe() is materialised before its first row reaches this query, so an error in
  -- it arrives before any row is returned, and the handler below answers alone.
  return query
    select o.check_name, o.kind,
           -- A tick that failed internally recorded its error on its own open alert; the
           -- cron run itself succeeded, because the tick never raises.
           case when o.check_name = 'bingd-ops-health' and a.detail ? 'tick_error' then 'failing'
                else o.status end,
           o.muted, o.max_interval, o.last_run, o.last_success, o.consecutive_failures,
           a.opened_at,
           case when o.check_name = 'bingd-ops-health' and a.detail ? 'tick_error'
                then o.detail || jsonb_build_object('tick_error', a.detail -> 'tick_error',
                                                    'message', a.detail -> 'message')
                else o.detail end
      from _ops_observe(now()) with ordinality o
      left join ops_alerts a on a.check_name = o.check_name and a.closed_at is null
     order by o.ordinality;
exception when others then
  /**
   * The observation itself fails: the same fault the tick records as its own alert. The
   * readout must still say so rather than raise, or the self-check is lost exactly when it
   * matters. So: bingd-ops-health as failing, with this error and the tick's, then every
   * other open alert as the tick last saw it.
   */
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return query
    select 'bingd-ops-health'::text, 'cron'::text, 'failing'::text, false, interval '25 minutes',
           null::timestamptz, null::timestamptz, 0, a.opened_at,
           jsonb_strip_nulls(jsonb_build_object(
             'observe_error', v_state, 'message', left(v_msg, 200),
             'tick_error', a.detail -> 'tick_error'))
      from (select 1) one
      left join ops_alerts a on a.check_name = 'bingd-ops-health' and a.closed_at is null
    union all
    select a.check_name, 'alert'::text, a.status, false, null::interval,
           null::timestamptz, null::timestamptz, 0, a.opened_at, a.detail
      from ops_alerts a
     where a.closed_at is null and a.check_name <> 'bingd-ops-health';
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. The tick
-- ---------------------------------------------------------------------------

create or replace function ops_health_tick(p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_at       timestamptz := coalesce(p_at, now());
  r          record;
  v_open     ops_alerts%rowtype;
  v_prev     bigint;
  v_bad      boolean;
  v_detail   jsonb;
  v_seen     text[] := '{}';
  v_opened   integer := 0;
  v_reopened integer := 0;
  v_closed   integer := 0;
  v_state    text;
  v_msg      text;
begin
  -- One tick at a time. A second caller (a manual call beside cron) returns at once.
  if not pg_try_advisory_xact_lock(hashtextextended('bingd:ops-health-tick', 0)) then
    return jsonb_build_object('status', 'busy');
  end if;

  begin
    for r in select * from _ops_observe(v_at) loop
      v_seen := v_seen || r.check_name;
      v_bad := r.status in ('late', 'failing', 'missing') and not r.muted;
      v_detail := r.detail || jsonb_strip_nulls(jsonb_build_object(
        'last_run', r.last_run, 'last_success', r.last_success,
        'consecutive_failures', nullif(r.consecutive_failures, 0)));

      select * into v_open from ops_alerts a
       where a.check_name = r.check_name and a.closed_at is null
       for update;

      if v_bad and found then
        update ops_alerts
           set status = r.status, last_seen_at = v_at, detail = v_detail
         where id = v_open.id;
      elsif v_bad then
        -- Gone bad again within an hour of recovering: the same incident, the same row.
        select a.id into v_prev from ops_alerts a
         where a.check_name = r.check_name
           and a.close_reason = 'recovered'
           and a.closed_at > v_at - interval '1 hour'
         order by a.closed_at desc limit 1
         for update;
        if found then
          update ops_alerts
             set status = r.status, last_seen_at = v_at, detail = v_detail,
                 closed_at = null, close_reason = null, reopened = reopened + 1
           where id = v_prev;
          v_reopened := v_reopened + 1;
        else
          insert into ops_alerts (check_name, status, opened_at, last_seen_at, detail)
          values (r.check_name, r.status, v_at, v_at, v_detail);
          v_opened := v_opened + 1;
        end if;
      elsif found then
        update ops_alerts
           set closed_at = v_at, last_seen_at = v_at,
               close_reason = case when r.muted then 'muted' else 'recovered' end
         where id = v_open.id;
        v_closed := v_closed + 1;
      end if;
    end loop;

    -- A check this version no longer reports cannot recover. Close it rather than leave it
    -- open for ever.
    update ops_alerts
       set closed_at = v_at, last_seen_at = v_at, close_reason = 'retired'
     where closed_at is null and not (check_name = any(v_seen));

    return jsonb_build_object(
      'status',   'ok',
      'checked',  cardinality(v_seen),
      'opened',   v_opened,
      'reopened', v_reopened,
      'closed',   v_closed,
      'open',     (select count(*) from ops_alerts where closed_at is null));
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    -- Say so where the operator looks, then return. The block above rolled back.
    begin
      insert into ops_alerts (check_name, status, opened_at, last_seen_at, detail)
      values ('bingd-ops-health', 'failing', v_at, v_at,
              jsonb_build_object('tick_error', v_state, 'message', left(v_msg, 200)))
      on conflict (check_name) where closed_at is null do update
        set status = 'failing', last_seen_at = excluded.last_seen_at,
            detail = ops_alerts.detail || excluded.detail;
    exception when others then
      null;
    end;
    return jsonb_build_object('status', 'error', 'sqlstate', v_state);
  end;
end;
$fn$;

create or replace function ops_health_tick()
returns jsonb
language sql
security definer
set search_path = public
as $fn$
  select ops_health_tick(now());
$fn$;

comment on function _ops_observe(timestamptz) is
  'What ops_job_health() reports, as of p_at: each expected pg_cron job (missing, failing, late or ok, from the last 5,000 cron.job_run_details rows by primary key, never a full scan), the push outbox and import queue (late when work is older than 15 minutes), and the welcome dispatcher''s gates and last GitHub answer (info). Internal (20261130000500).';
comment on function _ops_expected_jobs() is
  'The pg_cron jobs ops_job_health() expects, and the longest gap each may go without a run. Internal (20261130000500).';
comment on function ops_job_health() is
  'Live background-job health: one row per check, status ok, late, failing, missing or info, and the open ops_alerts row if there is one. Includes bingd-ops-health itself, so a stopped health tick shows here. If the observation itself fails it does not raise: it returns bingd-ops-health as failing with the error, then the open alerts (kind alert). Reads cron history by primary key only. service_role and the SQL editor (20261130000500).';
comment on function ops_health_tick(timestamptz) is
  'One bingd-ops-health tick as of p_at: opens an ops_alerts row when a check goes late, failing or missing, closes it when the check recovers (or is muted), and folds a relapse within an hour into the same row. Transitions only. Never raises: an internal failure is recorded as an open bingd-ops-health alert and returned as status error. Internal (20261130000500).';
comment on function ops_health_tick() is
  'The bingd-ops-health call: ops_health_tick(now()). Never raises. Internal (20261130000500).';

revoke all on function _ops_observe(timestamptz)       from public, anon, authenticated, service_role;
revoke all on function _ops_expected_jobs()            from public, anon, authenticated, service_role;
revoke all on function ops_health_tick(timestamptz)    from public, anon, authenticated, service_role;
revoke all on function ops_health_tick()               from public, anon, authenticated, service_role;
revoke all on function ops_job_health()                from public, anon, authenticated;
grant execute on function ops_job_health()             to service_role;

end;
$install$;

-- ---------------------------------------------------------------------------
-- The schedule
--
-- Every ten minutes at 3, 13, …, 53: off the minute the other jobs share and off the hour.
-- Replaced by name, so re-applying this file leaves exactly one job. Skipped where pg_cron
-- is not installed; where it is, a failure to schedule raises.
-- ---------------------------------------------------------------------------

do $schedule$
declare
  v_old bigint;
  v_id  bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice 'ops health: pg_cron is not installed; bingd-ops-health not scheduled';
    return;
  end if;

  for v_old in execute $q$ select jobid from cron.job where jobname = 'bingd-ops-health' $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_old;
  end loop;

  execute $q$ select cron.schedule('bingd-ops-health', '3,13,23,33,43,53 * * * *',
    'select public.ops_health_tick()') $q$ into v_id;

  raise notice 'ops health: bingd-ops-health scheduled as job %', v_id;
end;
$schedule$;
