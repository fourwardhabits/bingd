import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDbBefore } from './harness.mjs';

/**
 * T1's backfill, against the awkward shapes that actually exist (§M.3, §O.1).
 *
 * `createTestDbBefore` is the whole reason this file is separate: the ordinary harness
 * reloads a snapshot in which `20261003000100` has already run against an empty
 * database, where the backfill is a guaranteed no-op. Every assertion below would pass
 * there whether or not the backfill works at all.
 *
 * So the pre-epic rows are written FIRST, with the schema as it stood on 2026-09-20, and
 * the migration is then applied over them. §O.1's migration fixture, in full:
 *
 *   - an in-app dated row, plus diary entries on the same date and on a later one
 *   - a multi-diary imported row, and an earliest-entry Rewatch flag
 *   - a `watched.csv`-only row, and an in-app undated row
 *   - an existing-undated row later stamped by the §C.3.7 defect
 *   - a ranked import, and a series row
 *   - duplicate `title_ranked` posts, which must NOT become events
 *   - a re-added watchlist row
 *   - a burst of rows dated on one signup day, which must stay untouched
 *
 * R3 is the rule every assertion here serves: **nothing is inferred**. The only sources
 * of a viewing are the diary's per-entry URIs and the diary's own Rewatch flag.
 */

const T1 = '20261003000100_a_watch_that_knows_when_it_was.sql';

let t;
let user;
let other;
const M = {};
let n = 0;

const movie = async (key, title) => {
  n += 1;
  M[key] = await t.createMovie(title, n + 70000);
  return M[key];
};

/** A pre-epic collection row, written straight to the table as the old writers did. */
const seen = async (id, { bucket = 'loved', watchedOn = null, source = 'in_app', createdAt } = {}) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket, watched_on, source, created_at)
     values ($1, $2, $3::taste_bucket, $4::date, $5::content_source,
             coalesce($6::timestamptz, now()))`,
    [user, id, bucket, watchedOn, source, createdAt ?? null],
  );

const diary = async (id, uri, watchedOn, isRewatch = false) =>
  t.sql(
    `insert into imported_watches (user_id, media_item_id, diary_uri, watched_on, is_rewatch, imported_at)
     values ($1, $2, $3, $4::date, $5, now() - interval '30 days')`,
    [user, id, uri, watchedOn, isRewatch],
  );

const events = async (id, who = user) => {
  const { rows } = await t.sql(
    `select watched_on, basis, import_ref
       from watch_events
      where user_id = $1 and media_item_id = $2
      order by watched_on nulls first, recorded_at, import_ref nulls first`,
    [who, id],
  );
  return rows.map((r) => ({
    on: r.watched_on === null ? null : new Date(r.watched_on).toISOString().slice(0, 10),
    basis: r.basis,
    ref: r.import_ref,
  }));
};

const cachedDate = async (id) => {
  const { rows } = await t.sql(
    `select watched_on from user_media where user_id = $1 and media_item_id = $2`,
    [user, id],
  );
  return rows[0].watched_on === null
    ? null
    : new Date(rows[0].watched_on).toISOString().slice(0, 10);
};

before(async () => {
  t = await createTestDbBefore(T1);
  user = await t.createUser({ username: 'backfill_one' });
  other = await t.createUser({ username: 'backfill_two' });
  await t.actAs(user);

  // ---------------------------------------------------------------------------
  // 1. A native dated row whose diary agrees on the date. One viewing, two records:
  //    it must produce ONE event (§O.6.3).
  await movie('sameDay', 'Heat');
  await seen(M.sameDay, { watchedOn: '2026-01-10' });
  await diary(M.sameDay, 'https://boxd.it/a1', '2026-01-10');

  // 2. A native dated row whose diary holds a LATER date. Two viewings, and the cache
  //    moves to the authoritative later one — the one set the diff script enumerates.
  await movie('laterDiary', 'Collateral');
  await seen(M.laterDiary, { watchedOn: '2025-03-01' });
  await diary(M.laterDiary, 'https://boxd.it/a2', '2026-04-04');

  // 3. A multi-diary imported row whose EARLIEST entry is flagged Rewatch. Three diary
  //    events plus one `#prior` — the design's only inference, from the source's own flag.
  await movie('multi', 'Ronin');
  await seen(M.multi, { watchedOn: '2024-09-09', source: 'imported' });
  await diary(M.multi, 'https://boxd.it/a3', '2020-01-01', true);
  await diary(M.multi, 'https://boxd.it/a4', '2022-02-02');
  await diary(M.multi, 'https://boxd.it/a5', '2024-09-09');

  // 4. A `watched.csv`-only row: seen, imported, no date and no diary.
  await movie('csvOnly', 'Thief');
  await seen(M.csvOnly, { watchedOn: null, source: 'imported' });

  // 5. An in-app undated row — an onboarding pick, or an "I don't remember".
  await movie('nativeUndated', 'Manhunter');
  await seen(M.nativeUndated, { watchedOn: null });

  // 6. An imported row carrying the diary MAXIMUM with no `imported_watches` behind it,
  //    which is §M.3 step 4. The date is authoritative and must survive as `diary`.
  await movie('maxOnly', 'Miami Vice');
  await seen(M.maxOnly, { watchedOn: '2021-06-06', source: 'imported' });

  // 7. The §C.3.7 defect's own output: a row that was undated and got stamped today by
  //    LogSheet. Indistinguishable from a deliberate date, and §M.7 says it migrates
  //    exactly like one — `unattributed`, same date, never moved or nulled.
  await movie('defectStamped', 'Blackhat');
  await seen(M.defectStamped, { watchedOn: '2026-09-01' });

  // 8. A ranked import. Ranking flipped its provenance to in_app (20260917000200), and
  //    it still has no date: it must stay undated. §C.3.5.
  await movie('rankedImport', 'Public Enemies');
  await seen(M.rankedImport, { watchedOn: null, source: 'in_app' });
  await t.sql(
    `insert into rankings (user_id, media_item_id, category, bucket, position)
     values ($1, $2, 'movies', 'loved', 1)`,
    [user, M.rankedImport],
  );

  // 9. Duplicate `title_ranked` posts on one title. R3: a feed post is not evidence of a
  //    viewing, and an unrank plus a re-rank reposts. This must produce ONE event.
  await movie('reposted', 'The Insider');
  await seen(M.reposted, { watchedOn: null });
  for (const i of [1, 2, 3]) {
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload)
       values ($1, 'title_ranked', $2, jsonb_build_object('position', $3::int, 'bucket', 'loved',
               'category', 'movies', 'score', 8.0))`,
      [user, M.reposted, i],
    );
  }

  // 10. A watchlist entry the reader re-added deliberately. The backfill replays fifteen
  //     months of history; if the watchlist triggers were live it would be emptied.
  await movie('rewatchWanted', 'Ali');
  await seen(M.rewatchWanted, { watchedOn: '2023-05-05' });
  await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
    user,
    M.rewatchWanted,
  ]);

  // 11. A series row. Never gets an event, and must not put W1 permanently out of reach.
  const series = await t.createSeries('The Wire', 77001);
  await t.sql(
    `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
    [user, series],
  );
  M.series = series;

  // 12. The signup-day burst: fifty rows dated on one day. §M.7 — never moved, nulled or
  //     reclassified automatically, "not for being near signup, not for arriving in a
  //     burst, not for looking historical". They keep counting where they count today.
  M.burst = [];
  for (let i = 0; i < 50; i += 1) {
    const id = await t.createMovie(`Burst ${i}`, 78000 + i);
    await seen(id, { watchedOn: '2026-02-14', createdAt: '2026-02-14T10:00:00Z' });
    M.burst.push(id);
  }

  // 13. A second account, so the backfill is proven not to be single-tenant by accident.
  await t.actAs(other);
  await movie('otherUser', 'Ferrari');
  await t.sql(
    `insert into user_media (user_id, media_item_id, bucket, watched_on)
     values ($1, $2, 'fine', date '2026-03-03')`,
    [other, M.otherUser],
  );
  await t.actAs(user);

  // The fixture's own writes earn awards -- inserting a `rankings` row fires
  // `award_on_ranking`. Cleared here so "it is quiet" is a question about the MIGRATION
  // rather than about the setup, which is what it failed on first: one `award_earned`
  // from the seeded ranking, counted as a leak.
  await t.sql(`delete from feed_events where actor_id in ($1, $2)`, [user, other]);

  await t.applyMigration(T1);
});

