import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The import's lifecycle notifications — `20260917001500`.
 *
 * The importer tells somebody they may close the app. These are the second half of that
 * promise: one notification when the job is accepted, one when it finishes, one if it
 * fails, and never a second of any of them. Every test below drives the job through the
 * functions the client and the cron tick actually call, and counts rows in `notifications`,
 * because "exactly once" is a claim about rows and not about which trigger fired.
 */

let t;
let seq = 172000;

const staged = (name) => ({
  kind: 'watched',
  correlation: `${name.toLowerCase()}|2001`,
  name,
  year: 2001,
  filmUri: `https://boxd.it/${name.toLowerCase().replace(/\W/g, '')}`,
  rating: 4,
  bucket: 'loved',
  watchedOn: null,
});

const datedMovie = async (title) => {
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, release_date, provenance)
     values ('movie', $1, $2, '2001-06-01', 'manual') returning id`,
    [-seq++, title],
  );
  return rows[0].id;
};

/** The client's half: create, stage, hand over. */
const startImport = async (user, names) => {
  await t.actAs(user);
  const { rows } = await t.sql(`select import_create() as id`);
  const jobId = rows[0].id;
  await t.sql(`select import_stage($1, $2::jsonb) as r`, [
    jobId,
    JSON.stringify(names.map(staged)),
  ]);
  await t.sql(`select import_ready($1) as r`, [jobId]);
  await t.actAs(null);
  return jobId;
};

/** The worker's half, a tick at a time, as pg_cron would. */
const tick = async (times = 1) => {
  for (let i = 0; i < times; i += 1) {
    await t.sql(`select _drain_import_jobs(5, 500), _import_sweep_abandoned()`);
  }
};

const runToEnd = async (jobId) => {
  for (let i = 0; i < 40; i += 1) {
    await tick();
    const { rows } = await t.sql(`select completed_at from import_jobs where id = $1`, [jobId]);
    if (rows[0].completed_at) return;
  }
  throw new Error('job did not finish');
};

const notificationsFor = async (user, jobId) => {
  const { rows } = await t.sql(
    `select type, subject_type, subject_id, payload, actor_id
       from notifications
      where recipient_id = $1 and payload ->> 'job_id' = $2
      order by created_at, type`,
    [user, jobId],
  );
  return rows;
};

const typesFor = async (user, jobId) => (await notificationsFor(user, jobId)).map((r) => r.type);

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

describe('an import that finishes', () => {
  let ada;

  before(async () => {
    ada = await t.createUser({ username: 'notify_ada' });
  });

  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from notifications`);
    await t.sql(`delete from user_media`);
  });

  it('says it started once the job exists and has been handed over, and not before', async () => {
    const title = `Notify Start ${seq}`;
    await datedMovie(title);
    await t.actAs(ada);
    const { rows } = await t.sql(`select import_create() as id`);
    const jobId = rows[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([staged(title)])]);
    await t.actAs(null);
    assert.deepEqual(await typesFor(ada, jobId), [], 'a slot being filled is not an import');

    await t.actAs(ada);
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);

    const rows2 = await notificationsFor(ada, jobId);
    assert.deepEqual(rows2.map((r) => r.type), ['import_started']);
    assert.equal(rows2[0].subject_type, 'import_job');
    assert.equal(rows2[0].subject_id, jobId, 'the tap has to be able to find this exact job');
    assert.equal(rows2[0].actor_id, null);
  });

  it('does not say it started twice when the client hands it over twice', async () => {
    const title = `Notify Twice ${seq}`;
    await datedMovie(title);
    const jobId = await startImport(ada, [title]);
    await t.actAs(ada);
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);
    assert.deepEqual(await typesFor(ada, jobId), ['import_started']);
  });

  it('says it is ready exactly once, with the summary, through the silence the import keeps', async () => {
    const titles = [`Notify Done A ${seq}`, `Notify Done B ${seq}`];
    for (const title of titles) await datedMovie(title);
    const jobId = await startImport(ada, titles);
    await runToEnd(jobId);
    // Ticks after the end, and a settle asked for again, are the worker reprocessing a
    // terminal job. They must say nothing.
    await tick(3);
    await t.sql(`select _import_settle($1)`, [jobId]);

    const rows = await notificationsFor(ada, jobId);
    assert.deepEqual(
      rows.map((r) => r.type),
      ['import_started', 'import_completed'],
    );
    assert.equal(rows[1].payload.watched, 2);
  });

  it('writes no feed activity for any of it', async () => {
    const title = `Notify Feed ${seq}`;
    await datedMovie(title);
    const jobId = await startImport(ada, [title]);
    await runToEnd(jobId);
    const { rows } = await t.sql(`select count(*)::int as n from feed_events where actor_id = $1`, [
      ada,
    ]);
    assert.equal(rows[0].n, 0);
  });

  it('gives a re-import its own notifications', async () => {
    const title = `Notify Again ${seq}`;
    await datedMovie(title);
    const first = await startImport(ada, [title]);
    await runToEnd(first);
    const second = await startImport(ada, [title]);
    await runToEnd(second);

    assert.deepEqual(await typesFor(ada, first), ['import_started', 'import_completed']);
    assert.deepEqual(await typesFor(ada, second), ['import_started', 'import_completed']);
  });

  // A behaviour, not a mechanism: the explicit exemption and the unmapped-type fallback
  // produce the same answer, and this pins the answer either way.
  it('is delivered with every notification category switched off', async () => {
    const { rows: categories } = await t.sql(`select unnest(_notification_categories()) as c`);
    for (const { c } of categories) {
      await t.sql(
        `insert into notification_preferences (user_id, category, enabled) values ($1, $2, false)
         on conflict (user_id, category) do update set enabled = false`,
        [ada, c],
      );
    }
    try {
      const title = `Notify Muted ${seq}`;
      await datedMovie(title);
      const jobId = await startImport(ada, [title]);
      await runToEnd(jobId);
      assert.deepEqual(await typesFor(ada, jobId), ['import_started', 'import_completed']);
    } finally {
      await t.sql(`delete from notification_preferences where user_id = $1`, [ada]);
    }
  });

  it('keeps the silence for everything else the import does', async () => {
    // The control: the gate still cancels an ordinary notification under the marker.
    await t.sql(`begin`);
    try {
      await t.sql(`select set_config('bingd.import_running', txid_current()::text, true)`);
      await t.sql(
        `insert into notifications (recipient_id, type, payload) values ($1, 'award_earned', '{}')`,
        [ada],
      );
      await t.sql(
        `insert into notifications (recipient_id, type, payload)
         values ($1, 'import_started', jsonb_build_object('job_id', gen_random_uuid()))`,
        [ada],
      );
      const { rows } = await t.sql(
        `select type from notifications where recipient_id = $1 order by type`,
        [ada],
      );
      assert.deepEqual(rows.map((r) => r.type), ['import_started']);
    } finally {
      await t.sql(`rollback`);
    }
  });
});

