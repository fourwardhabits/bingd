import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The monthly leaderboard — `20260828000300`, and the review fact `20260828000200`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE FOR
 *
 * A leaderboard is the first surface in this product where a number is a *claim about a
 * person made to other people*, so two families of defect matter more here than they do
 * anywhere else:
 *
 *   **Gaming.** A metric that can be inflated without doing the thing it measures is
 *   worse than no metric. Three routes are closed by construction and each is asserted
 *   rather than argued: a rewatch cannot count twice (`user_media` is keyed by title),
 *   an edit cannot mint a review (`note_first_published_at` is stamped once), and
 *   un-sharing then re-sharing cannot mint a second one (it is never cleared).
 *
 *   **Leakage.** The board is viewer-relative, so the same call is a different list for
 *   every caller. Founder §26: a private account the viewer has not been approved by
 *   must not appear with a count. That is the one property whose failure would be
 *   invisible in the app — the row would simply be there, looking correct.
 *
 * `asUser` throughout, not `actAs`. These are definer functions so `actAs` would be
 * honest, but the viewer-relative assertions are exactly the ones that must keep meaning
 * something if a future rewrite drops `security definer`, and under `actAs` an owner
 * bypasses row security and every one of them would pass for the wrong reason.
 */

let t;
let seq = 91000;

const board = (who, metric = 'titles') =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select * from monthly_leaderboard($1, 50)`, [metric]);
    return rows;
  });

const standing = (who, metric = 'titles') =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select * from my_leaderboard_standing($1)`, [metric]);
    return rows[0];
  });

/** Handles in board order, which is the order the client draws. */
const names = (rows) => rows.map((r) => r.username);

/** A day inside the current month, safe for any month length. */
const thisMonth = (day = 5) => `date_trunc('month', current_date)::date + ${day - 1}`;

/**
 * Logs a watch directly.
 *
 * `log_watched` would be the app's route and is deliberately not used: it stamps and
 * coalesces dates through logic this file is not testing, and the fixtures here need to
 * place a watch on an exact day including days in the previous month. The column is the
 * canonical fact either way — that is the whole premise of the metric.
 */
