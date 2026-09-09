import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Top Rated: the catalogue in community-score order (20260913000100).
 *
 * The function under test exists because `community_score` answers about one title and
 * a wall needs the same answer about all of them. So the load-bearing assertion in this
 * file is not any single number — it is that the two functions **agree**, title by
 * title, over collections built by the real ranking engine. If they ever disagree the
 * product has two community scores, which is the one outcome the migration's header
 * forbids.
 *
 * Everything else here is the properties a paginated wall has to have: a total order
 * that never repeats or skips a row, a threshold that is a floor rather than a
 * suggestion, and a population that is exactly `community_score`'s.
 */

let t;

/** Distinct negative tmdb ids, so no fixture can collide with the seed catalogue. */
let seq = 810000;
const movie = (title) => t.createMovie(title, seq++);

/** Ranks to completion always letting the incumbent win, so arrival order is rank order. */
const rankBelow = (id, bucket) => t.rankToCompletion(id, bucket, async (pivot) => pivot);

const topRated = async (medium, limit = 20, cursor = null) =>
  (
    await t.sql(`select * from top_rated_titles($1, $2, $3, $4, $5)`, [
      medium,
      limit,
      cursor?.score ?? null,
      cursor?.rating_count ?? null,
      cursor?.media_item_id ?? null,
    ])
  ).rows;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

