import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Proactive notifications, part 3: 20261031000100.
 *
 * The rules being pinned (docs/product/proactive-notifications.md §Q, §R; Codex final
 * decision of 2026-10-31):
 *   · Reactions default off for every unset account; Awards on; explicit rows win;
 *     nothing backfilled.
 *   · All four switches seed false and fail closed; proactive.season_enabled gates
 *     creation, selection and the claim of season_premiere.
 *   · A season is announced only for a released normal season, freshly read, with a valid
 *     operator verification of US availability that agrees with the release event; to a
 *     reader who saved the series or season, or watched the immediately preceding season.
 *   · Once per (reader, season release); eligible from the start of the date in the
 *     reader's zone and in Los Angeles; expiring at the earliest of three clocks.
 *   · Order: priority, canonical type, a saved season before caught-up-only, social
 *     cluster affinity, then age. A season and its series share the title cooldown.
 *   · _proactive_affinity: pinned weights, decay, caps, reciprocity; never visible.
 *   · Social pushes and rows name the strongest two friends; the count is everybody.
 *   · Version-1 tokens get no proactive push.
 *   · One qualifying social event per transaction.
 *   · release_status flags only unauthorised season rows.
 *
 * Every clock is explicit and in 2031, except the feed_events trigger, which reads now().
 */

let t;
let seq = 0;

const at = (iso) => new Date(iso).toISOString();
const one = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

const setConfig = (key, value) =>
  t.sql(
    `insert into app_config (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );

async function user(name, { timezone = 'UTC', region = 'US', device = true, version = 2 } = {}) {
  const id = await t.createUser({ username: `${name}${(seq += 1)}`.slice(0, 20) });
  await t.sql(`insert into account_context (user_id, timezone, region) values ($1, $2, $3)`, [
    id,
    timezone,
    region,
  ]);
  if (device) {
    await t.sql(
      `insert into device_tokens (user_id, token, platform, proactive_version) values ($1, $2, 'ios', $3)`,
      [id, `ExponentPushToken[${id}-main]`, version],
    );
  }
  return id;
}

async function movie(title, releaseDate = '2020-01-01') {
  seq += 1;
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, release_date, provenance)
     values ('movie', $1, $2, $3, 'tmdb') returning id`,
    [1_810_000_000 + seq, `${title} ${seq}`, releaseDate],
  );
  return rows[0].id;
}

/** A series with seasons `{n: air_date}`. Season 0 is a specials season. */
async function series(title, seasons) {
  seq += 1;
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, provenance)
     values ('series', $1, $2, 'tmdb') returning id`,
    [1_910_000_000 + seq, `${title} ${seq}`],
  );
  const id = rows[0].id;
  const ids = {};
  for (const [n, date] of Object.entries(seasons)) {
    const { rows: s } = await t.sql(
      `insert into media_items (kind, parent_id, season_number, tmdb_id, title, release_date, provenance)
       values ('season', $1, $2, $3, $4, $5, 'tmdb') returning id`,
      [id, Number(n), 1_960_000_000 + seq * 100 + Number(n), `Season ${n}`, date],
    );
    ids[n] = s[0].id;
  }
  return { id, seasons: ids };
}

const friends = async (a, b) => {
  for (const [x, y] of [[a, b], [b, a]]) {
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now()) on conflict do nothing`,
      [x, y],
    );
  }
};

const save = (u, m) =>
  t.sql(`insert into watchlist (user_id, media_item_id, created_at) values ($1, $2, '2030-01-01')`, [u, m]);
