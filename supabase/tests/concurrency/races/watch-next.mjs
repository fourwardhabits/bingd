import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, newOp, raceContext } from './_shared.mjs';

/**
 * Watch next, under independent connections — `20260929000200`.
 *
 * PGlite is one connection, so `watch-next.test.mjs` cannot see any of this. The writer
 * reads a count and then inserts, and the Watchlist row it hangs off can be deleted by
 * another transaction at any moment; the constraints hold the cap regardless, but the
 * promises below are about the *answers* a client gets, and about never deadlocking with
 * the Watchlist writers.
 *
 * THE INVARIANTS
 *
 * **WN1. Two pins racing for the last slot: one `ok`, one `full`, and the second is
 * OBSERVED waiting.** On which key is worth being exact about, for the reason
 * `recommendation.mjs` C1 records for two sends by one sender: the first lock either call
 * reaches is `_assert_operation_rate`'s per-account key for `set_watch_next`, held to
 * commit, so that is what the loser waits on and the `watch-next:` key is never contended
 * here. The writer's own key is the second line — it keeps the answer right if the rate
 * limiter ever stops locking — and the structural cap is the third. What this asserts is
 * the observable: the loser waits, then reads three pins and answers `full` with them,
 * rather than reaching the insert with a stale count and dying on 23505.
 *
 * **WN2. A pin racing an unsave of the same title never leaves an orphan and never
 * errors.** Either the unsave commits first and the pin is refused `not_on_watchlist`, or
 * the pin holds the Watchlist row (`for key share`) and the unsave, queued behind it,
 * cascades the new pin away.
 *
 * **WN3. A pin racing the series trigger that finishes that series does not deadlock**,
 * and the series leaves both lists.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('watch next races', () => {
    before(() => rc.open());
    after(() => rc.close());

    /** One saved-and-pinned title per call, through the real writers. */
    const setUp = async (who, count) => {
      const s = await ctx.db.session('setup');
      await s.actAs(who);
      const ids = [];
      for (let i = 0; i < count; i += 1) {
        const id = await ctx.fx.createMovie(`WN ${who.slice(0, 6)} ${i}`);
        await call(s, `set_watchlist($1, $2, true)`, [await newOp(ctx.db), id]);
        ids.push(id);
      }
      return { s, ids };
    };

    const pins = async (who) =>
      (
        await ctx.db.rows(
          `select media_item_id from watch_next where user_id = $1 order by slot`,
          [who],
        )
      ).map((r) => r.media_item_id);

    it('WN1: two pins racing for the last slot get one ok and one full, serialised on the key', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const { s, ids } = await setUp(me, 4);
      await call(s, `set_watch_next($1, $2, true)`, [await newOp(db), ids[0]]);
      await call(s, `set_watch_next($1, $2, true)`, [await newOp(db), ids[1]]);
      await s.end();

      await db.armBarrier('watch_next', 'wn-last-slot');
      const ctl = await db.controller();
      await ctl.hold('wn-last-slot');

      const t1 = await db.session('device-a');
      const t2 = await db.session('device-b');
      await t1.actAs(me);
      await t2.actAs(me);

      await t1.begin();
      await t1.pauseAt('wn-last-slot');
      const p1 = t1.start(`select set_watch_next($1, $2, true) as r`, [
        await newOp(db),
        ids[2],
      ]);
      await t1.awaitBlocked();

      await t2.begin();
      const p2 = t2.start(`select set_watch_next($1, $2, true) as r`, [
        await newOp(db),
        ids[3],
      ]);
      await t2.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.accountKey(me, 'set_watch_next'),
      });

      await ctl.release('wn-last-slot');
      const r1 = (await p1).rows[0].r;
      await t1.commit();
      const r2 = (await p2).rows[0].r;
      await t2.commit();

      assert.equal(r1.status, 'ok');
      assert.deepEqual(r2, {
        status: 'refused',
        reason: 'full',
        pinned: [ids[0], ids[1], ids[2]],
      });
      assert.deepEqual(await pins(me), [ids[0], ids[1], ids[2]]);

      await db.disarmBarrier('watch_next');
      await t1.end();
      await t2.end();
      await ctl.end();
    });

    it('WN1b: two pins with two slots free both land, in distinct slots', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const { s, ids } = await setUp(me, 3);
      await call(s, `set_watch_next($1, $2, true)`, [await newOp(db), ids[0]]);
      await s.end();

      const t1 = await db.session('device-a');
      const t2 = await db.session('device-b');
      await t1.actAs(me);
      await t2.actAs(me);
      const [a, b] = await Promise.all([
        call(t1, `set_watch_next($1, $2, true)`, [await newOp(db), ids[1]]),
        call(t2, `set_watch_next($1, $2, true)`, [await newOp(db), ids[2]]),
      ]);

      assert.equal(a.status, 'ok');
      assert.equal(b.status, 'ok');
      const slots = await db.rows(
        `select slot from watch_next where user_id = $1 order by slot`,
        [me],
      );
      assert.deepEqual(
        slots.map((r) => r.slot),
        [1, 2, 3],
      );

      await t1.end();
      await t2.end();
    });

    it('WN2: a pin racing an unsave of the same title leaves no orphan, whichever wins', async () => {
      const { db, fx } = ctx;

      for (const pinFirst of [true, false]) {
        const me = await fx.createUser();
        const { s, ids } = await setUp(me, 1);
        await s.end();
        const [film] = ids;

        const pinner = await db.session('pinner');
        const unsaver = await db.session('unsaver');
        await pinner.actAs(me);
        await unsaver.actAs(me);

        const pinSql = `select set_watch_next($1, $2, true) as r`;
        const unsaveSql = `select set_watchlist($1, $2, false) as r`;

        let pinned;
        if (pinFirst) {
          // The pin takes `for key share` on the Watchlist row; the unsave's delete must
          // then wait for it, and cascade the new pin away once it commits.
          await pinner.begin();
          pinned = (await pinner.q(pinSql, [await newOp(db), film])).rows[0].r;
          await unsaver.begin();
          const up = unsaver.start(unsaveSql, [await newOp(db), film]);
          await unsaver.awaitBlocked();
          await pinner.commit();
          await up;
          await unsaver.commit();
          assert.equal(pinned.status, 'ok');
        } else {
          // The unsave holds the row; the pin queues on it and must find it gone.
          await unsaver.begin();
          await unsaver.q(unsaveSql, [await newOp(db), film]);
          await pinner.begin();
          const pp = pinner.start(pinSql, [await newOp(db), film]);
          await pinner.awaitBlocked();
          await unsaver.commit();
          pinned = (await pp).rows[0].r;
          await pinner.commit();
          assert.deepEqual(pinned, { status: 'refused', reason: 'not_on_watchlist' });
        }

        assert.deepEqual(await pins(me), [], `no orphan pin (pin first: ${pinFirst})`);
        await pinner.end();
        await unsaver.end();
      }
    });

    it('WN3: a pin racing the trigger that finishes the series does not deadlock', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const show = await fx.createSeries('WN3 Series');
      const s1 = await fx.createSeason(show, 1);
      const other = await fx.createMovie('WN3 Other');

      const setup = await db.session('setup');
      await setup.actAs(me);
      await call(setup, `set_watchlist($1, $2, true)`, [await newOp(db), show]);
      await call(setup, `set_watchlist($1, $2, true)`, [await newOp(db), other]);
      await call(setup, `set_watch_next($1, $2, true)`, [await newOp(db), other]);
      await setup.end();

      const finisher = await db.session('finisher');
      const pinner = await db.session('pinner');
      await finisher.actAs(me);
      await pinner.actAs(me);

      // The pin holds the key and the series row (key share) first; the series trigger
      // then wants to delete that row and waits; the pin commits; the delete cascades.
      await pinner.begin();
      const pinned = (
        await pinner.q(`select set_watch_next($1, $2, true, $3) as r`, [
          await newOp(db),
          show,
          other,
        ])
      ).rows[0].r;
      assert.equal(pinned.status, 'ok');

      await finisher.begin();
      const fp = finisher.start(`select set_bucket($1, $2, 'loved') as r`, [
        await newOp(db),
        s1,
      ]);
      await finisher.awaitBlocked();
      await pinner.commit();
      await fp;
      await finisher.commit();

      assert.deepEqual(
        await pins(me),
        [],
        'the finished series leaves Watch next with its row',
      );
      const left = await db.rows(
        `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
        [me, show],
      );
      assert.equal(left.length, 0);

      await finisher.end();
      await pinner.end();
    });
  });
}
