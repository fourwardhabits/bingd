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
      // Handlers attached at start: either call may settle — including with the 40P01
      // this test exists to rule out — while the test is still awaiting the release,
      // and a rejection crossing an I/O turn unhandled fails the suite as an
      // unhandledRejection rather than through the assertion below.
      const follow = t1
        .start(`select follow($1, $2) as r`, [await newOp(db), b])
        .then((r) => r.rows[0].r, (e) => e);
      await t1.awaitBlocked({ on: 'advisory', advisoryKey: pairKey });

      const block = t2
        .start(`select block($1, $2) as r`, [await newOp(db), a])
        .then((r) => r.rows[0].r, (e) => e);
      await t2.awaitBlocked({ on: 'advisory', advisoryKey: pairKey });

      // Both are queued on one key. Releasing it lets them through one at a time in
      // whatever order PostgreSQL chose; neither can be holding what the other wants,
      // so neither can be told 40P01.
      await ctl.releasePair(a, b);

      const [rf, rb] = await Promise.all([follow, block]);

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

    /**
     * L2, for the writer that acquired a *second* pair on 2026-08-26.
     *
     * ---------------------------------------------------------------------------
     * Why `add_comment` cannot deadlock against another `add_comment`
     * ---------------------------------------------------------------------------
     *
     * Every pair lock in this schema is `_lock_pair(auth.uid(), X)`, so two callers
     * with *different* uids can share at most one key: `{a,x} = {b,p}` with `a <> b`
     * forces `p = a` and `x = b`, and asking for a second shared key forces `p = q`,
     * which contradicts the two counterparts being distinct. One shared key cannot be
     * a cycle. Two transactions with the *same* uid serialise on
     * `_assert_operation_rate`'s account lock, which is keyed on `(uid, 'add_comment')`
     * and taken before either of them reaches a pair.
     *
     * So a same-function deadlock is not constructible, and a test that fired two
     * replies at each other would prove nothing about the ordering — it would pass with
     * the locks in any order at all.
     *
     * ---------------------------------------------------------------------------
     * What *is* constructible, and is what this test does
     * ---------------------------------------------------------------------------
     *
     * `set_watch_tags` is the other multi-pair writer, it takes a *different* account
     * key (`'set_watch_tags'`), and one account can be doing both at once — a reply
     * being posted from the phone while the companion picker is saved on the tablet.
     * Those two transactions can want the same two pairs, and they are the pair of
     * calls whose relative lock order actually decides whether 40P01 fires.
     *
     * The cast is chosen so that `add_comment`'s *semantic* order is the reverse of its
     * uuid order: the activity's actor is the higher uuid and the author replied to is
     * the lower one. A version that took "the actor, then the person replied to" would
     * therefore take `hi` then `lo` while `set_watch_tags` takes `lo` then `hi`, and
     * the two would hold what the other wants.
     *
     * The interleaving is forced rather than hoped for. `lo`'s key is left free and
     * `hi`'s is held by the controller, so:
     *
     *   - the reply must take `lo` and then queue on `hi`  — asserted by the key it
     *     is found waiting on;
     *   - the tag save must then queue on `lo`             — which it can only do if
     *     the reply already holds `lo`, i.e. if the reply took the *lower* uuid first.
     *
     * That second assertion is the ordering test. With the locks taken in semantic
     * order the tag save would be found waiting on `hi` instead and the correlated
     * `awaitBlocked` throws; release the controller's key after that and PostgreSQL
     * reports the deadlock outright.
     */
    it('L2: a reply and a companion save wanting the same two pairs take them in one order', async () => {
      const { db, fx } = ctx;
      const caller = await fx.createUser();
      const one = await fx.createUser();
      const two = await fx.createUser();

      // Sorted the way `_lock_pair`'s key is: uuid text, which for a uuid is the same
      // order as the uuid itself. Nothing here depends on which of the two generated
      // ids happened to come out larger.
      const [lo, hi] = [one, two].sort();

      await fx.mutualFollow(caller, lo);
      await fx.mutualFollow(caller, hi);

      // The activity belongs to `hi` and the remark being answered belongs to `lo`, so
      // "actor first" and "lowest uuid first" disagree.
      const movie = await fx.createMovie('Two Pairs, Two Writers');
      const event = await fx.feedEvent(hi, movie);

      const rootWriter = await db.session('root-author');
      await rootWriter.actAs(lo);
      const root = (
        await rootWriter.one(`select add_comment($1, $2, $3) as r`, [
          await newOp(db),
          event,
          'the remark being answered',
        ])
      ).r.comment_id;
      await rootWriter.end();

      const tagged = await fx.createMovie('Two Pairs, Watched Together');
      await fx.logWatch(caller, tagged);

      const ctl = await db.controller();
      const t1 = await db.session('replying');
      const t2 = await db.session('saving-companions');
      await t1.actAs(caller);
      await t2.actAs(caller);

      const loKey = await db.pairKey(caller, lo);
      const hiKey = await db.pairKey(caller, hi);

      try {
        await ctl.holdPair(caller, hi);

        // Handlers attached at start: either call may settle — including with the 40P01
        // this test exists to rule out — while the test is still awaiting a release.
        const replying = t1
          .start(`select add_comment($1, $2, $3, $4, $5) as r`, [
            await newOp(db),
            event,
            'answering that',
            false,
            root,
          ])
          .then((r) => r.rows[0].r, (e) => e);
        await t1.awaitBlocked({ on: 'advisory', advisoryKey: hiKey });

        const saving = t2
          .start(`select set_watch_tags($1, $2, $3) as r`, [await newOp(db), tagged, [hi, lo]])
          .then((r) => r.rows[0].r, (e) => e);
        // The ordering assertion. Waiting on `lo` means the reply is holding `lo`,
        // which it can only be if it took the lower uuid before the higher one.
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: loKey });

        await ctl.releasePair(caller, hi);

        const [r1, r2] = await Promise.all([replying, saving]);
        for (const r of [r1, r2]) {
          assert.notEqual(r?.code, '40P01', `deadlock detected: ${r?.message}`);
        }
        assert.equal(r1?.status, 'ok', `the reply must succeed, got ${r1?.message ?? r1?.status}`);
        assert.equal(r2?.status, 'ok', `the save must succeed, got ${r2?.message ?? r2?.status}`);
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
      }

      assert.equal(
        (await db.rows(
          `select 1 from watch_tags where tagger_id = $1 and media_item_id = $2 and not removed_by_tagger`,
          [caller, tagged],
        )).length,
        2,
        'both companions saved',
      );
      assert.equal(
        (await db.rows(`select 1 from comments where author_id = $1 and parent_id = $2`, [
          caller,
          root,
        ])).length,
        1,
        'and the reply landed',
      );
    });
  });
}