after(async () => {
  await t?.close();
});

describe('T1 backfill · the invariant, over every shape at once', () => {
  it('assert_watch_history_valid passes for both accounts', async () => {
    await t.sql(`select assert_watch_history_valid()`);
  });

  it('every rankable seen row has at least one event, and the series has none', async () => {
    const { rows } = await t.sql(
      `select count(*)::int as n from user_media um
         join media_items m on m.id = um.media_item_id
        where rankable_category(m.kind) is not null
          and not exists (select 1 from watch_events we
                           where we.user_id = um.user_id and we.media_item_id = um.media_item_id)`,
    );
    assert.equal(rows[0].n, 0);
    assert.deepEqual(await events(M.series), [], 'a series is never watched');
  });
});

describe('T1 backfill · the diary is authoritative and is never doubled', () => {
  it('a native date the diary also holds yields ONE event', async () => {
    // Step 3 skips a native date a diary event already carries. Two events here would be
    // one viewing counted twice, for ever, in every lifetime metric.
    const rows = await events(M.sameDay);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { on: '2026-01-10', basis: 'diary', ref: 'https://boxd.it/a1' });
    assert.equal(await cachedDate(M.sameDay), '2026-01-10', 'the cache is unchanged');
  });

  it('a native date plus a LATER diary date yields two events, and the cache moves', async () => {
    const rows = await events(M.laterDiary);
    assert.deepEqual(
      rows.map((r) => [r.on, r.basis]),
      [
        ['2025-03-01', 'unattributed'],
        ['2026-04-04', 'diary'],
      ],
    );
    assert.equal(
      await cachedDate(M.laterDiary),
      '2026-04-04',
      'authoritative data added a viewing; the diff script enumerates exactly this set',
    );
  });

  it('a multi-diary row becomes one event per entry, plus the asserted prior viewing', async () => {
    const rows = await events(M.multi);
    assert.equal(rows.length, 4, 'three diary entries and one prior');

    const prior = rows.filter((r) => r.ref?.endsWith('#prior'));
    assert.equal(prior.length, 1);
    assert.equal(prior[0].on, null, 'a prior viewing has no date; the source only says it happened');
    assert.equal(prior[0].basis, 'none');

    assert.deepEqual(
      rows.filter((r) => r.basis === 'diary').map((r) => r.on),
      ['2020-01-01', '2022-02-02', '2024-09-09'],
    );
    assert.equal(await cachedDate(M.multi), '2024-09-09', 'the latest known date');
  });

  it('an imported row carrying only the diary maximum keeps that date, as diary', async () => {
    // §M.3 step 4. Calling it native would put an import on the monthly board at T4.
    assert.deepEqual(await events(M.maxOnly), [{ on: '2021-06-06', basis: 'diary', ref: null }]);
    assert.equal(await cachedDate(M.maxOnly), '2021-06-06');
  });
});

