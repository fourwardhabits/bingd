import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The Letterboxd import safety layer — `20260917000100`.
 *
 * ---------------------------------------------------------------------------
 * THE ACCEPTANCE CRITERION IS THE FIRST SUITE, AND IT IS THE POINT
 *
 * This migration ships **before** anything that can create an imported row. Every
 * predicate it adds tests `user_media.source = 'imported'`, and no row in any database
 * anywhere has that value yet. So the claim being made is not "the new behaviour is
 * correct" but "**there is no new behaviour yet**", and `a database with no imported rows`
 * below is what turns that claim into something that fails if it stops being true.
 *
 * Everything after it exercises the behaviour that switches on when the first imported row
 * appears, which on a real database is still weeks away.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GATE IS TESTED AT THE TABLE AND NOT AT THE AWARD
 *
 * The requirement is that an import emits no feed activity and no notification. That is a
 * statement about *every* producer, so a test that only proves awards are quiet would be
 * evidence about awards. `insert into feed_events` and `insert into notifications`
 * directly, under the marker, is the assertion that matches the requirement — and it keeps
 * holding for whatever somebody adds next year.
 */

let t;
let seq = 96000;

/**
 * Runs body inside one transaction that has declared itself an import.
 *
 * The marker is `txid_current()`, not a constant — see `_importing()`. A DO block runs in
 * its own transaction, so this is the real shape the apply path will use.
 */
const importing = (sql) => t.sql(`do $$ begin
  perform set_config('bingd.import_running', txid_current()::text, true);
  ${sql}
end $$;`);

const count = async (table, where = 'true') => {
  const { rows } = await t.sql(`select count(*)::int as n from ${table} where ${where}`);
  return rows[0].n;
};

const logWatch = (user, item, source = 'in_app') =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket, source)
     values ($1, $2, 'loved', $3::content_source)`,
    [user, item, source],
  );

/**
 * The caller's own count, through the public surface.
 *
 * `_leaderboard_counts` is internal and revoked from `authenticated`, so reaching for it
 * directly would be testing something no client can call. `my_leaderboard_standing` is the
 * RPC the app actually uses and it runs the same CTE.
 */
const myCount = (who, metric, timeframe) =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select * from my_leaderboard_standing($1, $2)`, [
      metric,
      timeframe,
    ]);
    return rows[0]?.metric_count ?? 0;
  });

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

// ===========================================================================

describe('a database with no imported rows', () => {
  let alice;
  let films;

  before(async () => {
    alice = await t.createUser({ username: 'imp_noop' });
    films = [
      await t.createMovie('Noop One', seq++),
      await t.createMovie('Noop Two', seq++),
    ];
  });

  beforeEach(async () => {
    await t.sql(`delete from user_media`);
    await t.sql(`delete from feed_events`);
    await t.sql(`delete from notifications`);
    await t.sql(`delete from award_unlocks`);
  });

  it('still counts native watches on the all-time board', async () => {
    for (const film of films) await logWatch(alice, film);
    assert.equal(await myCount(alice, 'titles', 'all_time'), 2);
  });

  it('still counts native watches on the monthly board', async () => {
    for (const film of films) await logWatch(alice, film);
    assert.equal(await myCount(alice, 'titles', 'month'), 2);
  });

  it('still writes a feed event', async () => {
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2)`,
      [alice, films[0]],
    );
    assert.equal(await count('feed_events'), 1);
  });

  it('still writes a notification', async () => {
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id) values ($1, 'follow', $1)`,
      [alice],
    );
    assert.equal(await count('notifications'), 1);
  });

  it('still runs the award trigger on an ordinary collection write', async () => {
    // Not asserting a tier — only that the trigger was not disarmed for everybody. The
    // suppression below must be conditional, and the failure mode of getting that wrong is
    // silent: awards would simply stop being earned.
    const { rows } = await t.sql(
      `select min(threshold) as lowest from award_tiers where award_key = 'movie-muncher'`,
    );
    const lowest = rows[0].lowest;

    for (let i = 0; i < lowest; i += 1) {
      await logWatch(alice, await t.createMovie(`Muncher ${seq}`, seq++));
    }

    assert.ok(
      (await count('award_unlocks', `user_id = '${alice}' and award_key = 'movie-muncher'`)) >= 1,
      'a native collection write must still be able to unlock an award',
    );
  });
});

