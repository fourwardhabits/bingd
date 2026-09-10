import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The first-run picker's supply of movies (20260915000100).
 *
 * The founder exhausted the old trending grid after four titles on a physical device, so
 * the properties this file defends are the two the replacement was written for:
 *
 *   - **it does not run out.** A limit that cannot be filled from ranked titles is filled
 *     from the catalogue, and the caller can tell which is which.
 *   - **it does not lead with a fluke.** A 10.0 carried by one rating never appears above
 *     a broadly ranked title, whatever the percentile arithmetic works out to.
 *
 * As with `top-rated.test.mjs`, the load-bearing assertion is not any single number: it is
 * that the community half agrees with `community_score` title by title. Two functions
 * computing a community score is the one outcome the migration forbids.
 */

let t;

/** Distinct negative tmdb ids, so no fixture can collide with the seed catalogue. */
let seq = 910000;
const movie = async (title, db = t) => db.createMovie(title, seq++);

/** A movie the fallback is allowed to offer: it needs artwork and a popularity to sort by. */
const catalogueMovie = async (title, popularity, db = t) => {
  const id = await movie(title, db);
  await db.sql(`update media_items set poster_path = $2, popularity = $3 where id = $1`, [
    id,
    `/${title.replace(/\W/g, '')}.jpg`,
    popularity,
  ]);
  return id;
};

/** Ranks to completion always letting the incumbent win, so arrival order is rank order. */
const rankBelow = (id, bucket, db = t) =>
  db.rankToCompletion(id, bucket, async (pivot) => pivot);

const starters = async (limit = 60, db = t) =>
  (await db.sql(`select * from starter_movies($1)`, [limit])).rows;

/**
 * A database of this test's own.
 *
 * **Eligibility here is a fact about the whole platform**, not about one fixture: the
 * threshold is a percentile over every ranked movie in the database, so a title's
 * admission depends on what every *other* test put there. Two of the cases below are
 * about that arithmetic and cannot share a population with anything, so they build their
 * own — which is also the only honest way to assert an empty community half.
 */
