import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * Reordering one list from two devices at once — `20261010000100`.
 *
 * ---------------------------------------------------------------------------
 * THE RACE THE LOCK EXISTS FOR
 *
 * `move_list_item` renumbers the whole list to a contiguous 1…N in a single
 * `update`, computed from `row_number()` over the rows as it found them. Two
 * moves on one list run that computation against snapshots taken before either
 * committed, so under READ COMMITTED each one writes an order derived from the
 * list *without* the other's change in it.
 *
 * The damage is not "one move is lost" — last-move-wins is the documented and
 * intended resolution (§E), and losing one of two simultaneous reorders is what
 * a person would expect. The damage is the **deferrable unique**: two full
 * renumberings interleaving can leave two rows claiming one position, and
 * because the constraint is `deferrable initially deferred`, that is discovered
 * at COMMIT rather than at the statement. The loser gets a `23505` it did
 * nothing to earn, on a control that is an arrow on a row.
 *
 * `pg_advisory_xact_lock(hashtextextended(list_id, 0))` is the fix, and it is
 * the same shape as `_leave_series_watchlist`'s: the second transaction waits,
 * and then computes its `row_number()` under a snapshot that contains the first
 * move.
 *
 * **This is invisible to `lists.test.mjs`**, which runs on PGlite — one
 * connection, so two transactions never overlap and every interleaving is
 * serial by construction. That is the gap this whole directory exists for.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANTS
 *
 * **LM1. The second move is OBSERVED waiting on the list's own advisory key**,
 * and both moves succeed. Named rather than "a lock", so deleting
 * `pg_advisory_xact_lock` from `move_list_item` turns this red through
 * `awaitBlocked` instead of leaving it green on a lucky interleaving.
 *
 * **LM2. Positions stay unique and contiguous** however the scheduler lands two
 * bare concurrent moves — the invariant the deferrable constraint protects, and
 * the one a person would notice breaking.
 *
 * **LM3. A move racing a removal of a different item** leaves every surviving
 * title on the list with a position of its own. Remove does not renumber, so
 * this is the case where one writer is compacting and the other is punching a
 * hole.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MUTATION CHECK ACTUALLY SHOWED, WHICH IS LESS THAN IT LOOKS
 *
 * Deleting the advisory lock from `move_list_item` turns **LM1 red and leaves
 * LM2 and LM3 green** (measured, 2026-09-20). LM1 reports exactly what it
 * should: *"never blocked on advisory key … last seen wait=Lock/transactionid"*.
 *
 * That last word is the finding. Without the advisory lock the two moves still
 * serialise — on the **row locks** their `UPDATE`s take, because both rewrite
 * the same rows. So the corruption these tests are named for is harder to reach
 * than "remove the lock and watch it break", and LM2 and LM3 are **invariant
 * checks rather than regression witnesses**: they say the list survives, and
 * they would not by themselves notice the lock going.
 *
 * LM1 is the one that carries the claim, and it is written to. The advisory lock
 * is still worth having for the reason it is worth having everywhere else here:
 * row locks serialise the *statement*, and the function computes `row_number()`
 * over a snapshot taken **before** it — so what the row locks protect is the
 * write, not the arithmetic that decided it. Stating the bound is better than
 * three green tests that imply a stronger one.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('list reorder races', () => {
    before(() => rc.open());
    after(() => rc.close());

    /** The advisory key `move_list_item` takes, computed the same way it does. */
    const listKey = async (listId) => {
      const [row] = await ctx.db.rows(
        `select hashtextextended($1::text, 0)::text as k`,
        [listId],
      );
      return row.k;
    };

    /** The list as stored: the raw positions, in order. */
    const stored = (listId) =>
      ctx.db.rows(
        `select li.media_item_id, li.position, m.title
           from list_items li join media_items m on m.id = li.media_item_id
          where li.list_id = $1 order by li.position`,
        [listId],
      );

    /**
     * A list of `n` titles owned by a fresh account, built through the real writers
     * so that positions are whatever `add_list_item` actually assigns.
     */
    const fixture = async (n) => {
      const owner = await ctx.fx.createUser();
      const session = await ctx.db.session('owner');
      await session.actAs(owner);

      const created = await call(
        session,
        `create_list($1, 'Race list', null, 'private'::list_visibility, 'ranked', null)`,
        [await newOp(ctx.db)],
      );
      assert.equal(created.status, 'ok');

      const items = [];
      for (let i = 0; i < n; i += 1) {
        const id = await ctx.fx.createMovie(`Film ${i}`);
        const added = await call(session, `add_list_item($1, $2, $3)`, [
          await newOp(ctx.db),
          created.id,
          id,
        ]);
        assert.equal(added.status, 'added');
        items.push(id);
      }

      await session.end();
      return { owner, listId: created.id, items };
    };

    /** Two sessions acting as the same owner, which is the two-devices case. */
    const twoDevices = async (owner) => {
      const a = await ctx.db.session('device-a');
      const b = await ctx.db.session('device-b');
      await a.actAs(owner);
      await b.actAs(owner);
      return [a, b];
    };

    const assertContiguous = async (listId, expectedCount) => {
      const rows = await stored(listId);
      assert.equal(rows.length, expectedCount, 'the list lost or gained a row');
      assert.deepEqual(
        rows.map((row) => row.position),
        Array.from({ length: expectedCount }, (_, i) => i + 1),
        'positions are not a contiguous 1..N',
      );
      assert.equal(
        new Set(rows.map((row) => row.media_item_id)).size,
        expectedCount,
        'a title appears twice',
      );
    };

    // -----------------------------------------------------------------------
    // LM1
    // -----------------------------------------------------------------------

    it('serialises a second move on the same list, on the list’s own key', async () => {
      const { owner, listId, items } = await fixture(4);
      const [a, b] = await twoDevices(owner);
      const key = await listKey(listId);

      try {
        await a.begin();
        await a.one(`select move_list_item($1, $2, $3, 0) as r`, [
          await newOp(ctx.db),
          listId,
          items[3],
        ]);

        // Fired, not awaited: it must reach the lock and stop there.
        const second = fire(b, `move_list_item($1, $2, $3, 0)`, [
          await newOp(ctx.db),
          listId,
          items[2],
        ]);

        // The assertion that carries this file. Correlated to the key
        // `move_list_item` computes, so "something serialised these" is not enough.
        await b.awaitBlocked({ on: 'advisory', advisoryKey: key });

        await a.commit();
        // `fire` resolves the driver's full result, not a row — `session.start` is
        // `client.query`. The answer is the first row's `r`.
        const result = (await second).rows[0].r;
        assert.equal(result.status, 'ok', 'the waiting move was refused');
      } finally {
        await a.end();
        await b.end();
      }

      // Last move wins, and the list is intact.
      await assertContiguous(listId, 4);
      const rows = await stored(listId);
      assert.equal(rows[0].media_item_id, items[2], 'the second move did not win');
    });

    // -----------------------------------------------------------------------
    // LM2
    // -----------------------------------------------------------------------

    it('keeps positions unique and contiguous under two bare concurrent moves', async () => {
      const { owner, listId, items } = await fixture(5);
      const [a, b] = await twoDevices(owner);

      try {
        // No barrier and no begin: whichever way the scheduler lands them, both
        // must commit and the list must survive. An invariant check rather than a
        // regression witness — see the header on what the mutation actually showed.
        const [first, second] = await Promise.all([
          call(a, `move_list_item($1, $2, $3, 4)`, [await newOp(ctx.db), listId, items[0]]),
          call(b, `move_list_item($1, $2, $3, 0)`, [await newOp(ctx.db), listId, items[4]]),
        ]);
        assert.equal(first.status, 'ok');
        assert.equal(second.status, 'ok');
      } finally {
        await a.end();
        await b.end();
      }

      await assertContiguous(listId, 5);
    });

    // -----------------------------------------------------------------------
    // LM3
    // -----------------------------------------------------------------------

    it('survives a move racing a removal of a different title', async () => {
      const { owner, listId, items } = await fixture(4);
      const [a, b] = await twoDevices(owner);

      try {
        const [moved, removed] = await Promise.all([
          call(a, `move_list_item($1, $2, $3, 0)`, [await newOp(ctx.db), listId, items[3]]),
          call(b, `remove_list_item($1, $2, $3)`, [await newOp(ctx.db), listId, items[1]]),
        ]);
        assert.equal(moved.status, 'ok');
        assert.equal(removed.status, 'ok');
      } finally {
        await a.end();
        await b.end();
      }

      const rows = await stored(listId);
      assert.equal(rows.length, 3, 'the removal did not take, or took too much');
      assert.equal(
        rows.some((row) => row.media_item_id === items[1]),
        false,
        'the removed title is still on the list',
      );
      assert.equal(
        new Set(rows.map((row) => row.position)).size,
        rows.length,
        'two surviving rows share a position',
      );

      /**
       * **Contiguity is deliberately not asserted here.** `remove_list_item` does
       * not renumber — the gap is invisible because every reader draws the
       * read-time ordinal — so a list that has had a removal legitimately has one.
       * What must hold is uniqueness, which is what the constraint protects, and
       * that the ordinals a reader sees are still 1…N.
       */
      const ordinals = await ctx.db.rows(
        `select row_number() over (order by position) as ord
           from list_items where list_id = $1 order by position`,
        [listId],
      );
      assert.deepEqual(
        ordinals.map((row) => Number(row.ord)),
        [1, 2, 3],
        'the ordinals a reader would see are not 1..N',
      );
    });
  });
}
