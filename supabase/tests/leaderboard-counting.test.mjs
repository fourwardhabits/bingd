import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb, createTestDbBefore, one } from './harness.mjs';
import { tvRanking } from './tv-ranking-support.mjs';

/**
 * Leaderboard counting (founder brief 2026-11-23 §3, migration 20261130001300).
 *
 * A point is a **distinct watched title**, never a ranking operation. Movies, whole shows
 * and seasons are three units; All Titles counts all three, TV Shows counts shows and
 * seasons, Movies counts films. All time counts every watched title once; This month
 * counts titles with a native-dated viewing in the UTC month. Reviews are unchanged.
 *
 * Every write here goes through the RPC the app calls (`log_title`, `log_rewatch`,
 * `rank_start` / `rank_answer`, `rank_again`, `rank_rebucket`, `rank_reorder`,
 * `rank_promote_show`, `rank_unpromote_show`, `keep_show`, `save_note`, `unlog`) as the
 * signed-in reader, and every read through `leaderboard` / `my_leaderboard_standing` as
 * a signed-in viewer, so the suite proves the numbers a phone would draw.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ctx = { t: null, user: null, seq: 0 };
const { op, movie, series, rank, correct, positions } = tvRanking(ctx);

before(async () => {
  ctx.t = await createTestDb();
});

after(async () => {
  await ctx.t?.close();
});

beforeEach(async () => {
  ctx.seq += 1;
  ctx.user = await ctx.t.createUser({ username: `lbc_${ctx.seq}` });
  await ctx.t.actAs(ctx.user);
});

const call = (sql, params) => one(ctx.t.db, `select ${sql} as r`, params);
const me = () => ctx.t.actAs(ctx.user);

/** The UTC date, `n` days from today, as SQL. */
const utcDay = (n = 0) => `((now() at time zone 'UTC')::date + ${n})`;
const MONTH_START = `date_trunc('month', (now() at time zone 'UTC'))::date`;

/** A date inside this UTC month that is never in the future (the 1st, or today). */
const thisMonth = async () =>
  (await ctx.t.sql(`select ${MONTH_START} as d`)).rows[0].d.toISOString().slice(0, 10);
const lastYear = async () =>
  (await ctx.t.sql(`select (${MONTH_START} - 400) as d`)).rows[0].d.toISOString().slice(0, 10);

/** The Log sheet: a first log with the reader's tap as the basis (LogSheet.tsx). */
const logTitle = async (
  item,
  { bucket = 'loved', on = 'today', basis = 'today_default' } = {},
) => {
  await me();
  const date = on === 'today' ? (await ctx.t.sql(`select ${utcDay()} as d`)).rows[0].d : on;
  return call(`log_title($1, $2, $3::taste_bucket, $4::date, $5::watch_date_basis)`, [
    await op(),
    item,
    bucket,
    basis === 'none' ? null : date,
    basis,
  ]);
};

/** Log another watch (LogAnotherWatchSheet.tsx). */
const logRewatch = async (item, on, basis = 'reader') => {
  await me();
  return call(`log_rewatch($1, $2, $3::date, $4::watch_date_basis)`, [
    await op(),
    item,
    on,
    basis,
  ]);
};

/** Log, then rank: what the app does for a title it has just been told about. */
const logAndRank = async (item, score, opts = {}) => {
  await logTitle(item, opts);
  return rank(item, opts.bucket ?? 'loved', score);
};

/** My count and rank, through the board and through the pinned standing. */
const counts = async (metric, timeframe, viewer = ctx.user) => {
  const board = await ctx.t.asUser(
    viewer,
    async () =>
      (await ctx.t.sql(`select * from leaderboard($1, $2, 100)`, [metric, timeframe])).rows,
  );
  const standing = await ctx.t.asUser(
    ctx.user,
    async () =>
      (await ctx.t.sql(`select * from my_leaderboard_standing($1, $2)`, [metric, timeframe]))
        .rows[0],
  );
  await me();
  const row = board.find((r) => r.user_id === ctx.user);
  return { board: row?.metric_count ?? 0, boardRank: row?.rank ?? null, standing };
};

