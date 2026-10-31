import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Proactive notifications: 20261028000100 (ledger, arbiter, kill switch, claim, inbox)
 * and 20261028000200 (watchlist_social, theatrical_release, watchlist_resurface).
 *
 * Every arbiter call takes an explicit clock. Most fixtures live in 2031 so nothing
 * depends on the day the suite runs; the few tests that go through the real
 * feed_events trigger use the real clock, because the trigger reads now().
 *
 * The founder's rules being pinned (docs/product/proactive-notifications.md):
 *   · one proactive push per recipient per local day, two per rolling seven days;
 *   · the same type not again inside 72 hours (resurfacing: seven days), the same title
 *     not again inside seven days; reactive pushes consume none of it;
 *   · priority theatrical_release > watchlist_social > watchlist_resurface, and losers
 *     are not queued;
 *   · 17:00-20:00 local; unknown timezone means no proactive push;
 *   · watchlist_social: one inbox row per fixed seven-day window, push-eligible at the
 *     second distinct friend, at most one push, copy counted at send time;
 *   · theatrical: once per release, T-7, never on the day;
 *   · resurfacing: push only, hidden from the inbox, once a week at most;
 *   · proactive.push_enabled = false stops proactive delivery and nothing else.
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

/**
 * A reader. `version` is the proactive version of the build that registered their one
 * device (null: a build that predates proactive kinds).
 */
async function user(name, { timezone = 'UTC', region = 'US', device = true, version = 2 } = {}) {
  const id = await t.createUser({ username: `${name}${(seq += 1)}`.slice(0, 20) });
  if (timezone !== undefined || region !== undefined) {
    await t.sql(`insert into account_context (user_id, timezone, region) values ($1, $2, $3)`, [
      id,
      timezone,
      region,
    ]);
  }
  if (device) await addDevice(id, 'main', version);
  return id;
}

/** Another device on the same account, from a build of the given proactive version. */
async function addDevice(u, label, version = 2, platform = 'ios') {
  const token = `ExponentPushToken[${u}-${label}]`;
  await t.sql(
    `insert into device_tokens (user_id, token, platform, proactive_version) values ($1, $2, $3, $4)`,
    [u, token, platform, version],
  );
  return token;
}

async function movie(title, releaseDate = '2020-01-01') {
  seq += 1;
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, release_date, provenance)
     values ('movie', $1, $2, $3, 'tmdb') returning id`,
    [1_800_000_000 + seq, `${title} ${seq}`, releaseDate],
  );
  return rows[0].id;
}

const follow = (a, b) =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, 'approved', now()) on conflict do nothing`,
    [a, b],
  );
const friends = async (a, b) => {
  await follow(a, b);
  await follow(b, a);
};

const save = (u, m, savedAt = '2030-01-01T00:00:00Z') =>
  t.sql(`insert into watchlist (user_id, media_item_id, created_at) values ($1, $2, $3)`, [
    u,
    m,
    savedAt,
  ]);
const unsave = (u, m) => t.sql(`delete from watchlist where user_id = $1 and media_item_id = $2`, [u, m]);
const markWatched = (u, m) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')
     on conflict (user_id, media_item_id) do update set bucket = 'loved'`,
    [u, m],
  );

/** A feed event written now, which is what the trigger sees. */
const activity = async (actor, m, type = 'title_ranked') =>
  (
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id) values ($1, $2, $3) returning id`,
      [actor, type, m],
    )
  ).rows[0]?.id ?? null;

/**
 * A feed event the trigger ignores (generation off), then the cluster add called with an
 * explicit clock. The way to test windows without waiting seven real days.
 */
async function addAt(reader, actor, m, iso) {
  await setConfig('proactive.generation_enabled', false);
  try {
    const ev = await activity(actor, m);
    return one(`_proactive_social_add($1, $2, $3, $4, $5::timestamptz)`, [reader, actor, m, ev, at(iso)]);
  } finally {
    await setConfig('proactive.generation_enabled', true);
  }
}

const arbitrate = (iso) => one(`_proactive_arbitrate($1::timestamptz)`, [at(iso)]);
const tick = (iso) => one(`_proactive_tick($1::timestamptz)`, [at(iso)]);

const candidates = async (u, type = null) =>
  (
    await t.sql(
      `select * from proactive_candidates
        where recipient_id = $1 and ($2::text is null or type = $2)
        order by created_at, id`,
      [u, type],
    )
  ).rows;

const outboxFor = async (u) =>
  (await t.sql(`select * from push_outbox where recipient_id = $1`, [u])).rows;

const inbox = async (u) => {
  await t.actAs(u);
  try {
    return (await t.sql(`select * from my_notifications(200)`)).rows;
  } finally {
    await t.actAs(null);
  }
};

/**
 * Claims everything queued and returns the jobs for one recipient's notifications.
 *
 * `iso` is the instant proactive timeliness is judged at (claim_push_batch's p_now). A
 * test that expects a proactive job to be sent passes a time inside the evening it was
 * selected for; with none, the real clock decides, which is right for reactive jobs and
 * for anything that must be dropped whatever the hour.
 */
