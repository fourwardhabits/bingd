import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb, migrationSql } from './harness.mjs';

/**
 * Background-job health and transition-only alerts (20261130000500).
 *
 * `ops_job_health()` says, live, whether each scheduled job and queue is ok, late, failing or
 * missing. `ops_health_tick()` (pg_cron `bingd-ops-health`) records only the transitions in
 * `ops_alerts`: one row opened when a check goes bad, closed when it recovers, and a relapse
 * within an hour folded into the same row.
 *
 * What is pinned here:
 *   - each classification, from pg_cron's own columns, and that cron history is read through
 *     a bounded window of runids, not the whole table;
 *   - transitions only: no duplicate alerts on repeated ticks, recovery closes, relapse
 *     within the hour reopens, muting closes and suppresses;
 *   - nothing is delivered anywhere (no notification, no push), so nothing is sent while the
 *     operator path is the documented query;
 *   - grants and RLS, idempotent scheduling, the migration with no extensions at all, the
 *     tick never raising, and the rollback.
 *
 * PGlite has no pg_cron, pg_net or vault. Each test builds the stand-ins it needs, with the
 * real column names, and drops them afterwards.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const MIGRATION = '20261130000500_a_job_that_says_when_another_is_broken.sql';
const ROLLBACK = join(root, 'docs', 'release', 'ops-health', 'rollback-20261130000500.sql');

const JOBS = [
  'bingd-import-drain',
  'bingd-import-maintenance',
  'bingd-push-drain',
  'bingd-release-evaluate',
  'bingd-release-refresh',
  'bingd-welcome-dispatch',
  'bingd-ops-health',
];
const CHECKS = [...JOBS, 'push-outbox', 'import-queue', 'welcome-dispatch-github'];
const AT = '2026-11-20T12:00:00Z';

let t;

const installCron = async (jobs = JOBS) => {
  await t.sql(`create schema if not exists cron`);
  await t.sql(`
    create table if not exists cron.job (
      jobid bigserial primary key, jobname text, schedule text default '* * * * *',
      command text default 'select 1', active boolean default true)`);
  await t.sql(`
    create table if not exists cron.job_run_details (
      runid bigserial primary key, jobid bigint not null, status text not null,
      return_message text, start_time timestamptz, end_time timestamptz)`);
  await t.sql(`
    create or replace function cron.schedule(job_name text, schedule text, command text)
    returns bigint language sql as $$
      insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid
    $$`);
  await t.sql(`
    create or replace function cron.unschedule(job_id bigint)
    returns boolean language sql as $$
      with d as (delete from cron.job where jobid = job_id returning 1) select exists (select 1 from d)
    $$`);
  for (const job of jobs) await t.sql(`insert into cron.job (jobname) values ($1)`, [job]);
};

/** One run of `job`, started `minutesAgo` minutes before `at`. */
const run = (job, minutesAgo, status = 'succeeded', message = '1 row', at = AT) =>
  t.sql(
    `insert into cron.job_run_details (jobid, status, return_message, start_time, end_time)
     select jobid, $2, $3, $4::timestamptz - $5::float8 * interval '1 minute',
            $4::timestamptz - $5::float8 * interval '1 minute' + interval '10 ms'
       from cron.job where jobname = $1`,
    [job, status, message, at, minutesAgo],
  );

/** A succeeded run one minute ago for every job. */
const allHealthy = async (at = AT) => {
  for (const job of JOBS) await run(job, 1, 'succeeded', '1 row', at);
};

const observe = async (at = AT) => {
  const { rows } = await t.sql(`select * from _ops_observe($1::timestamptz)`, [at]);
  return Object.fromEntries(rows.map((r) => [r.check_name, r]));
};
const statuses = async (at = AT) =>
  Object.fromEntries(Object.entries(await observe(at)).map(([k, v]) => [k, v.status]));
const tick = async (at = AT) =>
  (await t.sql(`select ops_health_tick($1::timestamptz) as r`, [at])).rows[0].r;
const alerts = async () =>
  (
    await t.sql(
      `select check_name, status, opened_at, closed_at, close_reason, reopened, detail
         from ops_alerts order by id`,
    )
  ).rows;
const minutesAfter = (m, at = AT) => new Date(Date.parse(at) + m * 60_000).toISOString();

