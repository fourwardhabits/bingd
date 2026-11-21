import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * A watchlist session is one post (20261125000100), under two connections.
 *
 * **WG1. Two devices saving different titles at once leave one post with both.** The
 * writer takes `watchlist_story:<actor>` before it reads anything, because `for update`
 * cannot lock a group that does not exist yet: without the lock both transactions would
 * find no open group and each insert one.
 *
 * **WG2. The second device waits on that lock, demonstrated.** The first save is paused
 * uncommitted; the second must block on the advisory key (since 20261130000900 the first of
 * the actor's two session keys, `ranking_story`), and after the first commits it
 * joins the first's post rather than starting another.
 *
 * **WG3. Two devices saving the same title at once announce it once.** The second reads
 * membership after the lock, finds the title, and adds nothing; both calls succeed.
 *
 * **WG4. A catalogue delete of a group's first title waits for a save joining it** (Codex,
 * PR 310). The save holds the actor key uncommitted; the delete's trigger must block on that
 * key, then see the new member, keep the post with it as representative, and not let the
 * cascade take the post and its conversation.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('watchlist grouping races', () => {
    before(() => rc.open());
    after(() => rc.close());

    const save = `set_watchlist($1, $2, true)`;

    const posts = (actor) =>
      ctx.db.rows(
        `select e.id, e.payload,
                (select count(*) from feed_watchlist_titles wt where wt.event_id = e.id)::int as members
           from feed_events e
          where e.actor_id = $1 and e.type = 'watchlist_added'
          order by e.causal_at, e.id`,
        [actor],
      );

    /**
     * Recomputed, as `follow-activity.mjs` does, and kept as a string for 64-bit fidelity.
     *
     * The first of the actor's two session keys (20261130000900): every session writer, the
     * save and the catalogue trigger included, takes `ranking_story:<actor>` and then
     * `watchlist_story:<actor>`, so a second writer waits on the first key.
     */
    const storyKey = async (actor) =>
      (
        await ctx.db.rows(
          `select hashtextextended('ranking_story:' || $1::text, 0)::text as k`,
          [actor],
        )
      )[0].k;

    it('WG1: two devices saving different titles at once leave one post with both', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const [a, b] = [await fx.createMovie('WG1 A'), await fx.createMovie('WG1 B')];
      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        const [r1, r2] = await Promise.all([
          call(t1, save, [await newOp(db), a]),
          call(t2, save, [await newOp(db), b]),
        ]);
        assert.deepEqual([r1.status, r2.status], ['ok', 'ok']);

        const rows = await posts(me);
        assert.equal(rows.length, 1, 'WG1: one post, not one per device');
        assert.equal(rows[0].members, 2);
        assert.equal(rows[0].payload.count, 2, 'the count matches the members');
      } finally {
        await t1.end();
        await t2.end();
      }
    });

    it('WG2: the second save waits on the actor key, then joins the first post', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const [a, b] = [await fx.createMovie('WG2 A'), await fx.createMovie('WG2 B')];
      const t1 = await db.session('first');
      const t2 = await db.session('second');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        await t1.begin();
        await call(t1, save, [await newOp(db), a]);

        const p2 = fire(t2, save, [await newOp(db), b]);
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await storyKey(me) });

        await t1.commit();
        const r2 = (await p2).rows[0].r;
        assert.equal(r2.status, 'ok');

        const rows = await posts(me);
        assert.equal(rows.length, 1, 'WG2: the second device joined the first post');
        assert.equal(rows[0].members, 2);
        assert.equal(rows[0].payload.count, 2);
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    it('WG4: deleting a one-title group’s representative waits for a save joining it, and keeps the post', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const friend = await fx.createUser();
      const [a, b] = [await fx.createMovie('WG4 A'), await fx.createMovie('WG4 B')];
      const t1 = await db.session('saver');
      const t2 = await db.session('operator');
      try {
        await t1.actAs(me);
        await call(t1, save, [await newOp(db), a]);
        const [post] = await posts(me);
        // The conversation that must survive.
        await t1.actAs(friend);
        await call(t1, `add_comment($1, $2, 'keep this', false)`, [await newOp(db), post.id]);
        await t1.actAs(me);

        await t1.begin();
        await call(t1, save, [await newOp(db), b]);

        const p2 = t2.start(`delete from media_items where id = $1`, [a]);
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await storyKey(me) });
        await t1.commit();
        await p2;

        const rows = await posts(me);
        assert.equal(rows.length, 1, 'WG4: the post survived');
        assert.equal(rows[0].id, post.id);
        assert.equal(rows[0].members, 1);
        assert.equal(rows[0].payload.count, 1);
        const [{ rep }] = await db.rows(
          `select media_item_id as rep from feed_events where id = $1`,
          [post.id],
        );
        assert.equal(rep, b, 'the surviving member is now the representative');
        const [{ n }] = await db.rows(
          `select count(*)::int as n from comments where feed_event_id = $1`,
          [post.id],
        );
        assert.equal(n, 1, 'and its conversation is intact');
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    it('WG3: two devices saving the same title at once announce it once', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const a = await fx.createMovie('WG3 A');
      const t1 = await db.session('one');
      const t2 = await db.session('two');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        const [r1, r2] = await Promise.all([
          call(t1, save, [await newOp(db), a]),
          call(t2, save, [await newOp(db), a]),
        ]);
        assert.deepEqual([r1.status, r2.status], ['ok', 'ok']);

        const rows = await posts(me);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].members, 1, 'WG3: announced once');
        assert.equal(rows[0].payload.count, 1);
        const [{ n }] = await db.rows(
          `select count(*)::int as n from watchlist where user_id = $1 and media_item_id = $2`,
          [me, a],
        );
        assert.equal(n, 1);
      } finally {
        await t1.end();
        await t2.end();
      }
    });
  });
}
