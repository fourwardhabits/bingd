import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The watchlist_social pilot (20261130001100, docs/product/proactive-pilot-2026-11-22.md).
 *
 * Pinned here:
 *   · seeds: proactive.social_enabled and proactive.theatrical_enabled false,
 *     proactive.friend_min_affinity 1.5, proactive.pilot_recipients [], and every one of
 *     them fails closed;
 *   · a friend counts only above the affinity threshold: mutual follow alone, or mutual
 *     follow plus any amount of reacting, never does; a comment does;
 *   · the allowlist restricts creation of every type, revalidates at selection and the
 *     claim, and an empty list is the old behaviour;
 *   · the social switch stops creation and, already selected, the claim;
 *   · no backfill: activity from before the switch never joins a cluster;
 *   · the whole path for a listed reader: two qualifying friends, one inbox row, one
 *     outbox row at the evening window, a job to the capable device only, named friends.
 *
 * The trigger reads the real clock, so these fixtures do too, and the arbiter is asked at
 * the next 17:30 UTC (the readers' timezone is UTC).
 */

let t;
let seq = 0;

const one = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;
const setConfig = (key, value) =>
  t.sql(
    `insert into app_config (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );
const dropConfig = (key) => t.sql(`delete from app_config where key = $1`, [key]);

/** The next 17:30 UTC strictly after now, inside the readers' evening window. */
function nextEvening(daysLater = 0) {
  const d = new Date();
  d.setUTCHours(17, 30, 0, 0);
  if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + daysLater);
  return d.toISOString();
}

async function user(
  name,
  { device = true, version = 2, timezone = 'UTC', visibility = 'public' } = {},
) {
  const id = await t.createUser({ username: `${name}${(seq += 1)}`.slice(0, 20), visibility });
  await t.sql(`insert into account_context (user_id, timezone, region) values ($1, $2, 'US')`, [
    id,
    timezone,
  ]);
  if (device) await addDevice(id, 'main', version);
  return id;
}

async function addDevice(u, label, version = 2) {
  const token = `ExponentPushToken[${u}-${label}]`;
  await t.sql(
    `insert into device_tokens (user_id, token, platform, proactive_version) values ($1, $2, 'ios', $3)`,
    [u, token, version],
  );
  return token;
}

async function movie(title = 'Pilot') {
  seq += 1;
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, release_date, provenance)
     values ('movie', $1, $2, '2020-01-01', 'tmdb') returning id`,
    [1_830_000_000 + seq, `${title} ${seq}`],
  );
  return rows[0].id;
}

const follow = (a, b, state = 'approved') =>
  state === 'approved'
    ? t.sql(
        `insert into follows (follower_id, followee_id, state, approved_at)
         values ($1, $2, 'approved', now()) on conflict do nothing`,
        [a, b],
      )
    : t.sql(
        `insert into follows (follower_id, followee_id, state) values ($1, $2, 'pending') on conflict do nothing`,
        [a, b],
      );
const mutual = async (a, b) => {
  await follow(a, b);
  await follow(b, a);
};
const save = (u, m) =>
  t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [u, m]);

/** Something of `owner`'s for somebody to comment on or react to. */
async function post(owner) {
  const { rows } = await t.sql(
    `insert into feed_events (actor_id, type, media_item_id) values ($1, 'watchlist_added', $2) returning id`,
    [owner, await movie('Post')],
  );
  return rows[0].id;
}
/** The reader commented on the friend's activity today: affinity 0.5 + 2 = 2.5. */
const talk = async (reader, friend) =>
  t.sql(`insert into comments (feed_event_id, author_id, body) values ($1, $2, 'yes')`, [
    await post(friend),
    reader,
  ]);
