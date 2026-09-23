import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * T1 — the watch-event foundation (`20261003000100`).
 *
 * `watch-history-and-ranking-calibration.md` §D, and §O.2's "watch semantics, asserted
 * per entry path" — each of §D.6's paths is a test here.
 *
 * The three facts under test, and they are the three the schema has always blurred:
 *
 *   SEEN       the `user_media` row exists
 *   WATCH      a `watch_events` row, whose date may be null and whose null is data
 *   RECORDING  `recorded_at`, `user_media.created_at` — never substituted for a watch
 *
 * The invariant `assert_watch_history_valid()` is asserted after every mutation in this
 * file rather than at the end, because cache drift (§O.6.2) is the failure that is
 * invisible one statement later and obvious a hundred statements later.
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
  user = await t.createUser({ username: `watch_${seq}` });
  await t.actAs(user);
});

const movie = (title) => t.createMovie(title, (seq += 1) + 91000);
const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const call = async (sql, params) => {
  const { rows } = await t.sql(`select ${sql} as result`, params);
  return rows[0].result;
};

/** Every event on a title, in §D.2's rewatch order. */
const events = async (mediaItemId) => {
  const { rows } = await t.sql(
    `select id, watched_on, basis, import_ref, recorded_at
       from watch_events
      where user_id = $1 and media_item_id = $2
      order by watched_on nulls first, recorded_at`,
    [user, mediaItemId],
  );
  return rows;
};

const cached = async (mediaItemId) => {
  const { rows } = await t.sql(
    `select watched_on, source, bucket from user_media where user_id = $1 and media_item_id = $2`,
    [user, mediaItemId],
  );
  return rows[0] ?? null;
};

/** The whole point: it must hold after every write, not only at the end. */
const valid = () => t.sql(`select assert_watch_history_valid($1)`, [user]);

const iso = (d) => (d === null ? null : new Date(d).toISOString().slice(0, 10));

describe('T1 · seen implies a watch', () => {
  it('set_bucket creates the seen row and the deferred trigger gives it an undated event', async () => {
    const m = await movie('Heat');
    await call(`set_bucket($1, $2, 'loved')`, [await op(), m]);

    const rows = await events(m);
    assert.equal(rows.length, 1, 'exactly one event');
    assert.equal(rows[0].watched_on, null, 'seen with no known timing');
    assert.equal(rows[0].basis, 'none');
    assert.equal((await cached(m)).watched_on, null, 'the cache says no known date');
    await valid();
  });

  it('the event a seen row gets is recorded at the row’s own creation instant, not now()', async () => {
    // §M.3's honest recording time. A backfilled row's disclosure happened years ago,
    // and `now()` would claim the whole library was disclosed during a migration.
    const m = await movie('Thief');
    await call(`set_bucket($1, $2, 'fine')`, [await op(), m]);

    const { rows } = await t.sql(
      `select we.recorded_at = um.created_at as same
         from watch_events we
         join user_media um
           on um.user_id = we.user_id and um.media_item_id = we.media_item_id
        where we.user_id = $1 and we.media_item_id = $2`,
      [user, m],
    );
    assert.equal(rows[0].same, true);
  });

  it('a series never gets an event, because a series is never watched', async () => {
    // `rankable_category` is asked rather than assumed. `_assert_loggable` refuses a
    // series today; a phantom event for one would sit in W1's way for ever.
    const s = await t.createSeries('The Wire', (seq += 1) + 92000);
    const err = await t.errorFrom(`select set_bucket($1, $2, 'loved')`, [await op(), s]);
    assert.ok(err, 'a series cannot be logged at all');
    await valid();
  });
});

