import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Recommendation Engine V2, A2 (20261116000200): taste-compatible collaborative evidence.
 *
 * Three things matter more than the ranking quality, and are asserted here:
 *
 *   - the batch Taste arithmetic is **the same** as `taste_match`, so the people chosen as
 *     neighbours are the people the Match % would call compatible;
 *   - **following has no effect** — a followed neighbour counts exactly as much as a stranger
 *     with the same taste, and a private account never counts, followed or not;
 *   - **nothing restricted leaks** — blocked, suspended and private accounts drop out at read
 *     time even when cached, and no title appears on one person's say-so.
 */

let t;
let reader;
let seq = 720000;

const setConfig = (key, value) =>
  t.sql(
    `insert into app_config (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );

const films = async (count, label) => {
  const ids = [];
  for (let i = 0; i < count; i += 1) ids.push(await t.createMovie(`${label}-${seq}`, seq++));
  return ids;
};

/**
 * A ranked list, best first. Each entry is `[mediaItemId, bucket]`; entries must already be
 * in bucket order (loved, fine, not_for_me), which is what a real ranking always is.
 */
const rank = async (user, entries, category = 'movies') => {
  let position = 0;
  for (const [mediaItemId, bucket] of entries) {
    position += 1;
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, $3::ranking_category, $4::taste_bucket, $5)`,
      [user, mediaItemId, category, bucket, position],
    );
  }
};

const bucketsFor = (count) =>
  Array.from({ length: count }, (_, i) => (i < count * 0.4 ? 'loved' : i < count * 0.8 ? 'fine' : 'not_for_me'));

const user = async (name, visibility = 'public') =>
  t.createUser({ username: `tn_${name}_${seq++}`, visibility });

const collaborative = async (asUser, kind = 'movie', limit = 40) => {
  await t.actAs(asUser);
  const { rows } = await t.sql(`select * from collaborative_candidates($1, $2)`, [kind, limit]);
  return rows;
};

const neighbours = async (of) => {
  const { rows } = await t.sql(
    `select neighbour_id, match, common_count, weight from taste_neighbours
      where reader_id = $1 order by neighbour_id`,
    [of],
  );
  return rows;
};

const enable = async (engine = 'v2_hybrid', who = [reader]) => {
  await setConfig('recommendations.v2_engine', engine);
  await setConfig('recommendations.v2_allowlist', who);
};

const forceRefresh = (of) => t.sql(`delete from taste_neighbour_refresh where reader_id = $1`, [of]);

/** A reader with 20 ranked films, and a set of "taste twins" who ranked the same 20 the same way. */
let shared;
let extra;

before(async () => {
  t = await createTestDb();
  reader = await user('reader');
  shared = await films(20, 'shared');
  extra = await films(6, 'extra');
  await rank(reader, shared.map((id, i) => [id, bucketsFor(20)[i]]));
});

after(async () => {
  await t?.db.close();
});

beforeEach(async () => {
  await setConfig('recommendations.v2_engine', 'v1');
  await setConfig('recommendations.v2_allowlist', []);
  await setConfig('recommendations.v2_rollout_percent', 0);
  await t.sql(`delete from taste_neighbours`);
  await t.sql(`delete from taste_neighbour_refresh`);
});

/** A neighbour whose ranking of `shared` matches the reader's, then loves `loves` too. */
const twin = async (name, { visibility = 'public', loves = [], hates = [] } = {}) => {
  const id = await user(name, visibility);
  const order = bucketsFor(20);
  const loved = shared.filter((_, i) => order[i] === 'loved').map((m) => [m, 'loved']);
  const fine = shared.filter((_, i) => order[i] === 'fine').map((m) => [m, 'fine']);
  const nfm = shared.filter((_, i) => order[i] === 'not_for_me').map((m) => [m, 'not_for_me']);
  await rank(id, [
    ...loves.map((m) => [m, 'loved']),
    ...loved,
    ...fine,
    ...nfm,
    ...hates.map((m) => [m, 'not_for_me']),
  ]);
  return id;
};