// ===========================================================================

describe('the leaderboards stop counting an imported history', () => {
  let alice;
  let native;
  let imported;

  before(async () => {
    alice = await t.createUser({ username: 'imp_board' });
    native = await t.createMovie('Native Watch', seq++);
    imported = await t.createMovie('Imported Watch', seq++);
  });

  beforeEach(() => t.sql(`delete from user_media`));

  const board = (timeframe, metric = 'titles') => myCount(alice, metric, timeframe);

  it('excludes an imported row from all time', async () => {
    await logWatch(alice, imported, 'imported');
    assert.equal(await board('all_time'), 0);
  });

  it('excludes an imported row from this month', async () => {
    // The case that is easy to miss. A row from watched.csv carries no watch date at all,
    // so `coalesce(watched_on, created_at)` falls through to the day the import ran — and
    // without the predicate an entire library would land on the *current* month's board.
    await logWatch(alice, imported, 'imported');
    assert.equal(await board('month'), 0);
  });

  it('still counts a native row sitting beside an imported one', async () => {
    await logWatch(alice, native, 'in_app');
    await logWatch(alice, imported, 'imported');

    assert.equal(await board('all_time'), 1);
    assert.equal(await board('month'), 1);
  });

  it('excludes imported rows from the movies metric too', async () => {
    await logWatch(alice, imported, 'imported');
    assert.equal(await board('all_time', 'movies'), 0);
    assert.equal(await board('month', 'movies'), 0);
  });

  it('leaves the reviews metric alone, because an import writes no notes', async () => {
    await logWatch(alice, imported, 'imported');
    await t.sql(
      `update user_media set note = 'a note', note_visibility = 'public'
        where user_id = $1 and media_item_id = $2`,
      [alice, imported],
    );

    // Deliberately asserting the *absence* of a predicate: the review metrics were left
    // untouched, so a public note counts however the row arrived. If that is ever wrong it
    // is a product decision, not an oversight.
    assert.equal(await board('all_time', 'reviews'), 1);
  });
});

// ===========================================================================