const mute = (checks) =>
  t.sql(`update app_config set value = $1::jsonb where key = 'ops.alert_muted_checks'`, [
    JSON.stringify(checks),
  ]);

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

afterEach(async () => {
  await t.sql(`drop schema if exists cron cascade`);
  await t.sql(`drop schema if exists net cascade`);
  await t.sql(`drop schema if exists vault cascade`);
  await t.sql(`delete from ops_alerts`);
  await mute([]);
  await t.sql(`update app_config set value = '"nonprod"'::jsonb where key = 'env.name'`);
  await t.sql(
    `update app_config set value = 'false'::jsonb where key = 'welcome.delivery_enabled'`,
  );
  await t.sql(`delete from push_outbox`);
});

// ---------------------------------------------------------------------------

describe('the migration', () => {
  it('applies with no pg_cron, pg_net or vault, schedules nothing, and says every job is missing', async () => {
    assert.ok(
      t.appliedMigrations.includes(MIGRATION),
      'the harness did not apply the migration',
    );
    const { rows } = await t.sql(`select check_name, status, detail from ops_job_health()`);
    assert.deepEqual(
      rows.map((r) => r.check_name),
      CHECKS,
    );
    for (const r of rows.slice(0, JOBS.length)) {
      assert.equal(r.status, 'missing', r.check_name);
      assert.deepEqual(r.detail, { reason: 'pg_cron_unavailable' });
    }
    assert.deepEqual(
      rows.slice(JOBS.length).map((r) => [r.check_name, r.status]),
      [
        ['push-outbox', 'ok'],
        ['import-queue', 'ok'],
        ['welcome-dispatch-github', 'info'],
      ],
    );
  });

  it('seeds an empty mute list, so nothing is muted until somebody says so', async () => {
    const { rows } = await t.sql(
      `select value from app_config where key = 'ops.alert_muted_checks'`,
    );
    assert.deepEqual(rows, [{ value: [] }]);
  });

  it('creates security definer functions with a pinned search_path', async () => {
    const { rows } = await t.sql(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('ops_job_health', 'ops_health_tick', '_ops_observe')
        order by 1, 2`,
    );
    assert.deepEqual(
      rows.map((r) => [r.proname, r.args, r.prosecdef, r.proconfig]),
      [
        ['_ops_observe', 'p_at timestamp with time zone', true, ['search_path=public']],
        ['ops_health_tick', '', true, ['search_path=public']],
        ['ops_health_tick', 'p_at timestamp with time zone', true, ['search_path=public']],
        ['ops_job_health', '', true, ['search_path=public']],
      ],
    );
  });
});

describe('grants', () => {
  const FNS = [
    'ops_job_health()',
    'ops_health_tick()',
    'ops_health_tick(timestamptz)',
    '_ops_observe(timestamptz)',
    '_ops_expected_jobs()',
  ];

  it('no client role may execute any of the functions; service_role may only read', async () => {
    for (const fn of FNS) {
      const { rows } = await t.sql(
        `select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub,
                has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as service`,
        [fn],
      );
      assert.deepEqual(
        rows[0],
        { pub: false, anon: false, auth: false, service: fn === 'ops_job_health()' },
        fn,
      );
    }
    const refused = await t.asAnon(() => t.errorFrom(`select * from ops_job_health()`));
    assert.match(String(refused ?? ''), /permission denied/i);
    const tickRefused = await t.asRole('service_role', null, () =>
      t.errorFrom(`select ops_health_tick()`),
    );
    assert.match(
      String(tickRefused ?? ''),
      /permission denied/i,
      'service_role reached the tick',
    );
  });

  it('ops_alerts has RLS on, no policy, and no client privilege', async () => {
    const { rows } = await t.sql(
      `select c.relrowsecurity as rls,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
              has_table_privilege('anon', c.oid, 'select') as anon_select,
              has_table_privilege('authenticated', c.oid, 'select') as auth_select,
              has_table_privilege('authenticated', c.oid, 'insert') as auth_insert
         from pg_class c where c.oid = 'public.ops_alerts'::regclass`,
    );
    assert.deepEqual(rows[0], {
      rls: true,
      policies: 0,
      anon_select: false,
      auth_select: false,
      auth_insert: false,
    });
    const error = await t.asUser('00000000-0000-0000-0000-000000000001', () =>
      t.errorFrom(`select * from ops_alerts`),
    );
    assert.match(String(error ?? ''), /permission denied/i);
  });

  it('a service_role read of ops_job_health() works', async () => {
    await installCron();
    await allHealthy(new Date().toISOString());
    const rows = await t.asRole(
      'service_role',
      null,
      async () => (await t.sql(`select check_name, status from ops_job_health()`)).rows,
    );
    assert.equal(rows.length, CHECKS.length);
    assert.ok(
      rows.slice(0, JOBS.length).every((r) => r.status === 'ok'),
      JSON.stringify(rows),
    );
  });
});

describe('classification', () => {
  beforeEach(() => installCron());

  it('ok: every job ran inside its interval and its last run succeeded', async () => {
    await allHealthy();
    const s = await statuses();
    for (const job of JOBS) assert.equal(s[job], 'ok', job);
    const o = await observe();
    assert.equal(o['bingd-push-drain'].consecutive_failures, 0);
    assert.equal(o['bingd-push-drain'].detail.last_status, 'succeeded');
  });

  it('late: the last run is older than the allowed gap, or there is no run', async () => {
    await allHealthy();
    await run('bingd-release-refresh', 80); // allowed 75 minutes
    await t.sql(
      `delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'bingd-release-refresh')
         and start_time > $1::timestamptz - interval '5 minutes'`,
      [AT],
    );
    await t.sql(
      `delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'bingd-welcome-dispatch')`,
    );
    const s = await statuses();
    assert.equal(s['bingd-release-refresh'], 'late');
    assert.equal(s['bingd-welcome-dispatch'], 'late');
    assert.equal(s['bingd-import-drain'], 'ok');

    // 74 minutes is inside the gap.
    assert.equal((await statuses(minutesAfter(-6)))['bingd-release-refresh'], 'ok');
  });

  it('failing: the last finished run failed, counting failures since the last success', async () => {
    await allHealthy();
    await run('bingd-push-drain', 0.5, 'failed', 'push drain: not configured');
    await run('bingd-push-drain', 0.2, 'failed', 'push drain: not configured again');
    const o = await observe();
    assert.equal(o['bingd-push-drain'].status, 'failing');
    assert.equal(o['bingd-push-drain'].consecutive_failures, 2);
    assert.equal(o['bingd-push-drain'].detail.last_error, 'push drain: not configured again');
    assert.equal(o['bingd-push-drain'].detail.last_status, 'failed');

    // A run still going after the failures does not hide them.
    await run('bingd-push-drain', 0.1, 'running', null);
    assert.equal((await statuses())['bingd-push-drain'], 'failing');

    // A success after them clears it, and the old error is not reported.
    await run('bingd-push-drain', 0, 'succeeded');
    const after = await observe();
    assert.equal(after['bingd-push-drain'].status, 'ok');
    assert.equal(after['bingd-push-drain'].detail.last_error, undefined);
  });

  it('missing: the job is not scheduled, or is paused', async () => {
    await allHealthy();
    await t.sql(`delete from cron.job where jobname = 'bingd-release-evaluate'`);
    await t.sql(`update cron.job set active = false where jobname = 'bingd-import-drain'`);
    const o = await observe();
    assert.equal(o['bingd-release-evaluate'].status, 'missing');
    assert.equal(o['bingd-release-evaluate'].detail.reason, 'not_scheduled');
    assert.equal(o['bingd-import-drain'].status, 'missing');
    assert.equal(o['bingd-import-drain'].detail.reason, 'inactive');
  });

  it('reads cron history through the last 5,000 runids, not the whole table', async () => {
    await allHealthy();
    // 5,000 newer runs of the drain push the hourly job's run out of the window.
    await t.sql(
      `insert into cron.job_run_details (jobid, status, start_time, end_time)
       select (select jobid from cron.job where jobname = 'bingd-import-drain'), 'succeeded',
              $1::timestamptz - interval '30 seconds', $1::timestamptz - interval '30 seconds'
         from generate_series(1, 5000)`,
      [AT],
    );
    const o = await observe();
    assert.equal(o['bingd-release-refresh'].status, 'late');
    assert.equal(o['bingd-release-refresh'].detail.runs_in_window, 0);
    assert.equal(o['bingd-import-drain'].detail.runs_in_window, 5000);

    const { rows } = await t.sql(`select prosrc from pg_proc where proname = '_ops_observe'`);
    assert.match(rows[0].prosrc, /max\(runid\), 0\) - 5000 from cron\.job_run_details/);
    assert.match(rows[0].prosrc, /where d\.runid > \$1/);
  });

  it('the push outbox is late once a row is older than 15 minutes', async () => {
    await allHealthy();
    const user = await t.createUser({ username: 'ops_outbox_reader' });
    const { rows: n } = await t.sql(
      `insert into notifications (recipient_id, type) values ($1, 'follow') returning id`,
      [user],
    );
    await t.sql(`delete from push_outbox`);
    await t.sql(
      `insert into push_outbox (notification_id, recipient_id, created_at) values ($1, $2, $3::timestamptz - interval '16 minutes')`,
      [n[0].id, user, AT],
    );
    const o = await observe();
    assert.equal(o['push-outbox'].status, 'late');
    assert.deepEqual(o['push-outbox'].detail, { queued: 1, oldest_age_s: 960 });
    assert.equal((await statuses(minutesAfter(-2)))['push-outbox'], 'ok');
  });

  it('the import queue is late once an open job is older than 15 minutes', async () => {
    const user = await t.createUser({ username: 'ops_import_reader' });
    const { rows: cols } = await t.sql(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'import_jobs' and is_nullable = 'NO' and column_default is null`,
    );
    assert.deepEqual(
      cols.map((c) => c.column_name).sort(),
      ['user_id'],
      'import_jobs grew a required column',
    );
    await t.sql(
      `insert into import_jobs (user_id, created_at) values ($1, $2::timestamptz - interval '20 minutes')`,
      [user, AT],
    );
    try {
      const o = await observe();
      assert.equal(o['import-queue'].status, 'late');
      assert.deepEqual(o['import-queue'].detail, { open: 1, older_than_15m: 1 });
    } finally {
      await t.sql(`delete from import_jobs where user_id = $1`, [user]);
    }
  });

  it("the welcome dispatcher is informational: its gates, and GitHub's last answer", async () => {
    let o = await observe();
    assert.deepEqual(o['welcome-dispatch-github'].detail, { dispatcher: 'not_production' });
    assert.equal(o['welcome-dispatch-github'].status, 'info');

    await t.sql(`update app_config set value = '"prod"'::jsonb where key = 'env.name'`);
    assert.equal((await observe())['welcome-dispatch-github'].detail.dispatcher, 'disabled');
    await t.sql(
      `update app_config set value = 'true'::jsonb where key = 'welcome.delivery_enabled'`,
    );
    assert.equal(
      (await observe())['welcome-dispatch-github'].detail.dispatcher,
      'unconfigured',
    );

    await t.sql(`create schema vault`);
    await t.sql(`create table vault.secrets (name text primary key, secret text)`);
    await t.sql(
      `insert into vault.secrets values ('welcome_dispatch_github_token', 'fixture-not-real')`,
    );
    await t.sql(`create schema net`);
    await t.sql(`
      create table net._http_response (id bigserial primary key, status_code integer, content_type text,
        headers jsonb, content text, timed_out boolean, error_msg text, created timestamptz not null default now())`);
    await t.sql(
      `insert into net._http_response (status_code, headers, created) values
         (200, '{"Content-Type": "application/json"}', $1::timestamptz - interval '5 minutes'),
         (401, '{"X-GitHub-Request-Id": "abc"}', $1::timestamptz - interval '20 minutes'),
         (204, '{"x-github-request-id": "def"}', $1::timestamptz - interval '7 hours')`,
      [AT],
    );
    // 300 newer answers from the other posters do not hide GitHub's.
    await t.sql(
      `insert into net._http_response (status_code, headers, created)
       select 200, '{"Content-Type": "application/json"}', $1::timestamptz - interval '1 minute'
         from generate_series(1, 300)`,
      [AT],
    );
    o = await observe();
    assert.equal(o['welcome-dispatch-github'].status, 'info', 'a GitHub 401 is not an alert');
    assert.equal(o['welcome-dispatch-github'].detail.dispatcher, 'configured');
    assert.equal(o['welcome-dispatch-github'].detail.last_github_answer.status_code, 401);
    assert.ok(!JSON.stringify(o).includes('fixture-not-real'), 'the token reached the output');
  });
});

