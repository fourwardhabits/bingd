import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { raceContext } from './_shared.mjs';
import { AUTH_COLUMNS_SQL, OPEN_COHORT_SQL, welcomeSource, welcomeSqlToApply } from '../../welcome-email-support.mjs';

/**
 * The welcome email's claim, under two connections.
 *
 * `welcome_email.sql` is not a migration until the automation is switched on, so this
 * suite applies it on top of the migrated template, exactly as the PGlite suite does.
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **W1. Two runs never own the same person.** A second worker that reads the same
 * candidates before the first commits blocks on the ledger's primary key, then does
 * nothing. Together they claim each person once, and the loser returns nobody rather than
 * an error: a scheduled run that overlaps a manual one must not fail either of them.
 *
 * **W2. Two runs never retry the same failure.** The retry is a compare-and-set on
 * `status = 'failed'`. The second runner waits for the row lock, re-reads the row, finds
 * it `claimed`, and takes nothing. With the status guard deleted it takes the row a second
 * time as attempt 3, which the last test demonstrates, so W2 is not passing by accident.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('welcome email races', () => {
    before(async () => {
      await rc.open();
      await ctx.db.sql(AUTH_COLUMNS_SQL);
      const sql = await welcomeSqlToApply();
      if (sql) await ctx.db.sql(sql);
      await ctx.db.sql(OPEN_COHORT_SQL);
    });
    after(() => rc.close());

    /** An account with a confirmed address that signed up 40 hours ago. */
    const eligible = async () => {
      const { db, fx } = ctx;
      const id = await fx.createUser();
      await db.sql(`update auth.users set email = $2, email_confirmed_at = now() where id = $1`, [id, `${id}@example.com`]);
      await db.sql(`update profiles set created_at = now() - interval '40 hours' where id = $1`, [id]);
      return id;
    };

    const claimSql = `select recipient_id, attempt from welcome_email_claim()`;

    it('W1: two overlapping runs claim each person exactly once, and neither fails', async () => {
      const { db } = ctx;
      await db.sql(`delete from welcome_emails`);
      const people = [await eligible(), await eligible(), await eligible()];

      const a = await db.session('run-a');
      const b = await db.session('run-b');
      try {
        await a.begin();
        const first = (await a.q(claimSql)).rows;

        await b.begin();
        const pending = b.start(claimSql);
        await b.awaitBlocked();

        await a.commit();
        const second = (await pending).rows;
        await b.commit();

        assert.deepEqual(first.map((r) => r.recipient_id).sort(), [...people].sort());
        assert.deepEqual(second, [], 'the overlapping run owns nobody');

        const rows = await db.rows(`select user_id, attempts from welcome_emails where user_id = any($1::uuid[])`, [people]);
        assert.equal(rows.length, 3);
        assert.ok(rows.every((r) => r.attempts === 1));
      } finally {
        await a.end();
        await b.end();
      }
    });

    const retryRace = async () => {
      const { db } = ctx;
      await db.sql(`delete from welcome_emails`);
      const person = await eligible();
      await db.sql(`insert into welcome_emails (user_id, status, attempts, failed_reason) values ($1, 'failed', 1, '500 {}')`, [person]);

      const a = await db.session('retry-a');
      const b = await db.session('retry-b');
      try {
        await a.begin();
        const first = (await a.q(claimSql)).rows;

        await b.begin();
        const pending = b.start(claimSql);
        await b.awaitBlocked();

        await a.commit();
        const second = (await pending).rows;
        await b.commit();

        const [row] = await db.rows(`select status, attempts from welcome_emails where user_id = $1`, [person]);
        return { person, first, second, row };
      } finally {
        await a.end();
        await b.end();
      }
    };

    it('W2: two overlapping runs retry a failure once', async () => {
      const { person, first, second, row } = await retryRace();
      assert.deepEqual(first.map((r) => [r.recipient_id, r.attempt]), [[person, 2]]);
      assert.deepEqual(second, [], 'the overlapping run retries nothing');
      assert.deepEqual([row.status, row.attempts], ['claimed', 2]);
    });

    it('W2 bites: with the status guard deleted, the second run retries the same failure again', async () => {
      const { db } = ctx;
      const original = await welcomeSource();
      const guard = /(\n\s+where w\.user_id = v_row\.rid)\r?\n\s+and w\.status = 'failed'/;
      assert.match(original, guard, 'the guard this test deletes is where it expects');
      const claimFunction = original.match(/create function welcome_email_claim\([\s\S]*?\n\$\$;/)[0];

      try {
        await db.sql(claimFunction.replace('create function', 'create or replace function').replace(guard, '$1'));
        const { second, row } = await retryRace();
        assert.equal(second.length, 1, 'the mutant must double-claim, or W2 proves nothing');
        assert.equal(row.attempts, 3);
      } finally {
        await db.sql(claimFunction.replace('create function', 'create or replace function'));
      }
    });
  });
}
