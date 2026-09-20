import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * T4 — the readers repoint (`20261006000100`, §L.2, §M.5, R2).
 *
 * The tranche that **changes numbers people have seen**, which is why every assertion
 * below is written twice: once with the flag off, proving the migration is inert on the
 * day it applies, and once with it on, proving it does what §L.2 says.
 *
 * The two defects, in opposite directions:
 *
 *   the goal    counted ONE date per title, so a 2025 watch and a 2026 rewatch made the
 *               2025 year silently wrong
 *   the board   fell back from watching to recording, so an undated in-app row counted
 *               in the month it was created and a ranked import in the month it arrived
 */

let t;
let user;
let seq = 0;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  // Reset before the close, not in a second `after` hook: hooks run in registration
  // order, so a later one runs against a database this has already shut.
  if (t) {
    await t.sql(`update app_config set value = 'false'::jsonb
                  where key in ('goals.count_watch_events', 'leaderboard.monthly_from_events')`);
    await t.close();
  }
});

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `repoint_${seq}` });
  await t.actAs(user);
});

const movie = (title) => t.createMovie(title, (seq += 1) + 30000);

const flag = (key, on) =>
  t.sql(`update app_config set value = $2::jsonb where key = $1`, [key, String(on)]);

const goals = (on) => flag('goals.count_watch_events', on);
const board = (on) => flag('leaderboard.monthly_from_events', on);

