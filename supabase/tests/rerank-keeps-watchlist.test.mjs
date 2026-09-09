import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';

/**
 * A correction is not another watch — `20260911000100`.
 *
 * The Ranked menu names three acts. *I watched it again* is a watch. *Adjust placement*
 * and *Change your rating* are corrections to an opinion already recorded: they replace
 * the position and post no activity (20260826000500, `watch-again.test.mjs`). This file
 * pins the two places a correction was still being heard as a watch:
 *
 *   - the **watchlist**. A reader who ranked a title and then deliberately put it back
 *     on the watchlist lost that entry to the DELETE-and-INSERT a correction performs,
 *     because `rankings_leaves_watchlist` fires on every insert and the band-change
 *     upsert on `user_media` reads as "becoming watched";
 *   - the **placement date**. `rankings.created_at` is "the instant the title entered
 *     the ranking, the same instant its activity carries" (PRD, the sort contract), and
 *     the re-inserted row took `now()` — so a correction could fabricate a streak week
 *     and move a title to the top of *Recently ranked* for a non-event.
 *
 * What must not change is tested beside what must: a first placement and an explicit
 * rewatch still take the entry, still finish a series, and still stamp the date.
 */

let t;
let user;
let seq = 0;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `correct_${seq}` });
  await t.actAs(user);
});

const movie = (title) => t.createMovie(title, (seq += 1) + 80000);
const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const call = async (sql, params) => {
  const { rows } = await t.sql(`select ${sql} as result`, params);
  return rows[0].result;
};

const watchlisted = async (mediaItemId) => {
  const { rows } = await t.sql(
    `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
    [user, mediaItemId],
  );
  return rows.length === 1;
};

const addToWatchlist = async (mediaItemId) =>
  call(`set_watchlist($1, $2, true)`, [await op(), mediaItemId]);

const rankedAt = async (item) =>
  (
    await t.sql(`select created_at from rankings where user_id = $1 and media_item_id = $2`, [
      user,
      item,
    ])
  ).rows[0]?.created_at ?? null;

const rankingOf = async (item) =>
  (
    await t.sql(
      `select bucket, position from rankings where user_id = $1 and media_item_id = $2`,
      [user, item],
    )
  ).rows[0] ?? null;

const events = async (item) =>
  Number(
    (
      await t.sql(
        `select count(*)::int as n from feed_events
          where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
        [user, item],
      )
    ).rows[0].n,
  );

/** Ranks `n` other films into `bucket`, so a band is never empty by accident. */
const anchors = async (n, bucket = 'loved') => {
  for (let i = 0; i < n; i += 1) {
    const film = await movie(`Anchor ${bucket} ${i}`);
    await t.rankToCompletion(film, bucket, async (pivot) => pivot);
  }
};

/** Answers a session to completion, always preferring the subject. Returns the last call. */
const finish = async (step, subject) => {
  let current = step;
  let last = null;
  let guard = 0;
  while (!current.done) {
    const args = [current.session_id, subject, await op()];
    current = await one(t.db, `select rank_answer($1, $2, $3) as r`, args);
    last = { args, result: current };
    guard += 1;
    if (guard > 32) throw new Error('did not converge');
  }
  return { result: current, last };
};

/** Adjust placement: `rank_again` with `p_new_watch` false, which is what the sheet sends. */
const adjustPlacement = async (item, bucket = 'loved') =>
  finish(
    await one(t.db, `select rank_again($1, $2, $3, false) as r`, [item, bucket, await op()]),
    item,
  );

/** I watched it again. */
const watchedAgain = async (item, bucket = 'loved') =>
  finish(
    await one(t.db, `select rank_again($1, $2, $3, true) as r`, [item, bucket, await op()]),
    item,
  );

/** Change your rating into a different band. */
const changeBand = async (item, bucket) =>
  finish(
    await one(t.db, `select rank_rebucket($1, $2, $3) as r`, [item, bucket, await op()]),
    item,
  );

/** Pushes a ranking's placement date into the past, so "unchanged" is distinguishable from "now". */
const ageRanking = async (item) => {
  await t.sql(
    `update rankings set created_at = now() - interval '10 days'
      where user_id = $1 and media_item_id = $2`,
    [user, item],
  );
  return rankedAt(item);
};

const RELEASED = '2020-01-01';

const series = async (title) => t.createSeries(title, (seq += 1) + 9000);
const season = async (seriesId, number) => {
  const id = await t.createSeason(seriesId, number, `Season ${number}`);
  await t.sql(`update media_items set release_date = $2 where id = $1`, [id, RELEASED]);
  return id;
};

// ---------------------------------------------------------------------------