const unsave = (u, m) => t.sql(`delete from watchlist where user_id = $1 and media_item_id = $2`, [u, m]);
const logged = (u, m, fields = { bucket: 'loved' }) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket, progress)
     values ($1, $2, $3, $4)`,
    [u, m, fields.bucket ?? null, fields.progress ?? null],
  );

const tick = (iso) => one(`_proactive_tick($1::timestamptz)`, [at(iso)]);
const arbitrate = (iso) => one(`_proactive_arbitrate($1::timestamptz)`, [at(iso)]);

const candidates = async (u, type = null) =>
  (
    await t.sql(
      `select * from proactive_candidates
        where recipient_id = $1 and ($2::text is null or type = $2)
        order by created_at, id`,
      [u, type],
    )
  ).rows;

const inbox = async (u) => {
  await t.actAs(u);
  try {
    return (await t.sql(`select * from my_notifications(200)`)).rows;
  } finally {
    await t.actAs(null);
  }
};

async function claimFor(u, iso) {
  const jobs = [];
  for (let i = 0; i < 10; i += 1) {
    const batch = await one(`claim_push_batch(100, $1::timestamptz)`, [at(iso)]);
    if (!batch.length) break;
    jobs.push(...batch);
  }
  const { rows } = await t.sql(`select id from notifications where recipient_id = $1`, [u]);
  const mine = new Set(rows.map((r) => r.id));
  return jobs.filter((j) => mine.has(j.notification_id));
}

// Release fixtures, the release-awareness suite's own shape.
const track = (id, kind, now = '2031-01-01T00:00:00Z') =>
  t.sql(
    `insert into release_subjects (media_item_id, subject_kind, next_check_at)
     values ($1, $2, $3) on conflict do nothing`,
    [id, kind, now],
  );
const observeSeries = (id, seasons, now, { status = 'Returning Series' } = {}) =>
  one(`release_observe($1::jsonb, $2::timestamptz)`, [
    JSON.stringify({
      media_item_id: id,
      kind: 'series',
      status,
      in_production: true,
      read_at: at(now),
      seasons: Object.entries(seasons).map(([n, d]) => ({ season_number: Number(n), air_date: d })),
    }),
    at(now),
  ]);
const observeMovie = (id, theatrical, now) =>
  one(`release_observe($1::jsonb, $2::timestamptz)`, [
    JSON.stringify({
      media_item_id: id,
      kind: 'movie',
      status: 'Post Production',
      read_at: at(now),
      regions: [{ region: 'US', theatrical, limited: null, digital: null, premiere: null }],
    }),
    at(now),
  ]);

const RELEASE = '2031-05-16';
const OBSERVED = '2031-05-16T14:00:00Z'; // 07:00 in Los Angeles: the day has started there
const EVENING = '2031-05-16T18:00:00Z'; // 18:00 for a UTC reader
const CLAIM = '2031-05-16T18:05:00Z';

const verify = (event, { availableOn = RELEASE, verifiedAt = OBSERVED, hours = 24, region = 'US' } = {}) =>
  t.sql(
    `insert into proactive_season_availability
       (release_event_id, region, available_on, verified_at, valid_until, evidence_url)
     values ($1, $2, $3, $4::timestamptz, $4::timestamptz + make_interval(hours => $5), 'https://tv.example.com/s')
     on conflict (release_event_id, region) do update
       set available_on = excluded.available_on, verified_at = excluded.verified_at,
           valid_until = excluded.valid_until`,
    [event, region, availableOn, at(verifiedAt), hours],
  );

/**
 * A series whose Season 3 is released on RELEASE, observed at `observedAt`, with a
 * verification unless `verified` is false. Seasons 0 (specials), 1 and 2 aired long ago.
 */
async function seasonRelease({ release = RELEASE, observedAt = OBSERVED, verified = true } = {}) {
  const s = await series('Severance', { 0: '2020-01-01', 1: '2022-02-18', 2: '2025-01-17', 3: release });
  await track(s.id, 'series');
  await observeSeries(s.id, { 0: '2020-01-01', 1: '2022-02-18', 2: '2025-01-17', 3: release }, observedAt);
  const event = await one(
    `(select id from release_events where media_item_id = $1 and event_kind = 'season_premiere')`,
    [s.seasons[3]],
  );
  if (verified) await verify(event, { availableOn: release, verifiedAt: observedAt });
  return { ...s, event };
}

before(async () => {
  t = await createTestDb();
});

after(async () => t.close());

beforeEach(async () => {
  await setConfig('proactive.push_enabled', true);
  await setConfig('proactive.generation_enabled', true);
  await setConfig('proactive.resurface_enabled', false);
  await setConfig('proactive.season_enabled', true);
});

// ===========================================================================

describe('defaults (founder, 2026-10-31)', () => {
  it('an unset account gets Reactions off and Awards on, with no row written', async () => {
    const u = await user('dflt');
    await t.actAs(u);
    const { rows } = await t.sql(`select category, enabled from my_notification_preferences()`);
    await t.actAs(null);
    const prefs = Object.fromEntries(rows.map((r) => [r.category, r.enabled]));
    assert.equal(prefs.reactions, false);
    assert.equal(prefs.awards, true);
    assert.equal(prefs.watchlist_discovery, true);
    assert.equal(await one(`_notifies($1, 'reactions')`, [u]), false);
    assert.equal(await one(`_notifies($1, 'awards')`, [u]), true);
    const n = await one(`(select count(*)::integer from notification_preferences where user_id = $1)`, [u]);
    assert.equal(n, 0, 'nothing is backfilled');
  });

  it('explicit choices win both ways', async () => {
    const on = await user('rxon');
    const off = await user('awoff');
    await t.sql(`insert into notification_preferences (user_id, category, enabled) values ($1, 'reactions', true)`, [on]);
    await t.sql(`insert into notification_preferences (user_id, category, enabled) values ($1, 'awards', false)`, [off]);
    assert.equal(await one(`_notifies($1, 'reactions')`, [on]), true);
    assert.equal(await one(`_notifies($1, 'awards')`, [off]), false);
  });

  it('the insert-time gate drops a reaction for an unset account and keeps it for one that chose on', async () => {
    const actor = await user('rxactor');
    const unset = await user('rxunset');
    const chose = await user('rxchose');
    await t.sql(`insert into notification_preferences (user_id, category, enabled) values ($1, 'reactions', true)`, [chose]);
    const write = (r) =>
      t.sql(
        `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
         values ($1, 'reaction', $2, 'profile', $2) returning id`,
        [r, actor],
      );
    assert.equal((await write(unset)).rows.length, 0, 'no inbox row, so no push can follow');
    assert.equal((await write(chose)).rows.length, 1);
  });
});

describe('inertness: four switches, fail closed', () => {
  it('ships every switch off and version 2 as the minimum', async () => {
    const fresh = await createTestDb();
    try {
      const { rows } = await fresh.sql(`select key, value from app_config where key like 'proactive.%'`);
      const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      for (const key of ['generation_enabled', 'push_enabled', 'resurface_enabled', 'season_enabled']) {
        assert.equal(cfg[`proactive.${key}`], false, key);
      }
      assert.equal(cfg['proactive.min_client_version'], 2);
      assert.equal(cfg['proactive.season_max_read_age_hours'], 12);
      assert.equal(cfg['proactive.season_collect_hours'], 48);
      const status = (await fresh.sql(`select proactive_status() as s`)).rows[0].s;
      assert.equal(status.season_enabled, false);
    } finally {
      await fresh.close();
    }
  });

  it('the season switch is on only for the JSON boolean true', async () => {
    for (const value of ['true', 1, null, { on: true }]) {
      await setConfig('proactive.season_enabled', value);
      assert.equal(await one(`_proactive_season_enabled()`), false, JSON.stringify(value));
    }
    await t.sql(`delete from app_config where key = 'proactive.season_enabled'`);
    assert.equal(await one(`_proactive_season_enabled()`), false, 'absent');
    await setConfig('proactive.season_enabled', true);
    assert.equal(await one(`_proactive_season_enabled()`), true);
  });

  it('a manual tick with generation off creates nothing, season switch or not', async () => {
    const r = await user('inert');
    const s = await seasonRelease();
    await save(r, s.id);
    await setConfig('proactive.generation_enabled', false);
    await tick(EVENING);
    assert.equal((await candidates(r)).length, 0);
    assert.equal((await inbox(r)).length, 0);
    assert.equal((await t.sql(`select * from push_outbox where recipient_id = $1`, [r])).rows.length, 0);
  });

  it('generation on with the season switch off creates no season row', async () => {
    const r = await user('inert2');
    const s = await seasonRelease();
    await save(r, s.id);
    await setConfig('proactive.season_enabled', false);
    const result = await tick(EVENING);
    assert.equal(result.season_candidates, 0);
    assert.equal((await candidates(r, 'season_premiere')).length, 0);
    assert.equal((await inbox(r)).length, 0);
  });
});

describe('season_premiere: who hears', () => {
  it('saved series, saved season, caught up, and behind-with-a-save; nobody weaker', async () => {
    const s = await seasonRelease();
    const savedSeries = await user('svs');
    await save(savedSeries, s.id);
    const savedSeason = await user('svn');
    await save(savedSeason, s.seasons[3]);
    const caughtUp = await user('cup');
    await logged(caughtUp, s.seasons[2]);
    const behindSaved = await user('bhs');
    await logged(behindSaved, s.seasons[1]);
    await save(behindSaved, s.id);
    const behind = await user('bhd');
    await logged(behind, s.seasons[1]);
    const watchingPrior = await user('wpr');
    await logged(watchingPrior, s.seasons[2], { progress: 'watching' });
    const specialsOnly = await user('spc');
    await logged(specialsOnly, s.seasons[0]);
    const nobody = await user('nob');
    const touched = await user('tch');
    await save(touched, s.id);
    await logged(touched, s.seasons[3], { progress: 'watching' });
    const muted = await user('mut');
    await save(muted, s.id);
    await t.sql(`insert into notification_preferences (user_id, category, enabled) values ($1, 'watchlist_discovery', false)`, [muted]);
    const elsewhere = await user('gb', { region: 'GB' });
    await save(elsewhere, s.id);

    await tick('2031-05-16T15:00:00Z');

    const interest = async (u) => (await candidates(u, 'season_premiere'))[0]?.metadata.interest ?? null;
    assert.equal(await interest(savedSeries), 'watchlist');
    assert.equal(await interest(savedSeason), 'watchlist');
    assert.equal(await interest(caughtUp), 'caught_up');
    assert.equal(await interest(behindSaved), 'watchlist');
    for (const u of [behind, watchingPrior, specialsOnly, nobody, touched, muted, elsewhere]) {
      assert.equal((await candidates(u)).length, 0);
      assert.equal((await inbox(u)).length, 0);
    }
  });

  it('a Season 1 has nobody caught up; only a save counts', async () => {
    const s = await series('Pilot', { 1: RELEASE });
    await track(s.id, 'series');
    await observeSeries(s.id, { 1: RELEASE }, OBSERVED);
    const event = await one(`(select id from release_events where media_item_id = $1)`, [s.seasons[1]]);
    await verify(event);
    const r = await user('s1');
    await save(r, s.id);
    const other = await user('s1n');
    await tick('2031-05-16T15:00:00Z');
    assert.equal((await candidates(r, 'season_premiere')).length, 1);
    assert.equal((await candidates(other)).length, 0);
  });

  it('an unknown region gets the inbox row, which says US, and no push', async () => {
    const s = await seasonRelease();
    const r = await user('unk', { region: null });
    await save(r, s.id);
    await tick('2031-05-16T15:00:00Z');
    const [c] = await candidates(r, 'season_premiere');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'region_unknown');
    const [row] = await inbox(r);
    assert.equal(row.kind, 'season_premiere');
    assert.equal(row.media_item_id, s.seasons[3]);
    assert.equal(row.series_title.startsWith('Severance'), true);
    assert.equal(row.payload.available_on, RELEASE);
    assert.equal(row.payload.region, 'US');
    assert.equal(row.payload.season_number, 3);
  });

  it('interest is checked again at selection: a save removed before the evening suppresses it', async () => {
    const s = await seasonRelease();
    const r = await user('unsv');
    await save(r, s.id);
    await tick('2031-05-16T15:00:00Z');
    await unsave(r, s.id);
    await arbitrate(EVENING);
    const [c] = await candidates(r, 'season_premiere');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'no_season_interest');
  });
});

describe('season_premiere: only what is verified', () => {
  it('a regionless TMDB date alone announces nothing', async () => {
    const s = await seasonRelease({ verified: false });
    const r = await user('nover');
    await save(r, s.id);
    await tick(EVENING);
    assert.equal((await candidates(r)).length, 0);
  });

  it('refuses a verification that is expired, from the future, or for another date', async () => {
    const cases = [
      { verifiedAt: '2031-05-14T12:00:00Z', hours: 24 }, // expired before the tick
      { verifiedAt: '2031-05-16T19:00:00Z', hours: 24 }, // written after the tick's clock
      { availableOn: '2031-05-23' }, // a different date from the release
    ];
    for (const v of cases) {
      const s = await seasonRelease({ verified: false });
      await verify(s.event, v);
      const r = await user('badv');
      await save(r, s.id);
      await tick(EVENING);
      assert.equal((await candidates(r)).length, 0, JSON.stringify(v));
    }
  });

  it('the table refuses a long-lived or non-US verification', async () => {
    const s = await seasonRelease({ verified: false });
    assert.ok(await t.errorFrom(
      `insert into proactive_season_availability values ($1, 'US', $2, $3, $3::timestamptz + interval '49 hours', 'https://x.example')`,
      [s.event, RELEASE, at(OBSERVED)],
    ));
    assert.ok(await t.errorFrom(
      `insert into proactive_season_availability values ($1, 'GB', $2, $3, $3::timestamptz + interval '1 hour', 'https://x.example')`,
      [s.event, RELEASE, at(OBSERVED)],
    ));
    assert.ok(await t.errorFrom(
      `insert into proactive_season_availability values ($1, 'US', $2, $3, $3::timestamptz + interval '1 hour', 'javascript:alert(1)')`,
      [s.event, RELEASE, at(OBSERVED)],
    ));
  });

  it('a stale read announces nothing', async () => {
    const s = await seasonRelease();
    const r = await user('stale');
    await save(r, s.id);
    // 14:00 read, collected at 02:01 the next day: past the 12-hour read age.
    await tick('2031-05-17T02:01:00Z');
    assert.equal((await candidates(r)).length, 0);
  });

  it('a scheduled season whose date has arrived but is unconfirmed is not released', async () => {
    const s = await series('Unconfirmed', { 1: '2022-01-01', 2: RELEASE });
    await track(s.id, 'series');
    // Observed the morning before, ahead of the earliest zone's midnight: still scheduled.
    await observeSeries(s.id, { 1: '2022-01-01', 2: RELEASE }, '2031-05-15T08:00:00Z');
    const e = await one(`(select row_to_json(e) from release_events e where media_item_id = $1)`, [s.seasons[2]]);
    assert.equal(e.state, 'scheduled');
    const r = await user('unconf');
    await save(r, s.id);
    await verify(e.id, { verifiedAt: '2031-05-15T08:00:00Z' });
    await tick('2031-05-15T09:00:00Z');
    assert.equal((await candidates(r)).length, 0);
  });

  it('a date "reached" in the earliest zone still waits for midnight in Los Angeles', async () => {
    // _release_reached counts a date from 14 hours before UTC midnight, so at 12:00 UTC
    // on the 15th the season is released while it is still the 15th in the US.
    const s = await seasonRelease({ observedAt: '2031-05-15T12:00:00Z' });
    assert.equal(await one(`(select state from release_events where id = $1)`, [s.event]), 'released');
    const r = await user('early', { timezone: 'Pacific/Kiritimati' });
    await save(r, s.id);
    // Already the 16th in Kiritimati, still the 15th in Los Angeles: nothing at all, not
    // even the inbox row (Codex re-review, MAJOR).
    await tick('2031-05-15T12:30:00Z');
    assert.equal((await candidates(r)).length, 0);
    assert.equal((await inbox(r)).length, 0);
    // A fresh read before midnight there (the first one is 19 hours old by then).
    await observeSeries(s.id, { 0: '2020-01-01', 1: '2022-02-18', 2: '2025-01-17', 3: RELEASE }, '2031-05-16T06:00:00Z');
    await tick('2031-05-16T06:59:00Z');
    assert.equal((await inbox(r)).length, 0, 'one minute before midnight in Los Angeles');
    // Los Angeles midnight (07:00 UTC): collected and eligible at once.
    await tick('2031-05-16T07:00:00Z');
    const [c] = await candidates(r, 'season_premiere');
    assert.equal(c.eligible_at.toISOString(), '2031-05-16T07:00:00.000Z');
    assert.equal((await inbox(r)).length, 1);
  });

  it('a date moved after release suppresses the candidate and hides the row', async () => {
    const s = await seasonRelease();
    const r = await user('moved');
    await save(r, s.id);
    await tick('2031-05-16T15:00:00Z');
    assert.equal((await inbox(r)).length, 1);
    await observeSeries(s.id, { 1: '2022-02-18', 2: '2025-01-17', 3: '2031-06-20' }, '2031-05-16T16:00:00Z');
    await arbitrate(EVENING);
    const [c] = await candidates(r, 'season_premiere');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'release_changed');
    assert.equal((await inbox(r)).length, 0, 'it no longer says anything true');
  });

  it('a removed verification hides the row and stops the claim; an expired one keeps the row', async () => {
    const s = await seasonRelease();
    const r = await user('rmv');
    await save(r, s.id);
    await tick(EVENING);
    assert.equal((await candidates(r, 'season_premiere'))[0].state, 'selected');
    await t.sql(`delete from proactive_season_availability where release_event_id = $1`, [s.event]);
    assert.equal((await inbox(r)).length, 0);
    assert.equal((await claimFor(r, CLAIM)).length, 0);
    const [c] = await candidates(r, 'season_premiere');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'availability_unverified');

    const s2 = await seasonRelease();
    const r2 = await user('expv');
    await save(r2, s2.id);
    await verify(s2.event, { hours: 5 }); // valid until 19:00
    await tick(EVENING);
    await t.sql(`update proactive_season_availability set verified_at = $2, valid_until = $3 where release_event_id = $1`, [
      s2.event, at('2031-05-14T00:00:00Z'), at('2031-05-15T00:00:00Z'),
    ]);
    assert.equal((await inbox(r2)).length, 1, 'expiry stops delivery, not the dated fact');
  });
});

describe('season_premiere: once, on time', () => {
  it('repeated ticks, a renewed verification and a re-read never make a second', async () => {
    const s = await seasonRelease();
    const r = await user('once');
    await save(r, s.id);
    await tick('2031-05-16T15:00:00Z');
    await verify(s.event, { verifiedAt: '2031-05-16T15:30:00Z' });
    await observeSeries(s.id, { 1: '2022-02-18', 2: '2025-01-17', 3: RELEASE }, '2031-05-16T16:00:00Z');
    await tick('2031-05-16T16:30:00Z');
    await tick(EVENING);
    assert.equal((await candidates(r, 'season_premiere')).length, 1);
    assert.equal((await inbox(r)).length, 1);
  });

  it('is eligible from the start of the date in both the reader\'s zone and Los Angeles', async () => {
    // Observed at 07:30 UTC on the day: 00:30 in Los Angeles, 16:30 in Tokyo.
    const s = await seasonRelease({ observedAt: '2031-05-16T07:30:00Z' });
    const tokyo = await user('tyo', { timezone: 'Asia/Tokyo' });
    await save(tokyo, s.id);
    await tick('2031-05-16T07:45:00Z');
    const [c] = await candidates(tokyo, 'season_premiere');
    assert.equal(c.eligible_at.toISOString(), '2031-05-16T07:45:00.000Z');
    // Before Los Angeles midnight (07:00 UTC) a Tokyo reader, already well into the day,
    // gets nothing; the first tick after it collects them, eligible at that tick.
    const s2 = await seasonRelease({ observedAt: '2031-05-16T05:00:00Z' });
    assert.equal(await one(`(select state from release_events where id = $1)`, [s2.event]), 'released');
    const tokyo2 = await user('tyo2', { timezone: 'Asia/Tokyo' });
    await save(tokyo2, s2.id);
    await tick('2031-05-16T05:10:00Z');
    assert.equal((await candidates(tokyo2)).length, 0);
    await tick('2031-05-16T07:04:00Z');
    const [c2] = await candidates(tokyo2, 'season_premiere');
    assert.equal(c2.eligible_at.toISOString(), '2031-05-16T07:04:00.000Z');
    // A reader west of Los Angeles waits for their own midnight (Honolulu: 10:00 UTC).
    const s3 = await seasonRelease({ observedAt: '2031-05-16T07:30:00Z' });
    const hnl = await user('hnl', { timezone: 'Pacific/Honolulu' });
    await save(hnl, s3.id);
    await tick('2031-05-16T09:59:00Z');
    assert.equal((await candidates(hnl)).length, 0);
    await tick('2031-05-16T10:00:00Z');
    assert.equal((await candidates(hnl, 'season_premiere')).length, 1);
  });

  it('expires at the earliest of +48h, the end of the second local day, and the verification', async () => {
    const s = await seasonRelease();
    const r = await user('exp');
    await save(r, s.id);
    await tick('2031-05-16T15:00:00Z');
    const [c] = await candidates(r, 'season_premiere');
    // verified 14:00 for 24h → 2031-05-17T14:00Z; +48h → 05-18T14:00Z; second day ends 05-18T00:00Z.
    assert.equal(c.expires_at.toISOString(), '2031-05-17T14:00:00.000Z');
  });

  it('is selected in the evening and sent once, to version-2 devices, with its facts and deadline', async () => {
    const s = await seasonRelease();
    const r = await user('send');
    await t.sql(
      `insert into device_tokens (user_id, token, platform, proactive_version) values ($1, $2, 'android', 1)`,
      [r, `ExponentPushToken[${r}-old]`],
    );
    await save(r, s.id);
    await tick(EVENING);
    const jobs = await claimFor(r, CLAIM);
    assert.equal(jobs.length, 1);
    const [job] = jobs;
    assert.equal(job.type, 'season_premiere');
    assert.equal(job.media_item_id, s.seasons[3]);
    assert.equal(job.media_kind, 'season');
    assert.equal(job.proactive.season_number, 3);
    assert.equal(job.proactive.available_on, RELEASE);
    assert.equal(new Date(job.proactive.deliver_by).toISOString(), '2031-05-16T20:00:00.000Z');
    assert.deepEqual(job.tokens.map((x) => x.token), [`ExponentPushToken[${r}-main]`]);
    assert.equal((await claimFor(r, '2031-05-16T18:30:00Z')).length, 0, 'at most once');
    assert.equal((await candidates(r, 'season_premiere'))[0].state, 'sent');
  });

  it('turning the season switch off stops a season already selected for tonight', async () => {
    const s = await seasonRelease();
    const r = await user('swoff');
    await save(r, s.id);
    await tick(EVENING);
    await setConfig('proactive.season_enabled', false);
    assert.equal((await claimFor(r, CLAIM)).length, 0);
    const [c] = await candidates(r, 'season_premiere');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'season_disabled');
  });

  it('a version-1-only reader is held client_unsupported; reactive delivery is unchanged', async () => {
    const s = await seasonRelease();
    const r = await user('v1', { version: 1 });
    await save(r, s.id);
    await tick(EVENING);
    assert.equal((await candidates(r, 'season_premiere'))[0].last_block_reason, 'client_unsupported');
    const actor = await user('v1actor');
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2)`,
      [r, actor],
    );
    const jobs = await claimFor(r, CLAIM);
    assert.deepEqual(jobs.map((j) => j.type), ['follow']);
    assert.equal(jobs[0].tokens.length, 1, 'the old device still gets reactive pushes');
  });
});