describe('the batch Taste arithmetic', () => {
  it('equals taste_match for every pair, on random rankings', async () => {
    let state = 7;
    const random = () => ((state = (state * 48271) % 2147483647) / 2147483647);
    const me = await user('eq_reader');
    const pool = await films(30, 'eq');
    const pick = (n) => [...pool].sort(() => random() - 0.5).slice(0, n);
    const ordered = (ids) => {
      const tagged = ids.map((id) => [id, random() < 0.45 ? 'loved' : random() < 0.6 ? 'fine' : 'not_for_me']);
      const order = { loved: 0, fine: 1, not_for_me: 2 };
      return tagged.sort((a, b) => order[a[1]] - order[b[1]]);
    };
    await rank(me, ordered(pick(22)));
    const others = [];
    for (let i = 0; i < 10; i += 1) {
      const other = await user(`eq_${i}`);
      await rank(other, ordered(pick(6 + Math.floor(random() * 20))));
      others.push(other);
    }

    const { rows: batch } = await t.sql(`select * from _taste_matches($1, $2::uuid[])`, [me, others]);
    const byId = new Map(batch.map((row) => [row.other_id, row]));
    await t.actAs(me);
    for (const other of others) {
      const { rows } = await t.sql(`select * from taste_match($1)`, [other]);
      const single = rows[0];
      const mine = byId.get(other);
      assert.equal(mine?.common_count ?? 0, single.common_count, 'same overlap');
      assert.equal(mine?.score ?? null, single.score, `same score for ${other}`);
    }
  });

  /**
   * The random fixture above never puts two rows from one series in front of the formula, so
   * it passed against the pre-WS5 copy too. Here every person ranks several rows of one show:
   * two seasons of one show, and a whole show beside one of its own seasons
   * (20261114000400). `_taste_matches` must equal `taste_match` exactly, and its overlap must
   * be a count of series units, not of rows.
   */
  it('equals taste_match when one person ranks two seasons of a show, or a show and a season', async () => {
    let state = 11;
    const random = () => ((state = (state * 48271) % 2147483647) / 2147483647);
    const order = { loved: 0, fine: 1, not_for_me: 2 };
    const bucketOf = () => (random() < 0.45 ? 'loved' : random() < 0.6 ? 'fine' : 'not_for_me');
    const ordered = (ids) => ids.map((id) => [id, bucketOf()]).sort((a, b) => order[a[1]] - order[b[1]]);

    const filmsHere = await films(8, 'ws5');
    const showA = await t.createSeries(`ws5-a-${seq}`, seq++);
    const a1 = await t.createSeason(showA, 1, 'A1');
    const a2 = await t.createSeason(showA, 2, 'A2');
    const a3 = await t.createSeason(showA, 3, 'A3');
    const showB = await t.createSeries(`ws5-b-${seq}`, seq++);
    const b1 = await t.createSeason(showB, 1, 'B1');
    const showC = await t.createSeries(`ws5-c-${seq}`, seq++);

    const rankAll = async (who, { movies, seasons, shows }) => {
      await rank(who, ordered(movies));
      await rank(who, ordered(seasons), 'tv_seasons');
      await rank(who, ordered(shows), 'tv_shows');
    };
    const me = await user('ws5_reader');
    // Two seasons of A (three, in fact), and B ranked whole beside its own season.
    await rankAll(me, { movies: filmsHere, seasons: [a1, a2, a3, b1], shows: [showB, showC] });

    const others = [];
    const shapes = [
      { seasons: [a1, a2], shows: [] }, // two seasons of one show
      { seasons: [b1], shows: [showB] }, // a show and one of its seasons
      { seasons: [a1, a2, a3, b1], shows: [showB, showC] },
      { seasons: [a2, a3], shows: [showB] },
      { seasons: [a1, b1], shows: [showC, showB] },
      { seasons: [a1, a3, b1], shows: [] },
    ];
    for (const [i, shape] of shapes.entries()) {
      for (const movieCount of [3, 4, 8]) {
        const other = await user(`ws5_${i}_${movieCount}`);
        await rankAll(other, { movies: [...filmsHere].sort(() => random() - 0.5).slice(0, movieCount), ...shape });
        others.push(other);
      }
    }

    const { rows: batch } = await t.sql(`select * from _taste_matches($1, $2::uuid[])`, [me, others]);
    const byId = new Map(batch.map((row) => [row.other_id, row]));
    await t.actAs(me);
    let scored = 0;
    let fewerUnitsThanRows = 0;
    for (const other of others) {
      const single = (await t.sql(`select * from taste_match($1)`, [other])).rows[0];
      const mine = byId.get(other);
      assert.equal(mine?.common_count ?? 0, single.common_count, `same unit count for ${other}`);
      assert.equal(mine?.score ?? null, single.score, `same score for ${other}`);
      if (single.score != null) scored += 1;
      const { rows } = await t.sql(
        `select count(*)::int as n from rankings a join rankings b on b.media_item_id = a.media_item_id
          where a.user_id = $1 and b.user_id = $2`,
        [me, other],
      );
      if (rows[0].n > single.common_count) fewerUnitsThanRows += 1;
    }
    await t.actAs(null);
    assert.ok(scored >= 6, `the fixture produces real scores (${scored})`);
    assert.equal(fewerUnitsThanRows, others.length, 'every pair shares more rows than series units');
  });

  it('scores a row the same whether or not the category and title filters are used', async () => {
    const people = [reader, ...(await t.sql(`select user_id from rankings group by user_id limit 6`)).rows.map((r) => r.user_id)];
    const key = (row) => `${row.user_id}:${row.media_item_id}`;
    const all = new Map(
      (await t.sql(`select * from _scored_rankings($1::uuid[])`, [people])).rows.map((row) => [key(row), String(row.score)]),
    );
    const movies = (await t.sql(`select * from _scored_rankings($1::uuid[], 'movies')`, [people])).rows;
    assert.ok(movies.length > 0);
    for (const row of movies) assert.equal(String(row.score), all.get(key(row)));
    const items = shared.slice(0, 5);
    const some = (await t.sql(`select * from _scored_rankings($1::uuid[], null, $2::uuid[])`, [people, items])).rows;
    assert.ok(some.length > 0);
    for (const row of some) {
      assert.ok(items.includes(row.media_item_id));
      assert.equal(String(row.score), all.get(key(row)), 'band sizes come from the whole category');
    }
  });
});