/** The reader's number on all four metrics in both timeframes, asserting the two RPCs agree. */
const snapshot = async () => {
  const out = {};
  for (const timeframe of ['all_time', 'month']) {
    for (const metric of ['titles', 'movies', 'tv', 'reviews']) {
      const c = await counts(metric, timeframe);
      assert.equal(
        c.board,
        c.standing.metric_count,
        `${metric}/${timeframe}: board = standing`,
      );
      out[`${metric}/${timeframe}`] = c.board;
    }
  }
  return out;
};

const expectCounts = async (expected) => {
  const got = await snapshot();
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(got[key], value, `${key}: expected ${value}, got ${got[key]}`);
  }
  return got;
};

const watchCount = async () =>
  (
    await ctx.t.sql(`select count(*)::int as n from watch_events where user_id = $1`, [
      ctx.user,
    ])
  ).rows[0].n;

// ===========================================================================

describe('films', () => {
  it('1. a movie logged once is one title, in both timeframes', async () => {
    await logAndRank(await movie('Once'), 80);
    await expectCounts({
      'titles/all_time': 1,
      'movies/all_time': 1,
      'tv/all_time': 0,
      'titles/month': 1,
      'movies/month': 1,
      'tv/month': 0,
    });
  });

  it('2. ranking edits, a rebucket, a reorder and a refine add nothing', async () => {
    const film = await movie('Edited');
    const other = await movie('Neighbour');
    await logAndRank(other, 50);
    await logAndRank(film, 80);
    const before = await expectCounts({ 'titles/all_time': 2, 'titles/month': 2 });
    const watches = await watchCount();

    await correct(film, 'loved'); // edit ranking, same band (rank_again)
    await correct(film, 'fine'); // move to another band (rank_rebucket)
    await correct(film, 'loved'); // and back
    const placed = (await positions('movies')).find((p) => p.media_item_id === film);
    await me();
    await call(`rank_reorder($1, $2, $3, $4, $5)`, [
      film,
      2,
      await op(),
      placed.position,
      null,
    ]);
    await correct(film, 'loved'); // a correction after the reorder

    assert.equal(await watchCount(), watches, 'no ranking operation wrote a watch');
    assert.deepEqual(await snapshot(), before);
  });

  it('retrying a completed ranking operation adds nothing', async () => {
    const film = await movie('Retried');
    await me();
    const opLog = await op();
    await call(`log_title($1, $2, 'loved', ${utcDay()}, 'today_default')`, [opLog, film]);
    await call(`log_title($1, $2, 'loved', ${utcDay()}, 'today_default')`, [opLog, film]);
    const opRewatch = await op();
    await call(`log_rewatch($1, $2, ${utcDay()}, 'today_default')`, [opRewatch, film]);
    await call(`log_rewatch($1, $2, ${utcDay()}, 'today_default')`, [opRewatch, film]);
    const id = await op();
    await call(`rank_start($1, 'loved'::taste_bucket, $2)`, [film, id]);
    await call(`rank_start($1, 'loved'::taste_bucket, $2)`, [film, id]);
    await expectCounts({ 'titles/all_time': 1, 'titles/month': 1 });
  });
});

// ===========================================================================

