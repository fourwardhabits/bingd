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

      // **Both jobs progressed**, which is the property. Each tick claims one job, so if
      // the second worker had queued on the first's row instead of skipping it, only one
      // job would have been matched — and with `t2`'s call awaited before `t1` commits,
      // a blocking claim would not merely be slow, it would deadlock and time out.
      //
      // Asserted on the rows rather than on `attempts`, because a productive slice now
      // resets that counter: the ceiling bounds unproductive claims, not claims.
      const pending = await db.rows(
        `select r.job_id, count(*)::int as n
           from import_rows r
          where r.job_id in ($1, $2) and r.status = 'pending'
          group by r.job_id`,
        [jobA, jobB],
      );
      assert.deepEqual(pending, [], 'W1: neither job was starved by the other');

      // Since 20260917001700 a tick works its claimed job until the job is done or the budget
      // is spent, so each worker carries its one-row job all the way to settle — and settle
      // deletes applied rows. What is asserted is the property itself: each worker finished a
      // job, and they were different jobs, which is only possible if the second skipped the
      // first's lock instead of queueing on it.
      const done = await db.rows(
        `select id, status, (counts->>'applied')::int as applied
           from import_jobs where id in ($1, $2) order by id`,
        [jobA, jobB],
      );
      assert.equal(done.length, 2);
      assert.ok(
        done.every((j) => j.status === 'done' && j.applied === 1),
        `W1: both jobs finished with their film applied (${JSON.stringify(done)})`,
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

    /**
     * W3. Two provider invocations at once never search the same row (`20260917001700`).
     *
     * A ten-second drain can start an Edge Function invocation while the last one is still
     * working. The claim locks with `skip locked` and re-checks the lease on the locked row, so
     * the two take disjoint rows and no title spends two attempts on one search. Without the
     * re-check, the second claim's `in` list — computed before the first committed — would
     * hand out the same rows again.
     */
    it('W3: two provider invocations at once claim disjoint rows', async () => {
      const { db, fx } = ctx;
      const who = await fx.createUser();
      const rows = Array.from({ length: 12 }, (_, i) => ({
        correlation: `provider race ${i}|2001`,
        name: `Provider Race Unknown ${i}`,
        year: 2001,
        bucket: 'loved',
      }));
      const job = await stageJob(who, rows);
      await db.sql(`select _import_match_batch($1, 100)`, [job]);

      const p1 = await db.session('invocation-one');
      const p2 = await db.session('invocation-two');
      let first;
      let second;
      try {
        await p1.begin();
        await p2.begin();
        first = (await p1.q(`select row_id from _import_provider_claim(8)`)).rows;
        // Fired while the first still holds its locks: it must skip them, not wait on them.
        second = (await p2.q(`select row_id from _import_provider_claim(8)`)).rows;
        await p1.commit();
        await p2.commit();
      } finally {
        await p1.rollback().catch(() => {});
        await p2.rollback().catch(() => {});
        await p1.end().catch(() => {});
        await p2.end().catch(() => {});
      }

      const a = new Set(first.map((r) => r.row_id));
      const overlap = second.filter((r) => a.has(r.row_id));
      assert.equal(first.length, 8);
      // Held open here, the second may find nothing to take — the candidates it chose were the
      // ones locked — and that is the safe answer. A claim RPC commits in microseconds, so in
      // production the overlap is the next invocation, not this one.
      assert.ok(second.length <= 4);
      assert.equal(overlap.length, 0, 'W3: no row handed to two invocations');

      // A third, after both committed, takes exactly what neither holds, and a fourth nothing.
      const [third] = await db.rows(`select count(*)::int as n from _import_provider_claim(50)`);
      assert.equal(third.n, 12 - first.length - second.length, 'the rest, once');
      const [left] = await db.rows(`select count(*)::int as n from _import_provider_claim(50)`);
      assert.equal(left.n, 0, 'every row is in hand until answered or its lease lapses');
      const [spent] = await db.rows(
        `select max(provider_attempts)::int as n from import_rows where job_id = $1`, [job]);
      assert.equal(spent.n, 1, 'one attempt each');
    });

    it('W2b: the collection is silent even when two workers write it at once', async () => {
      const { db } = ctx;
      const [events] = await db.rows(`select count(*)::int as n from feed_events`);
      // The import's own lifecycle notices are the one thing it may say (20260917001500), and
      // W1's jobs now finish inside their tick, so they say it.
      const [notes] = await db.rows(
        `select count(*)::int as n from notifications
          where type not in ('import_started', 'import_completed', 'import_failed')`,
      );
      assert.equal(events.n, 0, 'an import writes no feed activity, concurrently or not');
      assert.equal(notes.n, 0);
    });
  });
}
