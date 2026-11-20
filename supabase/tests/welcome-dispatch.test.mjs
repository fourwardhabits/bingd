import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb, migrationSql } from './harness.mjs';

/**
 * The welcome email's pg_cron dispatcher, `20261130000300`.
 *
 * `_dispatch_welcome_email()` asks GitHub to run `.github/workflows/welcome-email.yml` with
 * `target=production, mode=send`, once an hour, because GitHub's own `schedule:` starts this
 * repository's runs every five to ten hours. What matters here is the set of cases where it
 * must NOT post: not production, the email switched off, no token. Then, for the one case
 * where it does post, the exact request, and that the token reaches the Authorization header
 * and nothing else.
 *
 * PGlite has no `pg_cron`, `pg_net` or `vault`, so a bare replay is the "nothing installed"
 * case, and each test builds only the stand-ins it needs: a two-column
 * `vault.decrypted_secrets`, a `net.http_post` of pg_net's real signature that records what it
 * was asked to send, and a `cron.job` table with `schedule` / `unschedule` functions.
 *
 * NO SECRET, ANYWHERE. The token below is a fixture string.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const MIGRATION = '20261130000300_a_welcome_that_does_not_wait_for_github.sql';
const ROLLBACK = join(root, 'docs', 'release', 'welcome-dispatch', 'rollback-20261130000300.sql');
const TOKEN = 'fixture-token-not-real-0123456789';
const DISPATCH_URL =
  'https://api.github.com/repos/fourwardhabits/bingd/actions/workflows/welcome-email.yml/dispatches';

let t;

const dispatch = async () => (await t.sql(`select _dispatch_welcome_email() as r`)).rows[0].r;
const posts = async () => (await t.sql(`select url, body, params, headers, timeout from net.posts order by id`)).rows;

const setEnv = (name) =>
  t.sql(`update app_config set value = to_jsonb($1::text) where key = 'env.name'`, [name]);
const setDelivery = (on) =>
  t.sql(`update app_config set value = $1::jsonb where key = 'welcome.delivery_enabled'`, [
    on ? 'true' : 'false',
  ]);

const installVault = async (name, value = TOKEN) => {
  await t.sql(`create schema if not exists vault`);
  await t.sql(`create table if not exists vault.secrets (name text primary key, secret text not null)`);
  await t.sql(
    `create or replace view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets`,
  );
  if (name !== undefined) {
    await t.sql(`insert into vault.secrets (name, secret) values ($1, $2)`, [name, value]);
  }
};

/** pg_net's five-argument overload, which is the one the named-argument call binds to. */
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

const installCron = async () => {
  await t.sql(`create schema if not exists cron`);
  await t.sql(
    `create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true)`,
  );
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
};

const dropStandIns = async () => {
  await t.sql(`drop schema if exists vault cascade`);
  await t.sql(`drop schema if exists net cascade`);
  await t.sql(`drop schema if exists cron cascade`);
};

/** Everything a production dispatch needs. Each test then takes one piece away. */
const configureProduction = async () => {
  await setEnv('prod');
  await setDelivery(true);
  await installVault('welcome_dispatch_github_token');
  await installNet();
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

afterEach(async () => {
  await dropStandIns();
  await setEnv('nonprod');
  await setDelivery(false);
});

// ---------------------------------------------------------------------------

describe('the migration', () => {
  it('applies on a database with no pg_cron, pg_net or vault, and schedules nothing there', async () => {
    assert.ok(t.appliedMigrations.includes(MIGRATION), 'the harness did not apply the migration');
    const { rows } = await t.sql(`select to_regclass('cron.job') as job`);
    assert.equal(rows[0].job, null);
  });

  it('creates one parameterless security definer function with a pinned search_path', async () => {
    const { rows } = await t.sql(
      `select p.prosecdef, p.proconfig, pg_get_function_identity_arguments(p.oid) as args,
              pg_get_function_result(p.oid) as result
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = '_dispatch_welcome_email'`,
    );
    assert.equal(rows.length, 1, 'expected exactly one _dispatch_welcome_email');
    assert.equal(rows[0].prosecdef, true);
    assert.deepEqual(rows[0].proconfig, ['search_path=public']);
    assert.equal(rows[0].args, '', 'the dispatcher must take no input');
    assert.equal(rows[0].result, 'jsonb');
  });

  it('is executable by no client role and not by service_role', async () => {
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      const { rows } = await t.sql(
        role === 'public'
          ? `select exists (
               select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.proname = '_dispatch_welcome_email' and a.grantee = 0 and a.privilege_type = 'EXECUTE'
             ) as ok`
          : `select has_function_privilege($1, '_dispatch_welcome_email()', 'execute') as ok`,
        role === 'public' ? undefined : [role],
      );
      assert.equal(rows[0].ok, false, `${role} may execute _dispatch_welcome_email`);
    }

    await configureProduction();
    const call = () => t.errorFrom(`select _dispatch_welcome_email()`);
    const refusals = {
      anon: await t.asAnon(call),
      authenticated: await t.asUser('00000000-0000-0000-0000-000000000001', call),
      service_role: await t.asRole('service_role', null, call),
    };
    for (const [role, error] of Object.entries(refusals)) {
      assert.match(String(error ?? ''), /permission denied/i, `${role} reached the dispatcher`);
    }
    assert.equal((await posts()).length, 0, 'a refused caller still caused a request');
  });
});