describe('the tick: transitions only', () => {
  const PUSH = 'bingd-push-drain';

  /**
   * A tick `m` minutes after AT, with every job except `except` having just run, so the
   * minute-cadence jobs are not late merely because the test clock moved.
   */
  const later = async (m, except = [PUSH]) => {
    for (const job of JOBS) {
      if (!except.includes(job)) await run(job, 0.5, 'succeeded', '1 row', minutesAfter(m));
    }
    return tick(minutesAfter(m));
  };
  /** A run of the push drain `m` minutes after AT. */
  const push = (m, status, message = '1 row') =>
    run(PUSH, 0.1, status, message, minutesAfter(m));

  beforeEach(async () => {
    await installCron();
    await allHealthy();
  });

  it('opens nothing while everything is ok', async () => {
    assert.deepEqual(await tick(), {
      status: 'ok',
      checked: CHECKS.length,
      opened: 0,
      reopened: 0,
      closed: 0,
      open: 0,
    });
    assert.deepEqual(await alerts(), []);
  });

  it('opens one alert when a job fails, and repeated ticks do not add another', async () => {
    await push(0, 'failed', 'boom');
    assert.equal((await tick()).opened, 1);
    for (let i = 1; i <= 3; i += 1) {
      await push(i * 10, 'failed', 'boom');
      const r = await later(i * 10);
      assert.deepEqual([r.opened, r.reopened, r.closed, r.open], [0, 0, 0, 1], `tick ${i}`);
    }
    const rows = await alerts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].check_name, PUSH);
    assert.equal(rows[0].status, 'failing');
    assert.equal(rows[0].closed_at, null);
    assert.equal(rows[0].detail.last_error, 'boom');
    assert.equal(rows[0].detail.consecutive_failures, 4);
  });

  it('closes the alert when the job recovers, once', async () => {
    await push(0, 'failed', 'boom');
    await tick();
    await push(10, 'succeeded');
    const r = await later(10);
    assert.deepEqual([r.closed, r.open], [1, 0]);
    const [row] = await alerts();
    assert.equal(row.close_reason, 'recovered');
    assert.equal(row.closed_at.toISOString(), minutesAfter(10));
    await push(20, 'succeeded');
    assert.equal((await later(20)).closed, 0, 'a closed alert closed again');
  });

  it('keeps one row when a late job starts failing, with the latest status', async () => {
    await t.sql(
      `delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'bingd-release-refresh')`,
    );
    await tick();
    assert.equal((await alerts())[0].status, 'late');
    await run('bingd-release-refresh', 0.1, 'failed', 'refresh failed', minutesAfter(10));
    await later(10, ['bingd-release-refresh']);
    const rows = await alerts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failing');
  });

  it('a relapse within an hour of recovering reopens the same row; after an hour, a new one', async () => {
    await push(0, 'failed', 'boom');
    await tick();
    await push(10, 'succeeded');
    await later(10);
    await push(20, 'failed', 'boom again');
    const relapse = await later(20);
    assert.deepEqual([relapse.opened, relapse.reopened], [0, 1]);
    let rows = await alerts();
    assert.equal(rows.length, 1, 'a flap within the hour wrote a second row');
    assert.equal(rows[0].reopened, 1);
    assert.equal(rows[0].closed_at, null);
    assert.equal(
      rows[0].opened_at.toISOString(),
      new Date(AT).toISOString(),
      'reopening moved the start',
    );

    // Recover at +30, fail again at +91: more than an hour later, a new incident.
    await push(30, 'succeeded');
    await later(30);
    await push(91, 'failed', 'a new day');
    const next = await later(91);
    assert.deepEqual([next.opened, next.reopened], [1, 0]);
    rows = await alerts();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].close_reason, 'recovered');
    assert.equal(rows[1].closed_at, null);
  });

  it('at most one open alert per check, whatever writes it', async () => {
    await push(0, 'failed', 'boom');
    await tick();
    const error = await t.errorFrom(
      `insert into ops_alerts (check_name, status, opened_at, last_seen_at) values ('bingd-push-drain', 'late', now(), now())`,
    );
    assert.match(String(error ?? ''), /ops_alerts_one_open/);
  });

  it('a muted check opens nothing, and muting closes an open alert as muted', async () => {
    await push(0, 'failed', 'boom');
    await t.sql(`delete from cron.job where jobname = 'bingd-welcome-dispatch'`);
    await mute(['bingd-welcome-dispatch']);
    assert.equal((await tick()).opened, 1);
    assert.deepEqual(
      (await alerts()).map((a) => a.check_name),
      [PUSH],
    );
    assert.equal((await observe())['bingd-welcome-dispatch'].muted, true);
    assert.equal(
      (await observe())['bingd-welcome-dispatch'].status,
      'missing',
      'muting hid the status',
    );

    await mute(['bingd-welcome-dispatch', PUSH]);
    await push(10, 'failed', 'boom');
    assert.equal((await later(10)).closed, 1);
    assert.equal((await alerts())[0].close_reason, 'muted');
  });

  it('closes an alert for a check this version no longer reports, as retired', async () => {
    await t.sql(
      `insert into ops_alerts (check_name, status, opened_at, last_seen_at) values ('bingd-old-job', 'late', now(), now())`,
    );
    await tick();
    const [row] = await alerts();
    assert.equal(row.close_reason, 'retired');
  });

  it('delivers nothing: no notification and no push is written', async () => {
    const counts = async () =>
      (
        await t.sql(
          `select (select count(*) from notifications)::int as n, (select count(*) from push_outbox)::int as p`,
        )
      ).rows[0];
    const before = await counts();
    await push(0, 'failed', 'boom');
    await t.sql(`delete from cron.job where jobname = 'bingd-release-refresh'`);
    await tick();
    await push(10, 'succeeded');
    await later(10);
    assert.deepEqual(await counts(), before);
    assert.deepEqual(
      (await alerts()).map((a) => [a.check_name, a.close_reason]),
      [
        [PUSH, 'recovered'],
        ['bingd-release-refresh', null],
      ],
    );
  });
});

