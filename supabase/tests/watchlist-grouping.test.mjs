import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb, createTestDbBefore } from './harness.mjs';

/**
 * **A watchlist session is one post** (Feed Activity Grouping, 20261125000100).
 *
 * Saves inside one fixed 30-minute window join the actor's first post of that window;
 * each title is announced once, ever; the post keeps its id, its conversation and its place
 * in the Feed. Concurrency across two devices is in `concurrency/races/watchlist-grouping.mjs`
 * against real PostgreSQL. Single-title mode (the rollback) is `watchlist-activity.test.mjs`.
 */
const MIGRATION = '20261125000100_a_watchlist_session_is_one_post.sql';

describe('a watchlist session is one post', () => {
  let t;
  let follower;
  let stranger;
  let tmdb = 95000;

  before(async () => {
    t = await createTestDb();
    follower = await t.createUser({ username: 'wg_follower' });
    stranger = await t.createUser({ username: 'wg_stranger' });
  });

  after(async () => t.close());

  const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
  const film = async (title) => t.createMovie(title, (tmdb += 1));

  /** A fresh actor per case, so no window opened by one case is joined by another. */
  let n = 0;
  const actor = async (options = {}) => {
    n += 1;
    const id = await t.createUser({ username: `wg_actor_${n}`, ...options });
    await t.actAs(id);
    return id;
  };

  const call = async (sql, params) => {
    const { rows } = await t.sql(`select ${sql} as result`, params);
    return rows[0].result;
  };
  const add = async (mediaItemId, operationId) =>
    call(`set_watchlist($1, $2, true)`, [operationId ?? (await uuid()), mediaItemId]);
  const remove = async (mediaItemId) =>
    call(`set_watchlist($1, $2, false)`, [await uuid(), mediaItemId]);

  const posts = async (actorId) =>
    (
      await t.sql(
        `select id, media_item_id, payload, causal_at, created_at
           from feed_events
          where actor_id = $1 and type = 'watchlist_added'
          order by causal_at, id`,
        [actorId],
      )
    ).rows;
  const members = async (eventId) =>
    (
      await t.sql(
        `select media_item_id from feed_watchlist_titles where event_id = $1 order by id`,
        [eventId],
      )
    ).rows.map((row) => row.media_item_id);

  /** Moves a group's start back, as the clock would. */
  const age = (eventId, minutes) =>
    t.sql(
      `update feed_events
          set causal_at = causal_at - make_interval(mins => $2),
              created_at = created_at - make_interval(mins => $2)
        where id = $1`,
      [eventId, minutes],
    );

  const readMembers = (viewer, eventId) =>
    t.asUser(viewer, async () => {
      await t.actAs(viewer);
      const { rows } = await t.sql(`select * from watchlist_group_titles($1)`, [eventId]);
      return rows;
    });

  describe('grouping', () => {
    it('one saved title is one ordinary post with a count of one', async () => {
      const me = await actor();
      const dune = await film('Dune');
      await add(dune);

      const [post] = await posts(me);
      assert.equal((await posts(me)).length, 1);
      assert.equal(post.media_item_id, dune, 'the representative is the title saved');
      assert.equal(post.payload.count, 1);
      assert.deepEqual(await members(post.id), [dune]);
    });

    it('titles saved inside the window join that same post, in order, without moving it', async () => {
      const me = await actor();
      const [a, b, c] = [await film('Arrival'), await film('Sicario'), await film('Enemy')];
      await add(a);
      const [first] = await posts(me);
      await age(first.id, 10);
      const [before10] = await posts(me);

      await add(b);
      await add(c);

      const after = await posts(me);
      assert.equal(after.length, 1, 'still one post');
      assert.equal(after[0].id, first.id, 'the same event id');
      assert.equal(after[0].media_item_id, a, 'the representative is still the first title');
      assert.equal(
        after[0].causal_at.getTime(),
        before10.causal_at.getTime(),
        'causal_at is never bumped, so the post keeps its place in the Feed',
      );
      assert.equal(after[0].payload.count, 3);
      assert.deepEqual(await members(first.id), [a, b, c]);
    });

    it('a save after the window has closed starts a second post; the first is untouched', async () => {
      const me = await actor();
      const [a, b] = [await film('Heat'), await film('Ronin')];
      await add(a);
      const [first] = await posts(me);
      await age(first.id, 31);

      await add(b);

      const all = await posts(me);
      assert.equal(all.length, 2);
      assert.equal(all[0].id, first.id);
      assert.equal(all[0].payload.count, 1);
      assert.equal(all[1].media_item_id, b);
      assert.equal(all[1].payload.count, 1);
    });

    it('the window is fixed from the first save, not sliding: steady saving still splits at 30 minutes', async () => {
      const me = await actor();
      const [a, b, c] = [await film('Alien'), await film('Aliens'), await film('Prometheus')];
      await add(a);
      const [first] = await posts(me);
      await age(first.id, 20);
      await add(b); // 20 minutes in: joins
      await age(first.id, 15); // 35 minutes after the first save, 15 after the last
      await add(c);

      const all = await posts(me);
      assert.equal(all.length, 2, 'no inactivity timer keeps the first window open');
      assert.deepEqual(await members(all[0].id), [a, b]);
      assert.deepEqual(await members(all[1].id), [c]);
    });

    it('never joins a ranking post, even one that looks like a group and is open', async () => {
      const me = await actor();
      const ranked = await film('Past Lives');
      // A ranking_batch row carrying a count, written directly: the writer must not take it
      // for a watchlist group, whatever its payload says.
      await t.sql(
        `insert into feed_events (actor_id, type, media_item_id, payload)
         values ($1, 'ranking_batch', $2, '{"count": 3, "sitting": "s"}'::jsonb)`,
        [me, ranked],
      );
      const saved = await film('Aftersun');
      await add(saved);

      const { rows: batch } = await t.sql(
        `select payload from feed_events where actor_id = $1 and type = 'ranking_batch'`,
        [me],
      );
      assert.equal(batch[0].payload.count, 3, 'the ranking post is unchanged');
      assert.equal((await posts(me)).length, 1);
      assert.equal((await posts(me))[0].media_item_id, saved);
    });

    it('accepts a whole series as a member like a film', async () => {
      const me = await actor();
      const show = await t.createSeries('Severance', (tmdb += 1));
      const movie = await film('Her');
      await add(movie);
      await add(show);
      const [post] = await posts(me);
      assert.deepEqual(await members(post.id), [movie, show]);
    });
  });

  describe('no duplicate activity', () => {
    it('a retry of the same operation is absorbed', async () => {
      const me = await actor();
      const a = await film('Tár');
      const operation = await uuid();
      assert.equal((await add(a, operation)).status, 'ok');
      assert.equal((await add(a, operation)).status, 'already_applied');
      const [post] = await posts(me);
      assert.equal(post.payload.count, 1);
      assert.equal((await members(post.id)).length, 1);
    });

    it('an unknown commit retried under a fresh operation id adds no member', async () => {
      const me = await actor();
      const a = await film('Zodiac');
      await add(a);
      await add(a); // the client could not tell the first committed, and asked again
      const all = await posts(me);
      assert.equal(all.length, 1);
      assert.equal(all[0].payload.count, 1);
    });

    it('remove and re-add keeps the one post and its membership, and restores the row', async () => {
      const me = await actor();
      const [a, b] = [await film('Carol'), await film('Brooklyn')];
      await add(a);
      await add(b);
      const [post] = await posts(me);

      await remove(a);
      assert.deepEqual(await members(post.id), [a, b], 'removing a title keeps it in the post');
      await add(a);

      const { rows } = await t.sql(
        `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
        [me, a],
      );
      assert.equal(rows.length, 1, 'the watchlist row is back');
      const all = await posts(me);
      assert.equal(all.length, 1);
      assert.equal(all[0].payload.count, 2);
    });

    it('re-adding long after the window still creates nothing new', async () => {
      const me = await actor();
      const a = await film('Moonlight');
      await add(a);
      const [post] = await posts(me);
      await age(post.id, 600);
      await remove(a);
      await add(a);
      assert.equal((await posts(me)).length, 1);
    });

    it('the membership table refuses a second announcement outright', async () => {
      const me = await actor();
      const a = await film('Nope');
      await add(a);
      const [post] = await posts(me);
      const error = await t.errorFrom(
        `insert into feed_watchlist_titles (event_id, actor_id, media_item_id) values ($1, $2, $3)`,
        [post.id, me, a],
      );
      assert.ok(error);
    });
  });

  describe('the conversation survives growth', () => {
    it('comments and reactions on the first save are still on the post after it grows', async () => {
      const me = await actor();
      const [a, b] = [await film('Burning'), await film('Parasite')];
      await add(a);
      const [post] = await posts(me);

      await t.actAs(follower);
      await call(`add_comment($1, $2, 'great pick', false)`, [await uuid(), post.id]);
      await call(`set_reaction($1, $2, 'love')`, [await uuid(), post.id]);
      await t.actAs(me);
      await add(b);

      const [grown] = await posts(me);
      assert.equal(grown.id, post.id);
      assert.equal(grown.payload.count, 2);
      const { rows: comments } = await t.sql(
        `select 1 from comments where feed_event_id = $1`,
        [post.id],
      );
      const { rows: reactions } = await t.sql(
        `select 1 from reactions where feed_event_id = $1`,
        [post.id],
      );
      assert.equal(comments.length, 1);
      assert.equal(reactions.length, 1);
    });
  });

  describe('the member list', () => {
    it('returns every member in saved order, matching the count', async () => {
      const me = await actor();
      const ids = [
        await film('One'),
        await film('Two'),
        await film('Three'),
        await film('Four'),
      ];
      for (const id of ids) await add(id);
      const [post] = await posts(me);

      const rows = await readMembers(follower, post.id);
      assert.deepEqual(
        rows.map((row) => row.media_item_id),
        ids,
      );
      assert.deepEqual(
        rows.map((row) => row.ordinal),
        [1, 2, 3, 4],
      );
      assert.equal(rows.length, post.payload.count);
      assert.equal(rows[0].title, 'One');
      assert.equal(rows[0].kind, 'movie');
    });

    it('is refused across a block, and on a private account the reader does not follow', async () => {
      const me = await actor();
      const a = await film('Blocked');
      await add(a);
      const [post] = await posts(me);
      await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
        me,
        stranger,
      ]);
      assert.equal((await readMembers(stranger, post.id)).length, 0);

      const shy = await actor({ visibility: 'private' });
      const b = await film('Private');
      await add(b);
      const [hidden] = await posts(shy);
      assert.equal((await readMembers(follower, hidden.id)).length, 0);
      assert.equal((await readMembers(shy, hidden.id)).length, 1, 'the actor reads their own');
    });

    it('cannot be read from the table directly by any client', async () => {
      const error = await t.asUser(follower, () =>
        t.errorFrom(`select * from feed_watchlist_titles limit 1`),
      );
      assert.ok(error, 'no grant and no policy');
    });

    it('returns nothing for a post of another type', async () => {
      const me = await actor();
      const ranked = await film('Ranked');
      const { rows } = await t.sql(
        `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2) returning id`,
        [me, ranked],
      );
      assert.equal((await readMembers(follower, rows[0].id)).length, 0);
    });
  });

  describe('rollback: grouping switched off', () => {
    it('writes single-title posts, still once per title, and leaves existing groups alone', async () => {
      const me = await actor();
      const [a, b, c] = [
        await film('Grouped A'),
        await film('Single B'),
        await film('Single C'),
      ];
      await add(a);
      const [group] = await posts(me);

      await t.sql(
        `update app_config set value = 'false'::jsonb where key = 'feed.watchlist_grouping_enabled'`,
      );
      try {
        await add(b);
        await add(c);
        await remove(b);
        await add(b);
      } finally {
        await t.sql(
          `update app_config set value = 'true'::jsonb where key = 'feed.watchlist_grouping_enabled'`,
        );
      }

      const all = await posts(me);
      assert.equal(all.length, 3, 'one post per title while off, and no second post for b');
      assert.equal(all[0].id, group.id);
      assert.deepEqual(await members(group.id), [a]);
      assert.equal(all[1].payload.count, undefined, 'a single-title post carries no count');

      // Switched back on, inside the window: a new save joins the open *group*, never a
      // single-title post written while grouping was off.
      const d = await film('Back on D');
      await add(d);
      assert.deepEqual(await members(group.id), [a, d]);
    });
  });

  describe('a post outlives its first title', () => {
    it('removing the representative from the catalogue keeps the post and its conversation', async () => {
      const me = await actor();
      const [a, b] = [await film('Doomed'), await film('Survivor')];
      await add(a);
      await add(b);
      const [post] = await posts(me);
      await t.actAs(follower);
      await call(`add_comment($1, $2, 'keep me', false)`, [await uuid(), post.id]);
      await t.actAs(me);

      await t.sql(`delete from watchlist where media_item_id = $1`, [a]);
      await t.sql(`delete from media_items where id = $1`, [a]);

      const [kept] = await posts(me);
      assert.equal(kept.id, post.id);
      assert.equal(kept.media_item_id, b);
      assert.equal(kept.payload.count, 1);
      assert.deepEqual(await members(post.id), [b]);
      const { rows } = await t.sql(`select 1 from comments where feed_event_id = $1`, [
        post.id,
      ]);
      assert.equal(rows.length, 1);
    });
  });
});

describe('historical posts across the migration', () => {
  let t;
  let me;

  before(async () => {
    t = await createTestDbBefore(MIGRATION);
    me = await t.createUser({ username: 'wg_historian' });
    await t.actAs(me);
  });

  after(async () => t.close());

  const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
  const add = async (id) =>
    (await t.sql(`select set_watchlist($1, $2, true) as r`, [await uuid(), id])).rows[0].r;

  it('keeps every existing post as it is, gives each a membership, and never extends one', async () => {
    const [a, b] = [
      await t.createMovie('Legacy A', 96001),
      await t.createMovie('Legacy B', 96002),
    ];
    await add(a);
    await add(b);
    const { rows: beforeRows } = await t.sql(
      `select id, payload, causal_at from feed_events where actor_id = $1 and type = 'watchlist_added' order by causal_at, id`,
      [me],
    );
    assert.equal(beforeRows.length, 2, 'two single-title posts before the migration');

    await t.applyMigration(MIGRATION);

    const { rows: afterRows } = await t.sql(
      `select id, payload, causal_at from feed_events where actor_id = $1 and type = 'watchlist_added' order by causal_at, id`,
      [me],
    );
    assert.deepEqual(
      afterRows.map((row) => row.id),
      beforeRows.map((row) => row.id),
      'same ids: no historical post is rewritten or merged',
    );
    assert.equal(afterRows[0].payload.count, undefined);
    const { rows: membership } = await t.sql(
      `select event_id, media_item_id from feed_watchlist_titles where actor_id = $1 order by id`,
      [me],
    );
    assert.deepEqual(
      membership.map((row) => row.media_item_id),
      [a, b],
    );

    // Re-adding an already-announced title creates nothing; a new title starts a fresh group
    // rather than joining a historical post, even though that post is minutes old.
    await add(a);
    const c = await t.createMovie('After the migration', 96003);
    await add(c);
    const { rows: finalRows } = await t.sql(
      `select media_item_id, payload from feed_events where actor_id = $1 and type = 'watchlist_added' order by causal_at, id`,
      [me],
    );
    assert.equal(finalRows.length, 3);
    assert.equal(finalRows[2].media_item_id, c);
    assert.equal(finalRows[2].payload.count, 1);
  });
});
