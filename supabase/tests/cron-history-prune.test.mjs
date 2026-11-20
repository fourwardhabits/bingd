import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Cron history pruning, once an hour (20261130000400).
 *
 * `cron.job_run_details` has no index a prune can use, so every prune is a full scan. The
 * import prune ran on every one-minute maintenance tick and the release prune on every
 * quarter-hour evaluation: 64 full scans an hour, and on production the maintenance job was
 * 61% of all recorded database execution time. Now each prunes on one tick an hour.
 *
 * What is pinned here:
 *   - when each prune is due (import: minute 17 UTC; release: minute 0 UTC), and that it
 *     deletes nothing on any other tick;
 *   - that a due prune removes exactly what it removed before: its own two jobs' rows older
 *     than 7 (import) or 14 (release) days, and no other job's rows;
 *   - that the zero-argument forms the cron commands call still exist, take no input, and
 *     never raise, including with no pg_cron at all.
 *
 * PGlite has no pg_cron, so each test installs a two-table stand-in with pg_cron's column
 * names, and removes it afterwards.
 */

let t;

const installCron = async () => {
  await t.sql(`create schema if not exists cron`);
  await t.sql(`create table cron.job (jobid bigserial primary key, jobname text not null)`);
  await t.sql(`
    create table cron.job_run_details (
      runid bigserial primary key,
      jobid bigint not null,
      status text not null default 'succeeded',
      start_time timestamptz,
      end_time timestamptz
    )`);
  await t.sql(`
    insert into cron.job (jobname) values
      ('bingd-import-drain'), ('bingd-import-maintenance'),
      ('bingd-release-refresh'), ('bingd-release-evaluate'),
      ('bingd-push-drain')`);
};

/** One run of `job`, ended `daysAgo` days before `at`. */
const addRun = (job, at, daysAgo) =>
  t.sql(
    `insert into cron.job_run_details (jobid, start_time, end_time)
     select jobid, $2::timestamptz - $3::float8 * interval '1 day', $2::timestamptz - $3::float8 * interval '1 day'
       from cron.job where jobname = $1`,
    [job, at, daysAgo],
  );

const remaining = async () => {
  const { rows } = await t.sql(
    `select j.jobname, count(*)::int as n
       from cron.job_run_details d join cron.job j using (jobid)
      group by 1 order by 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.jobname, r.n]));
};

const importPrune = async (at) =>
  (await t.sql(`select _import_prune_cron_history($1::timestamptz) as n`, [at])).rows[0].n;
const releasePrune = async (at) =>
  (await t.sql(`select _release_prune_cron_history($1::timestamptz) as n`, [at])).rows[0].n;

/** For every job: one run 30 days old, one 10 days old, one 3 days old. */
const seed = async (at) => {
  for (const job of [
    'bingd-import-drain',
    'bingd-import-maintenance',
    'bingd-release-refresh',
    'bingd-release-evaluate',
    'bingd-push-drain',
  ]) {
    for (const days of [30, 10, 3]) await addRun(job, at, days);
  }
};

const ALL_THREE = {
  'bingd-import-drain': 3,
  'bingd-import-maintenance': 3,
  'bingd-push-drain': 3,
  'bingd-release-evaluate': 3,
  'bingd-release-refresh': 3,
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

afterEach(async () => {
  await t.sql(`drop schema if exists cron cascade`);
  await t.sql(`reset timezone`);
});

describe('the functions', () => {
  it('keep the zero-argument forms the cron commands call, and add a one-argument form with no default', async () => {
    const { rows } = await t.sql(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.pronargdefaults as defaults,
              pg_get_function_result(p.oid) as result, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('_import_prune_cron_history', '_release_prune_cron_history')
        order by 1, 2`,
    );
    assert.deepEqual(
      rows.map((r) => [r.proname, r.args, r.defaults, r.result, r.prosecdef, r.proconfig]),
      [
        ['_import_prune_cron_history', '', 0, 'integer', true, ['search_path=public']],
        [
          '_import_prune_cron_history',
          'p_at timestamp with time zone',
          0,
          'integer',
          true,
          ['search_path=public'],
        ],
        ['_release_prune_cron_history', '', 0, 'integer', true, ['search_path=public']],
        [
          '_release_prune_cron_history',
          'p_at timestamp with time zone',
          0,
          'integer',
          true,
          ['search_path=public'],
        ],
      ],
    );
  });

  it('are not executable by any client role', async () => {
    for (const fn of [
      '_import_prune_cron_history()',
      '_import_prune_cron_history(timestamptz)',
      '_release_prune_cron_history()',
      '_release_prune_cron_history(timestamptz)',
    ]) {
      for (const role of ['public', 'anon', 'authenticated']) {
        const { rows } = await t.sql(
          role === 'public'
            ? `select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as ok`
            : `select has_function_privilege($2, $1, 'execute') as ok`,
          role === 'public' ? [fn] : [fn, role],
        );
        assert.equal(rows[0].ok, false, `${role} can execute ${fn}`);
      }
    }
  });

  it('return 0 and do not raise where pg_cron is not installed, whatever the minute', async () => {
    assert.equal(await importPrune('2026-11-20T10:17:00Z'), 0);
    assert.equal(await releasePrune('2026-11-20T10:00:00Z'), 0);
    const { rows } = await t.sql(
      `select _import_prune_cron_history() as a, _release_prune_cron_history() as b`,
    );
    assert.deepEqual(rows[0], { a: 0, b: 0 });
  });
});