describe('collaborative_candidates', () => {
  it('answers nothing unless the engine is v2_hybrid', async () => {
    await twin('off_a', { loves: [extra[0]] });
    await twin('off_b', { loves: [extra[0]] });
    assert.equal((await collaborative(reader)).length, 0);
    await enable('v2_metadata');
    assert.equal((await collaborative(reader)).length, 0);
    const { rows } = await t.sql(`select count(*)::int as n from taste_neighbours where reader_id = $1`, [reader]);
    assert.equal(rows[0].n, 0, 'the cache is never filled while off');
  });

  it("recommends what taste-compatible strangers loved, as ids and an aggregate only", async () => {
    await twin('s_a', { loves: [extra[1]] });
    await twin('s_b', { loves: [extra[1]] });
    await enable();
    const rows = await collaborative(reader);
    const hit = rows.find((row) => row.media_item_id === extra[1]);
    assert.ok(hit, 'a title two twins loved is a candidate');
    assert.equal(hit.endorsers, 2);
    assert.ok(hit.support > 0 && hit.support <= 1);
    assert.deepEqual(Object.keys(hit).sort(), ['endorsers', 'media_item_id', 'support']);
    // The reader's own titles never come back.
    for (const row of rows) assert.ok(!shared.includes(row.media_item_id));
  });

  it("never surfaces a title on one person's say-so", async () => {
    await twin('one_a', { loves: [extra[2]] });
    await twin('one_b');
    await enable();
    assert.ok(!(await collaborative(reader)).some((row) => row.media_item_id === extra[2]));
  });

  it("lets neighbours' dislikes count against a title", async () => {
    const lovers = [await twin('neg_l1', { loves: [extra[3]] }), await twin('neg_l2', { loves: [extra[3]] })];
    await enable();
    const before = (await collaborative(reader)).find((row) => row.media_item_id === extra[3]);
    assert.ok(before);
    for (let i = 0; i < 4; i += 1) await twin(`neg_h${i}`, { hates: [extra[3]] });
    await forceRefresh(reader);
    const after = (await collaborative(reader)).find((row) => row.media_item_id === extra[3]);
    assert.ok(!after || after.support < before.support, 'four dislikes outweigh two loves');
    assert.equal(lovers.length, 2);
  });

  it("returns what two neighbours disliked as evidence against it, never on one person's say-so", async () => {
    await twin('dis_a', { hates: [extra[5]] });
    await enable();
    assert.ok(!(await collaborative(reader)).some((row) => row.media_item_id === extra[5]), 'one dislike is not a row');
    await twin('dis_b', { hates: [extra[5]] });
    await forceRefresh(reader);
    const row = (await collaborative(reader)).find((r) => r.media_item_id === extra[5]);
    assert.ok(row, 'two dislikes are');
    assert.ok(row.support < 0, 'and the support says which way');
    assert.equal(row.endorsers, 0);
  });

  it('gives a low-compatibility account no weight rather than opposite weight', async () => {
    const opposite = await user('opposite');
    const order = bucketsFor(20);
    // Reverse opinions on every shared title, and loves of two extras.
    const reversed = shared.map((m, i) => [m, order[19 - i]]);
    const sorted = reversed.sort(
      (a, b) => ['loved', 'fine', 'not_for_me'].indexOf(a[1]) - ['loved', 'fine', 'not_for_me'].indexOf(b[1]),
    );
    await rank(opposite, [[extra[4], 'loved'], ...sorted]);
    await twin('opp_twin', { loves: [extra[4]] });
    await enable();
    await collaborative(reader);
    const cached = await neighbours(reader);
    assert.ok(!cached.some((row) => row.neighbour_id === opposite), 'not a neighbour at all');
    assert.ok(!(await collaborative(reader)).some((row) => row.media_item_id === extra[4]));
  });
});