describe('TV: shows and seasons are separate units', () => {
  it('3. a show and one season, each logged, are two', async () => {
    const show = await series('Two Units');
    const s1 = await ctx.t.createSeason(show, 1, 'Two Units S1');
    await logAndRank(show, 80);
    await logAndRank(s1, 70);
    await expectCounts({
      'titles/all_time': 2,
      'tv/all_time': 2,
      'movies/all_time': 0,
      'titles/month': 2,
      'tv/month': 2,
    });
  });

  it('4. a show and three seasons, each logged, are four', async () => {
    const show = await series('Four Units');
    await logAndRank(show, 80);
    for (let n = 1; n <= 3; n += 1) {
      await logAndRank(await ctx.t.createSeason(show, n, `Four Units S${n}`), 70 - n);
    }
    await expectCounts({ 'tv/all_time': 4, 'titles/all_time': 4, 'tv/month': 4 });
  });

  it('5. a season ranked without a show log is one, and manufactures no show', async () => {
    const show = await series('Season Only');
    const s2 = await ctx.t.createSeason(show, 2, 'Season Only S2');
    await logAndRank(s2, 60);
    await expectCounts({ 'tv/all_time': 1, 'tv/month': 1, 'titles/all_time': 1 });
    const { rows } = await ctx.t.sql(
      `select 1 from user_media where user_id = $1 and media_item_id = $2`,
      [ctx.user, show],
    );
    assert.equal(rows.length, 0, 'ranking S2 wrote no whole-show entry');
  });

  it('Keep Show and the linked Update Show add nothing', async () => {
    const show = await series('Kept');
    const s1 = await ctx.t.createSeason(show, 1, 'Kept S1');
    const s2 = await ctx.t.createSeason(show, 2, 'Kept S2');
    await logAndRank(show, 80);
    const first = await logAndRank(s1, 70);
    const before = await expectCounts({ 'tv/all_time': 2, 'tv/month': 2 });

    await me();
    await call(`keep_show($1)`, [first.placement_id]);
    assert.deepEqual(await snapshot(), before, 'Keep Show');

    const second = await logAndRank(s2, 60);
    const withS2 = await expectCounts({ 'tv/all_time': 3, 'tv/month': 3 });
    const watches = await watchCount();
    await correct(show, 'fine', { linked: second.placement_id });
    assert.equal(await watchCount(), watches, 'Update Show wrote no watch');
    assert.deepEqual(await snapshot(), withS2, 'Update Show');
  });

  it('a season marked in progress is not a watched title', async () => {
    const show = await series('In Progress');
    const s1 = await ctx.t.createSeason(show, 1, 'In Progress S1');
    await ctx.t.sql(
      `insert into user_media (user_id, media_item_id, progress) values ($1, $2, 'watching')`,
      [ctx.user, s1],
    );
    await expectCounts({ 'tv/all_time': 0, 'tv/month': 0 });
  });
});

// ===========================================================================

describe('6. promoting an SN AVG show, and its Undo', () => {
  /** Two logged, ranked seasons, which draw the show at their average. */
  const averaged = async () => {
    const show = await series('Averaged');
    const seasons = [];
    for (let n = 1; n <= 2; n += 1) {
      const s = await ctx.t.createSeason(show, n, `Averaged S${n}`);
      await logAndRank(s, 70 - n);
      seasons.push(s);
    }
    return { show, seasons };
  };

  const promote = async (show) => {
    await me();
    return call(`rank_promote_show($1, 1, 'loved'::taste_bucket, $2, null)`, [
      show,
      await op(),
    ]);
  };

  it('promotion adds nothing, and Undo takes nothing away', async () => {
    const { show } = await averaged();
    const before = await expectCounts({
      'tv/all_time': 2,
      'tv/month': 2,
      'titles/all_time': 2,
    });

    const promoted = await promote(show);
    assert.equal(promoted.promoted, true);
    assert.deepEqual(await snapshot(), before, 'the placement is not a viewing');

    await me();
    await call(`rank_unpromote_show($1, $2, $3, 1)`, [show, promoted.placement_id, await op()]);
    assert.deepEqual(await snapshot(), before, 'Undo restores, and removes nothing counted');
  });

  it('editing the promoted show adds nothing either', async () => {
    const { show } = await averaged();
    const before = await snapshot();
    await promote(show);
    await correct(show, 'fine');
    assert.deepEqual(await snapshot(), before);
  });

  it('the evidence event a promoted show gets when its seasons leave is not a viewing', async () => {
    // `_a_placed_show_keeps_its_evidence`: the seasons go, the show keeps its ranking and
    // gets the backstop's undated event so W1 holds. Bookkeeping, not a watch.
    const { show, seasons } = await averaged();
    await promote(show);
    await me();
    for (const s of seasons) {
      await call(`rank_unrank($1, $2)`, [s, await op()]);
      await call(`unlog($1, $2)`, [await op(), s]);
    }
    const { rows } = await ctx.t.sql(
      `select basis from watch_events where user_id = $1 and media_item_id = $2`,
      [ctx.user, show],
    );
    assert.deepEqual(
      rows.map((r) => r.basis),
      ['none'],
      'the show has the backstop event',
    );
    await expectCounts({ 'tv/all_time': 0, 'titles/all_time': 0, 'tv/month': 0 });

    // A genuine viewing of the show afterwards is one title.
    await logRewatch(show, await thisMonth());
    await expectCounts({ 'tv/all_time': 1, 'tv/month': 1 });
  });

  it('a show logged before it was promoted keeps its one point', async () => {
    const { show } = await averaged();
    await logTitle(show, { basis: 'none' });
    // The log ranked nothing, so the show is still drawn at its seasons' average.
    const before = await expectCounts({ 'tv/all_time': 3, 'tv/month': 2 });
    await promote(show);
    assert.deepEqual(await snapshot(), before);
  });
});