const ownDatabase = async (body) => {
  const db = await createTestDb();
  try {
    await body(db);
  } finally {
    await db.close();
  }
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

describe('starter_movies', () => {
  it('leads with the broadly ranked titles, in score order, agreeing with community_score', async () => {
    const raters = [];
    for (let i = 0; i < 6; i += 1) {
      raters.push(await t.createUser({ username: `starter${i}` }));
    }

    const best = await movie('Broadly Loved');
    const second = await movie('Broadly Liked');

    for (const who of raters) {
      await t.actAs(who);
      await rankBelow(best, 'loved');
      await rankBelow(second, 'fine');
    }

    // A seventh account with nothing ranked, so the caller's own exclusions cannot
    // explain any of the ordering below.
    const reader = await t.createUser({ username: 'starterreader' });
    await t.actAs(reader);

    const rows = await starters();
    const community = rows.filter((row) => row.source === 'community');

    assert.equal(community[0].media_item_id, best);
    assert.equal(community[1].media_item_id, second);
    assert.ok(Number(community[0].score) > Number(community[1].score));

    // The assertion this file exists for.
    for (const row of community) {
      const { rows: one } = await t.sql(`select * from community_score($1)`, [row.media_item_id]);
      assert.equal(
        Number(one[0].score),
        Number(row.score),
        `disagreed with community_score on ${row.media_item_id}`,
      );
      assert.equal(one[0].rating_count, row.rating_count);
    }
  });

  it('refuses a perfect score carried by fewer ratings than the floor', async () => {
    /**
     * The founder's rule in one assertion: *do not surface a 10.0 based on one rating
     * ahead of broadly-ranked titles.* The fluke is built to win on every other axis —
     * it is `loved`, alone in its band, so it scores 10.0, which is the highest number
     * the ordering knows.
     */
    const solo = await t.createUser({ username: 'lonevoice' });
    const fluke = await movie('One Persons Ten');
    await t.actAs(solo);
    await rankBelow(fluke, 'loved');

    const reader = await t.createUser({ username: 'flukereader' });
    await t.actAs(reader);
    const rows = await starters();

    const row = rows.find((r) => r.media_item_id === fluke);
    assert.ok(
      !row || row.source === 'popularity',
      'one rating cannot put a title in the community half',
    );
    assert.ok(
      rows.filter((r) => r.source === 'community').length > 0,
      'and the community half is not empty, so the refusal is the rule and not a shortage',
    );
  });

  it('applies max(90th percentile, the floor) and reports the threshold it used', async () => {
    /**
     * The percentile is the half that cannot be asserted with a fixed number, because it
     * moves with the data. So it is asserted as a *relationship*: a title whose count is
     * below the ninetieth percentile of the ranked population is out even though it
     * clears the floor comfortably.
     *
     * Sixteen raters, one title ranked by all of them and one by five. Five is above the
     * floor of three and below any sensible ninetieth percentile of a population whose
     * top member has sixteen.
     */
    await ownDatabase(async (db) => {
      const raters = [];
      for (let i = 0; i < 16; i += 1) {
        raters.push(await db.createUser({ username: `pct${i}` }));
      }

      const everybody = await movie('Everybody Ranked This', db);
      const handful = await movie('Five People Ranked This', db);
      // Something for the fallback to answer with, so an empty community half is still a
      // list and the threshold it reports can be read off it.
      await catalogueMovie('Percentile Filler', 50, db);

      for (const [index, who] of raters.entries()) {
        await db.actAs(who);
        await rankBelow(everybody, 'fine', db);
        if (index < 5) await rankBelow(handful, 'loved', db);
      }

      const reader = await db.createUser({ username: 'pctreader' });
      await db.actAs(reader);
      const rows = await starters(60, db);
      const community = rows.filter((row) => row.source === 'community');
      const ids = community.map((row) => row.media_item_id);

      assert.ok(ids.includes(everybody), 'the most-ranked title is eligible');
      assert.ok(
        !ids.includes(handful),
        'five ratings is over the floor and under the percentile, so it is not eligible',
      );

      const threshold = rows[0].min_ratings;
      assert.ok(
        threshold > 5,
        `the applied threshold is the percentile, not the floor (${threshold})`,
      );
      assert.ok(
        rows.every((row) => row.min_ratings === threshold),
        'and every row reports the same one',
      );

      // The floor is a config row rather than a literal, and it is a floor: raising it
      // above the percentile is what makes it bite.
      await db.sql(
        `update app_config set value = '99'::jsonb where key = 'discovery.starter_min_ratings'`,
      );
      const raised = await starters(60, db);
      assert.equal(
        raised.filter((row) => row.source === 'community').length,
        0,
        'a floor above every count empties the community half',
      );
      assert.ok(raised.length > 0, 'and the fallback answers instead of an empty screen');
      assert.equal(raised[0].min_ratings, 99, 'the reported threshold is the floor');
    });
  });

  it('tops the list up from the catalogue rather than returning a short one', async () => {
    /**
     * The defect in one test. Whatever the ranked population looks like, a picker that
     * asks for twenty movies gets twenty movies.
     */
    for (let i = 0; i < 30; i += 1) {
      await catalogueMovie(`Popular Fixture ${i}`, 100 - i);
    }

    const reader = await t.createUser({ username: 'topupreader' });
    await t.actAs(reader);
    const rows = await starters(20);

    assert.equal(rows.length, 20);
    assert.ok(
      rows.some((row) => row.source === 'popularity'),
      'the shortfall came from the catalogue',
    );

    // The community rows lead, and the catalogue rows follow in popularity order.
    const tiers = rows.map((row) => (row.source === 'community' ? 0 : 1));
    assert.deepEqual(tiers, [...tiers].sort(), 'community rows are not interleaved');

    const fallback = rows.filter((row) => row.source === 'popularity');
    const { rows: byPopularity } = await t.sql(
      `select id from media_items
        where id = any($1::uuid[])
        order by popularity desc nulls last, id asc`,
      [fallback.map((row) => row.media_item_id)],
    );
    assert.deepEqual(
      fallback.map((row) => row.media_item_id),
      byPopularity.map((row) => row.id),
      'the catalogue half is in popularity order',
    );

    assert.ok(
      fallback.every((row) => row.score === null),
      'a catalogue row claims no community score',
    );
  });

  it('never offers a movie the caller has already ranked', async () => {
    const reader = await t.createUser({ username: 'alreadyranked' });
    await t.actAs(reader);

    const before = await starters(20);
    assert.ok(before.length > 0);
    const target = before[0].media_item_id;

    await rankBelow(target, 'loved');

    const after = await starters(20);
    assert.ok(
      !after.some((row) => row.media_item_id === target),
      'a ranked title leaves the picker',
    );
    assert.equal(after.length, 20, 'and the list is still full');
  });

  it('offers only movies', async () => {
    const series = await t.createSeries('Not A Movie', seq++);
    await t.sql(`update media_items set poster_path = '/s.jpg', popularity = 999 where id = $1`, [
      series,
    ]);
    const season = await t.createSeason(series, 1, 'Not A Movie: Season 1');
    await t.sql(`update media_items set poster_path = '/s1.jpg', popularity = 998 where id = $1`, [
      season,
    ]);

    const reader = await t.createUser({ username: 'moviesonly' });
    await t.actAs(reader);
    const ids = (await starters(50)).map((row) => row.media_item_id);

    assert.ok(!ids.includes(series), 'a series is not rankable and is not offered');
    assert.ok(!ids.includes(season), 'and a season is not a movie');
  });

  it('counts the same population community_score does, and refuses an anonymous caller', async () => {
    await ownDatabase(async (db) => {
      const raters = [];
      for (let i = 0; i < 8; i += 1) {
        raters.push(await db.createUser({ username: `pop2${i}` }));
      }
      const hidden = await db.createUser({ username: 'hiddenstarter', visibility: 'private' });

      const film = await movie('Counted Once Only', db);
      for (const who of raters) {
        await db.actAs(who);
        await rankBelow(film, 'loved', db);
      }
      await db.actAs(hidden);
      await rankBelow(film, 'not_for_me', db);

      // Asked by somebody who has ranked nothing: every rater above has ranked `film`,
      // and this function does not offer a title back to the person who ranked it.
      const reader = await db.createUser({ username: 'populationreader' });
      await db.actAs(reader);
      const row = (await starters(60, db)).find((r) => r.media_item_id === film);
      assert.equal(row.rating_count, 8, 'the private account is not in the population');
    });

    // `security definer` over rankings and profiles, so the identity check is not
    // decoration. `function-grants.test.mjs` asserts the grant; this asserts the guard
    // inside the body, which is what answers a session that reached it another way.
    const error = await t.asAnon(() => t.errorFrom(`select * from starter_movies(5)`));
    assert.ok(error, 'an anonymous caller is refused');
  });
});
