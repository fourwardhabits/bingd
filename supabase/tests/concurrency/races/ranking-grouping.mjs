import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * A backlog half hour is one post (20261126000100), under two connections.
 *
 * **RG1. Two devices ending two sittings at once leave one post.** With no group open, both
 * finalisers would otherwise find nothing to join and each publish. `ranking_story:<actor>`
 * is taken before anything is read, so the second waits, then finds the first's post open
 * and joins it.
 *
 * **RG2. The second finaliser waits on that lock, demonstrated**, rather than happening to
 * run second.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('ranking grouping races', () => {
    before(() => rc.open());
    after(() => rc.close());

    let base = 7_700_000;

    /** A ranked movie for `user`, written directly: these races are about the post. */
    const ranked = async (user) => {
      const [{ id }] = await ctx.db.rows(
        `with item as (
           insert into media_items (kind, tmdb_id, title, provenance)
           values ('movie', -($2::int), 'Ranking group race ' || $2::int, 'manual')
           returning id
         ), logged as (
           insert into user_media (user_id, media_item_id, bucket)
           select $1, id, 'loved' from item returning media_item_id
         ), placed as (
           insert into rankings (user_id, media_item_id, category, bucket, position)
           select $1, id, 'movies', 'loved',
                  coalesce((select max(position) from rankings
                             where user_id = $1 and category = 'movies'), 0) + 1
             from item returning media_item_id
         )
         select i.id from item i
          where exists (select 1 from logged) and exists (select 1 from placed)`,
        [user, (base += 1)],
      );
      return id;
    };

    /** A sitting with one noted title, drafted and not yet ended. */
    const drafted = async (session, user) => {
      const sitting = await newOp(ctx.db);
      await call(session, `rank_batch_note($1, $2, $3)`, [
        await newOp(ctx.db),
        sitting,
        await ranked(user),
      ]);
      return sitting;
    };

    const posts = (user) =>
      ctx.db.rows(
        `select id, type, payload from feed_events
          where actor_id = $1 and type in ('ranking_batch', 'ranking_batch_draft')
          order by causal_at, id`,
        [user],
      );

    const storyKey = async (user) =>
      (
        await ctx.db.rows(
          `select hashtextextended('ranking_story:' || $1::text, 0)::text as k`,
          [user],
        )
      )[0].k;

    it('RG1: two devices ending two sittings at once leave one post with both', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        const s1 = await drafted(t1, me);
        const s2 = await drafted(t2, me);

        const [r1, r2] = await Promise.all([
          call(t1, `rank_batch_finalize($1, $2)`, [await newOp(db), s1]),
          call(t2, `rank_batch_finalize($1, $2)`, [await newOp(db), s2]),
        ]);
        assert.deepEqual([r1.status, r2.status], ['ok', 'ok']);

        const rows = await posts(me);
        assert.equal(rows.length, 1, 'RG1: one post, not one per device');
        assert.equal(rows[0].type, 'ranking_batch');
        assert.equal(rows[0].payload.count, 2);
      } finally {
        await t1.end();
        await t2.end();
      }
    });

    it('RG2: the second finaliser waits on the actor key, then joins the first post', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const t1 = await db.session('first');
      const t2 = await db.session('second');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        const s1 = await drafted(t1, me);
        const s2 = await drafted(t2, me);

        await t1.begin();
        await call(t1, `rank_batch_finalize($1, $2)`, [await newOp(db), s1]);
        const p2 = fire(t2, `rank_batch_finalize($1, $2)`, [await newOp(db), s2]);
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await storyKey(me) });
        await t1.commit();

        const r2 = (await p2).rows[0].r;
        assert.equal(r2.status, 'ok');
        assert.equal(r2.joined, true, 'RG2: the second sitting joined the first post');
        const rows = await posts(me);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].payload.count, 2);
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });
  });
}
