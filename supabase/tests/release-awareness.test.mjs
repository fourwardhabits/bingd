import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Release awareness, SHADOW tranche: 20260930000100 and 20260930000200.
 *
 * Every time-dependent call takes an explicit clock (`p_now`) and every read carries its
 * own `read_at`, so nothing here waits for a real release and nothing depends on the day
 * the suite runs. Dates are in 2031 so no seeded catalogue row can be confused with a
 * fixture.
 *
 * The contract being pinned is the founder's (docs/product/release-awareness.md,
 * decisions 1-5): a release needs a TMDB read at most 12 hours old; a release first seen
 * more than 7 days late never reaches evaluation; caught-up viewers may be pushed, behind
 * viewers are inbox only, no history gets nothing; 2 pushes per 7 days, 36 hours apart,
 * 10:00-20:00 local, unknown timezone means no push; and nothing in this tranche can send.
 */

const here = dirname(fileURLToPath(import.meta.url));

let t;
let seq = 0;

const RELEASE = '2031-05-16'; // a Friday
const at = (iso) => new Date(iso).toISOString();

const one = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;
const uuid = async () => one(`gen_random_uuid()`);

/** A series with real-looking (positive) TMDB ids, so reconcile will track it. */
async function series(title, seasons = {}) {
  seq += 1;
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, provenance)
     values ('series', $1, $2, 'tmdb') returning id`,
    [1_900_000_000 + seq, title],
  );
  const id = rows[0].id;
  const ids = {};
  for (const [n, date] of Object.entries(seasons)) {
    const { rows: s } = await t.sql(
      `insert into media_items (kind, parent_id, season_number, tmdb_id, title, release_date, provenance)
       values ('season', $1, $2, $3, $4, $5, 'tmdb') returning id`,
      [id, Number(n), 1_950_000_000 + seq * 100 + Number(n), `Season ${n}`, date],
    );
    ids[n] = s[0].id;
  }
  return { id, seasons: ids };
}

async function movie(title, releaseDate = '2031-06-01') {
  seq += 1;
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, release_date, provenance)
     values ('movie', $1, $2, $3, 'tmdb') returning id`,
    [1_900_000_000 + seq, title, releaseDate],
  );
  return rows[0].id;
}

async function user(name, { timezone = 'UTC', region = 'US', device = true } = {}) {
  const id = await t.createUser({ username: `${name}${(seq += 1)}`.slice(0, 20) });
  if (timezone || region) {
    await t.sql(`insert into account_context (user_id, timezone, region) values ($1, $2, $3)`, [
      id,
      timezone,
      region,
    ]);
  }
  if (device) {
    await t.sql(
      `insert into device_tokens (user_id, token, platform) values ($1, $2, 'ios')`,
      [id, `ExponentPushToken[${id}]`],
    );
  }
  return id;
}

async function as(userId, sql, params) {
  await t.actAs(userId);
  try {
    return await one(sql, params);
  } finally {
    await t.actAs(null);
  }
}

const watched = async (u, mediaItemId) =>
  as(u, `set_bucket($1, $2, 'loved')`, [await uuid(), mediaItemId]);
const watching = async (u, mediaItemId) =>
  as(u, `set_season_progress($1, $2, 'watching')`, [await uuid(), mediaItemId]);
const watchlist = async (u, mediaItemId) =>
  as(u, `set_watchlist($1, $2, true)`, [await uuid(), mediaItemId]);

/** Track a subject directly, for state-machine tests that are not about interest. */
const track = (id, kind, now = '2031-01-01T00:00:00Z') =>
  t.sql(
    `insert into release_subjects (media_item_id, subject_kind, next_check_at)
     values ($1, $2, $3) on conflict do nothing`,
    [id, kind, now],
  );

const observeSeries = (id, seasons, now, { readAt = now, status = 'Returning Series' } = {}) =>
  one(`release_observe($1::jsonb, $2::timestamptz)`, [
    JSON.stringify({
      media_item_id: id,
      kind: 'series',
      status,
      in_production: true,
      read_at: at(readAt),
      seasons: Object.entries(seasons).map(([n, d]) => ({ season_number: Number(n), air_date: d })),
    }),
    at(now),
  ]);

const observeMovie = (id, theatrical, now, { readAt = now, status = 'Post Production', limited = null } = {}) =>
  one(`release_observe($1::jsonb, $2::timestamptz)`, [
    JSON.stringify({
      media_item_id: id,
      kind: 'movie',
      status,
      read_at: at(readAt),
      regions: [{ region: 'US', theatrical, limited, digital: null, premiere: null }],
    }),
    at(now),
  ]);

const event = async (mediaItemId) =>
  (await t.sql(`select * from release_events where media_item_id = $1`, [mediaItemId])).rows[0];

const logFor = async (eventId) =>
  (
    await t.sql(`select change, from_state, to_state, old_date::text, new_date::text
                   from release_event_log where release_event_id = $1 order by id`, [eventId])
  ).rows;

const evaluate = (now) => one(`_release_evaluate($1::timestamptz)`, [at(now)]);

const ledger = async (eventId) =>
  (
    await t.sql(
      `select l.*, p.username from release_shadow_ledger l join profiles p on p.id = l.user_id
        where release_event_id = $1 order by p.username`,
      [eventId],
    )
  ).rows;

const rowFor = async (u, eventId) =>
  (
    await t.sql(`select * from release_shadow_ledger where user_id = $1 and release_event_id = $2`, [
      u,
      eventId,
    ])
  ).rows[0];

before(async () => {
  t = await createTestDb();
});

after(async () => t.close());

// ---------------------------------------------------------------------------