describe('arbitration across four types', () => {
  it('a season beats a film on the same evening', async () => {
    const r = await user('svf');
    const film = await movie('Opening', '2031-05-18');
    await track(film, 'movie');
    await observeMovie(film, '2031-05-18', '2031-05-11T06:00:00Z');
    await one(`_release_evaluate($1::timestamptz)`, [at('2031-05-11T06:00:00Z')]);
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [r, film]);
    const s = await seasonRelease({ release: '2031-05-12', observedAt: '2031-05-12T14:00:00Z' });
    await save(r, s.id);
    await tick('2031-05-12T18:00:00Z');
    const byType = Object.fromEntries((await candidates(r)).map((c) => [c.type, c]));
    assert.equal(byType.season_premiere.state, 'selected');
    assert.equal(byType.theatrical_release.state, 'pending');
    assert.equal(byType.theatrical_release.last_block_reason, 'higher_priority_selected');
  });

  it('a saved series beats a caught-up-only season, even when it is younger', async () => {
    const r = await user('svcu');
    const older = await seasonRelease({ observedAt: '2031-05-16T14:00:00Z' });
    await logged(r, older.seasons[2]); // caught up, not saved
    await tick('2031-05-16T15:00:00Z'); // collected, outside the window
    const younger = await seasonRelease({ observedAt: '2031-05-16T16:00:00Z' });
    await save(r, younger.id);
    await tick(EVENING);
    const sel = (await candidates(r, 'season_premiere')).find((c) => c.state === 'selected');
    assert.equal(sel.media_item_id, younger.seasons[3]);
  });

  it('a season and its series share the seven-day title cooldown', async () => {
    const s = await seasonRelease();
    const r = await user('cool');
    await save(r, s.id);
    await t.sql(
      `insert into proactive_candidates
         (recipient_id, type, dedupe_key, media_item_id, priority, state, created_at, eligible_at,
          expires_at, selected_at, selected_local_date, sent_at)
       values ($1, 'watchlist_resurface', 'past', $2, 4, 'sent', $3, $3, $3, $3, '2031-05-13', $3)`,
      [r, s.id, at('2031-05-13T18:00:00Z')],
    );
    await tick(EVENING);
    const [c] = await candidates(r, 'season_premiere');
    assert.equal(c.state, 'pending');
    assert.equal(c.last_block_reason, 'title_cooldown');
  });
});

