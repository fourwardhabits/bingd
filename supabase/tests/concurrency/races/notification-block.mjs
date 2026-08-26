import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, inbox, newOp, raceContext, visibleInbox } from './_shared.mjs';

/**
 * The notification write-side block race — the blocker carried forward since
 * review 23b, and the reason this whole directory exists.
 *
 * ---------------------------------------------------------------------------
 * The invariant
 * ---------------------------------------------------------------------------
 *
 * **N1. A block is a barrier, not a filter.** Once `block(A, B)` has committed,
 * there is no `notifications` row between that pair. `block` deletes both
 * directions, and every writer that could make a new one is refused afterwards by
 * `_assert_reachable` / `can_view_profile` / `_is_mutual_follow`. So a row between a
 * blocked pair is not a stale row — it is a row that **cannot exist** under the
 * product model, and its presence means a writer committed inside a window the
 * block was supposed to close.
 *
 * This is deliberately not the same claim as "the recipient cannot see it". Review
 * 23b closed the visible half by adding `can_discover_profile` to `my_notifications`,
 * and that fix stands and is asserted below. But a row nobody may read is still a
 * row: it survives a later `unblock`, it is what a future push worker would read, and
 * it is a record of contact between two people who have severed it.
 *
 * ---------------------------------------------------------------------------
 * What these tests found
 * ---------------------------------------------------------------------------
 *
 * `add_comment`, `set_reaction` and `set_watch_tags` all violated N1, deterministically
 * and also at natural timing over fifty repeats. `20260819000400` gives all three the
 * pair lock the other seven writers already had. These tests are the regression, and
 * they are written so that **removing the lock again fails them twice over**: the
 * blocker is required to be observed *waiting* on the pair lock, and the final state
 * is required to be empty. Only asserting the second would leave a test that could
 * pass by luck.
 *
 * ---------------------------------------------------------------------------
 * What is *not* a violation
 * ---------------------------------------------------------------------------
 *
 * A notification created legitimately and *then* blocked is not this bug: `block`
 * deletes it, in the same transaction, by design. The last test in this file pins
 * that distinction so a later reader cannot mistake this suite for one that deletes
 * history.
 *
 * ---------------------------------------------------------------------------
 * How the window is opened
 * ---------------------------------------------------------------------------
 *
 * The window is inside a SECURITY DEFINER function, between its check and its insert,
 * so it cannot be reached by ordering client calls. The harness pauses the writer with
 * a barrier trigger on `notifications` — the shipped function is not modified,
 * re-implemented or stubbed; it simply stops when it reaches that table while the
 * block is let past.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('notification write-side block race', () => {
    before(() => rc.open());
    after(() => rc.close());

    /**
     * WRITER FIRST. The writer reaches its inbox row and stops; the blocker arrives
     * and must be found waiting on the pair lock; the writer is released and commits;
     * the blocker then runs and must leave nothing behind.
     *
     * The `finally` is not defensive style. A leaked open transaction holds a table
     * lock, the next `armBarrier` needs ACCESS EXCLUSIVE on the same table, and one
     * failing race turns every later test into a timeout reported against the wrong
     * test. That happened, and this is the fix.
     */
    const writerThenBlock = async ({ key, write, setup }) => {
      const { db, fx } = ctx;
      const actor = await fx.createUser();
      const victim = await fx.createUser();
      await setup?.({ actor, victim });

      await db.armBarrier('notifications', key);
      const ctl = await db.controller();
      const t1 = await db.session('writer');
      const t2 = await db.session('blocker');

      try {
        await ctl.hold(key);

        await t1.actAs(actor);
        await t1.begin();
        await t1.pauseAt(key);
        const pending = write({ t1, actor, victim });
        // The writer has passed its check and reached the insert. Proved, not assumed.
        await t1.awaitBlocked();

        await t2.actAs(victim);
        await t2.begin();
        const blocked = t2.start(`select block($1, $2) as r`, [await newOp(db), actor]);

        // The half that fails if the pair lock is ever removed again. Without it the
        // block sails past, commits, and the writer's row lands behind it.
        //
        // Correlated with the exact key `_lock_pair` computes, so this cannot be
        // satisfied by the blocker happening to wait on some other advisory lock.
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await db.pairKey(actor, victim) });

        await ctl.release(key);
        await pending;
        await t1.commit();
        await blocked;
        await t2.commit();
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
        await db.disarmBarrier('notifications').catch(() => {});
      }

      return { actor, victim };
    };

    /**
     * BLOCK FIRST, and this is the direction that proves the check is *under* the
     * lock rather than merely preceded by one. The block holds the pair; the writer
     * queues on it; the block commits; the writer then re-reads the relationship and
     * must refuse.
     */
    const blockThenWriter = async ({ write, setup }) => {
      const { db, fx } = ctx;
      const actor = await fx.createUser();
      const victim = await fx.createUser();
      await setup?.({ actor, victim });

      const ctl = await db.controller();
      const t1 = await db.session('writer');
      const t2 = await db.session('blocker');
      let result;

      try {
        const key = await db.pairKey(actor, victim);
        await ctl.holdPair(actor, victim);

        await t2.actAs(victim);
        await t2.begin();
        const blocked = t2.start(`select block($1, $2) as r`, [await newOp(db), actor]);
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: key });

        await t1.actAs(actor);
        await t1.begin();
        // The refusal is the *expected* outcome of this direction, and it can arrive
        // the moment t2 commits — while this function is still awaiting `blocked` or
        // `t2.commit()` below. The handler therefore has to exist from the instant the
        // promise does, or node:test reports the run as an unhandledRejection and the
        // late `.catch` earns a PromiseRejectionHandledWarning. Captured errors still
        // reach the caller's `result.code` assertion, so an unexpected error remains a
        // failure — it just fails the assertion instead of the process.
        const pending = write({ t1, actor, victim }).then(
          (r) => r.rows[0].r,
          (e) => e,
        );
        await t1.awaitBlocked({ on: 'advisory', advisoryKey: key });

        await ctl.releasePair(actor, victim);
        await blocked;
        await t2.commit();

        result = await pending;
        await t1.commit().catch(() => t1.rollback());
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
      }

      return { actor, victim, result };
    };

    const assertNoTrace = async (db, victim, actor, what) => {
      assert.deepEqual(
        (await inbox(db, victim, actor)).map((n) => n.type),
        [],
        `N1: a ${what} notification exists between a blocked pair`,
      );
      assert.equal(
        (await visibleInbox(db, victim)).length,
        0,
        `N1: a ${what} notification is deliverable to somebody who blocked its author`,
      );
    };

    describe('add_comment', () => {
      it('writer first: the block waits for it, then clears what it wrote', async () => {
        const { db, fx } = ctx;
        let event;
        const { actor, victim } = await writerThenBlock({
          key: 'comment-first',
          setup: async ({ victim: v }) => {
            const movie = await fx.createMovie('Comment Race A');
            event = await fx.feedEvent(v, movie);
          },
          write: ({ t1 }) =>
            t1.start(`select add_comment($1, $2, $3) as r`, [crypto.randomUUID(), event, 'hello']),
        });
        await assertNoTrace(db, victim, actor, 'comment');
      });

      it('block first: the writer re-reads under the lock and refuses', async () => {
        const { db, fx } = ctx;
        let event;
        const { actor, victim, result } = await blockThenWriter({
          setup: async ({ victim: v }) => {
            const movie = await fx.createMovie('Comment Race B');
            event = await fx.feedEvent(v, movie);
          },
          write: ({ t1 }) =>
            t1.start(`select add_comment($1, $2, $3) as r`, [crypto.randomUUID(), event, 'hello']),
        });

        assert.equal(result.code, 'P0002', 'a blocked commenter gets the missing-activity answer');
        await assertNoTrace(db, victim, actor, 'comment');
        assert.equal(
          (await db.rows(`select 1 from comments where author_id = $1`, [actor])).length,
          0,
          'the comment itself must not land either — the refusal rolls the whole call back',
        );
      });

    });

    /**
     * N1 for the *second* pair, which is what `20260826000600` added and what the first
     * draft of that migration left unguarded.
     *
     * A reply writes up to two inbox rows — one to the activity's actor, one to the
     * author being answered — and N1 is a claim about every pair, not about the pair
     * that happened to be there first. The tests above would all still pass if
     * `add_comment` locked the actor and left the reply target open, so these are the
     * ones that pin the new half.
     *
     * Three parties throughout, and deliberately so: with the actor and the author the
     * same person there is only one pair and the distinction cannot be observed. The
     * same-person case is pinned separately at the end, because collapsing two locks
     * into one is exactly the sort of thing a later `union` refactor could get wrong in
     * the other direction.
     */
    describe('add_comment replies', () => {
      /**
       * The cast every test here uses.
       *
       *   owner      owns the activity, and is notified about any comment on it
       *   author     wrote the root comment, and is notified about a reply to it
       *   commenter  replies, and is the caller whose pair locks are under test
       *
       * All three are public accounts following nobody, which is all `can_view_profile`
       * needs; the blocks are what make it interesting.
       */
      const cast = async () => {
        const { db, fx } = ctx;
        const owner = await fx.createUser();
        const author = await fx.createUser();
        const commenter = await fx.createUser();
        const movie = await fx.createMovie(`Reply Race ${crypto.randomUUID().slice(0, 8)}`);
        const event = await fx.feedEvent(owner, movie);

        const s = await db.session('root-author');
        await s.actAs(author);
        const root = (
          await s.one(`select add_comment($1, $2, $3) as r`, [
            await newOp(db),
            event,
            'the remark being answered',
          ])
        ).r.comment_id;
        await s.end();

        // The root comment notified the owner. Cleared, so every count below is about
        // the reply and not about the fixture that set it up.
        await db.sql(`delete from notifications where actor_id = $1`, [author]);

        return { owner, author, commenter, event, root };
      };

      const reply = (session, event, root) =>
        session.start(`select add_comment($1, $2, $3, $4, $5) as r`, [
          crypto.randomUUID(),
          event,
          'answering that',
          false,
          root,
        ]);

      /**
       * C. WRITER FIRST, against the reply target.
       *
       * The reply stops at its first inbox row — the owner's — with both pair locks
       * already taken. The person being replied to then blocks the commenter and must
       * be found waiting on *their* key, which is a different key from the one the
       * tests above assert and the whole point of this block.
       */
      it('C: a block by the person replied to waits on their own pair, then clears the reply notice', async () => {
        const { db } = ctx;
        const { owner, author, commenter, event, root } = await cast();

        await db.armBarrier('notifications', 'reply-first');
        const ctl = await db.controller();
        const t1 = await db.session('replier');
        const t2 = await db.session('reply-target-blocking');

        try {
          await ctl.hold('reply-first');

          await t1.actAs(commenter);
          await t1.begin();
          await t1.pauseAt('reply-first');
          const pending = reply(t1, event, root);
          await t1.awaitBlocked();

          await t2.actAs(author);
          await t2.begin();
          const blocked = t2.start(`select block($1, $2) as r`, [await newOp(db), commenter]);

          // Correlated with the commenter/author key specifically. A lock on the
          // commenter/owner pair — the only one the old hardening took — does not
          // satisfy this, which is what makes it a test of the second pair.
          await t2.awaitBlocked({
            on: 'advisory',
            advisoryKey: await db.pairKey(commenter, author),
          });

          await ctl.release('reply-first');
          await pending;
          await t1.commit();
          await blocked;
          await t2.commit();
        } finally {
          await t1.rollback().catch(() => {});
          await t2.rollback().catch(() => {});
          await t1.end().catch(() => {});
          await t2.end().catch(() => {});
          await ctl.end().catch(() => {});
          await db.disarmBarrier('notifications').catch(() => {});
        }

        await assertNoTrace(db, author, commenter, 'reply');

        // And the half that keeps this from being satisfied by refusing everything: the
        // owner blocked nobody, so their notice is legitimate and must still be there.
        assert.equal(
          (await inbox(db, owner, commenter)).length,
          1,
          'the activity owner is a different pair, and their notice is not the block’s business',
        );
      });

      /**
       * D. BLOCK FIRST, and in the other direction — the commenter is the one blocking.
       *
       * This is the direction that proves the reply target's predicate is re-read
       * *under* its lock rather than merely before it. The block holds the pair; the
       * reply queues on it; the block commits; the reply must then refuse.
       *
       * It also pins that the refusal is whole. The owner has blocked nobody, so a
       * function that dropped only the offending notification would still post the
       * remark and still notify them — and `set_watch_tags`'s rule is that a writer
       * refuses rather than partially applies.
       */
      it('D: a reply queued behind the commenter’s own block re-reads under it and refuses', async () => {
        const { db } = ctx;
        const { owner, author, commenter, event, root } = await cast();

        const ctl = await db.controller();
        const t1 = await db.session('replier');
        const t2 = await db.session('commenter-blocking');
        let result;

        try {
          const key = await db.pairKey(commenter, author);
          await ctl.holdPair(commenter, author);

          await t2.actAs(commenter);
          await t2.begin();
          const blocked = t2.start(`select block($1, $2) as r`, [await newOp(db), author]);
          await t2.awaitBlocked({ on: 'advisory', advisoryKey: key });

          await t1.actAs(commenter);
          await t1.begin();
          // Handled from the instant the promise exists — see the note on
          // `blockThenWriter` above; the refusal can arrive while this test is still
          // awaiting `t2`.
          const pending = reply(t1, event, root).then(
            (r) => r.rows[0].r,
            (e) => e,
          );
          await t1.awaitBlocked({ on: 'advisory', advisoryKey: key });

          await ctl.releasePair(commenter, author);
          await blocked;
          await t2.commit();

          result = await pending;
          await t1.commit().catch(() => t1.rollback());
        } finally {
          await t1.rollback().catch(() => {});
          await t2.rollback().catch(() => {});
          await t1.end().catch(() => {});
          await t2.end().catch(() => {});
          await ctl.end().catch(() => {});
        }

        assert.equal(
          result.code,
          'P0002',
          'a parent whose author the caller may no longer see is the same missing-comment answer',
        );
        await assertNoTrace(db, author, commenter, 'reply');
        assert.equal(
          (await db.rows(`select 1 from comments where author_id = $1`, [commenter])).length,
          0,
          'the reply itself must not land either — the refusal rolls the whole call back',
        );
        assert.equal(
          (await inbox(db, owner, commenter)).length,
          0,
          'and the owner is not notified about a reply that was refused',
        );
      });

      /**
       * F, positively. Two different people, two different pairs, two notices — the
       * state this whole block is protecting, asserted without a race so that a failure
       * above cannot be read as "replies do not notify anybody".
       */
      it('F: an ordinary reply notifies two different people through two different pairs', async () => {
        const { db } = ctx;
        const { owner, author, commenter, event, root } = await cast();

        const s = await db.session('replier');
        await s.actAs(commenter);
        await s.q(`select add_comment($1, $2, $3, $4, $5)`, [
          await newOp(db),
          event,
          'answering that',
          false,
          root,
        ]);
        await s.end();

        assert.equal((await inbox(db, owner, commenter)).length, 1, 'the activity owner');
        assert.equal((await inbox(db, author, commenter)).length, 1, 'the person replied to');
      });

      /**
       * E. The ordinary case — somebody replying under a remark on the actor's own
       * activity. One person, therefore one pair, therefore one lock and one notice.
       *
       * The race half matters because the `union` that deduplicates the pair is new: a
       * version that took the same key twice would still be correct here (advisory
       * locks are re-entrant within a transaction) but a version that took *neither*
       * would not, and only observing the blocker proves which one shipped.
       */
      it('E: when the actor is also the author replied to, one pair is locked and one notice written', async () => {
        const { db, fx } = ctx;
        const owner = await fx.createUser();
        const commenter = await fx.createUser();
        const movie = await fx.createMovie('Reply Race Same Person');
        const event = await fx.feedEvent(owner, movie);

        const s = await db.session('root-author');
        await s.actAs(owner);
        const root = (
          await s.one(`select add_comment($1, $2, $3) as r`, [
            await newOp(db),
            event,
            'the owner remarks on their own ranking',
          ])
        ).r.comment_id;
        await s.end();
        await db.sql(`delete from notifications where actor_id = $1`, [owner]);

        await db.armBarrier('notifications', 'reply-same');
        const ctl = await db.controller();
        const t1 = await db.session('replier');
        const t2 = await db.session('blocker');

        try {
          await ctl.hold('reply-same');

          await t1.actAs(commenter);
          await t1.begin();
          await t1.pauseAt('reply-same');
          const pending = reply(t1, event, root);
          await t1.awaitBlocked();

          await t2.actAs(owner);
          await t2.begin();
          const blocked = t2.start(`select block($1, $2) as r`, [await newOp(db), commenter]);
          await t2.awaitBlocked({
            on: 'advisory',
            advisoryKey: await db.pairKey(commenter, owner),
          });

          await ctl.release('reply-same');
          await pending;
          await t1.commit();
          await blocked;
          await t2.commit();
        } finally {
          await t1.rollback().catch(() => {});
          await t2.rollback().catch(() => {});
          await t1.end().catch(() => {});
          await t2.end().catch(() => {});
          await ctl.end().catch(() => {});
          await db.disarmBarrier('notifications').catch(() => {});
        }

        await assertNoTrace(db, owner, commenter, 'reply');

        // And the same fixture without a block: one event, one notice. The `<> v_actor`
        // suppression, pinned here as well as in `comment-threads.test.mjs`, because a
        // second lock quietly becoming a second *notification* is the way this could
        // regress from the concurrency side.
        const owner2 = await fx.createUser();
        const commenter2 = await fx.createUser();
        const event2 = await fx.feedEvent(owner2, await fx.createMovie('Reply Race Once'));
        const s2 = await db.session('owner-2');
        await s2.actAs(owner2);
        const root2 = (
          await s2.one(`select add_comment($1, $2, $3) as r`, [await newOp(db), event2, 'hers'])
        ).r.comment_id;
        await s2.end();

        const s3 = await db.session('replier-2');
        await s3.actAs(commenter2);
        await s3.q(`select add_comment($1, $2, $3, $4, $5)`, [
          await newOp(db),
          event2,
          'answering',
          false,
          root2,
        ]);
        await s3.end();

        assert.equal(
          (await inbox(db, owner2, commenter2)).length,
          1,
          'one person, one event, one notice — the actor and the author are the same here',
        );
      });

      /**
       * The oracle, for the parent. Review 25's MAJOR applies to the second id exactly
       * as it does to the first: if the author's pair were locked before the caller's
       * right to see them had been decided, the wait would answer "did X write this
       * comment" for an account that has blocked the caller.
       */
      it('refuses a parent whose author blocked the caller without waiting on their pair', async () => {
        const { db, fx } = ctx;
        const owner = await fx.createUser();
        const author = await fx.createUser();
        const attacker = await fx.createUser();
        const event = await fx.feedEvent(owner, await fx.createMovie('Reply Oracle Probe'));

        const s = await db.session('root-author');
        await s.actAs(author);
        const root = (
          await s.one(`select add_comment($1, $2, $3) as r`, [await newOp(db), event, 'mine'])
        ).r.comment_id;
        await s.end();

        // The author has blocked the attacker, so the parent is real but unreachable.
        await db.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
          author,
          attacker,
        ]);

        // Held exactly as an attacker would: `unfollow` takes the pair lock with no
        // reachability check of its own.
        const holder = await db.session('attacker-holding-the-pair');
        await holder.actAs(attacker);
        await holder.begin();
        await holder.q(`select unfollow($1, $2)`, [await newOp(db), author]);

        const probe = await db.session('probe');
        try {
          await probe.actAs(attacker);
          await probe.q(`set statement_timeout = '2s'`);
          const err = await probe.errorFrom(`select add_comment($1, $2, $3, $4, $5)`, [
            await newOp(db),
            event,
            'probe',
            false,
            root,
          ]);
          assert.equal(
            err?.code,
            'P0002',
            err?.code === '57014'
              ? 'the refusal waited on the reply target’s pair lock — the timing oracle is back'
              : 'the refusal must be the ordinary missing-comment answer',
          );
        } finally {
          await holder.rollback().catch(() => {});
          await holder.end().catch(() => {});
          await probe.end().catch(() => {});
        }
      });
    });

    describe('set_reaction', () => {
      // Reactions default off since 20260819000300, so the recipient must opt in or
      // the preference trigger drops the row before the race can be seen at all.
      const optIn = (db, victim) =>
        db.sql(
          `insert into notification_preferences (user_id, category, enabled)
           values ($1, 'reactions', true)
           on conflict (user_id, category) do update set enabled = true`,
          [victim],
        );

      it('writer first: the block waits for it, then clears what it wrote', async () => {
        const { db, fx } = ctx;
        let event;
        const { actor, victim } = await writerThenBlock({
          key: 'reaction-first',
          setup: async ({ victim: v }) => {
            const movie = await fx.createMovie('Reaction Race A');
            event = await fx.feedEvent(v, movie);
            await optIn(db, v);
          },
          write: ({ t1 }) =>
            t1.start(`select set_reaction($1, $2, $3) as r`, [crypto.randomUUID(), event, 'love']),
        });
        await assertNoTrace(db, victim, actor, 'reaction');
      });

      it('block first: the writer re-reads under the lock and refuses', async () => {
        const { db, fx } = ctx;
        let event;
        const { actor, victim, result } = await blockThenWriter({
          setup: async ({ victim: v }) => {
            const movie = await fx.createMovie('Reaction Race B');
            event = await fx.feedEvent(v, movie);
            await optIn(db, v);
          },
          write: ({ t1 }) =>
            t1.start(`select set_reaction($1, $2, $3) as r`, [crypto.randomUUID(), event, 'love']),
        });

        assert.equal(result.code, 'P0002');
        await assertNoTrace(db, victim, actor, 'reaction');
        assert.equal(
          (await db.rows(`select 1 from reactions where user_id = $1`, [actor])).length,
          0,
        );
      });
    });

    describe('set_watch_tags', () => {
      it('writer first: the block waits for it, then clears what it wrote', async () => {
        const { db, fx } = ctx;
        let movie;
        const { actor, victim } = await writerThenBlock({
          key: 'tag-first',
          setup: async ({ actor: a, victim: v }) => {
            movie = await fx.createMovie('Tag Race A');
            await fx.mutualFollow(a, v);
            await fx.logWatch(a, movie);
          },
          write: ({ t1, victim: v }) =>
            t1.start(`select set_watch_tags($1, $2, $3) as r`, [crypto.randomUUID(), movie, [v]]),
        });
        await assertNoTrace(db, victim, actor, 'watch_tag');
      });

      it('block first: the writer re-reads under the lock and refuses', async () => {
        const { db, fx } = ctx;
        let movie;
        const { actor, victim, result } = await blockThenWriter({
          setup: async ({ actor: a, victim: v }) => {
            movie = await fx.createMovie('Tag Race B');
            await fx.mutualFollow(a, v);
            await fx.logWatch(a, movie);
          },
          write: ({ t1, victim: v }) =>
            t1.start(`select set_watch_tags($1, $2, $3) as r`, [crypto.randomUUID(), movie, [v]]),
        });

        assert.equal(
          result.code,
          '42501',
          'a block ends the mutual follow, and a non-mutual companion is refused',
        );
        await assertNoTrace(db, victim, actor, 'watch_tag');
        assert.equal(
          (await db.rows(`select 1 from watch_tags where tagger_id = $1 and not removed_by_tagger`, [actor])).length,
          0,
          'set_watch_tags refuses as a whole rather than partially applying',
        );
      });
    });

    /**
     * Review 25's MAJOR, pinned.
     *
     * The first draft of `20260819000400` resolved the feed event's actor *without*
     * the visibility predicate so it could lock the pair before checking. That turned
     * the refusal into something you can time: an event that does not exist is refused
     * at once, and an event that exists but is not viewable stops on its actor's pair
     * lock. `unfollow` deliberately has no reachability check, so **any caller can
     * hold `_lock_pair(self, X)` against anyone they can name** — which makes the
     * difference a deterministic oracle rather than a statistical one.
     *
     * The test is the attack. It holds the pair lock exactly as an attacker would, and
     * requires the refusal to arrive anyway.
     */
    describe('a refusal must not be timeable', () => {
      const holdPairAsAnAttackerWould = async (attacker, target) => {
        const { db } = ctx;
        const s = await db.session('attacker-holding-the-pair');
        await s.actAs(attacker);
        await s.begin();
        // Not a synthetic `_lock_pair` call: this is the client-callable RPC that
        // takes the lock with no reachability check, which is what makes it reachable.
        await s.q(`select unfollow($1, $2)`, [await newOp(db), target]);
        return s;
      };

      it('add_comment refuses an unviewable event without waiting on the pair lock', async () => {
        const { db, fx } = ctx;
        const attacker = await fx.createUser();
        const target = await fx.createUser();
        const movie = await fx.createMovie('Oracle Probe');
        const event = await fx.feedEvent(target, movie);
        // The target has blocked the attacker, so the event is real but unviewable.
        await db.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
          target,
          attacker,
        ]);

        const holder = await holdPairAsAnAttackerWould(attacker, target);
        const probe = await db.session('probe');
        try {
          await probe.actAs(attacker);
          // A wait becomes a 57014 rather than a hung test, so the failure names itself.
          await probe.q(`set statement_timeout = '2s'`);
          const err = await probe.errorFrom(`select add_comment($1, $2, $3)`, [
            await newOp(db),
            event,
            'probe',
          ]);
          assert.equal(
            err?.code,
            'P0002',
            err?.code === '57014'
              ? 'the refusal waited on the pair lock — the timing oracle is back'
              : 'the refusal must be the ordinary missing-activity answer',
          );
        } finally {
          await holder.rollback().catch(() => {});
          await holder.end().catch(() => {});
          await probe.end().catch(() => {});
        }
      });

      it('add_comment refuses a missing event the same way, and neither waits', async () => {
        const { db, fx } = ctx;
        const attacker = await fx.createUser();
        const target = await fx.createUser();

        const holder = await holdPairAsAnAttackerWould(attacker, target);
        const probe = await db.session('probe');
        try {
          await probe.actAs(attacker);
          // A wait becomes a 57014 rather than a hung test, so the failure names itself.
          await probe.q(`set statement_timeout = '2s'`);
          const err = await probe.errorFrom(`select add_comment($1, $2, $3)`, [
            await newOp(db),
            crypto.randomUUID(),
            'probe',
          ]);
          assert.equal(
            err?.code,
            'P0002',
            'a missing event and an unviewable one must be one answer, arriving at one speed',
          );
        } finally {
          await holder.rollback().catch(() => {});
          await holder.end().catch(() => {});
          await probe.end().catch(() => {});
        }
      });

      it('set_reaction refuses an unviewable event without waiting on the pair lock', async () => {
        const { db, fx } = ctx;
        const attacker = await fx.createUser();
        const target = await fx.createUser();
        const movie = await fx.createMovie('Oracle Probe 2');
        const event = await fx.feedEvent(target, movie);
        await db.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
          target,
          attacker,
        ]);

        const holder = await holdPairAsAnAttackerWould(attacker, target);
        const probe = await db.session('probe');
        try {
          await probe.actAs(attacker);
          // A wait becomes a 57014 rather than a hung test, so the failure names itself.
          await probe.q(`set statement_timeout = '2s'`);
          const err = await probe.errorFrom(`select set_reaction($1, $2, $3)`, [
            await newOp(db),
            event,
            'love',
          ]);
          assert.equal(
            err?.code,
            'P0002',
            err?.code === '57014'
              ? 'the refusal waited on the pair lock — the timing oracle is back'
              : 'the refusal must be the ordinary missing-activity answer',
          );
        } finally {
          await holder.rollback().catch(() => {});
          await holder.end().catch(() => {});
          await probe.end().catch(() => {});
        }
      });
    });

    /**
     * The control that was already correct, kept because it is what showed the other
     * three were not. `recommend_title` has held the pair lock since 20260817001300.
     */
    it('recommend_title: the pair lock makes the block wait, and the state is legal', async () => {
      const { db, fx } = ctx;
      const sender = await fx.createUser();
      const recipient = await fx.createUser();
      const movie = await fx.createMovie('Protected');
      await fx.mutualFollow(sender, recipient);

      await db.armBarrier('notifications', 'rec-block');
      const ctl = await db.controller();
      const t1 = await db.session('sender');
      const t2 = await db.session('blocker');

      try {
        await ctl.hold('rec-block');
        await t1.actAs(sender);
        await t1.begin();
        await t1.pauseAt('rec-block');
        const pending = t1.start(`select recommend_title($1, $2, $3) as r`, [
          await newOp(db),
          recipient,
          movie,
        ]);
        await t1.awaitBlocked();

        await t2.actAs(recipient);
        await t2.begin();
        const blocked = t2.start(`select block($1, $2) as r`, [await newOp(db), sender]);
        await t2.awaitBlocked({
          on: 'advisory',
          advisoryKey: await db.pairKey(sender, recipient),
        });

        await ctl.release('rec-block');
        await pending;
        await t1.commit();
        await blocked;
        await t2.commit();
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
        await db.disarmBarrier('notifications').catch(() => {});
      }

      await assertNoTrace(db, recipient, sender, 'recommendation');
    });

    /**
     * The other half of review 23b's disposition, asserted rather than assumed. The
     * read path is a genuine second line of defence and this suite must not be read
     * as saying it does not work — only that a filtered row is still a row.
     */
    it('my_notifications filters a row between a blocked pair, however it got there', async () => {
      const { db, fx } = ctx;
      const actor = await fx.createUser();
      const victim = await fx.createUser();

      await db.sql(
        `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
         values ($1, 'follow', $2, 'profile', $2)`,
        [victim, actor],
      );
      assert.equal((await visibleInbox(db, victim)).length, 1, 'positive control');

      await db.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [victim, actor]);
      assert.equal(
        (await visibleInbox(db, victim)).length,
        0,
        'the read-side filter from review 23b must still hold',
      );
    });

    it('a notification created before a block is removed by the block, not by a race rule', async () => {
      const { db, fx } = ctx;
      const actor = await fx.createUser();
      const victim = await fx.createUser();
      await fx.follow(actor, victim);

      await db.sql(
        `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
         values ($1, 'follow', $2, 'profile', $2)`,
        [victim, actor],
      );

      const s = await db.session('blocker');
      await s.actAs(victim);
      await call(s, `block($1, $2)`, [await newOp(db), actor]);
      await s.end();

      assert.equal(
        (await inbox(db, victim, actor)).length,
        0,
        'block() clears the inbox in both directions — this is the designed behaviour, ' +
          'not a concurrency rule',
      );
    });
  });
}