describe('following has no effect', () => {
  it('weighs a followed neighbour exactly like an unfollowed one with the same taste', async () => {
    const followed = await twin('f_followed', { loves: [extra[5]] });
    const stranger = await twin('f_stranger', { loves: [extra[5]] });
    await enable();
    const without = await collaborative(reader);
    const weightsWithout = await neighbours(reader);

    await t.sql(`insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`, [reader, followed]);
    await forceRefresh(reader);
    const withFollow = await collaborative(reader);
    const weightsWith = await neighbours(reader);

    assert.deepEqual(withFollow, without);
    assert.deepEqual(weightsWith, weightsWithout);
    const byId = new Map(weightsWith.map((row) => [row.neighbour_id, row.weight]));
    assert.equal(byId.get(followed), byId.get(stranger));
  });

  it('never counts a private account, even one the reader follows', async () => {
    const title = (await films(1, 'hidden'))[0];
    const hidden = await twin('p_private', { visibility: 'private', loves: [title] });
    await twin('p_public', { loves: [title] });
    await t.sql(`insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`, [reader, hidden]);
    await enable();
    await collaborative(reader);
    assert.ok(!(await neighbours(reader)).some((row) => row.neighbour_id === hidden));
    assert.ok(!(await collaborative(reader)).some((row) => row.media_item_id === title), 'one public lover is not enough');
  });
});

describe('restricted accounts drop out at read time, cached or not', () => {
  it('drops a neighbour who blocks the reader, or whom the reader blocks, without a refresh', async () => {
    const title = (await films(1, 'blk'))[0];
    const a = await twin('b_a', { loves: [title] });
    const b = await twin('b_b', { loves: [title] });
    await enable();
    assert.ok((await collaborative(reader)).some((row) => row.media_item_id === title));

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [a, reader]);
    assert.ok(!(await collaborative(reader)).some((row) => row.media_item_id === title), 'blocked by a neighbour');
    await t.sql(`delete from blocks where blocker_id = $1`, [a]);

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [reader, b]);
    assert.ok(!(await collaborative(reader)).some((row) => row.media_item_id === title), 'neighbour blocked');
    await t.sql(`delete from blocks where blocker_id = $1`, [reader]);
  });

  it('drops a neighbour who goes private or is suspended, without a refresh', async () => {
    const title = (await films(1, 'priv'))[0];
    const a = await twin('v_a', { loves: [title] });
    await twin('v_b', { loves: [title] });
    await enable();
    assert.ok((await collaborative(reader)).some((row) => row.media_item_id === title));

    await t.sql(`update profiles set visibility = 'private' where id = $1`, [a]);
    assert.ok(!(await collaborative(reader)).some((row) => row.media_item_id === title));
    await t.sql(`update profiles set visibility = 'public', status = 'suspended' where id = $1`, [a]);
    assert.ok(!(await collaborative(reader)).some((row) => row.media_item_id === title));
    await t.sql(`update profiles set status = 'active' where id = $1`, [a]);
  });
});