describe('the tick never raises', () => {
  it('records its own failure as an open bingd-ops-health alert, and the next good tick closes it', async () => {
    await installCron();
    await allHealthy();
    await t.sql(`alter table cron.job_run_details rename column return_message to message`);

    const r = await tick();
    assert.equal(r.status, 'error');
    assert.equal(r.sqlstate, '42703');
    const [row] = await alerts();
    assert.equal(row.check_name, 'bingd-ops-health');
    assert.equal(row.status, 'failing');
    assert.equal(row.detail.tick_error, '42703');
    assert.equal((await alerts()).length, 1);

    // The readout does not raise either: it reports the health tick as failing, with the
    // error, and the open alerts beside it.
    await t.sql(
      `insert into ops_alerts (check_name, status, opened_at, last_seen_at) values ('bingd-push-drain', 'late', now(), now())`,
    );
    const { rows: readout } = await t.sql(
      `select check_name, kind, status, alert_open_since, detail from ops_job_health()`,
    );
    assert.deepEqual(
      readout.map((x) => [x.check_name, x.kind, x.status]),
      [
        ['bingd-ops-health', 'cron', 'failing'],
        ['bingd-push-drain', 'alert', 'late'],
      ],
    );
    assert.equal(readout[0].detail.observe_error, '42703');
    assert.equal(readout[0].detail.tick_error, '42703');
    assert.ok(readout[0].alert_open_since);
    await t.sql(`delete from ops_alerts where check_name = 'bingd-push-drain'`);

    // It fails again: still one row.
    assert.equal((await tick(minutesAfter(10))).status, 'error');
    assert.equal((await alerts()).length, 1);

    await t.sql(`alter table cron.job_run_details rename column message to return_message`);
    await run('bingd-ops-health', 0, 'succeeded', '1 row', minutesAfter(20));
    const ok = await tick(minutesAfter(20));
    assert.equal(ok.status, 'ok');
    assert.equal(ok.closed, 1);
    assert.equal((await alerts())[0].close_reason, 'recovered');
  });

  it('ops_job_health() shows a tick error as bingd-ops-health failing, though its cron run succeeded', async () => {
    await installCron();
    await allHealthy(new Date().toISOString());
    await t.sql(
      `insert into ops_alerts (check_name, status, opened_at, last_seen_at, detail)
       values ('bingd-ops-health', 'failing', now(), now(), '{"tick_error": "XX000", "message": "boom"}')`,
    );
    const { rows } = await t.sql(
      `select * from ops_job_health() where check_name = 'bingd-ops-health'`,
    );
    assert.equal(rows[0].status, 'failing');
    assert.equal(rows[0].detail.tick_error, 'XX000');
    assert.ok(rows[0].alert_open_since);
  });

  it('runs with no pg_cron at all, and calls every job missing', async () => {
    const r = await tick();
    assert.equal(r.status, 'ok');
    assert.equal(r.opened, JOBS.length);
  });
});

