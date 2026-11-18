import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { fire, newOp, raceContext } from './_shared.mjs';

/**
 * Collection drag-to-rerank from two devices at once (#318, 20261129000100).
 *
 * `collection-rerank.test.mjs` runs on PGlite: one connection, so two moves never overlap.
 * This is the overlap, on a real PostgreSQL.
 *
 * **CR1. Two moves in one band queue on the category lock**, observed waiting on that exact
 * advisory key. The second is computed from the list as it was before the first committed,
 * so its guards are stale, and it must be **refused (55000) rather than land one place
 * off**. That is the whole reason the guards exist: without them the second move's
 * absolute position would be applied to a list it was not computed from.
 *
 * **CR2. Two moves whose guards still hold both land**, in commit order, and I1–I4 and the
 * ledger's P1–P4 survive.
 *
 * **CR3. One operation id sent twice at once applies once**: the replay waits on the
 * ledger claim and returns the first reply, and there is one placement row.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('collection rerank races', () => {
    before(() => rc.open());
    after(() => rc.close());

    /** `n` films ranked into one band, each new one landing at the bottom. */
    const band = async (user, n, label) => {
      const solo = await ctx.db.session('setup');
      await solo.actAs(user);
      const ids = [];
      for (let i = 0; i < n; i += 1) {
        const film = await ctx.fx.createMovie(`${label} ${i}`);
        let step = (await solo.one(`select rank_start($1, 'loved') as r`, [film])).r;
        let guard = 0;
        while (!step.done) {
          step = (await solo.one(`select rank_answer($1, $2) as r`, [step.session_id, step.pivot])).r;
          guard += 1;
          if (guard > 32) throw new Error('did not converge');
        }
        ids.push(film);
      }
      await solo.end();
      return ids;
    };

    const order = async (user) =>
      (
        await ctx.db.rows(
          `select media_item_id from rankings where user_id = $1 and category = 'movies' order by position`,
          [user],
        )
      ).map((r) => r.media_item_id);

    const manualCount = async (user) =>
      Number(
        (
          await ctx.db.rows(
            `select count(*) as n from ranking_placements where user_id = $1 and kind = 'manual'`,
            [user],
          )
        )[0].n,
      );

    const valid = async (user) => {
      await ctx.db.sql(`select assert_ranking_valid($1, 'movies')`, [user]);
      await ctx.db.sql(`select assert_placements_valid($1)`, [user]);
    };

    it('CR1: a second move computed before the first committed waits, then is refused as stale', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await band(user, 4, 'CR1');

      const first = await db.session('device-a');
      const second = await db.session('device-b');
      await first.actAs(user);
      await second.actAs(user);

      // Device A moves #4 to the top: everything shifts down one.
      await first.begin();
      await first.q(`select rank_reorder($1, 1, $2, 4, $3)`, [ids[3], await newOp(db), ids[0]]);

      // Device B, drawn from the same list, moves #2 to #1, above ids[0].
      await second.begin();
      const moving = second.errorFrom(`select rank_reorder($1, 1, $2, 2, $3)`, [
        ids[1],
        await newOp(db),
        ids[0],
      ]);
      const waiting = await second.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.categoryKey(user, 'movies'),
      });
      assert.equal(waiting.wait_event, 'advisory');

      await first.commit();
      const refusal = await moving;
      await second.rollback();

      assert.equal(refusal?.code, '55000', 'the stale move is refused, not applied one place off');
      assert.deepEqual(await order(user), [ids[3], ids[0], ids[1], ids[2]], "only A's move landed");
      assert.equal(await manualCount(user), 1);
      await valid(user);

      await first.end();
      await second.end();
    });

    it('CR2: two moves whose guards still hold both land, in commit order', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await band(user, 4, 'CR2');

      const first = await db.session('device-a');
      const second = await db.session('device-b');
      await first.actAs(user);
      await second.actAs(user);

      // A swaps #1 and #2; B swaps #3 and #4. Neither touches the other's positions.
      await first.begin();
      await first.q(`select rank_reorder($1, 1, $2, 2, $3)`, [ids[1], await newOp(db), ids[0]]);

      await second.begin();
      const moving = fire(second, `rank_reorder($1, 3, $2, 4, $3)`, [ids[3], await newOp(db), ids[2]]);
      await second.awaitBlocked({ on: 'advisory', advisoryKey: await db.categoryKey(user, 'movies') });

      await first.commit();
      await moving;
      await second.commit();

      assert.deepEqual(await order(user), [ids[1], ids[0], ids[3], ids[2]]);
      assert.equal(await manualCount(user), 2);
      await valid(user);

      await first.end();
      await second.end();
    });

    it('CR3: one operation id sent twice at once applies once', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await band(user, 3, 'CR3');
      const id = await newOp(db);

      const first = await db.session('attempt-1');
      const retry = await db.session('attempt-2');
      await first.actAs(user);
      await retry.actAs(user);

      await first.begin();
      const reply = (await first.one(`select rank_reorder($1, 1, $2, 3, $3) as r`, [ids[2], id, ids[0]])).r;

      await retry.begin();
      const replaying = fire(retry, `rank_reorder($1, 1, $2, 3, $3)`, [ids[2], id, ids[0]]);
      await retry.awaitBlocked();

      await first.commit();
      const replayed = (await replaying).rows[0].r;
      await retry.commit();

      assert.deepEqual(await order(user), [ids[2], ids[0], ids[1]]);
      assert.equal(await manualCount(user), 1, 'one move, one placement');
      assert.deepEqual(replayed, reply, 'the replay returns the first reply');
      await valid(user);

      await first.end();
      await retry.end();
    });
  });
}