async function claimFor(u, iso = null) {
  const jobs = [];
  for (let i = 0; i < 10; i += 1) {
    const batch = iso
      ? await one(`claim_push_batch(100, $1::timestamptz)`, [at(iso)])
      : await one(`claim_push_batch(100)`);
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
const observeMovie = (id, theatrical, now, { readAt = now, status = 'Post Production' } = {}) =>
  one(`release_observe($1::jsonb, $2::timestamptz)`, [
    JSON.stringify({
      media_item_id: id,
      kind: 'movie',
      status,
      read_at: at(readAt),
      regions: [{ region: 'US', theatrical, limited: null, digital: null, premiere: null }],
    }),
    at(now),
  ]);
const evaluate = (iso) => one(`_release_evaluate($1::timestamptz)`, [at(iso)]);

/** A film that opens on `opens`, armed (T-7) and evaluated at `armAt`. */
async function armedFilm(title, opens = '2031-05-16', armAt = '2031-05-09T06:00:00Z') {
  const m = await movie(title, opens);
  await track(m, 'movie');
  await observeMovie(m, opens, armAt);
  await evaluate(armAt);
  return m;
}

/** A cluster of `n` mutual friends who all watched `m`, joined at `iso`. */
async function cluster(reader, m, n, iso = '2031-03-03T12:00:00Z') {
  for (let i = 0; i < n; i += 1) {
    const f = await user(`fr${i}_`);
    await friends(reader, f);
    await addAt(reader, f, m, iso);
  }
}

before(async () => {
  t = await createTestDb();
  await setConfig('proactive.push_enabled', true);
});

after(async () => t.close());

beforeEach(async () => {
  await setConfig('proactive.push_enabled', true);
  await setConfig('proactive.generation_enabled', true);
  await setConfig('proactive.resurface_enabled', true);
});

// ===========================================================================

describe('configuration and preferences', () => {
  it('ships with the kill switch OFF and the founder policy in one place', async () => {
    const fresh = await createTestDb();
    try {
      const { rows } = await fresh.sql(
        `select key, value from app_config where key like 'proactive.%' order by key`,
      );
      const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      assert.equal(cfg['proactive.push_enabled'], false, 'nothing proactive may send on deploy');
      assert.equal(
        cfg['proactive.generation_enabled'],
        false,
        'nothing proactive may even be generated on deploy',
      );
      assert.equal(cfg['proactive.resurface_enabled'], false, 'resurfacing has its own gate, off');
      assert.equal(cfg['proactive.window_start_hour'], 17);
      assert.equal(cfg['proactive.window_end_hour'], 20);
      assert.equal(cfg['proactive.daily_cap'], 1);
      assert.equal(cfg['proactive.weekly_cap'], 2);
      assert.equal(cfg['proactive.type_cooldown_hours'], 72);
      assert.equal(cfg['proactive.title_cooldown_days'], 7);
      assert.equal(cfg['proactive.resurface_cooldown_days'], 7);
      // 20261031000100: four types, seasons first.
      assert.deepEqual(cfg['proactive.priority'], {
        season_premiere: 1,
        theatrical_release: 2,
        watchlist_social: 3,
        watchlist_resurface: 4,
      });
    } finally {
      await fresh.close();
    }
  });

  it('adds exactly one category, default on, and leaves the other eight as they were', async () => {
    const u = await user('pref');
    await t.actAs(u);
    const { rows } = await t.sql(
      `select category, enabled from my_notification_preferences() order by category`,
    );
    await t.actAs(null);
    assert.deepEqual(
      rows.map((r) => r.category),
      [
        'awards', 'comments', 'follow_accepted', 'follows', 'invites', 'reactions',
        'recommendations', 'watch_tags', 'watchlist_discovery',
      ],
    );
    // Reactions alone default off since 20261031000100 (founder, 2026-10-31).
    for (const row of rows) assert.equal(row.enabled, row.category !== 'reactions', row.category);
  });

  it('leaves reactive push eligibility exactly as it was, and no proactive type in it', async () => {
    const { rows } = await t.sql(
      `select type, _push_eligible(type) as eligible from unnest(array[
         'follow','follow_request','follow_approved','friendship','comment','mention','reaction',
         'watch_tag','recommendation','recommendation_ranked','invite_activated','invite_joined',
         'invite_welcome','award_earned','goal_completed','import_started','import_completed',
         'import_failed','watchlist_social','theatrical_release','watchlist_resurface'
       ]) as type`,
    );
    const eligible = rows.filter((r) => r.eligible).map((r) => r.type);
    assert.deepEqual(eligible, [
      'follow', 'follow_request', 'comment', 'mention', 'reaction', 'watch_tag',
      'recommendation', 'recommendation_ranked', 'invite_activated', 'invite_joined',
      'award_earned', 'goal_completed', 'import_started', 'import_completed', 'import_failed',
    ]);
  });

  it('the Watchlist & discovery switch gates all three types at creation', async () => {
    const u = await user('prefoff');
    const f = await user('preff');
    await friends(u, f);
    const m = await movie('Muted');
    await save(u, m);
    await t.sql(
      `insert into notification_preferences (user_id, category, enabled) values ($1, 'watchlist_discovery', false)`,
      [u],
    );
    await addAt(u, f, m, '2031-03-03T12:00:00Z');
    // Muted means untouched: not even a suppressed placeholder that could later be reused.
    assert.equal((await candidates(u)).length, 0);
    assert.equal((await inbox(u)).length, 0, 'switched off means no inbox row either');
  });

  it('register_device_token records each build on its own token, and an old call still works', async () => {
    const u = await user('reg', { device: false });
    const token = `ExponentPushToken[reg-${u}]`;
    const version = async () =>
      (await t.sql(`select proactive_version from device_tokens where token = $1`, [token])).rows[0]
        .proactive_version;

    await t.actAs(u);
    try {
      // The three-argument call every shipped build makes.
      await t.sql(`select register_device_token(gen_random_uuid(), $1, 'ios')`, [token]);
      assert.equal(await version(), null, 'an old build is no claim of capability');
      await t.sql(`select register_device_token(gen_random_uuid(), $1, 'ios', 1)`, [token]);
      assert.equal(await version(), 1);
      // The same installation going back to an old build turns that one device off again.
      await t.sql(`select register_device_token(gen_random_uuid(), $1, 'ios')`, [token]);
      assert.equal(await version(), null, 'latest registration wins, per token');
      await t.sql(`select register_device_token(gen_random_uuid(), $1, 'ios', 9999)`, [token]);
      assert.equal(await version(), null, 'an out-of-range claim is no claim');
    } finally {
      await t.actAs(null);
    }
  });

  it('report_device_context is exactly as it was: two arguments, no capability', async () => {
    const { rows } = await t.sql(
      `select p.oid::regprocedure::text as sig from pg_proc p where p.proname = 'report_device_context'`,
    );
    assert.deepEqual(rows.map((r) => r.sig), ['report_device_context(text,text)']);
  });
});

// ===========================================================================

describe('the generation switch (seeded off)', () => {
  it('off: no social inbox row, no theatrical row, no resurfacing, no candidate at all', async () => {
    await setConfig('proactive.generation_enabled', false);
    const r = await user('genoff');
    const f = await user('genofff');
    await friends(r, f);
    const m = await movie('Generation Off');
    await save(r, m, '2029-01-01T00:00:00Z');
    const film = await armedFilm('Generation Off Film');
    await save(r, film);

    await activity(f, m, 'title_ranked');
    await tick('2031-05-09T17:30:00Z');
    await tick('2031-07-07T17:05:00Z');

    assert.equal((await candidates(r)).length, 0);
    assert.equal(
      (await inbox(r)).filter((n) => ['watchlist_social', 'theatrical_release'].includes(n.kind)).length,
      0,
    );
    assert.equal(await one(`(proactive_status() ->> 'generation_enabled')::boolean`), false);
  });

  it('is fail-closed: a malformed value is off', async () => {
    await setConfig('proactive.generation_enabled', 'yes');
    assert.equal(await one(`_proactive_generation_enabled()`), false);
    const r = await user('genbad');
    const f = await user('genbadf');
    await friends(r, f);
    const m = await movie('Malformed');
    await save(r, m);
    await activity(f, m);
    assert.equal((await candidates(r)).length, 0);
  });

  it('off: reactive notifications are written and queued exactly as before', async () => {
    await setConfig('proactive.generation_enabled', false);
    const r = await user('genreac');
    const f = await user('genreacf');
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2)`,
      [r, f],
    );
    assert.equal((await outboxFor(r)).length, 1);
    const jobs = await claimFor(r);
    assert.deepEqual(jobs.map((j) => j.type), ['follow']);
  });

  it('on: the same activity creates its cluster', async () => {
    await setConfig('proactive.generation_enabled', true);
    const r = await user('genon');
    const f = await user('genonf');
    await friends(r, f);
    const m = await movie('Generation On');
    await save(r, m);
    await activity(f, m);
    assert.equal((await candidates(r, 'watchlist_social')).length, 1);
  });
});

// ===========================================================================

describe('Watchlist & discovery transitions (Codex review)', () => {
  const setPref = (u, on) =>
    t.sql(
      `insert into notification_preferences (user_id, category, enabled)
       values ($1, 'watchlist_discovery', $2)
       on conflict (user_id, category) do update set enabled = excluded.enabled`,
      [u, on],
    );

  it('A: muted with a cluster open, a later friend neither bumps the row nor makes it unread', async () => {
    const r = await user('tra');
    const [a, b] = [await user('traa'), await user('trab')];
    await friends(r, a);
    await friends(r, b);
    const m = await movie('Transition A');
    await save(r, m);
    await addAt(r, a, m, '2031-04-07T09:00:00Z');
    const [c] = await candidates(r, 'watchlist_social');
    await t.sql(`update notifications set read_at = '2031-04-07T10:00:00Z' where id = $1`, [c.notification_id]);
    const before = (await t.sql(`select created_at, read_at from notifications where id = $1`, [c.notification_id])).rows[0];

    await setPref(r, false);
    await addAt(r, b, m, '2031-04-08T09:00:00Z');

    const after = (await t.sql(`select created_at, read_at from notifications where id = $1`, [c.notification_id])).rows[0];
    assert.deepEqual(after, before, 'no bump, no unread');
    const { rows } = await t.sql(
      `select count(distinct actor_id)::int people from proactive_cluster_actors where candidate_id = $1`,
      [c.id],
    );
    assert.equal(rows[0].people, 1, 'the muted-time friend was not recorded');
    const [still] = await candidates(r, 'watchlist_social');
    assert.equal(still.eligible_at, null, 'and so could not make it push-eligible');
  });

  it('B: muted activity leaves no history; after re-enabling, the next fresh activity starts a fresh cluster', async () => {
    const r = await user('trb');
    const [a, b, c2] = [await user('trba'), await user('trbb'), await user('trbc')];
    for (const f of [a, b, c2]) await friends(r, f);
    const m = await movie('Transition B');
    await save(r, m);

    await setPref(r, false);
    await addAt(r, a, m, '2031-04-14T09:00:00Z');
    assert.equal((await candidates(r)).length, 0, 'nothing recorded while muted');

    await setPref(r, true);
    await addAt(r, b, m, '2031-04-15T09:00:00Z');
    let cs = await candidates(r, 'watchlist_social');
    assert.equal(cs.length, 1, 'a fresh cluster');
    assert.equal(cs[0].state, 'pending');
    assert.ok(cs[0].notification_id);
    assert.equal(cs[0].eligible_at, null, 'the muted-time friend is not resurrected toward the threshold');

    await addAt(r, c2, m, '2031-04-15T10:00:00Z');
    cs = await candidates(r, 'watchlist_social');
    assert.ok(cs[0].eligible_at, 'two fresh friends make it eligible, normally');
    const row = (await inbox(r)).find((n) => n.kind === 'watchlist_social');
    assert.equal(row.cluster_count, 2);
  });

  it('B2: a cluster the arbiter ended for the preference is not reused after re-enabling', async () => {
    const r = await user('trb2');
    const m = await movie('Transition B2');
    await save(r, m);
    await cluster(r, m, 2, '2031-04-21T09:00:00Z');
    await setPref(r, false);
    await arbitrate('2031-04-21T17:30:00Z');
    let [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.suppression_reason, 'preference_off');

    await setPref(r, true);
    await cluster(r, m, 2, '2031-04-22T09:00:00Z');
    const cs = await candidates(r, 'watchlist_social');
    assert.equal(cs.length, 2, 'a new cluster rather than the dead one');
    c = cs.at(-1);
    assert.equal(c.state, 'pending');
    assert.ok(c.eligible_at);
    await arbitrate('2031-04-22T17:30:00Z');
    assert.equal((await candidates(r, 'watchlist_social')).at(-1).state, 'selected');
  });

  it('C: switching Watchlist & discovery off touches no other category', async () => {
    const r = await user('trc');
    const f = await user('trcf');
    await setPref(r, false);
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2)`,
      [r, f],
    );
    const kinds = (await inbox(r)).map((n) => n.kind);
    assert.deepEqual(kinds, ['follow']);
    await t.actAs(r);
    const { rows } = await t.sql(`select category, enabled from my_notification_preferences() order by category`);
    await t.actAs(null);
    // Every other category is at its default: on, except reactions (20261031000100).
    for (const row of rows) {
      assert.equal(row.enabled, !['watchlist_discovery', 'reactions'].includes(row.category), row.category);
    }
  });

  /**
   * Codex re-review, MINOR. A one-friend cluster is below the threshold, so the arbiter
   * never looks at it, and it used to survive a mute: one friend, off, a tick, on, one
   * fresh friend, and the old cluster went eligible with two. Muting is now a clean
   * boundary: the switch itself closes every open window.
   */
  it('D: one friend, a mute, a tick, an unmute, one fresh friend: a fresh one-person cluster', async () => {
    const r = await user('trd');
    const [a, b] = [await user('trda'), await user('trdb')];
    await friends(r, a);
    await friends(r, b);
    const m = await movie('Transition D');
    await save(r, m);
    await addAt(r, a, m, '2031-04-28T09:00:00Z');
    const [old] = await candidates(r, 'watchlist_social');
    assert.equal(old.eligible_at, null, 'one friend: below the threshold');

    await setPref(r, false);
    let [closed] = await candidates(r, 'watchlist_social');
    assert.equal(closed.state, 'suppressed', 'the switch itself ends the open cluster');
    assert.equal(closed.suppression_reason, 'preference_off');
    assert.ok(closed.window_ends_at <= new Date(), 'and closes its window');

    await arbitrate('2031-04-28T17:30:00Z');
    await setPref(r, true);
    await addAt(r, b, m, '2031-04-29T09:00:00Z');

    const cs = await candidates(r, 'watchlist_social');
    assert.equal(cs.length, 2, 'a fresh cluster, not the old one reopened');
    [closed] = cs;
    const fresh = cs[1];
    assert.equal(closed.state, 'suppressed', 'the old one stays ended');
    assert.equal(fresh.state, 'pending');
    assert.equal(fresh.eligible_at, null, 'NOT two-person eligible: the pre-mute friend does not count');
    const { rows } = await t.sql(
      `select count(distinct actor_id)::int people from proactive_cluster_actors where candidate_id = $1`,
      [fresh.id],
    );
    assert.equal(rows[0].people, 1);
    const row = (await inbox(r)).find((n) => n.id === fresh.notification_id);
    assert.equal(row.cluster_count, 1);
    await arbitrate('2031-04-29T17:30:00Z');
    assert.equal((await outboxFor(r)).length, 0, 'and nothing is pushed');
  });

  it('E: an eligible cluster, muted: a later friend adds no member, no bump, no unread', async () => {
    const r = await user('tre');
    const m = await movie('Transition E');
    await save(r, m);
    await cluster(r, m, 2, '2031-05-05T09:00:00Z');
    const [c] = await candidates(r, 'watchlist_social');
    assert.ok(c.eligible_at);
    await t.sql(`update notifications set read_at = '2031-05-05T10:00:00Z' where id = $1`, [c.notification_id]);
    const before = (await t.sql(`select created_at, read_at from notifications where id = $1`, [c.notification_id])).rows[0];

    await setPref(r, false);
    const late = await user('trel');
    await friends(r, late);
    await addAt(r, late, m, '2031-05-05T12:00:00Z');

    const after = (await t.sql(`select created_at, read_at from notifications where id = $1`, [c.notification_id])).rows[0];
    assert.deepEqual(after, before);
    const { rows } = await t.sql(
      `select count(distinct actor_id)::int people from proactive_cluster_actors where candidate_id = $1`,
      [c.id],
    );
    assert.equal(rows[0].people, 2);
    const cs = await candidates(r, 'watchlist_social');
    assert.equal(cs.length, 1, 'and no new cluster either');
    assert.equal(cs[0].suppression_reason, 'preference_off');
  });

  it('F: a cluster selected for tonight, muted and unmuted before the claim, is not sent', async () => {
    const r = await user('trf');
    const m = await movie('Transition F');
    await save(r, m);
    await cluster(r, m, 2, '2031-05-12T09:00:00Z');
    await arbitrate('2031-05-12T17:30:00Z');
    assert.equal((await candidates(r, 'watchlist_social'))[0].state, 'selected');

    await setPref(r, false);
    await setPref(r, true);
    const jobs = (await claimFor(r, '2031-05-12T17:35:00Z')).filter((j) => j.proactive);
    assert.equal(jobs.length, 0, 'the old cluster does not go out after the boundary');
    const [c] = await candidates(r, 'watchlist_social');
    assert.deepEqual([c.state, c.suppression_reason], ['suppressed', 'preference_off']);
  });

  it('G: a cluster already sent stays sent; only its window closes', async () => {
    const r = await user('trg');
    const m = await movie('Transition G');
    await save(r, m);
    await cluster(r, m, 2, '2031-05-19T09:00:00Z');
    await arbitrate('2031-05-19T17:30:00Z');
    await claimFor(r, '2031-05-19T17:35:00Z');
    assert.equal((await candidates(r, 'watchlist_social'))[0].state, 'sent');

    await setPref(r, false);
    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'sent', 'history is not rewritten');
    assert.ok(c.sent_at);
    assert.ok(c.window_ends_at <= new Date(), 'but nothing joins it after the boundary');

    await setPref(r, true);
    const f = await user('trgf');
    await friends(r, f);
    await addAt(r, f, m, '2031-05-20T09:00:00Z');
    const cs = await candidates(r, 'watchlist_social');
    assert.equal(cs.length, 2);
    assert.equal(cs[1].eligible_at, null, 'a fresh cluster, counted from one');
  });

  it('H: switching it ON, or switching another category off, closes nothing', async () => {
    const r = await user('trh');
    const m = await movie('Transition H');
    await save(r, m);
    const f = await user('trhf');
    await friends(r, f);
    await addAt(r, f, m, '2031-05-26T09:00:00Z');
    await setPref(r, true);
    await t.sql(
      `insert into notification_preferences (user_id, category, enabled) values ($1, 'comments', false)
       on conflict (user_id, category) do update set enabled = excluded.enabled`,
      [r],
    );
    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'pending');
    assert.ok(c.window_ends_at > new Date());
  });

  it('theatrical: a reader muted at arming who re-enables inside the two days still hears once', async () => {
    const r = await user('trt');
    const film = await armedFilm('Transition Film');
    await save(r, film);
    await setPref(r, false);
    await tick('2031-05-09T12:00:00Z');
    assert.equal((await candidates(r, 'theatrical_release')).length, 0, 'nothing recorded while muted');
    await setPref(r, true);
    await tick('2031-05-09T13:00:00Z');
    assert.equal((await candidates(r, 'theatrical_release')).length, 1);
  });
});

