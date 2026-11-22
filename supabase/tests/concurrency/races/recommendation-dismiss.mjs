import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, newOp, raceContext } from './_shared.mjs';

/**
 * Removing a received recommendation from Sent to You, raced (20261130001200).
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **D1. Two devices removing the same row at once agree.** Both calls succeed; the first
 * to commit dismisses it, the second queues on the row lock, re-reads `dismissed_at is
 * null` after the first commits, and reports `dismissed: false`. `dismissed_at` is the first
 * commit's time. No error, no deadlock.
 *
 * **D2. One operation id replayed on two connections at once applies once.** A client that
 * lost its reply retries with the same id while the original is still open: the second
 * blocks on the ledger's unique key and answers `already_applied` once the first commits.
 * This is what makes "dismiss, Undo, replay of the dismissal" safe.
 *
 * **D3. An Undo cannot overtake its dismissal.** A restore that reaches the server while the
 * dismissal is still uncommitted finds nothing to restore (its predicate is false on its
 * snapshot, so it does not wait), so the client must not send it until the dismissal has
 * answered — which `useDismissReceived` does. Once committed, the Undo restores the row.
 *
 * **D4. A resend and a dismissal of the same row, in either order, keep both effects.** The
 * resend moves `recommended_at`; the dismissal sets `dismissed_at`. Neither write's SET
 * names the other's column, so a resend cannot put a dismissed recommendation back in the
 * recipient's list, and a dismissal cannot undo the resend. Nobody is notified.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  const rowOf = async (db, id) =>
    (
      await db.rows(
        `select dismissed_at, recommended_at, seen_at, opened_at, state
           from title_recommendations where id = $1`,
        [id],
      )
    )[0];

  const deliveredPair = async (title) => {
    const { db, fx } = ctx;
    const sender = await fx.createUser();
    const recipient = await fx.createUser();
    await fx.mutualFollow(sender, recipient);
    await db.sql(
      `update app_config set value = '10000'::jsonb where key like 'recommendations.max_per_%'`,
    );
    const s = await db.session('sender');
    await s.actAs(sender);
    const movie = await fx.createMovie(title);
    const sent = await call(s, `recommend_title($1, $2, $3)`, [
      await newOp(db),
      recipient,
      movie,
    ]);
    assert.equal(sent.delivered, true);
    return { sender, recipient, movie, id: sent.id, s };
  };

  const devices = async (recipient) => {
    const { db } = ctx;
    const a = await db.session('device-a');
    const b = await db.session('device-b');
    await a.actAs(recipient);
    await b.actAs(recipient);
    return { a, b };
  };

  const DISMISS = `select dismiss_received_recommendation($1, $2) as r`;
  const RESTORE = `select restore_received_recommendation($1, $2) as r`;

  describe('Sent to You removal races', () => {
    before(() => rc.open());
    after(() => rc.close());

    it('D1: two devices removing the same row at once both succeed and agree', async () => {
      const { db } = ctx;
      const { recipient, id, s } = await deliveredPair('Dismiss Race D1');
      const { a, b } = await devices(recipient);

      await a.begin();
      assert.deepEqual((await a.q(DISMISS, [await newOp(db), id])).rows[0].r, {
        status: 'ok',
        dismissed: true,
      });
      await b.begin();
      const pb = b.start(DISMISS, [await newOp(db), id]);
      await b.awaitBlocked();

      const first = (await db.rows(`select now() as at`))[0].at;
      await a.commit();
      assert.deepEqual((await pb).rows[0].r, { status: 'ok', dismissed: false });
      await b.commit();

      const row = await rowOf(db, id);
      assert.notEqual(row.dismissed_at, null);
      assert.ok(row.dismissed_at <= first, 'D1: dismissed_at is the first commit’s');
      assert.equal(row.seen_at, null);
      assert.equal(row.opened_at, null);

      await a.end();
      await b.end();
      await s.end();
    });

    it('D2: one operation id replayed on two connections at once applies once', async () => {
      const { db } = ctx;
      const { recipient, id, s } = await deliveredPair('Dismiss Race D2');
      const { a, b } = await devices(recipient);
      const op = await newOp(db);

      await a.begin();
      assert.equal((await a.q(DISMISS, [op, id])).rows[0].r.dismissed, true);
      await b.begin();
      const pb = b.start(DISMISS, [op, id]);
      await b.awaitBlocked();
      await a.commit();
      assert.deepEqual((await pb).rows[0].r, { status: 'already_applied' });
      await b.commit();

      // The replay after an Undo: still already_applied, and the Undo stands.
      assert.equal(
        (await call(a, `restore_received_recommendation($1, $2)`, [await newOp(db), id]))
          .restored,
        true,
      );
      assert.deepEqual(await call(b, `dismiss_received_recommendation($1, $2)`, [op, id]), {
        status: 'already_applied',
      });
      assert.equal((await rowOf(db, id)).dismissed_at, null);

      await a.end();
      await b.end();
      await s.end();
    });

    it('D3: an Undo cannot overtake an uncommitted dismissal, which is why the client waits', async () => {
      const { db } = ctx;
      const { recipient, id, s } = await deliveredPair('Dismiss Race D3');
      const { a, b } = await devices(recipient);

      await a.begin();
      await a.q(DISMISS, [await newOp(db), id]);
      // READ COMMITTED: the restore's `dismissed_at is not null` is false on its snapshot, so
      // it does not wait on the row and finds nothing to restore. `useDismissReceived` holds
      // an Undo until its dismissal has answered for exactly this reason.
      await b.begin();
      assert.deepEqual((await b.q(RESTORE, [await newOp(db), id])).rows[0].r, {
        status: 'ok',
        restored: false,
      });
      await b.commit();
      await a.commit();
      assert.notEqual((await rowOf(db, id)).dismissed_at, null);

      // Once the dismissal has committed, the Undo restores it.
      assert.deepEqual(
        await call(b, `restore_received_recommendation($1, $2)`, [await newOp(db), id]),
        {
          status: 'ok',
          restored: true,
        },
      );
      assert.equal((await rowOf(db, id)).dismissed_at, null);

      await a.end();
      await b.end();
      await s.end();
    });

    it('D4: a resend and a dismissal of the same row keep both effects, in either order', async () => {
      const { db } = ctx;

      for (const order of ['resend-first', 'dismiss-first']) {
        const { recipient, movie, id, s } = await deliveredPair(`Dismiss Race D4 ${order}`);
        const before = await rowOf(db, id);
        const notes = (await db.rows(`select count(*)::int as n from notifications`))[0].n;
        const r = await db.session(`recipient-${order}`);
        await r.actAs(recipient);
        const RESEND = `select recommend_title($1, $2, $3) as r`;

        if (order === 'resend-first') {
          await s.begin();
          await s.q(RESEND, [await newOp(db), recipient, movie]);
          await r.begin();
          const pr = r.start(DISMISS, [await newOp(db), id]);
          await r.awaitBlocked();
          await s.commit();
          assert.deepEqual((await pr).rows[0].r, { status: 'ok', dismissed: true });
          await r.commit();
        } else {
          await r.begin();
          await r.q(DISMISS, [await newOp(db), id]);
          await s.begin();
          const ps = s.start(RESEND, [await newOp(db), recipient, movie]);
          await s.awaitBlocked();
          await r.commit();
          assert.equal((await ps).rows[0].r.created, false);
          await s.commit();
        }

        const row = await rowOf(db, id);
        assert.notEqual(row.dismissed_at, null, `D4 (${order}): the dismissal survives`);
        assert.ok(
          row.recommended_at > before.recommended_at,
          `D4 (${order}): the resend moved it`,
        );
        assert.equal(row.state, 'delivered');
        assert.equal(
          (await db.rows(`select count(*)::int as n from notifications`))[0].n,
          notes,
          `D4 (${order}): nobody is notified`,
        );
        await r.end();
        await s.end();
      }
    });
  });
}
