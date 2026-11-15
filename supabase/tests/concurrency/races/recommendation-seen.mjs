import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, newOp, raceContext } from './_shared.mjs';

/**
 * Sent to You read-state races (20261121000100, FU1113-E).
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **S1. Two marks at once agree.** One account on two devices opens Sent to You at the
 * same moment. Both calls succeed, the rows are marked once between them, and `seen_at`
 * is the first commit's time — the second re-reads `seen_at is null` after the first
 * commits and leaves it alone. No error, no deadlock.
 *
 * **S2. A send landing during a mark stays unseen.** The mark names the ids the client
 * had on screen; a recommendation committed concurrently is not among them and must
 * come out unread.
 *
 * **S3. A resend and a mark of the same row, in either order, keep both effects.** The
 * resend moves `recommended_at`; the mark sets `seen_at`. Neither write's SET list names
 * the other's column, so whichever commits second keeps the first's change — a resend
 * cannot make a seen row unread again (the same anti-spam rule as `opened_at`).
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  const seenOf = async (db, id) =>
    (
      await db.rows(
        `select seen_at, opened_at, recommended_at from title_recommendations where id = $1`,
        [id],
      )
    )[0];

  const deliveredPair = async () => {
    const { db, fx } = ctx;
    const sender = await fx.createUser();
    const recipient = await fx.createUser();
    await fx.mutualFollow(sender, recipient);
    await db.sql(
      `update app_config set value = '10000'::jsonb where key like 'recommendations.max_per_%'`,
    );
    const s = await db.session('sender');
    await s.actAs(sender);
    const ids = [];
    for (const title of ['Seen Race A', 'Seen Race B']) {
      const movie = await fx.createMovie(title);
      ids.push((await call(s, `recommend_title($1, $2, $3)`, [await newOp(db), recipient, movie])).id);
    }
    return { sender, recipient, ids, s };
  };

  describe('Sent to You read-state races', () => {
    before(() => rc.open());
    after(() => rc.close());

    it('S1: two devices marking the same rows at once both succeed and agree', async () => {
      const { db } = ctx;
      const { recipient, ids, s } = await deliveredPair();

      const a = await db.session('device-a');
      const b = await db.session('device-b');
      await a.actAs(recipient);
      await b.actAs(recipient);

      await a.begin();
      const ra = await call(a, `mark_recommendations_seen($1, $2::uuid[])`, [
        await newOp(db),
        ids,
      ]);
      assert.deepEqual(ra, { status: 'ok', marked: 2 });

      // The same rows, the other way round: the ordered row locks make B queue on the
      // first one rather than hold one A needs.
      await b.begin();
      const pb = b.start(`select mark_recommendations_seen($1, $2::uuid[]) as r`, [
        await newOp(db),
        [...ids].reverse(),
      ]);
      await b.awaitBlocked();

      const first = await db.rows(`select now() as at`);
      await a.commit();
      const rb = (await pb).rows[0].r;
      await b.commit();

      assert.deepEqual(rb, { status: 'ok', marked: 0 }, 'S1: the second finds them marked');
      const rows = await Promise.all(ids.map((id) => seenOf(db, id)));
      for (const row of rows) {
        assert.notEqual(row.seen_at, null);
        assert.ok(row.seen_at <= first[0].at, 'S1: seen_at is the first commit’s, not moved');
        assert.equal(row.opened_at, null);
      }

      await a.end();
      await b.end();
      await s.end();
    });

    it('S2: a recommendation committed during a mark is not in p_ids and stays unseen', async () => {
      const { db, fx } = ctx;
      const { sender, recipient, ids, s } = await deliveredPair();
      const late = await fx.createMovie('Seen Race Late');

      // The send is open (row inserted, not committed) while the mark runs and commits.
      await s.begin();
      const sent = await call(s, `recommend_title($1, $2, $3)`, [await newOp(db), recipient, late]);
      assert.equal(sent.delivered, true);

      const r = await db.session('recipient');
      await r.actAs(recipient);
      await r.begin();
      const pr = r.start(`select mark_recommendations_seen($1, $2::uuid[]) as r`, [
        await newOp(db),
        ids,
      ]);
      await r.assertRunning();
      const marked = (await pr).rows[0].r;
      await r.commit();
      await s.commit();

      assert.deepEqual(marked, { status: 'ok', marked: 2 });
      assert.equal((await seenOf(db, sent.id)).seen_at, null, 'S2: the late arrival is unread');

      // And a send committed *before* the mark, but not in what the client loaded, is
      // equally left alone — the ids are the whole of what is marked.
      const another = await fx.createMovie('Seen Race Not Loaded');
      const sent2 = await call(s, `recommend_title($1, $2, $3)`, [
        await newOp(db),
        recipient,
        another,
      ]);
      await call(r, `mark_recommendations_seen($1, $2::uuid[])`, [await newOp(db), ids]);
      assert.equal((await seenOf(db, sent2.id)).seen_at, null);

      assert.ok(sender);
      await r.end();
      await s.end();
    });

    it('S3: a resend and a mark of the same row keep both effects, in either order', async () => {
      const { db, fx } = ctx;
      const { recipient, s } = await deliveredPair();

      for (const order of ['resend-first', 'mark-first']) {
        const movie = await fx.createMovie(`Seen Race Resend ${order}`);
        const first = await call(s, `recommend_title($1, $2, $3)`, [
          await newOp(db),
          recipient,
          movie,
        ]);
        const before = await seenOf(db, first.id);

        const r = await db.session(`recipient-${order}`);
        await r.actAs(recipient);
        const markSql = `select mark_recommendations_seen($1, $2::uuid[]) as r`;
        const resendSql = `select recommend_title($1, $2, $3) as r`;

        if (order === 'resend-first') {
          await s.begin();
          await s.q(resendSql, [await newOp(db), recipient, movie]);
          await r.begin();
          const pm = r.start(markSql, [await newOp(db), [first.id]]);
          await r.awaitBlocked();
          await s.commit();
          assert.deepEqual((await pm).rows[0].r, { status: 'ok', marked: 1 });
          await r.commit();
        } else {
          await r.begin();
          await r.q(markSql, [await newOp(db), [first.id]]);
          await s.begin();
          const ps = s.start(resendSql, [await newOp(db), recipient, movie]);
          await s.awaitBlocked();
          await r.commit();
          assert.equal((await ps).rows[0].r.created, false);
          await s.commit();
        }

        const row = await seenOf(db, first.id);
        assert.notEqual(row.seen_at, null, `S3 (${order}): the mark survives the resend`);
        assert.ok(row.recommended_at > before.recommended_at, `S3 (${order}): the resend moved it`);
        assert.equal(row.opened_at, null);
        await r.end();
      }

      await s.end();
    });
  });
}