describe('bounds and caching', () => {
  it('caches for the TTL and keeps at most the neighbour limit', async () => {
    for (let i = 0; i < 6; i += 1) await twin(`c_${i}`);
    await setConfig('recommendations.neighbour_limit', 3);
    await enable();
    await collaborative(reader);
    const first = await neighbours(reader);
    assert.ok(first.length <= 3 && first.length > 0);
    const { rows: stamp } = await t.sql(`select refreshed_at from taste_neighbour_refresh where reader_id = $1`, [reader]);
    await collaborative(reader);
    const { rows: again } = await t.sql(`select refreshed_at from taste_neighbour_refresh where reader_id = $1`, [reader]);
    assert.equal(String(again[0].refreshed_at), String(stamp[0].refreshed_at), 'no refresh inside the TTL');
    await setConfig('recommendations.neighbour_limit', 40);
  });

  it('retries a pass that found nobody after three hours, not a whole TTL', async () => {
    const loner = await user('loner');
    await rank(loner, (await films(6, 'loner')).map((id) => [id, 'loved']));
    await enable('v2_hybrid', [loner]);
    await collaborative(loner);
    const stamp = async () =>
      String((await t.sql(`select refreshed_at, neighbours from taste_neighbour_refresh where reader_id = $1`, [loner])).rows[0].refreshed_at);
    const first = await stamp();
    await t.sql(`update taste_neighbour_refresh set refreshed_at = now() - interval '2 hours' where reader_id = $1`, [loner]);
    const twoHours = await stamp();
    await collaborative(loner);
    assert.equal(await stamp(), twoHours, 'two hours on, an empty result is still fresh');
    await t.sql(`update taste_neighbour_refresh set refreshed_at = now() - interval '4 hours' where reader_id = $1`, [loner]);
    await collaborative(loner);
    assert.notEqual(await stamp(), twoHours, 'four hours on, it is computed again');
    assert.ok(first);
  });

  it('runs the allowlist on its own engine while the percentage cohort stays on v2_engine', async () => {
    await twin('ovr_a', { loves: [extra[1]] });
    await twin('ovr_b', { loves: [extra[1]] });
    const bystander = await user('ovr_bystander');
    await setConfig('recommendations.v2_engine', 'v2_metadata');
    await setConfig('recommendations.v2_rollout_percent', 100);
    await setConfig('recommendations.v2_allowlist', [reader]);
    await setConfig('recommendations.v2_allowlist_engine', 'v2_hybrid');
    try {
      await t.actAs(reader);
      assert.equal((await t.sql(`select recommendation_engine() as e`)).rows[0].e, 'v2_hybrid');
      await t.actAs(bystander);
      assert.equal((await t.sql(`select recommendation_engine() as e`)).rows[0].e, 'v2_metadata');
      assert.ok((await collaborative(reader)).some((row) => row.media_item_id === extra[1]));
      assert.equal((await collaborative(bystander)).length, 0, 'the cohort is not on the hybrid');
    } finally {
      await setConfig('recommendations.v2_allowlist_engine', null);
    }
  });

  it('samples a bounded number of raters per title', async () => {
    // Thirty people who ranked the same five films exactly as `me` did: every one of them
    // would qualify. With five raters sampled per title, at most five can be found.
    const five = await films(5, 'pop');
    const me = await user('bounded');
    await rank(me, five.map((id) => [id, 'loved']));
    for (let i = 0; i < 30; i += 1) {
      const id = await user(`r_${i}`);
      await rank(id, five.map((m) => [m, 'loved']));
    }
    await setConfig('recommendations.neighbour_raters_per_title', 5);
    await t.sql(`select _refresh_taste_neighbours($1)`, [me]);
    const sampled = (await neighbours(me)).length;
    assert.ok(sampled > 0 && sampled <= 5, `found ${sampled} with five per title`);

    await setConfig('recommendations.neighbour_raters_per_title', 50);
    await t.sql(`select _refresh_taste_neighbours($1)`, [me]);
    assert.equal((await neighbours(me)).length, 30, 'and all thirty when the sample covers them');
  });

  it('is refused to anon, and its internals to everybody', async () => {
    const refused = await t.asAnon(() => t.errorFrom(`select * from collaborative_candidates('movie', 10)`));
    assert.match(String(refused?.message), /permission denied/);
    for (const call of [
      `select * from _taste_matches('${reader}', '{}'::uuid[])`,
      `select _refresh_taste_neighbours('${reader}')`,
      `select * from _scored_rankings('{}'::uuid[])`,
      `select * from taste_neighbours`,
    ]) {
      const error = await t.asUser(reader, () => t.errorFrom(call));
      assert.match(String(error?.message), /permission denied/, call);
    }
  });
});

