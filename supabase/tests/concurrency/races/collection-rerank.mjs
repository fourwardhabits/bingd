import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { fire, newOp, raceContext } from './_shared.mjs';

/**
 * Collection drag-to-rerank from two devices at once (#318, 20261129000100).
 *
 * `collection-rerank.test.mjs` runs on PGlite: one connection, so two moves never overlap.
 * This is the overlap, on a real PostgreSQL.
 *
 * **CR1. Two moves in one band queue on the category lock**, observed waiting on that exact
 * advisory key. The second is computed from the list as it was before the first committed,
 * so its guards are stale, and it must be **refused (55000) rather than land one place
 * off**. That is the whole reason the guards exist: without them the second move's
 * absolute position would be applied to a list it was not computed from.
 *
 * **CR1b/CR1c (Codex, PR 319).** A title shifted by another title's move while this one waits
 * for the category lock is re-read inside it: a stale expected position is refused, and an
 * unguarded move records where the title really was.
 *
 * **CR2. Two moves whose guards still hold both land**, in commit order, and I1–I4 and the
 * ledger's P1–P4 survive.
 *
 * **CR3. One operation id sent twice at once applies once**: the replay waits on the
 * ledger claim and returns the first reply, and there is one placement row.
 *
 * **CR4–CR6. Across a category** (20261129000200). Two devices dragging different titles
 * across categories queue on the category lock and the stale one is refused (CR4); two
 * dragging the same title queue on its media lock (CR5); and a move rolled back leaves no
 * category change, collection change or placement, while the move behind it lands (CR6).
 * I1–I4, P1–P4 and I3 (user_media agrees) hold after each.
 *
 * **CR7–CR10. The TV wall** (20261129000300). A promotion computed from a wall another
 * device just changed waits on the show category lock and is refused (CR7); two devices
 * promoting the same show serialise on its media lock and only one lands (CR8); an Undo
 * racing a move of the promoted show waits on the media lock and is refused once the move
 * lands (CR9); and a promotion rolled back leaves no collection row, ranking, placement,
 * record or watch, while the promotion behind it lands (CR10). W1 holds after each.
 *
 * **CR11–CR12 (Codex, PR 319).** Two devices removing a promoted show's last two seasons
 * serialise their commit-time evidence check on the series, so the second backfills the
 * show's undated event and W1 holds (CR11). A promotion waiting behind its last season's
 * unranking re-checks inside the seasons' category lock and is refused (CR12).
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('collection rerank races', () => {
    before(() => rc.open());
    after(() => rc.close());

    /** `n` films ranked into one band, each new one landing at the bottom. */
    const band = async (user, n, label) => {
      const solo = await ctx.db.session('setup');
      await solo.actAs(user);
      const ids = [];
      for (let i = 0; i < n; i += 1) {
        const film = await ctx.fx.createMovie(`${label} ${i}`);
        let step = (await solo.one(`select rank_start($1, 'loved') as r`, [film])).r;
        let guard = 0;
        while (!step.done) {
          step = (await solo.one(`select rank_answer($1, $2) as r`, [step.session_id, step.pivot])).r;
          guard += 1;
          if (guard > 32) throw new Error('did not converge');
        }
        ids.push(film);
      }
      await solo.end();
      return ids;
    };

    const order = async (user) =>
      (
        await ctx.db.rows(
          `select media_item_id from rankings where user_id = $1 and category = 'movies' order by position`,
          [user],
        )
      ).map((r) => r.media_item_id);

    const manualCount = async (user) =>
      Number(
        (
          await ctx.db.rows(
            `select count(*) as n from ranking_placements where user_id = $1 and kind = 'manual'`,
            [user],
          )
        )[0].n,
      );

    const valid = async (user) => {
      await ctx.db.sql(`select assert_ranking_valid($1, 'movies')`, [user]);
      await ctx.db.sql(`select assert_placements_valid($1)`, [user]);
    };

    it('CR1: a second move computed before the first committed waits, then is refused as stale', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await band(user, 4, 'CR1');

      const first = await db.session('device-a');
      const second = await db.session('device-b');
      await first.actAs(user);
      await second.actAs(user);

      // Device A moves #4 to the top: everything shifts down one.
      await first.begin();
      await first.q(`select rank_reorder($1, 1, $2, 4, $3)`, [ids[3], await newOp(db), ids[0]]);

      // Device B, drawn from the same list, moves #2 to #1, above ids[0].
      await second.begin();
      const moving = second.errorFrom(`select rank_reorder($1, 1, $2, 2, $3)`, [
        ids[1],
        await newOp(db),
        ids[0],
      ]);
      const waiting = await second.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.categoryKey(user, 'movies'),
      });
      assert.equal(waiting.wait_event, 'advisory');

      await first.commit();
      const refusal = await moving;
      await second.rollback();

      assert.equal(refusal?.code, '55000', 'the stale move is refused, not applied one place off');
      assert.deepEqual(await order(user), [ids[3], ids[0], ids[1], ids[2]], "only A's move landed");
      assert.equal(await manualCount(user), 1);
      await valid(user);

      await first.end();
      await second.end();
    });

    it('CR1b: a title shifted by another move while waiting is re-read, and the stale move refused', async () => {
      // Codex, PR 319: A/B/C/D. Device A moves B from #2 to #3. Device B read C at #3 and
      // moves it to #1, above A — an anchor that never changes. Only the title's own
      // position moved (to #2), so the expected-position guard is the only thing that can
      // notice, and only if the row is re-read after the category lock is taken.
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await band(user, 4, 'CR1b');

      const first = await db.session('device-a');
      const second = await db.session('device-b');
      await first.actAs(user);
      await second.actAs(user);

      await first.begin();
      await first.q(`select rank_reorder($1, 3, $2, 2, $3)`, [ids[1], await newOp(db), ids[2]]);

      await second.begin();
      const moving = second.errorFrom(`select rank_reorder($1, 1, $2, 3, $3)`, [
        ids[2],
        await newOp(db),
        ids[0],
      ]);
      await second.awaitBlocked({ on: 'advisory', advisoryKey: await db.categoryKey(user, 'movies') });

      await first.commit();
      const refusal = await moving;
      await second.rollback();

      assert.equal(refusal?.code, '55000', 'the title is at #2 now, not the #3 the client saw');
      assert.deepEqual(await order(user), [ids[0], ids[2], ids[1], ids[3]], "only A's move landed");
      assert.equal(await manualCount(user), 1);
      await valid(user);

      await first.end();
      await second.end();
    });

    it('CR1c: without guards, a waiting move still records where the title really was', async () => {
      // The same interleaving with no guards (an installed client never sends them): the
      // move lands, and the immutable ledger row must carry the position the title held
      // when the move ran, not the one read before the wait.
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await band(user, 4, 'CR1c');

      const first = await db.session('device-a');
      const second = await db.session('device-b');
      await first.actAs(user);
      await second.actAs(user);

      await first.begin();
      await first.q(`select rank_reorder($1, 3, $2)`, [ids[1], await newOp(db)]);

      await second.begin();
      const moving = fire(second, `rank_reorder($1, 1, $2)`, [ids[2], await newOp(db)]);
      await second.awaitBlocked({ on: 'advisory', advisoryKey: await db.categoryKey(user, 'movies') });

      await first.commit();
      const reply = (await moving).rows[0].r;
      await second.commit();

      assert.equal(reply.from_position, 2, 'C was at #2 when its move ran');
      const [row] = await db.rows(
        `select from_position from ranking_placements
          where user_id = $1 and media_item_id = $2 and kind = 'manual'`,
        [user, ids[2]],
      );
      assert.equal(row.from_position, 2);
      assert.deepEqual(await order(user), [ids[2], ids[0], ids[1], ids[3]]);
      await valid(user);

      await first.end();
      await second.end();
    });

    it('CR2: two moves whose guards still hold both land, in commit order', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await band(user, 4, 'CR2');

      const first = await db.session('device-a');
      const second = await db.session('device-b');
      await first.actAs(user);
      await second.actAs(user);

      // A swaps #1 and #2; B swaps #3 and #4. Neither touches the other's positions.
      await first.begin();
      await first.q(`select rank_reorder($1, 1, $2, 2, $3)`, [ids[1], await newOp(db), ids[0]]);

      await second.begin();
      const moving = fire(second, `rank_reorder($1, 3, $2, 4, $3)`, [ids[3], await newOp(db), ids[2]]);
      await second.awaitBlocked({ on: 'advisory', advisoryKey: await db.categoryKey(user, 'movies') });

      await first.commit();
      await moving;
      await second.commit();

      assert.deepEqual(await order(user), [ids[1], ids[0], ids[3], ids[2]]);
      assert.equal(await manualCount(user), 2);
      await valid(user);

      await first.end();
      await second.end();
    });

    it('CR3: one operation id sent twice at once applies once', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const ids = await band(user, 3, 'CR3');
      const id = await newOp(db);

      const first = await db.session('attempt-1');
      const retry = await db.session('attempt-2');
      await first.actAs(user);
      await retry.actAs(user);

      await first.begin();
      const reply = (await first.one(`select rank_reorder($1, 1, $2, 3, $3) as r`, [ids[2], id, ids[0]])).r;

      await retry.begin();
      const replaying = fire(retry, `rank_reorder($1, 1, $2, 3, $3)`, [ids[2], id, ids[0]]);
      await retry.awaitBlocked();

      await first.commit();
      const replayed = (await replaying).rows[0].r;
      await retry.commit();

      assert.deepEqual(await order(user), [ids[2], ids[0], ids[1]]);
      assert.equal(await manualCount(user), 1, 'one move, one placement');
      assert.deepEqual(replayed, reply, 'the replay returns the first reply');
      await valid(user);

      await first.end();
      await retry.end();
    });

    // -----------------------------------------------------------------------
    // Across a category (20261129000200, founder 2026-11-19)
    // -----------------------------------------------------------------------

    /** `n` films ranked into `bucket`, each new one landing at the bottom of it. */
    const bandIn = async (user, n, label, bucket) => {
      const solo = await ctx.db.session('setup');
      await solo.actAs(user);
      const ids = [];
      for (let i = 0; i < n; i += 1) {
        const film = await ctx.fx.createMovie(`${label} ${i}`);
        let step = (await solo.one(`select rank_start($1, $2::taste_bucket) as r`, [film, bucket])).r;
        let guard = 0;
        while (!step.done) {
          step = (await solo.one(`select rank_answer($1, $2) as r`, [step.session_id, step.pivot])).r;
          guard += 1;
          if (guard > 32) throw new Error('did not converge');
        }
        ids.push(film);
      }
      await solo.end();
      return ids;
    };

    /** I3 on every title: the collection row's category is the ranking's. */
    const agrees = async (user) => {
      const rows = await ctx.db.rows(
        `select r.media_item_id from rankings r
           join user_media m on m.user_id = r.user_id and m.media_item_id = r.media_item_id
          where r.user_id = $1 and m.bucket is distinct from r.bucket`,
        [user],
      );
      assert.deepEqual(rows, [], 'user_media.bucket agrees with rankings.bucket');
    };

    const bucketOf = async (user, item) =>
      (
        await ctx.db.rows(`select bucket from rankings where user_id = $1 and media_item_id = $2`, [
          user,
          item,
        ])
      )[0]?.bucket;

    it('CR4: two cross-category moves from two devices: the second waits, then is refused as stale', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const loved = await bandIn(user, 3, 'CR4 loved', 'loved');
      const fine = await bandIn(user, 3, 'CR4 fine', 'fine');

      const a = await db.session('device-a');
      const b = await db.session('device-b');
      await a.actAs(user);
      await b.actAs(user);

      // Device A drags the best film down among It was fine (onto fine[1], #5).
      await a.begin();
      await a.q(`select rank_reorder($1, 5, $2, 1, $3, 'fine')`, [loved[0], await newOp(db), fine[1]]);

      // Device B, drawn from the same list, drags fine[0] (#4) up onto loved[0] (#1).
      await b.begin();
      const moving = b.errorFrom(`select rank_reorder($1, 1, $2, 4, $3, 'loved')`, [
        fine[0],
        await newOp(db),
        loved[0],
      ]);
      const waiting = await b.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.categoryKey(user, 'movies'),
      });
      assert.equal(waiting.wait_event, 'advisory');

      await a.commit();
      const refusal = await moving;
      await b.rollback();

      assert.equal(refusal?.code, '55000', 'computed from a list that is gone, so refused');
      assert.deepEqual(await order(user), [loved[1], loved[2], fine[0], fine[1], loved[0], fine[2]]);
      assert.equal(await bucketOf(user, loved[0]), 'fine');
      assert.equal(await bucketOf(user, fine[0]), 'fine', "B's move did not land");
      assert.equal(await manualCount(user), 1);
      await valid(user);
      await agrees(user);

      await a.end();
      await b.end();
    });

    it('CR5: two devices moving the same title across categories serialise on its media lock', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const loved = await bandIn(user, 2, 'CR5 loved', 'loved');
      const nfm = await bandIn(user, 2, 'CR5 nfm', 'not_for_me');

      const a = await db.session('device-a');
      const b = await db.session('device-b');
      await a.actAs(user);
      await b.actAs(user);

      await a.begin();
      await a.q(`select rank_reorder($1, 4, $2, 1, $3, 'not_for_me')`, [loved[0], await newOp(db), nfm[1]]);

      // B saw the same title at #1 and sends it to the bottom of I liked it.
      await b.begin();
      const moving = b.errorFrom(`select rank_reorder($1, 2, $2, 1, $3, 'loved')`, [
        loved[0],
        await newOp(db),
        loved[1],
      ]);
      const waiting = await b.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, loved[0]),
      });
      assert.equal(waiting.wait_event, 'advisory');

      await a.commit();
      const refusal = await moving;
      await b.rollback();

      assert.equal(refusal?.code, '55000');
      assert.equal(await bucketOf(user, loved[0]), 'not_for_me');
      assert.deepEqual(await order(user), [loved[1], nfm[0], nfm[1], loved[0]]);
      await valid(user);
      await agrees(user);

      await a.end();
      await b.end();
    });

    it('CR6: a cross-category move rolled back leaves nothing, and the move waiting on it lands', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const loved = await bandIn(user, 3, 'CR6 loved', 'loved');
      const fine = await bandIn(user, 2, 'CR6 fine', 'fine');
      const before = await order(user);

      const a = await db.session('device-a');
      const b = await db.session('device-b');
      await a.actAs(user);
      await b.actAs(user);

      await a.begin();
      await a.q(`select rank_reorder($1, 4, $2, 2, $3, 'fine')`, [loved[1], await newOp(db), fine[0]]);

      await b.begin();
      const moving = fire(b, `rank_reorder($1, 1, $2, 5, $3, 'loved')`, [fine[1], await newOp(db), loved[0]]);
      await b.awaitBlocked({ on: 'advisory', advisoryKey: await db.categoryKey(user, 'movies') });

      await a.rollback();
      const landed = (await moving).rows[0].r;
      await b.commit();

      assert.equal(landed.moved, true);
      assert.equal(landed.bucket, 'loved');
      assert.deepEqual(await order(user), [fine[1], ...before.filter((id) => id !== fine[1])]);
      assert.equal(await bucketOf(user, loved[1]), 'loved', "A's rolled-back move left nothing");
      const placements = await ctx.db.rows(
        `select media_item_id from ranking_placements where user_id = $1 and kind = 'manual'`,
        [user],
      );
      assert.deepEqual(placements.map((p) => p.media_item_id), [fine[1]]);
      await valid(user);
      await agrees(user);

      await a.end();
      await b.end();
    });

    /** A wall: `n` explicit I loved it shows, and one show with a ranked season only. */
    const tvWall = async (user, n, label) => {
      const solo = await ctx.db.session('setup');
      await solo.actAs(user);
      const place = async (item) => {
        let step = (await solo.one(`select rank_start($1, 'loved') as r`, [item])).r;
        let guard = 0;
        while (!step.done) {
          step = (await solo.one(`select rank_answer($1, $2) as r`, [step.session_id, step.pivot])).r;
          guard += 1;
          if (guard > 32) throw new Error('did not converge');
        }
      };
      const shows = [];
      for (let i = 0; i < n; i += 1) {
        const show = await ctx.fx.createSeries(`${label} show ${i}`);
        await place(show);
        shows.push(show);
      }
      const avg = await ctx.fx.createSeries(`${label} avg`);
      const season = await ctx.fx.createSeason(avg, 1);
      await place(season);
      await solo.end();
      return { shows, avg, season };
    };

    const showOrder = async (user) =>
      (
        await ctx.db.rows(
          `select media_item_id from rankings where user_id = $1 and category = 'tv_shows' order by position`,
          [user],
        )
      ).map((r) => r.media_item_id);

    const tvValid = async (user) => {
      await ctx.db.sql(`select assert_ranking_valid($1, 'tv_shows')`, [user]);
      await ctx.db.sql(`select assert_ranking_valid($1, 'tv_seasons')`, [user]);
      await ctx.db.sql(`select assert_placements_valid($1)`, [user]);
      await ctx.db.sql(`select assert_watch_history_valid($1)`, [user]);
    };

    const ownWatches = async (user, item) =>
      Number(
        (
          await ctx.db.rows(
            `select count(*) as n from watch_events where user_id = $1 and media_item_id = $2`,
            [user, item],
          )
        )[0].n,
      );

    it('CR7: a promotion computed before another move committed waits on the category, then is refused', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const { shows, avg } = await tvWall(user, 3, 'CR7');

      const a = await db.session('device-a');
      const b = await db.session('device-b');
      await a.actAs(user);
      await b.actAs(user);

      // Device A moves show 2 to the top.
      await a.begin();
      await a.q(`select rank_reorder($1, 1, $2, 3, $3)`, [shows[2], await newOp(db), shows[0]]);

      // Device B drops the SN AVG poster onto show 1 (#2), from the wall before A's move.
      await b.begin();
      const promoting = b.errorFrom(`select rank_promote_show($1, 2, 'loved', $2, $3)`, [
        avg,
        await newOp(db),
        shows[1],
      ]);
      const waiting = await b.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.categoryKey(user, 'tv_shows'),
      });
      assert.equal(waiting.wait_event, 'advisory');

      await a.commit();
      const refusal = await promoting;
      await b.rollback();

      assert.equal(refusal?.code, '55000', 'show 0 is at #2 now, not show 1');
      assert.deepEqual(await showOrder(user), [shows[2], shows[0], shows[1]]);
      assert.equal(await ownWatches(user, avg), 0);
      await tvValid(user);

      await a.end();
      await b.end();
    });

    it('CR8: two devices promoting the same show serialise on its media lock, and one lands', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const { shows, avg } = await tvWall(user, 2, 'CR8');

      const a = await db.session('device-a');
      const b = await db.session('device-b');
      await a.actAs(user);
      await b.actAs(user);

      await a.begin();
      await a.q(`select rank_promote_show($1, 1, 'loved', $2, $3)`, [avg, await newOp(db), shows[0]]);

      await b.begin();
      const promoting = b.errorFrom(`select rank_promote_show($1, 3, 'loved', $2, null)`, [
        avg,
        await newOp(db),
      ]);
      await b.awaitBlocked({ on: 'advisory', advisoryKey: await db.mediaKey(user, avg) });

      await a.commit();
      const refusal = await promoting;
      await b.rollback();

      assert.equal(refusal?.code, '55000', 'already ranked by the time it ran');
      assert.deepEqual(await showOrder(user), [avg, shows[0], shows[1]]);
      const [{ n }] = await db.rows(`select count(*)::int as n from show_promotions where user_id = $1`, [user]);
      assert.equal(n, 1);
      assert.equal(await ownWatches(user, avg), 0);
      await tvValid(user);

      await a.end();
      await b.end();
    });

    it('CR9: an Undo racing a move of the promoted show waits on its media lock and is refused', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const { shows, avg } = await tvWall(user, 2, 'CR9');
      const setup = await db.session('setup');
      await setup.actAs(user);
      const promoted = (
        await setup.one(`select rank_promote_show($1, 1, 'loved', $2, $3) as r`, [avg, await newOp(db), shows[0]])
      ).r;
      await setup.end();

      const a = await db.session('device-a');
      const b = await db.session('device-b');
      await a.actAs(user);
      await b.actAs(user);

      await a.begin();
      await a.q(`select rank_reorder($1, 3, $2, 1, $3)`, [avg, await newOp(db), shows[1]]);

      await b.begin();
      const undoing = b.errorFrom(`select rank_unpromote_show($1, $2, $3, 1)`, [
        avg,
        promoted.placement_id,
        await newOp(db),
      ]);
      await b.awaitBlocked({ on: 'advisory', advisoryKey: await db.mediaKey(user, avg) });

      await a.commit();
      const refusal = await undoing;
      await b.rollback();

      assert.equal(refusal?.code, '55000', 'placed again since: the Undo would erase that move');
      assert.deepEqual(await showOrder(user), [shows[0], shows[1], avg]);
      await tvValid(user);

      await a.end();
      await b.end();
    });

    it('CR10: a promotion rolled back leaves nothing, and the promotion waiting on it lands', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const { shows, avg } = await tvWall(user, 2, 'CR10');

      const a = await db.session('device-a');
      const b = await db.session('device-b');
      await a.actAs(user);
      await b.actAs(user);

      await a.begin();
      await a.q(`select rank_promote_show($1, 1, 'loved', $2, $3)`, [avg, await newOp(db), shows[0]]);

      await b.begin();
      const promoting = fire(b, `rank_promote_show($1, 2, 'loved', $2, $3)`, [avg, await newOp(db), shows[1]]);
      await b.awaitBlocked({ on: 'advisory', advisoryKey: await db.mediaKey(user, avg) });

      await a.rollback();
      const landed = (await promoting).rows[0].r;
      await b.commit();

      assert.equal(landed.promoted, true);
      assert.equal(landed.position, 2);
      assert.deepEqual(await showOrder(user), [shows[0], avg, shows[1]]);
      const placements = await db.rows(
        `select position from ranking_placements where user_id = $1 and media_item_id = $2`,
        [user, avg],
      );
      assert.deepEqual(placements.map((p) => p.position), [2], "A's rolled-back promotion left no placement");
      const [{ n }] = await db.rows(`select count(*)::int as n from show_promotions where user_id = $1`, [user]);
      assert.equal(n, 1);
      assert.equal(await ownWatches(user, avg), 0, 'no watch at commit either');
      await tvValid(user);

      await a.end();
      await b.end();
    });

    it('CR11: two devices removing the last two seasons of a promoted show serialise, and W1 holds', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const { shows, avg, season } = await tvWall(user, 1, 'CR11');
      const setup = await db.session('setup');
      await setup.actAs(user);
      const second = await fx.createSeason(avg, 2);
      let step = (await setup.one(`select rank_start($1, 'loved') as r`, [second])).r;
      while (!step.done) step = (await setup.one(`select rank_answer($1, $2) as r`, [step.session_id, step.pivot])).r;
      await setup.q(`select rank_promote_show($1, 1, 'loved', $2, $3)`, [avg, await newOp(db), shows[0]]);
      // Unranked but still logged: their watches are the show's evidence.
      await setup.q(`select rank_unrank($1, $2)`, [season, await newOp(db)]);
      await setup.q(`select rank_unrank($1, $2)`, [second, await newOp(db)]);
      await setup.end();
      assert.equal(await ownWatches(user, avg), 0);

      const key = (
        await db.rows(`select hashtextextended('series-evidence:' || $1 || ':' || $2, 0)::text as k`, [user, avg])
      )[0].k;
      const a = await db.session('device-a');
      const b = await db.session('device-b');
      await a.actAs(user);
      await b.actAs(user);

      // A removes one season and holds the show's evidence key, as its own commit-time
      // check would; B removes the other and commits.
      await a.begin();
      await a.q(`select unlog($1, $2)`, [await newOp(db), season]);
      await a.q(`select pg_advisory_xact_lock($1::bigint)`, [key]);
      await b.begin();
      await b.q(`select unlog($1, $2)`, [await newOp(db), second]);
      const committing = b.start('commit');
      const waiting = await b.awaitBlocked({ on: 'advisory', advisoryKey: key });
      assert.equal(waiting.wait_event, 'advisory', "B's commit-time check waits for the show's key");

      await a.commit();
      await committing;

      const events = await db.rows(
        `select basis from watch_events where user_id = $1 and media_item_id = $2`,
        [user, avg],
      );
      assert.deepEqual(events.map((e) => e.basis), ['none'], 'the second to commit backfilled the show');
      await tvValid(user);

      await a.end();
      await b.end();
    });

    it('CR12: a promotion waiting behind its last season being unranked re-checks, and is refused', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const { shows, avg, season } = await tvWall(user, 1, 'CR12');

      const a = await db.session('device-a');
      const b = await db.session('device-b');
      await a.actAs(user);
      await b.actAs(user);

      await a.begin();
      await a.q(`select rank_unrank($1, $2)`, [season, await newOp(db)]);

      await b.begin();
      const promoting = b.errorFrom(`select rank_promote_show($1, 1, 'loved', $2, $3)`, [
        avg,
        await newOp(db),
        shows[0],
      ]);
      await b.awaitBlocked({ on: 'advisory', advisoryKey: await db.categoryKey(user, 'tv_seasons') });

      await a.commit();
      const refusal = await promoting;
      await b.rollback();

      assert.equal(refusal?.code, '55000', 'no ranked season by the time it ran');
      assert.deepEqual(await showOrder(user), [shows[0]]);
      const [{ n }] = await db.rows(
        `select count(*)::int as n from user_media where user_id = $1 and media_item_id = $2`,
        [user, avg],
      );
      assert.equal(n, 0);
      await tvValid(user);

      await a.end();
      await b.end();
    });
  });
}