describe('release state: observation and transitions', () => {
  it('future -> scheduled, then released on a fresh read once the date has begun anywhere', async () => {
    const show = await series('Severance Fixture', { 1: '2029-02-01', 2: '2030-02-01', 3: null });
    await track(show.id, 'series');

    await observeSeries(show.id, { 1: '2029-02-01', 2: '2030-02-01', 3: RELEASE }, '2031-05-01T00:00:00Z');
    let e = await event(show.seasons[3]);
    assert.equal(e.state, 'scheduled');
    assert.equal(e.scheduled_date.toISOString().slice(0, 10), RELEASE);
    assert.equal(e.evaluation, 'none');

    // 00:00 on the date at UTC+14 is 10:00 UTC the day before. One minute earlier: not yet.
    await observeSeries(show.id, { 3: RELEASE }, '2031-05-15T09:59:00Z');
    assert.equal((await event(show.seasons[3])).state, 'scheduled');

    await observeSeries(show.id, { 3: RELEASE }, '2031-05-15T10:00:00Z');
    e = await event(show.seasons[3]);
    assert.equal(e.state, 'released');
    assert.equal(e.released_on.toISOString().slice(0, 10), RELEASE);
    assert.equal(e.evaluation, 'pending');

    // The earlier seasons were already out when first observed, years late: recorded, never evaluated.
    assert.equal((await event(show.seasons[1])).evaluation, 'skipped_stale');
    assert.deepEqual(
      (await logFor(e.id)).map((r) => r.change),
      ['created', 'released'],
    );
  });

  it('refuses to release on a read older than 12 hours, and releases on the next fresh one', async () => {
    const show = await series('Stale Read', { 1: '2030-01-01', 2: null });
    await track(show.id, 'series');
    await observeSeries(show.id, { 2: RELEASE }, '2031-05-10T00:00:00Z');

    const now = '2031-05-16T12:00:00Z';
    await observeSeries(show.id, { 2: RELEASE }, now, { readAt: '2031-05-15T23:59:00Z' });
    assert.equal((await event(show.seasons[2])).state, 'scheduled', '12h01m old: not authoritative');

    await observeSeries(show.id, { 2: RELEASE }, now, { readAt: '2031-05-16T00:00:00Z' });
    assert.equal((await event(show.seasons[2])).state, 'released', 'exactly 12h old: authoritative');
  });

  it('a read stamped in the future is treated as now, not as fresher', async () => {
    const show = await series('Clock Skew', { 1: '2030-01-01', 2: null });
    await track(show.id, 'series');
    const r = await observeSeries(show.id, { 2: RELEASE }, '2031-05-16T12:00:00Z', {
      readAt: '2031-05-17T12:00:00Z',
    });
    assert.equal(r.fresh, true);
    const { rows } = await t.sql(`select last_read_at from release_subjects where media_item_id = $1`, [show.id]);
    assert.equal(rows[0].last_read_at.toISOString(), at('2031-05-16T12:00:00Z'));
  });

  it('postponement: the date moves, is logged, and the old date releases nothing', async () => {
    const show = await series('Postponed', { 1: '2030-01-01', 2: null });
    await track(show.id, 'series');
    await observeSeries(show.id, { 2: RELEASE }, '2031-05-01T00:00:00Z');
    await observeSeries(show.id, { 2: '2031-06-20' }, '2031-05-14T00:00:00Z');

    let e = await event(show.seasons[2]);
    assert.equal(e.state, 'scheduled');
    assert.equal(e.scheduled_date.toISOString().slice(0, 10), '2031-06-20');
    assert.equal(e.previous_date.toISOString().slice(0, 10), RELEASE);
    assert.equal(e.date_changes, 1);

    // The original day arrives; TMDB still says June.
    await observeSeries(show.id, { 2: '2031-06-20' }, '2031-05-16T12:00:00Z');
    e = await event(show.seasons[2]);
    assert.equal(e.state, 'scheduled');
    assert.deepEqual(
      (await logFor(e.id)).map((r) => [r.change, r.old_date, r.new_date]),
      [
        ['created', null, RELEASE],
        ['date_changed', RELEASE, '2031-06-20'],
      ],
    );
  });

  it('a date moved earlier is a change too, and pulls the next read in to six hours', async () => {
    const show = await series('Pulled Forward', { 1: '2030-01-01', 2: null });
    await track(show.id, 'series');
    await observeSeries(show.id, { 2: '2031-09-01' }, '2031-05-01T00:00:00Z');
    await observeSeries(show.id, { 2: '2031-05-02' }, '2031-05-01T06:00:00Z');

    const e = await event(show.seasons[2]);
    assert.equal(e.date_changes, 1);
    assert.equal(e.previous_date.toISOString().slice(0, 10), '2031-09-01');
    const { rows } = await t.sql(`select next_check_at from release_subjects where media_item_id = $1`, [show.id]);
    assert.equal(rows[0].next_check_at.toISOString(), at('2031-05-01T12:00:00Z'));
  });

  it('future -> TBD clears the stale date (which media_items could never do)', async () => {
    const show = await series('Back To TBD', { 1: '2030-01-01', 2: null });
    await track(show.id, 'series');
    await observeSeries(show.id, { 2: RELEASE }, '2031-05-01T00:00:00Z');
    await observeSeries(show.id, { 2: null }, '2031-05-02T00:00:00Z');

    const e = await event(show.seasons[2]);
    assert.equal(e.state, 'announced');
    assert.equal(e.scheduled_date, null);
    assert.equal(e.date_first_seen_at, null);
    assert.equal(e.date_changes, 1);
    assert.equal((await logFor(e.id)).at(-1).change, 'date_cleared');

    // And the date comes back later: a fresh first-seen, a date_set.
    await observeSeries(show.id, { 2: '2031-11-01' }, '2031-06-01T00:00:00Z');
    const back = await event(show.seasons[2]);
    assert.equal(back.state, 'scheduled');
    assert.equal(back.date_first_seen_at.toISOString(), at('2031-06-01T00:00:00Z'));
    assert.equal((await logFor(e.id)).at(-1).change, 'date_set');
  });

  it('refresh idempotency: the same observation twice changes nothing and logs nothing', async () => {
    const show = await series('Twice Seen', { 1: '2030-01-01', 2: null });
    await track(show.id, 'series');
    await observeSeries(show.id, { 1: '2030-01-01', 2: RELEASE }, '2031-05-01T00:00:00Z');
    const before = (await t.sql(`select count(*)::int n from release_event_log`)).rows[0].n;
    const events = (await t.sql(`select count(*)::int n from release_events`)).rows[0].n;

    const r = await observeSeries(show.id, { 1: '2030-01-01', 2: RELEASE }, '2031-05-01T01:00:00Z');
    assert.deepEqual(r.changes, { unchanged: 2 });
    assert.equal((await t.sql(`select count(*)::int n from release_event_log`)).rows[0].n, before);
    assert.equal((await t.sql(`select count(*)::int n from release_events`)).rows[0].n, events);
    assert.equal(
      (await event(show.seasons[2])).last_observed_at.toISOString(),
      at('2031-05-01T01:00:00Z'),
    );
  });

  it('released is terminal: a later correction is logged as an anomaly and releases nothing again', async () => {
    const show = await series('Wrong Day', { 1: '2030-01-01', 2: null });
    await track(show.id, 'series');
    await observeSeries(show.id, { 2: RELEASE }, '2031-05-16T01:00:00Z');
    await t.sql(`update release_events set evaluation = 'done' where media_item_id = $1`, [show.seasons[2]]);

    await observeSeries(show.id, { 2: '2031-07-01' }, '2031-05-16T07:00:00Z');
    let e = await event(show.seasons[2]);
    assert.equal(e.state, 'released');
    assert.equal(e.released_on.toISOString().slice(0, 10), RELEASE, 'the recorded release stands');
    assert.equal(e.evaluation, 'done', 'never re-opened for evaluation');
    assert.equal((await logFor(e.id)).at(-1).change, 'moved_after_release');

    // The corrected date arrives: still one event, still terminal, no second release.
    await observeSeries(show.id, { 2: '2031-07-01' }, '2031-07-01T12:00:00Z');
    e = await event(show.seasons[2]);
    assert.equal(e.evaluation, 'done');
    assert.equal((await logFor(e.id)).filter((r) => r.change === 'released').length, 1);
  });

  it('older than 7 days when first seen: recorded as released_stale, never evaluated', async () => {
    const show = await series('Found Late', { 1: '2030-01-01', 2: null, 3: null });
    await track(show.id, 'series');
    // Evaluation day 2031-05-24 (UTC). Seven days earlier is the last fresh date.
    await observeSeries(show.id, { 2: '2031-05-16', 3: '2031-05-17' }, '2031-05-24T12:00:00Z');
    const eight = await event(show.seasons[2]);
    const seven = await event(show.seasons[3]);
    assert.equal(eight.evaluation, 'skipped_stale');
    assert.equal((await logFor(eight.id))[0].change, 'released_stale');
    assert.equal(seven.evaluation, 'pending');
  });

  it('a scheduled event whose date passed while reads failed becomes stale, not fresh', async () => {
    const show = await series('Outage', { 1: '2030-01-01', 2: null });
    await track(show.id, 'series');
    await observeSeries(show.id, { 2: RELEASE }, '2031-05-10T00:00:00Z');
    await observeSeries(show.id, { 2: RELEASE }, '2031-05-30T00:00:00Z');
    assert.equal((await event(show.seasons[2])).evaluation, 'skipped_stale');
  });

  it('a canceled series withdraws what has not aired, and a revival restores it', async () => {
    const show = await series('Axed', { 1: '2030-01-01', 2: null });
    await track(show.id, 'series');
    await observeSeries(show.id, { 1: '2030-01-01', 2: '2031-09-01' }, '2031-05-01T00:00:00Z');
    await observeSeries(show.id, { 1: '2030-01-01', 2: '2031-09-01' }, '2031-05-02T00:00:00Z', {
      status: 'Canceled',
    });
    assert.equal((await event(show.seasons[2])).state, 'withdrawn');
    assert.equal((await event(show.seasons[1])).state, 'released', 'an aired season stays aired');

    await observeSeries(show.id, { 2: '2031-10-01' }, '2031-06-01T00:00:00Z');
    const e = await event(show.seasons[2]);
    assert.equal(e.state, 'scheduled');
    assert.equal((await logFor(e.id)).at(-1).change, 'restored');
  });

  it('Season 0 is ignored and a season the catalogue lacks is counted, not invented', async () => {
    const show = await series('Specials', { 1: '2030-01-01' });
    await track(show.id, 'series');
    const r = await observeSeries(show.id, { 0: RELEASE, 1: '2030-01-01', 7: RELEASE }, '2031-05-01T00:00:00Z');
    assert.equal(r.missing_seasons, 1);
    const { rows } = await t.sql(`select count(*)::int n from release_events where subject_id = $1`, [show.id]);
    assert.equal(rows[0].n, 1);
  });

  it('an untracked subject is answered and nothing is written; a kind mismatch is refused', async () => {
    const show = await series('Nobody Cares', { 1: '2030-01-01', 2: null });
    const r = await observeSeries(show.id, { 2: RELEASE }, '2031-05-01T00:00:00Z');
    assert.equal(r.status, 'untracked');
    assert.equal(await event(show.seasons[2]), undefined);

    await track(show.id, 'series');
    const err = await t.errorFrom(`select release_observe($1::jsonb, now())`, [
      JSON.stringify({ media_item_id: show.id, kind: 'movie', regions: [] }),
    ]);
    assert.match(err?.message ?? '', /is a series, not a movie/);
  });

  it('films: only a US wide-theatrical (type 3) date makes a release; limited and canceled do not', async () => {
    const wide = await movie('Wide Release');
    const limited = await movie('Two Cities Only');
    const axed = await movie('Shelved');
    for (const m of [wide, limited, axed]) await track(m, 'movie');

    await observeMovie(wide, RELEASE, '2031-05-16T12:00:00Z');
    await observeMovie(limited, null, '2031-05-16T12:00:00Z', { limited: RELEASE });
    await observeMovie(axed, '2031-08-01', '2031-05-16T12:00:00Z', { status: 'Canceled' });

    assert.equal((await event(wide)).state, 'released');
    assert.equal((await event(wide)).region, 'US');
    assert.equal((await event(limited)).state, 'announced');
    assert.equal((await event(axed)).state, 'withdrawn');

    const { rows } = await t.sql(`select facts from release_subjects where media_item_id = $1`, [limited]);
    assert.equal(rows[0].facts.regions[0].limited, RELEASE, 'the US release data is kept, not discarded');
  });

  /**
   * The founder's revision: a film is announced about a week before it opens, once, and
   * never on the day. These are the four awkward cases that policy has to survive.
   */
  describe('film awareness at T-7', () => {
    const filmSubject = async (date, title) => {
      const m = await movie(`${title} ${(seq += 1)}`, date);
      await track(m, 'movie');
      return m;
    };

    it('arms on T-7 and not before, and records the date it counts back from', async () => {
      const m = await filmSubject(RELEASE, 'On Time');
      await observeMovie(m, RELEASE, '2031-05-08T23:59:00Z');
      assert.equal((await event(m)).evaluation, 'none', 'T-8 is not yet the week');
      await observeMovie(m, RELEASE, '2031-05-09T00:01:00Z');
      const e = await event(m);
      assert.equal(e.evaluation, 'pending');
      assert.equal(e.awareness_on.toISOString().slice(0, 10), '2031-05-09');
      assert.equal(e.state, 'scheduled');
      assert.equal((await logFor(e.id)).at(-1).change, 'awareness_due');
    });

    it('a film met inside the week fires at once, with less notice', async () => {
      const m = await filmSubject(RELEASE, 'Late Find');
      await observeMovie(m, RELEASE, '2031-05-14T09:00:00Z'); // two days out
      assert.equal((await event(m)).evaluation, 'pending');
    });

    it('a film met on its opening day, or after, is never announced at all', async () => {
      const onTheDay = await filmSubject(RELEASE, 'Opening Day');
      await observeMovie(onTheDay, RELEASE, '2031-05-16T09:00:00Z');
      let e = await event(onTheDay);
      assert.deepEqual([e.state, e.evaluation], ['released', 'skipped_late']);
      assert.equal((await logFor(e.id))[0].change, 'released_late');

      const after = await filmSubject(RELEASE, 'Already Out');
      await observeMovie(after, RELEASE, '2031-05-18T09:00:00Z');
      e = await event(after);
      assert.equal(e.evaluation, 'skipped_late', 'a day-of push is exactly what this replaces');
    });

    it('announced once: a postponement afterwards does not announce it again', async () => {
      const m = await filmSubject(RELEASE, 'Pushed Back');
      await observeMovie(m, RELEASE, '2031-05-09T06:00:00Z');
      assert.equal((await event(m)).evaluation, 'pending');
      await evaluate('2031-05-09T10:00:00Z');
      const e = await event(m);
      assert.equal(e.evaluation, 'done');

      // The studio moves it by a month. The date is recorded; nobody is told twice.
      await observeMovie(m, '2031-06-20', '2031-05-10T06:00:00Z');
      assert.equal((await event(m)).evaluation, 'done');
      await observeMovie(m, '2031-06-20', '2031-06-13T06:00:00Z'); // the new T-7
      assert.equal((await event(m)).evaluation, 'done', 'one awareness per film release in v1');
      assert.equal((await t.sql(`select count(*)::int n from release_event_log where release_event_id = $1 and change = 'awareness_due'`, [e.id])).rows[0].n, 1);
    });

    it('a date pulled inside the week arms on the next read', async () => {
      const m = await filmSubject('2031-08-01', 'Moved Up');
      await observeMovie(m, '2031-08-01', '2031-05-09T06:00:00Z');
      assert.equal((await event(m)).evaluation, 'none');
      await observeMovie(m, '2031-05-13', '2031-05-09T12:00:00Z'); // now four days out
      const e = await event(m);
      assert.equal(e.evaluation, 'pending');
      assert.equal(e.awareness_on.toISOString().slice(0, 10), '2031-05-06');
    });

    it('a stale read never arms an awareness, and a date cleared to TBD disarms nothing already sent', async () => {
      const stale = await filmSubject(RELEASE, 'Stale');
      await observeMovie(stale, RELEASE, '2031-05-09T12:00:00Z', { readAt: '2031-05-08T23:00:00Z' });
      assert.equal((await event(stale)).evaluation, 'none', '13h old: not authoritative');
      await observeMovie(stale, RELEASE, '2031-05-09T12:00:00Z');
      assert.equal((await event(stale)).evaluation, 'pending');

      const tbd = await filmSubject(RELEASE, 'Back To TBD');
      await observeMovie(tbd, null, '2031-05-09T06:00:00Z');
      const e = await event(tbd);
      assert.deepEqual([e.state, e.evaluation, e.awareness_on], ['announced', 'none', null]);
    });
  });

  it('a failed read backs off 1h, 3h, 12h, 24h and never touches release state', async () => {
    const show = await series('Flaky', { 1: '2030-01-01', 2: null });
    await track(show.id, 'series');
    await observeSeries(show.id, { 2: RELEASE }, '2031-05-01T00:00:00Z');
    const now = '2031-05-02T00:00:00Z';
    const gaps = [];
    for (let i = 0; i < 5; i += 1) {
      await one(`release_observe_failure($1, 'TMDB 503', $2::timestamptz)`, [show.id, at(now)]);
      const { rows } = await t.sql(`select next_check_at, failures from release_subjects where media_item_id = $1`, [show.id]);
      gaps.push((rows[0].next_check_at - new Date(now)) / 3_600_000);
    }
    assert.deepEqual(gaps, [1, 3, 12, 24, 24]);
    assert.equal((await event(show.seasons[2])).state, 'scheduled');

    await observeSeries(show.id, { 2: RELEASE }, '2031-05-02T01:00:00Z');
    const { rows } = await t.sql(`select failures, last_error from release_subjects where media_item_id = $1`, [show.id]);
    assert.deepEqual(rows[0], { failures: 0, last_error: null }, 'one good read clears the failure');
  });

  it('cadence follows the design: 6h near a date, 1d within a month, 7d beyond, 3d undated, 30d ended', async () => {
    const next = async (id) =>
      (await t.sql(`select next_check_at from release_subjects where media_item_id = $1`, [id])).rows[0]
        .next_check_at.toISOString();
    const now = '2031-05-01T00:00:00Z';
    const cases = [
      [{ 2: '2031-05-02' }, 'Returning Series', '2031-05-01T06:00:00Z'],
      [{ 2: '2031-05-20' }, 'Returning Series', '2031-05-02T00:00:00Z'],
      [{ 2: '2031-09-01' }, 'Returning Series', '2031-05-08T00:00:00Z'],
      [{ 2: null }, 'Returning Series', '2031-05-04T00:00:00Z'],
      [{ 2: null }, 'Ended', '2031-05-31T00:00:00Z'],
    ];
    for (const [seasons, status, expected] of cases) {
      const show = await series(`Cadence ${status}`, { 1: '2030-01-01', 2: null });
      await track(show.id, 'series');
      await observeSeries(show.id, seasons, now, { status });
      assert.equal(await next(show.id), at(expected), `${status} ${JSON.stringify(seasons)}`);
    }
    const soon = await movie('Soon');
    const later = await movie('Later');
    for (const m of [soon, later]) await track(m, 'movie');
    await observeMovie(soon, '2031-06-15', now);
    await observeMovie(later, '2031-12-15', now);
    assert.equal(await next(soon), at('2031-05-02T00:00:00Z'));
    assert.equal(await next(later), at('2031-05-08T00:00:00Z'));
  });
});

