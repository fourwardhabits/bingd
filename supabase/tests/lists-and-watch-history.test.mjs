import assert from 'node:assert/strict';
import { before, after, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Lists v1 beside Watch History T1–T4 — the interaction audit, 2026-09-20.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR, AND WHY IT IS NOT IN EITHER FEATURE'S OWN FILE
 *
 * The two features were built on separate branches against the same tables, and the
 * integration question is not whether either works — `lists.test.mjs`, `watch-events.test.mjs`
 * and `rewatch.test.mjs` answer that. It is whether they **coupled** anything:
 *
 *   **A list is authored grouping and nothing else.** Putting a title in a list must not
 *   log it, watchlist it, rank it, or produce a watch event; taking it out must not unlog
 *   it; deleting the list must not touch the collection at all. lists-prd.md §D is a
 *   statement about the product, and this is the only place it is a statement about the
 *   schema.
 *
 *   **Watch History must not disturb a list.** Logging, rewatching, editing a watch date,
 *   deleting a watch event and unlogging all move rows in `user_media`, `watch_events` and
 *   `rankings`. None of them may reorder, shorten or touch a list — including
 *   `lists.updated_at`, which is My lists' entire sort order.
 *
 *   **The one legitimate coupling is `seen`, and it is a read.** §K's viewer progress and
 *   the bulk Watchlist add both ask "has this viewer seen it", which is a question about
 *   the collection. A watch changing a progress line is correct; a watch changing list
 *   *membership* is not.
 *
 * Every assertion below is written as a whole-state comparison — the list's items and
 * `updated_at`, the collection row, the event count — because a coupling defect shows up
 * as one extra row rather than as an error.
 */

let t;
let seq = 96000;

const uuid = () => crypto.randomUUID();

const rpc = (who, call, params = []) =>
  t.asUser(who, async () => (await t.sql(call, params)).rows);

const createList = (who, visibility = 'private') =>
  rpc(who, `select create_list($1, 'Interaction', null, $2::list_visibility, 'unranked', null) as r`, [
    uuid(),
    visibility,
  ]).then((rows) => rows[0].r.id);

const addItem = (who, list, item) =>
  rpc(who, `select add_list_item($1, $2, $3) as r`, [uuid(), list, item]).then((r) => r[0].r);

const removeItem = (who, list, item) =>
  rpc(who, `select remove_list_item($1, $2, $3) as r`, [uuid(), list, item]).then((r) => r[0].r);

const destroy = (who, list) =>
  rpc(who, `select delete_list($1, $2) as r`, [uuid(), list]).then((r) => r[0].r);

const bulkWatchlist = (who, list) =>
  rpc(who, `select add_list_to_watchlist($1, $2) as r`, [uuid(), list]).then((r) => r[0].r);

const progress = (who, list) =>
  rpc(who, `select list_viewer_progress($1) as r`, [list]).then((r) => r[0]?.r ?? null);

const logTitle = (who, item, date, basis = 'reader') =>
  rpc(who, `select log_title($1, $2, 'loved'::taste_bucket, $3::date, $4::watch_date_basis) as r`, [
    uuid(),
    item,
    date,
    basis,
  ]).then((r) => r[0].r);

const logRewatch = (who, item, date, basis = 'reader') =>
  rpc(who, `select log_rewatch($1, $2, $3::date, $4::watch_date_basis) as r`, [
    uuid(),
    item,
    date,
    basis,
  ]).then((r) => r[0].r);

const editEvent = (who, eventId, date, basis = 'reader') =>
  rpc(who, `select edit_watch_event($1, $2, $3::date, $4::watch_date_basis) as r`, [
    uuid(),
    eventId,
    date,
    basis,
  ]).then((r) => r[0].r);

const deleteEvent = (who, eventId) =>
  rpc(who, `select delete_watch_event($1, $2) as r`, [uuid(), eventId]).then((r) => r[0].r);

const unlog = (who, item) =>
  rpc(who, `select unlog($1, $2) as r`, [uuid(), item]).then((r) => r[0].r);

const setWatchlist = (who, item, on = true) =>
  rpc(who, `select set_watchlist($1, $2, $3) as r`, [uuid(), item, on]).then((r) => r[0].r);

/** Everything about a list that a coupling defect would move. */
const listState = async (list) => {
  const items = (
    await t.sql(
      `select media_item_id, "position" from list_items where list_id = $1 order by "position"`,
      [list],
    )
  ).rows;
  const meta = (await t.sql(`select updated_at, title, visibility from lists where id = $1`, [list]))
    .rows[0];
  return { items, updatedAt: meta?.updated_at ?? null };
};

/** Everything about one title in one account's collection. */
const collectionState = async (user, item) => {
  const um = (
    await t.sql(
      `select bucket, watched_on, progress, source from user_media
        where user_id = $1 and media_item_id = $2`,
      [user, item],
    )
  ).rows[0] ?? null;
  const events = (
    await t.sql(
      `select watched_on, basis from watch_events
        where user_id = $1 and media_item_id = $2 order by watched_on nulls first, recorded_at`,
      [user, item],
    )
  ).rows;
  const ranked = (
    await t.sql(`select position, bucket from rankings where user_id = $1 and media_item_id = $2`, [
      user,
      item,
    ])
  ).rows[0] ?? null;
  const watchlisted = (
    await t.sql(`select 1 from watchlist where user_id = $1 and media_item_id = $2`, [user, item])
  ).rows.length;
  const feed = (
    await t.sql(`select type from feed_events where actor_id = $1 and media_item_id = $2 order by type`, [
      user,
      item,
    ])
  ).rows.map((r) => r.type);
  return { um, events, ranked, watchlisted, feed };
};

const eventIds = async (user, item) =>
  (
    await t.sql(
      `select id from watch_events where user_id = $1 and media_item_id = $2
        order by watched_on nulls first, recorded_at`,
      [user, item],
    )
  ).rows.map((r) => r.id);

let owner;
let viewer;
let movieA;
let movieB;
let movieC;
let series;
let seasonOne;
let seasonTwo;

before(async () => {
  t = await createTestDb();

  owner = await t.createUser({ username: 'ixowner' });
  viewer = await t.createUser({ username: 'ixviewer' });

  movieA = await t.createMovie('Interaction A', seq++);
  movieB = await t.createMovie('Interaction B', seq++);
  movieC = await t.createMovie('Interaction C', seq++);
  series = await t.createSeries('Interaction Series', seq++);
  seasonOne = await t.createSeason(series, 1, 'Interaction Season 1');
  seasonTwo = await t.createSeason(series, 2, 'Interaction Season 2');
});

after(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.sql(`delete from lists`);
  await t.sql(`delete from watchlist`);
  await t.sql(`delete from feed_events`);
  await t.sql(`delete from rankings`);
  await t.sql(`delete from user_media`);
  await t.sql(`delete from processed_operations`);
});