// ===========================================================================

describe('at most once, and caps after a late drop', () => {
  const selectedAt = async (name, day) => {
    const r = await user(name);
    const m = await movie(name);
    await save(r, m);
    await cluster(r, m, 2, `${day}T09:00:00Z`);
    await arbitrate(`${day}T17:30:00Z`);
    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'selected');
    return { r, c };
  };

  it('a claimed proactive job whose lease expires is never returned again', async () => {
    const { r, c } = await selectedAt('amo_lease', '2032-04-05');
    const first = (await claimFor(r, '2032-04-05T17:35:00Z')).filter((j) => j.proactive);
    assert.equal(first.length, 1);

    // The sender dies: the lease runs out and the row is claimable again.
    await t.sql(
      `update push_outbox set claimed_at = now() - interval '10 minutes' where notification_id = $1`,
      [c.notification_id],
    );
    const second = (await claimFor(r, '2032-04-05T17:45:00Z')).filter((j) => j.proactive);
    assert.equal(second.length, 0, 'at most once: never handed over twice');
    assert.ok(!(await outboxFor(r)).some((o) => o.notification_id === c.notification_id), 'and the row is gone');
    assert.equal((await candidates(r, 'watchlist_social'))[0].state, 'sent', 'still recorded as handed over once');
  });

  it('a retry the sender asked for is not sent either', async () => {
    const { r, c } = await selectedAt('amo_retry', '2032-04-12');
    assert.equal((await claimFor(r, '2032-04-12T17:35:00Z')).filter((j) => j.proactive).length, 1);
    // What settle_push_batch does for a retryable failure: the row goes back to pending.
    await t.sql(
      `update push_outbox set state = 'pending', claimed_at = null, failures = failures + 1 where notification_id = $1`,
      [c.notification_id],
    );
    assert.equal((await claimFor(r, '2032-04-12T17:40:00Z')).filter((j) => j.proactive).length, 0);
  });

  it('reactive retries are unchanged: an expired lease is claimed again', async () => {
    const r = await user('amo_reactive');
    const f = await user('amo_reactivef');
    const { rows: [n] } = await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2) returning id`,
      [r, f],
    );
    assert.equal((await claimFor(r)).length, 1);
    await t.sql(`update push_outbox set claimed_at = now() - interval '10 minutes' where notification_id = $1`, [n.id]);
    const again = await claimFor(r);
    assert.deepEqual(again.map((j) => j.notification_id), [n.id], 'at least once, as before');
  });

  it('a push dropped late does not consume the budget, and the next evening can use it', async () => {
    const { r } = await selectedAt('amo_caps', '2032-04-19');
    // The drain stalls until the next morning: dropped, never handed over.
    assert.equal((await claimFor(r, '2032-04-20T09:00:00Z')).filter((j) => j.proactive).length, 0);
    const [dead] = await candidates(r, 'watchlist_social');
    assert.equal(dead.state, 'expired');
    assert.equal(dead.suppression_reason, 'outside_window');
    assert.equal(dead.sent_at, null, 'nothing is counted as sent');

    // Only what was handed over counts: the weekly and daily budget are intact.
    const { rows } = await t.sql(
      `select count(*)::int n from proactive_candidates
        where recipient_id = $1 and state in ('selected', 'sent')`,
      [r],
    );
    assert.equal(rows[0].n, 0);

    // Another title that evening is free to go, the type cooldown aside (set to 0 here).
    await setConfig('proactive.type_cooldown_hours', 0);
    try {
      const m2 = await movie('amo_caps second');
      await save(r, m2);
      await cluster(r, m2, 2, '2032-04-20T09:00:00Z');
      await arbitrate('2032-04-20T17:30:00Z');
      const second = (await candidates(r, 'watchlist_social')).at(-1);
      assert.equal(second.state, 'selected', 'the dropped push did not take the day or the week');
      assert.equal((await claimFor(r, '2032-04-20T17:35:00Z')).filter((j) => j.proactive).length, 1);
    } finally {
      await setConfig('proactive.type_cooldown_hours', 72);
    }
  });
});

// ===========================================================================

describe('theatrical region, re-checked', () => {
  it('created while US, now GB: not selected', async () => {
    const r = await user('reggb');
    const film = await armedFilm('Region Change');
    await save(r, film);
    await tick('2031-05-09T12:00:00Z');
    assert.equal((await candidates(r, 'theatrical_release'))[0].state, 'pending');
    await t.sql(`update account_context set region = 'GB' where user_id = $1`, [r]);
    await tick('2031-05-09T17:30:00Z');
    const [c] = await candidates(r, 'theatrical_release');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'region_mismatch');
  });

  it('selected while US, GB by the time it is claimed: not sent', async () => {
    const r = await user('regclaim');
    const film = await armedFilm('Region At Claim');
    await save(r, film);
    await tick('2031-05-09T17:30:00Z');
    assert.equal((await candidates(r, 'theatrical_release'))[0].state, 'selected');
    await t.sql(`update account_context set region = 'GB' where user_id = $1`, [r]);
    assert.equal((await claimFor(r, '2031-05-09T17:35:00Z')).filter((j) => j.proactive).length, 0);
    const [c] = await candidates(r, 'theatrical_release');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'region_mismatch');
  });

  it('region no longer known: not sent either', async () => {
    const r = await user('regnull');
    const film = await armedFilm('Region Gone');
    await save(r, film);
    await tick('2031-05-09T12:00:00Z');
    await t.sql(`update account_context set region = null where user_id = $1`, [r]);
    await tick('2031-05-09T17:30:00Z');
    assert.equal((await candidates(r, 'theatrical_release'))[0].suppression_reason, 'region_unknown');
  });
});

// ===========================================================================

describe('per-device compatibility', () => {
  it('one capable and one old device: the push goes to the capable one only', async () => {
    const r = await user('multi'); // its main device is capable (version 2)
    const old = await addDevice(r, 'old-tablet', null, 'android');
    const m = await movie('Two Devices');
    await save(r, m);
    await cluster(r, m, 2, '2031-12-29T09:00:00Z');

    await arbitrate('2031-12-29T17:30:00Z');
    assert.equal((await candidates(r, 'watchlist_social'))[0].state, 'selected');

    const [job] = (await claimFor(r, '2031-12-29T17:35:00Z')).filter((j) => j.proactive);
    assert.ok(job, 'the capable device makes the reader reachable');
    const tokens = job.tokens.map((d) => d.token);
    assert.deepEqual(tokens, [`ExponentPushToken[${r}-main]`]);
    assert.ok(!tokens.includes(old), 'the old build never receives a kind it cannot route');
  });

  it('only old devices: held, never sent, and the reason says why', async () => {
    const r = await user('oldonly', { version: null });
    await addDevice(r, 'old-2', null, 'android');
    const m = await movie('Old Only');
    await save(r, m);
    await cluster(r, m, 2, '2031-12-29T09:00:00Z');
    await arbitrate('2031-12-29T17:30:00Z');
    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'pending');
    assert.equal(c.last_block_reason, 'client_unsupported');
    assert.equal((await outboxFor(r)).length, 0);
  });

  it('the capable device goes away after selection: dropped at claim, not sent to the old one', async () => {
    const r = await user('lostcap');
    await addDevice(r, 'old-3', null);
    const m = await movie('Lost Capable');
    await save(r, m);
    await cluster(r, m, 2, '2031-12-29T09:00:00Z');
    await arbitrate('2031-12-29T17:30:00Z');
    await t.sql(`update device_tokens set revoked_at = now() where token = $1`, [
      `ExponentPushToken[${r}-main]`,
    ]);

    const jobs = (await claimFor(r, '2031-12-29T17:35:00Z')).filter((j) => j.proactive);
    assert.equal(jobs.length, 0);
    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'client_unsupported');
  });

  it('reactive pushes still go to every live device, old builds included', async () => {
    const r = await user('reacmulti');
    const old = await addDevice(r, 'old-4', null, 'android');
    const f = await user('reacmultif');
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2)`,
      [r, f],
    );
    const [job] = await claimFor(r);
    assert.equal(job.type, 'follow');
    assert.deepEqual(job.tokens.map((d) => d.token).sort(), [`ExponentPushToken[${r}-main]`, old].sort());
  });

  it('resurfacing is not even generated for a reader with only old devices', async () => {
    const r = await user('resold', { version: null });
    await save(r, await movie('Resurface Old'), '2029-01-01T00:00:00Z');
    await tick('2032-01-05T17:05:00Z');
    assert.equal((await candidates(r, 'watchlist_resurface')).length, 0);
  });
});

