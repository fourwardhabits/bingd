import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb, migrationSql } from './harness.mjs';

/**
 * Operator alert delivery, `20261130000700`. DRAFT.
 *
 * `_ops_alert_ping()` (pg_cron `bingd-ops-alert`) sends the current state of two checks to
 * an external dead-man's-switch provider: `bingd-heartbeat` (the health tick is alive and
 * healthy) and `bingd-alerts` (an actionable `ops_alerts` incident is open). The provider
 * turns states into emails; what is pinned here is the state, and every case where nothing
 * may be sent.
 *
 *   - the signal: a one-tick blip is not actionable, two ticks are, a recovery holds for an
 *     hour, muted and retired do not, the tick's own alert is the heartbeat's;
 *   - the gates: nonprod never reads the Vault, a missing, blank or malformed key sends
 *     nothing, configured without pg_net raises;
 *   - the request: literal host, the key only in the path, no `detail` in the body;
 *   - grants, idempotent scheduling that touches no other job, and the rollback.
 *
 * PGlite has no pg_cron, pg_net or vault. Each test builds the stand-ins it needs.
 * NO SECRET, ANYWHERE: the key below is a fixture string.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const MIGRATION = '20261130000700_an_alert_that_leaves_the_database.sql';
const ROLLBACK = join(root, 'docs', 'release', 'ops-alert', 'rollback-20261130000700.sql');
const KEY = 'fixtureKey_not-real_0123';
const BASE = `https://hc-ping.com/${KEY}/`;
const AT = '2026-11-20T12:05:00Z';

const JOBS = [
  'bingd-import-drain',
  'bingd-import-maintenance',
  'bingd-push-drain',
  'bingd-release-evaluate',
  'bingd-release-refresh',
  'bingd-welcome-dispatch',
  'bingd-ops-health',
];

let t;

const minutesBefore = (m, at = AT) => new Date(Date.parse(at) - m * 60_000).toISOString();

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

/** Every job ran and succeeded one minute before AT: the health tick is healthy. */
const healthyCron = async () => {
  await installCron();
  await t.sql(
    `insert into cron.job_run_details (jobid, status, return_message, start_time, end_time)
     select jobid, 'succeeded', '1 row', $1::timestamptz - interval '1 minute',
            $1::timestamptz - interval '1 minute' + interval '10 ms'
       from cron.job`,
    [AT],
  );
};

const installVault = async (name, value = KEY) => {
  await t.sql(`create schema if not exists vault`);
  await t.sql(`create table if not exists vault.secrets (name text primary key, secret text not null)`);
  await t.sql(
    `create or replace view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets`,
  );
  if (name !== undefined) {
    await t.sql(`insert into vault.secrets (name, secret) values ($1, $2)`, [name, value]);
  }
};

const installNet = async () => {
  await t.sql(`create schema if not exists net`);
  await t.sql(
    `create table if not exists net.posts (id bigserial, url text, body jsonb, params jsonb, headers jsonb, timeout integer)`,
  );
  await t.sql(`
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                                             headers jsonb default '{}', timeout_milliseconds integer default 5000)
    returns bigint language sql as $$
      insert into net.posts (url, body, params, headers, timeout)
      values (url, body, params, headers, timeout_milliseconds) returning id
    $$`);
};

const setEnv = (name) =>
  t.sql(`update app_config set value = to_jsonb($1::text) where key = 'env.name'`, [name]);

const configureProduction = async () => {
  await setEnv('prod');
  await healthyCron();
  await installVault('ops_alert_ping_key');
  await installNet();
};