describe('the import prune', () => {
  beforeEach(installCron);

  it("on minute 17 deletes only the import jobs' rows older than seven days", async () => {
    const at = '2026-11-20T10:17:00Z';
    await seed(at);
    assert.equal(await importPrune(at), 4);
    assert.deepEqual(await remaining(), {
      ...ALL_THREE,
      'bingd-import-drain': 1,
      'bingd-import-maintenance': 1,
    });
  });

  it('deletes nothing on any other minute of the hour', async () => {
    const hour = '2026-11-20T10';
    await seed(`${hour}:17:00Z`);
    for (let m = 0; m < 60; m += 1) {
      if (m === 17) continue;
      const at = `${hour}:${String(m).padStart(2, '0')}:00Z`;
      assert.equal(await importPrune(at), 0, `pruned at ${at}`);
    }
    assert.deepEqual(await remaining(), ALL_THREE);
  });

  it('reads the minute in UTC, not in the session time zone', async () => {
    const at = '2026-11-20T10:17:00Z';
    await seed(at);
    // India is UTC+5:30, so 10:17Z is 15:47 local. Still due.
    await t.sql(`set timezone = 'Asia/Kolkata'`);
    assert.equal(await importPrune(at), 4);
    // 10:47Z is 16:17 local. Not due.
    await seed(at);
    assert.equal(await importPrune('2026-11-20T10:47:00Z'), 0);
  });

  it('takes the seven days from the time it is given', async () => {
    const at = '2026-11-20T10:17:00Z';
    await addRun('bingd-import-drain', at, 7.01);
    await addRun('bingd-import-drain', at, 6.99);
    assert.equal(await importPrune(at), 1);
    assert.deepEqual(await remaining(), { 'bingd-import-drain': 1 });
  });

  it('leaves a run with no end_time, which is still running', async () => {
    await t.sql(
      `insert into cron.job_run_details (jobid, start_time, end_time)
       select jobid, now() - interval '30 days', null from cron.job where jobname = 'bingd-import-drain'`,
    );
    assert.equal(await importPrune('2026-11-20T10:17:00Z'), 0);
    assert.deepEqual(await remaining(), { 'bingd-import-drain': 1 });
  });

  it('returns 0 for a null time rather than raising', async () => {
    await seed('2026-11-20T10:17:00Z');
    assert.equal(
      (await t.sql(`select _import_prune_cron_history(null::timestamptz) as n`)).rows[0].n,
      0,
    );
    assert.deepEqual(await remaining(), ALL_THREE);
  });

  it('never raises, even when the delete itself fails', async () => {
    await seed('2026-11-20T10:17:00Z');
    await t.sql(`alter table cron.job_run_details rename column end_time to finished_at`);
    assert.equal(await importPrune('2026-11-20T10:17:00Z'), 0);
  });
});

describe('the release prune', () => {
  beforeEach(installCron);

  it("on minute 0 deletes only the release jobs' rows older than fourteen days", async () => {
    const at = '2026-11-20T10:00:00Z';
    await seed(at);
    assert.equal(await releasePrune(at), 2);
    assert.deepEqual(await remaining(), {
      ...ALL_THREE,
      'bingd-release-evaluate': 2,
      'bingd-release-refresh': 2,
    });
  });

  it('deletes nothing on the other three evaluation ticks, or any other minute', async () => {
    const hour = '2026-11-20T10';
    await seed(`${hour}:00:00Z`);
    for (let m = 1; m < 60; m += 1) {
      const at = `${hour}:${String(m).padStart(2, '0')}:00Z`;
      assert.equal(await releasePrune(at), 0, `pruned at ${at}`);
    }
    assert.deepEqual(await remaining(), ALL_THREE);
  });
});

describe('the zero-argument forms', () => {
  beforeEach(installCron);

  it('prune exactly when the one-argument form would for now(), in the same statement', async () => {
    // Everything is 30 days old, so a due prune removes the job's rows and an undue one
    // removes none. now() is fixed for the statement, so the minute and the call agree.
    for (const job of ['bingd-import-drain', 'bingd-release-evaluate']) {
      await addRun(job, new Date().toISOString(), 30);
    }
    const { rows } = await t.sql(
      `select extract(minute from now() at time zone 'UTC')::int as m,
              _import_prune_cron_history() as imp,
              _release_prune_cron_history() as rel`,
    );
    const { m, imp, rel } = rows[0];
    assert.equal(imp, m === 17 ? 1 : 0, `import prune at minute ${m}`);
    assert.equal(rel, m === 0 ? 1 : 0, `release prune at minute ${m}`);
  });
});
