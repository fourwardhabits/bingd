import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Affinity notifications, B1: 20261112000100.
 *
 *   · `_proactive_affinity` answers 0 for a pair either of whom has blocked the other, and
 *     for a pair either of whom is not active, whatever their history. The weights are
 *     untouched: an unblocked, active pair scores exactly what 20261031000100 pinned.
 *   · Lifting a block lets the history count again inside the 90-day window (recorded as a
 *     founder decision, not a guarantee).
 *   · `proactive_affinity_distribution` is service-role only, samples mutual pairs only, and
 *     returns aggregates: no pair, no id, no single person's value.
 *   · Neither function, nor the renamed original, is executable by a client.
 */

let t;
let seq = 0;

// The distribution scores at the database's now(), so its history is dated from the real clock.
let NOW = '2031-06-01T12:00:00Z';
const at = (iso) => new Date(iso).toISOString();
const daysAgo = (d) => new Date(new Date(NOW).getTime() - d * 86_400_000).toISOString();
const one = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;
const affinity = (r, a) => one(`_proactive_affinity($1, $2, $3::timestamptz)`, [r, a, at(NOW)]).then(Number);

const user = () => t.createUser({ username: `guard${(seq += 1)}` });

async function movie() {
  seq += 1;
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, provenance) values ('movie', $1, $2, 'tmdb') returning id`,
    [1_820_000_000 + seq, `Guarded ${seq}`],
  );
  return rows[0].id;
}

const follow = (a, b) =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, 'approved', now()) on conflict do nothing`,
    [a, b],
  );

async function friends(a, b) {
  await follow(a, b);
  await follow(b, a);
}

async function post(owner) {
  const { rows } = await t.sql(
    `insert into feed_events (actor_id, type, media_item_id) values ($1, 'watchlist_added', $2) returning id`,
    [owner, await movie()],
  );
  return rows[0].id;
}

const comment = async (author, event, iso) =>
  t.sql(`insert into comments (feed_event_id, author_id, body, created_at) values ($1, $2, 'hi', $3)`, [
    event,
    author,
    at(iso),
  ]);

/** A pair with history in every family the guard has to override. */
async function closePair() {
  const r = await user();
  const a = await user();
  await friends(r, a);
  await comment(r, await post(a), daysAgo(2));
  await comment(a, await post(r), daysAgo(3));
  await t.sql(
    `insert into title_recommendations (sender_id, recipient_id, media_item_id, created_at, state, fulfilled_at)
     values ($1, $2, $3, $4, 'delivered', $4)`,
    [r, a, await movie(), at(daysAgo(1))],
  );
  await t.sql(`insert into watch_tags (tagger_id, tagged_id, media_item_id, created_at) values ($1, $2, $3, $4)`, [
    a,
    r,
    await movie(),
    at(daysAgo(4)),
  ]);
  await t.sql(`insert into reactions (feed_event_id, user_id, kind, created_at) values ($1, $2, 'love', $3)`, [
    await post(a),
    r,
    at(daysAgo(1)),
  ]);
  return { r, a };
}

before(async () => {
  t = await createTestDb();
});

after(async () => t.close());

beforeEach(async () => {
  await t.sql(`delete from blocks`);
});

describe('_proactive_affinity: a block ends it', () => {
  it('an unblocked, active pair keeps exactly the pinned score', async () => {
    const { r, a } = await closePair();
    const raw = Number(await one(`_proactive_affinity_unguarded($1, $2, $3::timestamptz)`, [r, a, at(NOW)]));
    assert.ok(raw > 6, `history in every family scores well above the baseline (${raw})`);
    assert.equal(await affinity(r, a), raw);
  });

  it('answers 0 when the reader has blocked the friend, and when the friend has blocked the reader', async () => {
    const one = await closePair();
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [one.r, one.a]);
    assert.equal(await affinity(one.r, one.a), 0);
    assert.equal(await affinity(one.a, one.r), 0);

    const two = await closePair();
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [two.a, two.r]);
    assert.equal(await affinity(two.r, two.a), 0);
    assert.equal(await affinity(two.a, two.r), 0);
  });

  it('holds even with no follow between them, where the old score still counted history', async () => {
    const { r, a } = await closePair();
    await t.sql(`delete from follows where (follower_id, followee_id) in (($1, $2), ($2, $1))`, [r, a]);
    const unfollowed = await affinity(r, a);
    assert.ok(unfollowed > 0, 'history without a follow still scores (the follow is only +0.25 each way)');
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [a, r]);
    assert.equal(await affinity(r, a), 0);
  });

  it('a block between one of them and a third person changes nothing between the two', async () => {
    const { r, a } = await closePair();
    const before = await affinity(r, a);
    const third = await user();
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [r, third]);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [third, a]);
    assert.equal(await affinity(r, a), before);
  });

  it('lifting the block lets the history inside the window count again (founder decision)', async () => {
    const { r, a } = await closePair();
    const before = await affinity(r, a);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [r, a]);
    assert.equal(await affinity(r, a), 0);
    await t.sql(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [r, a]);
    assert.equal(await affinity(r, a), before);
  });

  it('answers 0 while either account is suspended', async () => {
    const { r, a } = await closePair();
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [a]);
    assert.equal(await affinity(r, a), 0);
    assert.equal(await affinity(a, r), 0);
    await t.sql(`update profiles set status = 'active' where id = $1`, [a]);
    assert.ok((await affinity(r, a)) > 0);
  });

  it('self, null and an unknown account are 0', async () => {
    const { r } = await closePair();
    assert.equal(await affinity(r, r), 0);
    assert.equal(Number(await one(`_proactive_affinity(null, $1, $2::timestamptz)`, [r, at(NOW)])), 0);
    assert.equal(
      Number(await one(`_proactive_affinity($1, gen_random_uuid(), $2::timestamptz)`, [r, at(NOW)])),
      0,
    );
  });

  it('the guard applies where the social path ranks friends', async () => {
    const { r, a } = await closePair();
    const candidate = await clusterWith(r, a);
    const ranked = async () =>
      (
        await t.sql(
          `select actor_id, affinity from _proactive_ranked_social_actors($1, $2, $3::timestamptz)`,
          [candidate, r, at(NOW)],
        )
      ).rows;
    const before = await ranked();
    assert.equal(before.length, 1);
    assert.ok(Number(before[0].affinity) > 0);
    // The ranking already drops a blocked friend (can_view_profile in _proactive_social_actors);
    // the guard is what keeps the score itself honest for any caller that does not.
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [a, r]);
    assert.equal((await ranked()).length, 0);
  });
});