// ---------------------------------------------------------------------------
// Affinity
// ---------------------------------------------------------------------------

const NOW = '2031-06-01T12:00:00Z';
const daysAgo = (d, iso = NOW) => new Date(new Date(iso).getTime() - d * 86_400_000).toISOString();
const affinity = (r, a, iso = NOW) => one(`_proactive_affinity($1, $2, $3::timestamptz)`, [r, a, at(iso)]);

/** An activity of `owner`'s to talk on. watchlist_added never wakes the social trigger. */
async function post(owner) {
  const m = await movie('Post');
  const { rows } = await t.sql(
    `insert into feed_events (actor_id, type, media_item_id) values ($1, 'watchlist_added', $2) returning id`,
    [owner, m],
  );
  return rows[0].id;
}
const comment = async (author, event, iso, parent = null) =>
  (
    await t.sql(
      `insert into comments (feed_event_id, author_id, body, created_at, parent_id)
       values ($1, $2, 'hi', $3, $4) returning id`,
      [event, author, at(iso), parent],
    )
  ).rows[0].id;

async function pair() {
  const r = await user('aff');
  const a = await user('affa');
  await friends(r, a);
  return { r, a };
}

describe('_proactive_affinity (pinned)', () => {
  it('a mutual follow alone is the weak baseline', async () => {
    const { r, a } = await pair();
    assert.equal(Number(await affinity(r, a)), 0.5);
    assert.equal(Number(await affinity(r, r)), 0);
  });

  it('weights direction: the reader talking counts in full, the friend talking half', async () => {
    const { r, a } = await pair();
    await comment(r, await post(a), NOW);
    assert.equal(Number(await affinity(r, a)), 2.5); // 0.5 + 2
    const { r: r2, a: a2 } = await pair();
    await comment(a2, await post(r2), NOW);
    assert.equal(Number(await affinity(r2, a2)), 1.5); // 0.5 + 0.5 × 2
  });

  it('decays with a 30-day half-life and forgets after 90 days or in the future', async () => {
    const { r, a } = await pair();
    await comment(r, await post(a), daysAgo(30));
    assert.equal(Number(await affinity(r, a)), 1.5); // 0.5 + 2 × ½
    const { r: r2, a: a2 } = await pair();
    await comment(r2, await post(a2), daysAgo(91));
    await comment(r2, await post(a2), daysAgo(-1));
    assert.equal(Number(await affinity(r2, a2)), 0.5);
  });

  it('a reply to the friend\'s comment outranks a comment on their post, once per comment', async () => {
    const { r, a } = await pair();
    const p = await post(a);
    const theirs = await comment(a, p, NOW);
    await comment(r, p, NOW, theirs); // on their post AND a reply to them: 3, not 5
    // in: their comment on their own post is not towards the reader (0); out: 3.
    assert.equal(Number(await affinity(r, a)), 3.5);
  });

  it('caps a repeated act per day and per family', async () => {
    const { r, a } = await pair();
    const p = await post(a);
    for (let i = 0; i < 5; i += 1) await comment(r, p, NOW);
    assert.equal(Number(await affinity(r, a)), 4.5, '10 in one day counts 4');
    for (let d = 1; d <= 3; d += 1) for (let i = 0; i < 3; i += 1) await comment(r, p, daysAgo(d));
    assert.equal(Number(await affinity(r, a)), 6.5, 'the conversation family caps at 6');
  });

  it('reactions are light: half a point a day, one point in all', async () => {
    const { r, a } = await pair();
    for (let i = 0; i < 6; i += 1) {
      await t.sql(`insert into reactions (feed_event_id, user_id, kind, created_at) values ($1, $2, 'love', $3)`, [
        await post(a), r, at(NOW),
      ]);
    }
    assert.equal(Number(await affinity(r, a)), 1.0); // 0.5 + min(1.5, 0.5 a day)
    for (let d = 1; d <= 4; d += 1) {
      await t.sql(`insert into reactions (feed_event_id, user_id, kind, created_at) values ($1, $2, 'love', $3)`, [
        await post(a), r, at(daysAgo(d)),
      ]);
    }
    assert.ok(Number(await affinity(r, a)) <= 1.5, 'the family caps at 1');
  });

  it('adds 2 for reciprocity: both directions, two distinct days each, in 30 days', async () => {
    const { r, a } = await pair();
    const pa = await post(a);
    const pr = await post(r);
    await comment(r, pa, daysAgo(1));
    await comment(r, pa, daysAgo(2));
    await comment(a, pr, daysAgo(1));
    const without = Number(await affinity(r, a));
    await comment(a, pr, daysAgo(2));
    const withIt = Number(await affinity(r, a));
    assert.ok(withIt - without > 2 - 1e-9 && withIt - without < 2 + 1.0, `${without} → ${withIt}`);
  });

  it('counts co-watching once a day, and never another person\'s private diary', async () => {
    const { r, a } = await pair();
    const m = await movie('Cowatch');
    await t.sql(`insert into watch_tags (tagger_id, tagged_id, media_item_id, created_at) values ($1, $2, $3, $4)`, [
      a, r, m, at(NOW),
    ]);
    assert.equal(Number(await affinity(r, a)), 2.0); // 0.5 + 0.5 × 3
    await t.sql(`update watch_tags set removed_by_tagged = true where tagger_id = $1 and tagged_id = $2`, [a, r]);
    assert.equal(Number(await affinity(r, a)), 0.5, 'a removed tag is gone');

    // The friend's own watch, with the reader as a companion: the friend's diary.
    await logged(a, m);
    const w = await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, '2031-06-01', 'reader') returning id`,
      [a, m],
    );
    await t.sql(`insert into watch_event_companions (watch_event_id, companion_id, created_at) values ($1, $2, $3)`, [
      w.rows[0].id, r, at(NOW),
    ]);
    assert.equal(Number(await affinity(r, a)), 0.5);

    // The reader's own watch, with the friend as a companion: counts, as OUT.
    const m2 = await movie('Cowatch2');
    await logged(r, m2);
    const w2 = await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, '2031-06-01', 'reader') returning id`,
      [r, m2],
    );
    await t.sql(`insert into watch_event_companions (watch_event_id, companion_id, created_at) values ($1, $2, $3)`, [
      w2.rows[0].id, a, at(NOW),
    ]);
    assert.equal(Number(await affinity(r, a)), 3.5); // 0.5 + 3
    // A tag for the same title and day is the same co-watch, not a second one.
    await t.sql(`insert into watch_tags (tagger_id, tagged_id, media_item_id, created_at) values ($1, $2, $3, $4)`, [
      r, a, m2, at(NOW),
    ]);
    assert.equal(Number(await affinity(r, a)), 3.5);
  });

  it('a deleted comment and an undelivered recommendation say nothing; a fulfilled one says a lot', async () => {
    const { r, a } = await pair();
    const c = await comment(r, await post(a), NOW);
    await t.sql(`update comments set deleted_at = $2 where id = $1`, [c, at(NOW)]);
    assert.equal(Number(await affinity(r, a)), 0.5);
    const m = await movie('Rec');
    await t.sql(
      `insert into title_recommendations (sender_id, recipient_id, media_item_id, created_at, state)
       values ($1, $2, $3, $4, 'pending')`,
      [r, a, m, at(NOW)],
    );
    assert.equal(Number(await affinity(r, a)), 0.5);
    await t.sql(`update title_recommendations set state = 'delivered', fulfilled_at = $3 where sender_id = $1 and recipient_id = $2`, [
      r, a, at(NOW),
    ]);
    assert.equal(Number(await affinity(r, a)), 5.0); // 0.5 + 3 out + 0.5 × 3 in
  });
});

