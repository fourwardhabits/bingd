import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { raceContext, newOp } from './_shared.mjs';
import { sleep } from '../harness.mjs';

/**
 * Stress repeats.
 *
 * These are **supplemental**. The deterministic barrier tests in the other files are
 * what prove the invariants; nothing here can prove anything the barriers cannot,
 * because an unsynchronised race that happens to interleave harmlessly is
 * indistinguishable from one that cannot interleave badly.
 *
 * What they add is the case the barriers deliberately exclude: the *natural* timing,
 * where nobody is holding anything open and the two transactions overlap by however
 * much the scheduler gives them. A defect that only appears under an interleaving
 * nobody thought to construct shows up here, and small random jitter widens the set
 * of interleavings sampled.
 *
 * Any intermittent failure is a failure. There is no retry and no tolerance: a race
 * test that is re-run until green is worse than no race test, because it converts a
 * real defect into a note about flakiness.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  // Kept modest on purpose: each iteration is several round trips against a real
  // postmaster, and a suite nobody runs proves nothing. Raise it when investigating.
  const ITERATIONS = Number(process.env.RACE_ITERATIONS ?? 50);

  describe(`stress repeats (${ITERATIONS} iterations)`, () => {
    before(() => rc.open());
    after(() => rc.close());

    const jitter = () => sleep(Math.floor(Math.random() * 4));

    it('follow and block, fired together, never leave both standing', async () => {
      const { db, fx } = ctx;
      const t1 = await db.session('follower');
      const t2 = await db.session('blocker');
      const failures = [];

      for (let i = 0; i < ITERATIONS; i += 1) {
        const a = await fx.createUser();
        const b = await fx.createUser();
        await t1.actAs(a);
        await t2.actAs(b);

        const results = await Promise.all([
          jitter().then(async () => t1.errorFrom(`select follow($1, $2)`, [await newOp(db), b])),
          jitter().then(async () => t2.errorFrom(`select block($1, $2)`, [await newOp(db), a])),
        ]);
        for (const e of results) {
          if (e?.code === '40P01') failures.push(`iteration ${i}: deadlock`);
        }

        const hasBlock = (await db.rows(`select 1 from blocks where blocker_id = $1 and blocked_id = $2`, [b, a])).length;
        const hasFollow = (await db.rows(`select 1 from follows where follower_id = $1 and followee_id = $2`, [a, b])).length;
        const notices = (await db.rows(`select 1 from notifications where recipient_id = $1 and actor_id = $2`, [b, a])).length;

        if (hasBlock && hasFollow) failures.push(`iteration ${i}: block and follow both stand`);
        if (hasBlock && notices) failures.push(`iteration ${i}: ${notices} notice(s) survived the block`);
      }

      assert.deepEqual(failures, [], 'every listed iteration is a real defect, not flakiness');
      await t1.end();
      await t2.end();
    });

    it('the same operation id, fired from two connections, applies once', async () => {
      const { db, fx } = ctx;
      const t1 = await db.session('a');
      const t2 = await db.session('b');
      const failures = [];

      for (let i = 0; i < ITERATIONS; i += 1) {
        const alice = await fx.createUser();
        const bob = await fx.createUser();
        const op = await newOp(db);
        await t1.actAs(alice);
        await t2.actAs(alice);

        await Promise.all([
          jitter().then(async () => t1.errorFrom(`select follow($1, $2)`, [op, bob])),
          jitter().then(async () => t2.errorFrom(`select follow($1, $2)`, [op, bob])),
        ]);

        const edges = (await db.rows(`select 1 from follows where follower_id = $1 and followee_id = $2`, [alice, bob])).length;
        const notices = (await db.rows(`select 1 from notifications where recipient_id = $1 and actor_id = $2`, [bob, alice])).length;
        const ledger = (await db.rows(`select 1 from processed_operations where user_id = $1 and operation_id = $2`, [alice, op])).length;

        if (edges !== 1) failures.push(`iteration ${i}: ${edges} edges`);
        if (notices !== 1) failures.push(`iteration ${i}: ${notices} notices`);
        if (ledger !== 1) failures.push(`iteration ${i}: ${ledger} ledger rows`);
      }

      assert.deepEqual(failures, []);
      await t1.end();
      await t2.end();
    });

    it('simultaneous sends of one title produce one row and one notice', async () => {
      const { db, fx } = ctx;
      const t1 = await db.session('a');
      const t2 = await db.session('b');
      const failures = [];

      for (let i = 0; i < ITERATIONS; i += 1) {
        const sender = await fx.createUser();
        const recipient = await fx.createUser();
        await fx.mutualFollow(sender, recipient);
        const movie = await fx.createMovie(`Stress ${i}`);
        await t1.actAs(sender);
        await t2.actAs(sender);

        await Promise.all([
          jitter().then(async () => t1.errorFrom(`select recommend_title($1, $2, $3)`, [await newOp(db), recipient, movie])),
          jitter().then(async () => t2.errorFrom(`select recommend_title($1, $2, $3)`, [await newOp(db), recipient, movie])),
        ]);

        const rows = (await db.rows(
          `select 1 from title_recommendations where sender_id = $1 and recipient_id = $2 and media_item_id = $3`,
          [sender, recipient, movie],
        )).length;
        const notices = (await db.rows(
          `select 1 from notifications where recipient_id = $1 and actor_id = $2 and type = 'recommendation'`,
          [recipient, sender],
        )).length;

        if (rows !== 1) failures.push(`iteration ${i}: ${rows} recommendation rows`);
        if (notices !== 1) failures.push(`iteration ${i}: ${notices} notices`);
      }

      assert.deepEqual(failures, []);
      await t1.end();
      await t2.end();
    });

    it('simultaneous taps on Share never mint a second live token', async () => {
      const { db, fx } = ctx;
      const t1 = await db.session('a');
      const t2 = await db.session('b');
      const failures = [];

      for (let i = 0; i < ITERATIONS; i += 1) {
        const owner = await fx.createUser();
        await t1.actAs(owner);
        await t2.actAs(owner);

        const results = await Promise.all([
          jitter().then(async () => t1.errorFrom(`select create_invite_link($1)`, [await newOp(db)])),
          jitter().then(async () => t2.errorFrom(`select create_invite_link($1)`, [await newOp(db)])),
        ]);
        for (const e of results) {
          if (e) failures.push(`iteration ${i}: a tap on Share failed with ${e.code}`);
        }

        const tokens = (await db.rows(
          `select 1 from invite_tokens where owner_id = $1 and revoked_at is null`,
          [owner],
        )).length;
        if (tokens !== 1) failures.push(`iteration ${i}: ${tokens} live tokens`);
      }

      assert.deepEqual(failures, []);
      await t1.end();
      await t2.end();
    });

    it('a comment and a block, fired together, never leave a notice behind the block', async () => {
      const { db, fx } = ctx;
      const t1 = await db.session('commenter');
      const t2 = await db.session('blocker');
      const failures = [];

      for (let i = 0; i < ITERATIONS; i += 1) {
        const actor = await fx.createUser();
        const victim = await fx.createUser();
        const movie = await fx.createMovie(`Comment stress ${i}`);
        const event = await fx.feedEvent(victim, movie);
        await t1.actAs(actor);
        await t2.actAs(victim);

        await Promise.all([
          jitter().then(async () => t1.errorFrom(`select add_comment($1, $2, $3)`, [await newOp(db), event, 'hi'])),
          jitter().then(async () => t2.errorFrom(`select block($1, $2)`, [await newOp(db), actor])),
        ]);

        const blocked = (await db.rows(`select 1 from blocks where blocker_id = $1 and blocked_id = $2`, [victim, actor])).length;
        const notices = (await db.rows(`select 1 from notifications where recipient_id = $1 and actor_id = $2`, [victim, actor])).length;
        if (blocked && notices) failures.push(`iteration ${i}: ${notices} notice(s) behind a block`);
      }

      assert.deepEqual(failures, []);
      await t1.end();
      await t2.end();
    });
  });
}