// ---------------------------------------------------------------------------
// A list is authored grouping only
// ---------------------------------------------------------------------------

describe('a list does not touch the collection', () => {
  it('adding a title logs nothing, watchlists nothing, ranks nothing, posts nothing', async () => {
    const list = await createList(owner);
    const before = await collectionState(owner, movieA);

    assert.equal((await addItem(owner, list, movieA)).status, 'added');

    assert.deepEqual(
      await collectionState(owner, movieA),
      before,
      'adding a title to a list changed the collection',
    );
    assert.equal(before.um, null, 'the fixture was already logged; the assertion above is vacuous');
    // And no watch event exists for a title nobody claims to have watched.
    assert.equal((await eventIds(owner, movieA)).length, 0);
  });

  it('adding a whole series to a list neither logs it nor its seasons', async () => {
    const list = await createList(owner);
    assert.equal((await addItem(owner, list, series)).status, 'added');

    for (const item of [series, seasonOne, seasonTwo]) {
      const state = await collectionState(owner, item);
      assert.equal(state.um, null, 'a listed series reached user_media');
      assert.equal(state.events.length, 0, 'a listed series produced a watch event');
      assert.equal(state.watchlisted, 0, 'a listed series reached the watchlist');
    }
  });

  it('removing a title from a list does not unlog it, and deleting the list does not either', async () => {
    const list = await createList(owner);
    await addItem(owner, list, movieA);
    await logTitle(owner, movieA, '2026-02-02');

    const logged = await collectionState(owner, movieA);
    assert.ok(logged.um, 'the fixture did not log');

    await removeItem(owner, list, movieA);
    assert.deepEqual(await collectionState(owner, movieA), logged, 'removal changed the collection');

    await addItem(owner, list, movieA);
    await destroy(owner, list);
    assert.deepEqual(
      await collectionState(owner, movieA),
      logged,
      'deleting the list changed the collection',
    );
  });

  it('a title on a list keeps its watchlist entry exactly as it was', async () => {
    const list = await createList(owner);
    await setWatchlist(owner, movieA, true);
    const before = (
      await t.sql(`select created_at from watchlist where user_id = $1 and media_item_id = $2`, [
        owner,
        movieA,
      ])
    ).rows[0];

    await addItem(owner, list, movieA);
    await removeItem(owner, list, movieA);

    const after = (
      await t.sql(`select created_at from watchlist where user_id = $1 and media_item_id = $2`, [
        owner,
        movieA,
      ])
    ).rows[0];
    assert.deepEqual(after, before, 'list membership moved the watchlist row');
  });
});