describe('affinity in the social path', () => {
  async function addAt(reader, actor, m, iso) {
    await setConfig('proactive.generation_enabled', false);
    try {
      const ev = (
        await t.sql(`insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2) returning id`, [
          actor, m,
        ])
      ).rows[0].id;
      return one(`_proactive_social_add($1, $2, $3, $4, $5::timestamptz)`, [reader, actor, m, ev, at(iso)]);
    } finally {
      await setConfig('proactive.generation_enabled', true);
    }
  }
  async function clusterOf(reader, m, n, iso) {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const f = await user(`c${i}_`);
      await friends(reader, f);
      await addAt(reader, f, m, iso);
      out.push(f);
    }
    return out;
  }

  it('the cluster with the closer friends wins the evening, though it is younger', async () => {
    const r = await user('soc');
    const older = await movie('Older');
    const closer = await movie('Closer');
    await save(r, older);
    await save(r, closer);
    await clusterOf(r, older, 2, '2031-03-03T10:00:00Z');
    const close = await clusterOf(r, closer, 2, '2031-03-03T11:00:00Z');
    for (const f of close) await comment(r, await post(f), '2031-03-02T12:00:00Z');
    await arbitrate('2031-03-03T18:00:00Z');
    const sel = (await candidates(r, 'watchlist_social')).find((c) => c.state === 'selected');
    assert.equal(sel.media_item_id, closer);
  });

  it('equal (zero) affinity falls back to the older cluster', async () => {
    const r = await user('socq');
    const older = await movie('Older');
    const younger = await movie('Younger');
    await save(r, older);
    await save(r, younger);
    await clusterOf(r, older, 2, '2031-03-03T10:00:00Z');
    await clusterOf(r, younger, 2, '2031-03-03T11:00:00Z');
    await arbitrate('2031-03-03T18:00:00Z');
    const sel = (await candidates(r, 'watchlist_social')).find((c) => c.state === 'selected');
    assert.equal(sel.media_item_id, older);
  });

  it('names the strongest two and counts everybody, in the push and the inbox', async () => {
    const r = await user('names');
    const m = await movie('Named');
    await save(r, m);
    const first = (await clusterOf(r, m, 1, '2031-03-03T10:00:00Z'))[0];
    const second = (await clusterOf(r, m, 1, '2031-03-03T10:10:00Z'))[0];
    const third = (await clusterOf(r, m, 1, '2031-03-03T10:20:00Z'))[0];
    await comment(r, await post(third), '2031-03-03T09:00:00Z');
    const nameOf = async (u) => one(`(select username::text from profiles where id = $1)`, [u]);

    // The inbox is read at the real clock; the comment is in 2031, so affinity there is
    // read against a clock before it. Read it through the ranked function directly too.
    const ranked = (
      await t.sql(
        `select actor_id from _proactive_ranked_social_actors(
           (select id from proactive_candidates where recipient_id = $1 and type = 'watchlist_social'), $1, $2::timestamptz)
         order by rn`,
        [r, at('2031-03-03T18:00:00Z')],
      )
    ).rows.map((x) => x.actor_id);
    assert.deepEqual(ranked, [third, first, second]);

    await arbitrate('2031-03-03T18:00:00Z');
    const [job] = await claimFor(r, '2031-03-03T18:05:00Z');
    assert.deepEqual(job.proactive.actor_names, [await nameOf(third), await nameOf(first)]);
    assert.equal(job.proactive.actor_count, 3);
    assert.equal(JSON.stringify(job).includes('affinity'), false, 'no score leaves the database');
  });
});