const watch = (user, item, dateSql) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket, watched_on)
     values ($1, $2, 'loved', ${dateSql})
     on conflict (user_id, media_item_id)
       do update set watched_on = excluded.watched_on`,
    [user, item],
  );

const clearAll = () => t.sql(`delete from user_media`);

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------

describe('the month, and what falls inside it', () => {
  let alice;
  let film;
  let older;

  before(async () => {
    alice = await t.createUser({ username: 'lb_alice' });
    film = await t.createMovie('In The Month', seq++);
    older = await t.createMovie('Last Month', seq++);
  });

  beforeEach(clearAll);

  it('counts a watch dated inside the current month', async () => {
    await watch(alice, film, thisMonth(1));
    assert.deepEqual(names(await board(alice)), ['lb_alice']);
    assert.equal((await board(alice))[0].metric_count, 1);
  });

  it('does not count a watch dated in the previous month', async () => {
    // The boundary from the other side: one day before the month starts. A board that
    // counted this would never reset, which is the all-time board the founder ruled out.
    await watch(alice, older, `date_trunc('month', current_date)::date - 1`);
    assert.deepEqual(names(await board(alice)), []);
  });

  it('is half-open at the top, so nothing is in two months at once', async () => {
    await watch(alice, film, `(date_trunc('month', current_date) + interval '1 month')::date`);
    assert.deepEqual(names(await board(alice)), []);
  });

  /**
   * The boundary is UTC, and it is **the same** boundary for both kinds of metric.
   *
   * Independent review's finding: the first version used `current_date` and cast the
   * boundary with `::timestamptz`, both of which read the *session's* TimeZone. PostgREST
   * does not pin that, so around a rollover two connections could have answered for
   * different months — and worse, the watched metrics (date) and the reviews metric
   * (timestamptz) could have disagreed with each other inside one call.
   *
   * Driven by moving the session's timezone a long way in each direction: if either
   * boundary still consulted it, one of these three would differ.
   */
  /**
   * The boundary is UTC, and neither half of it may consult the session's timezone.
   *
   * Independent review's finding: the first version used `current_date` and cast the
   * boundary with `::timestamptz`, both of which read the connection's `TimeZone`.
   * PostgREST does not pin that, so two sessions could have answered for different
   * months — and the watched metrics (a `date`) and the Reviews metric (a `timestamptz`)
   * could have disagreed with each other inside a single call.
   *
   * **Two tests, because one of them only works two days a month.** `date_trunc('month',
   * …)` collapses a one-day shift to nothing for twenty-nine days out of thirty, so a
   * behavioural check on the date boundary is genuinely blind except around a rollover.
   * The static check is what holds every other day. `moderation.test.mjs` reads `prosrc`
   * for the same reason.
   */
  it('does not let the date boundary read the session clock', async () => {
    const { rows } = await t.sql(
      `select prosrc from pg_proc where proname = '_leaderboard_month_start'`,
    );
    const body = String(rows[0].prosrc).replace(/--[^\n]*/g, ' ');

    assert.match(body, /at\s+time\s+zone\s+'UTC'/i, 'the boundary must name its zone');
    assert.doesNotMatch(
      body,
      /current_date|localtimestamp|current_timestamp/i,
      'these all read the session TimeZone; the month must not move with the connection',
    );
  });

  it('agrees about the boundary from a session on the other side of the date line', async () => {
    /**
     * The Reviews half, and this one **is** discriminating on any date.
     *
     * Under Kiritimati (+14) a `date::timestamptz` cast resolves the month's first
     * midnight fourteen hours *earlier* than UTC does. So a review stamped one second
     * before the UTC month began would fall inside a session-relative window and be
     * counted into a month it does not belong to — which is exactly the defect, visible
     * every day of the month rather than only at a rollover.
     */
    const boundary =
      `(date_trunc('month', (now() at time zone 'UTC')) at time zone 'UTC')`;

    await t.sql(`set time zone 'Pacific/Kiritimati'`);
    try {
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket, note, note_visibility,
                                 note_first_published_at)
         values ($1, $2, 'loved', 'Last month, just.', 'public',
                 ${boundary} - interval '1 second')`,
        [alice, film],
      );
      assert.deepEqual(
        names(await board(alice, 'reviews')),
        [],
        'a review published before the UTC month began must not count in it',
      );

      await t.sql(
        `update user_media set note_first_published_at = ${boundary} + interval '1 second'
          where user_id = $1 and media_item_id = $2`,
        [alice, film],
      );
      assert.equal((await board(alice, 'reviews'))[0]?.metric_count, 1);
    } finally {
      await t.sql(`set time zone 'UTC'`);
    }
  });

  it('counts nothing for a watch with no date', async () => {
    // `20260824000100` made "I watched this and I do not remember when" a first-class
    // state. A memory without a date cannot be attributed to a month, and inventing one
    // is the only alternative.
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on)
       values ($1, $2, 'loved', null)`,
      [alice, film],
    );
    assert.deepEqual(names(await board(alice)), []);
  });
});

// ---------------------------------------------------------------------------

describe('the four metrics, in the order the chips draw them', () => {
  let alice;
  let movieA;
  let movieB;
  let seasonA;

  before(async () => {
    alice = await t.createUser({ username: 'lb_metrics' });
    movieA = await t.createMovie('Metric A', seq++);
    movieB = await t.createMovie('Metric B', seq++);
    const show = await t.createSeries('Metric Show', seq++);
    seasonA = await t.createSeason(show, 1, 'Metric Show S1');
  });

  beforeEach(clearAll);

  it('Titles is movies and seasons together', async () => {
    await watch(alice, movieA, thisMonth(2));
    await watch(alice, seasonA, thisMonth(3));
    assert.equal((await board(alice, 'titles'))[0].metric_count, 2);
  });

  it('Movies counts only films', async () => {
    await watch(alice, movieA, thisMonth(2));
    await watch(alice, movieB, thisMonth(3));
    await watch(alice, seasonA, thisMonth(4));
    assert.equal((await board(alice, 'movies'))[0].metric_count, 2);
  });

  it('TV counts only seasons', async () => {
    await watch(alice, movieA, thisMonth(2));
    await watch(alice, seasonA, thisMonth(4));
    assert.equal((await board(alice, 'tv'))[0].metric_count, 1);
  });

  it('never counts a series row, which is not loggable at all', async () => {
    // PRD §10: a series is browsed, not watched. It cannot be ranked, and a catalogue
    // row of the wrong kind must not reach a total through a direct write.
    const show = await t.createSeries('Whole Show', seq++);
    await watch(alice, show, thisMonth(2));
    assert.deepEqual(names(await board(alice, 'titles')), []);
    assert.deepEqual(names(await board(alice, 'tv')), []);
  });

  it('refuses a metric it does not have', async () => {
    const error = await t.asUser(alice, () =>
      t.errorFrom(`select * from monthly_leaderboard('comments', 50)`),
    );
    assert.equal(error?.code, 'P0002');
  });

  it('defaults an absent metric to Titles rather than to nothing', async () => {
    await watch(alice, movieA, thisMonth(2));
    const rows = await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select * from monthly_leaderboard()`);
      return rows;
    });
    assert.equal(rows[0].metric_count, 1);
  });
});

