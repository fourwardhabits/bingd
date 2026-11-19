import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';
import { tvRanking } from './tv-ranking-support.mjs';

/**
 * The TV wall, dragged directly (#319, 20261129000300, founder QA 2026-11-20).
 *
 *   An explicit show, dragged             rank_reorder in tv_shows, as before
 *   An SN AVG show, dragged               rank_promote_show: an explicit show ranking at
 *                                         the drop, with that place's score
 *   ...and Undo                           rank_unpromote_show: the average-only state again
 *
 * A promotion writes a ranking, the collection row's category, one manual `placed`
 * placement and its record. It never writes a watch, a comparison, a post, a notification
 * or an award, and never reads or writes a season ranking.
 */
const ctx = { t: null, user: null, seq: 0 };
const { op, movie, series, rank, positions, posts } = tvRanking(ctx);

before(async () => {
  ctx.t = await createTestDb();
});

after(async () => {
  await ctx.t?.close();
});

beforeEach(async () => {
  ctx.seq += 1;
  ctx.user = await ctx.t.createUser({ username: `tvpromo_${ctx.seq}` });
  await ctx.t.actAs(ctx.user);
});

const rows = async (sql, params = []) => (await ctx.t.sql(sql, params)).rows;
const call = (sql, params) => one(ctx.t.db, `select ${sql} as r`, params);
const refusal = (sql, params) => ctx.t.errorFrom(`select ${sql}`, params);

const promote = async (item, position, bucket, anchor = null, opId = null) =>
  call(`rank_promote_show($1, $2, $3::taste_bucket, $4, $5)`, [
    item,
    position,
    bucket,
    opId ?? (await op()),
    anchor,
  ]);

const unpromote = async (item, placement, expected = null, opId = null) =>
  call(`rank_unpromote_show($1, $2, $3, $4)`, [item, placement, opId ?? (await op()), expected]);

/** Everything a promotion must leave alone, for this reader. */
const sideEffects = async () => {
  const [counts] = await rows(
    `select
       (select count(*)::int from watch_events where user_id = $1) as watches,
       (select count(*)::int from feed_events where actor_id = $1) as posts,
       (select count(*)::int from notifications where recipient_id = $1) as notifications,
       (select count(*)::int from comparisons where user_id = $1) as comparisons,
       (select count(*)::int from award_unlocks where user_id = $1) as awards,
       (select count(*)::int from ranking_sessions where user_id = $1) as sessions`,
    [ctx.user],
  );
  return counts;
};

const valid = async () => {
  for (const cat of ['tv_shows', 'tv_seasons', 'movies'])
    await ctx.t.sql(`select assert_ranking_valid($1, $2::ranking_category)`, [ctx.user, cat]);
  await ctx.t.sql(`select assert_placements_valid($1)`, [ctx.user]);
  await ctx.t.sql(`select assert_watch_history_valid($1)`, [ctx.user]);
};

/** Three explicit shows (all I loved it) and Shameless, with two ranked seasons only. */
const wall = async () => {
  const shows = [];
  for (const [name, score] of [
    ['Show A', 90],
    ['Show B', 70],
    ['Show C', 50],
  ]) {
    const id = await series(name);
    await rank(id, 'loved', score);
    shows.push(id);
  }
  const avg = await series('Shameless');
  const seasons = [];
  for (let n = 1; n <= 3; n += 1) seasons.push(await ctx.t.createSeason(avg, n, `Season ${n}`));
  await rank(seasons[0], 'loved', 60);
  await rank(seasons[1], 'fine', 40);
  return { shows, avg, seasons };
};

const ids = (list) => list.map((r) => r.media_item_id);

