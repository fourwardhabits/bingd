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
 *
 * **RG3. A comment being written on a draft is never lost to a join** (Codex, PR 311). The
 * finaliser locks the draft row, so it waits for the uncommitted comment, sees it, and
 * publishes the draft on its own rather than deleting it into the open group.
 *
 * **RG4. A placement note racing the join is never orphaned** (Codex, PR 311). The note takes
 * the same actor key, so it waits for the finaliser, then finds the join and adds its title
 * to the group rather than drafting an invisible post nothing would ever finalise.
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

    it('RG1: two devices ending two sittings at once both join the open post', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        // The open group both sittings began inside, so the outcome does not depend on
        // which device ends first (a sitting that began before a group never joins it).
        const s0 = await drafted(t1, me);
        await call(t1, `rank_batch_finalize($1, $2)`, [await newOp(db), s0]);
        const s1 = await drafted(t1, me);
        const s2 = await drafted(t2, me);

        const [r1, r2] = await Promise.all([
          call(t1, `rank_batch_finalize($1, $2)`, [await newOp(db), s1]),
          call(t2, `rank_batch_finalize($1, $2)`, [await newOp(db), s2]),
        ]);
        assert.deepEqual([r1.status, r2.status], ['ok', 'ok']);

        assert.deepEqual([r1.joined, r2.joined], [true, true]);

        const rows = await posts(me);
        assert.equal(rows.length, 1, 'RG1: one post, not one per device');
        assert.equal(rows[0].type, 'ranking_batch');
        assert.equal(rows[0].payload.count, 3);
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

    it('RG4: a placement note racing the join waits for it, then lands in the group (Codex, PR 311)', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const t1 = await db.session('finaliser');
      const t2 = await db.session('late-note');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        const s0 = await drafted(t1, me);
        await call(t1, `rank_batch_finalize($1, $2)`, [await newOp(db), s0]);
        const s1 = await drafted(t1, me);
        const late = await ranked(me);

        await t1.begin();
        const ended = await call(t1, `rank_batch_finalize($1, $2)`, [await newOp(db), s1]);
        assert.equal(ended.joined, true);
        const p2 = fire(t2, `rank_batch_note($1, $2, $3)`, [await newOp(db), s1, late]);
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await storyKey(me) });
        await t1.commit();

        const r2 = (await p2).rows[0].r;
        assert.equal(r2.status, 'ok');
        assert.equal(
          r2.joined,
          true,
          'RG4: the late title followed its sitting into the group',
        );
        const rows = await posts(me);
        assert.equal(rows.length, 1, 'RG4: no orphaned draft');
        assert.equal(rows[0].type, 'ranking_batch');
        assert.equal(rows[0].payload.count, 3);
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    it('RG5: two devices grouping two backfill rankings at once leave one group (20261128000100)', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      // Two first-time rankings with undated (historical) watches and their own posts.
      const titles = [await ranked(me), await ranked(me)];
      for (const id of titles) {
        await db.rows(
          `insert into watch_events (user_id, media_item_id, watched_on, basis) values ($1, $2, null, 'none')`,
          [me, id],
        );
        await db.rows(
          `insert into feed_events (actor_id, type, media_item_id, payload)
           values ($1, 'title_ranked', $2, '{"bucket":"loved","category":"movies"}')`,
          [me, id],
        );
      }
      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');
      try {
        await t1.actAs(me);
        await t2.actAs(me);
        const [r1, r2] = await Promise.all([
          call(t1, `rank_group_note($1, $2)`, [await newOp(db), titles[0]]),
          call(t2, `rank_group_note($1, $2)`, [await newOp(db), titles[1]]),
        ]);
        assert.deepEqual([r1.status, r2.status].sort(), ['grouped', 'solo']);
        const groups = await ctx.db.rows(
          `select id, payload from feed_events where actor_id = $1 and type = 'ranking_batch'`,
          [me],
        );
        assert.equal(groups.length, 1, 'RG5: one group, not one per device');
        assert.equal(groups[0].payload.count, 2);
        const [{ n }] = await ctx.db.rows(
          `select count(*)::int as n from feed_events where actor_id = $1 and presented_in = $2`,
          [me, groups[0].id],
        );
        assert.equal(n, 2, 'RG5: both rankings are shown through it');
      } finally {
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    it('RG6: two readers reacting at once to a hidden ranking both land, and its card comes back (Codex, PR 313)', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const titles = [await ranked(me), await ranked(me), await ranked(me)];
      for (const id of titles) {
        await db.rows(
          `insert into watch_events (user_id, media_item_id, watched_on, basis) values ($1, $2, null, 'none')`,
          [me, id],
        );
        await db.rows(
          `insert into feed_events (actor_id, type, media_item_id, payload)
           values ($1, 'title_ranked', $2, '{"bucket":"loved","category":"movies"}')`,
          [me, id],
        );
      }
      const owner = await db.session('owner');
      await owner.actAs(me);
      for (const id of titles)
        await call(owner, `rank_group_note($1, $2)`, [await newOp(db), id]);
      await owner.end();
      const [{ id: hidden }] = await ctx.db.rows(
        `select id from feed_events where actor_id = $1 and type = 'title_ranked' and presented_in is not null
          order by created_at limit 1`,
        [me],
      );

      const a = await fx.createUser();
      const b = await fx.createUser();
      const ta = await db.session('reader-a');
      const tb = await db.session('reader-b');
      try {
        await ta.actAs(a);
        await tb.actAs(b);
        await ta.begin();
        await tb.begin();
        await call(ta, `set_reaction($1, $2, 'love')`, [await newOp(db), hidden]);
        const pb = fire(tb, `set_reaction($1, $2, 'love')`, [await newOp(db), hidden]);
        await ta.commit();
        await pb;
        await tb.commit();
        const [{ n, shown }] = await ctx.db.rows(
          `select (select count(*)::int from reactions where feed_event_id = $1) n,
                  (select presented_in is null from feed_events where id = $1) shown`,
          [hidden],
        );
        assert.equal(n, 2, 'RG6: both reactions land; nobody is aborted by a deadlock');
        assert.equal(shown, true, 'RG6: the reacted-to ranking has its own card again');
      } finally {
        await ta.rollback().catch(() => {});
        await tb.rollback().catch(() => {});
        await ta.end().catch(() => {});
        await tb.end().catch(() => {});
      }
    });

    /** A backfill group of `n` hidden rankings for a fresh actor, through `rank_group_note`. */
    const backfillGroup = async (n) => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      for (let i = 0; i < n; i += 1) {
        const id = await ranked(me);
        await db.rows(
          `insert into watch_events (user_id, media_item_id, watched_on, basis) values ($1, $2, null, 'none')`,
          [me, id],
        );
        await db.rows(
          `insert into feed_events (actor_id, type, media_item_id, payload)
           values ($1, 'title_ranked', $2, '{"bucket":"loved","category":"movies"}')`,
          [me, id],
        );
        const owner = await db.session(`owner-${i}`);
        await owner.actAs(me);
        await call(owner, `rank_group_note($1, $2)`, [await newOp(db), id]);
        await owner.end();
      }
      const [group] = await db.rows(
        `select id from feed_events where actor_id = $1 and type = 'ranking_batch'`,
        [me],
      );
      // One ranking is a marked single, not yet a group.
      if (!group) return { me, group: null, members: [], groupKey: null };
      const members = (
        await db.rows(
          `select id from feed_events where presented_in = $1 order by created_at, id`,
          [group.id],
        )
      ).map((row) => row.id);
      const groupKey = (
        await db.rows(`select hashtextextended('feed_group:' || $1::text, 0)::text as k`, [
          group.id,
        ])
      )[0].k;
      return { me, group: group.id, members, groupKey };
    };

    it('RG7: a conversation being written on a group is never hidden by a member leaving (Codex, PR 313)', async () => {
      const { db, fx } = ctx;
      const { group, members, groupKey } = await backfillGroup(2);
      const talker = await fx.createUser();
      const reactor = await fx.createUser();
      const t1 = await db.session('talker');
      const t2 = await db.session('reactor');
      try {
        await t1.actAs(talker);
        await t2.actAs(reactor);
        await t1.begin();
        await call(t1, `add_comment($1, $2, 'love this set', false)`, [await newOp(db), group]);
        const p2 = fire(t2, `set_reaction($1, $2, 'love')`, [await newOp(db), members[0]]);
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: groupKey });
        await t1.commit();
        await p2;
        const [{ hidden, comments }] = await db.rows(
          `select (select presented_in from feed_events where id = $1) as hidden,
                  (select count(*)::int from comments where feed_event_id = $1) as comments`,
          [group],
        );
        assert.equal(comments, 1);
        assert.equal(hidden, null, 'RG7: the group with a conversation stays visible');
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });

    it('RG8: two readers on two members of one group are serialised, not deadlocked (Codex, PR 313)', async () => {
      const { db, fx } = ctx;
      const { members, groupKey } = await backfillGroup(2);
      const a = await fx.createUser();
      const b = await fx.createUser();
      const ta = await db.session('reader-a');
      const tb = await db.session('reader-b');
      try {
        await ta.actAs(a);
        await tb.actAs(b);
        await ta.begin();
        await call(ta, `set_reaction($1, $2, 'love')`, [await newOp(db), members[0]]);
        const pb = fire(tb, `set_reaction($1, $2, 'love')`, [await newOp(db), members[1]]);
        await tb.awaitBlocked({ on: 'advisory', advisoryKey: groupKey });
        await ta.commit();
        await pb;
        const rows = await db.rows(
          `select fe.id, fe.presented_in, (select count(*)::int from reactions r where r.feed_event_id = fe.id) n
             from feed_events fe where fe.id = any ($1::uuid[])`,
          [members],
        );
        assert.ok(
          rows.every((row) => row.n === 1),
          'RG8: both reactions land',
        );
        assert.ok(
          rows.every((row) => row.presented_in === null),
          'RG8: both cards are back',
        );
      } finally {
        await ta.rollback().catch(() => {});
        await ta.end().catch(() => {});
        await tb.end().catch(() => {});
      }
    });

    it('RG9: a review published while a grouping is in flight still gets its card back (Codex, PR 313)', async () => {
      const { db } = ctx;
      // One backfill ranking already marked, a second about to pair with it.
      const { me } = await backfillGroup(1);
      const second = await ranked(me);
      await db.rows(
        `insert into watch_events (user_id, media_item_id, watched_on, basis) values ($1, $2, null, 'none')`,
        [me, second],
      );
      await db.rows(
        `insert into feed_events (actor_id, type, media_item_id, payload)
         values ($1, 'title_ranked', $2, '{"bucket":"loved","category":"movies"}')`,
        [me, second],
      );
      await db.rows(
        `insert into user_media (user_id, media_item_id) values ($1, $2) on conflict do nothing`,
        [me, second],
      );
      const storyKey = (
        await db.rows(`select hashtextextended('ranking_story:' || $1::text, 0)::text as k`, [
          me,
        ])
      )[0].k;
      const tg = await db.session('grouping');
      const tr = await db.session('review');
      try {
        await tg.actAs(me);
        await tr.actAs(me);
        await tg.begin();
        const grouped = await call(tg, `rank_group_note($1, $2)`, [await newOp(db), second]);
        assert.equal(grouped.status, 'grouped');
        const pr = fire(
          tr,
          `save_note($1, $2, 'Written while it grouped.', null, 'public', false)`,
          [await newOp(db), second],
        );
        await tr.awaitBlocked({ on: 'advisory', advisoryKey: storyKey });
        await tg.commit();
        await pr;
        const [{ presented }] = await db.rows(
          `select presented_in as presented from feed_events
            where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
          [me, second],
        );
        assert.equal(presented, null, 'RG9: the reviewed ranking is not left hidden');
      } finally {
        await tg.rollback().catch(() => {});
        await tg.end().catch(() => {});
        await tr.end().catch(() => {});
      }
    });

    it('RG3: a comment written on a draft as it ends is kept: the draft publishes on its own', async () => {
      const { db, fx } = ctx;
      const me = await fx.createUser();
      const friend = await fx.createUser();
      const t1 = await db.session('commenter');
      const t2 = await db.session('finaliser');
      try {
        await t2.actAs(me);
        const s0 = await drafted(t2, me);
        await call(t2, `rank_batch_finalize($1, $2)`, [await newOp(db), s0]);
        const sitting = await newOp(db);
        const noted = await call(t2, `rank_batch_note($1, $2, $3)`, [
          await newOp(db),
          sitting,
          await ranked(me),
        ]);

        await t1.actAs(friend);
        await t1.begin();
        await call(t1, `add_comment($1, $2, 'mid-sitting', false)`, [
          await newOp(db),
          noted.event_id,
        ]);

        const p2 = fire(t2, `rank_batch_finalize($1, $2)`, [await newOp(db), sitting]);
        await t2.awaitBlocked({ on: 'transactionid' });
        await t1.commit();
        const r2 = (await p2).rows[0].r;

        assert.equal(r2.status, 'ok');
        assert.notEqual(r2.joined, true, 'RG3: a draft with a conversation is not merged away');
        const [{ n }] = await db.rows(
          `select count(*)::int as n from comments where feed_event_id = $1`,
          [noted.event_id],
        );
        assert.equal(n, 1, 'and its comment survives');
        const [{ type }] = await db.rows(`select type from feed_events where id = $1`, [
          noted.event_id,
        ]);
        assert.equal(type, 'ranking_batch');
      } finally {
        await t1.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }
    });
  });
}