// ---------------------------------------------------------------------------

describe('interest and the scheduled refresh', () => {
  beforeEach(async () => {
    await t.sql(`delete from release_subjects`);
  });

  const tracked = async () =>
    new Set((await t.sql(`select media_item_id from release_subjects`)).rows.map((r) => r.media_item_id));

  it('tracks explicit interest only, drops it when it goes, and ignores suspended accounts', async () => {
    const ranked = await series('Ranked Show', { 1: '2030-01-01' });
    const saved = await series('Saved Show', { 1: '2030-01-01' });
    const ignored = await series('Browsed Show', { 1: '2030-01-01' });
    const future = await movie('Future Film', '2031-09-01');
    const ancient = await movie('Ancient Film', '1999-01-01');
    const byTheSuspended = await series('Suspended Show', { 1: '2030-01-01' });

    const u = await user('interest');
    const gone = await user('suspended');
    await watched(u, ranked.seasons[1]);
    await watchlist(u, saved.id);
    await watchlist(u, future);
    await watchlist(u, ancient);
    await watched(gone, byTheSuspended.seasons[1]);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [gone]);

    const r = await one(`_release_reconcile($1::timestamptz)`, [at('2031-05-01T00:00:00Z')]);
    const set = await tracked();
    assert.ok(set.has(ranked.id));
    assert.ok(set.has(saved.id));
    assert.ok(set.has(future));
    assert.ok(!set.has(ignored.id), 'nobody expressed interest');
    assert.ok(!set.has(ancient), 'a decades-old film is not a release');
    assert.ok(!set.has(byTheSuspended.id), 'suspended accounts are not interest');
    assert.ok(r.added >= 3);

    await as(u, `set_watchlist($1, $2, false)`, [await uuid(), saved.id]);
    const again = await one(`_release_reconcile($1::timestamptz)`, [at('2031-05-01T01:00:00Z')]);
    assert.ok(!(await tracked()).has(saved.id));
    assert.ok(again.removed >= 1);
  });

  it('a film released in the US more than two weeks ago stops being polled', async () => {
    const film = await movie('Opened Already', '2031-04-01');
    const u = await user('filmgoer');
    await watchlist(u, film);
    await one(`_release_reconcile($1::timestamptz)`, [at('2031-04-01T00:00:00Z')]);
    await observeMovie(film, '2031-04-10', '2031-04-10T12:00:00Z');
    await one(`_release_reconcile($1::timestamptz)`, [at('2031-04-20T00:00:00Z')]);
    assert.ok((await tracked()).has(film), '10 days: still polled');
    await one(`_release_reconcile($1::timestamptz)`, [at('2031-04-26T00:00:00Z')]);
    assert.ok(!(await tracked()).has(film), '16 days: done');
  });

  describe('the tick', () => {
    const configure = async () => {
      await t.sql(`create schema if not exists vault`);
      await t.sql(`create table if not exists vault.secrets (name text primary key, secret text not null)`);
      await t.sql(`create or replace view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets`);
      await t.sql(`insert into vault.secrets values ('service_role_key', 'not-a-real-key') on conflict do nothing`);
      await t.sql(`create schema if not exists net`);
      await t.sql(`create table if not exists net.posts (url text, body jsonb)`);
      await t.sql(`
        create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                                                 headers jsonb default '{}', timeout_milliseconds integer default 5000)
        returns bigint language sql as $$ insert into net.posts values (url, body) returning 1::bigint $$`);
      await t.sql(`insert into app_config (key, value) values ('functions.base_url', '"https://example.test/functions/v1"')
                   on conflict (key) do update set value = excluded.value`);
    };
    const unconfigure = async () => {
      await t.sql(`drop view if exists vault.decrypted_secrets`);
      await t.sql(`drop table if exists vault.secrets`);
      await t.sql(`drop schema if exists vault`);
      await t.sql(`drop function if exists net.http_post(text, jsonb, jsonb, jsonb, integer)`);
      await t.sql(`drop table if exists net.posts`);
      await t.sql(`drop schema if exists net`);
      await t.sql(`delete from app_config where key = 'functions.base_url'`);
    };

    /** Everything interest already implies is read, so only what a test adds is due. */
    const settle = async (now) => {
      await one(`_release_reconcile($1::timestamptz)`, [at(now)]);
      await t.sql(`update release_subjects set next_check_at = '2099-01-01'`);
    };

    it('is idle with nothing due, disabled when switched off', async () => {
      await settle('2031-05-01T00:00:00Z');
      const r = await one(`_release_refresh_tick($1::timestamptz)`, [at('2031-05-01T00:00:00Z')]);
      assert.equal(r.status, 'idle');
      await t.sql(`insert into app_config (key, value) values ('release.refresh_enabled', 'false')
                   on conflict (key) do update set value = excluded.value`);
      assert.equal((await one(`_release_refresh_tick()`)).status, 'disabled');
      await t.sql(`update app_config set value = 'true' where key = 'release.refresh_enabled'`);
    });

    it('raises when work is due and the transport is missing, so cron records a failure', async () => {
      const show = await series('Due Show', { 1: '2030-01-01' });
      const u = await user('dueviewer');
      await watched(u, show.seasons[1]);
      const err = await t.errorFrom(`select _release_refresh_tick($1::timestamptz)`, [at('2031-05-01T00:00:00Z')]);
      assert.match(err?.message ?? '', /cannot reach tmdb-adapter/);
      assert.equal((await tracked()).size, 0, 'the whole tick rolled back');
    });

    it('posts the due ids to the adapter, leases them, and respects the batch size', async () => {
      await configure();
      try {
        await settle('2031-05-01T00:00:00Z');
        const u = await user('batcher');
        const shows = [];
        for (let i = 0; i < 3; i += 1) {
          const s = await series(`Batch ${i}`, { 1: '2030-01-01' });
          await watched(u, s.seasons[1]);
          shows.push(s.id);
        }
        await t.sql(`insert into app_config (key, value) values ('release.refresh_batch', '2')
                     on conflict (key) do update set value = excluded.value`);
        const now = '2031-05-01T00:00:00Z';
        const r = await one(`_release_refresh_tick($1::timestamptz)`, [at(now)]);
        assert.equal(r.status, 'posted');
        assert.equal(r.due, 2);
        const { rows: posts } = await t.sql(`select url, body from net.posts`);
        assert.equal(posts.length, 1);
        assert.equal(posts[0].url, 'https://example.test/functions/v1/tmdb-adapter');
        assert.equal(posts[0].body.action, 'release-refresh');
        assert.equal(posts[0].body.ids.length, 2);

        const r2 = await one(`_release_refresh_tick($1::timestamptz)`, [at(now)]);
        assert.equal(r2.due, 1, 'the leased two are not posted again');
        const r3 = await one(`_release_refresh_tick($1::timestamptz)`, [at(now)]);
        assert.equal(r3.status, 'idle');
        const r4 = await one(`_release_refresh_tick($1::timestamptz)`, [at('2031-05-01T02:00:00Z')]);
        assert.equal(r4.due, 2, 'an unanswered lease is retried after two hours');
      } finally {
        await t.sql(`update app_config set value = '40' where key = 'release.refresh_batch'`);
        await unconfigure();
      }
    });
  });
});