describe('the schedule', () => {
  it('is installed every ten minutes off the minute, and re-applying keeps one job', async () => {
    await installCron(['bingd-push-drain']);
    await t.sql(
      `insert into cron.job (jobname, schedule, command) values ('bingd-ops-health', '* * * * *', 'select 1')`,
    );

    const sql = await migrationSql(MIGRATION);
    await t.exec(sql);
    await t.exec(sql);

    const { rows } = await t.sql(
      `select jobname, schedule, command, active from cron.job order by jobname`,
    );
    assert.deepEqual(rows, [
      {
        jobname: 'bingd-ops-health',
        schedule: '3,13,23,33,43,53 * * * *',
        command: 'select public.ops_health_tick()',
        active: true,
      },
      { jobname: 'bingd-push-drain', schedule: '* * * * *', command: 'select 1', active: true },
    ]);
  });

  it('re-applying keeps the alert history and the operator mute list', async () => {
    await mute(['import-queue']);
    await t.sql(
      `insert into ops_alerts (check_name, status, opened_at, last_seen_at) values ('bingd-push-drain', 'late', now(), now())`,
    );
    await t.exec(await migrationSql(MIGRATION));
    assert.equal((await alerts()).length, 1);
    const { rows } = await t.sql(
      `select value from app_config where key = 'ops.alert_muted_checks'`,
    );
    assert.deepEqual(rows[0].value, ['import-queue']);
  });
});