/** An ops_alerts row, times in minutes before AT. closedAgo null = still open. */
const alert = (check, { openedAgo, seenAgo = openedAgo, closedAgo = null, reason = null, status = 'late', reopened = 0, detail = {} }) =>
  t.sql(
    `insert into ops_alerts (check_name, status, opened_at, last_seen_at, closed_at, close_reason, reopened, detail)
     values ($1, $2, $3::timestamptz - $4::float8 * interval '1 minute',
             $3::timestamptz - $5::float8 * interval '1 minute',
             $3::timestamptz - $6::float8 * interval '1 minute', $7, $8, $9::jsonb)`,
    [check, status, AT, openedAgo, closedAgo ?? seenAgo, closedAgo, reason, reopened, JSON.stringify(detail)],
  );

const signal = async (at = AT) => (await t.sql(`select _ops_alert_signal($1::timestamptz) as s`, [at])).rows[0].s;
const ping = async (at = AT) => (await t.sql(`select _ops_alert_ping($1::timestamptz) as r`, [at])).rows[0].r;
const posts = async () => (await t.sql(`select url, body, headers, timeout from net.posts order by id`)).rows;

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
  await t.sql(`update app_config set value = '[]'::jsonb where key = 'ops.alert_muted_checks'`);
  await setEnv('nonprod');
});

// ---------------------------------------------------------------------------

