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

const board = (who, metric = 'titles', timeframe = 'month') =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select * from leaderboard($1, $2, 50)`, [metric, timeframe]);
    return rows;
  });

const standing = (who, metric = 'titles', timeframe = 'month') =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select * from my_leaderboard_standing($1, $2)`, [
      metric,
      timeframe,
    ]);
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

  /**
   * The founder's report of 2026-08-30, and the correction `20260903000100` makes.
   *
   * `20260824000100` made "I watched this and I do not remember when" a first-class
   * state, and `set_bucket` creates a collection row with no date at all -- so on nonprod
   * five of twelve accounts had no dated row and could not appear on the monthly board
   * whatever they did. The month a watch belongs to is now the watch date, or failing
   * that the day the title entered the collection: a fact about the reader that the
   * writer recorded and no later edit moves.
   */
  it('counts an undated watch in the month it was logged', async () => {
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on)
       values ($1, $2, 'loved', null)`,
      [alice, film],
    );
    assert.deepEqual(names(await board(alice)), ['lb_alice']);
    assert.equal((await board(alice))[0].metric_count, 1);
  });

  it('counts an undated watch logged in a previous month in that month, not this one', async () => {
    // The fallback is a fallback and not a licence: one row is in one month, and the
    // month is when the reader actually did the thing.
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on, created_at)
       values ($1, $2, 'loved', null,
               (date_trunc('month', (now() at time zone 'UTC')) - interval '1 day'))`,
      [alice, film],
    );
    assert.deepEqual(names(await board(alice)), []);
  });

  it('lets the watch date override the logging date, in both directions', async () => {
    // A film logged today and dated last month counts last month, which is the whole
    // point of `watched_on` being the first half of the coalesce.
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on)
       values ($1, $2, 'loved', date_trunc('month', current_date)::date - 1)`,
      [alice, film],
    );
    assert.deepEqual(names(await board(alice)), []);

    // And a film logged last month but dated this one counts this month.
    await t.sql(
      `update user_media set watched_on = ${thisMonth(2)},
              created_at = (date_trunc('month', (now() at time zone 'UTC')) - interval '1 day')
        where user_id = $1 and media_item_id = $2`,
      [alice, film],
    );
    assert.deepEqual(names(await board(alice)), ['lb_alice']);
  });

  /**
   * The invariant that *is* promised, and the one that is not.
   *
   * Review 77 pointed out that an undated row counted in the month it was logged can be
   * given a later watch date and count again in that later month. True, and deliberately
   * not fixed: `log_watched` has always upserted `watched_on`, so a dated row re-dated to
   * a different month did exactly this before the coalesce existed. Pinning a row to the
   * first month it ever scored in needs a ledger, and the alternative to that ledger is a
   * product that refuses to believe a reader correcting a date.
   *
   * What holds, and what this asserts: a row is in exactly **one** month at a time and
   * counts **once** on any board, whatever it is touched with.
   */
  it('counts one row once, however many times it is written', async () => {
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on)
       values ($1, $2, 'loved', null)`,
      [alice, film],
    );
    assert.equal((await board(alice))[0].metric_count, 1);

    // Re-bucketing, dating inside the same month, and re-noting are all one row still.
    await t.sql(
      `update user_media set bucket = 'fine' where user_id = $1 and media_item_id = $2`,
      [alice, film],
    );
    await t.sql(
      `update user_media set watched_on = ${thisMonth(9)}
        where user_id = $1 and media_item_id = $2`,
      [alice, film],
    );
    assert.equal((await board(alice))[0].metric_count, 1);

    // And the fallback never adds to the date: a dated row is counted by its date alone.
    await t.sql(
      `update user_media set created_at = (now() at time zone 'UTC') - interval '400 days'
        where user_id = $1 and media_item_id = $2`,
      [alice, film],
    );
    assert.equal((await board(alice))[0].metric_count, 1);
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

  it('does not let a watch count as a review, or a review add a second title', async () => {
    /**
     * The half that has always mattered is the second: a watch is not a review, and a
     * board that counted it would be measuring the wrong thing entirely.
     *
     * The first half is restated for `20260903000100`. It used to read "a review with no
     * watch date counts nothing for Titles", which was true only because the monthly
     * metric refused an undated row — the gap that kept whole accounts off the board. A
     * review can only exist on a title already in the collection (`save_note` raises
     * P0002 otherwise), so that row is a logged title and counts as one. What must not
     * happen is that writing about it counts *again*: the metrics are separate, and
     * `user_media` is keyed by title.
     */
    await publish(alice, film, 'Words, no date.');
    assert.equal((await board(alice, 'titles'))[0].metric_count, 1);
    await publish(alice, film, 'Words, revised.');
    assert.equal((await board(alice, 'titles'))[0].metric_count, 1);

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

/**
 * **Who is on the board, and what a row is allowed to say about them.**
 *
 * The founder's §26 made the population `can_view_profile`, so an unapproved private
 * account was absent from the board entirely. **That was reversed on 2026-08-30**
 * (20260902000100) for the reason 20260819000100 gave when it made a private account
 * discoverable by name: privacy is about what somebody wrote, not about whether they can
 * be found -- and a board that silently omits people also lies about where the reader
 * stands.
 *
 * So the question this suite asks changed shape. It is no longer "is the row there"; it
 * is **"which fields is the row allowed to carry"**, and it is asked once per relationship:
 *
 *   public                  full row, Match included
 *   private + approved      full row, Match included -- approval is what Match needs
 *   private + unapproved    minimal row: rank, handle, name, avatar, visibility, count
 *   self                    full row, always, whatever the account's own visibility
 *   blocked either way      no row at all
 *   suspended               no row at all
 *   deleted                 no row at all
 *
 * The distinction that matters is between *private* and *unreadable*, and the function
 * returns both -- `visibility` for the lock the client draws, `viewable` for whether
 * there is anything else to draw. An approved follower of a private account is
 * `private` and `viewable`, which is why one flag could not carry it.
 */
describe('viewer-relative: the founder’s §26, as amended', () => {
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

  it('shows a private account the viewer has not been approved by', async () => {
    // The 2026-08-30 reversal. `lb_hidden` has watched two things and is a real entrant;
    // it is now on this viewer's board too, so the ranking is not quietly wrong.
    assert.ok(names(await board(viewer)).includes('lb_hidden'));
  });

  it('gives that account a minimal row and nothing more', async () => {
    const row = (await board(viewer)).find((r) => r.username === 'lb_hidden');
    assert.ok(row, 'the row must be present to be minimal');

    // What the founder allowed: position, identity, the private flag, and the one number
    // that explains the position.
    assert.equal(row.visibility, 'private');
    assert.equal(row.viewable, false);
    assert.equal(row.metric_count, 2);
    assert.ok(Number.isInteger(row.rank));
    assert.equal(row.username, 'lb_hidden');

    // What it must not carry. Null and not zero: `0 shared` is a claim about a
    // collection this viewer has never been let into, and it is indistinguishable from
    // a real answer -- which is why the projection nulls both columns rather than
    // relying on `taste_match` returning its insufficient-overlap shape.
    assert.equal(row.match_percent, null);
    assert.equal(row.shared_count, null);
  });

  it('returns no field the client would have to conceal', async () => {
    // The founder's rule: "do not solve this by fetching private data and hiding it in
    // React Native". Asserted over the row's own values rather than over a list of
    // column names, so a column added later cannot smuggle a value through.
    const row = (await board(viewer)).find((r) => r.username === 'lb_hidden');
    const allowed = new Set([
      'user_id',
      'username',
      'display_name',
      'avatar_path',
      'visibility',
      'metric_count',
      'rank',
      'is_you',
      'viewable',
    ]);
    for (const [column, value] of Object.entries(row)) {
      if (allowed.has(column)) continue;
      assert.equal(value, null, `${column} carries a value on an unreadable row`);
    }
  });

  it('counts the private entrant in the denominator, because it is on the board', async () => {
    // `entrants` and the page must agree. They disagreed in the other direction before:
    // the row was absent and the count excluded it, which was consistent. Both moved
    // together, which is the property, and a reader who scrolls must not be able to
    // reach a different total than the one pinned under the list.
    const rows = await board(viewer);
    const mine = await standing(viewer);
    assert.equal(mine.entrants, rows.length);
    assert.ok(names(rows).includes('lb_hidden'));
  });

  it('replays the RPC directly and gets the same minimal row', async () => {
    // The projection is the privacy rule, so it has to hold for a caller who is not the
    // app -- a modified client, or somebody with the anon key and a session, calling
    // `leaderboard` by hand with a different limit.
    const rows = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from leaderboard('titles', 'month', 100)`);
      return rows;
    });
    const row = rows.find((r) => r.username === 'lb_hidden');
    assert.ok(row);
    assert.equal(row.viewable, false);
    assert.equal(row.match_percent, null);
    assert.equal(row.shared_count, null);
  });

  it('gives an approved follower the full row, Match included', async () => {
    // Private is not the same question as unreadable, and this is the row that proves
    // it: same visibility as `lb_hidden`, opposite treatment, because approval is what
    // Match is computed across.
    const row = (await board(viewer)).find((r) => r.username === 'lb_approver');
    assert.ok(row);
    assert.equal(row.visibility, 'private');
    assert.equal(row.viewable, true);
    assert.notEqual(row.shared_count, null);
  });

  it('shows a public account as viewable', async () => {
    const row = (await board(viewer)).find((r) => r.username === 'lb_open');
    assert.equal(row.visibility, 'public');
    assert.equal(row.viewable, true);
  });

  it('shows a private account that approved the viewer', async () => {
    assert.ok(names(await board(viewer)).includes('lb_approver'));
  });

  it('does not show somebody who blocked the viewer', async () => {
    assert.ok(!names(await board(viewer)).includes('lb_blocker'));
  });

  it('does not show somebody the viewer blocked, either', async () => {
    // A block is symmetrical here and the widened population must not have opened one
    // direction of it. `can_discover_profile` refuses both, ahead of everything else,
    // which is the property being asserted rather than assumed.
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [viewer, open]);
    try {
      assert.ok(!names(await board(viewer)).includes('lb_open'));
      // And the private row is unaffected by an unrelated block.
      assert.ok(names(await board(viewer)).includes('lb_hidden'));
    } finally {
      await t.sql(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [viewer, open]);
    }
  });

  it('does not show a suspended private account', async () => {
    // Suspension outranks discoverability. The widened population is the one place this
    // could have been lost, because the new branch is about *finding* people.
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [hidden]);
    try {
      assert.ok(!names(await board(viewer)).includes('lb_hidden'));
    } finally {
      await t.sql(`update profiles set status = 'active' where id = $1`, [hidden]);
    }
  });

  it('shows nothing for an account that no longer exists', async () => {
    // A deleted account has no `profiles` row, so it cannot be found by either branch
    // and its `user_media` went with it through the cascade.
    const gone = await t.createUser({ username: 'lb_gone', visibility: 'private' });
    await watch(gone, film, thisMonth(2));
    assert.ok(names(await board(viewer)).includes('lb_gone'));

    await t.sql(`delete from profiles where id = $1`, [gone]);
    assert.ok(!names(await board(viewer)).includes('lb_gone'));
  });

  it('gives the private account the minimal treatment on every metric', async () => {
    // Four chips, one projection. A metric that computed its own population -- or a
    // fifth added later reading `can_view_profile` directly -- is what this refuses.
    await t.sql(
      `update user_media set note = 'A review', note_visibility = 'public',
              note_first_published_at = now()
        where user_id = $1`,
      [hidden],
    );
    for (const metric of ['titles', 'movies', 'tv', 'reviews']) {
      for (const timeframe of ['month', 'all_time']) {
        const row = (await board(viewer, metric, timeframe)).find(
          (r) => r.username === 'lb_hidden',
        );
        if (!row) continue; // TV is zero here, and a zero is absent for everybody.
        assert.equal(row.viewable, false, `${metric}/${timeframe} leaked viewable`);
        assert.equal(row.match_percent, null, `${metric}/${timeframe} leaked Match`);
        assert.equal(row.shared_count, null, `${metric}/${timeframe} leaked shared`);
      }
    }
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
      // Match and its evidence, added 20260829000100. Two numbers about the *pair*,
      // decided by taste_match itself — never a title, never a date, never a ranking.
      'match_percent',
      'metric_count',
      'rank',
      'shared_count',
      'user_id',
      'username',
      // Whether the caller may read this account, which is not the same question as
      // whether it is private (20260902000100). It is a boolean about permission and
      // says nothing about the account beyond what `visibility` already did.
      'viewable',
      'visibility',
    ]);
  });
});

// ---------------------------------------------------------------------------

/**
 * All time — `20260829000100`.
 *
 * The founder approved it as an alternate view and was explicit that This month stays the
 * default: a monthly board resets incumbent advantage, and an all-time board is decided
 * once and then never moves. So these tests are about the *second* view being honest
 * rather than about it being primary.
 *
 * Three of the four metrics are the monthly ones with the date window removed. **Reviews
 * is different in kind** — a state rather than an event — and that asymmetry is the part
 * most worth pinning, because it is the one a reader would assume was a mistake.
 */
describe('the all-time board', () => {
  let alice;
  let bob;
  let movieA;
  let movieB;
  let seasonA;

  before(async () => {
    alice = await t.createUser({ username: 'at_alice' });
    bob = await t.createUser({ username: 'at_bob' });
    movieA = await t.createMovie('All Time A', seq++);
    movieB = await t.createMovie('All Time B', seq++);
    const show = await t.createSeries('All Time Show', seq++);
    seasonA = await t.createSeason(show, 1, 'All Time Show S1');
  });

  beforeEach(clearAll);

  it('counts watches from every month, not just this one', async () => {
    await watch(alice, movieA, `date_trunc('month', current_date)::date - 400`);
    await watch(alice, movieB, thisMonth(2));

    assert.deepEqual(names(await board(alice, 'titles', 'month')), ['at_alice']);
    assert.equal((await board(alice, 'titles', 'month'))[0].metric_count, 1);
    assert.equal((await board(alice, 'titles', 'all_time'))[0].metric_count, 2);
  });

  /**
   * The two boards agree about an undated watch, and since `20260903000100` they agree
   * that it counts.
   *
   * `20260824000100` made "I watched this and I do not remember when" a first-class
   * state, and monthly used to refuse such a row outright — which excluded a whole class
   * of account from the board rather than applying a stricter metric to it. All-time has
   * no month to be wrong about and always counted it; monthly now attributes it to the
   * month the title entered the collection. What remains different between the two
   * boards is only the window.
   */
  it('counts a watch with no date on both boards', async () => {
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on)
       values ($1, $2, 'loved', null)`,
      [alice, movieA],
    );

    assert.equal((await board(alice, 'titles', 'month'))[0].metric_count, 1);
    assert.equal((await board(alice, 'titles', 'all_time'))[0].metric_count, 1);
  });

  it('splits Movies and TV the same way', async () => {
    await watch(alice, movieA, `date_trunc('month', current_date)::date - 700`);
    await watch(alice, movieB, `date_trunc('month', current_date)::date - 60`);
    await watch(alice, seasonA, `date_trunc('month', current_date)::date - 900`);

    assert.equal((await board(alice, 'movies', 'all_time'))[0].metric_count, 2);
    assert.equal((await board(alice, 'tv', 'all_time'))[0].metric_count, 1);
    assert.equal((await board(alice, 'titles', 'all_time'))[0].metric_count, 3);
  });

  it('still refuses a series', async () => {
    const show = await t.createSeries('Not Rankable', seq++);
    await watch(alice, show, `date_trunc('month', current_date)::date - 30`);
    assert.deepEqual(names(await board(alice, 'titles', 'all_time')), []);
  });

  it('still counts a rewatched title once', async () => {
    await watch(alice, movieA, `date_trunc('month', current_date)::date - 300`);
    await watch(alice, movieA, thisMonth(3));
    assert.equal((await board(alice, 'titles', 'all_time'))[0].metric_count, 1);
  });

  describe('Reviews, which is a state rather than an event', () => {
    const publish = (user, item, visibility = 'public') =>
      t.sql(
        `insert into user_media (user_id, media_item_id, bucket, note, note_visibility)
         values ($1, $2, 'loved', 'Words.', $3::note_visibility)
         on conflict (user_id, media_item_id)
           do update set note = excluded.note, note_visibility = excluded.note_visibility`,
        [user, item, visibility],
      );

    it('counts titles currently carrying a public review, whenever written', async () => {
      await publish(alice, movieA);
      await publish(alice, movieB);
      // Backdate one publication well out of this month; all-time does not care.
      await t.sql(
        `update user_media set note_first_published_at = now() - interval '400 days'
          where user_id = $1 and media_item_id = $2`,
        [alice, movieA],
      );

      assert.equal((await board(alice, 'reviews', 'month'))[0].metric_count, 1);
      assert.equal((await board(alice, 'reviews', 'all_time'))[0].metric_count, 2);
    });

    it('drops a review that has been unshared, and restores it on re-share', async () => {
      // The state reading in one test. Un-sharing lowers the number and re-sharing puts
      // it back — so the toggle is a way of reaching a count already earned, never a way
      // of exceeding it. That is what makes an all-time board unfarmable by a different
      // mechanism than the monthly one's stamped-once fact.
      await publish(alice, movieA);
      assert.equal((await board(alice, 'reviews', 'all_time'))[0].metric_count, 1);

      await publish(alice, movieA, 'private');
      assert.deepEqual(names(await board(alice, 'reviews', 'all_time')), []);

      await publish(alice, movieA, 'public');
      assert.equal((await board(alice, 'reviews', 'all_time'))[0].metric_count, 1);
    });

    it('cannot be farmed past the number of titles actually reviewed', async () => {
      await publish(alice, movieA);
      for (let i = 0; i < 5; i += 1) {
        await publish(alice, movieA, 'private');
        await publish(alice, movieA, 'public');
      }
      assert.equal((await board(alice, 'reviews', 'all_time'))[0].metric_count, 1);
      // And the monthly board is unmoved too: the stamp never re-fires.
      assert.equal((await board(alice, 'reviews', 'month'))[0].metric_count, 1);
    });

    it('does not count a private note', async () => {
      await publish(alice, movieA, 'private');
      assert.deepEqual(names(await board(alice, 'reviews', 'all_time')), []);
    });
  });

  it('orders and ties exactly as the monthly board does', async () => {
    await watch(alice, movieA, `date_trunc('month', current_date)::date - 500`);
    await watch(alice, movieB, `date_trunc('month', current_date)::date - 500`);
    await watch(bob, movieA, `date_trunc('month', current_date)::date - 500`);

    const rows = await board(alice, 'titles', 'all_time');
    assert.deepEqual(names(rows), ['at_alice', 'at_bob']);
    assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
  });

  it('gives the caller a standing in the timeframe they asked for', async () => {
    await watch(alice, movieA, `date_trunc('month', current_date)::date - 500`);
    await watch(bob, movieA, thisMonth(2));

    assert.equal((await standing(alice, 'titles', 'month')).rank, null);
    assert.equal((await standing(alice, 'titles', 'all_time')).rank, 1);
  });

  it('refuses a timeframe it does not have', async () => {
    // Week and year were ruled out by the founder. An unknown value is a visible failure
    // rather than a silent fall back to this month.
    const error = await t.asUser(alice, () =>
      t.errorFrom(`select * from leaderboard('titles', 'this_week', 50)`),
    );
    assert.equal(error?.code, 'P0002');
  });

  it('defaults to this month when no timeframe is given', async () => {
    await watch(alice, movieA, `date_trunc('month', current_date)::date - 500`);
    const rows = await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select * from leaderboard('titles')`);
      return rows;
    });
    assert.deepEqual(rows.map((r) => r.username), [], 'the default view is this month');
  });

  it('applies the same minimal-row rule to the all-time board', async () => {
    // One population filter and one projection; both timeframes use them, so a private
    // account is listed-but-minimal in All time exactly as it is in This month. The
    // all-time view is where a divergence would be least likely to be noticed, because
    // it is the tab a reader visits least.
    const hidden = await t.createUser({ username: 'at_hidden', visibility: 'private' });
    await watch(hidden, movieA, `date_trunc('month', current_date)::date - 500`);

    const seen = (await board(alice, 'titles', 'all_time')).find(
      (r) => r.username === 'at_hidden',
    );
    assert.ok(seen, 'a private account is on the all-time board');
    assert.equal(seen.viewable, false);
    assert.equal(seen.match_percent, null);
    assert.equal(seen.shared_count, null);
    assert.ok(seen.metric_count > 0);

    // And their own board is unchanged: nobody's own numbers are minimal to themselves.
    const own = (await board(hidden, 'titles', 'all_time')).find(
      (r) => r.username === 'at_hidden',
    );
    assert.ok(own);
    assert.equal(own.viewable, true);
    assert.equal(own.is_you, true);
  });
});

// ---------------------------------------------------------------------------

/**
 * Match on the row — founder §6 and the row-polish addendum.
 *
 * `20260826000600` part N refused Match on the Followers list on a cost argument: fifty
 * rows would be fifty `taste_match` calls and there is no batched form. That reasoning is
 * unchanged, which is exactly why it is allowed here — `people_taste_matches` already
 * pays the same price over a set bounded to thirty, and this board is bounded to a
 * hundred on a surface whose whole purpose is social discovery.
 *
 * The privacy claim is that nothing is decided *here*: `taste_match` refuses the caller
 * themselves and anyone `can_view_profile` does not admit, and returns the identical
 * insufficient-overlap shape either way.
 */
describe('Match beside the name', () => {
  let viewer;
  let other;
  let film;

  before(async () => {
    viewer = await t.createUser({ username: 'lm_viewer' });
    other = await t.createUser({ username: 'lm_other' });
    film = await t.createMovie('Match Row', seq++);
  });

  beforeEach(clearAll);

  it('carries a shared count and a null score when the overlap is thin', async () => {
    await watch(viewer, film, thisMonth(2));
    await watch(other, film, thisMonth(2));

    const rows = await board(viewer, 'titles');
    const theirs = rows.find((r) => r.username === 'lm_other');
    assert.equal(theirs.match_percent, null, 'no score below the shared-title minimum');
    assert.equal(theirs.shared_count, 0, 'and nothing ranked in common');
  });

  it('returns nulls on the caller’s own row', async () => {
    // A 100% match with your own catalogue is a tautology. `taste_match` refuses the self
    // case, so the row carries nothing and the client draws "You" there instead.
    await watch(viewer, film, thisMonth(2));

    const mine = (await board(viewer, 'titles')).find((r) => r.is_you);
    assert.equal(mine.match_percent, null);
    assert.equal(mine.shared_count, 0);
  });

  it('says the same thing in both timeframes', async () => {
    await watch(viewer, film, `date_trunc('month', current_date)::date - 500`);
    await watch(other, film, `date_trunc('month', current_date)::date - 500`);

    const rows = await board(viewer, 'titles', 'all_time');
    const theirs = rows.find((r) => r.username === 'lm_other');
    assert.equal(theirs.shared_count, 0);
    assert.equal(theirs.match_percent, null);
  });
});

// ---------------------------------------------------------------------------

/**
 * The founder's report of 2026-08-30, reproduced as a fixture.
 *
 * A followed public account with two ranked films this month was absent from the Titles
 * board while accounts with counts of one and two were on it. Privacy was not the cause
 * and the account was not hidden: its rows carry no `watched_on`, because `set_bucket`
 * creates a collection row without one and the reader never opened the Log sheet to
 * stamp a date. `20260903000100` gives every collection row a month.
 *
 * The point of doing it this way round — a whole board rather than one count — is that
 * the defect was never only about the missing row. A board that omits an entrant is also
 * a board that lies to everyone below them about where they stand.
 */
describe('an account that ranks without dating anything', () => {
  let viewer;
  let dated;
  let undated;
  let films;

  before(async () => {
    viewer = await t.createUser({ username: 'lb_silky_view' });
    dated = await t.createUser({ username: 'lb_silky_dated' });
    undated = await t.createUser({ username: 'lb_silky_plain' });
    films = [];
    for (let i = 0; i < 3; i += 1) films.push(await t.createMovie(`Silky ${i}`, seq++));
  });

  beforeEach(clearAll);

  /** What `set_bucket` writes: a collection row with a band and no date at all. */
  const bucketOnly = (user, item) =>
    t.sql(
      `insert into user_media (user_id, media_item_id, bucket)
       values ($1, $2, 'loved')
       on conflict (user_id, media_item_id) do update set bucket = excluded.bucket`,
      [user, item],
    );

  it('competes on the monthly board with the people who dated theirs', async () => {
    await watch(dated, films[0], thisMonth(3));
    await bucketOnly(undated, films[1]);
    await bucketOnly(undated, films[2]);

    const rows = await board(viewer, 'titles', 'month');
    const theirs = rows.find((row) => row.username === 'lb_silky_plain');

    assert.ok(theirs, 'an account whose rows carry no watch date must still be on the board');
    assert.equal(theirs.metric_count, 2);
    // And it is above the dated account with one, which is the half of the defect that
    // was invisible: the board had been telling that reader they were first.
    assert.deepEqual(names(rows), ['lb_silky_plain', 'lb_silky_dated']);
    assert.deepEqual(
      rows.map((row) => row.rank),
      [1, 2],
    );
  });

  it('says the same thing to the reader about their own standing', async () => {
    await bucketOnly(undated, films[0]);
    await bucketOnly(undated, films[1]);

    const mine = await standing(undated, 'titles', 'month');
    assert.equal(mine.metric_count, 2);
    assert.equal(mine.rank, 1);
  });

  it('counts both boards the same way for an account that dates nothing', async () => {
    await bucketOnly(undated, films[0]);

    assert.equal((await board(viewer, 'titles', 'month')).length, 1);
    assert.equal((await board(viewer, 'titles', 'all_time')).length, 1);
  });
});
