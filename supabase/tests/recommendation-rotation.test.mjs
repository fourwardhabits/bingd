import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * For You rotation and the social candidate source — `20260828000500`.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THINGS WORTH PINNING HERE
 *
 * **That an impression is idempotent by shape.** The founder's instruction is not to
 * record a write per render, and the client's "only when the delivered set changes" rule
 * is a promise a client bug can break. The hour-truncated primary key is the guarantee
 * that survives one: a hundred calls in a minute insert one row per title. That is what
 * these tests assert, because it is the property the design rests on rather than the one
 * the client currently happens to have.
 *
 * **That the social source returns ids and never people.** `rank.ts` forbids the client
 * being given other users' rankings, because a client holding them can fabricate social
 * proof. `social_candidates` widens the pool without relaxing that: every endorser passes
 * `can_view_profile`, the aggregation happens server-side, and the shape that comes back
 * is `(media_item_id, endorsements)`. The column list is asserted, not described.
 */

let t;
let seq = 93000;

const shown = (who, ids) =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select note_recommendations_shown($1::uuid[]) as r`, [ids]);
    return rows[0].r;
  });

const exposure = (who) =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select * from recommendation_exposure() order by shown_count desc`);
    return rows;
  });

const candidates = (who, limit = 40) =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select * from social_candidates($1)`, [limit]);
    return rows;
  });

const follow = (a, b, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, $3)
     on conflict (follower_id, followee_id) do update set state = excluded.state`,
    [a, b, state],
  );

const rank = (user, item, bucket = 'loved', position = 1) =>
  t.sql(
    `insert into rankings (user_id, media_item_id, category, bucket, position)
     values ($1, $2, 'movies', $3::taste_bucket, $4)
     on conflict (user_id, media_item_id) do update set bucket = excluded.bucket`,
    [user, item, bucket, position],
  );

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------

describe('recording that a title was shown', () => {
  let alice;
  let a;
  let b;

  before(async () => {
    alice = await t.createUser({ username: 'rr_alice' });
    a = await t.createMovie('Shown A', seq++);
    b = await t.createMovie('Shown B', seq++);
  });

  beforeEach(() => t.sql(`delete from recommendation_impressions`));

  it('records a slate', async () => {
    const result = await shown(alice, [a, b]);
    assert.equal(result.status, 'ok');
    assert.equal(result.recorded, 2);

    const rows = await exposure(alice);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].shown_count, 1);
  });

  it('records the same slate again as nothing, within the hour', async () => {
    // The founder's "do not write on every render", enforced by the key rather than by
    // the caller's discipline.
    await shown(alice, [a, b]);
    const again = await shown(alice, [a, b]);
    assert.equal(again.recorded, 0);
    assert.equal((await exposure(alice)).length, 2);
  });

  it('survives a render loop without growing', async () => {
    for (let i = 0; i < 25; i += 1) await shown(alice, [a, b]);
    const { rows } = await t.sql(
      `select count(*)::int as n from recommendation_impressions where user_id = $1`,
      [alice],
    );
    assert.equal(rows[0].n, 2, 'one row per title per hour, whatever the client does');
  });

  it('counts a later hour separately', async () => {
    await shown(alice, [a]);
    // Age the row by two hours, which is what a second session tomorrow looks like from
    // the key's point of view.
    await t.sql(
      `update recommendation_impressions set shown_at = shown_at - interval '2 hours'
        where user_id = $1`,
      [alice],
    );
    await shown(alice, [a]);
    assert.equal((await exposure(alice))[0].shown_count, 2);
  });

  it('ignores an id that names nothing rather than failing the batch', async () => {
    const { rows } = await t.sql(`select gen_random_uuid() as id`);
    const result = await shown(alice, [a, rows[0].id, b]);
    assert.equal(result.recorded, 2);
  });

  it('accepts an empty list', async () => {
    const result = await shown(alice, []);
    assert.equal(result.recorded, 0);
  });

  it('refuses an oversized batch', async () => {
    const many = [];
    for (let i = 0; i < 70; i += 1) many.push(a);
    const error = await t.asUser(alice, () =>
      t.errorFrom(`select note_recommendations_shown($1::uuid[])`, [many]),
    );
    assert.equal(error?.code, '22023');
  });
});

