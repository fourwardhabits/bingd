import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * Refine under two writers (T5, `20261019000100`).
 *
 * Refine adds no lock of its own: `refine_start` takes `_lock_media` like every opening,
 * and the answers run through `rank_answer`, whose claim and category lock are already
 * raced in `ranking.mjs` and `operation-intent.mjs`. What is new, and what these prove on
 * a real PostgreSQL (PGlite has one backend and cannot ask):
 *
 *   R1  two `refine_start`s for one title — a double tap, or two devices — end in ONE
 *       session, and the second is told it resumed it;
 *   R2  a replayed answer racing its original records ONE comparison and returns the
 *       original's reply;
 *   R3  a refine that moves a title, racing a first ranking into the same band, leaves
 *       the ranking and the ledger valid.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;
  let base = 50_000_000;

  /** `n` ranked loved movies with backfill placements, as the owner, in one statement. */
  async function library(db, user, n) {
    const rows = await db.rows(
      `with items as (
         insert into media_items (kind, tmdb_id, title, provenance)
         select 'movie', -($2::int + g), 'Refine race ' || $2::int || ' ' || g, 'manual'
           from generate_series(1, $3::int) g
         returning id, tmdb_id
       ), numbered as (
         select id, row_number() over (order by tmdb_id desc)::int as n from items
       ), logged as (
         insert into user_media (user_id, media_item_id, bucket)
         select $1, id, 'loved' from numbered returning media_item_id
       ), ranked as (
         insert into rankings (user_id, media_item_id, category, bucket, position)
         select $1, id, 'movies', 'loved', n from numbered returning media_item_id
       ), placed as (
         insert into ranking_placements (user_id, media_item_id, category, kind, outcome,
           bucket, position, band_rank, band_size, category_size, score, adjustable)
         select $1, id, 'movies', 'backfill', 'placed', 'loved', n, n, $3::int, $3::int, 8.0, true
           from numbered returning media_item_id
       )
       select n.id from numbered n
        where exists (select 1 from ranked r where r.media_item_id = n.id)
          and exists (select 1 from placed p where p.media_item_id = n.id)
          and exists (select 1 from logged l where l.media_item_id = n.id)
        order by n.n`,
      [user, (base += 1000), n],
    );
    return rows.map((r) => r.id);
  }

  const valid = async (db, user) => {
    await db.sql(`select assert_ranking_valid($1, 'movies')`, [user]);
    await db.sql(`select assert_placements_valid($1)`, [user]);
  };

  describe('refine under two writers', () => {
    before(async () => {
      await rc.open();
      await ctx.db.sql(
        `update app_config set value = 'true'::jsonb where key = 'ranking.refine_enabled'`,
      );
    });
    after(() => rc.close());

    it('R1: two refine_starts for one title end in one session, the second resumed', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await library(db, user, 30);
      const target = ids[12];

      const first = await db.session('first');
      const second = await db.session('second');
      await first.actAs(user);
      await second.actAs(user);

      await first.begin();
      const a = await call(first, `refine_start($1, $2)`, [target, await newOp(db)]);
      assert.equal(a.done, false);

      await second.begin();
      const racing = fire(second, `refine_start($1, $2)`, [target, await newOp(db)]);
      const waiting = await second.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, target),
      });
      assert.equal(waiting.wait_event, 'advisory', 'the media lock serialises them');

      await first.commit();
      const b = (await racing).rows[0].r;
      await second.commit();

      assert.equal(b.resumed, true);
      assert.equal(b.session_id, a.session_id);
      assert.equal(b.pivot, a.pivot);
      const sessions = await db.rows(
        `select count(*)::int as n from ranking_sessions where user_id = $1 and media_item_id = $2`,
        [user, target],
      );
      assert.equal(sessions[0].n, 1);

      await first.end();
      await second.end();
    });

    it('R2: a replayed answer racing its original is applied once', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await library(db, user, 30);
      const target = ids[8];

      const opener = await db.session('opener');
      await opener.actAs(user);
      const s = await call(opener, `refine_start($1, $2)`, [target, await newOp(db)]);
      await opener.end();

      const op = await newOp(db);
      const original = await db.session('original');
      const replay = await db.session('replay');
      await original.actAs(user);
      await replay.actAs(user);

      await original.begin();
      const x = await call(original, `rank_answer($1, $2, $3)`, [s.session_id, s.pivot, op]);

      await replay.begin();
      const racing = fire(replay, `rank_answer($1, $2, $3)`, [s.session_id, s.pivot, op]);
      // The claim's `on conflict` waits on the uncommitted claim rather than skipping.
      await replay.awaitBlocked();

      await original.commit();
      const y = (await racing).rows[0].r;
      await replay.commit();

      assert.deepEqual(y, x, 'the replay answers with what the original said');
      const answers = await db.rows(
        `select count(*)::int as n from comparisons where session_id = $1`,
        [s.session_id],
      );
      assert.equal(answers[0].n, 1);
      await valid(db, user);

      await original.end();
      await replay.end();
    });

    it('R3: a refine move racing a first ranking in the same band stays valid', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await library(db, user, 40);
      const target = ids[30]; // #31; the reader now puts it above #25..#30

      const fresh = await fx.createMovie('Arrives mid-refine');

      const refiner = await db.session('refiner');
      const ranker = await db.session('ranker');
      await refiner.actAs(user);
      await ranker.actAs(user);

      // The refine session opens over the band BEFORE the fresh title exists in it.
      const r = await call(refiner, `refine_start($1, $2)`, [target, await newOp(db)]);
      assert.equal(r.done, false);

      // The fresh title is ranked into the same band from another screen, losing every
      // comparison. Its placing answer is held open, holding the category lock.
      let s = await call(ranker, `rank_start($1, 'loved', $2)`, [fresh, await newOp(db)]);
      let placing = null;
      for (let guard = 0; guard < 20 && !placing; guard += 1) {
        await ranker.begin();
        const next = await call(ranker, `rank_answer($1, $2, $3)`, [
          s.session_id,
          s.pivot,
          await newOp(db),
        ]);
        if (next.done) placing = next;
        else {
          await ranker.commit();
          s = next;
        }
      }
      assert.ok(placing, 'the first ranking reached its finalize');

      // The refine answer has to wait for it: the session sync takes the category lock.
      const truth = [
        ...ids.slice(0, 24),
        target,
        ...ids.slice(24, 30),
        ...ids.slice(31),
        fresh,
      ];
      const winnerFor = (pivot) =>
        truth.indexOf(target) < truth.indexOf(pivot) ? target : pivot;
      const racing = fire(refiner, `rank_answer($1, $2, $3)`, [
        r.session_id,
        winnerFor(r.pivot),
        await newOp(db),
      ]);
      const waiting = await refiner.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.categoryKey(user, 'movies'),
      });
      assert.equal(waiting.wait_event, 'advisory');

      await ranker.commit();
      let res = (await racing).rows[0].r;

      // The band moved under the session, so it was rebased; carry on to the end.
      for (let guard = 0; !res.done && guard < 30; guard += 1) {
        res = await call(refiner, `rank_answer($1, $2, $3)`, [
          res.session_id,
          winnerFor(res.pivot),
          await newOp(db),
        ]);
      }

      assert.equal(res.done, true);
      assert.equal(res.movement.outcome, 'moved');
      assert.equal(res.movement.kind, 'refine');
      assert.equal(res.position, 25);
      const order = await db.rows(
        `select media_item_id from rankings where user_id = $1 order by position`,
        [user],
      );
      assert.deepEqual(
        order.map((row) => row.media_item_id),
        truth,
      );
      await valid(db, user);
      await refiner.end();
      await ranker.end();
    });
  });
}
