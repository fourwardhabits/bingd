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

// ---------------------------------------------------------------------------
// Across a category (20261129000200, founder 2026-11-19)
// ---------------------------------------------------------------------------

describe('a move across a rating category', () => {
  const cross = (item, to, bucket, { id = null, expected = null, anchor = null } = {}) =>
    one(t.db, `select rank_reorder($1, $2, $3, $4, $5, $6::taste_bucket) as r`, [
      item,
      to,
      id,
      expected,
      anchor,
      bucket,
    ]);

  const bucketOf = async (item) =>
    (
      await t.sql(`select bucket from rankings where user_id = $1 and media_item_id = $2`, [
        ctx.user,
        item,
      ])
    ).rows[0]?.bucket;

  const collectionBucket = async (item) =>
    (
      await t.sql(`select bucket from user_media where user_id = $1 and media_item_id = $2`, [
        ctx.user,
        item,
      ])
    ).rows[0]?.bucket;

  const ledger = async (item) =>
    (
      await t.sql(
        `select bucket, from_bucket, position, from_position, band_rank, band_size, score,
                from_score, comparisons, session_id, watch_event_id
           from ranking_placements
          where user_id = $1 and media_item_id = $2 and kind = 'manual'
          order by created_at, id`,
        [ctx.user, item],
      )
    ).rows;

  const latestPost = async (item) =>
    (
      await t.sql(
        `select id, payload from feed_events
          where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
        [ctx.user, item],
      )
    ).rows;

  it('down: an I liked it title dropped among It was fine becomes It was fine, rescored', async () => {
    const loved = await band(3, 'loved');
    const fine = await band(3, 'fine');
    const postBefore = await latestPost(loved[0]);
    const before = await sideEffects();

    const r = await cross(loved[0], 5, 'fine', { id: await op(), expected: 1, anchor: fine[1] });

    assert.equal(r.moved, true);
    assert.equal(r.bucket, 'fine');
    assert.equal(r.from_bucket, 'loved');
    assert.deepEqual(await order(), [loved[1], loved[2], fine[0], fine[1], loved[0], fine[2]]);
    assert.equal(await bucketOf(loved[0]), 'fine');
    assert.equal(await collectionBucket(loved[0]), 'fine', 'I3: the collection row agrees');
    // Band of four, third in it: the score is the place's, from the model, not a guess.
    assert.equal(num(r.score), await scoreFor('fine', 3, 4));
    assert.equal(num(r.from_score), await scoreFor('loved', 1, 3));
    assert.ok(num(r.score) < 7 && num(r.score) >= 3.5, 'an It was fine score');

    const [row] = await ledger(loved[0]);
    assert.equal(row.from_bucket, 'loved');
    assert.equal(row.bucket, 'fine');
    assert.equal(row.from_position, 1);
    assert.equal(row.position, 5);
    assert.equal(row.band_rank, 3);
    assert.equal(row.band_size, 4);
    assert.equal(row.comparisons, 0);
    assert.equal(row.session_id, null);
    assert.equal(row.watch_event_id, null);

    // The latest watch's existing post follows, and nothing new is posted.
    const postAfter = await latestPost(loved[0]);
    assert.equal(postAfter.length, 1);
    assert.equal(postAfter[0].id, postBefore[0].id);
    assert.equal(postAfter[0].payload.bucket, 'fine');
    assert.equal(num(postAfter[0].payload.score), num(r.score));

    // Nothing but the subject's category changed in the collection; no ranking act.
    const after = await sideEffects();
    assert.equal(after.comparisons, before.comparisons);
    assert.equal(after.watches, before.watches);
    assert.equal(after.feed, before.feed);
    assert.equal(after.notifications, before.notifications);
    assert.equal(after.sessions, before.sessions);
    assert.deepEqual(after.createdAt, before.createdAt);
    const changed = after.collection.filter(
      (row, i) => row.bucket !== before.collection[i].bucket,
    );
    assert.deepEqual(changed.map((c) => c.media_item_id), [loved[0]]);
    await valid();
  });

  it('up: an I didn’t like it title dropped among I liked it becomes I liked it', async () => {
    const loved = await band(3, 'loved');
    const fine = await band(2, 'fine');
    const nfm = await band(2, 'not_for_me');

    const r = await cross(nfm[1], 2, 'loved', { id: await op(), expected: 7, anchor: loved[1] });

    assert.deepEqual(await order(), [loved[0], nfm[1], loved[1], loved[2], fine[0], fine[1], nfm[0]]);
    assert.equal(r.bucket, 'loved');
    assert.equal(await collectionBucket(nfm[1]), 'loved');
    assert.equal(num(r.score), await scoreFor('loved', 2, 4));
    assert.ok(num(r.score) >= 7);
    await valid();
  });

  it('a long move from the top of one category to the bottom of the last', async () => {
    const loved = await band(4, 'loved');
    const fine = await band(2, 'fine');
    const nfm = await band(3, 'not_for_me');
    const r = await cross(loved[0], 9, 'not_for_me', { id: await op(), expected: 1, anchor: nfm[2] });
    assert.deepEqual(await order(), [...loved.slice(1), ...fine, ...nfm, loved[0]]);
    assert.equal(num(r.score), await scoreFor('not_for_me', 4, 4));
    await valid();
  });

  it('at the line: the last of one category becomes the first of the next without moving', async () => {
    const loved = await band(3, 'loved');
    const fine = await band(2, 'fine');
    const r = await cross(loved[2], 3, 'fine', { id: await op(), expected: 3 });
    assert.equal(r.moved, true, 'a change of category is a move');
    assert.equal(r.position, 3);
    assert.deepEqual(await order(), [...loved, ...fine]);
    assert.equal(await bucketOf(loved[2]), 'fine');
    assert.equal(num(r.score), await scoreFor('fine', 1, 3));
    await valid();
    // Fourth in It was fine cannot become I liked it: there is an It was fine title above it.
    const gap = await t.errorFrom(`select rank_reorder($1, $2, $3, null, null, 'loved')`, [
      fine[0],
      4,
      await op(),
    ]);
    assert.equal(gap?.code, '22023');
    // And the first It was fine title becomes the last I liked it again the same way.
    const back = await cross(loved[2], 3, 'loved', { id: await op(), expected: 3 });
    assert.equal(back.bucket, 'loved');
    assert.equal(await bucketOf(loved[2]), 'loved');
    assert.equal(num(back.score), await scoreFor('loved', 3, 3));
    assert.equal((await ledger(loved[2])).length, 2);
    await valid();
  });

  it('into an empty category, and out of a category it was alone in', async () => {
    const loved = await band(3, 'loved');
    // No It was fine and no I didn't like it titles yet: the only place in each is the end.
    const r = await cross(loved[1], 3, 'not_for_me', { id: await op(), expected: 2, anchor: loved[2] });
    assert.deepEqual(await order(), [loved[0], loved[2], loved[1]]);
    assert.equal(r.bucket, 'not_for_me');
    assert.equal(num(r.score), await scoreFor('not_for_me', 1, 1));
    await valid();

    const wrong = await t.errorFrom(`select rank_reorder($1, $2, $3, null, null, 'fine')`, [
      loved[0],
      1,
      await op(),
    ]);
    assert.equal(wrong?.code, '22023', 'an empty category has exactly one place, at its line');

    // The not_for_me title was alone; moving it back up empties that category again.
    await cross(loved[1], 1, 'loved', { id: await op(), expected: 3, anchor: loved[0] });
    assert.deepEqual(await order(), [loved[1], loved[0], loved[2]]);
    const sizes = (
      await t.sql(`select count(*) filter (where bucket = 'not_for_me') as n from rankings where user_id = $1`, [
        ctx.user,
      ])
    ).rows[0];
    assert.equal(Number(sizes.n), 0);
    await valid();
  });

  it('refuses a position that is not a place in the named category (22023), changing nothing', async () => {
    const loved = await band(2, 'loved');
    const fine = await band(2, 'fine');
    const nfm = await band(2, 'not_for_me');
    const before = await order();
    for (const [item, to, bucket] of [
      [loved[0], 2, 'not_for_me'],
      [loved[0], 6, 'fine'],
      [nfm[0], 1, 'fine'],
      [fine[0], 0, 'loved'],
      [fine[0], 7, 'not_for_me'],
    ]) {
      const err = await t.errorFrom(`select rank_reorder($1, $2, $3, null, null, $4::taste_bucket)`, [
        item,
        to,
        await op(),
        bucket,
      ]);
      assert.equal(err?.code, '22023', `${bucket} @ ${to}`);
    }
    assert.deepEqual(await order(), before);
    assert.equal((await manual()).length, 0);
    await valid();
  });

  it('undo puts it back in its own category and place, with the original scores', async () => {
    const loved = await band(3, 'loved');
    const fine = await band(3, 'fine');
    const before = await order();
    const scoreOf = async (item) => {
      const rows = await t.sql(`select position, bucket from rankings where user_id = $1 and media_item_id = $2`, [
        ctx.user,
        item,
      ]);
      return rows.rows[0];
    };
    const original = await scoreOf(loved[2]);

    await cross(loved[2], 5, 'fine', { id: await op(), expected: 3, anchor: fine[1] });
    // The undo the client builds: back to 3 in loved, anchored on whoever is at 3 now.
    const anchorNow = (await order())[2];
    const back = await cross(loved[2], 3, 'loved', { id: await op(), expected: 5, anchor: anchorNow });

    assert.equal(back.moved, true);
    assert.deepEqual(await order(), before);
    assert.deepEqual(await scoreOf(loved[2]), original);
    assert.equal(await collectionBucket(loved[2]), 'loved');
    assert.equal(num(back.score), await scoreFor('loved', 3, 3));
    const rows = await ledger(loved[2]);
    assert.deepEqual(
      rows.map((r) => [r.from_bucket, r.bucket]),
      [
        ['loved', 'fine'],
        ['fine', 'loved'],
      ],
      'both moves are in the history',
    );
    await valid();
  });

  it('undo after another device moved something is refused, not misapplied (55000)', async () => {
    const loved = await band(3, 'loved');
    const fine = await band(3, 'fine');
    await cross(loved[2], 5, 'fine', { id: await op(), expected: 3, anchor: fine[1] });
    const anchorNow = (await order())[2];
    // Another device moves the title at 3 meanwhile.
    await reorder(anchorNow, 4, { id: await op() });
    const err = await t.errorFrom(`select rank_reorder($1, $2, $3, $4, $5, 'loved')`, [
      loved[2],
      3,
      await op(),
      5,
      anchorNow,
    ]);
    assert.equal(err?.code, '55000');
    assert.equal(await bucketOf(loved[2]), 'fine', 'nothing moved back');
    await valid();
  });

  it('a stale position or anchor refuses a cross-category move (55000)', async () => {
    const loved = await band(3, 'loved');
    const fine = await band(3, 'fine');
    const before = await order();
    const stalePos = await t.errorFrom(`select rank_reorder($1, $2, $3, $4, $5, 'fine')`, [
      loved[0],
      5,
      await op(),
      2,
      fine[1],
    ]);
    assert.equal(stalePos?.code, '55000');
    const staleAnchor = await t.errorFrom(`select rank_reorder($1, $2, $3, $4, $5, 'fine')`, [
      loved[0],
      5,
      await op(),
      1,
      fine[0],
    ]);
    assert.equal(staleAnchor?.code, '55000');
    assert.deepEqual(await order(), before);
    assert.equal(await bucketOf(loved[0]), 'loved');
    assert.equal((await manual()).length, 0);
  });

  it('a replayed operation id crosses once (I5)', async () => {
    const loved = await band(3, 'loved');
    const fine = await band(2, 'fine');
    const id = await op();
    const first = await cross(loved[0], 4, 'fine', { id, expected: 1, anchor: fine[0] });
    const replay = await cross(loved[0], 4, 'fine', { id, expected: 1, anchor: fine[0] });
    assert.deepEqual(replay, first);
    assert.equal((await ledger(loved[0])).length, 1);
    assert.deepEqual(await order(), [loved[1], loved[2], fine[0], loved[0], fine[1]]);
    await valid();
  });

  it('a same-category call with no category named behaves exactly as before', async () => {
    const loved = await band(3, 'loved');
    const fine = await band(2, 'fine');
    const r = await reorder(loved[2], 1, { id: await op(), expected: 3, anchor: loved[0] });
    assert.equal(r.bucket, 'loved');
    assert.equal(r.from_bucket, 'loved');
    const err = await t.errorFrom(`select rank_reorder($1, $2, $3)`, [loved[0], 4, await op()]);
    assert.equal(err?.code, '22023', 'no category named means its own category');
    assert.deepEqual(await order(), [loved[2], loved[0], loved[1], ...fine]);
    await valid();
  });

  it('TV seasons cross categories among seasons only; shows and films are untouched', async () => {
    const parent = await ctx.t.createSeries('Cross parent', (ctx.seq += 1) * 10 + 870000);
    const seasons = [];
    for (const [n, bucket, score] of [
      [1, 'loved', 80],
      [2, 'loved', 70],
      [3, 'fine', 50],
      [4, 'fine', 40],
    ]) {
      const id = await ctx.t.createSeason(parent, n, `Season ${n}`);
      await tv.rank(id, bucket, score);
      seasons.push(id);
    }
    const show = await ctx.t.createSeries('Cross show', (ctx.seq += 1) * 10 + 870000);
    await tv.rank(show, 'loved', 90);
    const films = await band(2);
    const showsBefore = await order('tv_shows');
    const filmsBefore = await order('movies');
    const seasonsBefore = await order('tv_seasons');
    const s0 = seasonsBefore.indexOf(seasons[0]) + 1;
    const anchorPos = seasonsBefore.length;

    const r = await cross(seasons[0], anchorPos, 'fine', {
      id: await op(),
      expected: s0,
      anchor: seasonsBefore[anchorPos - 1],
    });
    assert.equal(r.category, 'tv_seasons');
    assert.equal(r.bucket, 'fine');
    assert.equal(await bucketOf(seasons[0]), 'fine');
    assert.deepEqual(await order('tv_shows'), showsBefore);
    assert.deepEqual(await order('movies'), filmsBefore);
    assert.equal(films.length, 2);
    await valid('tv_seasons');
    await valid('tv_shows');
    await valid('movies');
  });
});
