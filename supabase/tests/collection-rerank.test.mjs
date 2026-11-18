import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';
import { tvRanking } from './tv-ranking-support.mjs';

/**
 * Collection drag-to-rerank (#318, 20261129000100): `rank_reorder`, granted back.
 *
 * What a move must do, and what it must never do:
 *
 *   · move `rankings.position` inside one band (I1, I2, I4 after every call);
 *   · write exactly one `manual` placement per move, and none for a no-op or a refusal (P1);
 *   · refuse a band crossing (22023) and a move computed from a stale list (55000);
 *   · apply a replayed operation id once (I5);
 *   · keep the three pools apart: a season's move never moves a show, nor a movie;
 *   · create no comparison, watch, feed post or notification (I7), keep `created_at`,
 *     and bring only the latest watch's EXISTING post up to date.
 */

const ctx = { t: null, user: null, seq: 0 };
const tv = tvRanking(ctx);
let t;

before(async () => {
  ctx.t = await createTestDb();
  t = ctx.t;
});

after(async () => {
  await ctx.t?.close();
});

beforeEach(async () => {
  ctx.seq += 1;
  ctx.user = await t.createUser({ username: `rerank_${ctx.seq}` });
  await t.actAs(ctx.user);
});

const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const movie = (title) => t.createMovie(title, (ctx.seq += 1) * 10 + 880000);

/** Ranks films into one band in the order given: each new one lands at the bottom. */
const band = async (n, bucket = 'loved', label = bucket) => {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const film = await movie(`${label} ${i}`);
    await t.rankToCompletion(film, bucket, async (pivot) => pivot);
    ids.push(film);
  }
  return ids;
};

/** The ranking as media ids in position order. */
const order = async (category = 'movies') =>
  (
    await t.sql(
      `select media_item_id from rankings
        where user_id = $1 and category = $2::ranking_category order by position`,
      [ctx.user, category],
    )
  ).rows.map((r) => r.media_item_id);

const reorder = (item, to, { id = null, expected = null, anchor = null } = {}) =>
  one(t.db, `select rank_reorder($1, $2, $3, $4, $5) as r`, [item, to, id, expected, anchor]);

const manual = async (item = null) =>
  (
    await t.sql(
      `select kind, outcome, bucket, position, from_position, band_rank, band_size,
              category_size, score, from_score, comparisons, adjustable, session_id,
              watch_event_id, operation_id, category
         from ranking_placements
        where user_id = $1 and kind = 'manual' and ($2::uuid is null or media_item_id = $2)
        order by created_at, id`,
      [ctx.user, item],
    )
  ).rows;

/** Every row a move must not create, counted. */
const sideEffects = async () => {
  const n = async (sql) => Number((await t.sql(sql, [ctx.user])).rows[0].n);
  return {
    comparisons: await n(`select count(*) as n from comparisons where user_id = $1`),
    watches: await n(`select count(*) as n from watch_events where user_id = $1`),
    feed: await n(`select count(*) as n from feed_events where actor_id = $1`),
    notifications: await n(`select count(*) as n from notifications where actor_id = $1`),
    sessions: await n(`select count(*) as n from ranking_sessions where user_id = $1`),
    collection: (
      await t.sql(
        `select media_item_id, bucket, watched_on, updated_at from user_media
          where user_id = $1 order by media_item_id`,
        [ctx.user],
      )
    ).rows,
    createdAt: (
      await t.sql(
        `select media_item_id, created_at from rankings where user_id = $1 order by media_item_id`,
        [ctx.user],
      )
    ).rows,
  };
};

const valid = async (category = 'movies') => {
  await t.assertValid(ctx.user, category);
  await t.sql(`select assert_placements_valid($1)`, [ctx.user]);
};

const num = (v) => (v === null || v === undefined ? null : Number(v));

const scoreFor = async (bucket, rank, size) =>
  num((await t.sql(`select score_for($1::taste_bucket, $2, $3) as s`, [bucket, rank, size])).rows[0].s);

// ---------------------------------------------------------------------------

