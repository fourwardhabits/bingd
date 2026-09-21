import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * Two titles added to one list at once — `20261011000100`.
 *
 * ---------------------------------------------------------------------------
 * THE RACE, AND WHY IT IS A PRODUCT PATH RATHER THAN A THOUGHT EXPERIMENT
 *
 * `AddTitlesSheet` stays open after a tap and does not wait for the previous
 * write: *"the row's tick lands on the tap rather than a round trip later — the
 * sheet stays open and the next tap is immediate"*. So two taps inside one round
 * trip are two overlapping transactions appending to the same list.
 *
 * `_add_list_item_unchecked` appends with `max(position) + 1`. Read outside a
 * lock, both transactions get the same answer, both insert it, and because
 * `list_items_position_unique` is `deferrable initially deferred` nothing
 * complains until COMMIT — at which point the second tap is a `23505` on a list
 * that is not full and a title that is not a duplicate. `move_list_item` has
 * taken the list's advisory key since Lists v1 for exactly this reason; the
 * insert path did not, and now does.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANTS
 *
 * **LA1. The second add is OBSERVED waiting on the list's own advisory key**,
 * and both adds succeed with positions of their own. Correlated to the key the
 * function computes, so deleting the lock turns this red through `awaitBlocked`
 * rather than leaving it green on a lucky interleaving. Unlike the reorder file,
 * the two adds touch **different rows**, so there are no row locks to serialise
 * them accidentally — this one is a regression witness on its own.
 *
 * **LA2. The same title added twice at once answers `already`, never an error.**
 * Under the lock the second transaction's `exists` test runs against a snapshot
 * that contains the first row. Without it, the primary key raises `23505` and a
 * double tap on one row reports a failure for something that worked.
 *
 * **LA3. An add racing a move** leaves the list contiguous and unique — the case
 * where one writer is appending and the other is renumbering everything.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('list add races', () => {
    before(() => rc.open());
    after(() => rc.close());

    /** The advisory key the list writers take, computed the same way they do. */
    const listKey = async (listId) => {
      const [row] = await ctx.db.rows(`select hashtextextended($1::text, 0)::text as k`, [
        listId,
      ]);
      return row.k;
    };

    const stored = (listId) =>
      ctx.db.rows(
        `select media_item_id, "position" from list_items
          where list_id = $1 order by "position"`,
        [listId],
      );

    const assertSound = async (listId, expectedCount) => {
      const rows = await stored(listId);
      assert.equal(rows.length, expectedCount, 'the list lost or gained a row');
      assert.equal(
        new Set(rows.map((r) => r.position)).size,
        expectedCount,
        'two items claim one position',
      );
      assert.equal(
        new Set(rows.map((r) => r.media_item_id)).size,
        expectedCount,
        'a title appears twice',
      );
    };

    /** A list with `n` titles, built through the real writer. */
    const fixture = async (n) => {
      const owner = await ctx.fx.createUser();
      const s = await ctx.db.session('setup');
      await s.actAs(owner);

      const created = await call(
        s,
        `create_list($1, 'Add race', null, 'private'::list_visibility, 'unranked', null)`,
        [await newOp(ctx.db)],
      );
      assert.equal(created.status, 'ok');

      const items = [];
      for (let i = 0; i < n; i += 1) {
        const id = await ctx.fx.createMovie(`Add film ${i}`);
        const added = await call(s, `add_list_item($1, $2, $3)`, [
          await newOp(ctx.db),
          created.id,
          id,
        ]);
        assert.equal(added.status, 'added');
        items.push(id);
      }

      await s.end();
      return { owner, listId: created.id, items };
    };

    const twoDevices = async (owner) => {
      const a = await ctx.db.session('device-a');
      const b = await ctx.db.session('device-b');
      await a.actAs(owner);
      await b.actAs(owner);
      return [a, b];
    };

    // -----------------------------------------------------------------------
    // LA1
    // -----------------------------------------------------------------------

    it('serialises a second add on the list’s own key, and both get a position', async () => {
      const { owner, listId } = await fixture(3);
      const [a, b] = await twoDevices(owner);
      const key = await listKey(listId);
      const first = await ctx.fx.createMovie('Add race first');
      const second = await ctx.fx.createMovie('Add race second');

      try {
        await a.begin();
        const one = await a.one(`select add_list_item($1, $2, $3) as r`, [
          await newOp(ctx.db),
          listId,
          first,
        ]);
        assert.equal(one.r.status, 'added');

        // Fired, not awaited: it must reach the lock and stop there.
        const pending = fire(b, `add_list_item($1, $2, $3)`, [
          await newOp(ctx.db),
          listId,
          second,
        ]);

        await b.awaitBlocked({ on: 'advisory', advisoryKey: key });

        await a.commit();
        const result = (await pending).rows[0].r;
        assert.equal(result.status, 'added', 'the waiting add was refused');
        assert.equal(result.count_after, 5, 'the waiting add counted a stale list');
      } finally {
        await a.end();
        await b.end();
      }

      await assertSound(listId, 5);
    });

    // -----------------------------------------------------------------------
    // LA2
    // -----------------------------------------------------------------------

    it('answers already, not an error, when one title is added twice at once', async () => {
      const { owner, listId } = await fixture(2);
      const [a, b] = await twoDevices(owner);
      const title = await ctx.fx.createMovie('Add race duplicate');

      try {
        const [one, two] = await Promise.all([
          call(a, `add_list_item($1, $2, $3)`, [await newOp(ctx.db), listId, title]),
          call(b, `add_list_item($1, $2, $3)`, [await newOp(ctx.db), listId, title]),
        ]);
        const answers = [one.status, two.status].sort();
        assert.deepEqual(
          answers,
          ['added', 'already'],
          'a double tap on one row must add once and say so once',
        );
      } finally {
        await a.end();
        await b.end();
      }

      await assertSound(listId, 3);
    });

    // -----------------------------------------------------------------------
    // LA3
    // -----------------------------------------------------------------------

    it('survives an add racing a reorder of the same list', async () => {
      const { owner, listId, items } = await fixture(4);
      const [a, b] = await twoDevices(owner);
      const title = await ctx.fx.createMovie('Add race beside a move');

      try {
        const [added, moved] = await Promise.all([
          call(a, `add_list_item($1, $2, $3)`, [await newOp(ctx.db), listId, title]),
          call(b, `move_list_item($1, $2, $3, 0)`, [await newOp(ctx.db), listId, items[3]]),
        ]);
        assert.equal(added.status, 'added');
        assert.equal(moved.status, 'ok');
      } finally {
        await a.end();
        await b.end();
      }

      await assertSound(listId, 5);
    });
  });
}