describe('T1 · log_title, the normal log (§D.5, §D.6 path 1)', () => {
  it('creates the seen row and dates its one event', async () => {
    const m = await movie('Collateral');
    const r = await call(`log_title($1, $2, 'loved', current_date, 'today_default')`, [
      await op(),
      m,
    ]);
    assert.equal(r.status, 'ok');
    assert.equal(r.created, true);

    const rows = await events(m);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].basis, 'today_default');
    assert.notEqual(rows[0].watched_on, null);
    assert.equal(iso((await cached(m)).watched_on), iso(rows[0].watched_on), 'cache follows');
    await valid();
  });

  it('Earlier writes one undated event and no date anywhere', async () => {
    const m = await movie('Ronin');
    await call(`log_title($1, $2, 'fine', null, 'none')`, [await op(), m]);

    const rows = await events(m);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].basis, 'none');
    assert.equal(rows[0].watched_on, null);
    assert.equal((await cached(m)).watched_on, null);
    await valid();
  });

  it('on an ALREADY-SEEN title it sets the bucket and ignores the date (§D.6 path 3)', async () => {
    // The whole of T0b, enforced in the server. "Ranking now" is not "watched now".
    const m = await movie('Manhunter');
    await call(`log_title($1, $2, 'fine', null, 'none')`, [await op(), m]);
    await call(`log_title($1, $2, 'loved', current_date, 'today_default')`, [await op(), m]);

    const rows = await events(m);
    assert.equal(rows.length, 1, 'no second event');
    assert.equal(rows[0].basis, 'none', 'and no date fabricated onto the first');
    assert.equal((await cached(m)).bucket, 'loved', 'the bucket did move');
    assert.equal((await cached(m)).watched_on, null);
    await valid();
  });

  it('refuses a basis that disagrees with the date, in both directions', async () => {
    const m = await movie('Blackhat');
    assert.ok(
      await t.errorFrom(`select log_title($1, $2, 'loved', current_date, 'none')`, [await op(), m]),
      'a date with basis none',
    );
    assert.ok(
      await t.errorFrom(`select log_title($1, $2, 'loved', null, 'reader')`, [await op(), m]),
      'a basis that claims a date it has not got',
    );
    assert.ok(
      await t.errorFrom(`select log_title($1, $2, 'loved', current_date, 'diary')`, [await op(), m]),
      'diary is the importer’s basis and no client may claim it',
    );
  });

  it('refuses a future date beyond tomorrow, and accepts tomorrow', async () => {
    // current_date + 1, because the server is UTC and the client sends a local date.
    const a = await movie('Ali');
    await call(`log_title($1, $2, 'fine', current_date + 1, 'reader')`, [await op(), a]);
    const b = await movie('Public Enemies');
    assert.ok(
      await t.errorFrom(`select log_title($1, $2, 'fine', current_date + 2, 'reader')`, [
        await op(),
        b,
      ]),
    );
  });

  it('replays to the same answer and writes nothing twice', async () => {
    const m = await movie('The Insider');
    const id = await op();
    const first = await call(`log_title($1, $2, 'loved', current_date, 'today_default')`, [id, m]);
    const again = await call(`log_title($1, $2, 'loved', current_date, 'today_default')`, [id, m]);
    assert.deepEqual(again, first, 'the stored answer, not a second write');
    assert.equal((await events(m)).length, 1);
    await valid();
  });
});