// ---------------------------------------------------------------------------

describe('the cooldown window, and why nothing is hidden for ever', () => {
  let alice;
  let film;

  before(async () => {
    alice = await t.createUser({ username: 'rr_cooldown' });
    film = await t.createMovie('Cools Off', seq++);
  });

  beforeEach(() => t.sql(`delete from recommendation_impressions`));

  it('drops an impression older than the window', async () => {
    await shown(alice, [film]);
    assert.equal((await exposure(alice)).length, 1);

    await t.sql(
      `update recommendation_impressions set shown_at = shown_at - interval '80 hours'
        where user_id = $1`,
      [alice],
    );
    assert.deepEqual(await exposure(alice), [], 'a strong candidate must be able to return');
  });

  it('keeps one inside the window', async () => {
    await shown(alice, [film]);
    await t.sql(
      `update recommendation_impressions set shown_at = shown_at - interval '40 hours'
        where user_id = $1`,
      [alice],
    );
    assert.equal((await exposure(alice)).length, 1);
  });

  it('follows the configured window rather than a constant', async () => {
    await shown(alice, [film]);
    await t.sql(
      `update recommendation_impressions set shown_at = shown_at - interval '40 hours'
        where user_id = $1`,
      [alice],
    );
    await t.sql(`update app_config set value = '12'::jsonb where key = 'foryou.impression_window_hours'`);
    try {
      assert.deepEqual(await exposure(alice), []);
    } finally {
      await t.sql(
        `update app_config set value = '72'::jsonb where key = 'foryou.impression_window_hours'`,
      );
    }
  });

  it('is not a dismissal, and does not become one', async () => {
    // Two mechanisms for two questions. A dismissal is a veto with no expiry; an
    // impression is a preference over ordering. Collapsing them would make "I have seen
    // this a lot" eventually mean "never show me this".
    await shown(alice, [film]);
    const { rows } = await t.sql(
      `select count(*)::int as n from recommendation_feedback where user_id = $1`,
      [alice],
    );
    assert.equal(rows[0].n, 0);
  });
});

// ---------------------------------------------------------------------------

