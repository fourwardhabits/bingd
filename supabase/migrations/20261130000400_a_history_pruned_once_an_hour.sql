-- A history pruned once an hour (2026-11-20).
--
-- WHAT WAS ACTUALLY WRONG
--
-- `bingd-import-maintenance` runs every minute, and the last of its three calls,
-- `_import_prune_cron_history()` (20260917001700), deletes this job's and the import drain's
-- `cron.job_run_details` rows older than seven days. `bingd-release-evaluate` does the same for
-- the release jobs every fifteen minutes (`_release_prune_cron_history()`, 20260930000200).
--
-- `cron.job_run_details` has one index, its primary key on `runid`. There is nothing on
-- `end_time` or `jobid`, and the table belongs to pg_cron, so each prune is a sequential scan
-- of the whole table to find a handful of expired rows. Measured on production, read-only,
-- 2026-11-20:
--
--   * the table holds ~196,000 rows (49 MB). 116,000 of them are `bingd-push-drain`'s, which
--     nothing prunes, so it grows by 1,440 rows a day;
--   * it has been sequentially scanned 101,493 times, reading 14.8 billion tuples (146,000 a
--     scan), and never by index. That is the minute prune plus the quarter-hour one;
--   * `select public._import_sweep_abandoned(), public._import_enrich_nudge(),
--     public._import_prune_cron_history()` is the most expensive statement on the database:
--     24,128 s of 39,333 s of all execution time pg_stat_statements has recorded (61%), mean
--     252 ms, max 12.5 s. All authenticated (app) queries together are 8,083 s.
--
-- On staging, with the same table shape (179,000 rows), the same three-call job averages
-- 71 ms; the two-call version that ran there before the prune existed averaged 13 ms. The
-- prune's own `select` equivalent is 80 ms under EXPLAIN ANALYZE, a parallel seq scan.
--
-- Pruning to seven (or fourteen) days does not need to happen every minute. An hour of extra
-- history is 360 drain rows and 60 maintenance rows.
--
-- THE CHANGE
--
--   * Each prune now does its delete once an hour and returns 0 on every other call:
--     the import prune on the tick at minute 17 (UTC), the release prune on the tick at
--     minute 0, which is the first of the four quarter-hour evaluations. So the table is
--     scanned 2 times an hour instead of 64.
--   * The work moves into a one-argument form, `_import_prune_cron_history(p_at)` and
--     `_release_prune_cron_history(p_at)`, that takes the clock as input, so a test can say
--     exactly when a prune is due and what it removes. The zero-argument functions the cron
--     commands call stay, with the same names, return type and grants, and simply pass
--     `now()`. Neither one-argument form has a default, so the zero-argument call stays
--     unambiguous.
--
-- WHAT DOES NOT CHANGE
--
-- The schedules, the cron commands, the installers (`schedule_import_drain`,
-- `schedule_release_awareness`) and the jobs whose history each prune touches. The retention
-- windows are the same seven and fourteen days, now up to an hour later. Both still never
-- raise. A tick missed at minute 17 or 0 (pg_cron down, or more than a minute late) skips
-- that hour's prune, and the next hour's removes what it would have.
--
-- Not done here, recorded for a decision: `bingd-push-drain`'s history is unpruned and is
-- most of the table. Pruning it is a retention decision, and `push_drain_status()` reads only
-- its latest run.
--
-- ROLLBACK
--
-- Re-run the two zero-argument bodies from 20260917001700 and 20260930000200 (`create or
-- replace`, unchanged signatures), then:
--   drop function if exists _import_prune_cron_history(timestamptz);
--   drop function if exists _release_prune_cron_history(timestamptz);
-- No schedule needs to change in either direction.
--
-- Inside one `do` block, as in 20260923000100: the CLI applies statements outside a
-- transaction, and a new function is executable by PUBLIC until its `revoke` runs.

do $install$
begin

create or replace function _import_prune_cron_history(p_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_deleted integer := 0;
begin
  -- Once an hour: the maintenance tick at minute 17, UTC whatever the session's zone.
  if p_at is null or extract(minute from p_at at time zone 'UTC')::integer <> 17 then
    return 0;
  end if;
  if to_regclass('cron.job_run_details') is null or to_regclass('cron.job') is null then
    return 0;
  end if;
  -- These two jobs only. Other jobs' history is somebody else's to keep.
  execute $q$
    delete from cron.job_run_details d
     using cron.job j
     where j.jobid = d.jobid
       and j.jobname in ('bingd-import-drain', 'bingd-import-maintenance')
       and d.end_time < $1 - interval '7 days'
  $q$ using p_at;
  get diagnostics v_deleted = row_count;
  return v_deleted;
exception when others then
  -- Housekeeping. It must never be the reason the sweep or the poster nudge did not run.
  return 0;
end;
$fn$;

create or replace function _import_prune_cron_history()
returns integer
language sql
security definer
set search_path = public
as $fn$
  select _import_prune_cron_history(now());
$fn$;

create or replace function _release_prune_cron_history(p_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_deleted integer := 0;
begin
  -- Once an hour: the evaluation tick at minute 0 (it runs at 0, 15, 30 and 45), UTC.
  if p_at is null or extract(minute from p_at at time zone 'UTC')::integer <> 0 then
    return 0;
  end if;
  if to_regclass('cron.job_run_details') is null or to_regclass('cron.job') is null then
    return 0;
  end if;
  execute $q$
    delete from cron.job_run_details d
     using cron.job j
     where j.jobid = d.jobid
       and j.jobname in ('bingd-release-refresh', 'bingd-release-evaluate')
       and d.end_time < $1 - interval '14 days'
  $q$ using p_at;
  get diagnostics v_deleted = row_count;
  return v_deleted;
exception when others then
  return 0;
end;
$fn$;

create or replace function _release_prune_cron_history()
returns integer
language sql
security definer
set search_path = public
as $fn$
  select _release_prune_cron_history(now());
$fn$;

comment on function _import_prune_cron_history(timestamptz) is
  'Trims cron.job_run_details for the import drain and its maintenance job to seven days before p_at, and only when p_at is minute 17 of an hour (UTC); 0 otherwise. Each call is a full scan of a table with no usable index, so once an hour is enough (20261130000400). Never raises. Internal.';
comment on function _import_prune_cron_history() is
  'The bingd-import-maintenance call: _import_prune_cron_history(now()). Prunes once an hour, returns 0 on the other 59 ticks (20261130000400). Never raises. Internal.';
comment on function _release_prune_cron_history(timestamptz) is
  'Trims cron.job_run_details for the two release jobs to fourteen days before p_at, and only when p_at is minute 0 of an hour (UTC); 0 otherwise (20261130000400). Never raises. Internal.';
comment on function _release_prune_cron_history() is
  'The bingd-release-evaluate call: _release_prune_cron_history(now()). Prunes once an hour, on the :00 evaluation (20261130000400). Never raises. Internal.';

revoke all on function _import_prune_cron_history(timestamptz)  from public, anon, authenticated;
revoke all on function _import_prune_cron_history()             from public, anon, authenticated;
revoke all on function _release_prune_cron_history(timestamptz) from public, anon, authenticated;
revoke all on function _release_prune_cron_history()            from public, anon, authenticated;

end;
$install$;