describe('an import that fails', () => {
  let bo;

  before(async () => {
    bo = await t.createUser({ username: 'notify_bo' });
  });

  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from notifications`);
  });

  it('says so once when a started job is dead-lettered, and never also says it finished', async () => {
    const jobId = await startImport(bo, [`Notify Never Placed ${seq++}`]);
    // Six claims that moved nothing, with a row still outstanding: the dead letter's case.
    await t.sql(`update import_jobs set attempts = 6 where id = $1`, [jobId]);
    await tick(3);

    const { rows: job } = await t.sql(`select status from import_jobs where id = $1`, [jobId]);
    assert.equal(job[0].status, 'failed', 'fixture: the dead letter fired');
    assert.deepEqual(await typesFor(bo, jobId), ['import_started', 'import_failed']);

    // A later writer trying to report the other outcome is refused by the index.
    await t.sql(
      `insert into notifications (recipient_id, type, subject_type, subject_id, payload)
       values ($1, 'import_completed', 'import_job', $2, jsonb_build_object('job_id', $2::uuid))
       on conflict do nothing`,
      [bo, jobId],
    );
    assert.deepEqual(await typesFor(bo, jobId), ['import_started', 'import_failed']);
  });

  it('says nothing about a half-sent import nobody came back to finish', async () => {
    await t.actAs(bo);
    const { rows } = await t.sql(`select import_create() as id`);
    const jobId = rows[0].id;
    await t.actAs(null);
    await t.sql(`update import_jobs set created_at = now() - interval '2 days' where id = $1`, [
      jobId,
    ]);
    await tick();

    const { rows: job } = await t.sql(`select status from import_jobs where id = $1`, [jobId]);
    assert.equal(job[0].status, 'failed', 'fixture: the sweep retired it');
    assert.deepEqual(await typesFor(bo, jobId), []);
  });
});

describe('the push', () => {
  let cy;

  before(async () => {
    cy = await t.createUser({ username: 'notify_cy' });
    await t.asUser(cy, () =>
      t.sql(`select register_device_token(gen_random_uuid(), $1, 'ios')`, [
        'ExponentPushToken[importimportimport01]',
      ]),
    );
  });

  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from notifications`);
    await t.sql(`delete from push_outbox`);
  });

  it('queues all three types', async () => {
    const { rows } = await t.sql(
      `select _push_eligible('import_started') a, _push_eligible('import_completed') b,
              _push_eligible('import_failed') c`,
    );
    assert.deepEqual(rows[0], { a: true, b: true, c: true });
  });

  it('hands the sender the job and the summary, so the tap opens this import', async () => {
    const title = `Notify Push ${seq}`;
    await datedMovie(title);
    const jobId = await startImport(cy, [title]);
    await runToEnd(jobId);

    const { rows } = await t.sql(`select claim_push_batch(20) as jobs`);
    const jobs = rows[0].jobs;
    const byType = Object.fromEntries(jobs.map((job) => [job.type, job]));

    assert.ok(byType.import_started, 'the actorless start survives the claim');
    assert.equal(byType.import_started.import_job_id, jobId);
    assert.equal(byType.import_started.import_counts, null);

    assert.ok(byType.import_completed, 'the actorless completion survives the claim');
    assert.equal(byType.import_completed.import_job_id, jobId);
    assert.equal(byType.import_completed.import_counts.watched, 1);
  });

  it('carries no job id on any other type', async () => {
    const other = await t.createUser({ username: `notify_other_${seq++}` });
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2)`,
      [cy, other],
    );
    const { rows } = await t.sql(`select claim_push_batch(20) as jobs`);
    const follow = rows[0].jobs.find((job) => job.type === 'follow');
    assert.ok(follow, 'fixture: the follow was claimed');
    assert.equal(follow.import_job_id, null);
    assert.equal(follow.import_counts, null);
  });
});

describe('the inbox', () => {
  it('returns the import rows with the job they are about', async () => {
    const dee = await t.createUser({ username: 'notify_dee' });
    const title = `Notify Inbox ${seq}`;
    await datedMovie(title);
    const jobId = await startImport(dee, [title]);
    await runToEnd(jobId);

    const rows = await t.asUser(dee, async () => {
      const { rows: inbox } = await t.sql(`select * from my_notifications(50)`);
      return inbox;
    });
    const imports = rows.filter((row) => String(row.kind ?? row.type).startsWith('import_'));
    assert.equal(imports.length, 2);
    for (const row of imports) {
      assert.equal(row.subject_type, 'import_job');
      assert.equal(row.subject_id, jobId);
    }
  });
});