describe('a move inside one band', () => {
  it('moves up: the title lands at the target and the ones between shift down', async () => {
    const ids = await band(5);
    const r = await reorder(ids[3], 1, { id: await op(), expected: 4, anchor: ids[0] });
    assert.equal(r.moved, true);
    assert.equal(r.position, 1);
    assert.equal(r.from_position, 4);
    assert.deepEqual(await order(), [ids[3], ids[0], ids[1], ids[2], ids[4]]);
    await valid();
  });

  it('moves down: the ones between shift up', async () => {
    const ids = await band(5);
    await reorder(ids[0], 4, { id: await op(), expected: 1, anchor: ids[3] });
    assert.deepEqual(await order(), [ids[1], ids[2], ids[3], ids[0], ids[4]]);
    await valid();
  });

  it('swaps two neighbours with an adjacent move, either way', async () => {
    const ids = await band(3);
    await reorder(ids[1], 1, { id: await op(), expected: 2, anchor: ids[0] });
    assert.deepEqual(await order(), [ids[1], ids[0], ids[2]]);
    await reorder(ids[1], 2, { id: await op(), expected: 1, anchor: ids[0] });
    assert.deepEqual(await order(), [ids[0], ids[1], ids[2]]);
    await valid();
  });

  it('a long move across a large band keeps I1 and I2', async () => {
    const ids = await band(30);
    await reorder(ids[29], 1, { id: await op(), expected: 30, anchor: ids[0] });
    await reorder(ids[0], 30, { id: await op(), expected: 2, anchor: ids[28] });
    const now = await order();
    assert.equal(now[0], ids[29]);
    assert.equal(now[29], ids[0]);
    assert.equal(new Set(now).size, 30);
    await valid();
  });

  it('a no-op answers done, moves nothing and writes no placement', async () => {
    const ids = await band(3);
    const before = await order();
    const r = await reorder(ids[1], 2, { id: await op(), expected: 2, anchor: ids[1] });
    assert.equal(r.moved, false);
    assert.deepEqual(await order(), before);
    assert.equal((await manual()).length, 0);
    await valid();
  });

  it('every score in the band reflows from the new positions, and the reply says so', async () => {
    const ids = await band(4);
    const top = await scoreFor('loved', 1, 4);
    const bottom = await scoreFor('loved', 4, 4);
    const r = await reorder(ids[3], 1, { id: await op() });
    assert.equal(num(r.score), top, 'the moved title now carries the top score');
    assert.equal(num(r.from_score), bottom);
    assert.equal(r.band_lo, 1);
    assert.equal(r.band_size, 4);
    const live = (
      await t.sql(
        `select media_item_id, score from public_scores($1::uuid[], $2::uuid[])`,
        [[ctx.user], ids],
      )
    ).rows;
    const scoreOf = (id) => num(live.find((row) => row.media_item_id === id)?.score);
    assert.equal(scoreOf(ids[3]), top);
    assert.equal(scoreOf(ids[2]), bottom, 'the title pushed to the bottom took the bottom score');
  });
});

describe('the ledger: one manual placement per move', () => {
  it('records the move with its from and to, and no session, comparison or watch', async () => {
    const ids = await band(4);
    const id = await op();
    await reorder(ids[2], 1, { id });
    const rows = await manual(ids[2]);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.kind, 'manual');
    assert.equal(row.outcome, 'moved');
    assert.equal(row.position, 1);
    assert.equal(row.from_position, 3);
    assert.equal(row.band_rank, 1);
    assert.equal(row.band_size, 4);
    assert.equal(row.category_size, 4);
    assert.equal(num(row.score), await scoreFor('loved', 1, 4));
    assert.equal(num(row.from_score), await scoreFor('loved', 3, 4));
    assert.equal(row.comparisons, 0);
    assert.equal(row.adjustable, false);
    assert.equal(row.session_id, null);
    assert.equal(row.watch_event_id, null);
    assert.equal(row.operation_id, id);
    assert.equal(row.category, 'movies');
    await valid();
  });

  it('a replayed operation id moves once and records once (I5)', async () => {
    const ids = await band(4);
    const id = await op();
    const first = await reorder(ids[3], 1, { id, expected: 4, anchor: ids[0] });
    const afterFirst = await order();
    // The replay names a position that is stale by now. It must still answer, not refuse:
    // the claim recognises it before any guard is read.
    const second = await reorder(ids[3], 1, { id, expected: 4, anchor: ids[0] });
    assert.deepEqual(second, first, 'the replay returns the first reply');
    assert.deepEqual(await order(), afterFirst);
    assert.equal((await manual(ids[3])).length, 1);
    await valid();
  });
});

