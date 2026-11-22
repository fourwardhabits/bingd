import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * Two posts per shared window (20261130001000), under several connections.
 *
 * Every session writer (`rank_group_note`, `set_watchlist`'s `_post_watchlist_activity`,
 * `rank_batch_note`, `rank_batch_finalize`) takes the actor's two keys in one order,
 * `ranking_story` then `watchlist_story`, before it reads anything. The keys now guard the
 * window's ANCHOR, which both kinds share: whichever writer decides second must see the
 * first one's window.
 *
 * **RS1. A ranking on one device and a save on another, at once, share one window.** The
 * ranking's note runs uncommitted (it marks the ranking and records its anchor); the save
 * must block on `ranking_story:<actor>`, and once the note commits it opens its watchlist
 * post on the ranking's window: two posts (one per kind), one anchor, nobody notified.
 * Without the shared key the save would read no window and anchor a second one on itself.
 *
 * **RS2. Saves and a ranking from three devices into an open window.** The saves commit into
 * the one watchlist post, the ranking stays its own card on the same window, and the
 * watchlist post moved forward, never back.
 *
 * **RS3. A reaction in flight on the would-be peer is waited for and seen.** A friend's
 * reaction on a single first ranking is open; a second ranking's note locks that row, waits,
 * and on the reaction's commit finds it referenced and leaves it alone: two cards, the liked
 * one still its own.
 *
 * **RS5. A save whose transaction began before a ranking committed.** The save's `now()` is
 * earlier than the window the ranking opened; it must still claim that window (whose start
 * moves back to it), never open a second one.
 *
 * **RS4. A sitting ending while a save lands.** The finaliser holds both keys; the save waits,
 * then opens its watchlist post on the window the sitting's post carries: two posts, one
 * anchor.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('activity session races', () => {
    before(() => rc.open());
    after(() => rc.close());

    let base = 8_300_000;

    const loggedToday = async (user, id) => {
      await ctx.db.rows(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [
        user,
        id,
      ]);
      await ctx.db.rows(
        `insert into watch_events (user_id, media_item_id, watched_on, basis)
         values ($1, $2, current_date, 'today_default')`,
        [user, id],
      );
      return id;
    };

    const key = async (name, user) =>
      (
        await ctx.db.rows(`select hashtextextended($1 || ':' || $2::text, 0)::text as k`, [
          name,
          user,
        ])
      )[0].k;

    const shape = async (user) =>
      (
        await ctx.db.rows(
          `select (select count(*)::int from feed_events where actor_id = $1 and presented_in is null
                      and type <> 'ranking_batch_draft') as visible,
                  (select array_agg(type order by type) from feed_events
                    where actor_id = $1 and presented_in is null
                      and type <> 'ranking_batch_draft') as types,
                  (select count(distinct payload ->> 'started_at')::int from feed_events
                    where actor_id = $1 and presented_in is null
                      and type <> 'ranking_batch_draft') as anchors,
                  (select count(*)::int from notifications where recipient_id = $1 or actor_id = $1) as notes,
                  (select (payload ->> 'count')::int from feed_events
                    where actor_id = $1 and presented_in is null and type = 'watchlist_added'
                    order by causal_at desc limit 1) as saves`,
          [user],
        )
      )[0];

    const save = `set_watchlist($1, $2, true)`;

    it('RS1: a ranking on one device and a save on another, at once, share one window', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const film = await loggedToday(me, await fx.createMovie('RS1 ranked', (base += 1)));
      const saved = await fx.createMovie('RS1 saved', (base += 1));
      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        await t1.begin();
        assert.equal((await call(t1, `rank_start($1, 'loved')`, [film])).done, true);
        const r1 = await call(t1, `rank_group_note($1, $2)`, [await newOp(db), film]);
        assert.equal(r1.status, 'solo');

        const p2 = fire(t2, save, [await newOp(db), saved]);
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await key('ranking_story', me) });
        await t1.commit();
        assert.equal((await p2).rows[0].r.status, 'ok');

        const s = await shape(me);
        assert.deepEqual(
          s.types,
          ['title_ranked', 'watchlist_added'],
          'RS1: one post per kind',
        );
        assert.equal(s.anchors, 1, 'RS1: one window');
        assert.equal(s.notes, 0, 'nobody notified');
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    it('RS2: saves and a ranking from three devices into an open window', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const t0 = await db.session('setup');
      await t0.actAs(me);
      await call(t0, save, [await newOp(db), await fx.createMovie('RS2 first', (base += 1))]);
      await t0.end();
      const [{ id, causal_at: before }] = await db.rows(
        `select id, causal_at from feed_events where actor_id = $1`,
        [me],
      );
      const show = await fx.createSeries('RS2 show', (base += 1));
      const season = await loggedToday(me, await fx.createSeason(show, 1));
      const [a, b] = [
        await fx.createMovie('RS2 a', (base += 1)),
        await fx.createMovie('RS2 b', (base += 1)),
      ];
      const sessions = [
        await db.session('one'),
        await db.session('two'),
        await db.session('three'),
      ];
      try {
        for (const s of sessions) await s.actAs(me);
        assert.equal((await call(sessions[2], `rank_start($1, 'loved')`, [season])).done, true);
        const results = await Promise.all([
          call(sessions[0], save, [await newOp(db), a]),
          call(sessions[1], save, [await newOp(db), b]),
          call(sessions[2], `rank_group_note($1, $2)`, [await newOp(db), season]),
        ]);
        assert.equal(results[2].status, 'solo', 'a ranking never joins the watchlist post');

        const s = await shape(me);
        assert.deepEqual(s.types, ['title_ranked', 'watchlist_added'], 'RS2: two posts');
        assert.equal(s.anchors, 1, 'one window');
        assert.equal(s.saves, 3);
        const [{ members, type, causal_at: after }] = await db.rows(
          `select (select count(*)::int from _group_members($1)) as members, type, causal_at
             from feed_events where id = $1`,
          [id],
        );
        assert.equal(members, 3, 'the count matches the members');
        assert.equal(type, 'watchlist_added', 'still a watchlist post');
        assert.ok(after >= before, 'it moved forward, never back');
      } finally {
        for (const s of sessions) await s.end().catch(() => {});
      }
    });

    it('RS3: a reaction in flight on the would-be peer is waited for, and the liked ranking keeps its card', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const friend = await fx.createUser();
      await db.rows(
        `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
        [friend, me],
      );
      const film = await loggedToday(me, await fx.createMovie('RS3 ranked', (base += 1)));
      // Another ladder, so it ranks without a comparison.
      const second = await loggedToday(
        me,
        await fx.createSeason(await fx.createSeries('RS3 show', (base += 1)), 1),
      );
      const t0 = await db.session('setup');
      await t0.actAs(me);
      assert.equal((await call(t0, `rank_start($1, 'loved')`, [film])).done, true);
      assert.equal(
        (await call(t0, `rank_group_note($1, $2)`, [await newOp(db), film])).status,
        'solo',
      );
      assert.equal((await call(t0, `rank_start($1, 'loved')`, [second])).done, true);
      await t0.end();
      const [{ id: ranking }] = await db.rows(
        `select id from feed_events where actor_id = $1 and type = 'title_ranked' and media_item_id = $2`,
        [me, film],
      );

      const liker = await db.session('friend');
      const noter = await db.session('noter');
      try {
        await liker.actAs(friend);
        await noter.actAs(me);
        await liker.begin();
        await call(liker, `set_reaction($1, $2, 'love')`, [await newOp(db), ranking]);

        const p = fire(noter, `rank_group_note($1, $2)`, [await newOp(db), second]);
        // The reaction's key-share lock on the peer's row: the note's `for update` waits.
        await noter.awaitBlocked({});
        await liker.commit();
        assert.equal((await p).rows[0].r.status, 'solo');

        const rows = await db.rows(
          `select id, presented_in from feed_events where actor_id = $1 order by causal_at`,
          [me],
        );
        assert.equal(rows.length, 2, 'RS3: two cards');
        assert.equal(
          rows.find((r) => r.id === ranking).presented_in,
          null,
          'the liked card stays',
        );
      } finally {
        await liker.rollback().catch(() => {});
        await liker.end().catch(() => {});
        await noter.end().catch(() => {});
      }
    });

    it('RS5: a save whose transaction began before a ranking committed shares that ranking’s window', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const film = await loggedToday(me, await fx.createMovie('RS5 ranked', (base += 1)));
      const saved = await fx.createMovie('RS5 saved', (base += 1));
      const early = await db.session('early-save');
      const ranker = await db.session('ranker');
      try {
        await early.actAs(me);
        await ranker.actAs(me);
        await early.begin();
        await early.q(`select pg_sleep(0.02)`);
        assert.equal((await call(ranker, `rank_start($1, 'loved')`, [film])).done, true);
        assert.equal(
          (await call(ranker, `rank_group_note($1, $2)`, [await newOp(db), film])).status,
          'solo',
        );
        await call(early, save, [await newOp(db), saved]);
        await early.commit();

        const s = await shape(me);
        assert.deepEqual(
          s.types,
          ['title_ranked', 'watchlist_added'],
          'RS5: one post per kind',
        );
        assert.equal(s.anchors, 1, 'RS5: one window, starting at the earlier save');
      } finally {
        await early.rollback().catch(() => {});
        await early.end().catch(() => {});
        await ranker.end().catch(() => {});
      }
    });

    it('RS4: a sitting ending while a save lands leaves two posts on one window', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const film = await loggedToday(me, await fx.createMovie('RS4 ranked', (base += 1)));
      const t1 = await db.session('backlog');
      const t2 = await db.session('saver');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        const sitting = await newOp(db);
        assert.equal((await call(t1, `rank_start($1, 'loved')`, [film])).done, true);
        await call(t1, `rank_batch_note($1, $2, $3)`, [await newOp(db), sitting, film]);

        await t1.begin();
        const done = await call(t1, `rank_batch_finalize($1, $2)`, [await newOp(db), sitting]);
        assert.equal(done.status, 'ok');
        const p2 = fire(t2, save, [
          await newOp(db),
          await fx.createMovie('RS4 saved', (base += 1)),
        ]);
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await key('ranking_story', me) });
        await t1.commit();
        assert.equal((await p2).rows[0].r.status, 'ok');

        const s = await shape(me);
        assert.deepEqual(
          s.types,
          ['ranking_batch', 'watchlist_added'],
          'RS4: one post per kind',
        );
        assert.equal(s.anchors, 1, 'on the sitting’s window');
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });
  });
}