describe('rank_promote_show', () => {
  it('gives an SN AVG show an explicit ranking at the drop, and nothing else', async () => {
    const { shows, avg } = await wall();
    const seasonsBefore = await positions('tv_seasons');
    const before = await sideEffects();

    const r = await promote(avg, 2, 'loved', shows[1]);
    assert.equal(r.promoted, true);
    assert.equal(r.position, 2);
    assert.equal(r.bucket, 'loved');
    assert.ok(r.placement_id);

    assert.deepEqual(ids(await positions('tv_shows')), [shows[0], avg, shows[1], shows[2]]);
    assert.deepEqual(await positions('tv_seasons'), seasonsBefore, 'seasons untouched');

    const [um] = await rows(
      `select bucket, source, watched_on from user_media where user_id = $1 and media_item_id = $2`,
      [ctx.user, avg],
    );
    assert.equal(um.bucket, 'loved');
    assert.equal(um.watched_on, null);

    assert.deepEqual(await sideEffects(), before, 'no watch, post, notification or award');
    assert.equal((await posts(avg)).length, 0);

    const placements = await rows(
      `select kind, outcome, position, bucket, score, from_position from ranking_placements
        where user_id = $1 and media_item_id = $2`,
      [ctx.user, avg],
    );
    assert.equal(placements.length, 1);
    assert.equal(placements[0].kind, 'manual');
    assert.equal(placements[0].outcome, 'placed');
    assert.equal(placements[0].from_position, null);
    assert.equal(Number(placements[0].score), Number(r.score));

    // The score is the place's, read from the show band, not the seasons' average.
    const [{ s }] = await rows(`select score_for('loved', 2, 4) as s`);
    assert.equal(Number(r.score), Number(s));
    await valid();
  });

  it('places it in another category, at either end of that category', async () => {
    const { shows, avg } = await wall();
    // No It was fine shows yet: the run starts at 4 and has no titles, so 4 is its only place.
    const r = await promote(avg, 4, 'fine', null);
    assert.equal(r.bucket, 'fine');
    assert.deepEqual(ids(await positions('tv_shows')), [...shows, avg]);
    await valid();
  });

  it('refuses what it cannot do, writing nothing', async () => {
    const { shows, avg, seasons } = await wall();
    const film = await movie('Heat');
    await rank(film, 'loved', 10);
    const unranked = await series('Never watched');
    const before = await positions('tv_shows');

    const cases = [
      [[film, 1, 'loved', null], '22023'],
      [[seasons[0], 1, 'loved', null], '22023'],
      [[shows[0], 1, 'loved', shows[0]], '55000'], // already explicit
      [[unranked, 1, 'loved', shows[0]], '55000'], // no ranked season
      [[avg, 2, 'loved', shows[2]], '55000'], // stale anchor
      [[avg, 4, 'loved', shows[0]], '55000'], // anchor for a place with no show
      [[avg, 5, 'loved', null], '22023'], // outside the band
      [[avg, 1, 'fine', shows[0]], '22023'], // a loved place for a fine show
    ];
    for (const [[item, pos, bucket, anchor], code] of cases) {
      const e = await refusal(`rank_promote_show($1, $2, $3::taste_bucket, $4, $5)`, [
        item,
        pos,
        bucket,
        await op(),
        anchor,
      ]);
      assert.equal(e?.code, code, `${pos}/${bucket}: ${e?.message}`);
    }
    const nullBucket = await refusal(`rank_promote_show($1, 1, null, $2, null)`, [avg, await op()]);
    assert.equal(nullBucket?.code, '22023');
    assert.deepEqual(await positions('tv_shows'), before);
    assert.equal((await rows(`select 1 from user_media where user_id = $1 and media_item_id = $2`, [ctx.user, avg])).length, 0);
    await valid();
  });

  it('answers a replay from the ledger', async () => {
    const { shows, avg } = await wall();
    const id = await op();
    const first = await promote(avg, 1, 'loved', shows[0], id);
    const again = await promote(avg, 1, 'loved', shows[0], id);
    assert.deepEqual(again, first);
    assert.equal((await positions('tv_shows')).length, 4);
    await valid();
  });

  it('moves a promoted show afterwards like any explicit show, silently', async () => {
    const { shows, avg } = await wall();
    await promote(avg, 1, 'loved', shows[0]);
    const before = await sideEffects();
    const moved = await call(`rank_reorder($1, $2, $3, $4, $5, $6::taste_bucket, $7::taste_bucket)`, [
      avg,
      4,
      await op(),
      1,
      null,
      'fine',
      'loved',
    ]);
    assert.equal(moved.bucket, 'fine');
    assert.deepEqual(await sideEffects(), before, 'a manual move posts nothing either');
    await valid();
  });
});