describe('T1 · set_watch_date (§D.5)', () => {
  it('dates the one event, and clears it back to none', async () => {
    const m = await movie('Miami Vice');
    await call(`set_bucket($1, $2, 'fine')`, [await op(), m]);

    await call(`set_watch_date($1, $2, date '2019-03-03', 'reader')`, [await op(), m]);
    let rows = await events(m);
    assert.equal(rows[0].basis, 'reader');
    assert.equal(iso(rows[0].watched_on), '2019-03-03');
    assert.equal(iso((await cached(m)).watched_on), '2019-03-03');
    await valid();

    await call(`set_watch_date($1, $2, null, 'none')`, [await op(), m]);
    rows = await events(m);
    assert.equal(rows[0].basis, 'none');
    assert.equal((await cached(m)).watched_on, null, 'the cache comes back down');
    await valid();
  });

  it('refuses P0001 multiple_watches once a title has more than one event', async () => {
    const m = await movie('Last of the Mohicans');
    await call(`set_bucket($1, $2, 'loved')`, [await op(), m]);
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, date '2021-01-01', 'reader')`,
      [user, m],
    );

    const err = await t.errorFrom(`select set_watch_date($1, $2, date '2020-01-01', 'reader')`, [
      await op(),
      m,
    ]);
    assert.equal(err?.code, 'P0001');
    assert.match(String(err?.message), /multiple_watches/);
    await valid();
  });

  it('refuses a title that is not in the collection', async () => {
    const m = await movie('The Keep');
    const err = await t.errorFrom(`select set_watch_date($1, $2, current_date, 'reader')`, [
      await op(),
      m,
    ]);
    assert.equal(err?.code, 'P0002');
  });
});

describe('T1 · the legacy writers keep their meaning (§D.5, §M.4)', () => {
  it('log_watched(date) dates the one event, with basis unattributed', async () => {
    // The server cannot know whether an old client defaulted the date or the reader
    // chose it. `unattributed` is the honest word, and it is what §M.7's cleanup finds.
    const m = await movie('Heat 2');
    await call(`set_bucket($1, $2, 'loved')`, [await op(), m]);
    await call(`log_watched($1, $2, date '2026-01-05', null, null, null)`, [await op(), m]);

    const rows = await events(m);
    assert.equal(rows.length, 1, 'no second viewing invented');
    assert.equal(rows[0].basis, 'unattributed');
    assert.equal(iso(rows[0].watched_on), '2026-01-05');
    assert.equal(iso((await cached(m)).watched_on), '2026-01-05', 'installed clients still read this');
    await valid();
  });

  it('log_watched on a title it CREATES leaves exactly one event, not two', async () => {
    // §O.6.3. The deferred trigger must not add an undated event beside the dated one.
    const m = await movie('Jericho Mile');
    await call(`log_watched($1, $2, date '2025-07-07', null, null, null)`, [await op(), m]);

    const rows = await events(m);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].basis, 'unattributed');
    assert.equal(iso(rows[0].watched_on), '2025-07-07');
    await valid();
  });

  it('a second log_watched OVERWRITES, exactly as it always did', async () => {
    const m = await movie('Crime Story');
    await call(`log_watched($1, $2, date '2025-07-07', null, null, null)`, [await op(), m]);
    await call(`log_watched($1, $2, date '2025-08-08', null, null, null)`, [await op(), m]);

    const rows = await events(m);
    assert.equal(rows.length, 1, 'one date, and a new one replaces it');
    assert.equal(iso(rows[0].watched_on), '2025-08-08');
    await valid();
  });

  it('clear_watch_date clears the event and keeps the watch', async () => {
    const m = await movie('The Fall');
    await call(`set_bucket($1, $2, 'fine')`, [await op(), m]);
    await call(`log_watched($1, $2, date '2024-02-02', null, null, null)`, [await op(), m]);
    await call(`clear_watch_date($1, $2)`, [await op(), m]);

    const rows = await events(m);
    assert.equal(rows.length, 1, 'the viewing survives');
    assert.equal(rows[0].basis, 'none');
    assert.equal((await cached(m)).watched_on, null);
    await valid();
  });

  it('clear_watch_date still refuses when the date is the only watch signal (I8)', async () => {
    const m = await movie('L.A. Takedown');
    await call(`log_watched($1, $2, date '2024-02-02', null, null, null)`, [await op(), m]);
    const err = await t.errorFrom(`select clear_watch_date($1, $2)`, [await op(), m]);
    assert.equal(err?.code, '22023');
  });

  it('clear_watch_date clears the newest DATED event, not a later undated one', async () => {
    // An undated event recorded after a dated one is the prior-viewing case. Clearing
    // that one would report success and leave the date on the row.
    const m = await movie('Band of the Hand');
    await call(`set_bucket($1, $2, 'fine')`, [await op(), m]);
    await call(`log_watched($1, $2, date '2024-02-02', null, null, null)`, [await op(), m]);
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis, recorded_at)
       values ($1, $2, null, 'none', now() + interval '1 minute')`,
      [user, m],
    );

    await call(`clear_watch_date($1, $2)`, [await op(), m]);
    assert.equal((await cached(m)).watched_on, null, 'the date is genuinely gone');
    assert.equal((await events(m)).length, 2, 'and both viewings survive');
    await valid();
  });
});