/** A pending social candidate for `recipient` whose cluster holds `actor`. */
async function clusterWith(recipient, actor) {
  const m = await movie();
  const { rows } = await t.sql(
    `insert into proactive_candidates
       (recipient_id, type, media_item_id, dedupe_key, priority, created_at, expires_at, window_ends_at)
     values ($1, 'watchlist_social', $2, $3, 1, $4, $5, $5) returning id`,
    [recipient, m, `guard:${seq}`, at(daysAgo(1)), at(daysAgo(-6))],
  );
  await t.sql(`insert into proactive_cluster_actors (candidate_id, actor_id, feed_event_id, joined_at) values ($1, $2, $3, $4)`, [
    rows[0].id,
    actor,
    await post(actor),
    at(daysAgo(1)),
  ]);
  return rows[0].id;
}

describe('proactive_affinity_distribution', () => {
  it('only the service role may run it; nothing here is executable by a client', async () => {
    const u = await user();
    for (const q of [
      `select proactive_affinity_distribution(100)`,
      `select _proactive_affinity_unguarded(gen_random_uuid(), gen_random_uuid(), now())`,
      `select _proactive_affinity(gen_random_uuid(), gen_random_uuid(), now())`,
    ]) {
      const asUser = await t.asUser(u, () => t.errorFrom(q));
      assert.match(asUser?.message ?? '', /permission denied/, q);
      const asAnon = await t.asAnon(() => t.errorFrom(q));
      assert.match(asAnon?.message ?? '', /permission denied/, q);
    }
    const ok = await t.asRole('service_role', null, () => t.errorFrom(`select proactive_affinity_distribution(100)`));
    assert.equal(ok, null);
  });

  it('samples mutual pairs only and returns aggregates without an id', async () => {
    await t.sql(`delete from follows`);
    const pinned = NOW;
    NOW = new Date().toISOString();
    const close = await closePair().finally(() => {
      NOW = pinned;
    }); // two directed mutual rows, well above baseline
    const r = await user();
    const a = await user();
    await friends(r, a); // two directed rows at the 0.5 baseline
    const lonely = await user();
    await follow(lonely, r); // one-way: never sampled

    const { rows } = await t.sql(`select proactive_affinity_distribution(50) as d`);
    const d = rows[0].d;
    assert.equal(Number(d.pairs), 4);
    assert.deepEqual(Object.keys(d).sort(), [
      'baseline_only',
      'computed_at',
      'mean',
      'pairs',
      'quantiles',
      'sample_percent',
      'share_at_least',
    ]);
    assert.equal(Number(d.baseline_only), 0.5);
    assert.equal(Number(d.quantiles.p50) > 0.5, true);
    assert.equal(Number(d.share_at_least['1.5']), 0.5);
    const text = JSON.stringify(d);
    for (const id of [close.r, close.a, r, a, lonely]) assert.equal(text.includes(id), false);
  });

  it('bounds the sample it is asked for', async () => {
    const { rows } = await t.sql(`select proactive_affinity_distribution(1000000) as big, proactive_affinity_distribution(-5) as small`);
    assert.ok(Number(rows[0].big.pairs) <= 20000);
    assert.ok(Number(rows[0].small.pairs) <= 50);
  });
});
