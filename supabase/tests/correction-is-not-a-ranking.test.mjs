import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';

/**
 * A correction is not a new ranking — `20260928000100` (T0).
 *
 * *Update your rating* — `rank_again` with `p_new_watch` false in the same band,
 * `rank_rebucket` into another — replaces a position. It is a correction of an opinion
 * already recorded, not a ranking act of its own. `_rank_finalize` performs it as a
 * delete and re-insert of the `rankings` row, and three things heard that re-insert as a
 * new ranking:
 *
 *   - `rankings.created_at` took `now()`, so the weekly streak (derived from it) counted
 *     a correction as "ranked this week", and *Recently ranked* moved the title up;
 *   - the rankings watchlist triggers removed an entry the reader had deliberately
 *     re-added since the ranking, for the title and for its series;
 *   - a band change moved `user_media.bucket`, and the update trigger read loved -> fine
 *     as the row "becoming watched".
 *
 * What must not change is tested beside what must: a first ranking and *Log another
 * watch* (`p_new_watch`) are ranking acts — stamped now, taking the entry, posting.
 * Supersedes PR #118's `rerank-keeps-watchlist.test.mjs`, which pinned the same
 * behaviour against a migration that never shipped.
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

const movie = (title) => t.createMovie(title, (seq += 1) + 81000);
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

/** *Update your rating*, same band: `rank_again` with `p_new_watch` false. */
const correct = async (item, bucket = 'loved') =>
  finish(
    await one(t.db, `select rank_again($1, $2, $3, false) as r`, [item, bucket, await op()]),
    item,
  );

/** *Update your rating* into another band. */
const correctBand = async (item, bucket) =>
  finish(
    await one(t.db, `select rank_rebucket($1, $2, $3) as r`, [item, bucket, await op()]),
    item,
  );

/** *Log another watch*: `rank_again` with `p_new_watch` true. */
const watchAgain = async (item, bucket = 'loved') =>
  finish(
    await one(t.db, `select rank_again($1, $2, $3, true) as r`, [item, bucket, await op()]),
    item,
  );

/**
 * Moves every one of this account's rankings three weeks into the past, so "unchanged"
 * is distinguishable from "now" and nothing of the setup sits in the current week.
 */
const ageEverything = async () => {
  await t.sql(
    `update rankings set created_at = now() - interval '21 days' where user_id = $1`,
    [user],
  );
};

/**
 * How many rankings carry an instant in the current week — the question the weekly
 * streak asks of this column (src/features/streaks/streak.ts). Monday-based to match it;
 * the property under test does not depend on the week boundary, only on "not now".
 */
const rankedThisWeek = async () =>
  Number(
    (
      await t.sql(
        `select count(*)::int as n from rankings
          where user_id = $1 and created_at >= date_trunc('week', now())`,
        [user],
      )
    ).rows[0].n,
  );

const time = (value) => new Date(value).getTime();

const RELEASED = '2020-01-01';
const series = async (title) => t.createSeries(title, (seq += 1) + 9100);
const season = async (seriesId, number) => {
  const id = await t.createSeason(seriesId, number, `Season ${number}`);
  await t.sql(`update media_items set release_date = $2 where id = $1`, [id, RELEASED]);
  return id;
};

// ---------------------------------------------------------------------------

describe('a first ranking', () => {
  it('is a ranking act: stamped now, off the watchlist, one activity', async () => {
    await anchors(2);
    const film = await movie('First');
    await addToWatchlist(film);
    const started = Date.now();

    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    assert.ok(time(await rankedAt(film)) >= started - 5_000, 'created now');
    assert.equal(await watchlisted(film), false, '20260815040000 unchanged');
    assert.equal(await events(film), 1);
    await t.assertValid(user);
  });
});

describe('a correction keeps the instant its ranking already had', () => {
  it('in the same band', async () => {
    await anchors(3);
    const film = await movie('Same band');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await ageEverything();
    const before = await rankedAt(film);

    await correct(film);

    assert.equal(time(await rankedAt(film)), time(before));
    await t.assertValid(user);
  });

  it('into another band', async () => {
    await anchors(3, 'loved');
    await anchors(3, 'fine');
    const film = await movie('Moved band');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await ageEverything();
    const before = await rankedAt(film);

    await correctBand(film, 'fine');

    assert.equal((await rankingOf(film)).bucket, 'fine', 'the band did move');
    assert.equal(time(await rankedAt(film)), time(before));
    await t.assertValid(user);
  });

  it('so a week with nothing but corrections is not a ranking week', async () => {
    await anchors(3, 'loved');
    await anchors(2, 'fine');
    const film = await movie('Quiet week');
    const other = await movie('Also quiet');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await t.rankToCompletion(other, 'loved', async (pivot) => pivot);
    await ageEverything();
    assert.equal(await rankedThisWeek(), 0, 'setup: nothing ranked this week');

    await correct(film);
    await correctBand(other, 'fine');

    assert.equal(
      await rankedThisWeek(),
      0,
      'two corrections this week, and no ranking the streak could count',
    );
  });

  it('while Log another watch is a new ranking act, stamped now', async () => {
    await anchors(3);
    const film = await movie('Watched twice');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await ageEverything();
    const before = await rankedAt(film);

    await watchAgain(film);

    assert.ok(time(await rankedAt(film)) > time(before), 'a second viewing is a new instant');
    assert.equal(await rankedThisWeek(), 1, 'and a genuine ranking week');
  });

  it('through a correction that was left and resumed', async () => {
    // #172's resume path (20260926000100) re-enters the same session; the instant is
    // decided at finalize, so a resumed correction keeps it just the same.
    await anchors(6);
    const film = await movie('Resumed');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await ageEverything();
    const before = await rankedAt(film);

    const opened = await one(t.db, `select rank_again($1, 'loved', $2, false) as r`, [
      film,
      await op(),
    ]);
    assert.equal(opened.done, false, 'a band of six needs comparisons');
    const answered = await one(t.db, `select rank_answer($1, $2, $3) as r`, [
      opened.session_id,
      film,
      await op(),
    ]);
    assert.equal(answered.done, false, 'still mid-session');

    const resumed = await one(t.db, `select rank_again($1, 'loved', $2, false) as r`, [
      film,
      await op(),
    ]);
    assert.equal(resumed.resumed, true, 'the same session, resumed');
    await finish(resumed, film);

    assert.equal(time(await rankedAt(film)), time(before));
    await t.assertValid(user);
  });
});