// ---------------------------------------------------------------------------
// Watch History does not disturb a list
// ---------------------------------------------------------------------------

describe('a watch does not touch a list', () => {
  /** Every watch-history writer, against a list holding the same title. */
  const cases = [
    ['log_title', async (item) => logTitle(owner, item, '2026-03-03')],
    [
      'log_rewatch',
      async (item) => {
        await logTitle(owner, item, '2026-03-03');
        return logRewatch(owner, item, '2026-04-04');
      },
    ],
    [
      'edit_watch_event',
      async (item) => {
        await logTitle(owner, item, '2026-03-03');
        const [id] = await eventIds(owner, item);
        return editEvent(owner, id, '2025-01-01');
      },
    ],
    [
      'delete_watch_event',
      async (item) => {
        await logTitle(owner, item, '2026-03-03');
        await logRewatch(owner, item, '2026-05-05');
        const ids = await eventIds(owner, item);
        return deleteEvent(owner, ids.at(-1));
      },
    ],
    [
      'unlog',
      async (item) => {
        await logTitle(owner, item, '2026-03-03');
        return unlog(owner, item);
      },
    ],
  ];

  for (const [name, act] of cases) {
    it(`${name} leaves the list's items, order and updated_at untouched`, async () => {
      const list = await createList(owner);
      for (const item of [movieA, movieB, movieC]) await addItem(owner, list, item);
      const before = await listState(list);

      await act(movieB);

      assert.deepEqual(await listState(list), before, `${name} moved the list`);
    });
  }

  it('unlogging a listed title keeps it on the list with its position', async () => {
    const list = await createList(owner);
    for (const item of [movieA, movieB, movieC]) await addItem(owner, list, item);
    await logTitle(owner, movieB, '2026-03-03');
    await unlog(owner, movieB);

    const { items } = await listState(list);
    assert.deepEqual(
      items.map((r) => r.media_item_id),
      [movieA, movieB, movieC],
      'unlogging dropped the title from the list',
    );
    assert.equal((await collectionState(owner, movieB)).um, null, 'unlog did not unlog');
  });
});

// ---------------------------------------------------------------------------
// The one coupling that is meant to exist: seen, as a read
// ---------------------------------------------------------------------------