describe('exposure is the caller’s own and nobody else’s', () => {
  let alice;
  let bob;
  let film;

  before(async () => {
    alice = await t.createUser({ username: 'rr_mine' });
    bob = await t.createUser({ username: 'rr_theirs' });
    film = await t.createMovie('Only Mine', seq++);
  });

  it('does not show one account another’s impressions', async () => {
    await shown(alice, [film]);
    assert.deepEqual(await exposure(bob), []);
  });

  it('leaves the table unreadable directly, even to the person whose rows they are', async () => {
    /**
     * RLS on with **no select policy at all**, which its own migration calls "a
     * server-side signal, not user content". The definer reader is the only shape of it
     * a client gets.
     *
     * Asserted as *no rows* rather than as an error, and the distinction is the trap
     * this codebase has been caught by before: row security denies by returning nothing,
     * not by raising. A test written as `errorFrom(...)` would pass against a table with
     * a wide-open policy and no rows in it, and fail against this one — which is the
     * wrong way round in both directions.
     */
    await shown(alice, [film]);
    const direct = await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select * from recommendation_impressions`);
      return rows;
    });
    assert.deepEqual(direct, [], 'the table itself must stay closed');

    // And the definer reader does see them, so the emptiness above is the policy rather
    // than an empty table.
    assert.equal((await exposure(alice)).length, 1);
  });

  it('tells an anonymous caller nothing', async () => {
    assert.ok(await t.asAnon(() => t.errorFrom(`select * from recommendation_exposure()`)));
    assert.ok(
      await t.asAnon(() => t.errorFrom(`select note_recommendations_shown(array[]::uuid[])`)),
    );
  });
});

// ---------------------------------------------------------------------------

describe('social candidates', () => {
  let me;
  let friendA;
  let friendB;
  let stranger;
  let loved;
  let alsoLoved;
  let merelyFine;

  before(async () => {
    me = await t.createUser({ username: 'sc_me' });
    friendA = await t.createUser({ username: 'sc_friend_a' });
    friendB = await t.createUser({ username: 'sc_friend_b' });
    stranger = await t.createUser({ username: 'sc_stranger' });

    loved = await t.createMovie('Both Loved It', seq++);
    alsoLoved = await t.createMovie('One Loved It', seq++);
    merelyFine = await t.createMovie('Merely Fine', seq++);

    await follow(me, friendA);
    await follow(me, friendB);
  });

  beforeEach(async () => {
    await t.sql(`delete from rankings where user_id in ($1, $2, $3, $4)`, [
      me,
      friendA,
      friendB,
      stranger,
    ]);
    await t.sql(`delete from user_media where user_id = $1`, [me]);
    await t.sql(`delete from watchlist where user_id = $1`, [me]);
    await t.sql(`delete from recommendation_feedback where user_id = $1`, [me]);
  });

  it('suggests what the people you follow put in their top band', async () => {
    await rank(friendA, loved, 'loved', 1);
    await rank(friendB, loved, 'loved', 1);
    await rank(friendA, alsoLoved, 'loved', 2);

    const rows = await candidates(me);
    assert.deepEqual(
      rows.map((r) => r.media_item_id),
      [loved, alsoLoved],
      'most endorsements first',
    );
    assert.equal(rows[0].endorsements, 2);
  });

  it('ignores a title they merely finished', async () => {
    await rank(friendA, merelyFine, 'fine', 1);
    assert.deepEqual(await candidates(me), []);
  });

  it('ignores somebody the caller does not follow', async () => {
    await rank(stranger, loved, 'loved', 1);
    assert.deepEqual(await candidates(me), []);
  });

  it('ignores a follow that is still pending', async () => {
    const waiting = await t.createUser({ username: 'sc_waiting', visibility: 'private' });
    await follow(me, waiting, 'pending');
    await rank(waiting, loved, 'loved', 1);
    try {
      assert.deepEqual(await candidates(me), []);
    } finally {
      await t.sql(`delete from follows where follower_id = $1 and followee_id = $2`, [me, waiting]);
      await t.sql(`delete from rankings where user_id = $1`, [waiting]);
    }
  });

  it('drops an endorser who has blocked the caller', async () => {
    await rank(friendA, loved, 'loved', 1);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [friendA, me]);
    try {
      assert.deepEqual(await candidates(me), []);
    } finally {
      await t.sql(`delete from blocks where blocker_id = $1`, [friendA]);
    }
  });

  it('drops a suspended endorser', async () => {
    await rank(friendA, loved, 'loved', 1);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [friendA]);
    try {
      assert.deepEqual(await candidates(me), []);
    } finally {
      await t.sql(`update profiles set status = 'active' where id = $1`, [friendA]);
    }
  });

  it('never suggests something the caller has already logged', async () => {
    await rank(friendA, loved, 'loved', 1);
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'fine')`,
      [me, loved],
    );
    assert.deepEqual(await candidates(me), []);
  });

  it('never suggests something the caller has ranked', async () => {
    await rank(friendA, loved, 'loved', 1);
    await rank(me, loved, 'loved', 1);
    assert.deepEqual(await candidates(me), []);
  });

  it('never suggests something already on the caller’s watchlist', async () => {
    await rank(friendA, loved, 'loved', 1);
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [me, loved]);
    assert.deepEqual(await candidates(me), []);
  });

  it('never suggests something the caller dismissed, however many friends loved it', async () => {
    // A dismissal is a veto. Endorsements are a weight, and a weight does not beat a veto.
    await rank(friendA, loved, 'loved', 1);
    await rank(friendB, loved, 'loved', 1);
    await t.sql(
      `insert into recommendation_feedback (user_id, media_item_id, kind)
       values ($1, $2, 'dismiss')`,
      [me, loved],
    );
    assert.deepEqual(await candidates(me), []);
  });

  it('returns ids and a count, and never a person', async () => {
    await rank(friendA, loved, 'loved', 1);
    const rows = await candidates(me);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['endorsements', 'media_item_id']);
  });

  it('tells an anonymous caller nothing', async () => {
    assert.ok(await t.asAnon(() => t.errorFrom(`select * from social_candidates(40)`)));
  });
});