describe('television', () => {
  it("rolls a neighbour's seasons up to the show, once per neighbour", async () => {
    const show = await t.createSeries(`tn-show-${seq}`, seq++);
    const s1 = await t.createSeason(show, 1, 'S1');
    const s2 = await t.createSeason(show, 2, 'S2');
    const a = await twin('tv_a');
    const b = await twin('tv_b');
    await rank(a, [[s1, 'loved'], [s2, 'loved']], 'tv_seasons');
    await rank(b, [[s2, 'loved']], 'tv_seasons');
    await enable();
    const rows = await collaborative(reader, 'series');
    const hit = rows.find((row) => row.media_item_id === show);
    assert.ok(hit, 'the show, not a season');
    assert.equal(hit.endorsers, 2, 'two seasons from one neighbour count once');
    assert.ok(!rows.some((row) => row.media_item_id === s1 || row.media_item_id === s2));
    assert.ok(!(await collaborative(reader, 'movie')).some((row) => row.media_item_id === show));
  });

  it("reads a neighbour's whole-show ranking (tv_shows), not only their seasons", async () => {
    const show = await t.createSeries(`tn-whole-${seq}`, seq++);
    const a = await twin('whole_a');
    const b = await twin('whole_b');
    await rank(a, [[show, 'loved']], 'tv_shows');
    await rank(b, [[show, 'loved']], 'tv_shows');
    await enable();
    const hit = (await collaborative(reader, 'series')).find((row) => row.media_item_id === show);
    assert.ok(hit, 'two neighbours who ranked the show whole endorse it');
    assert.equal(hit.endorsers, 2);
    assert.ok(!(await collaborative(reader, 'movie')).some((row) => row.media_item_id === show));
  });

  it('counts a neighbour once per series when they ranked the show whole and its seasons', async () => {
    const show = await t.createSeries(`tn-unit-${seq}`, seq++);
    const s1 = await t.createSeason(show, 1, 'S1');
    const s2 = await t.createSeason(show, 2, 'S2');
    const a = await twin('unit_a');
    const b = await twin('unit_b');
    await rank(a, [[show, 'loved']], 'tv_shows');
    await rank(a, [[s1, 'loved'], [s2, 'loved']], 'tv_seasons');
    await rank(b, [[show, 'loved']], 'tv_shows');
    await rank(b, [[s1, 'loved']], 'tv_seasons');
    await enable();
    const hit = (await collaborative(reader, 'series')).find((row) => row.media_item_id === show);
    assert.ok(hit);
    assert.equal(hit.endorsers, 2, 'two people, five rows, two opinions');
  });

  it("takes a neighbour's whole-show ranking as their opinion of the show over a season", async () => {
    const show = await t.createSeries(`tn-pref-${seq}`, seq++);
    const s1 = await t.createSeason(show, 1, 'S1');
    const a = await twin('pref_a');
    const b = await twin('pref_b');
    for (const who of [a, b]) {
      // Loved one season, and ranked the show as a whole Not for me.
      await rank(who, [[s1, 'loved']], 'tv_seasons');
      await rank(who, [[show, 'not_for_me']], 'tv_shows');
    }
    await enable();
    const hit = (await collaborative(reader, 'series')).find((row) => row.media_item_id === show);
    assert.ok(hit, 'a disputed row: evidence against the show');
    assert.ok(hit.support < 0, `support ${hit.support}`);
    assert.equal(hit.endorsers, 0);
  });
});
