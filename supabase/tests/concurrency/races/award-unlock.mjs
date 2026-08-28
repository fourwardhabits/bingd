import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { raceContext } from './_shared.mjs';

/**
 * The award transition, under independent connections.
 *
 * `20260828000100`'s exactly-once claim is one sentence in the migration header: "of
 * two devices crossing the same tier simultaneously, the second blocks on the first's
 * row and then inserts nothing, and both side effects hang off the insert that
 * reported a row." Every word of that is a claim about two transactions — which
 * PGlite, being one connection, cannot express. `supabase/tests/award-unlocks.test.mjs`
 * asserts what the detector *does*; this asserts that what it does survives being done
 * twice at once.
 *
 * The invariants:
 *
 * **A1. Two detectors crossing one tier announce once, and the loser genuinely
 * waits.** The second transaction must be OBSERVED blocked on the first's uncommitted
 * `award_unlocks` row — not merely produce a clean end state, because most
 * interleavings resolve harmlessly whether or not the insert is guarded. When the
 * first commits, the loser's `on conflict do nothing` reports no row, so it announces
 * nothing: one unlock, one feed post, one congratulations.
 *
 * **A2. The same holds without a constructed window** — two bare concurrent calls,
 * however the scheduler lands them, leave the same single announcement.
 *
 * **A3. And through the real trigger**: two follow approvals landing together, each
 * carrying the earner past the threshold from a different connection, announce once.
 * This is the shape production actually produces — the detector is reached from
 * row-level triggers on somebody else's writes, not from a client call.
 *
 * The earner's five mutuals are built with `award_on_follow` disabled, because the
 * point is a metric already past the threshold with the tier NOT yet on the ledger —
 * the state two devices race from. `_maybe_award_unlocks` is EXECUTE-revoked from
 * every client role (a caller who could invoke it could probe another account's
 * counts), so the racing sessions run unauthenticated, as the triggers' SECURITY
 * DEFINER context effectively does.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('award unlock races', () => {
    before(() => rc.open());
    after(() => rc.close());

    /** `n` mutuals for `who`, written while the award trigger is not watching. */
    const mutualsQuietly = async (who, n) => {
      const { db, fx } = ctx;
      await db.sql(`alter table follows disable trigger award_on_follow`);
      try {
        for (let i = 0; i < n; i += 1) {
          await fx.mutualFollow(who, await fx.createUser());
        }
      } finally {
        await db.sql(`alter table follows enable trigger award_on_follow`);
      }
    };

    const announcements = async (who) => {
      const { db } = ctx;
      const [unlocks] = await db.rows(
        `select count(*)::int as total,
                count(*) filter (where announced)::int as announced
           from award_unlocks where user_id = $1 and award_key = 'mutual-mania'`,
        [who],
      );
      const posts = await db.rows(
        `select payload from feed_events where actor_id = $1 and type = 'award_earned'`,
        [who],
      );
      const inbox = await db.rows(
        `select actor_id from notifications where recipient_id = $1 and type = 'award_earned'`,
        [who],
      );
      return { unlocks, posts, inbox };
    };

    it('A1: the second detector blocks on the first’s uncommitted row and announces nothing', async () => {
      const { db, fx } = ctx;
      const earner = await fx.createUser();
      await mutualsQuietly(earner, 5);

      // AFTER insert, so the paused transaction is holding its freshly written —
      // uncommitted — ledger row when the second one arrives at the primary key.
      await db.armBarrier('award_unlocks', 'award-cross', { timing: 'after' });
      const ctl = await db.controller();
      await ctl.hold('award-cross');

      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');

      try {
        await t1.begin();
        await t1.pauseAt('award-cross');
        const p1 = t1.start(`select _maybe_award_unlocks($1, array['mutual-mania'])`, [earner]);
        await t1.awaitBlocked();

        await t2.begin();
        const p2 = t2.start(`select _maybe_award_unlocks($1, array['mutual-mania'])`, [earner]);
        /**
         * The observation that carries the test. `transactionid` is what a backend
         * waiting for another transaction's row lock reports — here, the loser sitting
         * on the winner's uncommitted (user, award, tier) insert. Delete the
         * `on conflict do nothing` shape from the migration and this wait becomes a
         * 23505 instead; delete the insert-first design and it never blocks at all,
         * and `awaitBlocked` fails loudly rather than passing on a lucky interleaving.
         */
        await t2.awaitBlocked({ on: 'transactionid' });

        await ctl.release('award-cross');
        await p1;
        await t1.commit();
        await p2;
        await t2.commit();
      } finally {
        await db.disarmBarrier('award_unlocks');
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
      }

      const { unlocks, posts, inbox } = await announcements(earner);
      assert.deepEqual(
        unlocks,
        { total: 1, announced: 1 },
        'A1: one ledger row, and it is the one that announced',
      );
      assert.equal(posts.length, 1, 'A1: one feed post');
      assert.deepEqual(posts[0].payload, {
        award: 'mutual-mania',
        tier: 'hello',
        award_name: 'Mutual Mania',
        tier_label: 'Hello',
      });
      assert.equal(inbox.length, 1, 'A1: one congratulations');
      assert.equal(inbox[0].actor_id, null, 'actorless — nobody did this to them');
    });

    it('A2: two bare concurrent detectors leave one announcement, however they land', async () => {
      const { db, fx } = ctx;
      const earner = await fx.createUser();
      await mutualsQuietly(earner, 5);

      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');
      try {
        await Promise.all([
          t1.q(`select _maybe_award_unlocks($1, array['mutual-mania'])`, [earner]),
          t2.q(`select _maybe_award_unlocks($1, array['mutual-mania'])`, [earner]),
        ]);
      } finally {
        await t1.end();
        await t2.end();
      }

      const { unlocks, posts, inbox } = await announcements(earner);
      assert.deepEqual(unlocks, { total: 1, announced: 1 });
      assert.equal(posts.length, 1);
      assert.equal(inbox.length, 1);
    });

    it('A3: two follow approvals landing together cross the earner once, through the real trigger', async () => {
      // Production's shape: the fifth and sixth mutual arrive from two connections in
      // the same instant, `award_on_follow` fires inside each transaction, and both
      // reach the detector past the threshold. The pairs differ, so no follows lock
      // serialises them — the award_unlocks insert is the only thing standing there.
      const { db, fx } = ctx;
      const earner = await fx.createUser();
      await mutualsQuietly(earner, 4);
      const fifth = await fx.createUser();
      const sixth = await fx.createUser();

      const t1 = await db.session('fifth-mutual');
      const t2 = await db.session('sixth-mutual');
      try {
        await Promise.all([
          t1.q(
            `insert into follows (follower_id, followee_id, state, approved_at)
             values ($1, $2, 'approved', now()), ($2, $1, 'approved', now())`,
            [earner, fifth],
          ),
          t2.q(
            `insert into follows (follower_id, followee_id, state, approved_at)
             values ($1, $2, 'approved', now()), ($2, $1, 'approved', now())`,
            [earner, sixth],
          ),
        ]);
      } finally {
        await t1.end();
        await t2.end();
      }

      const { unlocks, posts, inbox } = await announcements(earner);
      assert.deepEqual(unlocks, { total: 1, announced: 1 }, 'A3: one crossing, whoever carried it');
      assert.equal(posts.length, 1);
      assert.equal(inbox.length, 1);
    });
  });
}