describe('T1 backfill · R3, nothing is inferred', () => {
  it('duplicate title_ranked posts produce exactly one event, and it is undated', async () => {
    assert.deepEqual(await events(M.reposted), [{ on: null, basis: 'none', ref: null }]);
  });

  it('a ranked import stays undated: ranking is not watching', async () => {
    assert.deepEqual(await events(M.rankedImport), [{ on: null, basis: 'none', ref: null }]);
    assert.equal(await cachedDate(M.rankedImport), null);
  });

  it('a watched.csv-only row is seen with no date', async () => {
    assert.deepEqual(await events(M.csvOnly), [{ on: null, basis: 'none', ref: null }]);
  });

  it('an in-app undated row is seen with no date', async () => {
    assert.deepEqual(await events(M.nativeUndated), [{ on: null, basis: 'none', ref: null }]);
  });
});

describe('T1 backfill · §M.7, no in-app date is moved, nulled or reclassified', () => {
  it('the signup-day burst of fifty keeps every date, as unattributed', async () => {
    const { rows } = await t.sql(
      `select count(*)::int as n
         from watch_events
        where user_id = $1 and media_item_id = any($2::uuid[])
          and watched_on = date '2026-02-14' and basis = 'unattributed'`,
      [user, M.burst],
    );
    assert.equal(rows[0].n, 50, 'not for being near signup, not for arriving in a burst');

    const { rows: cache } = await t.sql(
      `select count(*)::int as n from user_media
        where user_id = $1 and media_item_id = any($2::uuid[])
          and watched_on = date '2026-02-14'`,
      [user, M.burst],
    );
    assert.equal(cache[0].n, 50, 'and the cache is exactly where it was');
  });

  it("the §C.3.7 defect's own stamped date migrates like any other", async () => {
    // No stored intent separates it from a deliberate date, so nothing here guesses.
    // T7's *Review watch dates* is how a reader — never the app — cleans these up.
    assert.deepEqual(await events(M.defectStamped), [
      { on: '2026-09-01', basis: 'unattributed', ref: null },
    ]);
  });
});

describe('T1 backfill · it is quiet', () => {
  it('a deliberately re-added watchlist row survives fifteen months of replayed history', async () => {
    const { rows } = await t.sql(
      `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
      [user, M.rewatchWanted],
    );
    assert.equal(rows.length, 1, 'the watchlist triggers were off for the backfill, on after it');
  });

  it('no goal completion and no award was announced by a migration', async () => {
    const { rows } = await t.sql(
      `select count(*)::int as n from feed_events
        where actor_id = $1 and type in ('goal_completed', 'award_earned')`,
      [user],
    );
    assert.equal(rows[0].n, 0, 'the quiet marker covered the whole transaction');
  });

  it('provenance is untouched: an imported row is still imported', async () => {
    const { rows } = await t.sql(
      `select source from user_media where user_id = $1 and media_item_id = $2`,
      [user, M.multi],
    );
    assert.equal(rows[0].source, 'imported');
  });

  it('a second account is backfilled too', async () => {
    assert.deepEqual(await events(M.otherUser, other), [
      { on: '2026-03-03', basis: 'unattributed', ref: null },
    ]);
  });
});

describe('T1 backfill · running it again would change nothing', () => {
  it('a re-import of the same diary adds no events', async () => {
    // The `import_ref` unique index is what makes this free, and it is the same property
    // `imported_watches` was given in 20260917000100 rather than a second mechanism.
    const before = (await t.sql(`select count(*)::int as n from watch_events`)).rows[0].n;
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref)
       select user_id, media_item_id, watched_on, 'diary', diary_uri from imported_watches
       on conflict (user_id, import_ref) where import_ref is not null do nothing`,
    );
    const after = (await t.sql(`select count(*)::int as n from watch_events`)).rows[0].n;
    assert.equal(after, before);
    await t.sql(`select assert_watch_history_valid()`);
  });
});
