import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * An activity session is one post (20261130000900), under several connections.
 *
 * Every session writer (`rank_group_note`, `set_watchlist`'s `_post_watchlist_activity`,
 * `rank_batch_note`, `rank_batch_finalize`) takes the actor's two keys in one order,
 * `ranking_story` then `watchlist_story`, before it reads anything.
 *
 * **RS1. A ranking on one device and a save on another, at once, are one post.** The
 * ranking's note runs uncommitted (it marks the ranking `groupable`); the save must block on
 * `ranking_story:<actor>`, and once the note commits it pairs with the ranking: one visible
 * post holding both, nobody notified. Without the shared key the save would read no session
 * and no marked ranking, and start a second post.
 *
 * **RS2. Saves and a ranking from three devices into an open session.** All three commit
 * into the one post; its count and members agree, and it moved forward, never back.
 *
 * **RS3. A reaction in flight on the would-be peer is waited for and seen.** A friend's
 * reaction on a single first ranking is open; the save locks that ranking row, waits, and on
 * the reaction's commit finds it referenced and leaves it alone: two posts, the liked one
 * still its own card.
 *
 * **RS4. A sitting ending while a save lands.** The finaliser holds both keys; the save waits,
 * then joins the post the sitting published: one post.
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
                  (select count(*)::int from notifications where recipient_id = $1 or actor_id = $1) as notes,
                  (select max((payload ->> 'count')::int) from feed_events
                    where actor_id = $1 and presented_in is null
                      and type in ('ranking_batch', 'watchlist_added')) as count`,
          [user],
        )
      )[0];

    const save = `set_watchlist($1, $2, true)`;

    it('RS1: a ranking on one device and a save on another, at once, are one post', async () => {
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
        const r2 = (await p2).rows[0].r;
        assert.equal(r2.status, 'ok');

        const s = await shape(me);
        assert.equal(s.visible, 1, 'RS1: one post for the half hour');
        assert.equal(s.count, 2);
        assert.equal(s.notes, 0, 'nobody notified');
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    it('RS2: saves and a ranking from three devices into an open session are one post', async () => {
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
        assert.equal(results[2].status, 'joined');
        assert.equal(results[2].event_id, id);

        const s = await shape(me);
        assert.equal(s.visible, 1, 'RS2: one post');
        assert.equal(s.count, 4);
        const [{ members, type, causal_at: after }] = await db.rows(
          `select (select count(*)::int from _group_members($1)) as members, type, causal_at
             from feed_events where id = $1`,
          [id],
        );
        assert.equal(members, 4, 'the count matches the members');
        assert.equal(type, 'ranking_batch', 'a ranking made it a ranking group in place');
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
      const t0 = await db.session('setup');
      await t0.actAs(me);
      assert.equal((await call(t0, `rank_start($1, 'loved')`, [film])).done, true);
      assert.equal(
        (await call(t0, `rank_group_note($1, $2)`, [await newOp(db), film])).status,
        'solo',
      );
      await t0.end();
      const [{ id: ranking }] = await db.rows(
        `select id from feed_events where actor_id = $1 and type = 'title_ranked'`,
        [me],
      );

      const liker = await db.session('friend');
      const saver = await db.session('saver');
      try {
        await liker.actAs(friend);
        await saver.actAs(me);
        await liker.begin();
        await call(liker, `set_reaction($1, $2, 'love')`, [await newOp(db), ranking]);

        const p = fire(saver, save, [
          await newOp(db),
          await fx.createMovie('RS3 saved', (base += 1)),
        ]);
        // The reaction's key-share lock on the ranking's row: the save's `for update` waits.
        await saver.awaitBlocked({});
        await liker.commit();
        assert.equal((await p).rows[0].r.status, 'ok');

        const rows = await db.rows(
          `select id, type, presented_in from feed_events where actor_id = $1 order by causal_at`,
          [me],
        );
        assert.equal(rows.length, 2, 'RS3: two posts');
        assert.equal(
          rows.find((r) => r.id === ranking).presented_in,
          null,
          'the liked card stays',
        );
      } finally {
        await liker.rollback().catch(() => {});
        await liker.end().catch(() => {});
        await saver.end().catch(() => {});
      }
    });

    it('RS4: a sitting ending while a save lands leaves one post', async () => {
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
        assert.equal(s.visible, 1, 'RS4: the save joined the post the sitting published');
        assert.equal(s.count, 2);
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });
  });
}
