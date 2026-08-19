import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { blocks, follows, inbox, newOp, raceContext } from './_shared.mjs';

/**
 * The follow / request / approve / unfollow / block matrix, raced with real sessions.
 *
 * ---------------------------------------------------------------------------
 * The invariant every case shares
 * ---------------------------------------------------------------------------
 *
 * **R1. The final state must be one the product model permits.** Concretely:
 *
 *   - a block and a follow between the same pair never both stand, in either
 *     direction — that is exactly the resurrection bug `_lock_pair` was added for
 *     (independent review 12), because a later `unblock` would restore a
 *     relationship the block had promised to sever;
 *   - a pending request never survives a block;
 *   - the inbox never holds a row between a blocked pair;
 *   - an approved follow is never silently downgraded to pending.
 *
 * These are asserted against the tables, not against what the RPCs returned. An RPC
 * answering `ok` while the database holds a state that cannot exist is the failure
 * this file is looking for, and asserting on return values would hide it.
 *
 * ---------------------------------------------------------------------------
 * How each interleaving is made deterministic
 * ---------------------------------------------------------------------------
 *
 * Both orders are constructed for every pairing, because they are different races
 * and only one of them is usually thought about. The first writer is stopped at a
 * barrier *after* it has taken the pair lock; the second is then shown to be waiting
 * **on that exact key**, correlated through `pg_locks`; the first is released. So "T1
 * got there first" is an observation of PostgreSQL rather than a hope about scheduling,
 * and "the pair lock is what held it" is an observation rather than an inference.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('follow / request / approve / unfollow / block matrix', () => {
    before(() => rc.open());
    after(() => rc.close());

    /**
     * Runs `first` to a barrier on `barrierTable`, proves `second` is queued behind
     * it **on the pair key**, then releases and commits both in that order.
     */
    const ordered = async ({
      barrierTable,
      barrierEvent = 'insert',
      key,
      pair,
      first,
      second,
    }) => {
      const { db } = ctx;
      await db.armBarrier(barrierTable, key, { event: barrierEvent });
      const ctl = await db.controller();
      const t1 = await db.session('first');
      const t2 = await db.session('second');

      /**
       * Everything below is in a `finally`, and that is not defensive style — it is
       * what stopped one failing race from hanging every test after it. A leaked
       * open transaction holds a table lock, the next `armBarrier` needs ACCESS
       * EXCLUSIVE on the same table, and the run reports timeouts against tests that
       * were never even reached.
       */
      try {
        await ctl.hold(key);

        await t1.actAs(first.as);
        await t1.begin();
        await t1.pauseAt(key);
        const p1 = t1.start(first.sql, first.params);
        await t1.awaitBlocked();

        await t2.actAs(second.as);
        await t2.begin();
        const p2 = t2.start(second.sql, second.params);

        /**
         * Unconditional, and it has no opt-out — review 25d's point, after 25c's.
         * The parameter that used to let a case skip this is gone: every skip it ever
         * granted turned out to be a real pair wait left unproved, so the escape hatch
         * was only ever a way to record a wrong belief about which lock was doing the
         * work.
         *
         * Correlated with the key `_lock_pair` computes, because `on: 'advisory'`
         * alone can be satisfied by the rate limiter's per-account lock — which would
         * make a test claiming to prove pair serialisation prove nothing of the sort.
         *
         * Every case here is a pair wait, including the two where both calls are the
         * same account: `block`, `unfollow` and `respond_follow_request` take **no
         * account lock at all** — only `follow` among these does — so being the same
         * account is never what serialises them.
         */
        await t2.awaitBlocked({
          on: 'advisory',
          advisoryKey: await db.pairKey(pair[0], pair[1]),
        });

        await ctl.release(key);
        const r1 = await p1.then((r) => r.rows[0].r).catch((e) => e);
        await t1.commit();
        const r2 = await p2.then((r) => r.rows[0].r).catch((e) => e);
        await t2.commit().catch(() => t2.rollback());
        return { r1, r2 };
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
        await db.disarmBarrier(barrierTable).catch(() => {});
      }
    };

    /** R1, asserted the same way everywhere so a new case cannot forget half of it. */
    const assertLegal = async (db, a, b) => {
      const blockAB = (await blocks(db, a, b)).length;
      const blockBA = (await blocks(db, b, a)).length;
      if (blockAB || blockBA) {
        assert.equal((await follows(db, a, b)).length, 0, 'R1: a follow survived a block (a→b)');
        assert.equal((await follows(db, b, a)).length, 0, 'R1: a follow survived a block (b→a)');
        assert.equal((await inbox(db, a, b)).length, 0, 'R1: an inbox row survived a block (a←b)');
        assert.equal((await inbox(db, b, a)).length, 0, 'R1: an inbox row survived a block (b←a)');
      }
    };

    it('FOLLOW then BLOCK: the follow commits first and the block removes it', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();

      await ordered({
        barrierTable: 'follows',
        key: 'follow-then-block',
        pair: [a, b],
        first: { as: a, sql: `select follow($1, $2) as r`, params: [await newOp(db), b] },
        second: { as: b, sql: `select block($1, $2) as r`, params: [await newOp(db), a] },
      });

      assert.equal((await blocks(db, b, a)).length, 1);
      await assertLegal(db, a, b);
    });

    it('BLOCK then FOLLOW: the follow is refused, and refused the same way a stranger is', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();

      const { r2 } = await ordered({
        barrierTable: 'blocks',
        key: 'block-then-follow',
        pair: [a, b],
        first: { as: b, sql: `select block($1, $2) as r`, params: [await newOp(db), a] },
        second: { as: a, sql: `select follow($1, $2) as r`, params: [await newOp(db), b] },
      });

      assert.equal(r2.code, 'P0002', 'a blocked follower must get the missing-account answer');
      assert.equal((await blocks(db, b, a)).length, 1);
      await assertLegal(db, a, b);
    });

    it('FOLLOW REQUEST then BLOCK: no pending request survives', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser({ visibility: 'private' });

      await ordered({
        barrierTable: 'follows',
        key: 'request-then-block',
        pair: [a, b],
        first: { as: a, sql: `select follow($1, $2) as r`, params: [await newOp(db), b] },
        second: { as: b, sql: `select block($1, $2) as r`, params: [await newOp(db), a] },
      });

      assert.equal((await follows(db, a, b)).length, 0, 'R1: a pending request survived a block');
      await assertLegal(db, a, b);
    });

    it('APPROVE then BLOCK: the approved edge does not outlive the block', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser({ visibility: 'private' });
      await fx.follow(a, b, 'pending');

      await ordered({
        // The approval's own inbox row is the step to stop at: it runs after the
        // update, so the barrier proves the update had already happened.
        barrierTable: 'notifications',
        key: 'approve-then-block',
        pair: [a, b],
        first: {
          as: b,
          sql: `select respond_follow_request($1, $2, true) as r`,
          params: [await newOp(db), a],
        },
        second: { as: b, sql: `select block($1, $2) as r`, params: [await newOp(db), a] },
      });

      await assertLegal(db, a, b);
    });

    it('BLOCK then APPROVE: there is no longer a request to approve', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser({ visibility: 'private' });
      await fx.follow(a, b, 'pending');

      const { r2 } = await ordered({
        barrierTable: 'blocks',
        key: 'block-then-approve',
        pair: [a, b],
        first: { as: b, sql: `select block($1, $2) as r`, params: [await newOp(db), a] },
        second: {
          as: b,
          sql: `select respond_follow_request($1, $2, true) as r`,
          params: [await newOp(db), a],
        },
      });

      assert.equal(r2.code, 'P0002', 'the request was removed by the block');
      await assertLegal(db, a, b);
    });

    it('UNFOLLOW then BLOCK, and BLOCK then UNFOLLOW: withdrawal always works', async () => {
      const { db, fx } = ctx;

      const a1 = await ctx.fx.createUser();
      const b1 = await ctx.fx.createUser();
      await fx.follow(a1, b1);
      await ordered({
        // `unfollow` only ever *deletes* from notifications, so a before-insert
        // barrier there would never fire and the test would look like a missing lock.
        barrierTable: 'follows',
        barrierEvent: 'delete',
        key: 'unfollow-then-block',
        pair: [a1, b1],
        first: { as: a1, sql: `select unfollow($1, $2) as r`, params: [await newOp(db), b1] },
        second: { as: b1, sql: `select block($1, $2) as r`, params: [await newOp(db), a1] },
      });
      assert.equal((await follows(db, a1, b1)).length, 0);
      await assertLegal(db, a1, b1);

      // The other order, and the one that matters: `unfollow` deliberately does not
      // check reachability, so a block must not be able to strand the edge.
      const a2 = await fx.createUser();
      const b2 = await fx.createUser();
      await fx.follow(a2, b2);
      const { r2 } = await ordered({
        barrierTable: 'blocks',
        key: 'block-then-unfollow',
        pair: [a2, b2],
        first: { as: b2, sql: `select block($1, $2) as r`, params: [await newOp(db), a2] },
        second: { as: a2, sql: `select unfollow($1, $2) as r`, params: [await newOp(db), b2] },
      });
      assert.equal(r2.status, 'ok', 'a blocked follower must still be able to withdraw');
      assert.equal((await follows(db, a2, b2)).length, 0);
      await assertLegal(db, a2, b2);
    });

    it('FOLLOW vs UNFOLLOW from two devices: the later intent wins and nothing is half-applied', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();

      // Follow first, paused at its inbox row; unfollow queued behind the pair lock.
      await ordered({
        barrierTable: 'notifications',
        key: 'follow-vs-unfollow',
        pair: [a, b],
        first: { as: a, sql: `select follow($1, $2) as r`, params: [await newOp(db), b] },
        second: { as: a, sql: `select unfollow($1, $2) as r`, params: [await newOp(db), b] },
        // Same account and same connection count as the approve case: two devices,
        // two sessions, but the pair lock is what they contend on because the ledger
        // rows differ.
      });

      assert.equal((await follows(db, a, b)).length, 0, 'the unfollow ran second and wins');
      assert.equal(
        (await inbox(db, b, a)).length,
        0,
        'unfollow withdraws the notice the follow filed, even one filed moments earlier',
      );
    });

    it('REQUEST vs APPROVAL: an approval cannot land on a request that has not committed', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser({ visibility: 'private' });

      const { r2 } = await ordered({
        barrierTable: 'follows',
        key: 'request-vs-approve',
        pair: [a, b],
        first: { as: a, sql: `select follow($1, $2) as r`, params: [await newOp(db), b] },
        second: {
          as: b,
          sql: `select respond_follow_request($1, $2, true) as r`,
          params: [await newOp(db), a],
        },
      });

      // The approval waited on the pair lock, so by the time it ran the request was
      // committed and visible. Approving it is correct; the failure would be a P0002
      // here *and* a pending row left behind, which is the state nobody can clear.
      assert.equal(r2.status, 'ok');
      assert.equal((await follows(db, a, b))[0].state, 'approved');
    });

    it('two blocks of the same pair from both sides settle without deadlock', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();
      await fx.mutualFollow(a, b);

      const t1 = await db.session('a-blocks-b');
      const t2 = await db.session('b-blocks-a');
      await t1.actAs(a);
      await t2.actAs(b);

      const results = await Promise.all([
        t1.errorFrom(`select block($1, $2) as r`, [await newOp(db), b]),
        t2.errorFrom(`select block($1, $2) as r`, [await newOp(db), a]),
      ]);
      for (const e of results) assert.notEqual(e?.code, '40P01', `deadlock: ${e?.message}`);

      assert.equal((await blocks(db, a, b)).length, 1);
      assert.equal((await blocks(db, b, a)).length, 1);
      await assertLegal(db, a, b);

      await t1.end();
      await t2.end();
    });
  });
}
