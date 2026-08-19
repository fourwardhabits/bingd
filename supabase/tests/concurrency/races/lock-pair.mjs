import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { newOp, raceContext } from './_shared.mjs';

/**
 * `_lock_pair`, with real sessions.
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **L1. The pair is unordered.** `_lock_pair(A, B)` and `_lock_pair(B, A)` take the
 * *same* lock. This is the whole reason the function normalises with
 * `least`/`greatest`, and the property every writer's correctness rests on: a
 * follow and a block on the same two people must contend, whichever direction each
 * call comes from.
 *
 * **L2. No deadlock from inconsistent ordering.** Because there is one key per pair
 * and every writer takes exactly one, two opposite-direction callers cannot hold
 * what the other wants. `set_watch_tags` is the one writer that touches several
 * pairs, so it must take them in a fixed order; that is asserted here directly.
 *
 * **L3. Different pairs do not contend.** A lock that serialised everybody would
 * satisfy L1 and L2 and be useless. The negative case is what keeps the test honest.
 *
 * ---------------------------------------------------------------------------
 * Why these tests fail if normalisation is removed
 * ---------------------------------------------------------------------------
 *
 * Not by inspecting the function's source — by observation. Two sessions call it in
 * opposite directions and the second is required to *block*. Delete the
 * `least`/`greatest` and the two calls hash to different keys, the second returns
 * immediately, and `awaitBlocked` throws.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('_lock_pair ordering and deadlock', () => {
    before(() => rc.open());
    after(() => rc.close());

    it('L1: opposite directions take the same lock', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();

      const t1 = await db.session('ab');
      const t2 = await db.session('ba');

      await t1.begin();
      await t1.q(`select _lock_pair($1, $2)`, [a, b]);

      await t2.begin();
      const second = t2.start(`select _lock_pair($1, $2)`, [b, a]);

      // Correlated with the key computed from (a, b) — the *other* order — so this
      // asserts normalisation rather than merely that something blocked.
      const waiting = await t2.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.pairKey(a, b),
      });
      assert.equal(waiting.wait_event, 'advisory');

      await t1.commit();
      await second;
      await t2.commit();

      await t1.end();
      await t2.end();
    });

    it('L3: a different pair does not contend', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();
      const c = await fx.createUser();

      const t1 = await db.session('ab');
      const t2 = await db.session('ac');

      await t1.begin();
      await t1.q(`select _lock_pair($1, $2)`, [a, b]);

      await t2.begin();
      const second = t2.start(`select _lock_pair($1, $2)`, [a, c]);
      await second;
      await t2.assertRunning({ forMs: 100 });

      await t1.commit();
      await t2.commit();
      await t1.end();
      await t2.end();
    });

    it('a pair of one account with itself is legal, and is one key', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();

      const t1 = await db.session('aa');
      const t2 = await db.session('aa-again');

      await t1.begin();
      await t1.q(`select _lock_pair($1, $1)`, [a]);

      await t2.begin();
      const second = t2.start(`select _lock_pair($1, $1)`, [a]);
      await t2.awaitBlocked({ on: 'advisory', advisoryKey: await db.pairKey(a, a) });

      await t1.commit();
      await second;
      await t2.commit();
      await t1.end();
      await t2.end();

      // No writer calls it this way — `follow` and `block` refuse self-targets before
      // reaching it — but `least(x,x) = greatest(x,x)`, so it degenerates to a normal
      // single-account lock rather than raising or taking two.
    });

    it('a real writer blocks on exactly the key _lock_pair computes', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();

      const ctl = await db.controller();
      await ctl.holdPair(b, a); // deliberately the other direction

      const t1 = await db.session('follower');
      await t1.actAs(a);
      await t1.begin();
      const pending = t1.start(`select follow($1, $2) as r`, [await newOp(db), b]);

      // If `follow` did not call `_lock_pair`, or if the key were direction-dependent,
      // this would never block and the test would fail here rather than silently pass.
      // The key is the one `_lock_pair` computes, so "blocks on exactly the key" in the
      // title is what is asserted rather than what is hoped.
      await t1.awaitBlocked({ on: 'advisory', advisoryKey: await db.pairKey(a, b) });

      await ctl.releasePair(b, a);
      await pending;
      await t1.commit();

      await t1.end();
      await ctl.end();
    });

    it('L2: opposite-direction follow and block do not deadlock', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();

      const ctl = await db.controller();
      await ctl.holdPair(a, b);

      const t1 = await db.session('a-follows-b');
      const t2 = await db.session('b-blocks-a');
      await t1.actAs(a);
      await t2.actAs(b);

      // Deliberately no explicit transaction. Each call is its own implicit one, so
      // whichever wins the lock releases it at the end of its own statement and the
      // other proceeds without the test having to guess which went first — which is
      // the only way to await both and still be sure neither is waiting on the test.
      const pairKey = await db.pairKey(a, b);
      const follow = t1.start(`select follow($1, $2) as r`, [await newOp(db), b]);
      await t1.awaitBlocked({ on: 'advisory', advisoryKey: pairKey });

      const block = t2.start(`select block($1, $2) as r`, [await newOp(db), a]);
      await t2.awaitBlocked({ on: 'advisory', advisoryKey: pairKey });

      // Both are queued on one key. Releasing it lets them through one at a time in
      // whatever order PostgreSQL chose; neither can be holding what the other wants,
      // so neither can be told 40P01.
      await ctl.releasePair(a, b);

      const [rf, rb] = await Promise.all([
        follow.then((r) => r.rows[0].r).catch((e) => e),
        block.then((r) => r.rows[0].r).catch((e) => e),
      ]);

      for (const r of [rf, rb]) {
        assert.notEqual(r?.code, '40P01', `deadlock detected: ${r?.message}`);
      }

      // Whatever the order, the end state must be one the product model allows.
      const hasBlock = (await db.rows(`select 1 from blocks where blocker_id = $1 and blocked_id = $2`, [b, a])).length;
      const hasFollow = (await db.rows(`select 1 from follows where follower_id = $1 and followee_id = $2`, [a, b])).length;
      assert.equal(hasBlock, 1, 'the block must have taken effect');
      assert.equal(hasFollow, 0, 'a block and a follow cannot both stand');

      await t1.end();
      await t2.end();
      await ctl.end();
    });

    it('L2: set_watch_tags takes several pairs, and takes them in a fixed order', async () => {
      const { db, fx } = ctx;
      const tagger = await fx.createUser();
      const x = await fx.createUser();
      const y = await fx.createUser();
      const movie = await fx.createMovie('Two Companions');

      await fx.mutualFollow(tagger, x);
      await fx.mutualFollow(tagger, y);
      await fx.logWatch(tagger, movie);

      // Two devices saving the same picker with the list in opposite orders. If the
      // pairs were locked in argument order, these two transactions would take the
      // same two keys in opposite orders — the textbook deadlock.
      const t1 = await db.session('device-a');
      const t2 = await db.session('device-b');
      await t1.actAs(tagger);
      await t2.actAs(tagger);

      const results = await Promise.all([
        t1.errorFrom(`select set_watch_tags($1, $2, $3) as r`, [await newOp(db), movie, [x, y]]),
        t2.errorFrom(`select set_watch_tags($1, $2, $3) as r`, [await newOp(db), movie, [y, x]]),
      ]);

      for (const e of results) {
        assert.notEqual(e?.code, '40P01', `deadlock detected: ${e?.message}`);
      }

      const tags = await db.rows(
        `select tagged_id from watch_tags
          where tagger_id = $1 and media_item_id = $2 and not removed_by_tagger`,
        [tagger, movie],
      );
      assert.equal(tags.length, 2, 'both companions saved');

      await t1.end();
      await t2.end();
    });
  });
}