// ---------------------------------------------------------------------------

describe('shadow evaluation: eligibility', () => {
  let show;
  let e;
  const u = {};

  before(async () => {
    show = await series('Tiered', { 1: '2029-01-01', 2: '2030-01-01', 3: null });

    u.caughtUp = await user('a_caughtup');
    u.behind = await user('b_behind');
    u.watchingOnly = await user('c_watchingonly');
    u.watchlistOnly = await user('d_watchlistonly');
    u.noTz = await user('e_notz', { timezone: null, region: null });
    u.already = await user('f_already');
    u.prefOff = await user('g_prefoff');
    u.suspended = await user('h_suspended');
    u.noDevice = await user('i_nodevice', { device: false });
    u.stranger = await user('j_stranger');

    await watched(u.caughtUp, show.seasons[2]);
    await watched(u.behind, show.seasons[1]);
    await watching(u.watchingOnly, show.seasons[2]);
    await watchlist(u.watchlistOnly, show.id);
    await watched(u.noTz, show.seasons[2]);
    await watched(u.already, show.seasons[2]);
    await watched(u.already, show.seasons[3]);
    await watched(u.prefOff, show.seasons[2]);
    await t.sql(`insert into notification_preferences (user_id, category, enabled) values ($1, 'new_seasons', false)`, [u.prefOff]);
    await watched(u.suspended, show.seasons[2]);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [u.suspended]);
    await watched(u.noDevice, show.seasons[2]);

    await track(show.id, 'series');
    await observeSeries(show.id, { 1: '2029-01-01', 2: '2030-01-01', 3: RELEASE }, '2031-05-16T08:00:00Z');
    e = await event(show.seasons[3]);
    assert.equal(e.evaluation, 'pending');
    // 07:00 UTC on the release day: outside a UTC window, so nothing is pushed yet.
    await evaluate('2031-05-16T07:00:00Z');
  });

  it('decides every interested account exactly as decision 3 says', async () => {
    const rows = Object.fromEntries((await ledger(e.id)).map((r) => [r.user_id, r]));
    const get = (k) => rows[u[k]];

    assert.deepEqual([get('caughtUp').tier, get('caughtUp').outcome], ['caught_up', 'pending']);
    assert.deepEqual([get('behind').tier, get('behind').outcome, get('behind').reason], ['behind', 'inbox_only', 'behind_tier']);
    assert.deepEqual([get('watchingOnly').tier, get('watchingOnly').outcome, get('watchingOnly').reason], ['no_history', 'skipped', 'no_history']);
    assert.deepEqual([get('watchlistOnly').outcome, get('watchlistOnly').reason], ['skipped', 'no_history']);
    assert.deepEqual([get('noTz').tier, get('noTz').outcome, get('noTz').reason, get('noTz').timezone_known], ['caught_up', 'inbox_only', 'no_timezone', false]);
    assert.deepEqual([get('already').outcome, get('already').reason], ['skipped', 'already_watched']);
    assert.deepEqual([get('prefOff').outcome, get('prefOff').reason, get('prefOff').preference_on], ['skipped', 'preference_off', false]);
    assert.equal(get('noDevice').has_device, false);
    assert.equal(get('noDevice').outcome, 'pending', 'no device is recorded, not decided: the shadow counts it');
    assert.equal(get('suspended'), undefined, 'a suspended account is not evaluated');
    assert.equal(get('stranger'), undefined, 'no interest, no row');
    assert.equal(get('caughtUp').freshness_days, 0);
    assert.equal(get('caughtUp').region_status, 'not_applicable');
  });

  it('dedupe: evaluating again, or re-observing the release, adds nothing', async () => {
    const before = (await ledger(e.id)).length;
    await evaluate('2031-05-16T07:15:00Z');
    await observeSeries(show.id, { 3: RELEASE }, '2031-05-16T09:00:00Z');
    await evaluate('2031-05-16T09:15:00Z');
    assert.equal((await ledger(e.id)).length, before);
    assert.equal((await event(show.seasons[3])).evaluation, 'done');
    const dupes = await t.sql(`select user_id from release_shadow_ledger group by user_id, release_event_id having count(*) > 1`);
    assert.equal(dupes.rows.length, 0);
  });

  it('watchlisted films: the awareness is a week before it opens, and region decides who may be pushed', async () => {
    const film = await movie('Opening Night', RELEASE);
    const us = await user('k_us');
    const unknown = await user('l_unknown', { region: null });
    const gb = await user('m_gb', { region: 'GB' });
    for (const x of [us, unknown, gb]) await watchlist(x, film);
    await track(film, 'movie');

    // T-8: the week has not started, so there is nothing to say yet.
    await observeMovie(film, RELEASE, '2031-05-08T12:00:00Z');
    assert.equal((await event(film)).evaluation, 'none');
    assert.equal((await event(film)).awareness_on.toISOString().slice(0, 10), '2031-05-09');

    // T-7.
    await observeMovie(film, RELEASE, '2031-05-09T06:00:00Z');
    const fe = await event(film);
    assert.equal(fe.evaluation, 'pending');
    assert.equal(fe.state, 'scheduled', 'the film has not opened yet');
    await evaluate('2031-05-09T06:05:00Z');

    const r = Object.fromEntries((await ledger(fe.id)).map((x) => [x.user_id, x]));
    assert.deepEqual([r[us].tier, r[us].region_status, r[us].outcome], ['watchlist', 'match', 'pending']);
    assert.equal(r[us].days_to_release, 7);
    assert.equal(r[us].timing, 'theatrical_t7');
    assert.deepEqual([r[unknown].region_status, r[unknown].outcome, r[unknown].reason], ['unknown', 'inbox_only', 'region_unknown']);
    assert.deepEqual([r[gb].region_status, r[gb].outcome, r[gb].reason], ['mismatch', 'skipped', 'region_mismatch']);
  });

  it('a stale release produces no ledger rows at all', async () => {
    const late = await series('Late Arrival', { 1: '2029-01-01', 2: null });
    const v = await user('n_late');
    await watched(v, late.seasons[1]);
    await track(late.id, 'series');
    await observeSeries(late.id, { 2: '2031-05-01' }, '2031-05-16T08:00:00Z');
    await evaluate('2031-05-16T08:05:00Z');
    const le = await event(late.seasons[2]);
    assert.equal(le.evaluation, 'skipped_stale');
    assert.equal((await ledger(le.id)).length, 0);
  });
});