/** Reactions on four different days, both ways: the reactions family at its cap of 1. */
async function reactALot(reader, friend) {
  for (let d = 0; d < 4; d += 1) {
    for (const [who, owner] of [
      [reader, friend],
      [friend, reader],
    ]) {
      for (const kind of ['love', 'funny']) {
        await t.sql(
          `insert into reactions (feed_event_id, user_id, kind, created_at)
           values ($1, $2, $3, now() - make_interval(days => $4))`,
          [await post(owner), who, kind, d],
        );
      }
    }
  }
}
/** A qualifying friend: mutual, and the reader talks to them. */
async function closeFriend(reader, name = 'cf') {
  const f = await user(name);
  await mutual(reader, f);
  await talk(reader, f);
  return f;
}

/** A ranking written now, which is what the trigger sees. */
const rank = async (actor, m) =>
  (
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2) returning id`,
      [actor, m],
    )
  ).rows[0].id;

const socialRows = async (u) =>
  (
    await t.sql(
      `select * from proactive_candidates where recipient_id = $1 and type = 'watchlist_social' order by created_at`,
      [u],
    )
  ).rows;
const inboxRows = async (u) =>
  (
    await t.sql(
      `select * from notifications where recipient_id = $1 and type = 'watchlist_social'`,
      [u],
    )
  ).rows;
const arbitrate = (iso) => one(`_proactive_arbitrate($1::timestamptz)`, [iso]);
const tick = (iso) => one(`_proactive_tick($1::timestamptz)`, [iso]);
const members = async (candidate, reader) =>
  (
    await t.sql(`select display_name from _proactive_social_actors($1, $2)`, [
      candidate,
      reader,
    ])
  ).rows.map((r) => r.display_name);

async function claimFor(u, iso) {
  const jobs = [];
  for (let i = 0; i < 10; i += 1) {
    const batch = await one(`claim_push_batch(100, $1::timestamptz)`, [iso]);
    if (!batch.length) break;
    jobs.push(...batch);
  }
  const { rows } = await t.sql(`select id from notifications where recipient_id = $1`, [u]);
  const mine = new Set(rows.map((r) => r.id));
  return jobs.filter((j) => mine.has(j.notification_id));
}

before(async () => {
  t = await createTestDb();
});

after(async () => t.close());

beforeEach(async () => {
  await setConfig('proactive.generation_enabled', true);
  await setConfig('proactive.push_enabled', true);
  await setConfig('proactive.social_enabled', true);
  await setConfig('proactive.theatrical_enabled', false);
  await setConfig('proactive.resurface_enabled', false);
  await setConfig('proactive.season_enabled', false);
  await setConfig('proactive.friend_min_affinity', 1.5);
  await setConfig('proactive.pilot_recipients', []);
});

// ===========================================================================

describe('seeds and switches', () => {
  it('ships the pilot keys dark: social and theatrical off, threshold 1.5, no allowlist', async () => {
    const fresh = await createTestDb();
    try {
      const { rows } = await fresh.sql(
        `select key, value from app_config where key like 'proactive.%'`,
      );
      const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      assert.equal(cfg['proactive.social_enabled'], false);
      assert.equal(cfg['proactive.theatrical_enabled'], false);
      assert.equal(cfg['proactive.friend_min_affinity'], 1.5);
      assert.deepEqual(cfg['proactive.pilot_recipients'], []);
      for (const key of [
        'generation_enabled',
        'push_enabled',
        'resurface_enabled',
        'season_enabled',
      ]) {
        assert.equal(cfg[`proactive.${key}`], false, key);
      }
      const status = (await fresh.sql(`select proactive_status() as s`)).rows[0].s;
      assert.equal(status.social_enabled, false);
      assert.equal(status.theatrical_enabled, false);
      assert.equal(Number(status.friend_min_affinity), 1.5);
      assert.deepEqual(status.pilot, { restricted: false, recipients: 0 });
    } finally {
      await fresh.close();
    }
  });

  it('each type switch is on only for the JSON boolean true', async () => {
    for (const key of ['social', 'theatrical']) {
      for (const value of ['true', 1, null, { on: true }]) {
        await setConfig(`proactive.${key}_enabled`, value);
        assert.equal(
          await one(`_proactive_${key}_enabled()`),
          false,
          `${key} ${JSON.stringify(value)}`,
        );
      }
      await dropConfig(`proactive.${key}_enabled`);
      assert.equal(await one(`_proactive_${key}_enabled()`), false, `${key} absent`);
      await setConfig(`proactive.${key}_enabled`, true);
      assert.equal(await one(`_proactive_${key}_enabled()`), true, key);
    }
  });

  it('the threshold must be a JSON number, or nobody qualifies; absent is 1.5', async () => {
    const r = await user('thr');
    const f = await closeFriend(r);
    assert.equal(await one(`_proactive_friend_qualifies($1, $2, now())`, [r, f]), true);
    for (const value of ['1.5', null, { v: 1 }, [1]]) {
      await setConfig('proactive.friend_min_affinity', value);
      assert.equal(await one(`_proactive_friend_min_affinity()`), null, JSON.stringify(value));
      assert.equal(
        await one(`_proactive_friend_qualifies($1, $2, now())`, [r, f]),
        false,
        JSON.stringify(value),
      );
    }
    await dropConfig('proactive.friend_min_affinity');
    assert.equal(Number(await one(`_proactive_friend_min_affinity()`)), 1.5);
  });

  it('the allowlist: empty or absent restricts nothing, a list restricts, anything malformed allows nobody', async () => {
    const a = await user('pla');
    const b = await user('plb');
    const allows = (u) => one(`_proactive_pilot_allows($1)`, [u]);
    assert.equal(await allows(a), true);
    await dropConfig('proactive.pilot_recipients');
    assert.equal(await allows(a), true, 'absent');
    await setConfig('proactive.pilot_recipients', [a.toUpperCase()]);
    assert.equal(await allows(a), true, 'listed, in either case');
    assert.equal(await allows(b), false, 'not listed');
    for (const value of [a, null, { id: a }, [a, 'not-a-uuid'], [a, 7]]) {
      await setConfig('proactive.pilot_recipients', value);
      assert.equal(await allows(a), false, JSON.stringify(value));
    }
    await setConfig('proactive.pilot_recipients', [a, b]);
    const status = await one(`proactive_status()`);
    assert.deepEqual(status.pilot, { restricted: true, recipients: 2 });
    assert.equal(
      JSON.stringify(status).includes(a),
      false,
      'the status never names an account',
    );
  });

  it('every new function is internal', async () => {
    const u = await user('grants');
    for (const q of [
      `select _proactive_social_enabled()`,
      `select _proactive_theatrical_enabled()`,
      `select _proactive_friend_min_affinity()`,
      `select _proactive_friend_qualifies(gen_random_uuid(), gen_random_uuid(), now())`,
      `select _proactive_pilot_recipients()`,
      `select _proactive_pilot_allows(gen_random_uuid())`,
    ]) {
      const asUser = await t.asUser(u, () => t.errorFrom(q));
      assert.match(asUser?.message ?? '', /permission denied/, q);
      const asAnon = await t.asAnon(() => t.errorFrom(q));
      assert.match(asAnon?.message ?? '', /permission denied/, q);
    }
  });
});

// ===========================================================================

describe('meaningful affinity, not mutual following alone', () => {
  it('two mutual friends who never interacted write nothing at all', async () => {
    const r = await user('bare');
    const m = await movie();
    await save(r, m);
    for (const n of ['b1', 'b2', 'b3']) {
      const f = await user(n);
      await mutual(r, f);
      await rank(f, m);
    }
    assert.equal((await socialRows(r)).length, 0);
    assert.equal((await inboxRows(r)).length, 0);
  });

  it('reactions alone never qualify a friend, however many', async () => {
    const r = await user('rx');
    const f = await user('rxf');
    await mutual(r, f);
    await reactALot(r, f);
    const score = Number(await one(`_proactive_affinity($1, $2, now())`, [r, f]));
    assert.ok(
      score > 1.4 && score <= 1.5,
      `mutual + capped reactions is at most 1.5 (${score})`,
    );
    assert.equal(await one(`_proactive_friend_qualifies($1, $2, now())`, [r, f]), false);
    const m = await movie();
    await save(r, m);
    await rank(f, m);
    assert.equal((await socialRows(r)).length, 0);
  });

  it('a friend the reader talks to joins; a second makes the push eligible', async () => {
    const r = await user('mx');
    const m = await movie();
    await save(r, m);
    const f1 = await closeFriend(r, 'mx1');
    const bare = await user('mxbare');
    await mutual(r, bare);
    await rank(f1, m);
    let [c] = await socialRows(r);
    assert.ok(c, 'one qualifying friend opens the cluster and its inbox row');
    assert.equal(c.eligible_at, null);
    assert.equal(c.last_block_reason, 'below_threshold');
    assert.equal((await inboxRows(r)).length, 1);

    await rank(bare, m);
    [c] = await socialRows(r);
    assert.equal(c.eligible_at, null, 'a non-qualifying friend does not count toward the two');
    assert.equal(
      Number(
        await one(`(select count(*) from proactive_cluster_actors where candidate_id = $1)`, [
          c.id,
        ]),
      ),
      1,
      'and is not even recorded',
    );

    const f2 = await closeFriend(r, 'mx2');
    await rank(f2, m);
    [c] = await socialRows(r);
    assert.notEqual(c.eligible_at, null, 'the second qualifying friend makes it eligible');
    assert.equal((await members(c.id, r)).length, 2);
    assert.equal(
      (await inboxRows(r)).length,
      1,
      'still one inbox row: aggregated, not one per ranking',
    );
  });

  it('a member who stops qualifying drops out of the count, the names and the push', async () => {
    const r = await user('decay');
    const m = await movie();
    await save(r, m);
    const f1 = await closeFriend(r, 'dc1');
    const f2 = await closeFriend(r, 'dc2');
    await rank(f1, m);
    await rank(f2, m);
    const [c] = await socialRows(r);
    assert.equal((await members(c.id, r)).length, 2);
    // As if the history had decayed: raise the bar above both.
    await setConfig('proactive.friend_min_affinity', 10);
    assert.equal((await members(c.id, r)).length, 0);
    assert.equal(await one(`_proactive_invalid($1, now())`, [c.id]), 'below_threshold');
  });

  it('a block ends the friend, and a private account the reader cannot see never counts', async () => {
    const r = await user('blk');
    const m = await movie();
    await save(r, m);
    const blocked = await closeFriend(r, 'blkf');
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [blocked, r]);
    await rank(blocked, m);
    // A private account that follows the reader, whose own approval the reader is still
    // waiting for: not mutual, not viewable.
    const priv = await user('priv', { visibility: 'private' });
    await follow(priv, r);
    await follow(r, priv, 'pending');
    await t.sql(`insert into comments (feed_event_id, author_id, body) values ($1, $2, 'hi')`, [
      await post(r),
      priv,
    ]);
    await rank(priv, m);
    assert.equal((await socialRows(r)).length, 0);
    assert.equal((await inboxRows(r)).length, 0);
  });

  it('Watchlist & discovery off writes nothing for a qualifying friend', async () => {
    const r = await user('off');
    await t.sql(
      `insert into notification_preferences (user_id, category, enabled) values ($1, 'watchlist_discovery', false)`,
      [r],
    );
    const m = await movie();
    await save(r, m);
    await rank(await closeFriend(r, 'off1'), m);
    await rank(await closeFriend(r, 'off2'), m);
    assert.equal((await socialRows(r)).length, 0);
    assert.equal((await inboxRows(r)).length, 0);
  });
});

// ===========================================================================

describe('the switches and no backfill', () => {
  it('generation on with the social switch off writes nothing', async () => {
    await setConfig('proactive.social_enabled', false);
    const r = await user('soff');
    const m = await movie();
    await save(r, m);
    await rank(await closeFriend(r, 'soff1'), m);
    await rank(await closeFriend(r, 'soff2'), m);
    assert.equal((await socialRows(r)).length, 0);
  });

  it('activity from before the switch never joins, and the first tick after it sends nothing', async () => {
    await setConfig('proactive.social_enabled', false);
    const r = await user('nobf');
    const m = await movie();
    await save(r, m);
    const f1 = await closeFriend(r, 'nobf1');
    const f2 = await closeFriend(r, 'nobf2');
    await rank(f1, m);
    await rank(f2, m);
    await setConfig('proactive.social_enabled', true);
    await tick(nextEvening());
    assert.equal((await socialRows(r)).length, 0, 'the week before is not evaluated');
    assert.equal(
      (await t.sql(`select 1 from push_outbox where recipient_id = $1`, [r])).rows.length,
      0,
    );
    // A row dated two days back, written now (a repair or a backfill), is ignored too.
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, created_at) values ($1, 'title_ranked', $2, now() - interval '2 days')`,
      [await closeFriend(r, 'nobf3'), m],
    );
    assert.equal((await socialRows(r)).length, 0);
    // The next ranking after the switch starts a cluster of one, counted from now.
    await rank(f1, m);
    const [c] = await socialRows(r);
    assert.equal(c.eligible_at, null, 'one friend, not three');
    assert.equal((await members(c.id, r)).length, 1);
  });

  it('theatrical stays dark while generation is on, until its own switch is', async () => {
    const r = await user('thd');
    const m = await movie('Opening');
    await save(r, m);
    // A T-7 armed event, as the release-awareness state machine leaves one.
    const opens = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await t.sql(
      `insert into release_subjects (media_item_id, subject_kind, next_check_at) values ($1, 'movie', now())`,
      [m],
    );
    const subject = m;
    await t.sql(
      `insert into release_events (media_item_id, subject_id, event_kind, region, state, scheduled_date,
                                   evaluation, evaluated_at, first_observed_at, last_observed_at)
       values ($1, $2, 'theatrical_release', 'US', 'scheduled', $3::date, 'done', now(), now(), now())`,
      [m, subject, opens],
    );
    await tick(new Date().toISOString());
    assert.equal(
      (await t.sql(`select 1 from proactive_candidates where recipient_id = $1`, [r])).rows
        .length,
      0,
    );
    await setConfig('proactive.theatrical_enabled', true);
    await tick(new Date().toISOString());
    assert.equal(
      (
        await t.sql(
          `select 1 from proactive_candidates where recipient_id = $1 and type = 'theatrical_release'`,
          [r],
        )
      ).rows.length,
      1,
      'the switch is what was holding it',
    );
  });

  it('the social switch off drops a selected cluster at the claim, and reactive is untouched', async () => {
    const r = await user('ssel');
    const m = await movie();
    await save(r, m);
    await rank(await closeFriend(r, 'ssel1'), m);
    await rank(await closeFriend(r, 'ssel2'), m);
    const evening = nextEvening();
    await arbitrate(evening);
    let [c] = await socialRows(r);
    assert.equal(c.state, 'selected');
    await setConfig('proactive.social_enabled', false);
    assert.deepEqual(await claimFor(r, evening), []);
    [c] = await socialRows(r);
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'social_disabled');
  });
});