describe('top_rated_titles', () => {
  it('orders by the community score, and agrees with community_score on every row', async () => {
    const raters = [];
    for (let i = 0; i < 5; i += 1) {
      raters.push(await t.createUser({ username: `agree${i}` }));
    }

    const best = await movie('The Best One');
    const second = await movie('The Second One');

    // Everybody loves both and places the best one first, so it holds the band high.
    for (const who of raters) {
      await t.actAs(who);
      await rankBelow(best, 'loved');
      await rankBelow(second, 'loved');
    }

    await t.actAs(raters[0]);
    const rows = await topRated('movies');

    assert.equal(rows[0].media_item_id, best);
    assert.equal(rows[1].media_item_id, second);
    assert.ok(Number(rows[0].score) > Number(rows[1].score));

    // The assertion this file exists for.
    for (const row of rows) {
      const { rows: one } = await t.sql(`select * from community_score($1)`, [
        row.media_item_id,
      ]);
      assert.equal(
        Number(one[0].score),
        Number(row.score),
        `disagreed with community_score on ${row.media_item_id}`,
      );
      assert.equal(one[0].rating_count, row.rating_count);
    }
  });

  it('admits a title at the threshold and refuses the one below it', async () => {
    // The boundary the founder set: five ratings, not four. Both titles are built the
    // same way and differ only in how many people rated them, so nothing but the count
    // can explain the difference in the answer.
    const raters = [];
    for (let i = 0; i < 5; i += 1) {
      raters.push(await t.createUser({ username: `bound${i}` }));
    }

    const four = await movie('Four Ratings');
    const five = await movie('Five Ratings');

    for (const [index, who] of raters.entries()) {
      await t.actAs(who);
      await rankBelow(five, 'fine');
      if (index < 4) await rankBelow(four, 'fine');
    }

    await t.actAs(raters[0]);
    const ids = (await topRated('movies')).map((row) => row.media_item_id);

    assert.ok(ids.includes(five), 'five ratings is enough');
    assert.ok(!ids.includes(four), 'four ratings is not');

    // And the floor is the config row rather than a literal, so moving it moves the wall.
    await t.sql(
      `update app_config set value = '4'::jsonb where key = 'discovery.top_rated_min_ratings'`,
    );
    const relaxed = (await topRated('movies')).map((row) => row.media_item_id);
    assert.ok(relaxed.includes(four), 'lowering the config row admits the four-rating title');
    await t.sql(
      `update app_config set value = '5'::jsonb where key = 'discovery.top_rated_min_ratings'`,
    );
  });

  it('reports the threshold it applied, and does not read the display threshold', async () => {
    const who = await t.createUser({ username: 'thresholdreader' });
    await t.actAs(who);

    // `score.community_min_ratings` is the *title page's* number and is 1. If this
    // function ever read it, a single rating would put a title on the wall.
    await t.sql(
      `update app_config set value = '1'::jsonb where key = 'score.community_min_ratings'`,
    );
    const solo = await movie('One Rating Only');
    await rankBelow(solo, 'loved');

    const rows = await topRated('movies');
    assert.ok(!rows.some((row) => row.media_item_id === solo), 'one rating is not five');
    assert.ok(rows.every((row) => row.min_ratings === 5));
  });

  it('counts public active accounts only, exactly as community_score does', async () => {
    const publicRaters = [];
    for (let i = 0; i < 5; i += 1) {
      publicRaters.push(await t.createUser({ username: `pop${i}` }));
    }
    const hidden = await t.createUser({ username: 'hiddenone', visibility: 'private' });

    const film = await movie('Counted Once');
    for (const who of publicRaters) {
      await t.actAs(who);
      await rankBelow(film, 'loved');
    }
    await t.actAs(hidden);
    await rankBelow(film, 'not_for_me');

    await t.actAs(publicRaters[0]);
    const row = (await topRated('movies')).find((r) => r.media_item_id === film);
    assert.equal(row.rating_count, 5, 'the private account is not in the population');
    assert.equal(Number(row.score), 10, 'and so cannot drag the mean down');

    /**
     * And the other half of the population clause, which had no test: `status = 'active'`.
     * Visibility and status are separate columns and a filter can lose one of them
     * without the other noticing, so a suspended *public* account is the case that
     * distinguishes them. It is also the direction that matters for moderation — a
     * suspended account's ratings must stop counting towards what everybody is shown.
     */
    const suspended = await t.createUser({ username: 'suspendedrater' });
    await t.actAs(suspended);
    await rankBelow(film, 'not_for_me');
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);

    await t.actAs(publicRaters[0]);
    const afterSuspension = (await topRated('movies')).find((r) => r.media_item_id === film);
    assert.equal(afterSuspension.rating_count, 5, 'a suspended account is not in the population');
    assert.equal(Number(afterSuspension.score), 10, 'and so cannot drag the mean down either');
  });

  it('excludes a blocked account from both directions, like the single-title read', async () => {
    const raters = [];
    for (let i = 0; i < 5; i += 1) {
      raters.push(await t.createUser({ username: `blockpop${i}` }));
    }
    const viewer = raters[0];
    const blocked = raters[4];

    const film = await movie('Blocked Population');
    for (const who of raters) {
      await t.actAs(who);
      await rankBelow(film, 'loved');
    }

    await t.actAs(viewer);
    const before = (await topRated('movies')).find((r) => r.media_item_id === film);
    assert.equal(before.rating_count, 5);

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
      viewer,
      blocked,
    ]);

    await t.actAs(viewer);
    const after = (await topRated('movies')).find((r) => r.media_item_id === film);
    // Four is below the threshold, so the title leaves the wall entirely for this
    // viewer. That is the honest consequence of the population shrinking, and it is
    // `community_score`'s behaviour too.
    assert.equal(after, undefined);

    await t.sql(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [
      viewer,
      blocked,
    ]);
  });

  it('answers for TV with seasons and never with a series', async () => {
    const raters = [];
    for (let i = 0; i < 5; i += 1) raters.push(await t.createUser({ username: `tvfan${i}` }));

    const show = await t.createSeries('A Show', seq++);
    const season = await t.createSeason(show, 1, 'Season 1');

    for (const who of raters) {
      await t.actAs(who);
      await rankBelow(season, 'loved');
    }

    await t.actAs(raters[0]);
    const tv = await topRated('tv');
    assert.ok(
      tv.some((row) => row.media_item_id === season),
      'the season is the rankable unit and is on the wall',
    );
    assert.ok(
      !tv.some((row) => row.media_item_id === show),
      'a series has no ranking and must never appear',
    );

    // And the two media do not leak into each other.
    const movies = await topRated('movies');
    assert.ok(!movies.some((row) => row.media_item_id === season));
  });

  it('pages without repeating or skipping a row', async () => {
    const raters = [];
    for (let i = 0; i < 5; i += 1) raters.push(await t.createUser({ username: `pager${i}` }));

    // Six films, each rated by everyone, in a deliberate order so the scores spread.
    const films = [];
    for (let i = 0; i < 6; i += 1) films.push(await movie(`Paged ${i}`));
    for (const who of raters) {
      await t.actAs(who);
      for (const film of films) await rankBelow(film, 'loved');
    }

    await t.actAs(raters[0]);
    const all = await topRated('movies', 50);

    const walked = [];
    let cursor = null;
    for (let page = 0; page < 40; page += 1) {
      const rows = await topRated('movies', 2, cursor);
      if (rows.length === 0) break;
      walked.push(...rows.map((row) => row.media_item_id));
      cursor = rows[rows.length - 1];
    }

    assert.deepEqual(
      walked,
      all.map((row) => row.media_item_id),
      'walking the cursor two at a time is the same list as asking for it at once',
    );
    assert.equal(new Set(walked).size, walked.length, 'no row is returned twice');
  });

  it('breaks a genuine score and count tie on the immutable id', async () => {
    /**
     * The tie has to be *built*, and the first version of this test did not build one.
     *
     * It gave one film to `fine` and the other to `not_for_me` in the same five
     * collections, which scores them 6.9 and 3.4 — never equal — and then guarded its
     * only ordering assertion behind `if (scores are equal)`. The assertion therefore
     * never ran, and an implementation with the tie-break reversed, or with no
     * tie-break at all, passed it. Independent review, 2026-09-09.
     *
     * A real tie needs equal scores *and* equal counts from disjoint raters: each film
     * alone in its rater's `loved` band, so `score_for` returns the band high of 10.0
     * for a band of one, and five raters each. Nothing but the id can separate them.
     */
    const left = [];
    const right = [];
    for (let i = 0; i < 5; i += 1) left.push(await t.createUser({ username: `tieleft${i}` }));
    for (let i = 0; i < 5; i += 1) right.push(await t.createUser({ username: `tieright${i}` }));

    const one = await movie('Tie One');
    const two = await movie('Tie Two');
    for (const who of left) {
      await t.actAs(who);
      await rankBelow(one, 'loved');
    }
    for (const who of right) {
      await t.actAs(who);
      await rankBelow(two, 'loved');
    }

    await t.actAs(left[0]);
    const rows = await topRated('movies', 50);
    const tied = rows.filter((row) => row.media_item_id === one || row.media_item_id === two);
    assert.equal(tied.length, 2);

    // The tie is asserted rather than assumed: if a future change stops these two
    // scoring identically, this fails here instead of silently skipping the real check.
    assert.equal(Number(tied[0].score), Number(tied[1].score), 'the scores must actually tie');
    assert.equal(tied[0].rating_count, tied[1].rating_count, 'and so must the counts');
    assert.equal(Number(tied[0].score), 10, 'a band of one scores its high');

    // Unconditional, and in the direction the migration commits to: ascending id.
    assert.ok(
      tied[0].media_item_id < tied[1].media_item_id,
      'a genuine tie is broken by the ascending id',
    );

    /**
     * And the tie-break is stable across a page boundary, which is where a sort that
     * disagreed with its own cursor would actually hurt.
     *
     * Asserted against the *full* ordering rather than against `tied[1]` directly: other
     * fixtures in this file also score 10.0 from five raters, so the row after the first
     * of these two is not necessarily the second of them. What must hold is that
     * continuing from a row inside a tied run returns exactly the row the uncursored
     * ordering puts next — which is the claim a cursor makes.
     */
    const whole = await topRated('movies', 50);
    const at = whole.findIndex((r) => r.media_item_id === tied[0].media_item_id);
    assert.ok(at >= 0 && at + 1 < whole.length, 'the tie is not the last row of the wall');
    const walked = await topRated('movies', 1, whole[at]);
    assert.equal(
      walked[0].media_item_id,
      whole[at + 1].media_item_id,
      'continuing from inside a tied run returns the row the full ordering puts next',
    );
  });

  it('refuses a medium it does not answer for, and half a cursor', async () => {
    const who = await t.createUser({ username: 'refusals' });
    await t.actAs(who);

    assert.ok(
      await t.errorFrom(`select * from top_rated_titles('series')`),
      'a series is not a medium this wall has',
    );
    assert.ok(
      await t.errorFrom(`select * from top_rated_titles(null)`),
      'and neither is nothing',
    );
    // A row comparison containing NULL is NULL rather than false, so an incomplete
    // cursor would silently return an empty page that looks like the end of the wall.
    assert.ok(
      await t.errorFrom(`select * from top_rated_titles('movies', 20, 9.0, null, null)`),
      'a cursor is all three values or none',
    );
    assert.ok(
      await t.errorFrom(
        `select * from top_rated_titles('movies', 20, null, null, gen_random_uuid())`,
      ),
      'including the other way round',
    );
  });

  it('is reachable by a signed-in client and by nobody else', async () => {
    const who = await t.createUser({ username: 'reachability' });

    await t.asUser(who, async () => {
      const { rows } = await t.sql(`select * from top_rated_titles('movies', 5)`);
      assert.ok(Array.isArray(rows));
    });

    await t.asAnon(async () => {
      const error = await t.errorFrom(`select * from top_rated_titles('movies', 5)`);
      assert.ok(error, 'anon has no grant on this function');
    });
  });
});
