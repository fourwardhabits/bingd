import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, newOp, raceContext } from './_shared.mjs';

/**
 * `_assert_operation_rate` at the boundary, with real sessions.
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **Q1. The ceiling is a ceiling under concurrency.** With one slot left, two
 * simultaneous attempts admit exactly one. The per-account advisory lock is the only
 * thing making this true: without it both count a total that excludes the other and
 * both pass. That is asserted by *observation* — the second caller is required to be
 * waiting on the lock.
 *
 * **Q2. The lock is per account.** One person at their ceiling must not stall anybody
 * else. The negative case is what stops Q1 from being satisfiable by a global lock.
 *
 * **Q3. The counter counts the claim, so the current operation is included.** The
 * check is `v_used > v_max` and `_claim_operation` has already inserted this
 * operation's row, so a ceiling of N admits exactly N. Off by one in either direction
 * is a real product difference and is pinned here rather than left to be rediscovered.
 *
 * ---------------------------------------------------------------------------
 * The semantic debt this suite documents rather than fixes
 * ---------------------------------------------------------------------------
 *
 * There are two different things a limiter can bound, and this schema currently has
 * both, decided per function by whether the refusal is **raised or returned**:
 *
 *   - **Successful-action quota.** A raised refusal rolls back the transaction, and
 *     the claim row with it — so the refused attempt costs nothing and the ceiling
 *     bounds *successes*. `follow`, `add_comment`, `set_reaction` and `set_watch_tags`
 *     are all this shape.
 *
 *   - **Abuse-attempt throttle.** `recommend_title` returns `{"status":"refused"}`
 *     inside a successful transaction, deliberately, so the claim survives and the
 *     attempt is counted. Its own comment says why: a raise would make refused
 *     attempts free, and probing whether a stranger is reachable is exactly what
 *     wants bounding.
 *
 * Both behaviours are tested below as they stand. Neither is changed here: the brief
 * for this phase is explicit that rate-limit semantics are not to be redesigned
 * unless a race exposes a correctness bug, and no race here does. The disposition is
 * carried into the hardening notes for the next phase.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('rate-limit boundary under concurrency', () => {
    before(() => rc.open());
    after(() => rc.close());

    const setCeiling = (db, key, n) =>
      db.sql(
        `insert into app_config (key, value) values ($1, $2::jsonb)
         on conflict (key) do update set value = excluded.value`,
        [key, String(n)],
      );

    const slots = async (db, user, kind) =>
      (await db.rows(`select 1 from processed_operations where user_id = $1 and kind = $2`, [user, kind]))
        .length;

    it('Q3: a ceiling of N admits exactly N', async () => {
      const { db, fx } = ctx;
      await setCeiling(db, 'follow.max_per_hour', 2);
      const alice = await fx.createUser();
      const targets = [await fx.createUser(), await fx.createUser(), await fx.createUser()];

      const s = await db.session('client');
      await s.actAs(alice);

      assert.equal((await call(s, `follow($1, $2)`, [await newOp(db), targets[0]])).status, 'ok');
      assert.equal((await call(s, `follow($1, $2)`, [await newOp(db), targets[1]])).status, 'ok');

      const third = await s.errorFrom(`select follow($1, $2)`, [await newOp(db), targets[2]]);
      assert.equal(third?.code, '53400', 'the third must be refused');

      assert.equal(await slots(db, alice, 'follow'), 2, 'the refused attempt left no ledger row');
      await s.end();
    });

    it('Q1: with one slot left, two simultaneous attempts admit exactly one', async () => {
      const { db, fx } = ctx;
      await setCeiling(db, 'follow.max_per_hour', 1);
      const alice = await fx.createUser();
      const b = await fx.createUser();
      const c = await fx.createUser();

      await db.armBarrier('follows', 'quota');
      const ctl = await db.controller();
      await ctl.hold('quota');

      const t1 = await db.session('attempt-a');
      const t2 = await db.session('attempt-b');
      await t1.actAs(alice);
      await t2.actAs(alice);

      // t1 is past the rate check and holding the per-account lock.
      await t1.begin();
      await t1.pauseAt('quota');
      const p1 = t1.start(`select follow($1, $2) as r`, [await newOp(db), b]);
      await t1.awaitBlocked();

      await t2.begin();
      const p2 = t2.start(`select follow($1, $2) as r`, [await newOp(db), c]);
      // The whole of Q1. Remove the advisory lock from `_assert_operation_rate` and
      // this throws instead of the assertion below failing — which is the right way
      // round, because a count that races is not visible in the final row count when
      // the limit happens not to be reached.
      //
      // Correlated with the limiter's own key, so a wait on the pair lock cannot
      // satisfy it: `follow` takes both, and only one of them is under test here.
      await t2.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.accountKey(alice, 'follow'),
      });

      await ctl.release('quota');
      const r1 = (await p1).rows[0].r;
      await t1.commit();
      const r2 = await p2.then((r) => r.rows[0].r).catch((e) => e);
      await t2.commit().catch(() => t2.rollback());

      assert.equal(r1.status, 'ok');
      assert.equal(r2?.code, '53400', 'the loser must be refused, not admitted');
      assert.equal(await slots(db, alice, 'follow'), 1, 'Q1: exactly one accepted operation');
      assert.equal(
        (await db.rows(`select 1 from follows where follower_id = $1`, [alice])).length,
        1,
      );

      await db.sql(`drop trigger if exists _race_barrier_follows on follows`);
      await t1.end();
      await t2.end();
      await ctl.end();
    });

    it('Q2: one account at its ceiling does not stall another', async () => {
      const { db, fx } = ctx;
      await setCeiling(db, 'follow.max_per_hour', 10);
      const alice = await fx.createUser();
      const bob = await fx.createUser();
      const target = await fx.createUser();

      await db.armBarrier('follows', 'per-account');
      const ctl = await db.controller();
      await ctl.hold('per-account');

      const t1 = await db.session('alice');
      await t1.actAs(alice);
      await t1.begin();
      await t1.pauseAt('per-account');
      const p1 = t1.start(`select follow($1, $2) as r`, [await newOp(db), target]);
      await t1.awaitBlocked();

      const t2 = await db.session('bob');
      await t2.actAs(bob);
      await t2.begin();
      const p2 = t2.start(`select follow($1, $2) as r`, [await newOp(db), target]);
      await p2;
      await t2.assertRunning({ forMs: 100 });
      await t2.commit();

      await ctl.release('per-account');
      await p1;
      await t1.commit();

      await db.sql(`drop trigger if exists _race_barrier_follows on follows`);
      await t1.end();
      await t2.end();
      await ctl.end();
    });

    it('the two limiter classes behave as their functions decide: raised refusals are free, returned ones are not', async () => {
      const { db, fx } = ctx;
      await setCeiling(db, 'follow.max_per_hour', 60);
      const alice = await fx.createUser();
      const stranger = await fx.createUser();
      const movie = await fx.createMovie('Limiter Classes');

      const s = await db.session('client');
      await s.actAs(alice);

      // Raised: `follow` against a suspended target rolls the claim back with it.
      const ghost = await fx.createUser();
      await db.sql(`update profiles set status = 'suspended' where id = $1`, [ghost]);
      const raised = await s.errorFrom(`select follow($1, $2)`, [await newOp(db), ghost]);
      assert.equal(raised?.code, 'P0002');
      assert.equal(await slots(db, alice, 'follow'), 0, 'a raised refusal costs no slot');

      // Returned: `recommend_title` keeps its claim on purpose.
      const returned = await call(s, `recommend_title($1, $2, $3)`, [
        await newOp(db),
        stranger,
        movie,
      ]);
      assert.equal(returned.status, 'refused');
      assert.equal(
        await slots(db, alice, 'recommend_title'),
        1,
        'a returned refusal spends a slot, which is what throttles probing',
      );

      await s.end();
    });

    it('the two ceilings on recommend_title are both enforced, and the hour is the tighter one', async () => {
      const { db, fx } = ctx;
      await setCeiling(db, 'recommendations.max_per_hour', 1);
      await setCeiling(db, 'recommendations.max_per_day', 50);
      const sender = await fx.createUser();
      const r1 = await fx.createUser();
      const r2 = await fx.createUser();
      await fx.mutualFollow(sender, r1);
      await fx.mutualFollow(sender, r2);
      const m1 = await fx.createMovie('First');
      const m2 = await fx.createMovie('Second');

      const s = await db.session('sender');
      await s.actAs(sender);

      assert.equal((await call(s, `recommend_title($1, $2, $3)`, [await newOp(db), r1, m1])).status, 'ok');
      const over = await s.errorFrom(`select recommend_title($1, $2, $3)`, [await newOp(db), r2, m2]);
      assert.equal(over?.code, '53400');
      assert.match(over.hint ?? '', /01:00:00|1 hour/, 'the hour ceiling is the one that fired');

      await s.end();
    });
  });
}