// ---------------------------------------------------------------------------

describe('a rewatch cannot buy a second point', () => {
  let alice;
  let film;

  before(async () => {
    alice = await t.createUser({ username: 'lb_rewatch' });
    film = await t.createMovie('Watched Twice', seq++);
  });

  beforeEach(clearAll);

  it('counts one title once however often it is logged', async () => {
    // Structural rather than a `distinct`: `user_media` is keyed (user, title), so a
    // rewatch is an UPDATE and there is no shape in which two rows exist to count.
    await watch(alice, film, thisMonth(2));
    await watch(alice, film, thisMonth(9));
    await watch(alice, film, thisMonth(20));
    assert.equal((await board(alice))[0].metric_count, 1);
  });

  it('moves the title to the month it was last watched in, rather than leaving both', async () => {
    await watch(alice, film, `date_trunc('month', current_date)::date - 10`);
    assert.deepEqual(names(await board(alice)), []);
    await watch(alice, film, thisMonth(3));
    assert.equal((await board(alice))[0].metric_count, 1);
  });
});

// ---------------------------------------------------------------------------

describe('Reviews, and the four ways it must not be inflated', () => {
  let alice;
  let film;

  const publish = (user, item, note, visibility = 'public') =>
    t.sql(
      `insert into user_media (user_id, media_item_id, bucket, note, note_visibility)
       values ($1, $2, 'loved', $3, $4::note_visibility)
       on conflict (user_id, media_item_id)
         do update set note = excluded.note, note_visibility = excluded.note_visibility`,
      [user, item, note, visibility],
    );

  const stamp = async (user, item) => {
    const { rows } = await t.sql(
      `select note_first_published_at from user_media where user_id = $1 and media_item_id = $2`,
      [user, item],
    );
    return rows[0]?.note_first_published_at ?? null;
  };

  before(async () => {
    alice = await t.createUser({ username: 'lb_reviews' });
    film = await t.createMovie('Reviewed', seq++);
  });

  beforeEach(clearAll);

  it('counts a note published this month', async () => {
    await publish(alice, film, 'A real review.');
    assert.equal((await board(alice, 'reviews'))[0].metric_count, 1);
  });

  it('does not count a private note', async () => {
    // A note nobody can read is not a review. It is the founder's list of exclusions and
    // the one most easily got wrong, because the text and the column are identical.
    await publish(alice, film, 'Just for me.', 'private');
    assert.deepEqual(names(await board(alice, 'reviews')), []);
    assert.equal(await stamp(alice, film), null);
  });

  it('does not re-stamp when the text is edited', async () => {
    await publish(alice, film, 'First thoughts.');
    const first = await stamp(alice, film);
    await publish(alice, film, 'Second thoughts, at length.');
    assert.deepEqual(await stamp(alice, film), first);
    assert.equal((await board(alice, 'reviews'))[0].metric_count, 1);
  });

  it('does not re-stamp when it is unshared and shared again', async () => {
    // The cheap duplicate point the founder ruled out by name. The stamp survives the
    // private round trip, so the second publication earns nothing.
    await publish(alice, film, 'Out loud.');
    const first = await stamp(alice, film);
    await publish(alice, film, 'Out loud.', 'private');
    assert.deepEqual(await stamp(alice, film), first, 'unsharing must not clear the fact');
    await publish(alice, film, 'Out loud.');
    assert.deepEqual(await stamp(alice, film), first);
    assert.equal((await board(alice, 'reviews'))[0].metric_count, 1);
  });

  it('refuses to have the stamp erased by a write that supplies null', async () => {
    // Rule 2 of the trigger, against a writer that does not know the column exists.
    await publish(alice, film, 'Durable.');
    const first = await stamp(alice, film);
    await t.sql(
      `update user_media set note_first_published_at = null
        where user_id = $1 and media_item_id = $2`,
      [alice, film],
    );
    assert.deepEqual(await stamp(alice, film), first);
  });

  it('counts one review per title, not one per edit', async () => {
    const second = await t.createMovie('Also Reviewed', seq++);
    await publish(alice, film, 'One.');
    await publish(alice, second, 'Two.');
    await publish(alice, film, 'One, revised.');
    await publish(alice, film, 'One, revised again.');
    assert.equal((await board(alice, 'reviews'))[0].metric_count, 2);
  });

  it('does not count a review published in a previous month', async () => {
    await publish(alice, film, 'Old news.');
    await t.sql(
      `update user_media
          set note_first_published_at = date_trunc('month', now()) - interval '2 days'
        where user_id = $1 and media_item_id = $2`,
      [alice, film],
    );
    assert.deepEqual(names(await board(alice, 'reviews')), []);
  });

  it('does not let a watch count as a review, or a review as a watch', async () => {
    await publish(alice, film, 'Words, no date.');
    assert.deepEqual(names(await board(alice, 'titles')), []);

    await clearAll();
    await watch(alice, film, thisMonth(2));
    assert.deepEqual(names(await board(alice, 'reviews')), []);
  });
});