describe('privacy of the new internals', () => {
  it('no client can execute the scoring or read the verification', async () => {
    const u = await user('priv');
    const a = await user('priva');
    for (const q of [
      [`select _proactive_affinity($1, $2, now())`, [u, a]],
      [`select * from _proactive_ranked_social_actors(gen_random_uuid(), $1, now())`, [u]],
      [`select _proactive_season_interest($1, gen_random_uuid())`, [u]],
      [`select _proactive_season_collect(now())`, null],
      [`select * from proactive_season_availability`, null],
    ]) {
      const err = await t.asUser(u, () => t.errorFrom(q[0], q[1] ?? undefined));
      assert.ok(err, q[0]);
      assert.match(err.message, /permission denied/, q[0]);
    }
  });

  it('the inbox row carries no score', async () => {
    const s = await seasonRelease();
    const r = await user('noscore', { region: null });
    await save(r, s.id);
    await tick('2031-05-16T15:00:00Z');
    const rows = await inbox(r);
    assert.equal(JSON.stringify(rows).includes('affinity'), false);
  });
});

describe('the social writer takes one qualifying event per transaction', () => {
  it('a second qualifying event in the same transaction joins nothing; the write succeeds', async () => {
    const r = await user('guard');
    const a = await user('guarda');
    await friends(r, a);
    const m1 = await movie('First');
    const m2 = await movie('Second');
    await save(r, m1);
    await save(r, m2);
    await t.exec(`
      do $$
      begin
        insert into feed_events (actor_id, type, media_item_id) values ('${a}', 'title_ranked', '${m1}');
        insert into feed_events (actor_id, type, media_item_id) values ('${a}', 'title_ranked', '${m2}');
      end;
      $$;
    `);
    const titles = (await candidates(r, 'watchlist_social')).map((c) => c.media_item_id);
    assert.deepEqual(titles, [m1]);
    const written = await one(`(select count(*)::integer from feed_events where actor_id = $1 and type = 'title_ranked')`, [a]);
    assert.equal(written, 2);

    // A later transaction starts clean.
    const m3 = await movie('Third');
    await save(r, m3);
    await t.sql(`insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2)`, [a, m3]);
    assert.equal((await candidates(r, 'watchlist_social')).length, 2);
  });
});

