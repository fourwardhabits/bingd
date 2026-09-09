import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * Follow activity under independent connections (`20260912000100`, founder §§A9–A14).
 *
 * `supabase/tests/follow-activity.test.mjs` asserts what `_post_follow_activity` *does*.
 * This asserts that what it does survives being done twice at once, which PGlite cannot
 * express at all: it is one connection, so `for update` never contends and `_lock_pair`
 * never blocks anybody.
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **F1. One story per actor per window, even when the actor is not the caller.** This is
 * the case the `for update` on the open story exists for, and it is not hypothetical:
 * `redeem_invite` posts the *inviter's* story from the *invitee's* session, so two people
 * accepting the same personal link at the same moment are two transactions appending to
 * one row. Without the lock they each find nothing open and each insert — and the founder's
 * §A13 frequency cap, which is "one row per actor per hour", becomes a row per invitee.
 *
 * **F2. Reciprocal suppression holds against a simultaneous follow back.** A follows B and
 * B follows A at the same instant must produce **one** story, not two. What makes it
 * provable rather than lucky is that both callers take `_lock_pair(A, B)` — the same key,
 * because the pair is unordered — *before* either posts, so the second one to arrive reads
 * a story that has already committed. A future edit that moved the post outside the lock
 * would leave both edges correct and the Feed saying the same thing twice.
 *
 * **F3. The edges are created whatever the presentation does.** Suppression is a Feed
 * decision, and a race that lost a follow row to it would be a relationship the reader
 * cannot see and cannot re-create.
 *
 * **F4. Two unrelated actors do not serialise each other.** The locks are keyed per pair
 * and per account; if the story insert took anything broader, one person following
 * somebody would stall everybody else's.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('follow activity races', () => {
    before(() => rc.open());
    after(() => rc.close());

    /** The caller's live token, minted through the shipped writer. */
    const mint = async (owner) => {
      const { db } = ctx;
      const s = await db.session('mint');
      try {
        await s.actAs(owner);
        const result = await call(s, `create_invite_link($1)`, [await newOp(db)]);
        assert.equal(result.status, 'ok');
        return result.token;
      } finally {
        await s.end();
      }
    };

    /** One actor's follow stories, with their membership counted. */
    const stories = async (actor) =>
      ctx.db.rows(
        `select e.id,
                (select count(*) from feed_follow_targets ft where ft.event_id = e.id)::int as members
           from feed_events e
          where e.actor_id = $1 and e.type = 'follow_added'
          order by e.causal_at desc`,
        [actor],
      );

    /**
     * The bigint `_post_follow_activity` computes for one actor's story.
     *
     * Recomputed rather than called, and returned as a string, for `pairKey`'s two reasons:
     * `select` on the function would take a transaction-scoped lock this connection's
     * implicit commit drops, and a 64-bit key rounded through a JavaScript number would
     * silently correlate `awaitBlocked` with the wrong lock.
     */
    const storyKey = async (actor) =>
      (
        await ctx.db.rows(
          `select hashtextextended('follow_story:' || $1::text, 0)::text as k`,
          [actor],
        )
      )[0].k;

    const edge = async (follower, followee) =>
      (
        await ctx.db.rows(
          `select state from follows where follower_id = $1 and followee_id = $2`,
          [follower, followee],
        )
      )[0]?.state ?? null;

    it('F1: two invitees accepting one link at once leave one story with both of them', async () => {
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const abi = await fx.createUser();
      const ravi = await fx.createUser();
      const token = await mint(inviter);

      const t1 = await db.session('abi');
      const t2 = await db.session('ravi');

      try {
        await t1.actAs(abi);
        await t2.actAs(ravi);

        const [r1, r2] = await Promise.all([
          call(t1, `redeem_invite($1, $2)`, [await newOp(db), token]),
          call(t2, `redeem_invite($1, $2)`, [await newOp(db), token]),
        ]);

        // Two different people, so both redemptions succeed — unlike R1 in
        // `invite-redeem.mjs`, where one account claims the same link twice.
        assert.deepEqual([r1.status, r2.status], ['ok', 'ok']);
        assert.equal(r1.connected, true);
        assert.equal(r2.connected, true);

        const rows = await stories(inviter);
        assert.equal(rows.length, 1, 'the inviter has one story, not one per invitee');
        assert.equal(rows[0].members, 2);

        // Neither invitee authored one: two edges are one relationship (§A14), and the
        // actor is the inviter because that is the direction with an audience.
        assert.deepEqual(await stories(abi), []);
        assert.deepEqual(await stories(ravi), []);
      } finally {
        await t1.end();
        await t2.end();
      }
    });

    it('F1: the second appender waits on the open story rather than inserting a second', async () => {
      /**
       * The same property as above, but *demonstrated* rather than observed: the first
       * transaction is paused with the story row already inserted and uncommitted, the
       * second is fired, and it must **block**. `awaitBlocked` throws if it does not, so
       * removing the `for update` fails this loudly instead of resolving the friendly way.
       */
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const abi = await fx.createUser();
      const ravi = await fx.createUser();
      const token = await mint(inviter);

      // The membership row is written last, so a barrier on it stops the first caller with
      // the story inserted, uncommitted, and both of its advisory locks held.
      await db.armBarrier('feed_follow_targets', 'story');
      const ctl = await db.controller();
      await ctl.hold('story');

      const t1 = await db.session('first');
      const t2 = await db.session('second');

      try {
        await t1.actAs(abi);
        await t2.actAs(ravi);

        await t1.begin();
        await t1.pauseAt('story');
        const p1 = fire(t1, `redeem_invite($1, $2)`, [await newOp(db), token]);
        await t1.awaitBlocked();

        await t2.begin();
        const p2 = fire(t2, `redeem_invite($1, $2)`, [await newOp(db), token]);
        /**
         * Correlated against the actor's own key rather than against "a lock", which is
         * review 25's lesson: a test that accepts any wait will accept the wrong reason.
         * This is the key `_post_follow_activity` computes, and it is the one that had to
         * be added — `for update` alone let both callers through, and the first version of
         * this test failed with two stories.
         */
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await storyKey(inviter) });

        await ctl.release('story');
        assert.equal((await p1).rows[0].r.status, 'ok');
        await t1.commit();

        assert.equal((await p2).rows[0].r.status, 'ok');
        await t2.commit();

        const rows = await stories(inviter);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].members, 2);
      } finally {
        await t1.end();
        await t2.end();
        await ctl.end();
        await db.disarmBarrier('feed_follow_targets');
      }
    });

    it('F2/F3: a simultaneous follow back is one story and two edges', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();

      const t1 = await db.session('a');
      const t2 = await db.session('b');

      try {
        await t1.actAs(a);
        await t2.actAs(b);

        const [r1, r2] = await Promise.all([
          call(t1, `follow($1, $2)`, [await newOp(db), b]),
          call(t2, `follow($1, $2)`, [await newOp(db), a]),
        ]);

        assert.equal(r1.state, 'approved');
        assert.equal(r2.state, 'approved');

        // F3 first, because it is the one that must never be traded away: the
        // relationship exists in both directions whatever the Feed decided to say.
        assert.equal(await edge(a, b), 'approved');
        assert.equal(await edge(b, a), 'approved');

        // F2. One of the two announced it; the other saw the announcement and said
        // nothing. Which one wins is whichever took the pair lock first, and the
        // assertion is deliberately about the total rather than about who.
        const total = (await stories(a)).length + (await stories(b)).length;
        assert.equal(total, 1, 'a relationship is announced once, not once per direction');
      } finally {
        await t1.end();
        await t2.end();
      }
    });

    it('F2: the follow back blocks on the pair lock, which is what makes it see the story', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();
      const pairKey = await db.pairKey(a, b);

      const t1 = await db.session('a');
      const t2 = await db.session('b');
      const ctl = await db.controller();

      try {
        await t1.actAs(a);
        await t2.actAs(b);

        // Hold the very key `_lock_pair` computes, so the wait below is correlated
        // against that lock rather than against "something".
        await ctl.holdPair(a, b);
        await t1.begin();
        const p1 = fire(t1, `follow($1, $2)`, [await newOp(db), b]);
        await t1.awaitBlocked({ on: 'advisory', advisoryKey: pairKey });
        await ctl.releasePair(a, b);
        assert.equal((await p1).rows[0].r.state, 'approved');
        await t1.commit();

        // And now the follow back, after the story exists, is suppressed.
        assert.equal((await call(t2, `follow($1, $2)`, [await newOp(db), a])).state, 'approved');
        assert.deepEqual(await stories(b), []);
        assert.equal((await stories(a)).length, 1);
      } finally {
        await t1.end();
        await t2.end();
        await ctl.end();
      }
    });

    it('F4: one person following somebody does not stall an unrelated pair', async () => {
      /**
       * The story insert must take nothing broader than the pair and the account. A table
       * lock, or a lock on the type, would make this second call wait behind the first —
       * and on a busy evening that is every follow in the product serialised behind one.
       */
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();
      const c = await fx.createUser();
      const d = await fx.createUser();

      await db.armBarrier('feed_follow_targets', 'unrelated');
      const ctl = await db.controller();
      await ctl.hold('unrelated');

      const t1 = await db.session('a');
      const t2 = await db.session('c');

      try {
        await t1.actAs(a);
        await t2.actAs(c);

        await t1.begin();
        await t1.pauseAt('unrelated');
        const p1 = fire(t1, `follow($1, $2)`, [await newOp(db), b]);
        await t1.awaitBlocked();

        // Completes while the first is still paused. No barrier on this session, so it
        // runs the whole writer including its own story insert.
        assert.equal((await call(t2, `follow($1, $2)`, [await newOp(db), d])).state, 'approved');
        assert.equal((await stories(c)).length, 1);

        await ctl.release('unrelated');
        assert.equal((await p1).rows[0].r.state, 'approved');
        await t1.commit();
        assert.equal((await stories(a)).length, 1);
      } finally {
        await t1.end();
        await t2.end();
        await ctl.end();
        await db.disarmBarrier('feed_follow_targets');
      }
    });
  });
}