describe('seen is a read, not a membership', () => {
  it('a watch moves viewer progress and nothing else about the list', async () => {
    const list = await createList(owner, 'public');
    for (const item of [movieA, movieB]) await addItem(owner, list, item);
    const before = await listState(list);

    assert.deepEqual(await progress(owner, list), { seen: 0, total: 2 });

    await logTitle(owner, movieA, '2026-06-06');

    assert.deepEqual(await progress(owner, list), { seen: 1, total: 2 }, 'progress ignored a watch');
    assert.deepEqual(await listState(list), before, 'a watch moved the list itself');
  });

  it('an undated watch still counts as seen — seen is the collection row, not a date', async () => {
    const list = await createList(owner, 'public');
    await addItem(owner, list, movieA);

    // *Earlier*: a viewing whose timing nobody recorded (§C.3.8, basis none).
    await logTitle(owner, movieA, null, 'none');

    assert.deepEqual(
      await progress(owner, list),
      { seen: 1, total: 1 },
      'an undated viewing did not count as seen',
    );
  });

  it('a rewatch does not double-count progress', async () => {
    const list = await createList(owner, 'public');
    await addItem(owner, list, movieA);
    await logTitle(owner, movieA, '2026-06-06');
    await logRewatch(owner, movieA, '2026-07-07');

    assert.equal((await eventIds(owner, movieA)).length, 2, 'the rewatch did not record');
    assert.deepEqual(await progress(owner, list), { seen: 1, total: 1 }, 'progress counted viewings');
  });

  it('a season in progress is not seen, and a completed one is (§K)', async () => {
    const list = await createList(owner, 'public');
    await addItem(owner, list, seasonOne);

    await t.sql(
      `insert into user_media (user_id, media_item_id, progress) values ($1, $2, 'watching')`,
      [owner, seasonOne],
    );
    assert.deepEqual(await progress(owner, list), { seen: 0, total: 1 }, 'a half-watched season read as seen');

    await t.sql(`update user_media set progress = 'completed' where user_id = $1 and media_item_id = $2`, [
      owner,
      seasonOne,
    ]);
    assert.deepEqual(await progress(owner, list), { seen: 1, total: 1 }, 'a completed season read as unseen');
  });

  it('a whole series is seen once any season is, and watch history does not change that rule', async () => {
    const list = await createList(owner, 'public');
    await addItem(owner, list, series);

    assert.deepEqual(await progress(owner, list), { seen: 0, total: 1 });

    await logTitle(owner, seasonTwo, '2026-08-08');
    assert.deepEqual(
      await progress(owner, list),
      { seen: 1, total: 1 },
      'a logged season did not make its series seen',
    );

    // And a rewatch of that season changes nothing about the series line.
    await logRewatch(owner, seasonTwo, '2026-09-09');
    assert.deepEqual(await progress(owner, list), { seen: 1, total: 1 });
  });
});

// ---------------------------------------------------------------------------
// The bulk Watchlist add, across the two features
// ---------------------------------------------------------------------------

describe('add_list_to_watchlist beside watch events', () => {
  it('skips what the viewer has watched, adds the rest, and posts nothing', async () => {
    const list = await createList(owner, 'public');
    for (const item of [movieA, movieB, movieC]) await addItem(owner, list, item);

    // The viewer has seen A (dated) and B (undated); C is new to them.
    await logTitle(viewer, movieA, '2026-01-01');
    await logTitle(viewer, movieB, null, 'none');

    const result = await bulkWatchlist(viewer, list);
    assert.equal(result.status, 'ok');
    assert.equal(result.added, 1, 'the bulk add did not add exactly the unseen title');
    assert.equal(result.skipped_seen, 2, 'an undated viewing was not counted as seen');

    const saved = (
      await t.sql(`select media_item_id from watchlist where user_id = $1`, [viewer])
    ).rows.map((r) => r.media_item_id);
    assert.deepEqual(saved, [movieC]);

    const posted = (await t.sql(`select count(*)::int as n from feed_events where actor_id = $1`, [viewer]))
      .rows[0].n;
    assert.equal(posted, 0, 'the bulk add announced itself in the feed (§K says it is silent)');
  });

  it('a title added by the bulk add still leaves the watchlist when it is watched', async () => {
    const list = await createList(owner, 'public');
    await addItem(owner, list, movieC);
    await bulkWatchlist(viewer, list);
    assert.equal((await collectionState(viewer, movieC)).watchlisted, 1);

    await logTitle(viewer, movieC, '2026-09-10');

    assert.equal(
      (await collectionState(viewer, movieC)).watchlisted,
      0,
      'the watchlist invariant broke for a title that arrived from a list',
    );
    // And the list itself is unchanged: the title is still on it.
    const { items } = await listState(list);
    assert.deepEqual(items.map((r) => r.media_item_id), [movieC]);
  });

  it('a historical first viewing also clears the watchlist entry (§D.2, the first-watch case)', async () => {
    const list = await createList(owner, 'public');
    await addItem(owner, list, movieC);
    await bulkWatchlist(viewer, list);

    // The first actual evidence of watching, recorded with a past date. The approved
    // reading of §D.2 applies the chronology guard to the SECOND and later viewings, so
    // this first one still clears the watchlist.
    await logTitle(viewer, movieC, '2024-05-05');

    assert.equal(
      (await collectionState(viewer, movieC)).watchlisted,
      0,
      'a first viewing with a historical date left the title on the watchlist',
    );
  });
});
