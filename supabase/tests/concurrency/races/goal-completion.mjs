import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { raceContext } from './_shared.mjs';

/**
 * Annual goal completion, under independent connections — `20260829000200`.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS SUITE EXISTS FOR, AND WHY PGLITE COULD NOT SEE IT
 *
 * The first version of the migration relied on `goal_completions`' primary key alone,
 * with the header claiming that key as "the whole exactly-once mechanism". Independent
 * review found the half it does not supply: a primary key gives **at-most-once**, and
 * says nothing about at-least-once.
 *
 *   goal is 2, qualifying count is 0
 *   two devices insert two different films, concurrently
 *   under READ COMMITTED neither transaction sees the other's uncommitted row
 *   so each counts 1, finds 1 < 2, and returns without inserting
 *   both commit — the count is now 2, and nothing was ever announced
 *   every later watch finds `count - added >= target` and stays silent for ever
 *
 * That is a **permanently lost** achievement, which is a worse failure than the duplicate
 * the key prevents. And it is invisible to `supabase/tests/goal-completion.test.mjs`,
 * because PGlite is one connection: there is no second transaction, so there is no
 * interleaving to construct, and every assertion there passes against the broken version.
 *
 * The fix is an advisory transaction lock per `(account, year, medium)`, taken *before*
 * counting. The second transaction waits for the first to commit, then takes a fresh
 * READ COMMITTED snapshot for its `count(*)`, sees the committed row, and correctly
 * recognises itself as the crossing.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANTS
 *
 * **G1. A crossing split across two connections is still announced, once.** The second
 * transaction must be OBSERVED waiting on the *named* advisory key — not merely produce a
 * clean end state, because a serial interleaving resolves correctly whether or not the
 * lock is there.
 *
 * **G2. Two bare concurrent watches**, with no constructed window, leave exactly one
 * announcement however the scheduler lands them.
 *
 * **G3. Two devices logging the SAME title** cross nothing and announce nothing — one
 * title is one tick, and `user_media`'s primary key is what makes that true even here.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('goal completion races', () => {
    before(() => rc.open());
    after(() => rc.close());

    const YEAR = 2026;

    const setGoal = (who, target, category = 'movies') =>
      ctx.db.sql(
        `insert into watch_goals (user_id, year, category, target) values ($1, $2, $3, $4)
         on conflict (user_id, year, category) do update set target = excluded.target`,
        [who, YEAR, category, target],
      );

    const watchSql = `insert into user_media (user_id, media_item_id, bucket, watched_on)
                      values ($1, $2, 'loved', $3::date)
                      on conflict (user_id, media_item_id)
                        do update set watched_on = excluded.watched_on`;

    /** The advisory key `_maybe_goal_completion` takes, computed the same way it does. */
    const goalKey = async (who, category = 'movies') => {
      const [row] = await ctx.db.rows(
        `select hashtextextended('goal:' || $1::text || ':' || $2::text || ':' || $3::text, 0)::text as k`,
        [who, YEAR, category],
      );
      return row.k;
    };

    const announcements = async (who) => {
      const ledger = await ctx.db.rows(
        `select year, category, target_at_completion, count_at_completion
           from goal_completions where user_id = $1`,
        [who],
      );
      const posts = await ctx.db.rows(
        `select payload from feed_events where actor_id = $1 and type = 'goal_completed'`,
        [who],
      );
      const inbox = await ctx.db.rows(
        `select payload from notifications where recipient_id = $1 and type = 'goal_completed'`,
        [who],
      );
      return { ledger, posts, inbox };
    };

    it('G1: the second watch waits on the goal’s advisory lock, and it is the one that crosses', async () => {
      const { db, fx } = ctx;
      const earner = await fx.createUser();
      await setGoal(earner, 2);
      const first = await fx.createMovie('Race One');
      const second = await fx.createMovie('Race Two');

      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');

      try {
        // t1 inserts and stays open. Its trigger has already taken the advisory lock for
        // this (user, year, medium) and holds it until commit; it counted 1 of 2, so it
        // announces nothing — which is correct, it did not cross.
        await t1.begin();
        await t1.one(`${watchSql} returning user_id`, [earner, first, `${YEAR}-03-01`]);

        // t2's trigger reaches the same lock and must stop there.
        await t2.begin();
        const p2 = t2.start(watchSql, [earner, second, `${YEAR}-03-02`]);
        /**
         * The observation that carries the test. Correlated against the *named* key, so
         * this proves `_maybe_goal_completion` serialised these two rather than that
         * something did. Remove the `pg_advisory_xact_lock` from the migration and t2
         * never blocks — `awaitBlocked` throws instead of the suite passing on a lucky
         * interleaving, which is exactly the failure mode the lock was added for.
         */
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await goalKey(earner) });

        await t1.commit();
        await p2;
        await t2.commit();
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      const { ledger, posts, inbox } = await announcements(earner);
      assert.equal(ledger.length, 1, 'G1: the crossing was not lost between two connections');
      assert.equal(ledger[0].target_at_completion, 2);
      assert.equal(ledger[0].count_at_completion, 2);
      assert.equal(posts.length, 1, 'G1: one feed post');
      assert.deepEqual(posts[0].payload, { year: YEAR, category: 'movies', target: 2 });
      assert.equal(inbox.length, 1, 'G1: one congratulations');
    });

    it('G2: two bare concurrent watches announce exactly once', async () => {
      // No constructed window: whichever way the scheduler lands them, the count is 2 and
      // exactly one transaction may claim the crossing.
      const { db, fx } = ctx;
      const earner = await fx.createUser();
      await setGoal(earner, 2);
      const first = await fx.createMovie('Bare One');
      const second = await fx.createMovie('Bare Two');

      const t1 = await db.session('a');
      const t2 = await db.session('b');
      try {
        await Promise.all([
          t1.one(`${watchSql} returning user_id`, [earner, first, `${YEAR}-04-01`]),
          t2.one(`${watchSql} returning user_id`, [earner, second, `${YEAR}-04-02`]),
        ]);
      } finally {
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      const { ledger, posts, inbox } = await announcements(earner);
      assert.equal(ledger.length, 1, 'G2: exactly one completion');
      assert.equal(posts.length, 1, 'G2: exactly one feed post');
      assert.equal(inbox.length, 1, 'G2: exactly one congratulations');
    });

    it('G3: two devices logging the same title cross nothing', async () => {
      // One title is one tick. `user_media` is keyed (user, title), so the second write is
      // an update rather than a second row — and a goal of 2 stays unmet.
      const { db, fx } = ctx;
      const earner = await fx.createUser();
      await setGoal(earner, 2);
      const film = await fx.createMovie('Same Title');

      const t1 = await db.session('a2');
      const t2 = await db.session('b2');
      try {
        await Promise.all([
          t1.one(`${watchSql} returning user_id`, [earner, film, `${YEAR}-05-01`]),
          t2.one(`${watchSql} returning user_id`, [earner, film, `${YEAR}-05-02`]),
        ]);
      } finally {
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      const { ledger, posts } = await announcements(earner);
      assert.deepEqual(ledger, [], 'G3: a rewatch is not a second title');
      assert.deepEqual(posts, []);
    });
  });
}
