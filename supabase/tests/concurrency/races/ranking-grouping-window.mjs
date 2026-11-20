import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * A half hour of first rankings is one post (20261130000200), under several connections.
 *
 * **RGW1. Two first rankings committing at once leave one group.** Each device's ranking
 * post is written and its grouping note run inside the same open transaction, watched
 * "Today" (the evidence 20261128000100 refused). The second note blocks on
 * `ranking_story:<actor>` until the first commits, then finds the first post marked and
 * groups with it: one group, both rankings shown through it, no duplicate post, and no
 * notification, watch event or placement written by grouping.
 *
 * **RGW2. Three devices noting at once leave one group of three**: one solo, one grouped,
 * one joined, in whichever order the lock hands them out.
 *
 * **RGW3. An Unranked sitting ending while a title-page note is uncommitted** waits for it,
 * then presents that ranking too: one post for the half hour.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('ranking grouping window races', () => {
    before(() => rc.open());
    after(() => rc.close());

    let base = 7_800_000;

    /** A first-time ranked movie with a "Today" watch, its ranking written directly. */
    const rankedToday = async (user) => {
      const [{ id }] = await ctx.db.rows(
        `with item as (
           insert into media_items (kind, tmdb_id, title, provenance)
           values ('movie', -($2::int), 'Window race ' || $2::int, 'manual')
           returning id
         ), logged as (
           insert into user_media (user_id, media_item_id, bucket)
           select $1, id, 'loved' from item returning media_item_id
         ), watched as (
           insert into watch_events (user_id, media_item_id, watched_on, basis)
           select $1, id, current_date, 'today_default' from item returning media_item_id
         ), placed as (
           insert into rankings (user_id, media_item_id, category, bucket, position)
           select $1, id, 'movies', 'loved',
                  coalesce((select max(position) from rankings
                             where user_id = $1 and category = 'movies'), 0) + 1
             from item returning media_item_id
         )
         select i.id from item i
          where exists (select 1 from logged) and exists (select 1 from watched)
            and exists (select 1 from placed)`,
        [user, (base += 1)],
      );
      return id;
    };

    const postSql = `insert into feed_events (actor_id, type, media_item_id, payload)
                     values ($1, 'title_ranked', $2, '{"bucket":"loved","category":"movies"}')`;

    const storyKey = async (user) =>
      (
        await ctx.db.rows(
          `select hashtextextended('ranking_story:' || $1::text, 0)::text as k`,
          [user],
        )
      )[0].k;

    const shape = async (user) =>
      (
        await ctx.db.rows(
          `select (select count(*)::int from feed_events where actor_id = $1 and type = 'ranking_batch') as groups,
                  (select count(*)::int from feed_events where actor_id = $1 and type = 'ranking_batch'
                      and presented_in is null) as visible_groups,
                  (select count(*)::int from feed_events where actor_id = $1 and type = 'title_ranked') as rankings,
                  (select count(*)::int from feed_events where actor_id = $1 and type = 'title_ranked'
                      and presented_in is null) as visible_rankings,
                  (select count(*)::int from notifications where recipient_id = $1 or actor_id = $1) as notes,
                  (select count(*)::int from watch_events where user_id = $1) as watches,
                  (select count(*)::int from ranking_placements where user_id = $1) as placements,
                  (select max((payload ->> 'count')::int) from feed_events
                    where actor_id = $1 and type = 'ranking_batch') as count`,
          [user],
        )
      )[0];

    /** A title logged "Today" and not yet ranked, for the real ranking path. */
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

    it('RGW1: two first rankings committing at once within one window leave one group, no duplicate post', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      // A movie and a season: two ladders, so the two rankings do not serialise on one
      // category's lock and really are in flight together. Each is the first in its band,
      // so rank_start places it outright and posts its title_ranked inside the transaction.
      const a = await loggedToday(me, await fx.createMovie('Window race film', (base += 1)));
      const show = await fx.createSeries('Window race show', (base += 1));
      const b = await loggedToday(me, await fx.createSeason(show, 1));
      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        await t1.begin();
        await t2.begin();
        assert.equal((await call(t1, `rank_start($1, 'loved')`, [a])).done, true);
        assert.equal((await call(t2, `rank_start($1, 'loved')`, [b])).done, true);
        const r1 = await call(t1, `rank_group_note($1, $2)`, [await newOp(db), a]);
        assert.equal(r1.status, 'solo');
        const p2 = fire(t2, `rank_group_note($1, $2)`, [await newOp(db), b]);
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await storyKey(me) });
        await t1.commit();
        const r2 = (await p2).rows[0].r;
        await t2.commit();
        assert.equal(
          r2.status,
          'grouped',
          'RGW1: the second waited, then grouped with the first',
        );

        const s = await shape(me);
        assert.equal(s.groups, 1, 'RGW1: one group, not one per device');
        assert.equal(s.visible_groups, 1);
        assert.equal(s.count, 2);
        assert.equal(s.rankings, 2, 'RGW1: no ranking post duplicated or lost');
        assert.equal(s.visible_rankings, 0, 'RGW1: both shown through the group');
        assert.equal(s.notes, 0, 'RGW1: nobody notified');
        assert.equal(s.placements, 2, 'RGW1: one placement per ranking, none from grouping');
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    it('RGW2: three devices noting at once leave one group of three', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const titles = [await rankedToday(me), await rankedToday(me), await rankedToday(me)];
      for (const id of titles) await db.rows(postSql, [me, id]);
      const sessions = [];
      try {
        for (const name of ['phone', 'tablet', 'web']) {
          const s = await db.session(name);
          await s.actAs(me);
          sessions.push(s);
        }
        const results = await Promise.all(
          sessions.map(async (s, i) =>
            call(s, `rank_group_note($1, $2)`, [await newOp(db), titles[i]]),
          ),
        );
        assert.deepEqual(
          results.map((r) => r.status).sort(),
          ['grouped', 'joined', 'solo'],
          'RGW2: serialised, whatever the order',
        );
        const s = await shape(me);
        assert.equal(s.groups, 1, 'RGW2: one group');
        assert.equal(s.count, 3);
        assert.equal(s.visible_rankings, 0);
        assert.equal(s.notes, 0);
      } finally {
        for (const s of sessions) await s.end().catch(() => {});
      }
    });

    it('RGW3: a sitting ending while a title-page note is uncommitted waits, then presents it', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const page = await rankedToday(me);
      await db.rows(postSql, [me, page]);
      const tp = await db.session('title-page');
      const ts = await db.session('unranked');
      try {
        await tp.actAs(me);
        await ts.actAs(me);
        const sitting = await newOp(db);
        await call(ts, `rank_batch_note($1, $2, $3)`, [
          await newOp(db),
          sitting,
          await rankedToday(me),
        ]);

        await tp.begin();
        const noted = await call(tp, `rank_group_note($1, $2)`, [await newOp(db), page]);
        assert.equal(noted.status, 'solo');
        const pf = fire(ts, `rank_batch_finalize($1, $2)`, [await newOp(db), sitting]);
        await ts.awaitBlocked({ on: 'advisory', advisoryKey: await storyKey(me) });
        await tp.commit();
        const ended = (await pf).rows[0].r;
        assert.equal(ended.status, 'ok');
        assert.equal(ended.count, 2, 'RGW3: the sitting presents the title-page ranking');

        const s = await shape(me);
        assert.equal(s.visible_groups, 1);
        assert.equal(s.visible_rankings, 0, 'RGW3: one post for the half hour');
        assert.equal(s.notes, 0);
      } finally {
        await tp.rollback().catch(() => {});
        await tp.end().catch(() => {});
        await ts.end().catch(() => {});
      }
    });
  });
}
