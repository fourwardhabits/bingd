import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, inbox, newOp, raceContext } from './_shared.mjs';

/**
 * Redemption and activation, under independent connections.
 *
 * `invite-token.mjs` covers the mint. This covers everything `20260819000500` added,
 * and it exists because **every claim that migration makes about simultaneity is a
 * claim about two transactions** — which PGlite, being one connection, cannot express
 * at all. `supabase/tests/invite.test.mjs` asserts what these functions *do*; this
 * asserts that what they do survives being done twice at once.
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **R1. One inviter, and the first one committed.** Two tokens redeemed by the same
 * account at the same moment must leave exactly one attribution, and no later call may
 * move it. This is the defect the whole design is shaped around: a redemption that
 * could move credit is a growth number that can be stolen.
 *
 * **R2. A block is a barrier here too.** `redeem_invite` takes `_lock_pair` before it
 * reads `blocks`, like every other writer of that shape (`20260819000400`). A block
 * committing between the read and the insert must not leave an attribution behind.
 *
 * **R3. Activation happens once.** Two devices finishing the tenth ranking together
 * produce one `activated_at`, one `invite_activated` row, and **one** `activated: true`
 * answer — the third is what the client emits its analytics event from, so two of them
 * is a growth number reported twice for one person.
 *
 * **R4. One account's redemption does not serialise anybody else's.** The locks are
 * keyed per account and per pair; if they were not, one invitation being claimed would
 * stall every other.
 *
 * **R5. A revoked link cannot be redeemed, including by a revocation that arrives
 * mid-call.** Added after independent review 26, which found the one route to the wrong
 * inviter being credited: the token was read with a plain SELECT and the attribution was
 * written several statements later, so a `revoke_invite_link` committing in that window
 * left a redemption against a link its owner had just withdrawn.
 *
 * ---------------------------------------------------------------------------
 * How the windows are opened
 * ---------------------------------------------------------------------------
 *
 * Two ways, and the difference matters.
 *
 * A **barrier trigger** on the target table stops a writer *inside* its own SECURITY
 * DEFINER body, which is the only way to reach the window between a check and an
 * insert. The shipped function is not modified, re-implemented or stubbed.
 *
 * A **held advisory key** stops a writer at a named lock from outside, and is the only
 * thing that proves a *specific* lock is taken. Review 25's lesson is the reason both
 * are used: a test that asserts "something blocked" will accept the wrong reason, so
 * every wait here is correlated against the exact key the function computes.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('invite redemption and activation races', () => {
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

    const attribution = async (invitee) => {
      const rows = await ctx.db.rows(
        `select inviter_id, accepted_at, activated_at from invite_attributions
          where invitee_id = $1`,
        [invitee],
      );
      return rows[0] ?? null;
    };

    /**
     * Ranks `count` titles for one account, driving each comparison walk to a
     * placement. Only the first title in a band places directly.
     *
     * Deliberately *not* an insert straight into `rankings`: activation is counted from
     * that table but written by `_rank_finalize`, so a fixture that bypassed the writer
     * would leave the account at ten with no activation and the race below would be
     * measuring nothing.
     */
    const rankTitles = async (user, count, from) => {
      const { db } = ctx;
      const s = await db.session('ranker');
      try {
        await s.actAs(user);
        for (let i = 0; i < count; i += 1) {
          const film = (
            await db.rows(
              `insert into media_items (kind, tmdb_id, title, provenance)
               values ('movie', $1, $2, 'manual') returning id`,
              [-(from + i), `Race fixture ${from + i}`],
            )
          )[0].id;
          await db.sql(
            `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
            [user, film],
          );
          let step = await call(s, `rank_start($1, 'loved')`, [film]);
          for (let guard = 0; !step.done && guard < 20; guard += 1) {
            step = await call(s, `rank_answer($1, $2)`, [step.session_id, film]);
          }
          assert.equal(step.done, true, 'the ranking walk did not terminate');
        }
      } finally {
        await s.end();
      }
    };

    /** A film, ready to be the tenth. */
    const film = async (n) =>
      (
        await ctx.db.rows(
          `insert into media_items (kind, tmdb_id, title, provenance)
           values ('movie', $1, $2, 'manual') returning id`,
          [-n, `Tenth ${n}`],
        )
      )[0].id;

    /**
     * One season of a show, which ranks in the `tv_seasons` category.
     *
     * The category is what makes it useful here: `_rank_finalize` keys its advisory
     * lock on (user, category), so a movie and a season ranked by the same account at
     * the same moment are **not serialised by it**. That is the only arrangement in
     * which the row lock inside `_maybe_activate_invite` is the sole thing keeping
     * activation to once.
     */
    const season = async (n) => {
      const { db } = ctx;
      const series = (
        await db.rows(
          `insert into media_items (kind, tmdb_id, title, provenance)
           values ('series', $1, $2, 'manual') returning id`,
          [-n, `Show ${n}`],
        )
      )[0].id;
      return (
        await db.rows(
          `insert into media_items (kind, tmdb_id, title, parent_id, season_number, provenance)
           values ('season', $1, 'Season 1', $2, 1, 'manual') returning id`,
          [-(n + 1), series],
        )
      )[0].id;
    };

    // -----------------------------------------------------------------------
    // R1
    // -----------------------------------------------------------------------

    it('R1: two inviters racing for one invitee produce one attribution, and it does not move', async () => {
      /**
       * The sharpest form of the invariant. Two *different* tokens, two *different*
       * operation ids — so the ledger cannot serialise them and the primary key on
       * `invitee_id` is the only thing standing there.
       *
       * The barrier stops the first transaction after its insert reaches
       * `invite_attributions`; the second runs in full underneath it, finds the row
       * uncommitted, and blocks on the primary key. Whichever commits first is the one
       * that holds the attribution, and the loser must be *told so* rather than fail:
       * a 23505 reaching the client is an error a person can do nothing about.
       */
      const { db, fx } = ctx;
      const a = await fx.createUser();
      const b = await fx.createUser();
      const invitee = await fx.createUser();
      const tokenA = await mint(a);
      const tokenB = await mint(b);

      await db.armBarrier('invite_attributions', 'redeem');
      const ctl = await db.controller();
      await ctl.hold('redeem');

      const t1 = await db.session('token-a');
      const t2 = await db.session('token-b');

      try {
        await t1.actAs(invitee);
        await t2.actAs(invitee);

        await t1.begin();
        await t1.pauseAt('redeem');
        const p1 = t1.start(`select redeem_invite($1, $2) as r`, [await newOp(db), tokenA]);
        await t1.awaitBlocked();

        await t2.begin();
        const p2 = t2.start(`select redeem_invite($1, $2) as r`, [await newOp(db), tokenB]);
        /**
         * Correlated against the account key, not left as "something blocked".
         *
         * Both calls are by the same account, so the *first* lock either reaches is
         * `_assert_operation_rate`'s, keyed on the account and `redeem_invite`. Naming
         * it is what stops this test passing for a reason that has nothing to do with
         * the redemption — review 25's lesson, applied here from the start.
         */
        await t2.awaitBlocked({
          on: 'advisory',
          advisoryKey: await db.accountKey(invitee, 'redeem_invite'),
        });

        await ctl.release('redeem');
        const r1 = (await p1).rows[0].r;
        await t1.commit();
        const r2 = (await p2).rows[0].r;
        await t2.commit();

        assert.equal(r1.status, 'ok');
        assert.deepEqual(
          r2,
          { status: 'refused', reason: 'already_attributed' },
          'the loser must be answered, not handed a 23505 it cannot act on',
        );

        const row = await attribution(invitee);
        assert.equal(row.inviter_id, a, 'R1: the first committed attribution stands');

        // PRD §17's follow follows the attribution, so the loser created no edge either.
        const edges = await db.rows(
          `select followee_id from follows where follower_id = $1`,
          [invitee],
        );
        assert.deepEqual(
          edges.map((e) => e.followee_id),
          [a],
          'the refused redemption must not have followed its own inviter',
        );
      } finally {
        await db.disarmBarrier('invite_attributions');
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
      }
    });

    it('R1: the same token redeemed twice at once writes one row and one analytics-worthy ok', async () => {
      // Two devices, same link, same instant, different operation ids. Exactly one
      // caller may be told `ok` — `invite_redeemed` is emitted from that answer, and two
      // would report two arrivals from one person.
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);

      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');

      try {
        await t1.actAs(invitee);
        await t2.actAs(invitee);

        const [r1, r2] = await Promise.all([
          call(t1, `redeem_invite($1, $2)`, [await newOp(db), token]),
          call(t2, `redeem_invite($1, $2)`, [await newOp(db), token]),
        ]);

        const statuses = [r1.status, r2.status].sort();
        assert.deepEqual(statuses, ['ok', 'refused']);

        const rows = await db.rows(
          `select count(*)::int as n from invite_attributions where invitee_id = $1`,
          [invitee],
        );
        assert.equal(rows[0].n, 1);

        // **And exactly one of each notification** (20260831000100). Both rows hang off
        // the attribution insert above, so this follows from it — but it is the property
        // the founder's contract is actually about, and a future writer that moved either
        // insert out from under that guard would leave the count above still passing
        // while greeting somebody twice.
        const notices = await db.rows(
          `select type, count(*)::int as n from notifications
            where (recipient_id = $1 and type = 'invite_welcome')
               or (recipient_id = $2 and actor_id = $1 and type = 'invite_joined')
            group by type order by type`,
          [invitee, inviter],
        );
        assert.deepEqual(
          notices.map((row) => [row.type, row.n]),
          [
            ['invite_joined', 1],
            ['invite_welcome', 1],
          ],
        );
      } finally {
        await t1.end();
        await t2.end();
      }
    });

    it('R1: a replay in flight is answered with what the original did', async () => {
      // The same operation id from two connections — a retry fired while the first
      // request is still open, which is what a flaky connection produces. The ledger,
      // not the primary key, is what serialises this one.
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);
      const op = await newOp(db);

      await db.armBarrier('invite_attributions', 'replay');
      const ctl = await db.controller();
      await ctl.hold('replay');

      const t1 = await db.session('original');
      const t2 = await db.session('retry');

      try {
        await t1.actAs(invitee);
        await t2.actAs(invitee);

        await t1.begin();
        await t1.pauseAt('replay');
        const p1 = t1.start(`select redeem_invite($1, $2) as r`, [op, token]);
        await t1.awaitBlocked();

        await t2.begin();
        const p2 = t2.start(`select redeem_invite($1, $2) as r`, [op, token]);
        await t2.awaitBlocked();

        await ctl.release('replay');
        assert.equal((await p1).rows[0].r.status, 'ok');
        await t1.commit();
        const r2 = (await p2).rows[0].r;
        await t2.commit();

        assert.equal(r2.status, 'already_applied');
        assert.equal(r2.attributed, true, 'the replay reads the row the original committed');
      } finally {
        await db.disarmBarrier('invite_attributions');
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
      }
    });

    // -----------------------------------------------------------------------
    // R2
    // -----------------------------------------------------------------------

    it('R2: redemption waits on the pair lock a concurrent block holds', async () => {
      /**
       * The lock, isolated and named — the only way to show `redeem_invite` takes it at
       * all. The controller holds the exact key `_lock_pair` computes for the pair; the
       * redemption must be found waiting on *that* key, not merely on something.
       *
       * Without this test the pair lock could be deleted from the migration and the
       * state assertion below would still pass most of the time, because most
       * interleavings are harmless.
       */
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);

      const ctl = await db.controller();
      const pairKey = await db.pairKey(invitee, inviter);
      const t1 = await db.session('redeemer');

      try {
        await ctl.holdPair(invitee, inviter);

        await t1.actAs(invitee);
        await t1.begin();
        const pending = t1.start(`select redeem_invite($1, $2) as r`, [await newOp(db), token]);
        await t1.awaitBlocked({ on: 'advisory', advisoryKey: pairKey });

        await ctl.releasePair(invitee, inviter);
        assert.equal((await pending).rows[0].r.status, 'ok');
        await t1.commit();
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await ctl.end().catch(() => {});
      }
    });

    it('R2: a block committing mid-redemption leaves no attribution', async () => {
      /**
       * The state assertion the lock exists for. The redemption reaches
       * `invite_attributions` and stops; the block arrives and must be found waiting on
       * the pair lock the redemption is holding; the redemption is released and commits;
       * the block then runs.
       *
       * `block` voids only *unaccepted* attributions and deliberately leaves accepted
       * ones alone (`20260817000200`) — an accepted attribution is historical fact about
       * how somebody joined. So what it clears here is `token_id`, and the assertion is
       * that the two writers did not interleave into a state neither intended: the block
       * is serialised behind the redemption rather than running through the middle of it.
       */
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);

      await db.armBarrier('invite_attributions', 'block-race');
      const ctl = await db.controller();
      await ctl.hold('block-race');

      const t1 = await db.session('redeemer');
      const t2 = await db.session('blocker');

      try {
        await t1.actAs(invitee);
        await t2.actAs(inviter);

        await t1.begin();
        await t1.pauseAt('block-race');
        const p1 = t1.start(`select redeem_invite($1, $2) as r`, [await newOp(db), token]);
        await t1.awaitBlocked();

        await t2.begin();
        const p2 = t2.start(`select block($1, $2) as r`, [await newOp(db), invitee]);
        await t2.awaitBlocked({
          on: 'advisory',
          advisoryKey: await db.pairKey(invitee, inviter),
        });

        await ctl.release('block-race');
        assert.equal((await p1).rows[0].r.status, 'ok');
        await t1.commit();
        await p2;
        await t2.commit();

        // The block ran after the redemption, in full, rather than through it.
        const rows = await db.rows(`select 1 from blocks where blocker_id = $1 and blocked_id = $2`, [
          inviter,
          invitee,
        ]);
        assert.equal(rows.length, 1);
      } finally {
        await db.disarmBarrier('invite_attributions');
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
      }
    });

    it('R2: a block committed first refuses the redemption outright', async () => {
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);

      const blocker = await db.session('blocker');
      await blocker.actAs(inviter);
      await call(blocker, `block($1, $2)`, [await newOp(db), invitee]);
      await blocker.end();

      const s = await db.session('redeemer');
      try {
        await s.actAs(invitee);
        assert.deepEqual(await call(s, `redeem_invite($1, $2)`, [await newOp(db), token]), {
          status: 'refused',
          reason: 'blocked',
        });
        assert.equal(await attribution(invitee), null);
      } finally {
        await s.end();
      }
    });

    it('R2: a redemption racing the inviter deleting their account leaves no dangling credit', async () => {
      /**
       * Two orderings, and both must be safe. `delete_account` removes the profile; the
       * foreign key from `invite_tokens.owner_id` cascades, so the token goes with it.
       * A redemption that committed first keeps its attribution with `inviter_id` set
       * null (`20260813001500` — the growth fact is retained, the identity is not); one
       * that arrives after finds no live token and is answered `invalid`.
       *
       * What must not happen is a row referencing an inviter that no longer exists.
       */
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);

      const s = await db.session('redeemer');
      try {
        await s.actAs(invitee);
        assert.equal((await call(s, `redeem_invite($1, $2)`, [await newOp(db), token])).status, 'ok');

        await db.sql(`delete from profiles where id = $1`, [inviter]);

        const row = await attribution(invitee);
        assert.ok(row.accepted_at, 'the attribution survives the inviter leaving');
        assert.equal(row.inviter_id, null, 'the identity does not');

        // And the token is gone with the account, so nobody else can still claim it.
        assert.equal(
          (await db.rows(`select 1 from invite_tokens where token = $1`, [token])).length,
          0,
        );
      } finally {
        await s.end();
      }
    });

    // -----------------------------------------------------------------------
    // R3
    // -----------------------------------------------------------------------

    it('R3: two clients finishing the tenth ranking together activate once', async () => {
      /**
       * The invariant that carries the award, the notification and the analytics event
       * at once, so it is asserted at all three.
       *
       * Nine movies in Loved, then **a tenth movie and a first season, fired together**.
       * Both land in empty bands, so each is a single call that places directly and
       * reaches `_maybe_activate_invite` with no comparison walk in between — which makes
       * the race the one actually being claimed rather than a race between two binary
       * searches.
       *
       * **A movie and a season, deliberately, and not two movies.** `_rank_finalize` keys
       * its advisory lock on (user, category), so two movies would be serialised by that
       * lock and this test would prove nothing about `_maybe_activate_invite`. Across two
       * categories nothing serialises them, and the guarded UPDATE's row lock is the only
       * thing standing there — which is exactly the claim the migration makes.
       *
       * It also pins the criterion: ten *titles*, across both categories, because "ten
       * titles" is a statement about what somebody ranked and not about which tab they
       * were on.
       *
       * `activated: true` exactly once is the strongest of the three assertions: it is
       * what `RankingSheet` emits `invite_activated` from, so two would be one person
       * counted twice in the one growth number this phase exists to make real.
       */
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);

      const redeemer = await db.session('redeemer');
      await redeemer.actAs(invitee);
      assert.equal(
        (await call(redeemer, `redeem_invite($1, $2)`, [await newOp(db), token])).status,
        'ok',
      );
      await redeemer.end();

      await rankTitles(invitee, 9, 100000);
      assert.equal((await attribution(invitee)).activated_at, null, 'nine is not activation');

      const tenth = await film(200001);
      const eleventh = await season(210001);
      for (const item of [tenth, eleventh]) {
        await db.sql(
          `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
          [invitee, item],
        );
      }

      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');

      try {
        await t1.actAs(invitee);
        await t2.actAs(invitee);

        const [f1, f2] = await Promise.all([
          call(t1, `rank_start($1, 'fine')`, [tenth]),
          call(t2, `rank_start($1, 'loved')`, [eleventh]),
        ]);

        assert.equal(f1.done, true, 'an empty band places directly');
        assert.equal(f2.done, true);
        assert.equal(
          [f1.activated, f2.activated].filter(Boolean).length,
          1,
          'R3: exactly one caller may be told it activated',
        );
      } finally {
        await t1.end();
        await t2.end();
      }

      assert.ok((await attribution(invitee)).activated_at);
      assert.equal(
        (await inbox(ctx.db, inviter, invitee)).filter((n) => n.type === 'invite_activated').length,
        1,
        'R3: one notification',
      );
      assert.equal(
        (
          await ctx.db.rows(
            `select count(*)::int as n from invite_attributions
              where inviter_id = $1 and activated_at is not null`,
            [inviter],
          )
        )[0].n,
        1,
        'R3: Invite Instigator counts one',
      );
    });

    it('R3: the activation waits on the pair lock before filing its notification', async () => {
      /**
       * `20260819000400`'s rule applied to the newest notification writer: the pair lock
       * is taken before the check that guards the insert. Held from outside and
       * correlated against the exact key `_lock_pair` computes, because the state
       * assertion alone would pass with the lock deleted — most interleavings are
       * harmless, which is what makes an unnamed "something blocked" worthless here.
       *
       * The tenth title goes into an **empty band**, so the whole ranking is one call
       * and there is exactly one place it can stop. Nothing a person would notice is
       * held up: `_rank_finalize` has already placed the title by the time this lock is
       * reached.
       */
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);

      const redeemer = await db.session('redeemer');
      await redeemer.actAs(invitee);
      await call(redeemer, `redeem_invite($1, $2)`, [await newOp(db), token]);
      await redeemer.end();

      await rankTitles(invitee, 9, 300000);

      const tenth = await film(400001);
      await db.sql(`insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`, [
        invitee,
        tenth,
      ]);

      const ctl = await db.controller();
      const pairKey = await db.pairKey(invitee, inviter);
      const s = await db.session('ranker');

      try {
        await ctl.holdPair(invitee, inviter);

        await s.actAs(invitee);
        await s.begin();
        const pending = fire(s, `rank_start($1, 'fine')`, [tenth]);
        await s.awaitBlocked({ on: 'advisory', advisoryKey: pairKey });

        await ctl.releasePair(invitee, inviter);
        const step = (await pending).rows[0].r;
        await s.commit();

        assert.equal(step.done, true);
        assert.equal(step.activated, true);
      } finally {
        await s.rollback().catch(() => {});
        await s.end().catch(() => {});
        await ctl.end().catch(() => {});
      }

      assert.ok((await attribution(invitee)).activated_at);
      assert.equal(
        (await inbox(ctx.db, inviter, invitee)).filter((n) => n.type === 'invite_activated').length,
        1,
      );
    });

    it('R3: a block committing before the activation keeps the fact and drops the message', async () => {
      // The distinction the migration draws: `activated_at` is a fact about the invitee
      // and survives; the inbox row is a message between two people and does not.
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);

      const redeemer = await db.session('redeemer');
      await redeemer.actAs(invitee);
      await call(redeemer, `redeem_invite($1, $2)`, [await newOp(db), token]);
      await redeemer.end();

      const blocker = await db.session('blocker');
      await blocker.actAs(inviter);
      await call(blocker, `block($1, $2)`, [await newOp(db), invitee]);
      await blocker.end();

      await rankTitles(invitee, 10, 500000);

      assert.ok((await attribution(invitee)).activated_at, 'the activation is still recorded');
      assert.equal(
        (await inbox(ctx.db, inviter, invitee)).filter((n) => n.type === 'invite_activated').length,
        0,
        'and no inbox row exists between a blocked pair',
      );
    });

    // -----------------------------------------------------------------------
    // R5
    // -----------------------------------------------------------------------

    it('R5: a revocation committing mid-redemption is not overtaken', async () => {
      /**
       * Independent review 26's third Major, as a race rather than as an argument.
       *
       * The redemption is stopped at `invite_attributions` — *after* it has read the
       * token and before it writes anything — and the revocation is fired underneath it.
       * With the row lock on the token read, the revoking UPDATE must be found **waiting
       * on that row**, which is the whole assertion: without it, the revocation commits
       * through the window and the attribution lands against a withdrawn link.
       *
       * The redemption wins this ordering and that is correct: the invitation was live
       * when it was claimed, and it was withdrawn a moment later. What must not happen is
       * the two interleaving.
       */
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);

      await db.armBarrier('invite_attributions', 'revoke-race');
      const ctl = await db.controller();
      await ctl.hold('revoke-race');

      const t1 = await db.session('redeemer');
      const t2 = await db.session('revoker');

      try {
        await t1.actAs(invitee);
        await t2.actAs(inviter);

        await t1.begin();
        await t1.pauseAt('revoke-race');
        const p1 = t1.start(`select redeem_invite($1, $2) as r`, [await newOp(db), token]);
        await t1.awaitBlocked();

        await t2.begin();
        const p2 = t2.start(`select revoke_invite_link($1) as r`, [await newOp(db)]);
        // On the token's row lock, not an advisory one. `transactionid` is what a
        // backend waiting for another transaction's row lock reports.
        await t2.awaitBlocked({ on: 'transactionid' });

        await ctl.release('revoke-race');
        assert.equal((await p1).rows[0].r.status, 'ok');
        await t1.commit();
        assert.equal((await p2).rows[0].r.status, 'ok');
        await t2.commit();

        assert.equal((await attribution(invitee)).inviter_id, inviter);
      } finally {
        await db.disarmBarrier('invite_attributions');
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
      }
    });

    it('R5: a revocation that commits first makes the redemption refuse', async () => {
      /**
       * The other ordering, and it is the subtle one. The SELECT
       * blocks on the revoking transaction, and on release **re-evaluates its own
       * qualification** against the committed row version — READ COMMITTED's EPQ
       * recheck. `revoked_at` is now set, so the predicate matches nothing and the
       * caller is answered `invalid`, exactly as if the token had never existed.
       *
       * A plain SELECT would have used the older snapshot and let it through.
       */
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const token = await mint(inviter);

      const t1 = await db.session('revoker');
      const t2 = await db.session('redeemer');

      try {
        await t1.actAs(inviter);
        await t2.actAs(invitee);

        await t1.begin();
        await t1.q(`select revoke_invite_link($1)`, [await newOp(db)]);

        // Fired while the revocation is still open, so the SELECT genuinely waits.
        const pending = t2.start(`select redeem_invite($1, $2) as r`, [await newOp(db), token]);
        await t2.awaitBlocked({ on: 'transactionid' });

        await t1.commit();

        assert.deepEqual((await pending).rows[0].r, { status: 'refused', reason: 'invalid' });
        assert.equal(await attribution(invitee), null);
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    it('R5: revoke and Share, fired together, never leave two live tokens', async () => {
      // Both take the same per-account mint key, which is why they serialise. The
      // failure without it is a 23505 from `invite_tokens_one_live` reaching somebody
      // who pressed Share at the wrong moment.
      const { db, fx } = ctx;
      const owner = await fx.createUser();
      await mint(owner);

      const t1 = await db.session('revoker');
      const t2 = await db.session('sharer');

      try {
        await t1.actAs(owner);
        await t2.actAs(owner);

        const [r1, r2] = await Promise.all([
          call(t1, `revoke_invite_link($1)`, [await newOp(db)]),
          call(t2, `create_invite_link($1)`, [await newOp(db)]),
        ]);

        assert.equal(r1.status, 'ok');
        assert.equal(r2.status, 'ok', 'neither caller may be handed a 23505');

        const live = await db.rows(
          `select token from invite_tokens where owner_id = $1 and revoked_at is null`,
          [owner],
        );
        assert.equal(live.length, 1);
      } finally {
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    // -----------------------------------------------------------------------
    // R4
    // -----------------------------------------------------------------------

    it('R4: two invitees redeeming at once do not serialise against each other', async () => {
      // The complement, and it is not redundant: a lock keyed too broadly would make one
      // person claiming an invitation stall everybody else's, and every assertion above
      // would still pass.
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const first = await fx.createUser();
      const second = await fx.createUser();
      const token = await mint(inviter);

      await db.armBarrier('invite_attributions', 'independent');
      const ctl = await db.controller();
      await ctl.hold('independent');

      const t1 = await db.session('invitee-a');
      const t2 = await db.session('invitee-b');

      try {
        await t1.actAs(first);
        await t2.actAs(second);

        await t1.begin();
        await t1.pauseAt('independent');
        const p1 = t1.start(`select redeem_invite($1, $2) as r`, [await newOp(db), token]);
        await t1.awaitBlocked();

        await t2.begin();
        const p2 = t2.start(`select redeem_invite($1, $2) as r`, [await newOp(db), token]);
        // Runs straight through: different account, different pair, different keys.
        assert.equal((await p2).rows[0].r.status, 'ok');
        await t2.commit();

        await ctl.release('independent');
        assert.equal((await p1).rows[0].r.status, 'ok');
        await t1.commit();

        // One reusable personal link, two arrivals. This is the design (PRD §17), and it
        // is what makes the token model different from a per-recipient one.
        assert.equal((await attribution(first)).inviter_id, inviter);
        assert.equal((await attribution(second)).inviter_id, inviter);
      } finally {
        await db.disarmBarrier('invite_attributions');
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
      }
    });

    it('R4: a redemption does not stall an unrelated account minting a link', async () => {
      const { db, fx } = ctx;
      const inviter = await fx.createUser();
      const invitee = await fx.createUser();
      const stranger = await fx.createUser();
      const token = await mint(inviter);

      await db.armBarrier('invite_attributions', 'crosstalk');
      const ctl = await db.controller();
      await ctl.hold('crosstalk');

      const t1 = await db.session('redeemer');
      const t2 = await db.session('stranger');

      try {
        await t1.actAs(invitee);
        await t1.begin();
        await t1.pauseAt('crosstalk');
        const p1 = t1.start(`select redeem_invite($1, $2) as r`, [await newOp(db), token]);
        await t1.awaitBlocked();

        await t2.actAs(stranger);
        await t2.begin();
        const p2 = t2.start(`select create_invite_link($1) as r`, [await newOp(db)]);
        await t2.assertRunning();
        assert.equal((await p2).rows[0].r.status, 'ok');
        await t2.commit();

        await ctl.release('crosstalk');
        await p1;
        await t1.commit();
      } finally {
        await db.disarmBarrier('invite_attributions');
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
        await ctl.end().catch(() => {});
      }
    });
  });
}