describe('refusals change nothing', () => {
  it('a move across a band boundary is refused with 22023', async () => {
    const loved = await band(3, 'loved');
    const fine = await band(2, 'fine');
    const before = await order();
    const err = await t.errorFrom(`select rank_reorder($1, $2, $3)`, [fine[0], 1, await op()]);
    assert.equal(err?.code, '22023');
    const down = await t.errorFrom(`select rank_reorder($1, $2, $3)`, [loved[2], 4, await op()]);
    assert.equal(down?.code, '22023', 'one past the end of the band is still another band');
    assert.deepEqual(await order(), before);
    assert.equal((await manual()).length, 0);
    await valid();
  });

  it('a stale position is refused with 55000', async () => {
    const ids = await band(4);
    const err = await t.errorFrom(`select rank_reorder($1, $2, $3, $4)`, [
      ids[2],
      1,
      await op(),
      2, // the client thought it was #2; it is #3
    ]);
    assert.equal(err?.code, '55000');
    assert.equal((await manual()).length, 0);
  });

  it('a stale anchor is refused with 55000: another device ranked above the target', async () => {
    const ids = await band(3);
    // The client saw ids[0] at #1 and computed "move ids[2] to #1, above ids[0]".
    // Meanwhile another device puts a new film at the top of the band.
    const intruder = await movie('Intruder');
    await t.rankToCompletion(intruder, 'loved', async (_pivot, subject) => subject);
    const before = await order();
    assert.equal(before[0], intruder);
    const err = await t.errorFrom(`select rank_reorder($1, $2, $3, $4, $5)`, [
      ids[2],
      1,
      await op(),
      null,
      ids[0],
    ]);
    assert.equal(err?.code, '55000');
    assert.deepEqual(await order(), before);
    assert.equal((await manual()).length, 0);
  });

  it('a title that is not ranked is refused with P0002', async () => {
    const film = await movie('Logged only');
    const err = await t.errorFrom(`select rank_reorder($1, $2, $3)`, [film, 1, await op()]);
    assert.equal(err?.code, 'P0002');
  });

  it('a refused move releases its operation id', async () => {
    // The claim rolls back with the refusal, so the same intent can be retried once fixed.
    const ids = await band(3);
    const id = await op();
    const err = await t.errorFrom(`select rank_reorder($1, $2, $3, $4)`, [ids[2], 1, id, 2]);
    assert.equal(err?.code, '55000');
    const r = await reorder(ids[2], 1, { id, expected: 3 });
    assert.equal(r.moved, true);
  });
});

describe('a move is not a ranking act (I7)', () => {
  it('creates no comparison, watch, feed post, notification or session, and keeps created_at', async () => {
    const ids = await band(4);
    const before = await sideEffects();
    await reorder(ids[3], 1, { id: await op() });
    await reorder(ids[1], 4, { id: await op() });
    const afterMoves = await sideEffects();
    assert.deepEqual(afterMoves, before);
  });

  it("brings the latest watch's existing post up to date, and posts nothing new", async () => {
    const ids = await band(4);
    const postsBefore = (
      await t.sql(
        `select id, payload from feed_events
          where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
        [ctx.user, ids[3]],
      )
    ).rows;
    assert.equal(postsBefore.length, 1, 'the first ranking posted once');
    const r = await reorder(ids[3], 1, { id: await op() });
    const postsAfter = (
      await t.sql(
        `select id, payload from feed_events
          where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
        [ctx.user, ids[3]],
      )
    ).rows;
    assert.equal(postsAfter.length, 1, 'no new post');
    assert.equal(postsAfter[0].id, postsBefore[0].id);
    assert.equal(num(postsAfter[0].payload.score), num(r.score));
    assert.equal(postsAfter[0].payload.position, 1);
    assert.equal(postsAfter[0].payload.from_position, undefined, 'the payload carries no movement');
  });

  it('is executable by a signed-in reader, and not by anon', async () => {
    const ids = await band(2);
    const id = await op();
    const r = await t.asUser(ctx.user, () => reorder(ids[1], 1, { id }));
    assert.equal(r.moved, true);
    const err = await t.asAnon(() => t.errorFrom(`select rank_reorder($1, 1)`, [ids[0]]));
    assert.match(String(err?.message), /permission denied/i);
  });

  it("moves only the caller's own ranking", async () => {
    const mine = await band(3);
    const other = await t.createUser({ username: `rerank_other_${ctx.seq}` });
    await t.actAs(other);
    // Another reader asking to move my film finds it unranked in their own ranking.
    const err = await t.errorFrom(`select rank_reorder($1, $2, $3)`, [mine[2], 1, await op()]);
    assert.equal(err?.code, 'P0002');
    await t.actAs(ctx.user);
    assert.deepEqual(await order(), mine);
  });
});