describe('when it makes no request', () => {
  it('does nothing on a nonprod database, even with every other piece in place', async () => {
    await configureProduction();
    await setEnv('nonprod');

    assert.deepEqual(await dispatch(), { status: 'not_production' });
    assert.equal((await posts()).length, 0);
  });

  it('does nothing when env.name is missing, because missing means nonprod', async () => {
    await configureProduction();
    await t.sql(`delete from app_config where key = 'env.name'`);
    try {
      assert.deepEqual(await dispatch(), { status: 'not_production' });
      assert.equal((await posts()).length, 0);
    } finally {
      await t.sql(`insert into app_config (key, value) values ('env.name', '"nonprod"'::jsonb)`);
    }
  });

  it('does nothing when the welcome email is switched off', async () => {
    await configureProduction();
    await setDelivery(false);

    assert.deepEqual(await dispatch(), { status: 'disabled' });
    assert.equal((await posts()).length, 0);

    await t.sql(`delete from app_config where key = 'welcome.delivery_enabled'`);
    try {
      assert.deepEqual(await dispatch(), { status: 'disabled' }, 'a missing switch is off');
      assert.equal((await posts()).length, 0);
    } finally {
      await t.sql(`insert into app_config (key, value) values ('welcome.delivery_enabled', 'false'::jsonb)`);
    }
  });

  it('does nothing and returns cleanly when there is no Vault at all', async () => {
    await setEnv('prod');
    await setDelivery(true);
    await installNet();

    assert.deepEqual(await dispatch(), { status: 'unconfigured' });
    assert.equal((await posts()).length, 0);
  });

  it('does nothing when the Vault has no welcome_dispatch_github_token', async () => {
    await setEnv('prod');
    await setDelivery(true);
    await installNet();
    await installVault(undefined);
    await t.sql(`insert into vault.secrets values ('service_role_key', 'some-other-secret')`);

    assert.deepEqual(await dispatch(), { status: 'unconfigured' });
    assert.equal((await posts()).length, 0);
  });

  it('is not satisfied by a token under a different name, or an empty one', async () => {
    await setEnv('prod');
    await setDelivery(true);
    await installNet();
    await installVault('WELCOME_DISPATCH_GITHUB_TOKEN');
    assert.deepEqual(await dispatch(), { status: 'unconfigured' });

    await t.sql(`insert into vault.secrets values ('welcome_dispatch_github_token', E' \\n')`);
    assert.deepEqual(await dispatch(), { status: 'unconfigured' }, 'whitespace is not a token');
    assert.equal((await posts()).length, 0);
  });

  it('raises, without the token, when it is configured and pg_net is missing', async () => {
    await setEnv('prod');
    await setDelivery(true);
    await installVault('welcome_dispatch_github_token');

    const error = await t.errorFrom(`select _dispatch_welcome_email()`);
    const message = `${error?.message ?? ''} ${error?.hint ?? ''} ${error?.detail ?? ''}`;
    assert.match(message, /pg_net is not available/);
    assert.ok(!message.includes(TOKEN), 'the error message carries the token');
  });
});

