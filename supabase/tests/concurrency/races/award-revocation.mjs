import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { raceContext } from './_shared.mjs';

/**
 * Losing and re-earning an award, under independent connections.
 *
 * `20260904000100` makes a collection-derived tier reversible, and most of that claim is
 * a claim about two transactions. `supabase/tests/award-revocation.test.mjs` asserts
 * what the revocation *does*; PGlite is one connection and cannot express the race.
 * This is the race.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS GUARANTEED, AND WHAT IS STATED INSTEAD OF CLAIMED
 *
 * The revocation runs from a **deferred constraint trigger**, so within one transaction
 * it measures the final state — that is what stops a rebucket from re-announcing, and it
 * is pinned in the functional suite. Across transactions it takes **`_award_lock`**, the
 * account's advisory lock, before reading any metric.
 *
 * The unlock detector deliberately does **not** take that lock: it runs from AFTER-INSERT
 * triggers on `user_media`, so taking it there put it ahead of `_rank_finalize`'s band
 * lock and turned one account's award lock into a coarse write lock over every collection
 * write. `races/ranking.mjs` and `races/goal-completion.mjs` both caught that within a
 * single run, blocking on the wrong key.
 *
 * So one window is left open, and the migration header states it rather than pretending
 * otherwise: an addition whose detector has already run, followed by a removal that
 * commits before the addition does, revokes a tier the final count supports. That is a
 * MISSING unlock, never a stale one — nothing unsupported survives, nothing is
 * duplicated — and the account's next collection write earns it back with exactly one
 * announcement.
 *
 * These tests therefore pin the invariants that hold in EVERY interleaving, and pin
 * convergence where the outcome is genuinely non-deterministic. An assertion that
 * happened to pass on this machine's scheduling would be worse than no assertion.
 *
 *   **R1. Two removals serialise on the account's award lock**, observably — the second
 *   is seen waiting on that exact advisory key. Remove `_award_lock` from the revocation
 *   and this fails loudly rather than passing on a lucky interleaving.
 *
 *   **R2. Two removals that together cross the line revoke once and leave nothing
 *   behind**: no ledger row, no orphan feed post, no orphan congratulations.
 *
 *   **R3. A removal racing an addition never duplicates anything**, whichever commits
 *   first: at most one unlock, at most one post, at most one congratulations, and the
 *   post count always equals the announced-unlock count. Then one more write, and the
 *   state converges to exactly one of each.
 *
 *   **R4. Revoking and re-earning end in exactly one attainment**, and the announcement
 *   is a new row — which is only possible because the revocation took the old one out of
 *   a permanent partial unique index with it.
 *
 * Season Snacker (bronze at fifteen logged seasons) carries the crossings: it is the
 * cheapest collection metric not entangled with ranking positions, and every write here
 * goes through the REAL triggers — a bare insert into `user_media` fires
 * `award_on_user_media` and a bare delete fires the deferred `award_off_user_media`.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('award revocation races', () => {
    before(() => rc.open());
    after(() => rc.close());

    let seq = 0;

    /** A fixture season under a fixture series, so season numbers cannot collide. */
    const season = async () => {
      const { db } = ctx;
      seq += 1;
      const [series] = await db.rows(
        `insert into media_items (kind, tmdb_id, title, provenance)
         values ('series', $1, $2, 'manual') returning id`,
        [-(900000 + seq), `rr_series_${seq}`],
      );
      const [row] = await db.rows(
        `insert into media_items (kind, parent_id, season_number, title, provenance)
         values ('season', $1, 1, 'Season 1', 'manual') returning id`,
        [series.id],
      );
      return row.id;
    };

    /** `n` logged seasons for `who`, through the real insert trigger. */
    const giveSeasons = async (who, n) => {
      const { db } = ctx;
      const ids = [];
      for (let i = 0; i < n; i += 1) {
        const id = await season();
        await db.sql(
          `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
          [who, id],
        );
        ids.push(id);
      }
      return ids;
    };

    const state = async (who) => {
      const { db } = ctx;
      const [unlocks] = await db.rows(
        `select count(*)::int as total,
                count(*) filter (where announced)::int as announced
           from award_unlocks where user_id = $1 and award_key = 'season-snacker'`,
        [who],
      );
      const posts = await db.rows(
        `select id from feed_events
          where actor_id = $1 and type = 'award_earned' and payload ->> 'award' = 'season-snacker'`,
        [who],
      );
      const inbox = await db.rows(
        `select id from notifications
          where recipient_id = $1 and type = 'award_earned'
            and payload ->> 'award' = 'season-snacker'`,
        [who],
      );
      const [count] = await db.rows(`select _award_metric($1, 'season-snacker', 15)::int as m`, [
        who,
      ]);
      return {
        unlocks,
        posts: posts.map((row) => row.id),
        inbox: inbox.map((row) => row.id),
        metric: count.m,
      };
    };

    const remove = (session, who, id) =>
      session.start(`delete from user_media where user_id = $1 and media_item_id = $2`, [who, id]);

    const add = (session, who, id) =>
      session.start(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
        [who, id],
      );

    /** The advisory key `_award_lock` takes, computed by the database rather than guessed. */
    const awardKey = async (who) =>
      (
        await ctx.db.rows(`select hashtextextended('award:' || $1::text, 0) as k`, [who])
      )[0].k;

    it('R1: the second removal waits on the account’s award lock', async () => {
      const { db, fx } = ctx;
      const earner = await fx.createUser();
      const seasons = await giveSeasons(earner, 15);
      assert.deepEqual((await state(earner)).unlocks, { total: 1, announced: 1 }, 'CONTROL');

      const first = await db.session('first-removal');
      const second = await db.session('second-removal');

      try {
        // The revocation is deferred, so the DELETE itself takes nothing — the COMMIT is
        // where the lock is taken and held. Holding the first transaction open after its
        // delete and before its commit is not enough; it has to be *committing*.
        await first.begin();
        await first.q(`delete from user_media where user_id = $1 and media_item_id = $2`, [
          earner,
          seasons[0],
        ]);
        // A session-level lock on the same key, taken by this transaction, is what a
        // second committing transaction has to wait for. Taken through the function
        // under test, so a rename or a changed namespace fails here rather than
        // silently making this test assert nothing.
        await first.q(`select _award_lock($1)`, [earner]);

        await second.begin();
        await second.q(`delete from user_media where user_id = $1 and media_item_id = $2`, [
          earner,
          seasons[1],
        ]);
        const committing = second.start(`commit`);
        await second.awaitBlocked({ on: 'advisory', advisoryKey: await awardKey(earner) });

        await first.commit();
        await committing;
      } finally {
        await first.rollback().catch(() => {});
        await second.rollback().catch(() => {});
        await first.end().catch(() => {});
        await second.end().catch(() => {});
      }

      const now = await state(earner);
      assert.equal(now.metric, 13);
      assert.deepEqual(now.unlocks, { total: 0, announced: 0 }, 'R1: revoked once');
      assert.deepEqual(now.posts, [], 'R1: no orphan feed post');
      assert.deepEqual(now.inbox, [], 'R1: no orphan congratulations');
    });

    it('R2: two bare concurrent removals revoke once and leave nothing behind', async () => {
      const { db, fx } = ctx;
      const earner = await fx.createUser();
      const seasons = await giveSeasons(earner, 15);
      assert.deepEqual((await state(earner)).unlocks, { total: 1, announced: 1 }, 'CONTROL');

      const t1 = await db.session('one');
      const t2 = await db.session('two');
      try {
        await Promise.all([remove(t1, earner, seasons[0]), remove(t2, earner, seasons[1])]);
      } finally {
        await t1.end();
        await t2.end();
      }

      const now = await state(earner);
      assert.equal(now.metric, 13);
      assert.deepEqual(now.unlocks, { total: 0, announced: 0 }, 'R2: the tier is gone');
      assert.deepEqual(now.posts, [], 'R2: and no orphan feed post survives it');
      assert.deepEqual(now.inbox, [], 'R2: and no orphan congratulations');
    });

    it('R3: a removal racing an addition duplicates nothing, and converges to one', async () => {
      const { db, fx } = ctx;
      const earner = await fx.createUser();
      const seasons = await giveSeasons(earner, 15);
      const replacement = await season();

      const t1 = await db.session('remover');
      const t2 = await db.session('adder');
      try {
        await Promise.all([remove(t1, earner, seasons[0]), add(t2, earner, replacement)]);
      } finally {
        await t1.end();
        await t2.end();
      }

      // Whichever committed first, the count is back where it started. Two outcomes are
      // legitimate — the tier stood, or it was revoked by the window the header states —
      // and NEITHER may leave a duplicate or an announcement without an unlock.
      const mid = await state(earner);
      assert.equal(mid.metric, 15, 'R3: the collection is the size it started');
      assert.ok(mid.unlocks.total <= 1, 'R3: never two ledger rows');
      assert.ok(mid.posts.length <= 1, 'R3: never two feed posts');
      assert.ok(mid.inbox.length <= 1, 'R3: never two congratulations');
      assert.equal(
        mid.posts.length,
        mid.unlocks.announced,
        'R3: an announcement never outlives the unlock behind it',
      );
      assert.equal(mid.inbox.length, mid.unlocks.announced);

      // And it heals: the next collection write finds the tier absent and the count
      // sufficient, and earns it back — once.
      await giveSeasons(earner, 1);
      const now = await state(earner);
      assert.deepEqual(now.unlocks, { total: 1, announced: 1 }, 'R3: converged to one unlock');
      assert.equal(now.posts.length, 1, 'R3: and exactly one feed post');
      assert.equal(now.inbox.length, 1, 'R3: and exactly one congratulations');
    });

    it('R4: revoking and re-earning end in exactly one attainment, with a new announcement', async () => {
      const { db, fx } = ctx;
      const earner = await fx.createUser();
      const seasons = await giveSeasons(earner, 15);
      const original = (await state(earner)).posts[0];
      const extra = [await season(), await season()];

      // One removal, so the account sits ONE below the line. Both re-additions then
      // cross it independently — which is the state two devices race from, and the
      // only one where a duplicate announcement is even possible. (Two removals and
      // two additions would leave each adder seeing fourteen and neither crossing,
      // which is the ordinary detector behaviour and says nothing about revocation.)
      await db.sql(`delete from user_media where user_id = $1 and media_item_id = $2`, [
        earner,
        seasons[0],
      ]);
      const mid = await state(earner);
      assert.equal(mid.metric, 14);
      assert.deepEqual(mid.unlocks, { total: 0, announced: 0 }, 'R4: revoked at fourteen');
      assert.deepEqual(mid.posts, []);

      const t1 = await db.session('c');
      const t2 = await db.session('d');
      try {
        await Promise.all([add(t1, earner, extra[0]), add(t2, earner, extra[1])]);
      } finally {
        await t1.end();
        await t2.end();
      }

      const now = await state(earner);
      assert.equal(now.metric, 16, 'R4: both additions landed');
      assert.deepEqual(
        now.unlocks,
        { total: 1, announced: 1 },
        'R4: exactly one unlock for the new cycle',
      );
      assert.equal(now.posts.length, 1, 'R4: exactly one feed announcement');
      assert.notEqual(now.posts[0], original, 'R4: and it is a new row, not the revoked one');
      assert.equal(now.inbox.length, 1, 'R4: exactly one congratulations');
    });
  });
}