describe('the rollback', () => {
  it('removes the job, the functions, the table and the key; the migration applies again', async () => {
    await installCron(['bingd-push-drain']);
    await t.exec(await migrationSql(MIGRATION));

    await t.exec(await readFile(ROLLBACK, 'utf8'));

    const { rows: jobs } = await t.sql(`select jobname from cron.job order by jobname`);
    assert.deepEqual(
      jobs.map((r) => r.jobname),
      ['bingd-push-drain'],
      'the rollback touched another job',
    );
    const { rows: left } = await t.sql(
      `select (select count(*)::int from pg_proc where proname in ('ops_job_health', 'ops_health_tick', '_ops_observe', '_ops_expected_jobs')) as fns,
              to_regclass('public.ops_alerts') as tbl,
              (select count(*)::int from app_config where key = 'ops.alert_muted_checks') as keys`,
    );
    assert.deepEqual(left[0], { fns: 0, tbl: null, keys: 0 });

    await t.exec(await migrationSql(MIGRATION));
    const { rows: again } = await t.sql(
      `select count(*)::int as n from cron.job where jobname = 'bingd-ops-health'`,
    );
    assert.equal(again[0].n, 1);
    const { rows: grant } = await t.sql(
      `select has_function_privilege('anon', 'ops_job_health()', 'execute') as anon,
              has_function_privilege('authenticated', 'ops_health_tick()', 'execute') as auth,
              has_table_privilege('authenticated', 'ops_alerts', 'select') as tbl,
              (select relrowsecurity from pg_class where oid = 'public.ops_alerts'::regclass) as rls`,
    );
    assert.deepEqual(
      grant[0],
      { anon: false, auth: false, tbl: false, rls: true },
      're-applying re-opened a grant',
    );
  });

  it('runs cleanly where pg_cron is absent', async () => {
    await t.exec(await readFile(ROLLBACK, 'utf8'));
    assert.equal((await t.sql(`select to_regclass('public.ops_alerts') as t`)).rows[0].t, null);
    await t.exec(await migrationSql(MIGRATION));
    assert.equal(
      (await t.sql(`select count(*)::int as n from ops_job_health()`)).rows[0].n,
      CHECKS.length,
    );
  });
});