// ---------------------------------------------------------------------------

describe('what is deliberately not a point', () => {
  let alice;
  let film;

  before(async () => {
    alice = await t.createUser({ username: 'lb_excluded' });
    film = await t.createMovie('Not Counted', seq++);
  });

  beforeEach(clearAll);

  it('does not count a watchlist entry', async () => {
    // Wanting to see something is not having seen it, and the watchlist is the surface
    // where a person collects intentions by the dozen.
    await t.sql(`delete from watchlist where user_id = $1`, [alice]);
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [alice, film]);
    assert.deepEqual(names(await board(alice, 'titles')), []);
  });

  it('does not count a ranking without a watch date', async () => {
    // A ranking is a position, not a month. `rankings` does not appear in the board's
    // query at all, and this is the assertion that keeps it that way.
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [alice, film],
    );
    assert.deepEqual(names(await board(alice, 'titles')), []);
    await t.sql(`delete from rankings where user_id = $1`, [alice]);
  });
});

// ---------------------------------------------------------------------------

describe('ordering, ties and the caller’s own row', () => {
  let one;
  let two;
  let three;
  let films;

  before(async () => {
    // Handles chosen so the alphabetical tie-break is checkable: `lb_rank_a` sorts first.
    one = await t.createUser({ username: 'lb_rank_c' });
    two = await t.createUser({ username: 'lb_rank_a' });
    three = await t.createUser({ username: 'lb_rank_b' });
    films = [];
    for (let i = 0; i < 5; i += 1) films.push(await t.createMovie(`Ranked ${i}`, seq++));
  });

  beforeEach(clearAll);

  it('puts the biggest number first', async () => {
    await watch(one, films[0], thisMonth(2));
    await watch(one, films[1], thisMonth(3));
    await watch(one, films[2], thisMonth(4));
    await watch(two, films[0], thisMonth(2));
    await watch(three, films[0], thisMonth(2));
    await watch(three, films[1], thisMonth(3));

    assert.deepEqual(names(await board(one)), ['lb_rank_c', 'lb_rank_b', 'lb_rank_a']);
  });

  it('gives tied people the same rank and orders them by handle', async () => {
    await watch(one, films[0], thisMonth(2));
    await watch(two, films[0], thisMonth(2));
    await watch(three, films[0], thisMonth(2));
    await watch(three, films[1], thisMonth(3));

    const rows = await board(one);
    assert.deepEqual(names(rows), ['lb_rank_b', 'lb_rank_a', 'lb_rank_c']);
    assert.deepEqual(
      rows.map((r) => r.rank),
      [1, 2, 2],
      'a tie shares a rank; the next person is not second',
    );
  });

  it('is deterministic across calls', async () => {
    await watch(one, films[0], thisMonth(2));
    await watch(two, films[0], thisMonth(2));
    assert.deepEqual(names(await board(one)), names(await board(one)));
  });

  it('leaves out people with nothing this month rather than listing zeroes', async () => {
    await watch(one, films[0], thisMonth(2));
    assert.deepEqual(names(await board(one)), ['lb_rank_c']);
  });

  it('marks the caller’s own row', async () => {
    await watch(one, films[0], thisMonth(2));
    await watch(two, films[0], thisMonth(2));

    const rows = await board(two);
    assert.deepEqual(
      rows.filter((r) => r.is_you).map((r) => r.username),
      ['lb_rank_a'],
    );
  });

  it('gives the caller their standing even when they are not on the page', async () => {
    await watch(one, films[0], thisMonth(2));
    await watch(one, films[1], thisMonth(3));
    await watch(two, films[0], thisMonth(2));

    const mine = await standing(two);
    assert.equal(mine.metric_count, 1);
    assert.equal(mine.rank, 2);
    assert.equal(mine.entrants, 2);
  });

  it('gives no rank at all to somebody who has done nothing', async () => {
    await watch(one, films[0], thisMonth(2));
    const mine = await standing(three);
    // Null and not 0: a person with nothing to count has no position, and last place is
    // a thing you earn by being on the board.
    assert.equal(mine.rank, null);
    assert.equal(mine.metric_count, 0);
    assert.equal(mine.entrants, 1);
  });

  it('returns an empty board, not an error, when nobody has watched anything', async () => {
    assert.deepEqual(names(await board(one)), []);
    const mine = await standing(one);
    assert.equal(mine.entrants, 0);
    assert.equal(mine.rank, null);
  });
});