describe('rank_unpromote_show', () => {
  it('restores the average-only state, and leaves seasons and watches alone', async () => {
    const { shows, avg } = await wall();
    const showsBefore = await positions('tv_shows');
    const seasonsBefore = await positions('tv_seasons');
    const watchesBefore = await rows(
      `select id, media_item_id, watched_on from watch_events where user_id = $1 order by id`,
      [ctx.user],
    );
    const fx = await sideEffects();

    const r = await promote(avg, 2, 'loved', shows[1]);
    const u = await unpromote(avg, r.placement_id, 2);
    assert.equal(u.unpromoted, true);

    assert.deepEqual(await positions('tv_shows'), showsBefore);
    assert.deepEqual(await positions('tv_seasons'), seasonsBefore);
    assert.equal(
      (await rows(`select 1 from user_media where user_id = $1 and media_item_id = $2`, [ctx.user, avg])).length,
      0,
      'the collection row it created is gone',
    );
    assert.deepEqual(
      await rows(`select id, media_item_id, watched_on from watch_events where user_id = $1 order by id`, [ctx.user]),
      watchesBefore,
    );
    assert.deepEqual(await sideEffects(), fx);
    const [promo] = await rows(`select undone_at from show_promotions where user_id = $1`, [ctx.user]);
    assert.ok(promo.undone_at);
    await valid();
  });

  it('refuses once anything has happened since, and refuses twice', async () => {
    const { shows, avg } = await wall();
    const r = await promote(avg, 1, 'loved', shows[0]);

    const stale = await refusal(`rank_unpromote_show($1, $2, $3, $4)`, [avg, r.placement_id, await op(), 3]);
    assert.equal(stale?.code, '55000');

    await call(`rank_reorder($1, $2, $3, $4)`, [avg, 2, await op(), 1]);
    const since = await refusal(`rank_unpromote_show($1, $2, $3, $4)`, [avg, r.placement_id, await op(), 2]);
    assert.equal(since?.code, '55000', 'placed again since');
    assert.equal((await positions('tv_shows')).length, 4);

    const { avg: other } = await (async () => {
      const s = await series('Another');
      const season = await ctx.t.createSeason(s, 1, 'Season 1');
      await rank(season, 'loved', 5);
      return { avg: s };
    })();
    const p = await promote(other, 1, 'loved', shows[0]);
    await unpromote(other, p.placement_id, 1);
    const twice = await refusal(`rank_unpromote_show($1, $2, $3, $4)`, [other, p.placement_id, await op(), 1]);
    assert.equal(twice?.code, '55000');
    await valid();
  });

  it('puts back the watchlist entry the rating consumed, with its own date', async () => {
    const { shows, avg } = await wall();
    await ctx.t.sql(
      `insert into watchlist (user_id, media_item_id, created_at) values ($1, $2, '2026-01-02T03:04:05Z')`,
      [ctx.user, avg],
    );
    const r = await promote(avg, 1, 'loved', shows[0]);
    assert.equal(
      (await rows(`select 1 from watchlist where user_id = $1 and media_item_id = $2`, [ctx.user, avg])).length,
      0,
      'a rated show leaves the watchlist',
    );
    await unpromote(avg, r.placement_id, 1);
    const [w] = await rows(`select created_at from watchlist where user_id = $1 and media_item_id = $2`, [
      ctx.user,
      avg,
    ]);
    assert.equal(new Date(w.created_at).toISOString(), '2026-01-02T03:04:05.000Z');
    await valid();
  });

  it('keeps a collection row that existed before, with its note and its watches', async () => {
    const { shows, avg } = await wall();
    await call(`log_watched($1, $2, null, $3)`, [await op(), avg, 'Worth it for season 1']);
    const [before] = await rows(
      `select bucket, note, source from user_media where user_id = $1 and media_item_id = $2`,
      [ctx.user, avg],
    );
    const watches = await rows(`select id from watch_events where user_id = $1 and media_item_id = $2`, [
      ctx.user,
      avg,
    ]);
    assert.equal(watches.length, 1);

    const r = await promote(avg, 1, 'loved', shows[0]);
    await unpromote(avg, r.placement_id, 1);

    const [after] = await rows(
      `select bucket, note, source from user_media where user_id = $1 and media_item_id = $2`,
      [ctx.user, avg],
    );
    assert.deepEqual(after, before);
    assert.deepEqual(
      await rows(`select id from watch_events where user_id = $1 and media_item_id = $2`, [ctx.user, avg]),
      watches,
    );
    await valid();
  });
});