describe('three pools, moved independently', () => {
  /** Three ranked shows, three ranked seasons of a fourth show, and two films. */
  const pools = async () => {
    const shows = [];
    for (const [name, score] of [
      ['Show A', 90],
      ['Show B', 70],
      ['Show C', 50],
    ]) {
      const id = await ctx.t.createSeries(name, (ctx.seq += 1) * 10 + 870000);
      await tv.rank(id, 'loved', score);
      shows.push(id);
    }
    const parent = await ctx.t.createSeries('Seasons parent', (ctx.seq += 1) * 10 + 870000);
    const seasons = [];
    for (const [n, score] of [
      [1, 80],
      [2, 60],
      [3, 40],
    ]) {
      const id = await ctx.t.createSeason(parent, n, `Season ${n}`);
      await tv.rank(id, 'loved', score);
      seasons.push(id);
    }
    const films = await band(2);
    return { shows, seasons, parent, films };
  };

  it('a season move moves seasons only', async () => {
    const { shows, seasons, films } = await pools();
    const showsBefore = await order('tv_shows');
    const filmsBefore = await order('movies');
    assert.deepEqual(await order('tv_seasons'), seasons);
    const r = await reorder(seasons[2], 1, { id: await op(), expected: 3, anchor: seasons[0] });
    assert.equal(r.category, 'tv_seasons');
    assert.deepEqual(await order('tv_seasons'), [seasons[2], seasons[0], seasons[1]]);
    assert.deepEqual(await order('tv_shows'), showsBefore);
    assert.deepEqual(await order('movies'), filmsBefore);
    assert.equal(showsBefore.length, shows.length);
    assert.equal(filmsBefore.length, films.length);
    await valid('tv_seasons');
    await valid('tv_shows');
  });

  it('a show move moves shows only, and never creates a ranking for an unranked parent', async () => {
    const { shows, seasons, parent } = await pools();
    const seasonsBefore = await order('tv_seasons');
    await reorder(shows[0], 3, { id: await op(), expected: 1, anchor: shows[2] });
    assert.deepEqual(await order('tv_shows'), [shows[1], shows[2], shows[0]]);
    assert.deepEqual(await order('tv_seasons'), seasonsBefore);
    // The seasons' parent has no explicit show ranking, and a move cannot give it one.
    const err = await t.errorFrom(`select rank_reorder($1, $2, $3)`, [parent, 1, await op()]);
    assert.equal(err?.code, 'P0002');
    assert.equal((await order('tv_shows')).includes(parent), false);
    assert.equal(seasons.length, 3);
    await valid('tv_shows');
  });

  it('a TV move writes no update post of its own', async () => {
    const { seasons } = await pools();
    const posts = async () =>
      Number(
        (
          await t.sql(`select count(*) as n from feed_events where actor_id = $1`, [ctx.user])
        ).rows[0].n,
      );
    const before = await posts();
    await reorder(seasons[2], 1, { id: await op() });
    assert.equal(await posts(), before);
  });
});

describe('custom Lists keep their own order (#318 §7)', () => {
  it("moving a list item changes only that list's order, never a rank, score or comparison", async () => {
    const ids = await band(3);
    const call = async (sql, params) => (await one(t.db, `select ${sql} as r`, params));
    const created = await call(
      `create_list($1, 'Favourites', null, 'private'::list_visibility, 'ranked', null)`,
      [await op()],
    );
    for (const id of ids) {
      await call(`add_list_item($1, $2, $3)`, [await op(), created.id, id]);
    }
    const listOrder = async () =>
      (
        await t.sql(`select media_item_id from list_items where list_id = $1 order by position`, [
          created.id,
        ])
      ).rows.map((r) => r.media_item_id);
    assert.deepEqual(await listOrder(), ids);

    const before = {
      ranking: await order(),
      placements: (await t.sql(`select id from ranking_placements where user_id = $1 order by id`, [ctx.user])).rows,
      scores: (
        await t.sql(`select media_item_id, score from public_scores($1::uuid[], $2::uuid[]) order by 1`, [
          [ctx.user],
          ids,
        ])
      ).rows,
      side: await sideEffects(),
    };

    await call(`move_list_item($1, $2, $3, $4)`, [await op(), created.id, ids[2], 0]);
    assert.deepEqual(await listOrder(), [ids[2], ids[0], ids[1]], 'the list moved');

    assert.deepEqual(await order(), before.ranking, 'the ranking did not');
    assert.deepEqual(
      (await t.sql(`select id from ranking_placements where user_id = $1 order by id`, [ctx.user])).rows,
      before.placements,
    );
    assert.deepEqual(
      (
        await t.sql(`select media_item_id, score from public_scores($1::uuid[], $2::uuid[]) order by 1`, [
          [ctx.user],
          ids,
        ])
      ).rows,
      before.scores,
    );
    const side = await sideEffects();
    assert.equal(side.comparisons, before.side.comparisons);
    assert.equal(side.watches, before.side.watches);
    assert.deepEqual(side.createdAt, before.side.createdAt);
  });
});
