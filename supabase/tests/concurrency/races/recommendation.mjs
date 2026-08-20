import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, inbox, newOp, raceContext } from './_shared.mjs';

/**
 * Recommendation races.
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **C1. One row per (sender, recipient, title), for good.** `recommend_title` reads
 * then writes, with no unique index behind it and no upsert — the pair lock is the
 * whole of its atomicity. Two clients sending the same title at the same moment must
 * therefore produce one row, not two.
 *
 * **C2. One notice per recommendation, ever.** The notice is filed only when the row
 * is created. A second send moves `recommended_at` and files nothing, because a
 * notice that can be re-fired by re-sending is a way to ping somebody repeatedly.
 * A *race* must not be a way round that.
 *
 * **C3. `opened_at` survives a resend.** Deliberately absent from the update, and
 * load-bearing: a resend must not make a read recommendation look unread.
 *
 * **C4. `recommended_at` is deterministic under a race** — it is the later of the two
 * commits, because the second call runs entirely after the first has released the
 * pair lock. Not merely "some value"; the ordering is what the recipient's list is
 * sorted by.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('recommendation races', () => {
    before(() => rc.open());
    after(() => rc.close());

    it('C1/C2: the same title sent twice at once yields one row and one notice', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      await fx.mutualFollow(sender, recipient);
      const movie = await fx.createMovie('Simultaneous Send');

      await db.armBarrier('title_recommendations', 'dup-send');
      const ctl = await db.controller();
      await ctl.hold('dup-send');

      const t1 = await db.session('client-a');
      const t2 = await db.session('client-b');
      await t1.actAs(sender);
      await t2.actAs(sender);

      await t1.begin();
      await t1.pauseAt('dup-send');
      const p1 = t1.start(`select recommend_title($1, $2, $3) as r`, [
        await newOp(db),
        recipient,
        movie,
      ]);
      await t1.awaitBlocked();

      await t2.begin();
      const p2 = t2.start(`select recommend_title($1, $2, $3) as r`, [
        await newOp(db),
        recipient,
        movie,
      ]);
      // Different operation ids, so the ledger does not serialise them. *Something*
      // must, or both would find no row and both would insert.
      //
      // Correlating against the exact key showed which, and corrected this test: for
      // two sends by the **same** sender the first lock either transaction reaches is
      // `_assert_operation_rate`'s per-account one, so that is what the loser waits on
      // and the pair lock is never contended here. Asserting the pair key would have
      // been a claim about a lock this interleaving does not exercise — which is
      // exactly the weakness review 25 named. The pair lock is proved separately, by
      // the block races in notification-block.mjs.
      await t2.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.accountKey(sender, 'recommend_title'),
      });

      await ctl.release('dup-send');
      const r1 = (await p1).rows[0].r;
      await t1.commit();
      const r2 = (await p2).rows[0].r;
      await t2.commit();

      assert.equal(r1.created, true);
      assert.equal(r2.created, false, 'C1: the second call must find the first one’s row');
      assert.equal(r1.id, r2.id);

      const rows = await db.rows(
        `select id, recommended_at from title_recommendations
          where sender_id = $1 and recipient_id = $2 and media_item_id = $3`,
        [sender, recipient, movie],
      );
      assert.equal(rows.length, 1, 'C1: one canonical row');
      assert.equal((await inbox(db, recipient, sender)).length, 1, 'C2: one notice');

      await db.sql(`drop trigger if exists _race_barrier_title_recommendations on title_recommendations`);
      await t1.end();
      await t2.end();
      await ctl.end();
    });

    it('C3/C4: a resend moves recommended_at forward and leaves opened_at alone', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      await fx.mutualFollow(sender, recipient);
      const movie = await fx.createMovie('Resend Semantics');

      const s = await db.session('sender');
      await s.actAs(sender);
      const first = await call(s, `recommend_title($1, $2, $3)`, [await newOp(db), recipient, movie]);

      const r = await db.session('recipient');
      await r.actAs(recipient);
      await r.q(`select mark_recommendation_opened($1)`, [first.id]);
      await r.end();

      const before = (
        await db.rows(`select recommended_at, opened_at from title_recommendations where id = $1`, [
          first.id,
        ])
      )[0];
      assert.notEqual(before.opened_at, null);

      const again = await call(s, `recommend_title($1, $2, $3)`, [await newOp(db), recipient, movie]);
      assert.equal(again.created, false);

      const afterRow = (
        await db.rows(`select recommended_at, opened_at from title_recommendations where id = $1`, [
          first.id,
        ])
      )[0];

      assert.ok(
        afterRow.recommended_at >= before.recommended_at,
        'C4: a resend moves the row up the recipient’s list',
      );
      assert.deepEqual(afterRow.opened_at, before.opened_at, 'C3: opened_at must survive a resend');
      assert.equal((await inbox(db, recipient, sender)).length, 1, 'C2: still one notice');

      await s.end();
    });

    it('recommendation raced with a block leaves no row and no notice', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      await fx.mutualFollow(sender, recipient);
      const movie = await fx.createMovie('Blocked Mid-Send');

      const ctl = await db.controller();
      await ctl.holdPair(sender, recipient);

      // The block gets the pair lock first; the send queues behind it and must then
      // find itself no longer mutual.
      const t2 = await db.session('blocker');
      await t2.actAs(recipient);
      await t2.begin();
      const blockP = t2.start(`select block($1, $2) as r`, [await newOp(db), sender]);
      await t2.awaitBlocked({ on: 'advisory', advisoryKey: await db.pairKey(sender, recipient) });

      const t1 = await db.session('sender');
      await t1.actAs(sender);
      await t1.begin();
      const sendP = t1.start(`select recommend_title($1, $2, $3) as r`, [
        await newOp(db),
        recipient,
        movie,
      ]);
      await t1.awaitBlocked({ on: 'advisory', advisoryKey: await db.pairKey(sender, recipient) });

      await ctl.releasePair(sender, recipient);
      await blockP;
      await t2.commit();
      const sent = (await sendP).rows[0].r;
      await t1.commit();

      assert.equal(sent.status, 'refused');
      assert.equal(sent.reason, 'not_mutual', 'a block reports the same way a stranger does');
      assert.equal(
        (await db.rows(`select 1 from title_recommendations where sender_id = $1 and recipient_id = $2`, [sender, recipient])).length,
        0,
      );
      assert.equal((await inbox(db, recipient, sender)).length, 0);

      await t1.end();
      await t2.end();
      await ctl.end();
    });

    it('a refused send still spends its rate-limit slot', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const stranger = await fx.createUser();
      const movie = await fx.createMovie('Refused Send');

      const s = await db.session('sender');
      await s.actAs(sender);
      const r = await call(s, `recommend_title($1, $2, $3)`, [await newOp(db), stranger, movie]);
      assert.equal(r.status, 'refused');

      // The refusal is *returned* rather than raised precisely so the claim survives.
      // A raise would roll the ledger row back and make refused attempts free, which
      // is the throttle the abuse case depends on.
      assert.equal(
        (await db.rows(`select 1 from processed_operations where user_id = $1 and kind = 'recommend_title'`, [sender])).length,
        1,
      );

      await s.end();
    });
  });
}