// ---------------------------------------------------------------------------

describe('viewer-relative: the founder’s §26', () => {
  let viewer;
  let open;
  let hidden;
  let approver;
  let blocker;
  let film;
  let second;

  before(async () => {
    viewer = await t.createUser({ username: 'lb_viewer' });
    open = await t.createUser({ username: 'lb_open' });
    hidden = await t.createUser({ username: 'lb_hidden', visibility: 'private' });
    approver = await t.createUser({ username: 'lb_approver', visibility: 'private' });
    blocker = await t.createUser({ username: 'lb_blocker' });

    film = await t.createMovie('Seen By All', seq++);
    second = await t.createMovie('Seen By All Two', seq++);

    // The private account that approved the viewer.
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [viewer, approver],
    );
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [blocker, viewer]);
  });

  beforeEach(async () => {
    await clearAll();
    for (const person of [open, hidden, approver, blocker]) {
      await watch(person, film, thisMonth(2));
      await watch(person, second, thisMonth(3));
    }
  });

  it('shows a public account', async () => {
    assert.ok(names(await board(viewer)).includes('lb_open'));
  });

  it('does not show a private account the viewer has not been approved by', async () => {
    // The whole of §26. `lb_hidden` has watched two things and is a real entrant on
    // somebody else's board; on this viewer's it does not exist, count and all.
    assert.ok(!names(await board(viewer)).includes('lb_hidden'));
  });

  it('is not merely hiding the name — the count is absent too', async () => {
    const rows = await board(viewer);
    assert.equal(
      rows.filter((r) => r.username === 'lb_hidden').length,
      0,
      'a masked row with a real count is the leak this test exists for',
    );
    // And the denominator agrees: a viewer must not be able to infer a hidden entrant by
    // counting the board against `entrants`.
    const mine = await standing(viewer);
    assert.equal(mine.entrants, rows.length);
  });

  it('shows a private account that approved the viewer', async () => {
    assert.ok(names(await board(viewer)).includes('lb_approver'));
  });

  it('does not show somebody who blocked the viewer', async () => {
    assert.ok(!names(await board(viewer)).includes('lb_blocker'));
  });

  it('does not show a suspended account', async () => {
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [open]);
    try {
      assert.ok(!names(await board(viewer)).includes('lb_open'));
    } finally {
      await t.sql(`update profiles set status = 'active' where id = $1`, [open]);
    }
  });

  it('always shows the caller themselves, private or not', async () => {
    await watch(hidden, film, thisMonth(2));
    assert.ok(names(await board(hidden)).includes('lb_hidden'));
  });

  it('gives the private account its own full board while hiding it from strangers', async () => {
    // The property that makes viewer-relativity honest rather than a punishment: the
    // same call is a different list for every caller, and nobody's own numbers vanish.
    const theirs = await board(hidden);
    assert.ok(names(theirs).includes('lb_hidden'));
    assert.ok(names(theirs).includes('lb_open'));
  });

  it('tells an anonymous caller nothing', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select * from monthly_leaderboard('titles', 50)`),
    );
    assert.ok(error, 'anon must not be able to execute the board at all');
  });

  it('never returns a title or a date', async () => {
    const rows = await board(viewer);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      'avatar_path',
      'display_name',
      'is_you',
      'metric_count',
      'rank',
      'user_id',
      'username',
      'visibility',
    ]);
  });
});