describe('an import is silent', () => {
  let alice;
  let film;

  before(async () => {
    alice = await t.createUser({ username: 'imp_silent' });
    film = await t.createMovie('Silent Film', seq++);
  });

  beforeEach(async () => {
    await t.sql(`delete from feed_events`);
    await t.sql(`delete from notifications`);
    await t.sql(`delete from push_outbox`);
    await t.sql(`delete from user_media`);
  });

  it('writes no feed event, whatever produced it', async () => {
    await importing(
      `insert into feed_events (actor_id, type, media_item_id)
       values ('${alice}', 'title_ranked', '${film}');`,
    );
    assert.equal(await count('feed_events'), 0);
  });

  it('writes no notification', async () => {
    await importing(
      `insert into notifications (recipient_id, type, actor_id)
       values ('${alice}', 'follow', '${alice}');`,
    );
    assert.equal(await count('notifications'), 0);
  });

  it('queues no push, because the notification that would have caused one never existed', async () => {
    await importing(
      `insert into notifications (recipient_id, type, actor_id)
       values ('${alice}', 'follow', '${alice}');`,
    );
    assert.equal(await count('push_outbox'), 0);
  });

  it('runs no per-row award work', async () => {
    const { rows } = await t.sql(
      `select min(threshold) as lowest from award_tiers where award_key = 'movie-muncher'`,
    );
    const lowest = rows[0].lowest;

    const values = [];
    for (let i = 0; i < lowest; i += 1) {
      const item = await t.createMovie(`Quiet ${seq}`, seq++);
      values.push(`('${alice}', '${item}', 'loved', 'imported')`);
    }

    await importing(
      `insert into user_media (user_id, media_item_id, bucket, source)
       values ${values.join(',')};`,
    );

    assert.equal(
      await count('award_unlocks', `user_id = '${alice}'`),
      0,
      'the per-row trigger must be skipped during an import',
    );
  });

  it('lets the job settle the ledger afterwards without announcing it', async () => {
    // The shape the apply path will use: skip per row, evaluate once, and the gate keeps
    // that one evaluation quiet. The awards are real; nobody is told in a burst.
    const { rows } = await t.sql(
      `select min(threshold) as lowest from award_tiers where award_key = 'movie-muncher'`,
    );
    const lowest = rows[0].lowest;

    const values = [];
    for (let i = 0; i < lowest; i += 1) {
      const item = await t.createMovie(`Settle ${seq}`, seq++);
      values.push(`('${alice}', '${item}', 'loved', 'imported')`);
    }

    await importing(
      `insert into user_media (user_id, media_item_id, bucket, source)
       values ${values.join(',')};
       perform _maybe_award_unlocks('${alice}', array['movie-muncher']);`,
    );

    assert.ok(
      (await count('award_unlocks', `user_id = '${alice}'`)) >= 1,
      'the ledger must be true after the job settles',
    );
    assert.equal(await count('feed_events', `actor_id = '${alice}'`), 0);
    assert.equal(await count('notifications', `recipient_id = '${alice}'`), 0);
  });

  it('still evaluates the watchlist award during an import, silently', async () => {
    // The deliberate asymmetry in 20260917000100: two of the three award triggers skip
    // their per-row work during an import and `_award_touch_watchlist` does not, because a
    // single track over a watchlist is not the quadratic the guard exists to remove.
    //
    // Asserted rather than left to the comment, because the *requirement* is silence and
    // this is the path that proves the gate carries it without the trigger's help. If
    // somebody guards that trigger later for symmetry, this fails and tells them the apply
    // path now owes queue-dragon a settle.
    await t.sql(`delete from watchlist`);
    await t.sql(`delete from award_unlocks`);

    const { rows } = await t.sql(
      `select min(threshold) as lowest from award_tiers where award_key = 'queue-dragon'`,
    );
    const lowest = rows[0].lowest;

    const values = [];
    for (let i = 0; i < lowest; i += 1) {
      const item = await t.createMovie(`Queued ${seq}`, seq++);
      values.push(`('${alice}', '${item}')`);
    }

    await importing(
      `insert into watchlist (user_id, media_item_id) values ${values.join(',')};`,
    );

    assert.ok(
      (await count('award_unlocks', `user_id = '${alice}' and award_key = 'queue-dragon'`)) >= 1,
      'the watchlist track is evaluated during an import, not deferred',
    );
    assert.equal(await count('feed_events', `actor_id = '${alice}'`), 0);
    assert.equal(await count('notifications', `recipient_id = '${alice}'`), 0);
  });

  it('stops being silent the moment the transaction ends', async () => {
    // `set_config(..., true)` is transaction-local. If it ever leaked to the session, every
    // later feed event in that connection would vanish and nothing would say so.
    await importing(
      `insert into feed_events (actor_id, type, media_item_id)
       values ('${alice}', 'title_ranked', '${film}');`,
    );

    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2)`,
      [alice, film],
    );

    assert.equal(await count('feed_events'), 1);
  });

  it('is not importing by default', async () => {
    const { rows } = await t.sql(`select _importing() as importing`);
    assert.equal(rows[0].importing, false);
  });

  it('treats a marker that escaped its transaction as inert', async () => {
    // The reason the marker is `txid_current()` rather than the string 'on'. A session-level
    // SET — a forgotten `is_local`, a value left on a pooled connection — would otherwise
    // silently cancel every feed event and every notification for every account sharing
    // that connection, with no error and no bound in time.
    //
    // Set deliberately WRONG here: session-scoped (`false`), carrying a transaction id that
    // has already ended. Nothing later may honour it.
    await t.sql(`select set_config('bingd.import_running', txid_current()::text, false)`);

    try {
      const { rows } = await t.sql(`select _importing() as importing`);
      assert.equal(rows[0].importing, false, 'a stale transaction id must not mark an import');

      await t.sql(
        `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2)`,
        [alice, film],
      );
      assert.equal(await count('feed_events'), 1, 'a leaked marker must not swallow feed events');
    } finally {
      await t.sql(`select set_config('bingd.import_running', '', false)`);
    }
  });
});

// ===========================================================================

describe('removing an imported history', () => {
  let alice;

  before(async () => {
    alice = await t.createUser({ username: 'imp_remove' });
  });

  beforeEach(async () => {
    await t.sql(`delete from user_media`);
    await t.sql(`delete from award_unlocks`);
  });

  it('runs no per-row revocation work', async () => {
    const { rows } = await t.sql(
      `select min(threshold) as lowest from award_tiers where award_key = 'movie-muncher'`,
    );
    const lowest = rows[0].lowest;

    const values = [];
    for (let i = 0; i < lowest; i += 1) {
      const item = await t.createMovie(`Undo ${seq}`, seq++);
      values.push(`('${alice}', '${item}', 'loved', 'imported')`);
    }
    await importing(
      `insert into user_media (user_id, media_item_id, bucket, source) values ${values.join(',')};
       perform _maybe_award_unlocks('${alice}', array['movie-muncher']);`,
    );

    const before = await count('award_unlocks', `user_id = '${alice}'`);
    assert.ok(before >= 1);

    // The delete half of the same job. Without the guard this is one full revocation pass
    // per row, which on a real import is thousands of passes over the whole collection.
    await importing(`delete from user_media where user_id = '${alice}';`);

    assert.equal(
      await count('award_unlocks', `user_id = '${alice}'`),
      before,
      'revocation is deferred to the job, not run per row',
    );
  });
});

// ===========================================================================

describe('the provenance tables', () => {
  let alice;
  let bob;
  let film;

  before(async () => {
    alice = await t.createUser({ username: 'imp_prov_a' });
    bob = await t.createUser({ username: 'imp_prov_b' });
    film = await t.createMovie('Provenance', seq++);
  });

  beforeEach(async () => {
    await t.sql(`delete from user_media`);
    await t.sql(`delete from letterboxd_matches`);
    await logWatch(alice, film, 'imported');
  });

  const addTitle = (uri = 'https://boxd.it/iEEq', rating = '5.0') =>
    t.sql(
      `insert into imported_titles (user_id, media_item_id, letterboxd_uri, source_name, source_year, rating)
       values ($1, $2, $3, 'Free Solo', 2018, $4)`,
      [alice, film, uri, rating],
    );

  const addWatch = (diaryUri, watchedOn = '2026-09-10', rewatch = true) =>
    t.sql(
      `insert into imported_watches (user_id, media_item_id, diary_uri, watched_on, is_rewatch)
       values ($1, $2, $3, $4, $5)`,
      [alice, film, diaryUri, watchedOn, rewatch],
    );

  it('keeps the raw star, so the bucket policy stays reversible', async () => {
    await addTitle('https://boxd.it/iEEq', '3.5');
    const { rows } = await t.sql(`select rating from imported_titles where user_id = $1`, [alice]);
    assert.equal(Number(rows[0].rating), 3.5);
  });

  it('refuses a rating that is not a Letterboxd star', async () => {
    await assert.rejects(() => addTitle('https://boxd.it/x', '4.3'));
  });

  it('refuses a second row for the same diary entry', async () => {
    // The primary key is the diary URI because Letterboxd issues one per logged viewing.
    // That gives at-most-once *storage*, which is what is asserted here — idempotency is a
    // property of the writer's `on conflict` clause and there is no writer yet.
    await addWatch('https://boxd.it/ggWgth');
    await assert.rejects(() => addWatch('https://boxd.it/ggWgth'));
    assert.equal(await count('imported_watches', `user_id = '${alice}'`), 1);
  });

  it('refuses an implausible watch date', async () => {
    await assert.rejects(() => addWatch('https://boxd.it/zzz', '9999-12-31'));
  });

  it('keeps two viewings of one film apart', async () => {
    await addWatch('https://boxd.it/aaa', '2024-01-02', false);
    await addWatch('https://boxd.it/bbb', '2026-03-04', true);
    assert.equal(await count('imported_watches', `user_id = '${alice}'`), 2);
  });

  it('takes both provenance rows with the collection row', async () => {
    await addTitle();
    await addWatch('https://boxd.it/ggWgth');

    await t.sql(`delete from user_media where user_id = $1 and media_item_id = $2`, [alice, film]);

    assert.equal(await count('imported_titles', `user_id = '${alice}'`), 0);
    assert.equal(await count('imported_watches', `user_id = '${alice}'`), 0);
  });

  it('refuses provenance for a title that is not in the collection', async () => {
    const orphan = await t.createMovie('Not Logged', seq++);
    await assert.rejects(() =>
      t.sql(
        `insert into imported_titles (user_id, media_item_id, source_name) values ($1, $2, 'X')`,
        [alice, orphan],
      ),
    );
  });

  it('shows an account its own provenance and nobody else theirs', async () => {
    await addTitle();
    await addWatch('https://boxd.it/ggWgth');

    const mine = await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select * from imported_titles`);
      return rows.length;
    });
    const theirs = await t.asUser(bob, async () => {
      const { rows } = await t.sql(`select * from imported_titles`);
      return rows.length;
    });
    const theirWatches = await t.asUser(bob, async () => {
      const { rows } = await t.sql(`select * from imported_watches`);
      return rows.length;
    });

    assert.equal(mine, 1);
    assert.equal(theirs, 0);
    assert.equal(theirWatches, 0);
  });

  it('hides the shared match cache from every client', async () => {
    await t.sql(
      `insert into letterboxd_matches (letterboxd_uri, media_item_id) values ($1, $2)`,
      ['https://boxd.it/iEEq', film],
    );

    const seen = await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select * from letterboxd_matches`);
      return rows.length;
    });

    // RLS enabled with no policy: denied to everybody, the owner included. The matching
    // worker runs as service_role and bypasses it.
    assert.equal(seen, 0);
  });

  it('maps one film URI to one title', async () => {
    await t.sql(`insert into letterboxd_matches (letterboxd_uri, media_item_id) values ($1, $2)`, [
      'https://boxd.it/iEEq',
      film,
    ]);
    await assert.rejects(() =>
      t.sql(`insert into letterboxd_matches (letterboxd_uri, media_item_id) values ($1, $2)`, [
        'https://boxd.it/iEEq',
        film,
      ]),
    );
  });
});

// ===========================================================================

describe('collection_counts', () => {
  let alice;
  let bob;

  before(async () => {
    alice = await t.createUser({ username: 'imp_counts_a' });
    bob = await t.createUser({ username: 'imp_counts_b' });
  });

  beforeEach(async () => {
    await t.sql(`delete from rankings`);
    await t.sql(`delete from user_media`);
  });

  const counts = (who) =>
    t.asUser(who, async () => {
      const { rows } = await t.sql(`select * from collection_counts()`);
      return rows[0];
    });

  it('states the split the header draws', async () => {
    const ranked = await t.createMovie('Ranked', seq++);
    const logged = await t.createMovie('Logged', seq++);

    await logWatch(alice, ranked);
    await logWatch(alice, logged);
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [alice, ranked],
    );

    assert.deepEqual(await counts(alice), { ranked: 1, logged: 2 });
  });

  it('counts an imported title as logged, because it is', async () => {
    await logWatch(alice, await t.createMovie('Imported Logged', seq++), 'imported');
    assert.deepEqual(await counts(alice), { ranked: 0, logged: 1 });
  });

  it('never counts another account', async () => {
    await logWatch(bob, await t.createMovie('Bob Watch', seq++));
    assert.deepEqual(await counts(alice), { ranked: 0, logged: 0 });
  });

  it('is zero for an empty collection rather than null', async () => {
    assert.deepEqual(await counts(alice), { ranked: 0, logged: 0 });
  });
});