describe('T1 · the cache is recomputed, never advanced (§D.7)', () => {
  it('follows the maximum up and back down as events arrive, change and go', async () => {
    const m = await movie('Ferrari');
    await call(`set_bucket($1, $2, 'loved')`, [await op(), m]);

    const add = (d) =>
      t.sql(
        `insert into watch_events (user_id, media_item_id, watched_on, basis)
         values ($1, $2, $3::date, 'reader') returning id`,
        [user, m, d],
      );

    const a = (await add('2020-01-01')).rows[0].id;
    assert.equal(iso((await cached(m)).watched_on), '2020-01-01');

    const b = (await add('2022-06-06')).rows[0].id;
    assert.equal(iso((await cached(m)).watched_on), '2022-06-06', 'the later one wins');

    // The case `greatest(old, new)` gets wrong: the maximum goes DOWN.
    await t.sql(`delete from watch_events where id = $1`, [b]);
    assert.equal(iso((await cached(m)).watched_on), '2020-01-01', 'and back down on a delete');

    await t.sql(`update watch_events set watched_on = date '2018-03-03' where id = $1`, [a]);
    assert.equal(iso((await cached(m)).watched_on), '2018-03-03', 'and down on an edit');
    await valid();
  });

  it('a BACKDATED event does not consume a fresh watchlist intention (§D.2)', async () => {
    // The bug this tranche prevents rather than fixes. The reader put it back on the
    // watchlist yesterday to see it again; a 2019 viewing they are recording now is
    // older than that intention and does not cancel it.
    const m = await movie('Thief 1981');
    await call(`set_bucket($1, $2, 'loved')`, [await op(), m]);
    await t.sql(`delete from watchlist where user_id = $1 and media_item_id = $2`, [user, m]);
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [user, m]);

    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, date '2019-01-01', 'reader')`,
      [user, m],
    );

    const { rows } = await t.sql(
      `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
      [user, m],
    );
    assert.equal(rows.length, 1, 'the watchlist entry outlives an older viewing');
    await valid();
  });

  it('a CONTEMPORANEOUS event still clears the watchlist', async () => {
    const m = await movie('Public Enemies 2');
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [user, m]);
    await call(`log_title($1, $2, 'loved', current_date, 'today_default')`, [await op(), m]);

    const { rows } = await t.sql(
      `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
      [user, m],
    );
    assert.equal(rows.length, 0, 'watched today beats wanting to watch');
    await valid();
  });
});

describe('T1 · provenance follows the event, not the cache (§D.2)', () => {
  it('a native-dated event flips source to in_app', async () => {
    const m = await movie('Vice');
    await t.sql(
      `insert into user_media (user_id, media_item_id, source) values ($1, $2, 'imported')`,
      [user, m],
    );
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, current_date, 'reader')`,
      [user, m],
    );
    assert.equal((await cached(m)).source, 'in_app');
    await valid();
  });

  it('a DIARY event does not, and this is the regression the tranche could have shipped', async () => {
    // The cache follows diary dates. If provenance still followed the cache, importing a
    // library would flip every dated row to in_app — and `source <> 'imported'` is what
    // keeps an import off the all-time leaderboard. §C.3.5 with the sign flipped.
    const m = await movie('Tokyo Vice');
    await t.sql(
      `insert into user_media (user_id, media_item_id, source) values ($1, $2, 'imported')`,
      [user, m],
    );
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref)
       values ($1, $2, date '2019-05-05', 'diary', 'https://boxd.it/' || $3)`,
      [user, m, `d${seq}`],
    );
    assert.equal((await cached(m)).source, 'imported', 'still somebody else’s record');
    assert.equal(iso((await cached(m)).watched_on), '2019-05-05', 'but the date is ours to show');
    await valid();
  });

  it('an UNDATED event does not flip it either', async () => {
    const m = await movie('Luck');
    await t.sql(
      `insert into user_media (user_id, media_item_id, source) values ($1, $2, 'imported')`,
      [user, m],
    );
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, null, 'none')`,
      [user, m],
    );
    assert.equal((await cached(m)).source, 'imported');
    await valid();
  });
});

