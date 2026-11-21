import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * A reviewed first ranking joins its half hour (20261130000800), under several connections.
 *
 * **RRG1. A reviewed and a plain first ranking committing at once leave one group.** Each
 * device writes its ranking post and runs its grouping note inside one open transaction;
 * one of them also publishes a review of its title first, as the log sheet does. The
 * second note waits on `ranking_story:<actor>`, then groups with the first: one post, both
 * shown through it, the review intact, nobody notified.
 *
 * **RRG2. A review being published while its title is grouped does not hold the grouping
 * up, and is not undone by it.** The review's transaction is open (it holds the
 * `user_media` row); the grouping note for that title runs and commits on another
 * connection without waiting, and when the review commits the title is still in its group.
 *
 * **RRG3. Rankings and review edits landing together.** With a group open, one device
 * notes a ranking whose review it is publishing in the same transaction, another notes a
 * plain one, and a third edits the review of a title already in the group, all at once:
 * one group of four, no other visible post.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('reviewed ranking grouping races', () => {
    before(() => rc.open());
    after(() => rc.close());

    let base = 7_900_000;

    /** A first-time ranked movie with a "Today" watch, its ranking written directly. */
    const rankedToday = async (user) => {
      const [{ id }] = await ctx.db.rows(
        `with item as (
           insert into media_items (kind, tmdb_id, title, provenance)
           values ('movie', -($2::int), 'Reviewed race ' || $2::int, 'manual')
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

    const reviewSql = (text) => `save_note($1, $2, '${text}', null, 'public', false)`;

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
          `select (select count(*)::int from feed_events where actor_id = $1 and type = 'ranking_batch'
                      and presented_in is null) as visible_groups,
                  (select count(*)::int from feed_events where actor_id = $1 and presented_in is null)
                    as visible_posts,
                  (select count(*)::int from feed_events where actor_id = $1 and type = 'title_ranked')
                    as rankings,
                  (select count(*)::int from notifications where recipient_id = $1 or actor_id = $1) as notes,
                  (select max((payload ->> 'count')::int) from feed_events
                    where actor_id = $1 and type = 'ranking_batch' and presented_in is null) as count`,
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

    const noteOf = async (user, id) =>
      (
        await ctx.db.rows(
          `select note from user_media where user_id = $1 and media_item_id = $2 and note_visibility = 'public'`,
          [user, id],
        )
      )[0]?.note ?? null;

    it('RRG1: a reviewed and a plain first ranking committing at once leave one group', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      // A movie and a season: two ladders, so the two rankings do not serialise on one
      // category's lock and really are in flight together (as RGW1). Each is the first in
      // its band, so rank_start places it outright and posts it inside the transaction.
      const reviewed = await loggedToday(
        me,
        await fx.createMovie('Reviewed race film', (base += 1)),
      );
      const show = await fx.createSeries('Reviewed race show', (base += 1));
      const plain = await loggedToday(me, await fx.createSeason(show, 1));
      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        await t1.begin();
        await t2.begin();
        // The log sheet's review, then the ranking, in one device's transaction.
        await call(t1, reviewSql('Reviewed as it ranked.'), [await newOp(db), reviewed]);
        assert.equal((await call(t1, `rank_start($1, 'loved')`, [reviewed])).done, true);
        assert.equal((await call(t2, `rank_start($1, 'loved')`, [plain])).done, true);
        const r1 = await call(t1, `rank_group_note($1, $2)`, [await newOp(db), reviewed]);
        assert.equal(
          r1.status,
          'solo',
          'RRG1: a reviewed ranking alone is marked, not refused',
        );
        const p2 = fire(t2, `rank_group_note($1, $2)`, [await newOp(db), plain]);
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await storyKey(me) });
        await t1.commit();
        const r2 = (await p2).rows[0].r;
        await t2.commit();
        assert.equal(
          r2.status,
          'grouped',
          'RRG1: the second waited, then grouped with the reviewed one',
        );

        const s = await shape(me);
        assert.equal(s.visible_groups, 1);
        assert.equal(s.visible_posts, 1, 'RRG1: one post, no separate card for the review');
        assert.equal(s.count, 2);
        assert.equal(s.rankings, 2, 'RRG1: no ranking post duplicated or lost');
        assert.equal(s.notes, 0, 'RRG1: nobody notified');
        assert.equal(await noteOf(me, reviewed), 'Reviewed as it ranked.');
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    it('RRG2: a review in flight on a title neither holds up its grouping nor is undone by it', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const first = await rankedToday(me);
      await db.rows(postSql, [me, first]);
      const second = await rankedToday(me);
      await db.rows(postSql, [me, second]);
      const owner = await db.session('owner');
      const tr = await db.session('review');
      try {
        await owner.actAs(me);
        await tr.actAs(me);
        assert.equal(
          (await call(owner, `rank_group_note($1, $2)`, [await newOp(db), first])).status,
          'solo',
        );
        await tr.begin();
        await call(tr, reviewSql('Still being written.'), [await newOp(db), second]);
        // The review's transaction holds the user_media row. Grouping reads no review now,
        // so it neither waits for this one nor sees it.
        const grouped = await call(owner, `rank_group_note($1, $2)`, [await newOp(db), second]);
        assert.equal(grouped.status, 'grouped', 'RRG2: grouped without waiting for the review');
        await tr.commit();

        const s = await shape(me);
        assert.equal(s.visible_posts, 1, 'RRG2: still one post once the review commits');
        assert.equal(s.count, 2);
        const [{ presented }] = await db.rows(
          `select presented_in as presented from feed_events
            where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
          [me, second],
        );
        assert.equal(presented, grouped.event_id);
        assert.equal(await noteOf(me, second), 'Still being written.');
      } finally {
        await tr.rollback().catch(() => {});
        await tr.end().catch(() => {});
        await owner.end().catch(() => {});
      }
    });

    it('RRG3: a reviewed ranking, a plain one and a review edit landing at once leave one group of four', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const a = await rankedToday(me);
      const b = await rankedToday(me);
      await db.rows(postSql, [me, a]);
      await db.rows(postSql, [me, b]);
      const owner = await db.session('owner');
      await owner.actAs(me);
      await call(owner, reviewSql('First words.'), [await newOp(db), a]);
      await call(owner, `rank_group_note($1, $2)`, [await newOp(db), a]);
      assert.equal(
        (await call(owner, `rank_group_note($1, $2)`, [await newOp(db), b])).status,
        'grouped',
      );
      await owner.end();
      const c = await rankedToday(me);
      const d = await rankedToday(me);
      await db.rows(postSql, [me, c]);
      await db.rows(postSql, [me, d]);

      const sessions = [];
      try {
        for (const name of ['phone', 'tablet', 'web']) {
          const s = await db.session(name);
          await s.actAs(me);
          await s.begin();
          sessions.push(s);
        }
        const [s1, s2, s3] = sessions;
        await call(s1, reviewSql('Reviewed on the phone.'), [await newOp(db), c]);
        const results = await Promise.all([
          call(s1, `rank_group_note($1, $2)`, [await newOp(db), c]).then(async (r) => {
            await s1.commit();
            return r;
          }),
          call(s2, `rank_group_note($1, $2)`, [await newOp(db), d]).then(async (r) => {
            await s2.commit();
            return r;
          }),
          call(s3, reviewSql('Second thoughts.'), [await newOp(db), a]).then(async (r) => {
            await s3.commit();
            return r;
          }),
        ]);
        assert.deepEqual(
          [results[0].status, results[1].status],
          ['joined', 'joined'],
          'RRG3: both rankings joined the open group',
        );
        const s = await shape(me);
        assert.equal(s.visible_posts, 1, 'RRG3: one post');
        assert.equal(s.count, 4);
        assert.equal(s.notes, 0);
        assert.equal(await noteOf(me, a), 'Second thoughts.');
        assert.equal(await noteOf(me, c), 'Reviewed on the phone.');
      } finally {
        for (const s of sessions) {
          await s.rollback().catch(() => {});
          await s.end().catch(() => {});
        }
      }
    });
  });
}
