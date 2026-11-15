import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { newOp, raceContext } from './_shared.mjs';

/**
 * Helpful votes under independent connections — `20260911000100`, FU1113-F.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING RACED
 *
 * `set_review_helpful` takes no advisory lock: one vote is one row keyed
 * `(review_id, user_id)`, written with `insert … on conflict do nothing` or a
 * `delete`, and the count and the caller's own state are re-read afterwards. Its
 * correctness under concurrency therefore rests on the primary key and on READ
 * COMMITTED giving each statement a fresh snapshot — properties `review-helpful.test.mjs`
 * cannot observe, because PGlite is one connection. A reader with two devices, or a
 * retry racing its original, is two connections.
 *
 * THE INVARIANTS
 *
 * **HV1. Two concurrent Helpful=true from one reader leave one row**, and the second
 * is OBSERVED waiting on the first's uncommitted row (a `transactionid` lock) rather
 * than passing on a lucky interleaving. Both calls report count 1, marked.
 *
 * **HV2. The same, bare** — `Promise.all`, no orchestration, however the scheduler
 * lands them.
 *
 * **HV3. True racing false converges.** Whichever order the two commit in, the final
 * table is the outcome of *some* serial order of the two calls, and `title_reviews_v2`
 * reports exactly it: `helpful_count` equals the rows, `viewer_helpful` equals whether
 * the reader's row exists. Both orders are driven deterministically.
 *
 * **HV4. A retry racing its original (one operation id) applies once.**
 *
 * **HV5. Under a burst of mixed toggles from several readers**, every reader holds at
 * most one row, and the read path agrees with the table.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('review helpful races', () => {
    before(() => rc.open());
    after(() => rc.close());

    const voteSql = `select set_review_helpful($1, $2, $3) as r`;

    /** A public review by a fresh author on a fresh film, and its `user_media.id`. */
    const fixture = async () => {
      const { db, fx } = ctx;
      const author = await fx.createUser();
      const film = await fx.createMovie();
      await fx.logWatch(author, film);
      await db.sql(
        `update user_media
            set note = 'Worth arguing about.', note_visibility = 'public',
                note_updated_at = now()
          where user_id = $1 and media_item_id = $2`,
        [author, film],
      );
      const [{ id }] = await db.rows(
        `select id from user_media where user_id = $1 and media_item_id = $2`,
        [author, film],
      );
      return { author, film, reviewId: id };
    };

    const votesFor = (reviewId) =>
      ctx.db.rows(`select user_id from review_helpful_votes where review_id = $1 order by user_id`, [
        reviewId,
      ]);

    /** What the review card would draw for this reader, through the one read path. */
    const readAs = async (reader, film, reviewId) => {
      const s = await ctx.db.session('reader');
      try {
        await s.actAs(reader);
        const { rows } = await s.q(`select * from title_reviews_v2($1, 'top_desc', 100)`, [film]);
        return rows.find((row) => row.id === reviewId);
      } finally {
        await s.end();
      }
    };

    /** Two sessions acting as one reader: a phone and a tablet. */
    const devices = async (reader) => {
      const phone = await ctx.db.session('phone');
      const tablet = await ctx.db.session('tablet');
      await phone.actAs(reader);
      await tablet.actAs(reader);
      return [phone, tablet];
    };

    const close = async (...sessions) => {
      for (const s of sessions) {
        await s.rollback().catch(() => {});
        await s.end().catch(() => {});
      }
    };

    it('HV1: a second concurrent Helpful waits on the first’s row, and one row results', async () => {
      const { fx, db } = ctx;
      const { film, reviewId } = await fixture();
      const reader = await fx.createUser();
      const [phone, tablet] = await devices(reader);

      let first;
      let second;
      try {
        await phone.begin();
        first = (await phone.one(voteSql, [await newOp(db), reviewId, true])).r;

        await tablet.begin();
        const pending = tablet.start(voteSql, [await newOp(db), reviewId, true]);
        // The primary key, not luck, is what serialises them.
        await tablet.awaitBlocked({ on: 'transactionid' });

        await phone.commit();
        second = (await pending).rows[0].r;
        await tablet.commit();
      } finally {
        await close(phone, tablet);
      }

      assert.deepEqual(await votesFor(reviewId), [{ user_id: reader }], 'HV1: one row');
      assert.equal(first.helpful_count, 1);
      assert.equal(second.helpful_count, 1, 'HV1: the waiter re-read the committed count');
      assert.equal(second.viewer_helpful, true);
      const seen = await readAs(reader, film, reviewId);
      assert.equal(seen.helpful_count, 1);
      assert.equal(seen.viewer_helpful, true);
    });

    it('HV2: two bare concurrent Helpful=true calls leave one row', async () => {
      const { fx, db } = ctx;
      const { reviewId } = await fixture();
      const reader = await fx.createUser();
      const [phone, tablet] = await devices(reader);

      let results;
      try {
        results = await Promise.all([
          phone.one(voteSql, [await newOp(db), reviewId, true]),
          tablet.one(voteSql, [await newOp(db), reviewId, true]),
        ]);
      } finally {
        await close(phone, tablet);
      }

      assert.deepEqual(await votesFor(reviewId), [{ user_id: reader }], 'HV2: one row');
      for (const { r } of results) assert.equal(r.viewer_helpful, true);
    });

    it('HV3a: true committed after a racing false (on an unmarked review) stays marked', async () => {
      const { fx, db } = ctx;
      const { film, reviewId } = await fixture();
      const reader = await fx.createUser();
      const [phone, tablet] = await devices(reader);

      try {
        // Phone marks, uncommitted. Tablet takes it back: it cannot see the uncommitted
        // row, deletes nothing and does not wait — serially, "false, then true".
        await phone.begin();
        await phone.one(voteSql, [await newOp(db), reviewId, true]);
        await tablet.begin();
        const off = (await tablet.one(voteSql, [await newOp(db), reviewId, false])).r;
        assert.equal(off.viewer_helpful, false);
        await tablet.commit();
        await phone.commit();
      } finally {
        await close(phone, tablet);
      }

      const rows = await votesFor(reviewId);
      const seen = await readAs(reader, film, reviewId);
      assert.deepEqual(rows, [{ user_id: reader }], 'HV3a: the serial order false→true');
      assert.equal(seen.helpful_count, rows.length, 'HV3a: the count is the rows');
      assert.equal(seen.viewer_helpful, true, 'HV3a: the reader’s state is their row');
    });

    it('HV3b: true racing an uncommitted false (on a marked review) waits, then marks', async () => {
      const { fx, db } = ctx;
      const { film, reviewId } = await fixture();
      const reader = await fx.createUser();
      const other = await fx.createUser();
      const [phone, tablet] = await devices(reader);
      // Somebody else's vote too, so a count of 1 vs 2 distinguishes the outcomes.
      const s = await db.session('other');
      try {
        await s.actAs(other);
        await s.one(voteSql, [await newOp(db), reviewId, true]);
      } finally {
        await s.end();
      }

      let marked;
      try {
        await phone.one(voteSql, [await newOp(db), reviewId, true]);

        // Phone takes it back, uncommitted; tablet marks it and must wait on that row.
        await phone.begin();
        await phone.one(voteSql, [await newOp(db), reviewId, false]);
        await tablet.begin();
        const pending = tablet.start(voteSql, [await newOp(db), reviewId, true]);
        await tablet.awaitBlocked({ on: 'transactionid' });
        await phone.commit();
        marked = (await pending).rows[0].r;
        await tablet.commit();
      } finally {
        await close(phone, tablet);
      }

      const rows = await votesFor(reviewId);
      const seen = await readAs(reader, film, reviewId);
      assert.equal(rows.length, 2, 'HV3b: the serial order false→true: both readers marked');
      assert.equal(marked.helpful_count, 2, 'HV3b: the waiter reports the committed count');
      assert.equal(marked.viewer_helpful, true);
      assert.equal(seen.helpful_count, 2);
      assert.equal(seen.viewer_helpful, true);
    });

    it('HV4: a retry racing its original, on one operation id, applies once', async () => {
      const { fx, db } = ctx;
      const { reviewId } = await fixture();
      const reader = await fx.createUser();
      const [phone, tablet] = await devices(reader);
      const op = await newOp(db);

      let results;
      try {
        await phone.begin();
        const original = phone.start(voteSql, [op, reviewId, true]);
        await original;
        // The retry carries the same id and, adversarially, the opposite intent.
        await tablet.begin();
        const retry = tablet.start(voteSql, [op, reviewId, false]);
        await tablet.awaitBlocked({ on: 'transactionid' });
        await phone.commit();
        results = [(await original).rows[0].r, (await retry).rows[0].r];
        await tablet.commit();
      } finally {
        await close(phone, tablet);
      }

      assert.deepEqual(await votesFor(reviewId), [{ user_id: reader }], 'HV4: applied once');
      assert.equal(results[1].viewer_helpful, true, 'HV4: the retry was a no-op');
      const [{ n }] = await db.rows(
        `select count(*)::int as n from processed_operations where operation_id = $1`,
        [op],
      );
      assert.equal(n, 1);
    });

    it('HV5: a burst of mixed toggles from several readers keeps one row each, and the read agrees', async () => {
      const { fx, db } = ctx;
      const { film, reviewId } = await fixture();
      const readers = [];
      for (let n = 0; n < 4; n += 1) readers.push(await fx.createUser());

      const sessions = [];
      try {
        for (const reader of readers) {
          for (let d = 0; d < 2; d += 1) {
            const s = await db.session(`r${readers.indexOf(reader)}d${d}`);
            await s.actAs(reader);
            sessions.push(s);
          }
        }
        // Eight connections, three rounds each, alternating intent per device.
        for (let round = 0; round < 3; round += 1) {
          await Promise.all(
            sessions.map(async (s, i) =>
              s.one(voteSql, [await newOp(db), reviewId, (i + round) % 2 === 0]),
            ),
          );
        }
      } finally {
        for (const s of sessions) await s.end().catch(() => {});
      }

      const rows = await votesFor(reviewId);
      const ids = rows.map((row) => row.user_id);
      assert.equal(new Set(ids).size, ids.length, 'HV5: nobody holds two votes');
      for (const reader of readers) {
        const seen = await readAs(reader, film, reviewId);
        assert.equal(seen.helpful_count, rows.length, 'HV5: the count is the rows');
        // `bool_or` over no votes is null, which the client reads as false
        // (`use-title-reviews.ts`: `viewer_helpful ?? false`).
        assert.equal(seen.viewer_helpful ?? false, ids.includes(reader), 'HV5: state is the row');
      }
    });
  });
}
