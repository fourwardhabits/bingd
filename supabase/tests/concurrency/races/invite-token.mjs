import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, newOp, raceContext } from './_shared.mjs';

/**
 * Invite token minting, under two connections.
 *
 * Redemption and activation are not implemented and are not tested here — the
 * resolver is a separate, deferred piece of work. What exists today is the mint, and
 * its one-live-token invariant is a concurrency claim that has never been exercised.
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **I1. `invite_tokens_one_live` holds.** At most one unrevoked token per owner. It
 * is a partial unique index, so it cannot be violated — but it *can* be hit, and the
 * failure mode independent review 18 named is the one that matters: two taps on Share
 * arriving together, one of them answered with a 23505 the person can do nothing
 * about. So the assertion is both "one live token" and "neither caller saw an error".
 *
 * **I2. A personal link never rotates.** Every path — a fresh mint, a second call, a
 * replayed operation — must answer with the same token. A link that changes detaches
 * everybody already holding the old one.
 *
 * **I3. A replay writes no second creation row.** `invite_link_creations` is the only
 * invite metric this build can measure honestly, and `invite_link_created` is emitted
 * from that row. A replay that added one would inflate it.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('invite token races', () => {
    before(() => rc.open());
    after(() => rc.close());

    const live = (db, owner) =>
      db.rows(`select id, token, short_code from invite_tokens where owner_id = $1 and revoked_at is null`, [
        owner,
      ]);

    it('the index that would fire is really there, and really partial', async () => {
      const { db } = ctx;
      const [ix] = await db.rows(
        `select indexdef from pg_indexes where indexname = 'invite_tokens_one_live'`,
      );
      assert.ok(ix, 'invite_tokens_one_live is missing — I1 has nothing enforcing it');
      assert.match(ix.indexdef, /unique/i);
      assert.match(ix.indexdef, /revoked_at is null/i);
    });

    it('I1: two simultaneous mints yield one live token and no error for either caller', async () => {
      const { db, fx } = ctx;
      const owner = await fx.createUser();

      await db.armBarrier('invite_tokens', 'mint');
      const ctl = await db.controller();
      await ctl.hold('mint');

      const t1 = await db.session('tap-a');
      const t2 = await db.session('tap-b');
      await t1.actAs(owner);
      await t2.actAs(owner);

      await t1.begin();
      await t1.pauseAt('mint');
      const p1 = t1.start(`select create_invite_link($1) as r`, [await newOp(db)]);
      await t1.awaitBlocked();

      await t2.begin();
      const p2 = t2.start(`select create_invite_link($1) as r`, [await newOp(db)]);
      // Distinct operation ids, so the ledger does not serialise them. Correlating
      // against the exact key corrected this test: the first advisory lock either
      // transaction reaches is `_assert_operation_rate`'s, keyed on the account and
      // the operation kind — so that, and not review 18's mint lock, is what the
      // loser is waiting on here. The mint lock is isolated in its own test below,
      // because a limiter that happens to serialise the same callers would otherwise
      // let it be deleted with every test still green.
      await t2.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.accountKey(owner, 'create_invite_link'),
      });

      await ctl.release('mint');
      const r1 = (await p1).rows[0].r;
      await t1.commit();
      const r2 = (await p2).rows[0].r;
      await t2.commit();

      assert.equal(r1.status, 'ok');
      assert.equal(r2.status, 'ok', 'neither tap on Share may fail');
      assert.equal(r2.token, r1.token, 'I2: the second call returns the first one’s token');

      const tokens = await live(db, owner);
      assert.equal(tokens.length, 1, 'I1: exactly one live token');

      // Two genuine intents, so two creation rows: the metric counts asks for the
      // link, not tokens minted, and the second tap really was an ask.
      assert.equal(
        (await db.rows(`select 1 from invite_link_creations where inviter_id = $1`, [owner])).length,
        2,
      );

      await db.sql(`drop trigger if exists _race_barrier_invite_tokens on invite_tokens`);
      await t1.end();
      await t2.end();
      await ctl.end();
    });

    /**
     * Review 18's mint lock, isolated.
     *
     * The test above cannot prove it: two calls by the same owner meet
     * `_assert_operation_rate`'s per-account lock first, so they would still be
     * serialised — and `invite_tokens_one_live` would still hold — with the mint lock
     * deleted. Holding its exact key from outside is the only way to show
     * `create_invite_link` takes it at all.
     */
    it('the mint takes its own per-account lock, distinct from the rate limiter’s', async () => {
      const { db, fx } = ctx;
      const owner = await fx.createUser();

      const ctl = await db.controller();
      const mintKey = await db.accountKey(owner, 'invite_link');
      const t1 = await db.session('sharer');

      try {
        await ctl.holdAccount(owner, 'invite_link');

        await t1.actAs(owner);
        await t1.begin();
        const pending = t1.start(`select create_invite_link($1) as r`, [await newOp(db)]);
        await t1.awaitBlocked({ on: 'advisory', advisoryKey: mintKey });

        await ctl.releaseAccount(owner, 'invite_link');
        await pending;
        await t1.commit();
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await ctl.end().catch(() => {});
      }

      assert.equal((await live(db, owner)).length, 1);
    });

    it('I2/I3: a replayed operation returns the same token and writes no second creation row', async () => {
      const { db, fx } = ctx;
      const owner = await fx.createUser();
      const op = await newOp(db);

      const s = await db.session('client');
      await s.actAs(owner);

      const first = await call(s, `create_invite_link($1)`, [op]);
      assert.equal(first.status, 'ok');

      const replay = await call(s, `create_invite_link($1)`, [op]);
      assert.equal(replay.status, 'already_applied');
      assert.equal(replay.token, first.token, 'I2');
      assert.equal(replay.short_code, first.short_code);

      assert.equal((await live(db, owner)).length, 1, 'I1');
      assert.equal(
        (await db.rows(`select 1 from invite_link_creations where inviter_id = $1`, [owner])).length,
        1,
        'I3: a replay must not inflate the only invite metric this build has',
      );

      await s.end();
    });

    it('a replay racing the original in flight still answers with the token', async () => {
      const { db, fx } = ctx;
      const owner = await fx.createUser();
      const op = await newOp(db);

      await db.armBarrier('invite_link_creations', 'replay-inflight');
      const ctl = await db.controller();
      await ctl.hold('replay-inflight');

      const t1 = await db.session('original');
      const t2 = await db.session('replay');
      await t1.actAs(owner);
      await t2.actAs(owner);

      await t1.begin();
      await t1.pauseAt('replay-inflight');
      const p1 = t1.start(`select create_invite_link($1) as r`, [op]);
      await t1.awaitBlocked();

      await t2.begin();
      const p2 = t2.start(`select create_invite_link($1) as r`, [op]);
      await t2.awaitBlocked();

      await ctl.release('replay-inflight');
      const r1 = (await p1).rows[0].r;
      await t1.commit();
      const r2 = (await p2).rows[0].r;
      await t2.commit();

      assert.equal(r2.status, 'already_applied');
      assert.equal(
        r2.token,
        r1.token,
        'the already_applied branch reads the token the winning transaction committed',
      );
      assert.equal((await live(db, owner)).length, 1);

      await db.sql(`drop trigger if exists _race_barrier_invite_link_creations on invite_link_creations`);
      await t1.end();
      await t2.end();
      await ctl.end();
    });

    it('two owners minting at once do not serialise against each other', async () => {
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();

      await db.armBarrier('invite_tokens', 'two-owners');
      const ctl = await db.controller();
      await ctl.hold('two-owners');

      const t1 = await db.session('owner-a');
      await t1.actAs(a);
      await t1.begin();
      await t1.pauseAt('two-owners');
      const p1 = t1.start(`select create_invite_link($1) as r`, [await newOp(db)]);
      await t1.awaitBlocked();

      const t2 = await db.session('owner-b');
      await t2.actAs(b);
      await t2.begin();
      const p2 = t2.start(`select create_invite_link($1) as r`, [await newOp(db)]);
      // The lock is keyed per account. If it were not, one person tapping Share would
      // stall everybody else's.
      await p2;
      await t2.commit();

      await ctl.release('two-owners');
      await p1;
      await t1.commit();

      assert.equal((await live(db, a)).length, 1);
      assert.equal((await live(db, b)).length, 1);
      assert.notEqual((await live(db, a))[0].token, (await live(db, b))[0].token);

      await db.sql(`drop trigger if exists _race_barrier_invite_tokens on invite_tokens`);
      await t1.end();
      await t2.end();
      await ctl.end();
    });
  });
}