// ===========================================================================

describe('the allowlist', () => {
  it('a ranking reaches only listed readers, of every watchlister it could reach', async () => {
    const listed = await user('in');
    const other = await user('out');
    const m = await movie();
    await save(listed, m);
    await save(other, m);
    await setConfig('proactive.pilot_recipients', [listed]);
    const f = await user('both');
    for (const reader of [listed, other]) {
      await mutual(reader, f);
      await talk(reader, f);
    }
    await rank(f, m);
    assert.equal((await socialRows(listed)).length, 1);
    assert.equal((await socialRows(other)).length, 0);
    assert.equal((await inboxRows(other)).length, 0);
  });

  it('the ledger refuses an unlisted recipient whoever writes, and no inbox row follows', async () => {
    const listed = await user('lin');
    const other = await user('lout');
    await setConfig('proactive.pilot_recipients', [listed]);
    const m = await movie();
    const write = (u) =>
      t.sql(
        `insert into proactive_candidates (recipient_id, type, dedupe_key, media_item_id, priority, created_at, expires_at)
         values ($1, 'watchlist_resurface', 'x', $2, 4, now(), now() + interval '1 day') returning id`,
        [u, m],
      );
    assert.equal((await write(other)).rows.length, 0);
    assert.equal((await write(listed)).rows.length, 1);
    // The social writer reads the dropped row as already decided, and writes no inbox row.
    await save(other, m);
    const f = await closeFriend(other, 'loutf');
    const ev = await rank(f, m);
    assert.equal(
      await one(`_proactive_social_add($1, $2, $3, $4, now())`, [other, f, m, ev]),
      'raced',
    );
    assert.equal((await inboxRows(other)).length, 0);
  });

  it('a reader taken off the list is dropped at the claim, and a listed one still sent', async () => {
    const a = await user('offl');
    const b = await user('offl2');
    const m = await movie();
    const mb = await movie();
    await save(a, m);
    await save(b, mb);
    await setConfig('proactive.pilot_recipients', [a, b]);
    await rank(await closeFriend(a, 'ofa1'), m);
    await rank(await closeFriend(a, 'ofa2'), m);
    await rank(await closeFriend(b, 'ofb1'), mb);
    await rank(await closeFriend(b, 'ofb2'), mb);
    const evening = nextEvening();
    await arbitrate(evening);
    assert.equal((await socialRows(a))[0].state, 'selected');
    assert.equal((await socialRows(b))[0].state, 'selected');
    await setConfig('proactive.pilot_recipients', [b]);
    const jobs = await one(`claim_push_batch(100, $1::timestamptz)`, [evening]);
    const forA = (await inboxRows(a)).map((n) => n.id);
    const forB = (await inboxRows(b)).map((n) => n.id);
    assert.equal(
      jobs.filter((j) => forA.includes(j.notification_id)).length,
      0,
      'a is off the list: no push',
    );
    assert.equal(
      jobs.filter((j) => forB.includes(j.notification_id)).length,
      1,
      'b is still listed and gets the push',
    );
    const [ca] = await socialRows(a);
    assert.equal(ca.state, 'suppressed');
    assert.equal(ca.suppression_reason, 'outside_pilot');
  });

  it('a pending candidate outside the list is suppressed by the arbiter', async () => {
    const a = await user('arbl');
    const m = await movie();
    await save(a, m);
    await rank(await closeFriend(a, 'arb1'), m);
    await rank(await closeFriend(a, 'arb2'), m);
    await setConfig('proactive.pilot_recipients', [await user('someoneelse')]);
    await arbitrate(nextEvening());
    const [c] = await socialRows(a);
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'outside_pilot');
  });
});