// ---------------------------------------------------------------------------

describe('shadow evaluation: window, cap and priority', () => {
  beforeEach(async () => {
    await t.sql(`delete from release_shadow_ledger`);
    await t.sql(`update release_events set evaluation = 'done' where evaluation = 'pending'`);
  });

  /** A caught-up viewer of a fresh premiere released on `date`, observed at `observedAt`. */
  async function premiereFor(v, date, observedAt, title = 'Show') {
    const s = await series(`${title} ${(seq += 1)}`, { 1: '2030-01-01', 2: null });
    await watched(v, s.seasons[1]);
    await track(s.id, 'series');
    await observeSeries(s.id, { 1: '2030-01-01', 2: date }, observedAt);
    return event(s.seasons[2]);
  }

  /** A watchlisted film whose US wide release is `date`, observed at `observedAt`. */
  async function filmFor(v, date, observedAt, title = 'Film') {
    const m = await movie(`${title} ${(seq += 1)}`, date);
    await watchlist(v, m);
    await track(m, 'movie');
    await observeMovie(m, date, observedAt);
    return event(m);
  }

  it('10:00-20:00 in the account’s own zone, across a DST change', async () => {
    // 2031-03-09 is the US spring-forward Sunday: 10:00 PDT is 17:00 UTC, not 18:00.
    const v = await user('o_la', { timezone: 'America/Los_Angeles' });
    const pe = await premiereFor(v, '2031-03-09', '2031-03-09T08:00:00Z');
    await evaluate('2031-03-09T16:59:00Z');
    const waiting = await rowFor(v, pe.id);
    assert.equal(waiting.outcome, 'pending', '09:59 PDT');
    assert.equal(waiting.last_block_reason, 'quiet_window');
    assert.equal(waiting.plan_at.toISOString(), at('2031-03-09T17:00:00Z'), 'planned for 10:00 PDT');
    await evaluate('2031-03-09T17:00:00Z');
    const row = await rowFor(v, pe.id);
    assert.equal(row.outcome, 'would_push', '10:00 PDT');
    assert.equal(row.reason, 'would_send');
  });

  it('past 20:00 local the plan moves to the next morning rather than waking anybody', async () => {
    const v = await user('p_kolkata', { timezone: 'Asia/Kolkata' });
    const pe = await premiereFor(v, RELEASE, '2031-05-16T14:30:00Z'); // 20:00 IST
    await evaluate('2031-05-16T14:31:00Z');
    const row = await rowFor(v, pe.id);
    assert.equal(row.outcome, 'pending');
    assert.equal(row.plan_at.toISOString(), at('2031-05-17T04:30:00Z'), '10:00 IST the next day');
  });

  it('a premiere is never announced before its date has begun in Los Angeles', async () => {
    const akl = await user('r_auckland', { timezone: 'Pacific/Auckland' });
    const pa = await premiereFor(akl, RELEASE, '2031-05-15T23:00:00Z');
    await evaluate('2031-05-15T23:00:00Z'); // 11:00 NZST on the 16th, still the 15th in LA
    const row = await rowFor(akl, pa.id);
    assert.equal(row.outcome, 'pending');
    assert.equal(row.plan_at.toISOString(), at('2031-05-16T07:00:00Z'), '00:00 PDT, inside the NZ window');
    await evaluate('2031-05-16T07:00:00Z');
    assert.equal((await rowFor(akl, pa.id)).outcome, 'would_push');
  });

  it('a film plans for its T-7 window, and records what a day-of push would have been', async () => {
    const v = await user('w_film', { timezone: 'UTC' });
    const fe = await filmFor(v, RELEASE, '2031-05-09T06:00:00Z');
    await evaluate('2031-05-09T06:05:00Z');
    let row = await rowFor(v, fe.id);
    assert.equal(row.outcome, 'pending');
    assert.equal(row.plan_at.toISOString(), at('2031-05-09T10:00:00Z'), 'T-7 at 10:00 local');
    assert.equal(row.alt_timing, 'theatrical_day_of');
    assert.equal(row.alt_plan_at.toISOString(), at('2031-05-16T10:00:00Z'), 'what the day-of policy would have done');
    await evaluate('2031-05-09T10:00:00Z');
    row = await rowFor(v, fe.id);
    assert.equal(row.outcome, 'would_push');
    assert.equal(row.days_to_release, 7);
  });

  it('a season records the day-before alternative beside the morning it actually plans', async () => {
    const v = await user('x_alt', { timezone: 'UTC' });
    const pe = await premiereFor(v, RELEASE, '2031-05-16T08:00:00Z');
    await evaluate('2031-05-16T10:00:00Z');
    const row = await rowFor(v, pe.id);
    assert.equal(row.timing, 'season_release_morning');
    assert.equal(row.alt_timing, 'season_day_before');
    assert.equal(row.plan_at.toISOString(), at('2031-05-16T10:00:00Z'));
    assert.equal(row.alt_plan_at.toISOString(), at('2031-05-15T10:00:00Z'), '24h earlier, for comparison only');
    assert.equal(row.days_to_release, 0);
  });

  /**
   * The founder's revision: explicit interest is no longer capped. Every eligible release
   * is marked would_push, and the former rules are only replayed and recorded.
   */
  it('three releases in one day all go, and the former cap is recorded against two of them', async () => {
    const v = await user('s_binger', { timezone: 'UTC' });
    const a = await premiereFor(v, '2031-05-16', '2031-05-16T08:00:00Z', 'A');
    const b = await premiereFor(v, '2031-05-16', '2031-05-16T08:00:00Z', 'B');
    const c = await premiereFor(v, '2031-05-16', '2031-05-16T08:00:00Z', 'C');
    await evaluate('2031-05-16T10:00:00Z');

    const rows = await Promise.all([a, b, c].map((x) => rowFor(v, x.id)));
    assert.deepEqual(rows.map((r) => r.outcome), ['would_push', 'would_push', 'would_push'], 'nothing is discarded');
    assert.equal(rows.filter((r) => r.cap_would_suppress === false).length, 1, 'the former cap would have sent one');
    assert.deepEqual(
      rows.filter((r) => r.cap_would_suppress).map((r) => r.cap_reason),
      ['lost_to_priority', 'lost_to_priority'],
    );
  });

  it('the counterfactual replays 2 per 7 days and the 36 hour gap over the uncapped stream', async () => {
    const v = await user('y_replay', { timezone: 'UTC' });
    const days = ['2031-05-16', '2031-05-17', '2031-05-18', '2031-05-19'];
    const events = [];
    // A day at a time, in order: each premiere is observed on its morning and evaluated
    // that day, which is what the ticks do.
    for (const d of days) {
      events.push(await premiereFor(v, d, `${d}T08:00:00Z`, `Rep${d}`));
      await evaluate(`${d}T10:00:00Z`);
    }

    const rows = await Promise.all(events.map((e) => rowFor(v, e.id)));
    assert.deepEqual(rows.map((r) => r.outcome), Array(4).fill('would_push'), 'all four are eligible');
    assert.deepEqual(rows.map((r) => r.cap_reason), [
      null,           // day 1: the former rules would have sent it
      'cap_spacing',  // day 2: 24h later, inside the 36h gap
      null,           // day 3: 48h after the last counterfactual send
      'global_cap',   // day 4: two already sent inside the rolling week
    ]);
  });

  it('an inbox-only row carries no cap verdict: the cap was only ever about pushes', async () => {
    const v = await user('z_behind', { timezone: 'UTC' });
    const s = await series(`Behind Cap ${(seq += 1)}`, { 1: '2029-01-01', 2: '2030-01-01', 3: null });
    await watched(v, s.seasons[1]); // behind: never watched Season 2
    await track(s.id, 'series');
    await observeSeries(s.id, { 1: '2029-01-01', 2: '2030-01-01', 3: RELEASE }, '2031-05-16T08:00:00Z');
    await evaluate('2031-05-16T10:00:00Z');
    const row = await rowFor(v, (await event(s.seasons[3])).id);
    assert.deepEqual([row.outcome, row.reason], ['inbox_only', 'behind_tier']);
    assert.equal(row.cap_would_suppress, null);
  });

  it('a timezone that disappears is never guessed', async () => {
    const v = await user('v_vanish', { timezone: 'UTC' });
    const pe = await premiereFor(v, RELEASE, '2031-05-16T08:00:00Z');
    await evaluate('2031-05-16T08:05:00Z');
    await t.sql(`update account_context set timezone = null where user_id = $1`, [v]);
    await evaluate('2031-05-16T12:00:00Z');
    assert.equal((await rowFor(v, pe.id)).last_block_reason, 'no_timezone');
  });
});