describe('a deliberately re-added watchlist entry survives a correction', () => {
  it('in the same band', async () => {
    await anchors(3);
    const film = await movie('Re-added');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    assert.equal(await watchlisted(film), false, 'the first ranking took it');
    await addToWatchlist(film);

    await correct(film);

    assert.equal(await watchlisted(film), true, 'a correction is not a watch');
    await t.assertValid(user);
  });

  it('into another band, which also moves user_media.bucket', async () => {
    await anchors(3, 'loved');
    await anchors(3, 'fine');
    const film = await movie('Re-added and moved');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await addToWatchlist(film);

    await correctBand(film, 'fine');

    assert.equal(await watchlisted(film), true);
    assert.equal((await rankingOf(film)).bucket, 'fine');
    await t.assertValid(user);
  });

  it('but Log another watch satisfies it, as it always did', async () => {
    await anchors(3);
    const film = await movie('Watched again');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await addToWatchlist(film);

    await watchAgain(film);

    assert.equal(await watchlisted(film), false, 'a rewatch is a watch');
  });

  it('and a correction still removes an entry older than the ranking itself', async () => {
    // Chronology, not a switch: an entry that predates the ranking's instant is the
    // stale intention a ranking always satisfies. It cannot normally exist -- the first
    // ranking removes it -- so it is written directly to prove the rule is a comparison
    // and not "corrections never touch the watchlist".
    await anchors(3);
    const film = await movie('Stale entry');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await t.sql(
      `insert into watchlist (user_id, media_item_id, created_at)
       values ($1, $2, now() - interval '30 days')`,
      [user, film],
    );
    await ageEverything();

    await correct(film);

    assert.equal(await watchlisted(film), false, 'older than the ranking, so it leaves');
  });

  it('for a series the reader re-added after finishing it', async () => {
    const show = await series('Finished, re-added');
    const s1 = await season(show, 1);
    await addToWatchlist(show);

    await t.rankToCompletion(s1, 'loved', () => s1);
    assert.equal(await watchlisted(show), false, 'the only released season is met');

    await addToWatchlist(show);
    await correct(s1);
    assert.equal(await watchlisted(show), true, 'no season became met by a correction');

    await watchAgain(s1);
    assert.equal(await watchlisted(show), false, 'a season rewatch is a transition');
  });
});

describe('a re-rating outside ranking is not a watch either', () => {
  it('moving an unranked title between buckets leaves a re-added entry', async () => {
    const film = await movie('Rated, then re-rated');
    await call(`set_bucket($1, $2, 'loved')`, [await op(), film]);
    await addToWatchlist(film);

    await call(`set_bucket($1, $2, 'fine')`, [await op(), film]);

    assert.equal(await watchlisted(film), true);
  });

  it('while the first bucket on a row still takes it', async () => {
    const film = await movie('First bucket');
    await addToWatchlist(film);
    // A note first, so the row exists with no watch signal on it.
    await call(`log_watched($1, $2, null, 'someone recommended it')`, [await op(), film]);
    assert.equal(await watchlisted(film), true);

    await call(`set_bucket($1, $2, 'fine')`, [await op(), film]);

    assert.equal(await watchlisted(film), false, 'null -> bucket is becoming watched');
  });
});

describe('what a correction does not do', () => {
  it('posts no activity, where a first ranking and a rewatch each post one', async () => {
    await anchors(3);
    const film = await movie('Feed');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    assert.equal(await events(film), 1);

    await correct(film);
    assert.equal(await events(film), 1, 'a correction is not an activity');

    await watchAgain(film);
    assert.equal(await events(film), 2, 'a rewatch is');
  });

  it('changes nothing more on a retried finishing answer', async () => {
    await anchors(3);
    const film = await movie('Retried');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await addToWatchlist(film);
    await ageEverything();
    const before = await rankedAt(film);

    const { last } = await correct(film);
    assert.ok(last, 'the correction needed at least one answer to finish');

    const replay = await one(t.db, `select rank_answer($1, $2, $3) as r`, last.args);

    assert.deepEqual(replay, last.result, 'served from the ledger');
    assert.equal(time(await rankedAt(film)), time(before));
    assert.equal(await watchlisted(film), true);
    assert.equal(await events(film), 1);
    await t.assertValid(user);
  });

  it('leaves a bare rankings insert a watch signal, as 20260815040000 pinned', async () => {
    const film = await movie('Bare');
    await addToWatchlist(film);

    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved',
               (select coalesce(max(position), 0) + 1 from rankings
                 where user_id = $1 and category = 'movies'))`,
      [user, film],
    );

    assert.equal(await watchlisted(film), false);
    await t.sql(`delete from rankings where user_id = $1 and media_item_id = $2`, [user, film]);
  });
});