describe('the request it makes', () => {
  it('posts production/send of welcome-email.yml on main, with the GitHub headers', async () => {
    await configureProduction();

    const result = await dispatch();
    assert.equal(result.status, 'posted');
    assert.equal(typeof result.request_id, 'number');

    const sent = await posts();
    assert.equal(sent.length, 1, 'expected exactly one request');
    const [req] = sent;
    assert.equal(req.url, DISPATCH_URL);
    assert.deepEqual(req.body, { ref: 'main', inputs: { target: 'production', mode: 'send' } });
    assert.deepEqual(req.params, {});
    assert.deepEqual(req.headers, {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bingd-welcome-dispatch',
      'Content-Type': 'application/json',
    });
    assert.equal(req.timeout, 10000);
  });

  it('trims a pasted token, so a trailing newline does not become a 401', async () => {
    await setEnv('prod');
    await setDelivery(true);
    await installNet();
    await installVault('welcome_dispatch_github_token', `  ${TOKEN}\n`);

    assert.equal((await dispatch()).status, 'posted');
    assert.equal((await posts())[0].headers.Authorization, `Bearer ${TOKEN}`);
  });

  it('returns nothing that contains the token', async () => {
    await configureProduction();
    const raw = JSON.stringify(await dispatch());
    assert.ok(!raw.includes(TOKEN), 'the result carries the token');
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['request_id', 'status']);
  });

  it('never names the token in a raise, notice or return', async () => {
    const { rows } = await t.sql(
      `select prosrc from pg_proc where proname = '_dispatch_welcome_email'`,
    );
    const source = rows[0].prosrc;
    for (const line of source.split('\n')) {
      if (/\b(raise|return)\b/i.test(line)) {
        assert.doesNotMatch(line, /v_token/, `the token reaches a ${line.trim().slice(0, 50)}`);
      }
    }
    // The token is referenced exactly where it is read, tested and put in the header.
    const uses = source.match(/\bv_token\b/g) ?? [];
    assert.equal(uses.length, 5, `v_token is used ${uses.length} times; check every new use`);
  });

  it('asks only for inputs the workflow accepts, and never the canary', async () => {
    const workflow = await readFile(join(root, '.github', 'workflows', 'welcome-email.yml'), 'utf8');
    assert.match(workflow, /^\s{2}workflow_dispatch:/m, 'the workflow no longer accepts a dispatch');
    assert.match(workflow, /options: \[nonprod, production\]/);
    assert.match(workflow, /options: \[dry-run, send\]/);

    const migration = await migrationSql(MIGRATION);
    const bodies = [...migration.matchAll(/body\s*:=\s*'([^']+)'::jsonb/g)].map((m) => JSON.parse(m[1]));
    assert.deepEqual(bodies, [{ ref: 'main', inputs: { target: 'production', mode: 'send' } }]);
    assert.ok(!('canary' in bodies[0].inputs), 'a dispatch must never be a canary');
  });
});

describe('the schedule', () => {
  it('is installed hourly at :41 where pg_cron exists, and re-applying keeps one job', async () => {
    await installCron();
    // A stale job of the same name, as an earlier attempt would have left.
    await t.sql(`insert into cron.job (jobname, schedule, command) values ('bingd-welcome-dispatch', '* * * * *', 'select 1')`);

    const sql = await migrationSql(MIGRATION);
    await t.exec(sql);
    await t.exec(sql);

    const { rows } = await t.sql(
      `select jobname, schedule, command, active from cron.job where jobname = 'bingd-welcome-dispatch'`,
    );
    assert.deepEqual(rows, [
      {
        jobname: 'bingd-welcome-dispatch',
        schedule: '41 * * * *',
        command: 'select public._dispatch_welcome_email()',
        active: true,
      },
    ]);
  });

  it('leaves other jobs alone', async () => {
    await installCron();
    await t.sql(`insert into cron.job (jobname, schedule, command) values ('bingd-push-drain', '* * * * *', 'select public._drain_push_outbox()')`);
    await t.exec(await migrationSql(MIGRATION));

    const { rows } = await t.sql(`select jobname from cron.job order by jobname`);
    assert.deepEqual(rows.map((r) => r.jobname), ['bingd-push-drain', 'bingd-welcome-dispatch']);
  });
});

describe('the rollback', () => {
  it('removes the job and the function, and the migration applies again afterwards', async () => {
    await installCron();
    await t.sql(`insert into cron.job (jobname, schedule, command) values ('bingd-push-drain', '* * * * *', 'select public._drain_push_outbox()')`);
    await t.exec(await migrationSql(MIGRATION));

    await t.exec(await readFile(ROLLBACK, 'utf8'));

    const { rows: jobs } = await t.sql(`select jobname from cron.job order by jobname`);
    assert.deepEqual(jobs.map((r) => r.jobname), ['bingd-push-drain'], 'the rollback touched another job');
    const { rows: fns } = await t.sql(`select count(*)::int as n from pg_proc where proname = '_dispatch_welcome_email'`);
    assert.equal(fns[0].n, 0);

    await t.exec(await migrationSql(MIGRATION));
    const { rows: again } = await t.sql(`select count(*)::int as n from cron.job where jobname = 'bingd-welcome-dispatch'`);
    assert.equal(again[0].n, 1);
    const { rows: grant } = await t.sql(
      `select has_function_privilege('anon', '_dispatch_welcome_email()', 'execute') as anon,
              has_function_privilege('authenticated', '_dispatch_welcome_email()', 'execute') as auth`,
    );
    assert.deepEqual(grant[0], { anon: false, auth: false }, 're-applying re-opened the grants');
  });

  it('runs cleanly where pg_cron is absent', async () => {
    await t.exec(await readFile(ROLLBACK, 'utf8'));
    const { rows } = await t.sql(`select count(*)::int as n from pg_proc where proname = '_dispatch_welcome_email'`);
    assert.equal(rows[0].n, 0);
    await t.exec(await migrationSql(MIGRATION));
  });
});
