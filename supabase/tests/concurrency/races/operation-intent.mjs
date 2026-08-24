import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, inbox, newOp, raceContext } from './_shared.mjs';

/**
 * `_claim_operation`, under two connections holding the same intent.
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **O1. One intent, one application.** Two transactions carrying the same
 * `operation_id` for the same account apply it once. The loser reports
 * `already_applied` and writes nothing.
 *
 * **O2. A rolled-back claim is not a spent claim.** If the transaction that won the
 * claim aborts, the operation has not happened, so the next attempt must apply it.
 * The offline outbox depends on this: an operation whose transaction failed is
 * retried, and a ledger that remembered the failure would swallow it for ever.
 *
 * **O3. A replay changes no observable.** This is the Review-21 lesson stated as a
 * test rather than as a sentence. The question is not "can a replay create a
 * duplicate row" — `on conflict` answers that — it is whether a replay can move
 * *anything* a client or another account can see. So the assertions below snapshot
 * the whole reachable state, not a row count: the ledger, the rate-limit slots, the
 * inbox, `updated_at`, `recommended_at`, and the recommendation's opened flag.
 *
 * **O4. Distinct intents are distinct, even against one resource.** Two different
 * operation ids that reach the same end state are two operations: each takes a
 * ledger row and therefore a rate-limit slot, and that is by design — the limiter
 * counts attempts precisely so a follow/unfollow loop is bounded.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('_claim_operation / operation intent', () => {
    before(() => rc.open());
    after(() => rc.close());

    /**
     * Everything about a pair that a client or the other account could observe.
     *
     * `select *`, not a chosen column list, and that is review 25's minor: the first
     * version named `type` and `created_at` and left out `id`, `subject_id`, `payload`
     * and `read_at` — so a future replay bug that moved a notification's payload or
     * un-read it would have passed a test whose name promises it could not. A column
     * list here is a list of the mutations somebody thought of.
     *
     * Ordered by primary key rather than by timestamp for the same reason: two rows
     * sharing a `created_at` would otherwise compare unstably and the failure would
     * read as flakiness.
     */
    const snapshot = async (db, a, b) => ({
      ledger: await db.rows(
        `select * from processed_operations where user_id = $1 order by operation_id`,
        [a],
      ),
      follows: await db.rows(
        `select * from follows
          where (follower_id = $1 and followee_id = $2) or (follower_id = $2 and followee_id = $1)
          order by follower_id, followee_id`,
        [a, b],
      ),
      inbox: await db.rows(
        `select * from notifications
          where (recipient_id = $1 and actor_id = $2) or (recipient_id = $2 and actor_id = $1)
          order by id`,
        [a, b],
      ),
      recommendations: await db.rows(
        `select * from title_recommendations
          where sender_id in ($1, $2) or recipient_id in ($1, $2)
          order by id`,
        [a, b],
      ),
      comments: await db.rows(`select * from comments where author_id in ($1, $2) order by id`, [
        a,
        b,
      ]),
      reactions: await db.rows(
        `select * from reactions where user_id in ($1, $2) order by feed_event_id, user_id`,
        [a, b],
      ),
      watchTags: await db.rows(
        `select * from watch_tags where tagger_id in ($1, $2) or tagged_id in ($1, $2)
          order by tagger_id, tagged_id, media_item_id`,
        [a, b],
      ),
      inviteTokens: await db.rows(
        `select * from invite_tokens where owner_id in ($1, $2) order by id`,
        [a, b],
      ),
      inviteCreations: await db.rows(
        `select * from invite_link_creations where inviter_id in ($1, $2) order by id`,
        [a, b],
      ),
    });

    it('the same operation id from two sessions: the second blocks on the ledger, then reports already_applied', async () => {
      const { db, fx } = ctx;
      const alice = await fx.createUser();
      const bob = await fx.createUser();
      const op = await newOp(db);

      const t1 = await db.session('first');
      const t2 = await db.session('replay');
      await t1.actAs(alice);
      await t2.actAs(alice);

      await t1.begin();
      const first = t1.start(`select follow($1, $2) as r`, [op, bob]);
      await first;

      await t2.begin();
      const second = t2.start(`select follow($1, $2) as r`, [op, bob]);

      // The proof that the ledger's unique index is what serialises them. `transactionid`
      // is a row-lock wait: t2's insert is queued behind t1's uncommitted one.
      const waiting = await t2.awaitBlocked();
      assert.equal(waiting.wait_event_type, 'Lock');

      await t1.commit();
      const r2 = (await second).rows[0].r;
      await t2.commit();

      assert.equal(r2.status, 'already_applied', 'O1: the replay must not apply the operation');

      const edges = await db.rows(
        `select state from follows where follower_id = $1 and followee_id = $2`,
        [alice, bob],
      );
      assert.equal(edges.length, 1);
      assert.equal((await inbox(db, bob, alice)).length, 1, 'O1: exactly one inbox row');
      assert.equal(
        (await db.rows(`select 1 from processed_operations where user_id = $1 and operation_id = $2`, [alice, op])).length,
        1,
        'O1: exactly one ledger row, and therefore one rate-limit slot',
      );

      await t1.end();
      await t2.end();
    });

    it('a rolled-back claim is not a spent claim', async () => {
      const { db, fx } = ctx;
      const alice = await fx.createUser();
      const bob = await fx.createUser();
      const op = await newOp(db);

      const t1 = await db.session('aborts');
      const t2 = await db.session('retries');
      await t1.actAs(alice);
      await t2.actAs(alice);

      await t1.begin();
      await t1.q(`select follow($1, $2) as r`, [op, bob]);

      await t2.begin();
      const second = t2.start(`select follow($1, $2) as r`, [op, bob]);
      await t2.awaitBlocked();

      await t1.rollback();

      const r2 = (await second).rows[0].r;
      await t2.commit();

      assert.equal(r2.status, 'ok', 'O2: the retry after an abort must apply the operation');
      assert.equal(r2.state, 'approved');
      assert.equal(
        (await db.rows(`select 1 from follows where follower_id = $1 and followee_id = $2`, [alice, bob])).length,
        1,
      );

      await t1.end();
      await t2.end();
    });

    it('a replay after commit moves no observable at all', async () => {
      const { db, fx } = ctx;
      const alice = await fx.createUser();
      const bob = await fx.createUser();
      await fx.mutualFollow(alice, bob);
      const movie = await fx.createMovie('Replay Observables');

      const s = await db.session('client');
      await s.actAs(alice);

      const op = await newOp(db);
      const first = await call(s, `recommend_title($1, $2, $3)`, [op, bob, movie]);
      assert.equal(first.status, 'ok');
      assert.equal(first.created, true);

      // The recipient opens it. `opened_at` is the observable review 21 warned about:
      // a resend deliberately does not clear it, and a *replay* must not either.
      const r = await db.session('recipient');
      await r.actAs(bob);
      await r.q(`select mark_recommendation_opened($1)`, [first.id]);
      await r.end();

      const before = await snapshot(db, alice, bob);

      const replay = await call(s, `recommend_title($1, $2, $3)`, [op, bob, movie]);
      assert.equal(replay.status, 'already_applied');

      const afterState = await snapshot(db, alice, bob);
      assert.deepEqual(
        afterState,
        before,
        'O3: a replay changed something observable — ledger, inbox, recommendation ' +
          'recency or the opened flag',
      );

      await s.end();
    });

    it('a replay while the original is still in flight is still a replay', async () => {
      const { db, fx } = ctx;
      const alice = await fx.createUser();
      const bob = await fx.createUser();
      await fx.mutualFollow(alice, bob);
      const movie = await fx.createMovie('In Flight');
      const op = await newOp(db);

      await db.armBarrier('title_recommendations', 'inflight');
      const ctl = await db.controller();
      await ctl.hold('inflight');

      const t1 = await db.session('inflight');
      await t1.actAs(alice);
      await t1.begin();
      await t1.pauseAt('inflight');
      const pending = t1.start(`select recommend_title($1, $2, $3) as r`, [op, bob, movie]);
      await t1.awaitBlocked();

      const t2 = await db.session('replay');
      await t2.actAs(alice);
      await t2.begin();
      const second = t2.start(`select recommend_title($1, $2, $3) as r`, [op, bob, movie]);
      await t2.awaitBlocked();

      await ctl.release('inflight');
      await pending;
      await t1.commit();

      const r2 = (await second).rows[0].r;
      await t2.commit();

      assert.equal(r2.status, 'already_applied');
      assert.equal(
        (await db.rows(`select 1 from title_recommendations where sender_id = $1 and recipient_id = $2`, [alice, bob])).length,
        1,
        'O1: one recommendation row',
      );
      assert.equal((await inbox(db, bob, alice)).length, 1, 'O1: one inbox row');

      await db.sql(`drop trigger if exists _race_barrier_title_recommendations on title_recommendations`);
      await t1.end();
      await t2.end();
      await ctl.end();
    });

    it('two different operation ids against the same edge: one row, one notice, two slots', async () => {
      const { db, fx } = ctx;
      const alice = await fx.createUser();
      const bob = await fx.createUser();

      const t1 = await db.session('device-a');
      const t2 = await db.session('device-b');
      await t1.actAs(alice);
      await t2.actAs(alice);

      const opA = await newOp(db);
      const opB = await newOp(db);

      await t1.begin();
      const a = t1.start(`select follow($1, $2) as r`, [opA, bob]);
      await a;

      await t2.begin();
      const b = t2.start(`select follow($1, $2) as r`, [opB, bob]);
      // Distinct ledger rows, so nothing contends there — but both calls are by the
      // same account, so the first advisory lock either reaches is the rate limiter's,
      // and that is what the second waits on. Review 25b caught this comment claiming
      // the pair lock; correlating against the exact key is what settles it, and the
      // pair lock is proved by the block races rather than here.
      await t2.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.accountKey(alice, 'follow'),
      });

      await t1.commit();
      const rB = (await b).rows[0].r;
      await t2.commit();

      assert.equal(rB.status, 'ok');
      assert.equal(rB.state, 'approved', 'the second call reports the state it found');
      assert.equal(
        (await db.rows(`select 1 from follows where follower_id = $1 and followee_id = $2`, [alice, bob])).length,
        1,
        'one edge',
      );
      assert.equal((await inbox(db, bob, alice)).length, 1, 'one notice — the second inserted none');
      assert.equal(
        (await db.rows(`select 1 from processed_operations where user_id = $1 and kind = 'follow'`, [alice])).length,
        2,
        'O4: two intents are two rate-limit slots, which is what bounds a follow/unfollow loop',
      );

      await t1.end();
      await t2.end();
    });

    /**
     * **This test asserted the opposite until 2026-08-25, and the inversion is the
     * point.**
     *
     * The ledger is keyed `(user, operation)` and not `(user, operation, kind)`, so an
     * id spent on one kind and then passed to another used to answer `already_applied`
     * for something that never happened. This file recorded that as "the observed
     * contract" — operation ids are per intent and must never be reused across kinds —
     * which is a rule stated in a comment and enforced by nobody.
     *
     * `20260825000200` found the cost of leaving it there. `removeFromCollection` is
     * one intent made of two RPCs, `rank_unrank` then `unlog`, and passing its single
     * operation id to both is the obvious thing to write: the first claims the id, the
     * second finds it taken and reports success **having deleted nothing.** A removal
     * that says it worked and leaves the title on the shelf.
     *
     * So `_claim_operation` now compares the kind and raises 22023 instead. The rule is
     * the same rule; it is enforced by the database rather than by whoever last read
     * this comment.
     */
    it('refuses an operation id already spent on a different kind', async () => {
      const { db, fx } = ctx;
      const alice = await fx.createUser();
      const bob = await fx.createUser();
      const op = await newOp(db);

      const s = await db.session('client');
      await s.actAs(alice);

      assert.equal((await call(s, `follow($1, $2)`, [op, bob])).status, 'ok');

      const error = await s.errorFrom(`select unfollow($1, $2)`, [op, bob]);
      assert.equal(error?.code, '22023', 'a loud refusal, not a silent no-op');
      assert.match(error.message, /different operation/);

      assert.equal(
        (await db.rows(`select 1 from follows where follower_id = $1 and followee_id = $2`, [alice, bob])).length,
        1,
        'the unfollow still did not happen — but now the caller is told so',
      );

      // And the id keeps its original meaning, so the operation it really belongs to is
      // still replayable. A guard that poisoned the id would trade one silent failure
      // for another.
      assert.equal((await call(s, `follow($1, $2)`, [op, bob])).status, 'already_applied');

      await s.end();
    });
  });
}