// ===========================================================================

describe('watchlist social: who qualifies (through the real trigger)', () => {
  it('a mutual friend ranking a saved title opens one inbox row, and no push', async () => {
    const r = await user('soc1');
    const f = await user('soc1f');
    await friends(r, f);
    const m = await movie('Dune');
    await save(r, m);

    await activity(f, m, 'title_ranked');

    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'pending');
    assert.equal(c.eligible_at, null, 'one friend is not enough to push');
    assert.equal(c.last_block_reason, 'below_threshold');
    assert.equal((await outboxFor(r)).length, 0);

    const rows = (await inbox(r)).filter((n) => n.kind === 'watchlist_social');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cluster_count, 1);
    assert.equal(rows[0].media_item_id, m);
    assert.equal(rows[0].actor_id, null, 'actorless: names come from the cluster at read time');
  });

  it('a log counts as well as a rank; the second distinct friend makes it eligible', async () => {
    const r = await user('soc2');
    const [a, b] = [await user('soc2a'), await user('soc2b')];
    await friends(r, a);
    await friends(r, b);
    const m = await movie('Arrival');
    await save(r, m);

    await activity(a, m, 'title_logged');
    await activity(b, m, 'title_ranked');

    const [c] = await candidates(r, 'watchlist_social');
    assert.ok(c.eligible_at, 'two people is the threshold');
    assert.equal((await inbox(r)).filter((n) => n.kind === 'watchlist_social')[0].cluster_count, 2);
  });

  it('the same friend twice is one friend', async () => {
    const r = await user('soc3');
    const a = await user('soc3a');
    await friends(r, a);
    const m = await movie('Heat');
    await save(r, m);

    await activity(a, m, 'title_logged');
    await activity(a, m, 'title_ranked');

    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.eligible_at, null);
    const { rows } = await t.sql(
      `select count(*)::int n, count(distinct actor_id)::int people from proactive_cluster_actors where candidate_id = $1`,
      [c.id],
    );
    assert.deepEqual(rows[0], { n: 2, people: 1 });
  });

  it('a one-way follow, a stranger, the reader themself and a title not saved are all ignored', async () => {
    const r = await user('soc4');
    const oneWay = await user('soc4o');
    const stranger = await user('soc4s');
    await follow(r, oneWay); // r follows, not followed back
    const m = await movie('Ronin');
    const other = await movie('Unsaved');
    await save(r, m);

    await activity(oneWay, m);
    await activity(stranger, m);
    await activity(r, m);
    const f = await user('soc4f');
    await friends(r, f);
    await activity(f, other);

    assert.equal((await candidates(r)).length, 0);
  });

  it('a reader who has already watched the title is not told friends watched it', async () => {
    const r = await user('soc5');
    const f = await user('soc5f');
    await friends(r, f);
    const m = await movie('Seen');
    await save(r, m);
    await markWatched(r, m);
    await activity(f, m);
    assert.equal((await candidates(r)).length, 0);
  });

  it('watchlist adds, grouped Unranked sittings and their drafts never qualify', async () => {
    const r = await user('soc6');
    const f = await user('soc6f');
    await friends(r, f);
    const m = await movie('Sitting');
    await save(r, m);

    await activity(f, m, 'watchlist_added');
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload)
       values ($1, 'ranking_batch_draft', $2, jsonb_build_object('sitting', gen_random_uuid()::text, 'count', 30))`,
      [f, m],
    );
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload)
       values ($1, 'ranking_batch', $2, jsonb_build_object('sitting', gen_random_uuid()::text, 'count', 30))`,
      [f, m],
    );
    assert.equal((await candidates(r)).length, 0);
  });

  it('an import is silent, and so is a backfill written long after the fact', async () => {
    const r = await user('soc7');
    const f = await user('soc7f');
    await friends(r, f);
    const m = await movie('Imported');
    await save(r, m);

    await t.sql(`do $$ begin
      perform set_config('bingd.import_running', txid_current()::text, true);
      insert into feed_events (actor_id, type, media_item_id) values ('${f}', 'title_logged', '${m}');
    end $$;`);
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, created_at)
       values ($1, 'title_ranked', $2, now() - interval '3 days')`,
      [f, m],
    );
    assert.equal((await candidates(r)).length, 0);
  });

  it('generation off writes nothing, and the ranking it rides on still commits', async () => {
    const r = await user('soc8');
    const f = await user('soc8f');
    await friends(r, f);
    const m = await movie('Paused');
    await save(r, m);
    await setConfig('proactive.generation_enabled', false);
    const ev = await activity(f, m);
    assert.ok(ev);
    assert.equal((await candidates(r)).length, 0);
  });

  it('a real ranking through rank_start reaches the trigger', async () => {
    const r = await user('soc9');
    const f = await user('soc9f');
    await friends(r, f);
    const m = await movie('Ranked For Real');
    await save(r, m);
    await t.actAs(f);
    try {
      await t.rankToCompletion(m, 'loved', (pivot, subject) => subject);
    } finally {
      await t.actAs(null);
    }
    assert.equal((await candidates(r, 'watchlist_social')).length, 1);
  });
});

// ===========================================================================

describe('watchlist social: the seven-day cluster', () => {
  it('six friends over seven days: one inbox row, one candidate, one push at most', async () => {
    const r = await user('six');
    const m = await movie('Six');
    await save(r, m);
    const people = [];
    for (let i = 0; i < 6; i += 1) {
      const f = await user(`six${i}_`);
      await friends(r, f);
      people.push(f);
    }
    // Day 0 and day 1: the threshold.
    await addAt(r, people[0], m, '2031-03-03T09:00:00Z');
    await addAt(r, people[1], m, '2031-03-04T09:00:00Z');
    // Day 2 before the window: another arrives, and the push has not gone yet.
    await addAt(r, people[2], m, '2031-03-05T10:00:00Z');

    await arbitrate('2031-03-05T12:00:00Z');
    let [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'pending');
    assert.equal(c.last_block_reason, 'quiet_window', 'eligible at noon, held for the evening');

    await arbitrate('2031-03-05T17:15:00Z');
    [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'selected');

    const jobs = (await claimFor(r, '2031-03-05T17:20:00Z')).filter((j) => j.proactive);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].proactive.actor_count, 3, 'counted at send time, not at threshold time');
    assert.equal(jobs[0].proactive.actor_names.length, 2);

    // After the push: three more friends on days 3, 5 and 6.
    await addAt(r, people[3], m, '2031-03-06T09:00:00Z');
    await addAt(r, people[4], m, '2031-03-08T09:00:00Z');
    await addAt(r, people[5], m, '2031-03-09T09:00:00Z');
    for (const d of ['2031-03-06T18:00:00Z', '2031-03-08T18:00:00Z', '2031-03-09T18:00:00Z']) {
      await arbitrate(d);
    }

    const all = await candidates(r, 'watchlist_social');
    assert.equal(all.length, 1, 'one cluster for the whole window');
    assert.equal(all[0].state, 'sent');
    assert.equal(all[0].actor_count_at_send, 3, 'the delivered push is not rewritten');
    // Claimed rows stay until the sender settles them; what matters is nothing new waiting.
    assert.equal((await outboxFor(r)).filter((o) => o.state === 'pending').length, 0, 'nothing queued again');

    const rows = (await inbox(r)).filter((n) => n.kind === 'watchlist_social');
    assert.equal(rows.length, 1, 'one durable inbox row');
    assert.equal(rows[0].cluster_count, 6, 'the inbox keeps counting');
    assert.equal(rows[0].cluster_actors.length, 3, 'three faces at most');
  });

  it('the window is fixed: a friend on day eight opens a new cluster, and the old one expires unpushed', async () => {
    const r = await user('fixed');
    const [a, b] = [await user('fixeda'), await user('fixedb')];
    await friends(r, a);
    await friends(r, b);
    const m = await movie('Fixed');
    await save(r, m);

    await addAt(r, a, m, '2031-03-03T09:00:00Z');
    await addAt(r, b, m, '2031-03-11T09:00:00Z'); // eight days later

    await arbitrate('2031-03-11T10:00:00Z');
    const cs = await candidates(r, 'watchlist_social');
    assert.equal(cs.length, 2, 'the window did not slide to catch the second friend');
    assert.equal(cs[0].state, 'expired');
    assert.equal(cs[0].suppression_reason, 'below_threshold', 'one friend, and the window closed');
    assert.equal(cs[1].state, 'pending');
    assert.equal(cs[1].eligible_at, null);

    const rows = (await inbox(r)).filter((n) => n.kind === 'watchlist_social');
    assert.equal(rows.length, 2, 'the expired cluster keeps its inbox row');
  });

  it('a new friend is news again; the same friend logging what they ranked is not', async () => {
    const r = await user('bump');
    const [a, b] = [await user('bumpa'), await user('bumpb')];
    await friends(r, a);
    await friends(r, b);
    const m = await movie('Bump');
    await save(r, m);
    await addAt(r, a, m, '2031-03-03T09:00:00Z');
    const [c] = await candidates(r, 'watchlist_social');
    await t.sql(`update notifications set read_at = '2031-03-03T10:00:00Z' where id = $1`, [c.notification_id]);

    await addAt(r, a, m, '2031-03-04T09:00:00Z');
    let { rows } = await t.sql(`select created_at, read_at from notifications where id = $1`, [c.notification_id]);
    assert.ok(rows[0].read_at, 'the same person again does not re-open the row');

    await addAt(r, b, m, '2031-03-05T09:00:00Z');
    ({ rows } = await t.sql(`select created_at, read_at from notifications where id = $1`, [c.notification_id]));
    assert.equal(rows[0].read_at, null);
    assert.equal(rows[0].created_at.toISOString(), at('2031-03-05T09:00:00Z'));
  });

  it('a title taken off the Watchlist before the evening is not pushed', async () => {
    const r = await user('unsaved');
    const m = await movie('Unsaved Later');
    await save(r, m);
    await cluster(r, m, 2, '2031-03-03T09:00:00Z');
    await unsave(r, m);
    await arbitrate('2031-03-03T18:00:00Z');
    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'not_on_watchlist');
    assert.equal((await outboxFor(r)).length, 0);
  });

  it('a reader who watches it before the evening is not pushed', async () => {
    const r = await user('watchedfirst');
    const m = await movie('Watched First');
    await save(r, m);
    await cluster(r, m, 2, '2031-03-03T09:00:00Z');
    await markWatched(r, m);
    await arbitrate('2031-03-03T18:00:00Z');
    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'suppressed');
    // Logging a title takes it off the Watchlist (the collection's own rule), so the
    // first check that fails is that one. Either is the right answer: it was watched.
    assert.ok(['already_watched', 'not_on_watchlist'].includes(c.suppression_reason));
    assert.equal((await outboxFor(r)).length, 0);
  });

  it('a friend who blocks, unfollows or is suspended drops out of the count, the names and the push', async () => {
    const r = await user('priv');
    const [a, b] = [await user('priva'), await user('privb')];
    await friends(r, a);
    await friends(r, b);
    const m = await movie('Private');
    await save(r, m);
    await addAt(r, a, m, '2031-03-03T09:00:00Z');
    await addAt(r, b, m, '2031-03-03T10:00:00Z');

    // b stops following r back: no longer a mutual friend.
    await t.sql(`delete from follows where follower_id = $1 and followee_id = $2`, [b, r]);
    let rows = (await inbox(r)).filter((n) => n.kind === 'watchlist_social');
    assert.equal(rows[0].cluster_count, 1);

    await arbitrate('2031-03-03T18:00:00Z');
    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'below_threshold');

    // a is suspended: nobody left, so the row is not drawn at all.
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [a]);
    rows = (await inbox(r)).filter((n) => n.kind === 'watchlist_social');
    assert.equal(rows.length, 0);
  });

  it('a deleted activity takes its membership with it', async () => {
    const r = await user('deleted');
    const f = await user('deletedf');
    await friends(r, f);
    const m = await movie('Deleted');
    await save(r, m);
    const ev = await activity(f, m);
    assert.equal((await inbox(r)).filter((n) => n.kind === 'watchlist_social').length, 1);
    await t.sql(`delete from feed_events where id = $1`, [ev]);
    assert.equal((await inbox(r)).filter((n) => n.kind === 'watchlist_social').length, 0);
  });
});

// ===========================================================================

describe('theatrical release', () => {
  it('a watchlisted film at T-7: one inbox row and one candidate, pushed in the evening', async () => {
    const r = await user('film');
    const m = await armedFilm('Dune Part Three');
    await save(r, m);

    await tick('2031-05-09T12:00:00Z');
    const [c] = await candidates(r, 'theatrical_release');
    assert.equal(c.state, 'pending');
    assert.equal(c.metadata.opens_on, '2031-05-16');
    assert.equal(c.last_block_reason, 'quiet_window');
    const rows = (await inbox(r)).filter((n) => n.kind === 'theatrical_release');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.opens_on, '2031-05-16');

    await tick('2031-05-09T17:30:00Z');
    assert.equal((await candidates(r, 'theatrical_release'))[0].state, 'selected');
    const jobs = (await claimFor(r, '2031-05-09T17:35:00Z')).filter((j) => j.proactive);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, 'theatrical_release');
    assert.equal(jobs[0].media_item_id, m);
    assert.equal(jobs[0].proactive.opens_on, '2031-05-16');
  });

  it('nobody who has not saved it, and nobody outside the US', async () => {
    const notSaved = await user('nosave');
    const abroad = await user('abroad', { region: 'GB' });
    const m = await armedFilm('Abroad');
    await save(abroad, m);
    await tick('2031-05-09T12:00:00Z');
    assert.equal((await candidates(notSaved)).length, 0);
    assert.equal((await candidates(abroad)).length, 0);
  });

  it('an unknown region gets the inbox row and no push', async () => {
    const r = await user('noregion', { region: null });
    const m = await armedFilm('Unknown Region');
    await save(r, m);
    await tick('2031-05-09T12:00:00Z');
    const [c] = await candidates(r, 'theatrical_release');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'region_unknown');
    assert.equal((await inbox(r)).filter((n) => n.kind === 'theatrical_release').length, 1);
  });

  it('once per release, however many ticks and evaluations run', async () => {
    const r = await user('dupe');
    const m = await armedFilm('Twice');
    await save(r, m);
    await tick('2031-05-09T12:00:00Z');
    await evaluate('2031-05-09T12:10:00Z');
    await tick('2031-05-09T12:15:00Z');
    await tick('2031-05-10T12:00:00Z');
    assert.equal((await candidates(r, 'theatrical_release')).length, 1);
    assert.equal((await inbox(r)).filter((n) => n.kind === 'theatrical_release').length, 1);
  });

  it('a stale read never becomes a candidate', async () => {
    const r = await user('stale');
    const m = await armedFilm('Stale', '2031-05-16', '2031-05-09T06:00:00Z');
    await save(r, m);
    // 40 hours after the last read: past proactive.theatrical_max_read_age_hours.
    await tick('2031-05-10T22:00:00Z');
    assert.equal((await candidates(r, 'theatrical_release')).length, 0);
  });

  it('its push can only be delivered that evening, and never on or after the day', async () => {
    const r = await user('filmdeadline');
    const m = await armedFilm('Deadline Film');
    await save(r, m);
    await tick('2031-05-09T12:00:00Z');
    await tick('2031-05-09T17:30:00Z');
    const [c] = await candidates(r, 'theatrical_release');
    const [job] = (await claimFor(r, '2031-05-09T17:35:00Z')).filter((j) => j.proactive);
    const by = new Date(job.proactive.deliver_by);
    assert.equal(by.toISOString(), '2031-05-09T20:00:00.000Z', 'the selected evening');
    assert.ok(by <= new Date(c.expires_at), 'never past the candidate expiry');
    assert.ok(by < new Date('2031-05-16T00:00:00Z'), 'never on the opening day');
  });

  /**
   * Codex re-review, MINOR. The inbox row used to keep the date it was written with, so a
   * postponed film still said it opened on the old day. The row now reads the release
   * event's date as it stands, and is not drawn while the release has none.
   */
  describe('the inbox date follows the release', () => {
    const filmRow = async (r) => (await inbox(r)).filter((n) => n.kind === 'theatrical_release');

    it('postponed: the row says the new date, never the old one, and stays one row', async () => {
      const r = await user('postponed');
      const m = await armedFilm('Postponed');
      await save(r, m);
      await tick('2031-05-09T12:00:00Z');
      assert.equal((await filmRow(r))[0].payload.opens_on, '2031-05-16');

      await observeMovie(m, '2031-06-20', '2031-05-09T13:00:00Z');
      await tick('2031-05-09T17:30:00Z');
      const [c] = await candidates(r, 'theatrical_release');
      assert.equal(c.suppression_reason, 'release_changed', 'no push for a moved date');
      const rows = await filmRow(r);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].payload.opens_on, '2031-06-20');
      assert.ok(!JSON.stringify(rows[0].payload).includes('2031-05-16'), 'the old date is nowhere');
    });

    it('cancelled, or its date cleared: the row is not drawn at all', async () => {
      const axed = await user('axed');
      const m1 = await armedFilm('Axed');
      await save(axed, m1);
      await tick('2031-05-09T12:00:00Z');
      await observeMovie(m1, '2031-05-16', '2031-05-09T13:00:00Z', { status: 'Canceled' });
      assert.equal((await filmRow(axed)).length, 0, 'withdrawn');

      const undated = await user('undated');
      const m2 = await armedFilm('Undated');
      await save(undated, m2);
      await tick('2031-05-09T12:00:00Z');
      await observeMovie(m2, null, '2031-05-09T13:00:00Z');
      assert.equal((await filmRow(undated)).length, 0, 'no date');
      await tick('2031-05-09T17:30:00Z');
      assert.equal((await candidates(undated, 'theatrical_release'))[0].state, 'suppressed');
    });

    it('a new future date after that: the same row comes back with it, and no second row', async () => {
      const r = await user('restored');
      const m = await armedFilm('Restored');
      await save(r, m);
      await tick('2031-05-09T12:00:00Z');
      await observeMovie(m, '2031-05-16', '2031-05-09T13:00:00Z', { status: 'Canceled' });
      assert.equal((await filmRow(r)).length, 0);

      await observeMovie(m, '2031-07-04', '2031-05-10T13:00:00Z');
      await tick('2031-05-10T14:00:00Z');
      const rows = await filmRow(r);
      assert.equal(rows.length, 1, 'one row, whatever the date did');
      assert.equal(rows[0].payload.opens_on, '2031-07-04');
      assert.equal((await candidates(r, 'theatrical_release')).length, 1, 'and one candidate: once per release');
    });

    it('after it opens, the row states the day it opened', async () => {
      const r = await user('opened');
      const m = await armedFilm('Opened');
      await save(r, m);
      await tick('2031-05-09T12:00:00Z');
      await observeMovie(m, '2031-05-16', '2031-05-16T12:00:00Z', { status: 'Released' });
      const [row] = await filmRow(r);
      assert.equal(row.payload.opens_on, '2031-05-16');
    });
  });

  it('a date that moves before the push suppresses it, and nothing is sent on the day', async () => {
    const moved = await user('moved');
    const m1 = await armedFilm('Moved');
    await save(moved, m1);
    await tick('2031-05-09T12:00:00Z');
    await observeMovie(m1, '2031-06-20', '2031-05-09T13:00:00Z');
    await tick('2031-05-09T17:30:00Z');
    assert.equal((await candidates(moved, 'theatrical_release'))[0].suppression_reason, 'release_changed');

    // A film first armed two days out, whose reader is held until the day itself.
    const late = await user('late', { device: false });
    const m2 = await armedFilm('Late', '2031-05-16', '2031-05-14T06:00:00Z');
    await save(late, m2);
    await tick('2031-05-14T12:00:00Z');
    let [c] = await candidates(late, 'theatrical_release');
    assert.equal(c.state, 'pending');
    await observeMovie(m2, '2031-05-16', '2031-05-15T23:00:00Z'); // still fresh
    await tick('2031-05-16T00:30:00Z');
    [c] = await candidates(late, 'theatrical_release');
    assert.notEqual(c.state, 'selected');
    assert.ok(['expired', 'suppressed'].includes(c.state), 'no day-of push');
  });
});

// ===========================================================================

describe('watchlist resurfacing', () => {
  it('push only: a hidden carrier row, never in the inbox', async () => {
    const r = await user('res');
    const m = await movie('Saved Long Ago');
    await save(r, m, '2030-06-01T00:00:00Z');

    await tick('2031-07-07T17:05:00Z');
    const [c] = await candidates(r, 'watchlist_resurface');
    assert.equal(c.state, 'selected');
    assert.equal(c.media_item_id, m);
    assert.ok(c.notification_id, 'a carrier row exists for the outbox to key on');
    assert.equal((await outboxFor(r)).length, 1);
    assert.equal((await inbox(r)).length, 0, 'and the reader never sees it in the inbox');

    const jobs = (await claimFor(r, '2031-07-07T17:10:00Z')).filter((j) => j.proactive);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, 'watchlist_resurface');
    assert.equal(jobs[0].proactive.reason, 'saved');
  });

  it('at most once in seven days, and the same title is not picked again', async () => {
    const r = await user('res7');
    const a = await movie('First Pick');
    const b = await movie('Second Pick');
    await save(r, a, '2029-01-01T00:00:00Z');
    await save(r, b, '2030-01-01T00:00:00Z');

    await tick('2031-07-07T17:05:00Z');
    for (const d of ['2031-07-08', '2031-07-09', '2031-07-10', '2031-07-11', '2031-07-12', '2031-07-13']) {
      await tick(`${d}T17:05:00Z`);
    }
    let cs = await candidates(r, 'watchlist_resurface');
    assert.equal(cs.length, 1, 'nothing generated inside the week');
    assert.equal(cs[0].media_item_id, a, 'longest saved wins a tie');

    await tick('2031-07-15T17:05:00Z');
    cs = await candidates(r, 'watchlist_resurface');
    assert.equal(cs.length, 2);
    assert.equal(cs[1].media_item_id, b, 'the title just resurfaced is excluded');
  });

  it('a watched title is never picked, and an empty choice writes nothing', async () => {
    const r = await user('resw');
    const m = await movie('Already Seen');
    await save(r, m);
    await markWatched(r, m);
    await tick('2031-07-07T17:05:00Z');
    assert.equal((await candidates(r)).length, 0);
  });

  it('friends outweigh age, and the reason says so', async () => {
    const r = await user('resf');
    const old = await movie('Old Save');
    const social = await movie('Friends Watched');
    await save(r, old, '2029-01-01T00:00:00Z');
    await save(r, social, '2031-07-01T00:00:00Z');
    for (let i = 0; i < 2; i += 1) {
      const f = await user(`resf${i}_`);
      await friends(r, f);
      await setConfig('proactive.generation_enabled', false);
      await t.sql(
        `insert into feed_events (actor_id, type, media_item_id, created_at) values ($1, 'title_ranked', $2, '2031-07-05T12:00:00Z')`,
        [f, social],
      );
      await setConfig('proactive.generation_enabled', true);
    }
    const pick = (await t.sql(`select * from _proactive_resurface_pick($1, '2031-07-07T17:05:00Z')`, [r])).rows[0];
    assert.equal(pick.media_item_id, social);
    assert.equal(pick.reason, 'friends');
    assert.equal(pick.friends, 2);
  });

  it('nothing at all while the kill switch is off', async () => {
    const r = await user('reskill');
    await save(r, await movie('Kill'));
    await setConfig('proactive.push_enabled', false);
    await tick('2031-07-07T17:05:00Z');
    assert.equal((await candidates(r)).length, 0);
  });

  it('yields to a stronger candidate waiting for the same evening', async () => {
    const r = await user('resyield');
    const m = await movie('Social Wins');
    await save(r, m, '2029-01-01T00:00:00Z');
    await save(r, await movie('Resurface Loses'), '2029-01-01T00:00:00Z');
    await cluster(r, m, 2, '2031-07-07T09:00:00Z');
    await tick('2031-07-07T17:05:00Z');
    assert.equal((await candidates(r, 'watchlist_resurface')).length, 0);
    assert.equal((await candidates(r, 'watchlist_social'))[0].state, 'selected');
  });
});

// ===========================================================================

describe('the resurfacing switch (operator-only, seeded off)', () => {
  it('off: no resurfacing candidate, while social and theatrical still generate', async () => {
    await setConfig('proactive.resurface_enabled', false);
    const r = await user('resoff');
    await save(r, await movie('Resurface Off'), '2029-01-01T00:00:00Z');
    const f = await user('resofff');
    await friends(r, f);
    const m = await movie('Social Still On');
    await save(r, m);
    const film = await armedFilm('Theatrical Still On');
    await save(r, film);

    await activity(f, m);
    await tick('2031-05-09T12:00:00Z');
    await tick('2032-02-02T17:05:00Z');

    assert.equal((await candidates(r, 'watchlist_resurface')).length, 0);
    assert.equal((await candidates(r, 'watchlist_social')).length, 1, 'social is not its business');
    assert.equal((await candidates(r, 'theatrical_release')).length, 1, 'nor is theatrical');
    assert.equal(await one(`(proactive_status() ->> 'resurface_enabled')::boolean`), false);
  });

  it('is fail-closed: anything but true is off', async () => {
    await setConfig('proactive.resurface_enabled', 'true');
    assert.equal(await one(`_proactive_resurface_enabled()`), false, 'the string "true" is not true');
    const r = await user('resbad');
    await save(r, await movie('Resurface Malformed'), '2029-01-01T00:00:00Z');
    await tick('2032-02-09T17:05:00Z');
    assert.equal((await candidates(r, 'watchlist_resurface')).length, 0);
  });

  it('on, but with push off, still generates nothing: it is push-only', async () => {
    await setConfig('proactive.push_enabled', false);
    const r = await user('resnopush');
    await save(r, await movie('Resurface No Push'), '2029-01-01T00:00:00Z');
    await tick('2032-02-16T17:05:00Z');
    assert.equal((await candidates(r, 'watchlist_resurface')).length, 0);
  });

  it('on, with push on: generated', async () => {
    const r = await user('reson');
    await save(r, await movie('Resurface On'), '2029-01-01T00:00:00Z');
    await tick('2032-02-23T17:05:00Z');
    assert.equal((await candidates(r, 'watchlist_resurface')).length, 1);
  });
});

describe('tick hardening', () => {
  it('a malformed trending cache entry is skipped, not fatal, and a good id still counts', async () => {
    const r = await user('trendbad');
    const trending = await movie('Trending Title');
    const plain = await movie('Plain Title');
    await save(r, plain, '2031-01-01T00:00:00Z');
    await save(r, trending, '2031-01-01T00:00:00Z');
    await t.sql(
      `insert into provider_list_cache (list_key, payload, fetched_at, expires_at)
       values ('trending.movie.week', $1::jsonb, '2032-03-01T00:00:00Z', '2032-03-08T00:00:00Z'),
              ('trending.series.week', '{"ids": {"not": "an array"}}'::jsonb, '2032-03-01T00:00:00Z', '2032-03-08T00:00:00Z')
       on conflict (list_key) do update set payload = excluded.payload, fetched_at = excluded.fetched_at`,
      [JSON.stringify({ ids: ['not-a-uuid', 42, null, trending] })],
    );

    const pick = (await t.sql(`select * from _proactive_resurface_pick($1, '2032-03-02T17:05:00Z')`, [r])).rows[0];
    assert.equal(pick.media_item_id, trending, 'the valid id still scores');
    assert.equal(pick.reason, 'trending');

    const result = await tick('2032-03-02T17:05:00Z');
    assert.ok(result, 'the whole tick completed');
    assert.equal((await candidates(r, 'watchlist_resurface')).length, 1);
  });

  it('proactive_status reports the tick\'s last run, last success and last failure', async () => {
    const fresh = await createTestDb();
    try {
      await fresh.exec(`
        create schema cron;
        create table cron.job (jobid bigint primary key, jobname text, schedule text, active boolean);
        create table cron.job_run_details (
          runid bigint primary key, jobid bigint, status text,
          start_time timestamptz, end_time timestamptz, return_message text);
        insert into cron.job values (7, 'bingd-proactive-tick', '4,19,34,49 * * * *', true);
        insert into cron.job_run_details values
          (1, 7, 'succeeded', '2032-01-01T17:04:00Z', '2032-01-01T17:04:01Z', '1 row'),
          (2, 7, 'failed',    '2032-01-01T17:19:00Z', '2032-01-01T17:19:01Z', 'ERROR: something broke');
      `);
      let status = (await fresh.sql(`select proactive_status() as r`)).rows[0].r;
      assert.equal(status.tick.last_status, 'failed');
      assert.equal(status.tick.last_failure, 'ERROR: something broke');
      assert.ok(status.tick.last_success_at);
      assert.ok(status.problems.includes('last_tick_failed'));
      assert.equal(status.healthy, false);

      await fresh.exec(`insert into cron.job_run_details values
        (3, 7, 'succeeded', '2032-01-01T17:34:00Z', '2032-01-01T17:34:01Z', '1 row');`);
      status = (await fresh.sql(`select proactive_status() as r`)).rows[0].r;
      assert.equal(status.tick.last_status, 'succeeded');
      assert.ok(!status.problems.includes('last_tick_failed'), 'a recovered tick is not a problem');
      assert.ok(status.tick.last_failure_at, 'but the failure is still on record');
    } finally {
      await fresh.close();
    }
  });
});

// ===========================================================================

describe('the shared budget', () => {
  it('priority: a film beats friends on the same evening, and friends go the next evening', async () => {
    const r = await user('prio');
    const film = await armedFilm('Priority Film');
    await save(r, film);
    const m = await movie('Priority Social');
    await save(r, m);
    await cluster(r, m, 2, '2031-05-09T09:00:00Z');

    await tick('2031-05-09T17:30:00Z');
    let byType = Object.fromEntries((await candidates(r)).map((c) => [c.type, c]));
    assert.equal(byType.theatrical_release.state, 'selected');
    assert.equal(byType.watchlist_social.state, 'pending');
    assert.equal(byType.watchlist_social.last_block_reason, 'higher_priority_selected');

    // The same evening again: the day is spent.
    await tick('2031-05-09T18:30:00Z');
    byType = Object.fromEntries((await candidates(r)).map((c) => [c.type, c]));
    assert.equal(byType.watchlist_social.last_block_reason, 'daily_cap');

    // Tomorrow: still timely (inside its seven days), so it goes.
    await tick('2031-05-10T17:30:00Z');
    byType = Object.fromEntries((await candidates(r)).map((c) => [c.type, c]));
    assert.equal(byType.watchlist_social.state, 'selected');
  });

  it('two in seven days, then held; and a held candidate that stops being timely expires with the reason', async () => {
    // The type cooldown would otherwise be what holds these; this test is about the week.
    await setConfig('proactive.type_cooldown_hours', 0);
    try {
      const r = await user('weekly');
      for (const [i, day] of ['2031-08-04', '2031-08-05'].entries()) {
        const m = await movie(`Weekly ${i}`);
        await save(r, m);
        await cluster(r, m, 2, `${day}T09:00:00Z`);
        await arbitrate(`${day}T17:30:00Z`);
      }
      assert.equal((await candidates(r, 'watchlist_social')).filter((c) => c.state === 'selected').length, 2);

      const m3 = await movie('Weekly third');
      await save(r, m3);
      await cluster(r, m3, 2, '2031-08-06T09:00:00Z');
      await arbitrate('2031-08-06T17:30:00Z');
      const third = (await candidates(r, 'watchlist_social')).at(-1);
      assert.equal(third.state, 'pending');
      assert.equal(third.last_block_reason, 'weekly_cap');

      // It stops being timely while held: it expires, and does not catch up later.
      await t.sql(`update proactive_candidates set expires_at = '2031-08-08T09:00:00Z' where id = $1`, [third.id]);
      await arbitrate('2031-08-08T10:00:00Z');
      await arbitrate('2031-08-12T17:30:00Z');
      const settled = (await candidates(r, 'watchlist_social')).at(-1);
      assert.equal(settled.state, 'expired');
      assert.equal(settled.suppression_reason, 'weekly_cap', 'the analytics say what held it');
    } finally {
      await setConfig('proactive.type_cooldown_hours', 72);
    }
  });

  it('the same type not again inside 72 hours', async () => {
    const r = await user('typecd');
    const a = await movie('Type A');
    const b = await movie('Type B');
    await save(r, a);
    await save(r, b);
    await cluster(r, a, 2, '2031-09-01T09:00:00Z');
    await arbitrate('2031-09-01T17:30:00Z');
    await cluster(r, b, 2, '2031-09-02T09:00:00Z');
    await arbitrate('2031-09-02T17:30:00Z');
    const second = (await candidates(r, 'watchlist_social')).at(-1);
    assert.equal(second.last_block_reason, 'type_cooldown');
    await arbitrate('2031-09-04T17:45:00Z'); // 72h15m later
    assert.equal((await candidates(r, 'watchlist_social')).at(-1).state, 'selected');
  });

  it('the same title not again inside seven days, across types', async () => {
    const r = await user('titlecd');
    const film = await armedFilm('Same Title');
    await save(r, film);
    await tick('2031-05-09T17:30:00Z');
    assert.equal((await candidates(r, 'theatrical_release'))[0].state, 'selected');
    await cluster(r, film, 2, '2031-05-10T09:00:00Z');
    await arbitrate('2031-05-11T17:30:00Z');
    assert.equal((await candidates(r, 'watchlist_social'))[0].last_block_reason, 'title_cooldown');
  });

  it('reactive pushes consume none of it', async () => {
    const r = await user('reactive');
    const followers = [];
    for (let i = 0; i < 4; i += 1) {
      const f = await user(`reac${i}_`);
      followers.push(f);
      await t.sql(
        `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
         values ($1, 'follow', $2, 'profile', $2)`,
        [r, f],
      );
    }
    assert.equal((await outboxFor(r)).length, 4, 'reactive rows enqueue as they always did');
    const m = await movie('Reactive');
    await save(r, m);
    await cluster(r, m, 2, '2031-10-06T09:00:00Z');
    await arbitrate('2031-10-06T17:30:00Z');
    assert.equal((await candidates(r, 'watchlist_social'))[0].state, 'selected');
  });

  it('one per local day is structural, not just the arbiter being careful', async () => {
    const r = await user('structural');
    const a = await movie('Struct A');
    const b = await movie('Struct B');
    await save(r, a);
    await save(r, b);
    await cluster(r, a, 2, '2031-10-13T09:00:00Z');
    await cluster(r, b, 2, '2031-10-13T09:00:00Z');
    await arbitrate('2031-10-13T17:30:00Z');
    await arbitrate('2031-10-13T17:30:00Z'); // the same tick twice
    const cs = await candidates(r, 'watchlist_social');
    assert.equal(cs.filter((c) => c.state === 'selected').length, 1);
    assert.equal((await outboxFor(r)).length, 1);

    const loser = cs.find((c) => c.state === 'pending');
    const err = await t.errorFrom(
      `update proactive_candidates
          set state = 'selected', selected_at = now(), selected_local_date = '2031-10-13'
        where id = $1`,
      [loser.id],
    );
    assert.ok(err, 'a second selection for the same local day is refused by the index');
  });
});

// ===========================================================================

describe('local time', () => {
  it('the evening is the reader\'s own: Los Angeles and Kolkata go at different instants', async () => {
    const la = await user('la', { timezone: 'America/Los_Angeles' });
    const kol = await user('kol', { timezone: 'Asia/Kolkata' });
    for (const r of [la, kol]) {
      const m = await movie('Zone');
      await save(r, m);
      await cluster(r, m, 2, '2031-11-03T00:00:00Z');
    }
    // 12:00 UTC = 17:30 in Kolkata, 04:00 in Los Angeles.
    await arbitrate('2031-11-03T12:00:00Z');
    assert.equal((await candidates(kol, 'watchlist_social'))[0].state, 'selected');
    assert.equal((await candidates(la, 'watchlist_social'))[0].last_block_reason, 'quiet_window');
    // 01:30 UTC next day = 17:30 PST (UTC-8 in November).
    await arbitrate('2031-11-04T01:30:00Z');
    assert.equal((await candidates(la, 'watchlist_social'))[0].state, 'selected');
  });

  it('after 20:00 waits for the next evening', async () => {
    const r = await user('late_night');
    const m = await movie('Overnight');
    await save(r, m);
    await cluster(r, m, 2, '2031-11-10T20:30:00Z');
    await arbitrate('2031-11-10T20:45:00Z');
    await arbitrate('2031-11-11T09:00:00Z');
    assert.equal((await candidates(r, 'watchlist_social'))[0].last_block_reason, 'quiet_window');
    await arbitrate('2031-11-11T17:00:00Z');
    assert.equal((await candidates(r, 'watchlist_social'))[0].state, 'selected');
  });

  it('unknown timezone: no proactive push, the inbox row stays, and the reason is recorded', async () => {
    const r = await user('notz', { timezone: null });
    const m = await movie('No Zone');
    await save(r, m);
    await cluster(r, m, 2, '2031-11-17T09:00:00Z');
    await arbitrate('2031-11-17T18:00:00Z');
    let [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.last_block_reason, 'no_timezone');
    await arbitrate('2031-11-25T00:00:00Z');
    [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'expired');
    assert.equal(c.suppression_reason, 'no_timezone');
    assert.equal((await inbox(r)).filter((n) => n.kind === 'watchlist_social').length, 1);
  });

  it('a build that cannot render these kinds is not pushed one', async () => {
    const r = await user('oldclient', { version: null });
    const m = await movie('Old Client');
    await save(r, m);
    await cluster(r, m, 2, '2031-11-17T09:00:00Z');
    await arbitrate('2031-11-17T18:00:00Z');
    assert.equal((await candidates(r, 'watchlist_social'))[0].last_block_reason, 'client_unsupported');
  });
});

// ===========================================================================

describe('the kill switch', () => {
  it('off: nothing proactive is selected, and a reactive push still goes', async () => {
    const r = await user('kill');
    const m = await movie('Kill Social');
    await save(r, m);
    await cluster(r, m, 2, '2031-12-01T09:00:00Z');
    await setConfig('proactive.push_enabled', false);

    await arbitrate('2031-12-01T17:30:00Z');
    assert.equal((await candidates(r, 'watchlist_social'))[0].last_block_reason, 'kill_switch');
    assert.equal((await outboxFor(r)).length, 0);

    const f = await user('killf');
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2)`,
      [r, f],
    );
    const jobs = await claimFor(r);
    assert.deepEqual(jobs.map((j) => j.type), ['follow']);
  });

  it('switched off after selection: the queued proactive job is dropped at claim, the reactive one is not', async () => {
    const r = await user('killq');
    const m = await movie('Kill Queued');
    await save(r, m);
    await cluster(r, m, 2, '2031-12-08T09:00:00Z');
    await arbitrate('2031-12-08T17:30:00Z');
    assert.equal((await outboxFor(r)).length, 1);

    const f = await user('killqf');
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2)`,
      [r, f],
    );
    await setConfig('proactive.push_enabled', false);
    const jobs = await claimFor(r);
    assert.deepEqual(jobs.map((j) => j.type), ['follow']);
    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'kill_switch');
    // The claimed follow stays in the outbox until the sender settles it; the proactive
    // job is gone.
    const left = await outboxFor(r);
    assert.ok(!left.some((o) => o.notification_id === c.notification_id));
  });

  it('is fail-closed: a malformed value is off', async () => {
    await setConfig('proactive.push_enabled', 'yes');
    assert.equal(await one(`_proactive_push_enabled()`), false);
  });
});

// ===========================================================================

describe('sending', () => {
  it('a claimed proactive candidate is sent; a retry does not reset it', async () => {
    const r = await user('send');
    const m = await movie('Send');
    await save(r, m);
    await cluster(r, m, 2, '2031-12-15T09:00:00Z');
    await arbitrate('2031-12-15T17:30:00Z');
    const jobs = (await claimFor(r, '2031-12-15T17:35:00Z')).filter((j) => j.proactive);
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].tokens.map((d) => d.platform), ['ios']);
    const [c] = await candidates(r, 'watchlist_social');
    assert.equal(c.state, 'sent');
    assert.ok(c.sent_at);
    assert.equal(c.actor_count_at_send, 2);
  });

  it('a recipient with no live device is held, never queued for nobody', async () => {
    const r = await user('nodevice', { device: false });
    const m = await movie('No Device');
    await save(r, m);
    await cluster(r, m, 2, '2031-12-15T09:00:00Z');
    await arbitrate('2031-12-15T17:30:00Z');
    assert.equal((await candidates(r, 'watchlist_social'))[0].last_block_reason, 'no_device');
  });

  /**
   * Fable review, MAJOR. A selected candidate must not be delivered after its evening:
   * not after expires_at, not outside 17:00-20:00 local, not when a stalled drain
   * recovers the next morning or the next evening. Tonight or not at all.
   */
  describe('tonight or not at all', () => {
    const selected = async (name, { tz = 'UTC' } = {}) => {
      const r = await user(name, { timezone: tz });
      const m = await movie(name);
      await save(r, m);
      await cluster(r, m, 2, '2031-12-15T09:00:00Z');
      await arbitrate('2031-12-15T17:30:00Z');
      const [c] = await candidates(r, 'watchlist_social');
      assert.equal(c.state, 'selected', 'selected inside the evening window');
      return { r, c };
    };

    const dropped = async (r, iso, reason) => {
      const jobs = (await claimFor(r, iso)).filter((j) => j.proactive);
      assert.equal(jobs.length, 0, `no proactive job may be returned at ${iso}`);
      const [c] = await candidates(r, 'watchlist_social');
      assert.equal(c.state, 'expired', 'a timeliness failure is terminal');
      assert.equal(c.suppression_reason, reason);
      assert.ok(!(await outboxFor(r)).some((o) => o.notification_id === c.notification_id));
    };

    it('inside the window it claims normally', async () => {
      const { r } = await selected('tonight_ok');
      const jobs = (await claimFor(r, '2031-12-15T19:59:00Z')).filter((j) => j.proactive);
      assert.equal(jobs.length, 1);
      assert.equal((await candidates(r, 'watchlist_social'))[0].state, 'sent');
    });

    it('after the window closes the same evening', async () => {
      const { r } = await selected('tonight_late');
      await dropped(r, '2031-12-15T20:00:00Z', 'outside_window');
    });

    it('when a stalled drain recovers the next morning', async () => {
      const { r } = await selected('tonight_morning');
      await dropped(r, '2031-12-16T09:00:00Z', 'outside_window');
    });

    it('the next evening, inside the hours but not the evening it was chosen for', async () => {
      const { r } = await selected('tonight_nextday');
      await dropped(r, '2031-12-16T17:30:00Z', 'outside_window');
    });

    it('after expires_at, even inside the window', async () => {
      const { r, c } = await selected('tonight_expired');
      await t.sql(`update proactive_candidates set expires_at = '2031-12-15T17:40:00Z' where id = $1`, [c.id]);
      await dropped(r, '2031-12-15T17:45:00Z', 'expired');
    });

    it('in the reader\'s own zone, not UTC', async () => {
      // Kolkata is UTC+5:30: 17:30 local is 12:00Z, and 20:30 local is 15:00Z.
      const r = await user('tonight_kol', { timezone: 'Asia/Kolkata' });
      const m = await movie('Kolkata');
      await save(r, m);
      await cluster(r, m, 2, '2031-12-15T03:00:00Z');
      await arbitrate('2031-12-15T12:00:00Z');
      assert.equal((await candidates(r, 'watchlist_social'))[0].state, 'selected');
      await dropped(r, '2031-12-15T15:00:00Z', 'outside_window');
    });

    /**
     * Codex re-review, MAJOR. The claim's check ends at the claim; Expo would hold an
     * undelivered message for weeks. So every proactive job carries `deliver_by`, which
     * push-sender sends as the Expo expiration: the earlier of the candidate's expiry and
     * 20:00 local on the evening it was selected for.
     */
    const iso = (v) => new Date(v).toISOString();

    it('a job claimed inside the window carries 20:00 local that evening as its deadline', async () => {
      const { r } = await selected('deadline_utc');
      const [job] = (await claimFor(r, '2031-12-15T19:59:00Z')).filter((j) => j.proactive);
      assert.equal(iso(job.proactive.deliver_by), '2031-12-15T20:00:00.000Z');
    });

    it("the candidate's own expiry when that comes first", async () => {
      const { r, c } = await selected('deadline_exp');
      await t.sql(`update proactive_candidates set expires_at = '2031-12-15T17:50:00Z' where id = $1`, [c.id]);
      const [job] = (await claimFor(r, '2031-12-15T17:45:00Z')).filter((j) => j.proactive);
      assert.equal(iso(job.proactive.deliver_by), '2031-12-15T17:50:00.000Z');
    });

    it("20:00 in the reader's zone, not UTC", async () => {
      const r = await user('deadline_kol', { timezone: 'Asia/Kolkata' });
      const m = await movie('Deadline Kolkata');
      await save(r, m);
      await cluster(r, m, 2, '2031-12-15T03:00:00Z');
      await arbitrate('2031-12-15T12:00:00Z');
      const [job] = (await claimFor(r, '2031-12-15T12:05:00Z')).filter((j) => j.proactive);
      // 20:00 IST is 14:30Z.
      assert.equal(iso(job.proactive.deliver_by), '2031-12-15T14:30:00.000Z');
    });

    it('a reactive job carries no deadline of any kind', async () => {
      const r = await user('deadline_reactive');
      const f = await user('deadline_reactivef');
      await t.sql(
        `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
         values ($1, 'follow', $2, 'profile', $2)`,
        [r, f],
      );
      const [job] = await claimFor(r);
      assert.equal(job.type, 'follow');
      assert.equal(job.proactive, null);
    });

    it('a reactive push queued alongside is untouched by any of this', async () => {
      const { r } = await selected('tonight_reactive');
      const f = await user('tonight_reactivef');
      await t.sql(
        `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
         values ($1, 'follow', $2, 'profile', $2)`,
        [r, f],
      );
      const jobs = await claimFor(r, '2031-12-16T09:00:00Z');
      assert.deepEqual(jobs.map((j) => j.type), ['follow']);
    });
  });

  it('goal_completed: the claim now carries what its push copy needs', async () => {
    const r = await user('goal');
    await t.sql(
      `insert into notifications (recipient_id, type, payload)
       values ($1, 'goal_completed', '{"year": 2031, "category": "movies", "target": 50}')`,
      [r],
    );
    const jobs = await claimFor(r);
    assert.equal(jobs.length, 1, 'actorless, and still claimed');
    assert.deepEqual(jobs[0].goal, { year: 2031, category: 'movies', target: 50 });
  });
});

// ===========================================================================

describe('telemetry', () => {
  it('records the reader\'s own open once per channel, and nothing about anybody else\'s', async () => {
    const r = await user('open');
    const other = await user('openo');
    const m = await movie('Open');
    await save(r, m);
    await cluster(r, m, 2, '2031-12-22T09:00:00Z');
    await arbitrate('2031-12-22T17:30:00Z');
    const [c] = await candidates(r, 'watchlist_social');

    await t.asUser(r, () =>
      t.sql(`select record_notification_open($1, 'push', 'title')`, [c.notification_id]),
    );
    await t.asUser(r, () =>
      t.sql(`select record_notification_open($1, 'push', 'title')`, [c.notification_id]),
    );
    await t.asUser(r, () =>
      t.sql(`select record_notification_open($1, 'inbox', 'title')`, [c.notification_id]),
    );
    const answer = await t.asUser(other, () =>
      t.sql(`select record_notification_open($1, 'push', null) as r`, [c.notification_id]),
    );
    assert.deepEqual(answer.rows[0].r, { ok: true }, 'the same answer, so it is not an oracle');

    const { rows } = await t.sql(
      `select user_id, channel, candidate_id, kind, destination from notification_opens
        where notification_id = $1 order by channel`,
      [c.notification_id],
    );
    assert.deepEqual(
      rows.map((x) => [x.user_id, x.channel, x.candidate_id, x.kind]),
      [
        [r, 'inbox', c.id, 'watchlist_social'],
        [r, 'push', c.id, 'watchlist_social'],
      ],
    );
    assert.ok(await t.errorFrom(`select record_notification_open($1, 'sms', null)`, [c.notification_id]));
    assert.deepEqual(rows.map((x) => x.destination), ['title', 'title']);
  });

  it('stores only a closed destination vocabulary, never caller-supplied text', async () => {
    const r = await user('opendest');
    const f = await user('opendestf');
    const { rows: [n] } = await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2) returning id`,
      [r, f],
    );
    for (const bad of [`/u/${f}`, '/title/abc', 'title; drop table x', 'Title', 'x'.repeat(300)]) {
      const err = await t.asUser(r, () =>
        t.errorFrom(`select record_notification_open($1, 'inbox', $2)`, [n.id, bad]),
      );
      assert.ok(err, `${bad.slice(0, 20)} must be refused`);
    }
    await t.asUser(r, () => t.sql(`select record_notification_open($1, 'inbox', 'profile')`, [n.id]));
    const { rows } = await t.sql(`select destination from notification_opens where notification_id = $1`, [n.id]);
    assert.deepEqual(rows.map((x) => x.destination), ['profile']);
    // And the table itself refuses anything else, whoever writes it.
    assert.ok(
      await t.errorFrom(
        `insert into notification_opens (user_id, kind, channel, destination) values ($1, 'follow', 'push', '/u/me')`,
        [r],
      ),
    );
  });

  it('the operator views aggregate the ledger', async () => {
    const { rows } = await t.sql(`select * from proactive_summary`);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((x) => x.candidates > 0));
    const status = await one(`proactive_status()`);
    assert.equal(typeof status.push_enabled, 'boolean');
  });
});