describe('the migration', () => {
  it('applies with no pg_cron, pg_net or vault, and schedules nothing', async () => {
    assert.ok(t.appliedMigrations.includes(MIGRATION), 'the harness did not apply the migration');
    assert.equal((await t.sql(`select to_regclass('cron.job') as j`)).rows[0].j, null);
  });

  it('creates owner-only security definer functions with a pinned search_path', async () => {
    const { rows } = await t.sql(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('_ops_alert_ping', '_ops_alert_signal')
        order by 1, 2`,
    );
    assert.deepEqual(
      rows.map((r) => `${r.proname}(${r.args})`),
      ['_ops_alert_ping()', '_ops_alert_ping(p_at timestamp with time zone)', '_ops_alert_signal(p_at timestamp with time zone)'],
    );
    for (const r of rows) {
      assert.equal(r.prosecdef, true);
      assert.deepEqual(r.proconfig, ['search_path=public']);
    }
    for (const fn of ['_ops_alert_ping()', '_ops_alert_ping(timestamptz)', '_ops_alert_signal(timestamptz)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const { rows: p } = await t.sql(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn]);
        assert.equal(p[0].ok, false, `${role} may execute ${fn}`);
      }
    }

    await configureProduction();
    const refusals = [
      await t.asAnon(() => t.errorFrom(`select _ops_alert_ping()`)),
      await t.asUser('00000000-0000-0000-0000-000000000001', () => t.errorFrom(`select _ops_alert_ping()`)),
      await t.asRole('service_role', null, () => t.errorFrom(`select _ops_alert_ping()`)),
    ];
    for (const e of refusals) assert.match(String(e ?? ''), /permission denied/i);
    assert.equal((await posts()).length, 0, 'a refused caller still caused a request');
  });
});

describe('the signal', () => {
  it('is ok and ok when the tick is healthy and nothing is open', async () => {
    await healthyCron();
    assert.deepEqual(await signal(), {
      heartbeat: 'ok', ops_health: 'ok', alerts: 'ok', open: [], recovering: [],
    });
  });

  it('fails the heartbeat when the health tick is late, missing, or has its own open alert', async () => {
    await installCron();
    // Every job ran a minute ago except the tick, which last ran 40 minutes ago.
    await t.sql(
      `insert into cron.job_run_details (jobid, status, start_time, end_time)
       select jobid, 'succeeded',
              $1::timestamptz - case when jobname = 'bingd-ops-health' then interval '40 minutes' else interval '1 minute' end,
              $1::timestamptz - case when jobname = 'bingd-ops-health' then interval '40 minutes' else interval '1 minute' end
         from cron.job`,
      [AT],
    );
    let s = await signal();
    assert.equal(s.heartbeat, 'fail');
    assert.equal(s.ops_health, 'late');
    assert.equal(s.alerts, 'ok', 'the tick stopping is the heartbeat, not an alert');

    await t.sql(`drop schema cron cascade`);
    assert.equal((await signal()).heartbeat, 'fail', 'no pg_cron at all reads as missing');

    await healthyCron();
    await alert('bingd-ops-health', { openedAgo: 30, seenAgo: 2, status: 'failing', detail: { tick_error: '42P01' } });
    s = await signal();
    assert.equal(s.ops_health, 'ok', 'pg_cron says the tick ran');
    assert.equal(s.heartbeat, 'fail', 'a caught tick error is visible only as its own alert');
    assert.equal(s.alerts, 'ok', 'and it is not counted twice');

    await t.sql(`update ops_alerts set closed_at = $1::timestamptz - interval '5 minutes', close_reason = 'recovered'`, [AT]);
    s = await signal();
    assert.equal(s.heartbeat, 'ok', 'the tick recovered');
    assert.equal(s.alerts, 'ok', 'its recovery is not held on the alerts check either');
  });

  it('does not alert on a one-tick blip, and does on the second tick', async () => {
    await healthyCron();
    await alert('bingd-push-drain', { openedAgo: 2 });
    assert.equal((await signal()).alerts, 'ok', 'opened on the last tick only');

    await t.sql(`update ops_alerts set opened_at = opened_at - interval '10 minutes'`);
    const s = await signal();
    assert.equal(s.alerts, 'fail');
    assert.deepEqual(s.open.map((o) => [o.check, o.status]), [['bingd-push-drain', 'late']]);
  });

  it('alerts at once on a relapse folded into an older row', async () => {
    await healthyCron();
    // Reopened on the last tick: opened_at is the original incident's.
    await alert('import-queue', { openedAgo: 50, seenAgo: 2, reopened: 1 });
    assert.equal((await signal()).alerts, 'fail');
  });

  it('holds a recovery for an hour, so a flapping job is one down and one up', async () => {
    await healthyCron();
    // Open for 30 minutes, recovered 20 minutes ago.
    await alert('bingd-release-evaluate', { openedAgo: 50, closedAgo: 20, reason: 'recovered' });
    let s = await signal();
    assert.equal(s.alerts, 'fail');
    assert.deepEqual(s.open, []);
    assert.equal(s.recovering[0].check, 'bingd-release-evaluate');

    assert.equal((await signal(new Date(Date.parse(AT) + 35 * 60_000).toISOString())).alerts, 'fail',
      '55 minutes after recovering, still the same incident');

    assert.equal((await signal(new Date(Date.parse(AT) + 41 * 60_000).toISOString())).alerts, 'ok',
      'an hour after recovering, it is over');
  });

  it('does not hold a blip that recovered, or a muted or retired close', async () => {
    await healthyCron();
    await alert('bingd-push-drain', { openedAgo: 12, closedAgo: 2, reason: 'recovered' });
    await alert('bingd-import-drain', { openedAgo: 60, closedAgo: 5, reason: 'muted' });
    await alert('bingd-old-job', { openedAgo: 60, closedAgo: 5, reason: 'retired' });
    assert.equal((await signal()).alerts, 'ok');
  });

  it('never carries detail, last_error or anything but names, statuses and times', async () => {
    await healthyCron();
    await alert('bingd-push-drain', {
      openedAgo: 30, seenAgo: 2, status: 'failing',
      detail: { last_error: 'Key (user_id)=(00000000-0000-0000-0000-00000000beef) already exists' },
    });
    const s = await signal();
    assert.equal(s.alerts, 'fail');
    assert.deepEqual(Object.keys(s.open[0]).sort(), ['check', 'reopened', 'since', 'status']);
    assert.doesNotMatch(JSON.stringify(s), /beef|last_error|user_id/);
  });

  it('fails the heartbeat, with no alert state, when the observation itself fails', async () => {
    await installCron();
    // A cron.job_run_details without the columns _ops_observe reads.
    await t.sql(`alter table cron.job_run_details drop column start_time`);
    const s = await signal();
    assert.equal(s.heartbeat, 'fail');
    assert.equal(s.alerts, null);
    assert.equal(s.reason, 'observe_error');
  });
});

describe('when it sends nothing', () => {
  it('does nothing on a nonprod database, and does not even read the Vault', async () => {
    await configureProduction();
    await setEnv('nonprod');
    // A Vault that raises on read: a nonprod call must not reach it.
    await t.sql(`drop view vault.decrypted_secrets`);
    await t.sql(`create function vault.boom() returns text language plpgsql as $$ begin raise exception 'vault read'; end $$`);
    await t.sql(`create view vault.decrypted_secrets as select name, vault.boom() as decrypted_secret from vault.secrets`);
    assert.deepEqual(await ping(), { status: 'not_production' });
    assert.equal((await posts()).length, 0);
  });

  it('does nothing with no Vault, no key, or a blank key', async () => {
    await setEnv('prod');
    await healthyCron();
    await installNet();
    assert.deepEqual(await ping(), { status: 'unconfigured' }, 'no Vault');
    await installVault();
    assert.deepEqual(await ping(), { status: 'unconfigured' }, 'no key');
    await installVault('ops_alert_ping_key', ' \n');
    assert.deepEqual(await ping(), { status: 'unconfigured' }, 'blank key');
    assert.equal((await posts()).length, 0);
  });

  it('does nothing with a key that could change the path or the host', async () => {
    await setEnv('prod');
    await healthyCron();
    await installNet();
    await installVault('ops_alert_ping_key', 'x');
    for (const bad of ['short', '../../evil.example/abcdefghijkl', 'abcdefghijklmnop?x=1', 'abcdefghij klmnop', 'a'.repeat(65)]) {
      await t.sql(`update vault.secrets set secret = $1 where name = 'ops_alert_ping_key'`, [bad]);
      assert.deepEqual(await ping(), { status: 'invalid_key' }, bad);
    }
    assert.equal((await posts()).length, 0);
  });

  it('raises when fully configured with no pg_net, naming pg_net and not the key', async () => {
    await setEnv('prod');
    await healthyCron();
    await installVault('ops_alert_ping_key');
    const error = String(await t.errorFrom(`select _ops_alert_ping($1::timestamptz)`, [AT]));
    assert.match(error, /pg_net/);
    assert.doesNotMatch(error, new RegExp(KEY));
  });
});

describe('when it sends', () => {
  it('posts two successes when everything is healthy, to the literal host, key only in the path', async () => {
    await configureProduction();
    const r = await ping();
    assert.equal(r.status, 'posted');
    assert.equal(r.heartbeat, 'ok');
    assert.equal(r.alerts, 'ok');
    assert.equal(r.request_ids.length, 2);

    const sent = await posts();
    assert.deepEqual(sent.map((p) => p.url), [`${BASE}bingd-heartbeat`, `${BASE}bingd-alerts`]);
    for (const p of sent) {
      assert.equal(p.timeout, 10000);
      assert.doesNotMatch(JSON.stringify(p.body) + JSON.stringify(p.headers), new RegExp(KEY));
    }
    assert.deepEqual(sent[1].body.open, []);
  });

  it('posts /fail to the alerts check while an actionable incident is open, and success again after', async () => {
    await configureProduction();
    await alert('bingd-push-drain', { openedAgo: 30, seenAgo: 2, status: 'failing', detail: { last_error: 'boom' } });
    let r = await ping();
    assert.equal(r.alerts, 'fail');
    assert.equal(r.open, 1);
    let sent = await posts();
    assert.equal(sent[0].url, `${BASE}bingd-heartbeat`);
    assert.equal(sent[1].url, `${BASE}bingd-alerts/fail`);
    assert.equal(sent[1].body.open[0].check, 'bingd-push-drain');
    assert.doesNotMatch(JSON.stringify(sent[1].body), /boom/);

    // Recovered two hours later and stayed recovered for over an hour.
    await t.sql(`update ops_alerts set closed_at = $1::timestamptz - interval '61 minutes', close_reason = 'recovered'`, [AT]);
    await t.sql(`delete from net.posts`);
    r = await ping();
    assert.equal(r.alerts, 'ok');
    sent = await posts();
    assert.equal(sent[1].url, `${BASE}bingd-alerts`);
  });

  it('posts /fail to the heartbeat when the tick is unhealthy, and nothing for alerts when it cannot observe', async () => {
    await configureProduction();
    await alert('bingd-ops-health', { openedAgo: 2, status: 'failing', detail: { tick_error: 'XX000' } });
    await ping();
    let sent = await posts();
    assert.equal(sent[0].url, `${BASE}bingd-heartbeat/fail`);
    assert.equal(sent[1].url, `${BASE}bingd-alerts`);

    await t.sql(`delete from net.posts`);
    await t.sql(`alter table cron.job_run_details drop column start_time`);
    const r = await ping();
    assert.equal(r.heartbeat, 'fail');
    sent = await posts();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, `${BASE}bingd-heartbeat/fail`);
    assert.equal(sent[0].body.reason, 'observe_error');
  });

  it('trims a pasted newline around the key', async () => {
    await configureProduction();
    await t.sql(`update vault.secrets set secret = $1 where name = 'ops_alert_ping_key'`, [`${KEY}\n`]);
    await ping();
    assert.equal((await posts())[0].url, `${BASE}bingd-heartbeat`);
  });
});

describe('the schedule', () => {
  it('schedules one job by name, idempotently, and touches no other job', async () => {
    await installCron(['bingd-ops-health', 'bingd-push-drain']);
    const before = (await t.sql(`select jobid, jobname, schedule, command from cron.job order by jobid`)).rows;
    await t.exec(await migrationSql(MIGRATION));
    await t.exec(await migrationSql(MIGRATION));
    const { rows } = await t.sql(`select jobid, jobname, schedule, command from cron.job order by jobid`);
    assert.deepEqual(rows.slice(0, 2), before, 'another job changed');
    const mine = rows.filter((r) => r.jobname === 'bingd-ops-alert');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].schedule, '5,15,25,35,45,55 * * * *');
    assert.equal(mine[0].command, 'select public._ops_alert_ping()');
  });
});

describe('the rollback', () => {
  it('removes the job and the functions, keeps ops_alerts and the health tick; the migration applies again', async () => {
    await installCron(['bingd-ops-health']);
    await t.exec(await migrationSql(MIGRATION));
    await alert('bingd-push-drain', { openedAgo: 30, seenAgo: 2 });

    await t.exec(await readFile(ROLLBACK, 'utf8'));

    assert.deepEqual((await t.sql(`select jobname from cron.job`)).rows.map((r) => r.jobname), ['bingd-ops-health']);
    const { rows } = await t.sql(
      `select (select count(*)::int from pg_proc where proname in ('_ops_alert_ping', '_ops_alert_signal')) as fns,
              (select count(*)::int from ops_alerts) as alerts`,
    );
    assert.deepEqual(rows[0], { fns: 0, alerts: 1 });

    await t.exec(await migrationSql(MIGRATION));
    assert.equal((await t.sql(`select count(*)::int as n from cron.job where jobname = 'bingd-ops-alert'`)).rows[0].n, 1);
    const { rows: g } = await t.sql(
      `select has_function_privilege('anon', '_ops_alert_ping()', 'execute') as anon,
              has_function_privilege('service_role', '_ops_alert_signal(timestamptz)', 'execute') as svc`,
    );
    assert.deepEqual(g[0], { anon: false, svc: false }, 're-applying re-opened a grant');
  });
});