describe('release_status', () => {
  it('an authorised season row is healthy; an unlinked one is the leak', async () => {
    const s = await seasonRelease();
    const r = await user('rs');
    await save(r, s.id);
    await tick(EVENING);
    let status = await one(`release_status()`);
    assert.equal(status.release_notifications, 0);
    assert.equal(status.problems.includes('release_notifications_exist'), false);
    await setConfig('proactive.season_enabled', false);
    status = await one(`release_status()`);
    assert.equal(status.release_notifications, 0, 'history is not a leak');

    await t.sql(
      `insert into notifications (recipient_id, type, subject_type, subject_id, payload)
       values ($1, 'season_premiere', 'media_item', $2, '{}')`,
      [r, s.seasons[3]],
    );
    status = await one(`release_status()`);
    assert.equal(status.release_notifications, 1);
    assert.ok(status.problems.includes('release_notifications_exist'));
    await t.sql(`delete from notifications where type = 'season_premiere' and payload = '{}'::jsonb`);
  });
});

// ===========================================================================
// Codex re-review (2026-10-31): the reproduced defects, and the rest of the matrix
// ===========================================================================

describe('season_premiere: predecessor, interest and release changes (Codex re-review)', () => {
  it('a predecessor missing from the catalogue makes nobody caught up; a save still counts', async () => {
    // TMDB lists Seasons 1, 2 and 3; our catalogue never fetched Season 2.
    const s = await series('Gap', { 1: '2022-02-18', 3: RELEASE });
    await track(s.id, 'series');
    await observeSeries(s.id, { 1: '2022-02-18', 2: '2025-01-17', 3: RELEASE }, OBSERVED);
    const event = await one(`(select id from release_events where media_item_id = $1)`, [s.seasons[3]]);
    await verify(event);
    const s1Only = await user('gap1');
    await logged(s1Only, s.seasons[1]);
    const saved = await user('gapsv');
    await logged(saved, s.seasons[1]);
    await save(saved, s.id);
    await tick(EVENING);
    assert.equal((await candidates(s1Only)).length, 0, 'Season 1 is not the season before Season 3');
    assert.equal(await one(`_proactive_season_interest($1, $2)`, [s1Only, event]), null);
    assert.equal((await candidates(saved, 'season_premiere'))[0].metadata.interest, 'watchlist');
  });

  it('a save removed after selection stops the claim', async () => {
    const s = await seasonRelease();
    const r = await user('unclaim');
    await save(r, s.id);
    await tick(EVENING);
    assert.equal((await candidates(r, 'season_premiere'))[0].state, 'selected');
    await unsave(r, s.id);
    assert.equal((await claimFor(r, CLAIM)).length, 0);
    const [c] = await candidates(r, 'season_premiere');
    assert.deepEqual([c.state, c.suppression_reason], ['suppressed', 'no_season_interest']);
  });

  it('a series cancelled, a season gone from the listing, or a date cleared, all suppress', async () => {
    const cases = [
      ['cancelled', (s) => observeSeries(s.id, { 1: '2022-02-18', 2: '2025-01-17', 3: RELEASE }, '2031-05-16T16:00:00Z', { status: 'Canceled' })],
      ['gone', (s) => observeSeries(s.id, { 1: '2022-02-18', 2: '2025-01-17' }, '2031-05-16T16:00:00Z')],
      ['cleared', (s) => observeSeries(s.id, { 1: '2022-02-18', 2: '2025-01-17', 3: null }, '2031-05-16T16:00:00Z')],
    ];
    for (const [label, change] of cases) {
      const s = await seasonRelease();
      const r = await user(`chg${label}`.slice(0, 12));
      await save(r, s.id);
      await tick('2031-05-16T15:00:00Z');
      await change(s);
      await arbitrate(EVENING);
      const [c] = await candidates(r, 'season_premiere');
      assert.deepEqual([c.state, c.suppression_reason], ['suppressed', 'release_changed'], label);
    }
  });

  it('a cleared date also hides the inbox row', async () => {
    const s = await seasonRelease();
    const r = await user('clrrow');
    await save(r, s.id);
    await tick('2031-05-16T15:00:00Z');
    assert.equal((await inbox(r)).length, 1);
    await observeSeries(s.id, { 1: '2022-02-18', 2: '2025-01-17', 3: null }, '2031-05-16T16:00:00Z');
    assert.equal((await inbox(r)).length, 0);
  });
});