// ===========================================================================

describe('privilege', () => {
  it('no client can read the ledger, the cluster, the opens or the operator views', async () => {
    const u = await user('nosy');
    for (const rel of [
      'proactive_candidates', 'proactive_cluster_actors', 'notification_opens',
      'proactive_summary', 'proactive_attribution',
    ]) {
      const err = await t.asUser(u, () => t.errorFrom(`select * from ${rel}`));
      assert.ok(err, `${rel} must be unreadable to authenticated`);
    }
  });

  it('no client can run the arbiter, a collector, the tick, or the cluster writer', async () => {
    const u = await user('forger');
    const victim = await user('victim');
    const m = await movie('Forged');
    for (const call of [
      `select _proactive_arbitrate(now())`,
      `select _proactive_tick(now())`,
      `select _proactive_theatrical_collect(now())`,
      `select _proactive_resurface_collect(now())`,
      `select _proactive_social_add('${victim}', '${u}', '${m}', gen_random_uuid(), now())`,
      `select schedule_proactive_notifications()`,
      `select proactive_status()`,
    ]) {
      const err = await t.asUser(u, () => t.errorFrom(call));
      assert.ok(err, `${call} must be refused`);
    }
  });

  it('a client cannot write feed_events directly, which is the only way into a cluster', async () => {
    const u = await user('direct');
    const m = await movie('Direct');
    const err = await t.asUser(u, () =>
      t.errorFrom(`insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2)`, [u, m]),
    );
    assert.ok(err);
  });
});