describe('a deliberately re-added watchlist entry survives a correction', () => {
  it('Adjust placement leaves it exactly where the reader put it', async () => {
    await anchors(3);
    const film = await movie('Terrace House');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    assert.equal(await watchlisted(film), false, 'the first ranking took it, as always');

    await addToWatchlist(film);
    assert.equal(await watchlisted(film), true, 'and the reader put it back on purpose');

    await adjustPlacement(film);

    assert.equal(await watchlisted(film), true, 'a correction is not a watch');
    assert.equal(await events(film), 1, 'and posted nothing, as before');
    await t.assertValid(user);
  });

  it('Change your rating into another band leaves it too', async () => {
    // The second route: the user_media upsert moves `bucket`, and the update trigger
    // used to read that transition as "becoming watched".
    await anchors(3, 'loved');
    await anchors(3, 'fine');
    const film = await movie('Rebucketed');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await addToWatchlist(film);

    await changeBand(film, 'fine');

    assert.equal(await watchlisted(film), true);
    assert.equal((await rankingOf(film)).bucket, 'fine', 'the band did move');
    assert.equal(await events(film), 1);
    await t.assertValid(user);
  });

  it('I watched it again takes it off, as it always did', async () => {
    await anchors(3);
    const film = await movie('Watched twice');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await addToWatchlist(film);

    await watchedAgain(film);

    assert.equal(await watchlisted(film), false, 'a rewatch is a watch');
    assert.equal(await events(film), 2, 'and it posts, as 20260826000500 says');
    await t.assertValid(user);
  });

  it('a first placement straight off the watchlist still removes it', async () => {
    await anchors(2);
    const film = await movie('Fresh');
    await addToWatchlist(film);

    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    assert.equal(await watchlisted(film), false, '20260815040000 unchanged');
  });

  it('a retried finishing answer changes nothing the first one did not', async () => {
    await anchors(3);
    const film = await movie('Retried');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await addToWatchlist(film);

    const { last } = await adjustPlacement(film);
    assert.ok(last, 'the correction needed at least one answer to finish');

    const replay = await one(t.db, `select rank_answer($1, $2, $3) as r`, last.args);

    assert.deepEqual(replay, last.result, 'served from the ledger');
    assert.equal(await watchlisted(film), true);
    assert.equal(await events(film), 1);
    await t.assertValid(user);
  });
});

describe('the series entry', () => {
  it('survives a season correction and leaves on a season rewatch', async () => {
    const show = await series('Finished Then Re-added');
    const s1 = await season(show, 1);
    await addToWatchlist(show);

    await t.rankToCompletion(s1, 'loved', () => s1);
    assert.equal(await watchlisted(show), false, 'the only released season is met');

    await addToWatchlist(show);
    await adjustPlacement(s1);
    assert.equal(
      await watchlisted(show),
      true,
      'no season became met, so nothing to re-evaluate',
    );

    await watchedAgain(s1);
    assert.equal(
      await watchlisted(show),
      false,
      'a rewatch is a transition, and the state is re-read',
    );
  });
});

describe('the placement date', () => {
  it('is kept by Adjust placement', async () => {
    await anchors(3);
    const film = await movie('Dated');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const before = await ageRanking(film);

    await adjustPlacement(film);

    assert.equal(
      new Date(await rankedAt(film)).getTime(),
      new Date(before).getTime(),
      'the instant the title entered the ranking did not move for a non-event',
    );
  });

  it('is kept by a band change', async () => {
    await anchors(3, 'loved');
    await anchors(3, 'fine');
    const film = await movie('Dated and moved');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const before = await ageRanking(film);

    await changeBand(film, 'fine');

    assert.equal(new Date(await rankedAt(film)).getTime(), new Date(before).getTime());
  });

  it('is now for I watched it again', async () => {
    await anchors(3);
    const film = await movie('Dated twice');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const before = await ageRanking(film);

    await watchedAgain(film);

    assert.ok(
      new Date(await rankedAt(film)).getTime() > new Date(before).getTime(),
      'a second viewing is a new instant, which is what the streak and Recently ranked should see',
    );
  });
});

describe('the marker', () => {
  it('does not outlive the correction, on the same connection', async () => {
    await anchors(3);
    const film = await movie('Marked');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await addToWatchlist(film);
    await adjustPlacement(film);

    const { rows } = await t.sql(`select current_setting('bingd.rank_correction', true) as v`);
    assert.ok(!rows[0].v, `the transaction-local setting was discarded, got ${rows[0].v}`);

    // And the next bare watch signal on this very connection is still a watch:
    // 20260815040000's own probe, repeated after a correction.
    const other = await movie('Bare after');
    await addToWatchlist(other);
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved',
               (select coalesce(max(position), 0) + 1 from rankings
                 where user_id = $1 and category = 'movies'))`,
      [user, other],
    );
    assert.equal(await watchlisted(other), false);
    await t.sql(`delete from rankings where user_id = $1 and media_item_id = $2`, [
      user,
      other,
    ]);
  });
});