// ===========================================================================

describe('the pilot, end to end', () => {
  it('two qualifying friends: one inbox row, one push at the evening window, to the capable device only', async () => {
    const r = await user('e2e');
    const oldToken = await addDevice(r, 'old-tablet', null);
    await setConfig('proactive.pilot_recipients', [r]);
    const m = await movie('Dune');
    await save(r, m);
    const f1 = await closeFriend(r, 'ravi');
    const f2 = await closeFriend(r, 'eric');
    await rank(f1, m);
    await rank(f2, m);

    const [cand] = await socialRows(r);
    assert.notEqual(cand.eligible_at, null);
    const evening = nextEvening();
    // After 20:00 the window holds it: quiet hours.
    await arbitrate(new Date(new Date(evening).getTime() + 3 * 3_600_000).toISOString());
    let [c] = await socialRows(r);
    assert.equal(c.state, 'pending');
    assert.equal(c.last_block_reason, 'quiet_window');
    await arbitrate(evening);
    [c] = await socialRows(r);
    assert.equal(c.state, 'selected');
    const outbox = (await t.sql(`select * from push_outbox where recipient_id = $1`, [r])).rows;
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].notification_id, c.notification_id);

    const jobs = await claimFor(r, evening);
    assert.equal(jobs.length, 1);
    const job = jobs[0];
    assert.equal(job.type, 'watchlist_social');
    assert.equal(job.media_item_id, m);
    assert.equal(job.proactive.type, 'watchlist_social');
    assert.equal(job.proactive.actor_count, 2);
    assert.equal(job.proactive.actor_names.length, 2);
    assert.ok(job.proactive.deliver_by, 'a provider deadline');
    assert.deepEqual(
      job.tokens.map((d) => d.token),
      [`ExponentPushToken[${r}-main]`],
      'never the old build',
    );
    assert.ok(!job.tokens.some((d) => d.token === oldToken));
    [c] = await socialRows(r);
    assert.equal(c.state, 'sent');
    assert.equal(c.actor_count_at_send, 2);

    // Dedup: a third friend updates the inbox row and sends nothing more.
    await rank(await closeFriend(r, 'mo'), m);
    await arbitrate(evening);
    assert.deepEqual(await claimFor(r, evening), []);
    assert.equal((await inboxRows(r)).length, 1);
    assert.equal((await members(c.id, r)).length, 3);
  });

  it('the daily cap holds: a second cluster the same evening waits', async () => {
    const r = await user('cap');
    await setConfig('proactive.pilot_recipients', [r]);
    const m1 = await movie('One');
    const m2 = await movie('Two');
    await save(r, m1);
    await save(r, m2);
    const f1 = await closeFriend(r, 'cap1');
    const f2 = await closeFriend(r, 'cap2');
    for (const m of [m1, m2]) {
      await rank(f1, m);
      // One qualifying event per transaction: each ranking is its own statement here.
      await rank(f2, m);
    }
    const evening = nextEvening();
    await arbitrate(evening);
    const rows = await socialRows(r);
    assert.equal(rows.filter((c) => c.state === 'selected').length, 1);
    const held = rows.find((c) => c.state === 'pending');
    assert.equal(held.last_block_reason, 'higher_priority_selected');
    await claimFor(r, evening);
    await arbitrate(new Date(new Date(evening).getTime() + 30 * 60_000).toISOString());
    const later = (await socialRows(r)).find((c) => c.id === held.id);
    assert.equal(later.last_block_reason, 'daily_cap');
  });

  it('an old client gets no push; no device (permission never granted) means the inbox row only', async () => {
    const old = await user('oldc', { version: 1 });
    const denied = await user('nodev', { device: false });
    await setConfig('proactive.pilot_recipients', [old, denied]);
    for (const r of [old, denied]) {
      const m = await movie();
      await save(r, m);
      await rank(await closeFriend(r, 'oc1'), m);
      await rank(await closeFriend(r, 'oc2'), m);
    }
    const evening = nextEvening();
    await arbitrate(evening);
    const [co] = await socialRows(old);
    assert.equal(co.state, 'pending');
    assert.equal(co.last_block_reason, 'client_unsupported');
    const [cd] = await socialRows(denied);
    assert.equal(cd.state, 'pending');
    assert.equal(cd.last_block_reason, 'no_device');
    assert.equal((await inboxRows(denied)).length, 1, 'the inbox row is there');
    assert.equal(
      (await t.sql(`select 1 from push_outbox where recipient_id = any($1)`, [[old, denied]]))
        .rows.length,
      0,
    );
  });

  it('the kill switch still stops it at the claim', async () => {
    const r = await user('kill');
    await setConfig('proactive.pilot_recipients', [r]);
    const m = await movie();
    await save(r, m);
    await rank(await closeFriend(r, 'k1'), m);
    await rank(await closeFriend(r, 'k2'), m);
    const evening = nextEvening();
    await arbitrate(evening);
    await setConfig('proactive.push_enabled', false);
    assert.deepEqual(await claimFor(r, evening), []);
    const [c] = await socialRows(r);
    assert.equal(c.state, 'suppressed');
    assert.equal(c.suppression_reason, 'kill_switch');
  });
});