// ===========================================================================

describe('when, and whether, a title is in this month', () => {
  it('7. a backlog title logged today as Earlier counts all time, not this month', async () => {
    await logAndRank(await movie('Backlog'), 60, { basis: 'none' });
    await expectCounts({ 'titles/all_time': 1, 'titles/month': 0 });
  });

  it('a title logged today with an old date counts all time, not this month', async () => {
    await logAndRank(await movie('Backdated'), 60, { on: await lastYear(), basis: 'reader' });
    await expectCounts({ 'titles/all_time': 1, 'titles/month': 0 });
  });

  it('8. an undated entry (a band chosen, no Log sheet) counts all time only', async () => {
    const film = await movie('Undated');
    await me();
    await call(`set_bucket($1, $2, 'fine'::taste_bucket)`, [await op(), film]);
    await expectCounts({ 'titles/all_time': 1, 'titles/month': 0 });
  });

  it('a ranking alone, today, on an existing undated title adds nothing this month', async () => {
    const film = await movie('Ranked Today');
    await logTitle(film, { basis: 'none' });
    const before = await snapshot();
    await rank(film, 'loved', 70);
    assert.deepEqual(await snapshot(), before);
  });

  it('10. a rewatch this month counts once; an old watch alone does not', async () => {
    const film = await movie('Rewatched');
    await logAndRank(film, 70, { on: await lastYear(), basis: 'reader' });
    await expectCounts({ 'titles/month': 0, 'titles/all_time': 1 });
    await logRewatch(film, await thisMonth());
    await logRewatch(
      film,
      (await ctx.t.sql(`select ${utcDay()} as d`)).rows[0].d,
      'today_default',
    );
    await expectCounts({ 'titles/month': 1, 'titles/all_time': 1 });
  });

  it('11. the month is the UTC calendar month, half-open, whatever the session zone', async () => {
    const film = await movie('Boundary');
    await logTitle(film, { basis: 'none' });
    const add = (dateSql) =>
      ctx.t.sql(
        `insert into watch_events (user_id, media_item_id, watched_on, basis)
         values ($1, $2, ${dateSql}, 'reader')`,
        [ctx.user, film],
      );
    const clear = () =>
      ctx.t.sql(`delete from watch_events where user_id = $1 and basis = 'reader'`, [ctx.user]);

    await add(`${MONTH_START} - 1`);
    await expectCounts({ 'titles/month': 0 });
    await clear();
    await add(`(${MONTH_START} + interval '1 month')::date`);
    await expectCounts({ 'titles/month': 0 });
    await clear();
    await add(MONTH_START);
    await ctx.t.sql(`set time zone 'Pacific/Kiritimati'`);
    try {
      await expectCounts({ 'titles/month': 1 });
    } finally {
      await ctx.t.sql(`set time zone 'UTC'`);
    }
  });
});

// ===========================================================================