/** A seen title with the given dated viewings. */
const seen = async (title, watches, { source = 'in_app', createdAt = null } = {}) => {
  const m = await movie(title);
  await t.sql(
    `insert into user_media (user_id, media_item_id, bucket, source, created_at)
     values ($1, $2, 'loved', $3::content_source, coalesce($4::timestamptz, now()))`,
    [user, m, source, createdAt],
  );
  // The row's backstop event is undated; each explicit viewing is added beside it.
  for (const [on, basis] of watches) {
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, $3::date, $4::watch_date_basis)`,
      [user, m, on, basis],
    );
  }
  return m;
};

const goalCount = async (year, category = 'movies') =>
  (
    await t.sql(`select _goal_qualifying_count($1, $2, $3::ranking_category) as n`, [
      user,
      year,
      category,
    ])
  ).rows[0].n;

const thisMonth = (day) => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const boardCount = async () => {
  const { rows } = await t.sql(
    `select metric_count from _leaderboard_counts('titles', 'month') where user_id = $1`,
    [user],
  );
  return rows[0]?.metric_count ?? 0;
};

describe('§L.2 the yearly goal', () => {
  it('is inert while the flag is off', async () => {
    await goals(false);
    // The cache holds the LATEST date, so the pre-epic reader sees 2026 only.
    await seen('Two years', [
      ['2025-05-05', 'reader'],
      ['2026-05-05', 'reader'],
    ]);
    assert.equal(await goalCount(2025), 0, 'the defect, still present and still inert');
    assert.equal(await goalCount(2026), 1);
  });

  it('counts a title in EVERY year it has a dated viewing in', async () => {
    // The defect `goals.ts` has carried in its own header since 2026-08-16: "a film
    // watched in 2025 and rewatched in 2026 counts in 2026 and stops counting in 2025 —
    // the rewatch moved the only date there is".
    await goals(true);
    await seen('Heat', [
      ['2025-05-05', 'reader'],
      ['2026-05-05', 'today_default'],
    ]);
    assert.equal(await goalCount(2025), 1, '2025 is true again');
    assert.equal(await goalCount(2026), 1);
  });

  it('counts three rewatches in one year as ONE title', async () => {
    // `goals.ts` rule 4, which was documentary while user_media's key enforced it and is
    // load-bearing now: "a later watch-history table cannot quietly turn a goal of 52
    // into a goal of 52 viewings".
    await goals(true);
    await seen('Thrice', [
      ['2026-01-01', 'reader'],
      ['2026-05-05', 'reader'],
      ['2026-09-09', 'today_default'],
    ]);
    assert.equal(await goalCount(2026), 1);
  });

  it('counts a diary date, because a diary date is genuine', async () => {
    await goals(true);
    await seen('Imported', [['2026-03-03', 'diary']], { source: 'imported' });
    assert.equal(await goalCount(2026), 1);
  });

  it('counts an undated viewing for nothing, in either mode', async () => {
    await goals(true);
    await seen('No idea when', []);
    assert.equal(await goalCount(2026), 0);
    await goals(false);
    assert.equal(await goalCount(2026), 0);
  });

  it('a series belongs to no goal', async () => {
    await goals(true);
    const s = await t.createSeries('A show', (seq += 1) + 31000);
    await t.sql(`insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`, [
      user,
      s,
    ]);
    assert.equal(await goalCount(2026), 0);
    assert.equal(await goalCount(2026, 'tv_seasons'), 0);
  });
});

describe('§L.2 the goal trigger follows the events', () => {
  const year = new Date().getUTCFullYear();

  const setGoal = (target, category = 'movies') =>
    t.sql(
      `insert into watch_goals (user_id, year, category, target)
       values ($1, $2, $3::ranking_category, $4)
       on conflict (user_id, year, category) do update set target = excluded.target`,
      [user, year, category, target],
    );

  const completions = async () =>
    (
      await t.sql(
        `select count(*)::int as n from goal_completions where user_id = $1 and year = $2`,
        [user, year],
      )
    ).rows[0].n;

  it('a REWATCH dated this year completes a goal the cache would never have moved', async () => {
    // The crossing nobody would have counted: the title's latest date is unchanged, so
    // `user_media.watched_on` does not move and the old trigger never fires.
    await goals(true);
    await setGoal(2);
    await seen('First', [[`${year}-02-02`, 'reader']]);
    assert.equal(await completions(), 0);

    const m = await seen('Old favourite', [[`${year - 3}-01-01`, 'reader']]);
    assert.equal(await completions(), 0, 'an old date is not this year');

    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, $3::date, 'today_default')`,
      [user, m, `${year}-09-01`],
    );
    assert.equal(await completions(), 1, 'the rewatch crossed it');
  });

  it('a SECOND viewing in a year the title already counted in crosses nothing', async () => {
    await goals(true);
    await setGoal(2);
    const a = await seen('A', [[`${year}-01-01`, 'reader']]);
    await seen('B', [[`${year}-02-02`, 'reader']]);
    assert.equal(await completions(), 1, 'two distinct titles');

    await t.sql(`delete from goal_completions where user_id = $1`, [user]);
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, $3::date, 'reader')`,
      [user, a, `${year}-06-06`],
    );
    assert.equal(await completions(), 0, 'the count did not move, so nothing crossed');
  });

  it('the user_media trigger stands down when the flag is on, so nothing fires twice', async () => {
    await goals(true);
    await setGoal(1);
    await seen('Only one', [[`${year}-04-04`, 'reader']]);
    assert.equal(await completions(), 1, 'exactly one celebration');
  });
});

describe('§L.2 + R2 the monthly leaderboard', () => {
  it('is inert while the flag is off, fallback and all', async () => {
    await board(false);
    await seen('Undated, created this month', []);
    assert.equal(await boardCount(), 1, 'the fallback, still present');
  });

  it('counts a native-dated viewing in the month', async () => {
    await board(true);
    await seen('Watched here', [[thisMonth(3), 'today_default']]);
    assert.equal(await boardCount(), 1);
  });

  it('gives NO credit to an undated row, whatever month it was created in', async () => {
    // R2's headline effect: the only server code that read a recording time as a watch
    // time is gone, and this is the row it was crediting.
    await board(true);
    await seen('Undated', []);
    assert.equal(await boardCount(), 0);
  });

  it('gives NO credit to a diary date (R2)', async () => {
    await board(true);
    await seen('From Letterboxd', [[thisMonth(5), 'diary']], { source: 'imported' });
    assert.equal(await boardCount(), 0, 'history is not current viewing');
  });

  it('gives NO credit to a ranked import, which the fallback used to credit', async () => {
    // §C.3.5: ranking an imported undated title flipped `source` to in_app, and the
    // `created_at` fallback then attributed it to the import month.
    await board(true);
    const m = await seen('Ranked import', [], { source: 'imported' });
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [user, m],
    );
    await t.sql(`update user_media set source = 'in_app' where user_id = $1 and media_item_id = $2`, [
      user,
      m,
    ]);
    assert.equal(await boardCount(), 0);
  });

  it('DOES credit an imported title the reader has since watched here', async () => {
    // What the old `source <> 'imported'` filter would have refused, and the basis
    // filter gets right: the row came from an archive, and this viewing did not.
    await board(true);
    await seen('Imported then rewatched', [
      ['2019-01-01', 'diary'],
      [thisMonth(7), 'today_default'],
    ], { source: 'imported' });
    assert.equal(await boardCount(), 1);
  });

  it('counts three rewatches in the month as ONE title', async () => {
    await board(true);
    await seen('Thrice again', [
      [thisMonth(1), 'today_default'],
      [thisMonth(5), 'reader'],
      [thisMonth(9), 'reader'],
    ]);
    assert.equal(await boardCount(), 1);
  });

  it('counts an unattributed date, because it is a native date of unknown provenance', async () => {
    // §M.7: a pre-epic in-app date keeps counting where it counts today. No user loses
    // progress they have already seen.
    await board(true);
    await seen('Pre-epic', [[thisMonth(4), 'unattributed']]);
    assert.equal(await boardCount(), 1);
  });

  it('the all-time board is untouched by any of this', async () => {
    await board(true);
    await seen('All time', []);
    const { rows } = await t.sql(
      `select metric_count from _leaderboard_counts('titles', 'all_time') where user_id = $1`,
      [user],
    );
    assert.equal(rows[0]?.metric_count, 1, 'seen is seen, with or without a date');
  });
});

describe('§M.5 the diff, which is the gate for flipping either flag', () => {
  it('reports the goal RISING for a title with an earlier native date and a rewatch', async () => {
    const year = new Date().getUTCFullYear();
    await t.sql(
      `insert into watch_goals (user_id, year, category, target) values ($1, $2, 'movies', 10)
       on conflict (user_id, year, category) do update set target = excluded.target`,
      [user, year - 1],
    );
    await seen('Both years', [
      [`${year - 1}-05-05`, 'reader'],
      [`${year}-05-05`, 'reader'],
    ]);

    const { rows } = await t.sql(
      `select * from watch_history_repoint_diff() where user_id = $1 and period = $2`,
      [user, String(year - 1)],
    );
    const goal = rows.find((r) => r.metric === 'goal:movies');
    assert.ok(goal, 'the account appears in the diff');
    assert.equal(goal.before_count, 0, 'the cache held only the later date');
    assert.equal(goal.after_count, 1);
    assert.equal(goal.delta, 1, '§M.5: goals can RISE');
  });

  it('reports the monthly board FALLING for an undated row the fallback credited', async () => {
    await seen('Fallback credit', []);
    const { rows } = await t.sql(
      `select * from watch_history_repoint_diff()
        where user_id = $1 and metric = 'board:titles'`,
      [user],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delta, -1, "§M.5: the board falls, and that is R2's effect");
  });

  it('omits an account nothing changes for, so an empty result means invisible', async () => {
    await seen('Ordinary', [[thisMonth(2), 'today_default']]);
    const { rows } = await t.sql(`select * from watch_history_repoint_diff() where user_id = $1`, [
      user,
    ]);
    assert.deepEqual(rows, []);
  });
});