describe('a promoted show is seen through its seasons', () => {
  it('has no watch of its own, and gets the undated one only when its seasons leave', async () => {
    const { shows, avg, seasons } = await wall();
    await promote(avg, 1, 'loved', shows[0]);
    const own = () =>
      rows(`select watched_on, basis from watch_events where user_id = $1 and media_item_id = $2`, [
        ctx.user,
        avg,
      ]);
    assert.equal((await own()).length, 0);
    await valid();

    const removeSeason = async (season) => {
      await call(`rank_unrank($1, $2)`, [season, await op()]);
      await call(`unlog($1, $2)`, [await op(), season]);
    };
    await removeSeason(seasons[0]);
    assert.equal((await own()).length, 0, 'one season still carries it');
    await valid();

    await removeSeason(seasons[1]);
    const events = await own();
    assert.equal(events.length, 1);
    assert.equal(events[0].basis, 'none');
    assert.equal(events[0].watched_on, null);
    assert.equal((await positions('tv_shows')).length, 4, 'the show stays ranked');
    await valid();
  });

  it('still gives any other series row its backstop event', async () => {
    const s = await series('Logged whole');
    await call(`log_watched($1, $2)`, [await op(), s]);
    const events = await rows(`select basis from watch_events where user_id = $1 and media_item_id = $2`, [
      ctx.user,
      s,
    ]);
    assert.equal(events.length, 1);
    await valid();
  });
});

describe('the grants', () => {
  it('are for a signed-in reader only, and the record is server-only', async () => {
    for (const fn of [
      'rank_promote_show(uuid, integer, taste_bucket, uuid, uuid)',
      'rank_unpromote_show(uuid, uuid, uuid, integer)',
    ]) {
      const [g] = await rows(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as auth`,
        [fn],
      );
      assert.deepEqual(g, { anon: false, auth: true }, fn);
    }
    const [t] = await rows(
      `select has_table_privilege('authenticated', 'show_promotions', 'select') as s,
              has_table_privilege('anon', 'show_promotions', 'select') as a`,
    );
    assert.deepEqual(t, { s: false, a: false });
  });

  it('acts only on the caller’s own rankings', async () => {
    const { shows, avg } = await wall();
    const mine = await promote(avg, 1, 'loved', shows[0]);
    const other = await ctx.t.createUser({ username: `tvpromo_other_${ctx.seq}` });
    await ctx.t.actAs(other);
    const e = await refusal(`rank_unpromote_show($1, $2, $3, $4)`, [avg, mine.placement_id, await op(), 1]);
    assert.equal(e?.code, '55000');
    await ctx.t.actAs(ctx.user);
    assert.equal((await positions('tv_shows')).length, 4);
  });
});