describe('9. imported against native', () => {
  /** What the apply path writes: an imported row and its diary event. */
  const imported = async (title, on) => {
    const film = await movie(title);
    await ctx.t.sql(
      `insert into user_media (user_id, media_item_id, source) values ($1, $2, 'imported')`,
      [ctx.user, film],
    );
    if (on) {
      await ctx.t.sql(
        `insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref)
         values ($1, $2, $3::date, 'diary', $4)`,
        [ctx.user, film, on, `https://boxd.it/${title.replace(/\W/g, '')}`],
      );
      await ctx.t.sql(
        `delete from watch_events
          where user_id = $1 and media_item_id = $2 and basis = 'none' and import_ref is null`,
        [ctx.user, film],
      );
    }
    return film;
  };

  it('an import today with last year’s diary date counts nowhere', async () => {
    await imported('Diary Last Year', await lastYear());
    await imported('Undated Import', null);
    await expectCounts({ 'titles/all_time': 0, 'titles/month': 0 });
  });

  it('a diary date inside this month is history, not a viewing here', async () => {
    await imported('Diary This Month', await thisMonth());
    await expectCounts({ 'titles/all_time': 0, 'titles/month': 0 });
  });

  it('an import watched again here this month counts once, in both', async () => {
    const film = await imported('Imported Then Watched', await lastYear());
    await logRewatch(film, await thisMonth());
    await expectCounts({ 'titles/all_time': 1, 'titles/month': 1 });
  });

  it('an import the reader ranks here joins all time and not this month', async () => {
    // The 20260917000100 provenance ratchet: ranking is a native act on the title, so the
    // row stops being "imported". It records no viewing, so no month gains it.
    const film = await imported('Imported Then Ranked', await lastYear());
    await rank(film, 'loved', 70);
    await expectCounts({ 'titles/all_time': 1, 'titles/month': 0 });
  });

  it('a native title beside an import counts alone', async () => {
    await imported('Beside', await lastYear());
    await logAndRank(await movie('Native Beside'), 70);
    await expectCounts({ 'titles/all_time': 1, 'titles/month': 1 });
  });
});

// ===========================================================================

describe('12. reviews keep their semantics', () => {
  const note = async (item, text, visibility) => {
    await me();
    return call(`save_note($1, $2, $3, null, $4::note_visibility, false)`, [
      await op(),
      item,
      text,
      visibility,
    ]);
  };

  it('create, edit, unpublish and republish', async () => {
    const film = await movie('Reviewed');
    await logAndRank(film, 70);
    await note(film, 'First.', 'public');
    await expectCounts({ 'reviews/month': 1, 'reviews/all_time': 1, 'titles/all_time': 1 });

    await note(film, 'First, revised at length.', 'public');
    await expectCounts({ 'reviews/month': 1, 'reviews/all_time': 1 });

    await note(film, 'First, revised at length.', 'private');
    await expectCounts({ 'reviews/month': 1, 'reviews/all_time': 0 });

    await note(film, 'First, revised at length.', 'public');
    await expectCounts({ 'reviews/month': 1, 'reviews/all_time': 1, 'titles/month': 1 });
  });

  it('a review is not a viewing, and a viewing is not a review', async () => {
    const film = await movie('Words Only');
    await logTitle(film, { basis: 'none' });
    await note(film, 'Words.', 'public');
    await expectCounts({ 'reviews/month': 1, 'titles/month': 0, 'titles/all_time': 1 });
  });
});

// ===========================================================================

describe('13. privacy and visibility are the board’s, unchanged', () => {
  it('a private stranger is a minimal row with the same count; a blocker is absent', async () => {
    const viewer = await ctx.t.createUser({ username: `lbc_viewer_${ctx.seq}` });
    const blocker = await ctx.t.createUser({ username: `lbc_blocker_${ctx.seq}` });
    await ctx.t.sql(`update profiles set visibility = 'private' where id = $1`, [ctx.user]);
    await ctx.t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
      blocker,
      viewer,
    ]);

    const show = await series('Private Show');
    await logAndRank(show, 70);
    await logAndRank(await ctx.t.createSeason(show, 1, 'Private Show S1'), 60);
    await ctx.t.actAs(blocker);
    const theirs = await movie('Blocker Film');
    await call(`log_title($1, $2, 'loved', ${utcDay()}, 'today_default')`, [
      await op(),
      theirs,
    ]);
    await me();

    const rows = await ctx.t.asUser(
      viewer,
      async () => (await ctx.t.sql(`select * from leaderboard('tv', 'all_time', 100)`)).rows,
    );
    const row = rows.find((r) => r.user_id === ctx.user);
    assert.ok(row, 'the private entrant is on the board');
    assert.equal(row.metric_count, 2);
    assert.equal(row.viewable, false);
    assert.equal(row.match_percent, null);
    assert.equal(row.shared_count, null);
    assert.ok(!rows.some((r) => r.user_id === blocker), 'a blocker is absent');

    // No title-level date or title reaches any column of either RPC.
    for (const fn of ['leaderboard', 'my_leaderboard_standing']) {
      const { rows: cols } = await ctx.t.sql(
        `select unnest(proargnames) as name from pg_proc where proname = $1`,
        [fn],
      );
      for (const { name } of cols) {
        assert.doesNotMatch(String(name), /date|watched|media|title/i, `${fn}.${name}`);
      }
    }
  });
});