describe('T1 · the shape of the table (§D.1)', () => {
  it('basis none and a date cannot coexist, in either direction', async () => {
    const m = await movie('Witness');
    await call(`set_bucket($1, $2, 'fine')`, [await op(), m]);

    assert.ok(
      await t.errorFrom(
        `insert into watch_events (user_id, media_item_id, watched_on, basis)
         values ($1, $2, current_date, 'none')`,
        [user, m],
      ),
    );
    assert.ok(
      await t.errorFrom(
        `insert into watch_events (user_id, media_item_id, watched_on, basis)
         values ($1, $2, null, 'reader')`,
        [user, m],
      ),
    );
  });

  it('an implausible date is refused by the table, not only by the writer', async () => {
    const m = await movie('Blade Runner');
    await call(`set_bucket($1, $2, 'loved')`, [await op(), m]);
    assert.ok(
      await t.errorFrom(
        `insert into watch_events (user_id, media_item_id, watched_on, basis)
         values ($1, $2, date '9999-12-31', 'reader')`,
        [user, m],
      ),
    );
  });

  it('one diary URI per account, which is what makes a re-import free', async () => {
    const m = await movie('Apocalypse Now');
    await call(`set_bucket($1, $2, 'loved')`, [await op(), m]);
    const uri = `https://boxd.it/dup${seq}`;
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref)
       values ($1, $2, date '2020-02-02', 'diary', $3)`,
      [user, m, uri],
    );
    assert.ok(
      await t.errorFrom(
        `insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref)
         values ($1, $2, date '2020-02-02', 'diary', $3)`,
        [user, m, uri],
      ),
    );
  });

  it('removing the title from the collection cascades its whole history', async () => {
    const m = await movie('The Conversation');
    await call(`log_title($1, $2, 'loved', current_date, 'today_default')`, [await op(), m]);
    await t.sql(`delete from user_media where user_id = $1 and media_item_id = $2`, [user, m]);
    assert.equal((await events(m)).length, 0);
    await valid();
  });

  it('another account cannot read your dates at any visibility', async () => {
    const m = await movie('Klute');
    await call(`log_title($1, $2, 'loved', current_date, 'today_default')`, [await op(), m]);
    const other = await t.createUser({ username: `peek_${seq}` });

    await t.asUser(other, async () => {
      const { rows } = await t.sql(`select id from watch_events where media_item_id = $1`, [m]);
      assert.equal(rows.length, 0, 'a public profile publishes a ranking, never a diary');
    });
    await t.actAs(user);
  });
});

describe('T1 · assert_watch_history_valid catches what it is for', () => {
  it('W1: a seen title with no event', async () => {
    const m = await movie('Chinatown');
    await call(`set_bucket($1, $2, 'loved')`, [await op(), m]);
    await t.sql(`delete from watch_events where user_id = $1 and media_item_id = $2`, [user, m]);
    const err = await t.errorFrom(`select assert_watch_history_valid($1)`, [user]);
    assert.match(String(err?.message), /W1 violated/);
  });

  it('W3: a cache that has drifted from the events', async () => {
    const m = await movie('Cutter’s Way');
    await call(`log_title($1, $2, 'loved', current_date, 'today_default')`, [await op(), m]);
    // Forced past the trigger, which is the only way to produce the state in the tree.
    await t.sql(
      `update user_media set watched_on = date '1999-09-09'
        where user_id = $1 and media_item_id = $2`,
      [user, m],
    );
    const err = await t.errorFrom(`select assert_watch_history_valid($1)`, [user]);
    assert.match(String(err?.message), /W3 violated/);
  });
});
