import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { inbox, newOp, raceContext } from './_shared.mjs';

/**
 * Recommendation request races (20260826000400).
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **R1. Delivered exactly once.** A send racing a follow-back has two legal
 * interleavings — the send sees the approved edge and delivers, or it stores a pending
 * row that the follow then releases — and both must end at *one* row in `delivered`.
 * `recommend_title` and `follow` take the same `_lock_pair` key, which is what makes
 * this an ordering rather than an interleaving.
 *
 * **R2. Nothing is delivered twice.** An individual Add and a bulk release both move a
 * row out of `pending`, and they can be in flight at once. There is one row, and the
 * `state = 'pending'` guard is what makes the loser a no-op rather than a second
 * delivery.
 *
 * **R3. A dismissal is deterministic by transaction ordering.** Whichever of dismiss
 * and release commits first decides, and the other finds its guard false. What must
 * never happen is a row that is both.
 *
 * **R4. Dismiss all does not resurrect.** A release that arrives after a sweep must not
 * bring anything back, and a sweep that arrives after a release must not take back
 * something already delivered.
 *
 * **R5. Block wins.** Whichever order block and the release land in, the recipient can
 * see nothing from the blocked account afterwards — and no pending row survives to be
 * released by some later follow.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  /** The sender follows the recipient and is not followed back: the request case. */
  const oneWay = async (fx, db, sender, recipient) => {
    await db.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [sender, recipient],
    );
  };

  const sendAs = async (db, sender, recipient, mediaItemId) => {
    const s = await db.session('sender');
    try {
      await s.actAs(sender);
      const { rows } = await s.q(`select recommend_title($1, $2, $3) as r`, [
        await newOp(db),
        recipient,
        mediaItemId,
      ]);
      return rows[0].r;
    } finally {
      await s.end();
    }
  };

  /** Every row between the pair, with its stored state. Read as the owner. */
  const rowsBetween = (db, sender, recipient) =>
    db.rows(
      `select id, media_item_id, state from title_recommendations
        where sender_id = $1 and recipient_id = $2 order by media_item_id`,
      [sender, recipient],
    );

  /** What the recipient's two screens actually show, through the real read paths. */
  const screens = async (db, recipient) => {
    const s = await db.session('reader');
    try {
      await s.actAs(recipient);
      const { rows: list } = await s.q(`select * from recommendations_to_me(200)`);
      const { rows: held } = await s.q(`select * from recommendation_requests(200)`);
      return { delivered: list, requests: held };
    } finally {
      await s.end();
    }
  };

  describe('recommendation request races', () => {
    before(() => rc.open());
    after(() => rc.close());

    /**
     * R1, both ways round.
     *
     * The two interleavings are genuinely different products — one delivers with a
     * notification, the other releases silently — and the invariant is what they share:
     * one row, delivered, and a notification count that matches the branch that ran
     * rather than one that got filed twice.
     */
    for (const first of ['follow', 'send']) {
      it(`R1: a send racing a follow-back delivers exactly once (${first} takes the lock)`, async () => {
        const { db, fx } = ctx;
        const sender = await fx.createUser();
        const recipient = await fx.createUser();
        await oneWay(fx, db, sender, recipient);
        const movie = await fx.createMovie(`Send Versus Follow ${first}`);

        const ctl = await db.controller();
        await ctl.holdPair(sender, recipient);

        const tFollow = await db.session('follower');
        const tSend = await db.session('sender');
        await tFollow.actAs(recipient);
        await tSend.actAs(sender);

        const pairKey = await db.pairKey(sender, recipient);

        /**
         * Each returns a **box** around the in-flight promise rather than the promise
         * itself.
         *
         * An `async` helper that returns a promise has its own promise *adopt* it, so
         * `await startFollow()` would wait for the `follow` call to finish — which it
         * cannot, because the controller is still holding the pair lock and the other
         * half of the race has not been started yet. The test deadlocks and reports it
         * as a timeout in the schema.
         */
        const startFollow = async () => {
          await tFollow.begin();
          const box = { p: tFollow.start(`select follow($1, $2) as r`, [await newOp(db), sender]) };
          await tFollow.awaitBlocked({ on: 'advisory', advisoryKey: pairKey });
          return box;
        };
        const startSend = async () => {
          await tSend.begin();
          const box = {
            p: tSend.start(`select recommend_title($1, $2, $3) as r`, [
              await newOp(db),
              recipient,
              movie,
            ]),
          };
          await tSend.awaitBlocked({ on: 'advisory', advisoryKey: pairKey });
          return box;
        };

        // Whoever is queued on the pair lock first acquires it first.
        let followBox;
        let sendBox;
        if (first === 'follow') {
          followBox = await startFollow();
          sendBox = await startSend();
        } else {
          sendBox = await startSend();
          followBox = await startFollow();
        }
        const pFollow = followBox.p;
        const pSend = sendBox.p;

        /**
         * **Each transaction commits as soon as its own statement returns**, rather
         * than the test awaiting one and then the other.
         *
         * The pair lock is transaction-scoped, so the loser is waiting on the winner's
         * *commit* — and a test that awaits the loser first while holding the winner
         * open deadlocks the harness, not the schema. Which of the two acquires the
         * lock is exactly what this test is varying, so the sequencing must not assume
         * an answer to it.
         */
        const followDone = pFollow.then(async (r) => {
          await tFollow.commit();
          return r;
        });
        const sendDone = pSend.then(async (r) => {
          await tSend.commit();
          return r;
        });

        await ctl.releasePair(sender, recipient);
        const [, sendRow] = await Promise.all([followDone, sendDone]);
        const sent = sendRow.rows[0].r;

        const rows = await rowsBetween(db, sender, recipient);
        assert.equal(rows.length, 1, 'R1: one canonical row whichever order they landed in');
        assert.equal(rows[0].state, 'delivered', 'R1: and it is not left waiting');

        const { delivered, requests } = await screens(db, recipient);
        assert.equal(delivered.length, 1, 'R1: delivered exactly once');
        assert.equal(requests.length, 0);

        // The notification follows the branch that ran and is filed at most once. A
        // release is silent by design, so the send-first ordering leaves none at all --
        // which is the same thing every bulk release does.
        assert.equal(
          (await inbox(db, recipient, sender)).filter((n) => n.type === 'recommendation').length,
          sent.delivered ? 1 : 0,
        );

        await tFollow.end();
        await tSend.end();
        await ctl.end();
      });
    }

    /**
     * R2. Add holds the row; the release queues behind it on that row and finds the
     * guard false. No advisory lock is involved on the Add side at all — the row lock
     * is the whole mechanism, and that is worth proving rather than assuming.
     */
    it('R2: an individual Add racing a bulk release delivers one copy, not two', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      await oneWay(fx, db, sender, recipient);
      const a = await fx.createMovie('Add Versus Release A');
      const b = await fx.createMovie('Add Versus Release B');
      await sendAs(db, sender, recipient, a);
      await sendAs(db, sender, recipient, b);

      const held = (await rowsBetween(db, sender, recipient)).find((r) => r.media_item_id === a);

      const tAdd = await db.session('adder');
      await tAdd.actAs(recipient);
      await tAdd.begin();
      await tAdd.q(`select add_recommendation($1)`, [held.id]);

      const tFollow = await db.session('follower');
      await tFollow.actAs(recipient);
      await tFollow.begin();
      const pFollow = tFollow.start(`select follow($1, $2) as r`, [await newOp(db), sender]);
      // The release updates every pending row for the pair, so it meets the Add on the
      // one it is holding.
      await tFollow.awaitBlocked({ on: 'transactionid' });

      await tAdd.commit();
      await pFollow;
      await tFollow.commit();

      const rows = await rowsBetween(db, sender, recipient);
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((r) => r.state).sort(),
        ['delivered', 'delivered'],
        'R2: the added one is not delivered a second time by the release',
      );

      const { delivered, requests } = await screens(db, recipient);
      assert.equal(delivered.length, 2, 'R2: two titles, two rows, no duplicate');
      assert.equal(requests.length, 0);

      await tAdd.end();
      await tFollow.end();
    });

    /** R3, both orderings. Whichever commits first decides, and never both. */
    it('R3: a dismissal that commits before the release is never released', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      await oneWay(fx, db, sender, recipient);
      const a = await fx.createMovie('Dismiss Versus Release A');
      const b = await fx.createMovie('Dismiss Versus Release B');
      await sendAs(db, sender, recipient, a);
      await sendAs(db, sender, recipient, b);

      const target = (await rowsBetween(db, sender, recipient)).find((r) => r.media_item_id === a);

      const tDismiss = await db.session('dismisser');
      await tDismiss.actAs(recipient);
      await tDismiss.begin();
      await tDismiss.q(`select dismiss_recommendation($1)`, [target.id]);

      const tFollow = await db.session('follower');
      await tFollow.actAs(recipient);
      await tFollow.begin();
      const pFollow = tFollow.start(`select follow($1, $2) as r`, [await newOp(db), sender]);
      await tFollow.awaitBlocked({ on: 'transactionid' });

      await tDismiss.commit();
      await pFollow;
      await tFollow.commit();

      const rows = await rowsBetween(db, sender, recipient);
      const byMedia = Object.fromEntries(rows.map((r) => [r.media_item_id, r.state]));
      assert.equal(byMedia[a], 'dismissed', 'R3: a dismissal the release raced still stands');
      assert.equal(byMedia[b], 'delivered');

      const { delivered, requests } = await screens(db, recipient);
      assert.equal(delivered.length, 1);
      assert.equal(requests.length, 0);

      await tDismiss.end();
      await tFollow.end();
    });

    it('R3: a dismissal that arrives after the release is a no-op, not a retraction', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      await oneWay(fx, db, sender, recipient);
      const movie = await fx.createMovie('Release Versus Dismiss');
      await sendAs(db, sender, recipient, movie);
      const target = (await rowsBetween(db, sender, recipient))[0];

      const tFollow = await db.session('follower');
      await tFollow.actAs(recipient);
      await tFollow.begin();
      await tFollow.q(`select follow($1, $2)`, [await newOp(db), sender]);

      const tDismiss = await db.session('dismisser');
      await tDismiss.actAs(recipient);
      await tDismiss.begin();
      const pDismiss = tDismiss.start(`select dismiss_recommendation($1) as r`, [target.id]);
      await tDismiss.awaitBlocked({ on: 'transactionid' });

      await tFollow.commit();
      const result = (await pDismiss).rows[0].r;
      await tDismiss.commit();

      assert.equal(result.dismissed, false, 'R3: the guard, not an error');
      assert.equal((await rowsBetween(db, sender, recipient))[0].state, 'delivered');
      assert.equal((await screens(db, recipient)).delivered.length, 1);

      await tFollow.end();
      await tDismiss.end();
    });

    /** R4. A sweep and a release, in both directions, with nothing coming back. */
    it('R4: Dismiss all racing a follow resurrects nothing', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      await oneWay(fx, db, sender, recipient);
      for (const title of ['Sweep A', 'Sweep B', 'Sweep C']) {
        await sendAs(db, sender, recipient, await fx.createMovie(title));
      }

      const tSweep = await db.session('sweeper');
      await tSweep.actAs(recipient);
      await tSweep.begin();
      await tSweep.q(`select dismiss_all_recommendation_requests($1)`, [await newOp(db)]);

      const tFollow = await db.session('follower');
      await tFollow.actAs(recipient);
      await tFollow.begin();
      const pFollow = tFollow.start(`select follow($1, $2) as r`, [await newOp(db), sender]);
      await tFollow.awaitBlocked({ on: 'transactionid' });

      await tSweep.commit();
      await pFollow;
      await tFollow.commit();

      const rows = await rowsBetween(db, sender, recipient);
      assert.deepEqual(
        rows.map((r) => r.state),
        ['dismissed', 'dismissed', 'dismissed'],
        'R4: the follow must not undo a sweep that already committed',
      );
      const { delivered, requests } = await screens(db, recipient);
      assert.equal(delivered.length, 0);
      assert.equal(requests.length, 0);

      await tSweep.end();
      await tFollow.end();
    });

    it('R4: a sweep that arrives after the release does not take delivered ones back', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      await oneWay(fx, db, sender, recipient);
      await sendAs(db, sender, recipient, await fx.createMovie('Late Sweep A'));
      await sendAs(db, sender, recipient, await fx.createMovie('Late Sweep B'));

      const tFollow = await db.session('follower');
      await tFollow.actAs(recipient);
      await tFollow.begin();
      await tFollow.q(`select follow($1, $2)`, [await newOp(db), sender]);

      const tSweep = await db.session('sweeper');
      await tSweep.actAs(recipient);
      await tSweep.begin();
      const pSweep = tSweep.start(`select dismiss_all_recommendation_requests($1) as r`, [
        await newOp(db),
      ]);
      await tSweep.awaitBlocked({ on: 'transactionid' });

      await tFollow.commit();
      const swept = (await pSweep).rows[0].r;
      await tSweep.commit();

      assert.equal(swept.dismissed, 0, 'R4: there was nothing left pending to sweep');
      assert.equal((await screens(db, recipient)).delivered.length, 2);

      await tFollow.end();
      await tSweep.end();
    });

    /**
     * R5, both orderings.
     *
     * `block` and `follow` already take the same pair lock, so this is an ordering
     * question rather than an interleaving one. What is being proved is that the
     * *recipient sees nothing from the blocked account either way* — once because the
     * pending rows were deleted before they could be released, and once because
     * `profiles_read` drops the sender from a list that did get released.
     */
    it('R5: a block that lands first leaves nothing to release', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      await oneWay(fx, db, sender, recipient);
      await sendAs(db, sender, recipient, await fx.createMovie('Block First A'));
      await sendAs(db, sender, recipient, await fx.createMovie('Block First B'));

      const ctl = await db.controller();
      await ctl.holdPair(sender, recipient);

      const tBlock = await db.session('blocker');
      await tBlock.actAs(recipient);
      await tBlock.begin();
      const pBlock = tBlock.start(`select block($1, $2) as r`, [await newOp(db), sender]);
      await tBlock.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.pairKey(sender, recipient),
      });

      const tFollow = await db.session('follower');
      await tFollow.actAs(recipient);
      await tFollow.begin();
      const pFollow = tFollow.start(`select follow($1, $2) as r`, [await newOp(db), sender]);
      await tFollow.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.pairKey(sender, recipient),
      });

      await ctl.releasePair(sender, recipient);
      await pBlock;
      await tBlock.commit();

      // `_assert_reachable` refuses a blocked target, so the follow that queued behind
      // the block cannot happen at all — and there is nothing left for it to release.
      await assert.rejects(pFollow, (e) => e.code === 'P0002');
      await tFollow.rollback();

      assert.equal(
        (await rowsBetween(db, sender, recipient)).length,
        0,
        'R5: no pending row survives a block to be released by some later follow',
      );
      const { delivered, requests } = await screens(db, recipient);
      assert.equal(delivered.length, 0);
      assert.equal(requests.length, 0);

      await tBlock.end();
      await tFollow.end();
      await ctl.end();
    });

    it('R5: a block that lands after a release hides the delivered rows it left behind', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      await oneWay(fx, db, sender, recipient);
      await sendAs(db, sender, recipient, await fx.createMovie('Block Second A'));
      await sendAs(db, sender, recipient, await fx.createMovie('Block Second B'));

      const s = await db.session('recipient');
      await s.actAs(recipient);
      await s.q(`select follow($1, $2)`, [await newOp(db), sender]);
      await s.q(`select block($1, $2)`, [await newOp(db), sender]);
      await s.end();

      const rows = await rowsBetween(db, sender, recipient);
      assert.deepEqual(
        rows.map((r) => r.state),
        ['delivered', 'delivered'],
        'R5: a delivered recommendation is the reader’s own history and is not deleted',
      );

      const { delivered, requests } = await screens(db, recipient);
      assert.equal(delivered.length, 0, 'R5: but profiles_read drops the sender while blocked');
      assert.equal(requests.length, 0);
    });
  });
}
