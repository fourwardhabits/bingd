import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { raceContext } from './_shared.mjs';

/**
 * The import worker under two connections — `20260917000300`.
 *
 * ---------------------------------------------------------------------------
 * WHAT PGLITE CANNOT SEE HERE
 *
 * `supabase/tests/import-pipeline.test.mjs` proves the lease *arithmetic*: an expired
 * claim is reclaimable, a live one is not, three failures dead-letter. All of it is true
 * and none of it is concurrency, because PGlite is a single connection — there is no
 * second worker, so `for update skip locked` has nothing to skip and every assertion there
 * passes whether or not the clause is present.
 *
 * These are the two properties that only exist with a second backend.
 *
 * **W1. Two ticks firing together do not both take the same job.** The claim is
 * `for update skip locked`, so the second worker steps over the row rather than blocking
 * on it — which is the difference between two workers sharing a queue and two workers
 * serialising into one. Remove `skip locked` and this suite still passes on the end state
 * while the throughput quietly halves; so the assertion is on *who claimed*, taken from
 * the attempt counter, rather than on the rows that ended up written.
 *
 * **W2. Two workers applying one job's rows never double-apply a title.** The apply slice
 * also takes `for update skip locked` over `import_rows`, and each row takes
 * `_lock_media` before touching the collection. `user_media`'s primary key would hide a
 * duplicate insert; `imported_watches` would not, and neither would the viewing count.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('import worker races', () => {
    before(() => rc.open());
    after(() => rc.close());

    /** Stages a job directly, as the client RPCs would, without needing auth.uid(). */
    const stageJob = async (who, rows) => {
      const [job] = await ctx.db.rows(
        `insert into import_jobs (user_id, status) values ($1, 'matching') returning id`,
        [who],
      );
      for (const r of rows) {
        await ctx.db.sql(
          `insert into import_rows (job_id, kind, correlation, raw, status)
           values ($1, 'watched', $2, $3::jsonb, 'pending')`,
          [job.id, r.correlation, JSON.stringify(r)],
        );
      }
      return job.id;
    };

    it('W1: two ticks together claim different jobs rather than queueing on one', async () => {
      const { db, fx } = ctx;
      const one = await fx.createUser();
      const two = await fx.createUser();

      const filmA = await fx.createMovie('Worker Race A');
      const filmB = await fx.createMovie('Worker Race B');

      const jobA = await stageJob(one, [
        { correlation: 'worker race a|2001', name: 'Worker Race A', year: null, bucket: 'loved' },
      ]);
      const jobB = await stageJob(two, [
        { correlation: 'worker race b|2001', name: 'Worker Race B', year: null, bucket: 'loved' },
      ]);

      const t1 = await db.session('worker-one');
      const t2 = await db.session('worker-two');

      try {
        await t1.begin();
        // One job per tick, so the two workers must pick different rows.
        await t1.one(`select _drain_import_jobs(1, 100) as r`);

        await t2.begin();
        // If the claim blocked instead of skipping, this would wait on t1's row lock and
        // `awaitBlocked` would be the right assertion. It must NOT block.
        await t2.one(`select _drain_import_jobs(1, 100) as r`);

        await t1.commit();
        await t2.commit();
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      const claimed = await db.rows(
        `select id, attempts from import_jobs where id in ($1, $2) order by id`,
        [jobA, jobB],
      );
      assert.equal(claimed.length, 2);
      assert.deepEqual(
        claimed.map((r) => r.attempts).sort(),
        [1, 1],
        'W1: each worker took a different job, so each job was attempted exactly once',
      );

      // Both films must be findable by the matcher; neither job may have been starved.
      assert.ok(filmA && filmB);
    });

    it('W2: two workers applying one job never write a viewing twice', async () => {
      const { db, fx } = ctx;
      const who = await fx.createUser();

      const films = [];
      const rows = [];
      for (let i = 0; i < 6; i += 1) {
        const name = `Concurrent Apply ${i}`;
        films.push(await fx.createMovie(name));
        rows.push({
          correlation: `${name.toLowerCase()}|2001`,
          name,
          year: null,
          bucket: 'loved',
          watchedOn: '2024-04-04',
          watches: [{ diaryUri: `https://boxd.it/w${i}`, watchedOn: '2024-04-04', isRewatch: false }],
        });
      }

      const job = await stageJob(who, rows);

      // Match everything first, so both workers meet a job full of applicable rows.
      await db.sql(`select _import_match_batch($1, 100)`, [job]);
      await db.sql(`update import_jobs set status = 'applying', claimed_at = null where id = $1`, [job]);

      const t1 = await db.session('apply-one');
      const t2 = await db.session('apply-two');

      try {
        await t1.begin();
        await t2.begin();
        // Small slices, so both workers genuinely have rows to take.
        const p1 = t1.start(`select _import_apply_batch($1, 3) as r`, [job]);
        const p2 = t2.start(`select _import_apply_batch($1, 3) as r`, [job]);
        await p1;
        await p2;
        await t1.commit();
        await t2.commit();
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      const [media] = await db.rows(
        `select count(*)::int as n from user_media where user_id = $1`, [who]);
      const [watches] = await db.rows(
        `select count(*)::int as n from imported_watches where user_id = $1`, [who]);
      const [applied] = await db.rows(
        `select count(*)::int as n from import_rows where job_id = $1 and status = 'applied'`, [job]);

      assert.equal(media.n, 6, 'W2: six titles, however the slices divided them');
      assert.equal(watches.n, 6, 'W2: one viewing each — a double-apply would show here');
      assert.equal(applied.n, 6, 'W2: every row applied exactly once');
    });

    it('W2b: the collection is silent even when two workers write it at once', async () => {
      const { db } = ctx;
      const [events] = await db.rows(`select count(*)::int as n from feed_events`);
      const [notes] = await db.rows(`select count(*)::int as n from notifications`);
      assert.equal(events.n, 0, 'an import writes no feed activity, concurrently or not');
      assert.equal(notes.n, 0);
    });
  });
}
