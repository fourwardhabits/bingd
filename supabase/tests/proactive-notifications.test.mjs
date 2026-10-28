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
const uuid = async () => one(`gen_random_uuid()`);

const setConfig = (key, value) =>
  t.sql(
    `insert into app_config (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );

async function user(name, { timezone = 'UTC', region = 'US', device = true, version = 1 } = {}) {
  const id = await t.createUser({ username: `${name}${(seq += 1)}`.slice(0, 20) });
  if (timezone !== undefined || region !== undefined) {
    await t.sql(
      `insert into account_context (user_id, timezone, region, proactive_client_version)
       values ($1, $2, $3, $4)`,
      [id, timezone, region, version],
    );
  }
  if (device) {
    await t.sql(`insert into device_tokens (user_id, token, platform) values ($1, $2, 'ios')`, [
      id,
      `ExponentPushToken[${id}]`,
    ]);
  }
  return id;
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

/** Claims everything queued and returns the jobs for one recipient's notifications. */
async function claimFor(u) {
  const jobs = [];
  for (let i = 0; i < 10; i += 1) {
    const batch = await one(`claim_push_batch(100)`);
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
      assert.equal(cfg['proactive.window_start_hour'], 17);
      assert.equal(cfg['proactive.window_end_hour'], 20);
      assert.equal(cfg['proactive.daily_cap'], 1);
      assert.equal(cfg['proactive.weekly_cap'], 2);
      assert.equal(cfg['proactive.type_cooldown_hours'], 72);
      assert.equal(cfg['proactive.title_cooldown_days'], 7);
      assert.equal(cfg['proactive.resurface_cooldown_days'], 7);
      assert.deepEqual(cfg['proactive.priority'], {
        theatrical_release: 1,
        watchlist_social: 2,
        watchlist_resurface: 3,
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
    assert.ok(rows.every((r) => r.enabled === true));
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
    const [c] = await candidates(u, 'watchlist_social');
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'preference_off');
    assert.equal(c.notification_id, null);
    assert.equal((await inbox(u)).length, 0, 'switched off means no inbox row either');
  });

  it('report_device_context still answers a two-argument call, and records the version', async () => {
    const u = await user('ctx', { timezone: null, region: null, version: null });
    await t.actAs(u);
    await t.sql(`select report_device_context('Europe/London', 'GB')`);
    let { rows } = await t.sql(`select * from account_context where user_id = $1`, [u]);
    assert.equal(rows[0].proactive_client_version, null, 'an old build reports no capability');
    await t.sql(`select report_device_context('Europe/London', 'GB', 1)`);
    ({ rows } = await t.sql(`select * from account_context where user_id = $1`, [u]));
    assert.equal(rows[0].proactive_client_version, 1);
    await t.sql(`select report_device_context('Europe/London', 'GB', 9999)`);
    ({ rows } = await t.sql(`select * from account_context where user_id = $1`, [u]));
    assert.equal(rows[0].proactive_client_version, null, 'an out-of-range claim is no claim');
    await t.actAs(null);
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

    const jobs = (await claimFor(r)).filter((j) => j.proactive);
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
    const jobs = (await claimFor(r)).filter((j) => j.proactive);
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

    const jobs = (await claimFor(r)).filter((j) => j.proactive);
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
    const jobs = (await claimFor(r)).filter((j) => j.proactive);
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
      t.sql(`select record_notification_open($1, 'push', '/title/x')`, [c.notification_id]),
    );
    await t.asUser(r, () =>
      t.sql(`select record_notification_open($1, 'push', '/title/x')`, [c.notification_id]),
    );
    await t.asUser(r, () =>
      t.sql(`select record_notification_open($1, 'inbox', '/title/x')`, [c.notification_id]),
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