// ---------------------------------------------------------------------------

describe('the kill switch: nothing in this tranche can send', () => {
  const releaseTypes = `('season_premiere', 'theatrical_release')`;
  const counts = async () => ({
    notifications: (await t.sql(`select count(*)::int n from notifications where type in ${releaseTypes}`)).rows[0].n,
    outbox: (await t.sql(`select count(*)::int n from push_outbox o join notifications n on n.id = o.notification_id where n.type in ${releaseTypes}`)).rows[0].n,
  });

  it('seeds real sending OFF and shadow ON', async () => {
    const { rows } = await t.sql(`select key, value from app_config where key in ('release.push_enabled', 'release.shadow_enabled') order by key`);
    assert.deepEqual(rows.map((r) => [r.key, r.value]), [
      ['release.push_enabled', false],
      ['release.shadow_enabled', true],
    ]);
  });

  it('with the flag forced ON, a full release still writes zero notifications and zero outbox rows', async () => {
    await t.sql(`update app_config set value = 'true' where key = 'release.push_enabled'`);
    try {
      const v = await user('w_forced', { timezone: 'UTC' });
      const s = await series('Forced', { 1: '2030-01-01', 2: null });
      await watched(v, s.seasons[1]);
      await track(s.id, 'series');
      await observeSeries(s.id, { 2: '2031-05-16' }, '2031-05-16T08:00:00Z');
      await evaluate('2031-05-16T10:00:00Z');
      const row = await rowFor(v, (await event(s.seasons[2])).id);
      assert.equal(row.outcome, 'would_push');
      assert.equal(row.real_send_enabled, true, 'the flag is recorded');
      assert.deepEqual(await counts(), { notifications: 0, outbox: 0 }, 'and acted on by nothing');
    } finally {
      await t.sql(`update app_config set value = 'false' where key = 'release.push_enabled'`);
    }
  });

  it('neither release type may enqueue a push even if a row were written by hand', async () => {
    for (const type of ['season_premiere', 'theatrical_release']) {
      assert.equal(await one(`_push_eligible($1)`, [type]), false);
    }
  });

  it('no release function body writes notifications or push_outbox', async () => {
    const { rows } = await t.sql(`
      select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (p.proname like '%release%' or p.proname = 'report_device_context')`);
    assert.ok(rows.length >= 12);
    for (const { proname, prosrc } of rows) {
      assert.doesNotMatch(prosrc, /(insert\s+into|update|delete\s+from)\s+(public\.)?(notifications|push_outbox)\b/i, proname);
    }
    for (const file of [
      '20260930000100_a_release_you_can_see_coming.sql',
      '20260930000200_a_release_decided_in_the_dark.sql',
      '20260930000300_a_week_before_it_opens.sql',
    ]) {
      // Code only: the headers explain these tables by name, which is the point of them.
      const sql = (await readFile(join(here, '..', 'migrations', file), 'utf8')).replace(/--.*$/gm, '');
      assert.doesNotMatch(sql, /(insert\s+into|update|delete\s+from)\s+(public\.)?(notifications|push_outbox)\b/i, file);
      assert.doesNotMatch(sql, /_push_eligible/, `${file} must not touch push eligibility`);
    }
  });

  it('release_status reports zero release notifications and flags a real-send flag left on', async () => {
    let s = await one(`release_status()`);
    assert.equal(s.release_notifications, 0);
    assert.equal(s.release_push_outbox, 0);
    assert.equal(s.mode.real_send_enabled, false);
    assert.ok(s.problems.includes('functions_base_url_missing'), 'PGlite has no transport configured');
    await t.sql(`update app_config set value = 'true' where key = 'release.push_enabled'`);
    s = await one(`release_status()`);
    assert.ok(s.problems.includes('real_send_flag_on'));
    await t.sql(`update app_config set value = 'false' where key = 'release.push_enabled'`);
  });

  it('shadow OFF evaluates nothing', async () => {
    await t.sql(`update app_config set value = 'false' where key = 'release.shadow_enabled'`);
    try {
      assert.equal((await evaluate('2031-05-16T10:00:00Z')).status, 'disabled');
    } finally {
      await t.sql(`update app_config set value = 'true' where key = 'release.shadow_enabled'`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('rollback and retry', () => {
  it('a rolled-back evaluation leaves the event pending, and the retry writes each row once', async () => {
    await t.sql(`update release_events set evaluation = 'done' where evaluation = 'pending'`);
    const v = await user('x_retry', { timezone: 'UTC' });
    const s = await series('Retry', { 1: '2030-01-01', 2: null });
    await watched(v, s.seasons[1]);
    await track(s.id, 'series');
    await observeSeries(s.id, { 2: '2031-05-16' }, '2031-05-16T08:00:00Z');
    const ev = await event(s.seasons[2]);

    await t.exec('begin');
    await evaluate('2031-05-16T08:05:00Z');
    await t.exec('rollback');
    assert.equal((await event(s.seasons[2])).evaluation, 'pending');
    assert.equal((await ledger(ev.id)).length, 0);

    await evaluate('2031-05-16T08:10:00Z');
    await evaluate('2031-05-16T08:15:00Z');
    assert.equal((await ledger(ev.id)).length, 1);
  });

  it('an account deleted after its row was written takes the row with it', async () => {
    const v = await user('y_deleted', { timezone: 'UTC' });
    const s = await series('Deleted', { 1: '2030-01-01', 2: null });
    await watched(v, s.seasons[1]);
    await track(s.id, 'series');
    await observeSeries(s.id, { 2: '2031-05-16' }, '2031-05-16T08:00:00Z');
    await evaluate('2031-05-16T08:05:00Z');
    const ev = await event(s.seasons[2]);
    assert.equal((await ledger(ev.id)).length, 1);
    await t.sql(`delete from profiles where id = $1`, [v]);
    assert.equal((await ledger(ev.id)).length, 0);
  });
});

// ---------------------------------------------------------------------------

describe('account context and access', () => {
  it('report_device_context validates, never blanks a known value, and is not readable back', async () => {
    const v = await user('z_ctx', { timezone: null, region: null });
    let r = await as(v, `report_device_context('Europe/Warsaw', 'pl')`);
    assert.deepEqual(r, { ok: true, timezone_accepted: true, region_accepted: true });
    r = await as(v, `report_device_context('Mars/Olympus', '???')`);
    assert.deepEqual(r, { ok: true, timezone_accepted: false, region_accepted: false });
    const { rows } = await t.sql(`select timezone, region from account_context where user_id = $1`, [v]);
    assert.deepEqual(rows[0], { timezone: 'Europe/Warsaw', region: 'PL' });

    const seen = await t.asUser(v, () => t.errorFrom(`select * from account_context`));
    assert.ok(seen, 'no client can read account_context, including its owner');
    const anon = await t.asAnon(() => t.errorFrom(`select report_device_context('UTC', 'US')`));
    assert.ok(anon, 'anon cannot report');

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [v]);
    const suspended = await t.asUser(v, () => t.errorFrom(`select report_device_context('UTC', 'US')`));
    assert.ok(suspended, 'a suspended account is refused by assert_can_write');
  });

  it('every release table and operator function is closed to clients', async () => {
    const v = await user('zz_client');
    for (const q of [
      `select * from release_events`,
      `select * from release_subjects`,
      `select * from release_event_log`,
      `select * from release_shadow_ledger`,
      `select * from release_shadow_summary`,
      `select release_status()`,
      `select _release_evaluate()`,
      `select release_observe('{}'::jsonb)`,
      `select schedule_release_awareness()`,
    ]) {
      assert.ok(await t.asUser(v, () => t.errorFrom(q)), `authenticated: ${q}`);
      assert.ok(await t.asAnon(() => t.errorFrom(q)), `anon: ${q}`);
    }
  });
});