describe('season_premiere: exact clocks (Codex re-review)', () => {
  it('collects up to, and not at, 48 hours after the release was confirmed', async () => {
    for (const [iso, expected] of [['2031-05-18T13:59:00Z', 1], ['2031-05-18T14:00:00Z', 0]]) {
      const s = await seasonRelease({ verified: false });
      // A fresh read and a fresh verification two days on; the confirmation stays 05-16 14:00.
      await observeSeries(s.id, { 1: '2022-02-18', 2: '2025-01-17', 3: RELEASE }, '2031-05-18T13:00:00Z');
      await verify(s.event, { verifiedAt: '2031-05-18T13:00:00Z' });
      const r = await user('b48');
      await save(r, s.id);
      await tick(iso);
      assert.equal((await candidates(r, 'season_premiere')).length, expected, iso);
    }
  });

  it('each expiry bound can be the one that binds', async () => {
    // +48h from confirmation binds: confirmed early (05-15 12:00 UTC), verified for 48h.
    const a = await seasonRelease({ observedAt: '2031-05-15T12:00:00Z', verified: false });
    await verify(a.event, { verifiedAt: '2031-05-16T07:30:00Z', hours: 48 });
    await observeSeries(a.id, { 1: '2022-02-18', 2: '2025-01-17', 3: RELEASE }, '2031-05-16T07:30:00Z');
    const ra = await user('bnd48');
    await save(ra, a.id);
    await tick('2031-05-16T08:00:00Z');
    assert.equal((await candidates(ra, 'season_premiere'))[0].expires_at.toISOString(), '2031-05-17T12:00:00.000Z');

    // The end of the reader's second local day binds: Kiritimati (UTC+14) ends it at 10:00 UTC on the 17th.
    const b = await seasonRelease({ verified: false });
    await verify(b.event, { hours: 48 });
    const rb = await user('bndday', { timezone: 'Pacific/Kiritimati' });
    await save(rb, b.id);
    await tick('2031-05-16T15:00:00Z');
    assert.equal((await candidates(rb, 'season_premiere'))[0].expires_at.toISOString(), '2031-05-17T10:00:00.000Z');
  });

  it('counts the second local day in the reader\'s zone across a DST change', async () => {
    // US clocks spring forward on 2031-03-09; the second day ends at 00:00 EDT on 03-11 = 04:00 UTC.
    const s = await seasonRelease({ release: '2031-03-09', observedAt: '2031-03-09T14:00:00Z', verified: false });
    await verify(s.event, { availableOn: '2031-03-09', verifiedAt: '2031-03-09T14:00:00Z', hours: 48 });
    const r = await user('dst', { timezone: 'America/New_York' });
    await save(r, s.id);
    await tick('2031-03-09T15:00:00Z');
    assert.equal((await candidates(r, 'season_premiere'))[0].expires_at.toISOString(), '2031-03-11T04:00:00.000Z');
  });
});

describe('arbitration: seasons against the other types (Codex re-review)', () => {
  async function socialCluster(reader, m, iso) {
    await setConfig('proactive.generation_enabled', false);
    try {
      for (let i = 0; i < 2; i += 1) {
        const f = await user(`sx${i}_`);
        await friends(reader, f);
        const ev = (
          await t.sql(`insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2) returning id`, [f, m])
        ).rows[0].id;
        await one(`_proactive_social_add($1, $2, $3, $4, $5::timestamptz)`, [reader, f, m, ev, at(iso)]);
      }
    } finally {
      await setConfig('proactive.generation_enabled', true);
    }
  }

  it('a season beats an older social cluster the same evening', async () => {
    const r = await user('svsoc');
    const film = await movie('Social');
    await save(r, film);
    await socialCluster(r, film, '2031-05-16T09:00:00Z');
    const s = await seasonRelease();
    await save(r, s.id);
    await tick(EVENING);
    const byType = Object.fromEntries((await candidates(r)).map((c) => [c.type, c]));
    assert.equal(byType.season_premiere.state, 'selected');
    assert.equal(byType.watchlist_social.last_block_reason, 'higher_priority_selected');
  });

  it('equal configured priorities fall back to the canonical type order', async () => {
    await setConfig('proactive.priority', {
      season_premiere: 1, theatrical_release: 1, watchlist_social: 1, watchlist_resurface: 1,
    });
    try {
      const r = await user('eqpri');
      const film = await movie('Social2');
      await save(r, film);
      await socialCluster(r, film, '2031-05-16T09:00:00Z');
      const s = await seasonRelease();
      await save(r, s.id);
      await tick(EVENING);
      const sel = (await candidates(r)).find((c) => c.state === 'selected');
      assert.equal(sel.type, 'season_premiere');
    } finally {
      await setConfig('proactive.priority', {
        season_premiere: 1, theatrical_release: 2, watchlist_social: 3, watchlist_resurface: 4,
      });
    }
  });
});

describe('_proactive_affinity: the rest of the weights, and visibility (Codex re-review)', () => {
  it('an active mention counts 2, and an inactive one nothing', async () => {
    const { r, a } = await pair();
    const third = await user('aff3');
    const c = await comment(r, await post(third), NOW);
    await t.sql(`insert into comment_mentions (comment_id, mentioned_id, active) values ($1, $2, true)`, [c, a]);
    assert.equal(Number(await affinity(r, a)), 2.5);
    await t.sql(`update comment_mentions set active = false where comment_id = $1`, [c]);
    assert.equal(Number(await affinity(r, a)), 0.5);
  });

  it('opening a recommendation is the light response, and a re-send adds nothing', async () => {
    const { r, a } = await pair();
    const m = await movie('Opened');
    await t.sql(
      `insert into title_recommendations (sender_id, recipient_id, media_item_id, created_at, recommended_at, opened_at, state)
       values ($1, $2, $3, $4, $4, $4, 'delivered')`,
      [a, r, m, at(NOW)],
    );
    // in: 0.5 × 3 for the send; out: 1 for the reader opening it.
    assert.equal(Number(await affinity(r, a)), 3.0);
    await t.sql(`update title_recommendations set recommended_at = $3 where sender_id = $1 and recipient_id = $2`, [
      a, r, at(NOW),
    ]);
    assert.equal(Number(await affinity(r, a)), 3.0, 'recommended again: still one send');
  });

  it('forgets a reaction on a comment once the activity under it is no longer viewable', async () => {
    const { r, a } = await pair();
    const third = await user('affpriv');
    const c = await comment(a, await post(third), NOW);
    await t.sql(`insert into comment_reactions (comment_id, user_id, kind, created_at) values ($1, $2, 'love', $3)`, [
      c, r, at(NOW),
    ]);
    assert.equal(Number(await affinity(r, a)), 0.75);
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [third]);
    assert.equal(Number(await affinity(r, a)), 0.5, 'a private owner the reader does not follow');
  });

  it('forgets a comment on an activity whose owner has since blocked the reader', async () => {
    const { r, a } = await pair();
    const third = await user('affblk');
    await comment(r, await post(third), NOW, null);
    // The reader's comment on a third person's post is not towards the friend at all…
    const p = await post(third);
    const theirs = await comment(a, p, NOW);
    await comment(r, p, NOW, theirs); // …but a reply to the friend's comment there is (3).
    assert.equal(Number(await affinity(r, a)), 3.5);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [third, r]);
    assert.equal(Number(await affinity(r, a)), 0.5);
  });
});

describe('release_status: a misrouted season row is a leak (Codex re-review)', () => {
  it('a season row moved to another recipient is counted', async () => {
    const s = await seasonRelease();
    const r = await user('mis');
    const other = await user('misx');
    await save(r, s.id);
    await tick(EVENING);
    assert.equal((await one(`release_status()`)).release_notifications, 0);
    await t.sql(`update notifications set recipient_id = $2 where recipient_id = $1 and type = 'season_premiere'`, [r, other]);
    const status = await one(`release_status()`);
    assert.ok(status.release_notifications >= 1);
    assert.ok(status.release_push_outbox >= 1, 'its queued push is to somebody else now');
    assert.ok(status.problems.includes('release_notifications_exist'));
    await t.sql(`update notifications set recipient_id = $1 where recipient_id = $2 and type = 'season_premiere'`, [r, other]);
    assert.equal((await one(`release_status()`)).release_notifications, 0);
  });
});