// ===========================================================================

describe('14. the board and the pinned standing agree', () => {
  it('on every metric and timeframe, for a reader with everything', async () => {
    const show = await series('Everything');
    await logAndRank(show, 80);
    await logAndRank(await ctx.t.createSeason(show, 1, 'Everything S1'), 70);
    await logAndRank(await movie('Everything Film'), 60);
    await logAndRank(await movie('Everything Old'), 50, {
      on: await lastYear(),
      basis: 'reader',
    });
    const got = await snapshot(); // asserts board = standing for each of the eight
    assert.deepEqual(got, {
      'titles/all_time': 4,
      'movies/all_time': 2,
      'tv/all_time': 2,
      'reviews/all_time': 0,
      'titles/month': 3,
      'movies/month': 1,
      'tv/month': 2,
      'reviews/month': 0,
    });
    const c = await counts('titles', 'all_time');
    assert.equal(c.boardRank, c.standing.rank);
  });
});

// ===========================================================================

describe('migration 20261130001300', () => {
  it('reads no recording time and no flag', async () => {
    const { rows } = await ctx.t.sql(
      `select prosrc from pg_proc where proname = '_leaderboard_counts'`,
    );
    assert.equal(rows.length, 1, 'one definition, the (text, text) one');
    const body = String(rows[0].prosrc).replace(/--[^\n]*/g, ' ');
    // `sp.created_at` is the promotion's own time, compared with an event's recording
    // time to recognise bookkeeping; no recording time is ever read as a watch time.
    assert.doesNotMatch(body, /coalesce/i, 'no fallback of any kind');
    assert.doesNotMatch(body, /(?<!sp)\.(created_at|updated_at)\b/i, 'no row recording time');
    assert.doesNotMatch(body, /_monthly_board_from_events/, 'the flagged arm is gone');
    assert.doesNotMatch(body, /\brankings\b|ranking_placements/, 'rankings are not counted');
  });

  it('keeps both RPC signatures and the grants', async () => {
    const { rows } = await ctx.t.sql(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args,
              pg_get_function_result(p.oid) as result,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p
        where p.proname in ('leaderboard', 'my_leaderboard_standing', '_leaderboard_counts',
                            'monthly_leaderboard')
        order by p.proname`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.proname, r]));
    assert.equal(by._leaderboard_counts.args, 'p_metric text, p_timeframe text');
    assert.equal(by._leaderboard_counts.auth, false);
    assert.equal(by.leaderboard.args, 'p_metric text, p_timeframe text, p_limit integer');
    assert.equal(by.leaderboard.auth, true);
    assert.equal(by.leaderboard.anon, false);
    assert.equal(by.my_leaderboard_standing.args, 'p_metric text, p_timeframe text');
    assert.equal(by.my_leaderboard_standing.auth, true);
    assert.equal(by.monthly_leaderboard.auth, true);
  });

  it('applies over its predecessor, and the rollback restores that body exactly', async () => {
    const file = '20261130001300_a_title_counted_once_on_the_board.sql';
    const db = await createTestDbBefore(file);
    try {
      const body = async () =>
        (await db.sql(`select prosrc from pg_proc where proname = '_leaderboard_counts'`))
          .rows[0].prosrc;
      const previous = await body();
      await db.applyMigration(file);
      assert.notEqual(await body(), previous);

      const rollback = await readFile(
        join(
          here,
          '..',
          '..',
          'docs',
          'release',
          'leaderboard-counting',
          'rollback-20261130001300.sql',
        ),
        'utf8',
      );
      await db.exec(rollback);
      assert.equal(await body(), previous, 'the rollback is the 20261006000100 body');
      const { rows } = await db.sql(
        `select has_function_privilege('authenticated', 'public._leaderboard_counts(text,text)'::regprocedure, 'execute') as auth`,
      );
      assert.equal(rows[0].auth, false);

      // And forward again, as a re-apply after a rollback would.
      await db.applyMigration(file);
      assert.notEqual(await body(), previous);
    } finally {
      await db.close();
    }
  });
});
