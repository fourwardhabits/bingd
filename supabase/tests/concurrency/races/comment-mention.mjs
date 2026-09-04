import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * @mention exactly-once, under independent connections — `20260830000100`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS, AND WHAT PGLITE CANNOT SEE
 *
 * `supabase/tests/comment-mentions.test.mjs` proves the edit matrix in full — created
 * once, edited and still once, removed and re-added and still once. Every one of those
 * runs on one connection, so every one of them is a *serial* interleaving. The claim the
 * founder actually made is stronger than that:
 *
 *   **at most one mention notification per (comment id, mentioned user id), ever.**
 *
 * "Ever" includes two devices saving the same edit at the same moment, and an offline
 * outbox flushing twice under two different operation ids. `_claim_operation` answers a
 * replay carrying the *same* id and says nothing about either of those.
 *
 * The mechanism underneath is one statement:
 *
 *     update comment_mentions set notified_at = now()
 *      where comment_id = ... and mentioned_id = any (...) and notified_at is null
 *     returning mentioned_id
 *
 * which takes a row lock and returns exactly the pairs *this* transaction moved from
 * unstamped to stamped. The second transaction blocks on that row, and — because the
 * `returning` set is computed after it re-reads under READ COMMITTED — comes back empty.
 * The notification insert is fed from that set, so it inserts nothing.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANTS
 *
 * **M1. A concurrent duplicate edit is OBSERVED waiting**, and the loser files nothing.
 * Two assertions, and both are needed: the wait proves the two transactions really did
 * overlap — a serial interleaving resolves correctly whether or not the guard is there at
 * all, so a clean end state alone proves nothing — and the count proves the guard.
 *
 * The row they wait on is the **comment**, not the mention: `_edit_comment` rewrites
 * `comments` before it touches `comment_mentions`, so that update is the first
 * serialisation point and everything after it is already single-file. That is why this
 * test asserts a lock wait rather than a *named* key the way the advisory-lock suites do
 * — there is no advisory key here, and the guard would hold even if the comments update
 * were removed, because the `notified_at is null` update takes its own row lock.
 *
 * **M2. Two bare concurrent edits** — no constructed window — leave exactly one
 * notification however the scheduler lands them.
 *
 * **M3. Remove and re-add, across two connections**, still files nothing. This is the
 * anti-farming rule at the only arity where it could plausibly fail: the row is
 * deactivated by one transaction and reactivated by another, and the stamp is untouched
 * by both.
 *
 * **M4. Two people mentioned concurrently** each get exactly one — the guard must
 * serialise per pair, not per comment, or one person's notification would be lost to
 * another's.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('comment mention races', () => {
    before(() => rc.open());
    after(() => rc.close());

    /**
     * The handle a fixture account is given, which `createUser` builds from its id.
     *
     * Since `20260908000100` the *body* is what decides who a comment names, so these
     * bodies have to spell the real handle. They used to say `@x`, which was decorative
     * when the picked array was the only source and is a comment that names nobody now.
     */
    const handleOf = (id) => `u${id.slice(0, 8)}`;

    /** A conversation with an author who follows the person about to be named. */
    const scene = async (title) => {
      const { db, fx } = ctx;
      const actor = await fx.createUser();
      const author = await fx.createUser();
      const named = await fx.createUser();
      // Followed by the author, and in nobody's thread: the pure "population A" case, so
      // eligibility cannot quietly come from participation instead.
      await fx.follow(author, named);

      const film = await fx.createMovie(title);
      const event = await fx.feedEvent(actor, film, 'title_ranked');

      const s = await db.session('setup');
      try {
        await s.actAs(author);
        const posted = await call(
          s,
          `add_comment($1, $2, 'nothing to see here', false, null, '{}'::uuid[])`,
          [await newOp(db), event],
        );
        return { actor, author, named, event, comment: posted.comment_id };
      } finally {
        await s.end();
      }
    };

    const mentionsOf = (recipient) =>
      ctx.db.rows(
        `select payload ->> 'comment_id' as comment_id from notifications
          where recipient_id = $1 and type = 'mention'`,
        [recipient],
      );

    const ledger = (comment) =>
      ctx.db.rows(
        `select mentioned_id, active, notified_at is not null as notified
           from comment_mentions where comment_id = $1 order by mentioned_id`,
        [comment],
      );

    const editSql = `edit_comment($1, $2, $3, false, $4::uuid[])`;

    it('M1: the second save waits, and files nothing', async () => {
      const { db } = ctx;
      const { author, named, comment } = await scene('Mention Race One');

      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');

      try {
        await t1.actAs(author);
        await t2.actAs(author);

        // t1 stamps the pair and stays open. Its notification is written but not yet
        // visible to t2, which is the whole of the window.
        await t1.begin();
        await call(t1, editSql, [await newOp(db), comment, `@${handleOf(named)} hello`, [named]]);

        // t2 is a *different* intent by operation id — an outbox flushing the same edit
        // twice, or a second device — so the ledger cannot answer it. It has to stop on
        // the row.
        await t2.begin();
        const p2 = fire(t2, editSql, [await newOp(db), comment, `@${handleOf(named)} hello`, [named]]);
        /**
         * The observation that makes the window real rather than hoped for. Without it a
         * scheduler that happened to run these serially would pass this test with the
         * guard deleted.
         *
         * No `on` filter and no advisory key: the wait is a row-level conflict on the
         * `comments` row both transactions are rewriting, which surfaces as
         * `transactionid` or `tuple` depending on where in the queue the backend is. What
         * matters is that t2 is stopped until t1 commits — the assertion below is what
         * says the guard then did its job.
         */
        await t2.awaitBlocked();

        await t1.commit();
        await p2;
        await t2.commit();
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      assert.equal((await mentionsOf(named)).length, 1, 'M1: one notification, not two');
      const rows = await ledger(comment);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].notified, true, 'M1: the stamp is what the loser found');
    });

    it('M2: two bare concurrent saves leave exactly one', async () => {
      const { db } = ctx;
      const { author, named, comment } = await scene('Mention Race Two');

      const t1 = await db.session('a');
      const t2 = await db.session('b');
      try {
        await t1.actAs(author);
        await t2.actAs(author);
        await Promise.all([
          call(t1, editSql, [await newOp(db), comment, `@${handleOf(named)} hello`, [named]]),
          call(t2, editSql, [await newOp(db), comment, `@${handleOf(named)} hello there`, [named]]),
        ]);
      } finally {
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      assert.equal((await mentionsOf(named)).length, 1, 'M2: exactly one, whichever won');
    });

    /**
     * The anti-farming rule at the arity where it could plausibly fail. One connection
     * removes the mention, another puts it back; neither touches `notified_at`, and the
     * row is never deleted, so there is nothing for a second notification to be born from.
     */
    it('M3: removing on one connection and re-adding on another files nothing', async () => {
      const { db } = ctx;
      const { author, named, comment } = await scene('Mention Race Three');

      const first = await db.session('first');
      try {
        await first.actAs(author);
        await call(first, editSql, [await newOp(db), comment, `@${handleOf(named)} hello`, [named]]);
      } finally {
        await first.end();
      }
      assert.equal((await mentionsOf(named)).length, 1, 'M3: told once to begin with');

      const t1 = await db.session('remover');
      const t2 = await db.session('re-adder');
      try {
        await t1.actAs(author);
        await t2.actAs(author);
        // Serialised deliberately: this is not about the window, it is about the ledger
        // surviving a full remove/re-add cycle across two independent connections.
        await call(t1, editSql, [await newOp(db), comment, 'never mind', []]);
        await call(t2, editSql, [await newOp(db), comment, `@${handleOf(named)} hello again`, [named]]);
      } finally {
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      assert.equal((await mentionsOf(named)).length, 1, 'M3: re-adding never rings again');
      const rows = await ledger(comment);
      assert.equal(rows.length, 1, 'M3: the row was deactivated, never deleted');
      assert.equal(rows[0].active, true);
      assert.equal(rows[0].notified, true);
    });

    /**
     * The guard has to be per pair, not per comment. If it were per comment — a single
     * "has this comment notified anybody" flag, which is the obvious cheaper design — the
     * second person named would be silently lost.
     */
    it('M4: two people named concurrently each get exactly one', async () => {
      const { db, fx } = ctx;
      const { author, named, comment } = await scene('Mention Race Four');
      const second = await fx.createUser();
      await fx.follow(author, second);

      const t1 = await db.session('x');
      const t2 = await db.session('y');
      try {
        await t1.actAs(author);
        await t2.actAs(author);
        await Promise.all([
          call(t1, editSql, [await newOp(db), comment, `@${handleOf(named)} @${handleOf(second)} hello`, [named, second]]),
          call(t2, editSql, [await newOp(db), comment, `@${handleOf(named)} @${handleOf(second)} hi`, [named, second]]),
        ]);
      } finally {
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      assert.equal((await mentionsOf(named)).length, 1, 'M4: the first, once');
      assert.equal((await mentionsOf(second)).length, 1, 'M4: the second, once');
    });
  });
}
