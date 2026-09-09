import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `people_starter_suggestions` — 20260914000100, the organic state of onboarding's People
 * step.
 *
 * **What this file is really about is the exclusions**, exactly as `people-discovery.test`
 * is. A suggestion list is where a graph query written for one purpose leaks a
 * relationship it was never meant to disclose, and this one is put in front of somebody
 * with no relationships at all — so it has the least social cover of any list in the
 * product, and the strictest rule. The difference from `people_mutuals` is asserted
 * directly: a private account may appear there through proximity, and may never appear
 * here.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY ASSERTION NAMES A CANDIDATE INSTEAD OF EXPECTING AN EMPTY LIST
 *
 * This is the trap this file fell into first, and it is worth writing down because the
 * neighbouring discovery tests do not hit it.
 *
 * `people_mutuals` can only return accounts reachable through the caller's own follows, so
 * a fresh `alice` per test is naturally isolated: everybody left behind by earlier tests is
 * invisible to her. **This function has no such horizon.** It returns any public, active
 * account with rankings — which, in a database shared by every test in the file, means
 * every account any earlier test created. `assert.deepEqual(rows, [])` is therefore never
 * true after the first test, and a suite written that way fails for reasons that have
 * nothing to do with its subject.
 *
 * So each test gives its candidate **a title the caller has also ranked**. Shared titles
 * sort first, so an eligible candidate is necessarily row one, and an excluded one is
 * necessarily absent — no matter what the rest of the database contains. That makes the
 * exclusions *stronger* claims than emptiness would have been: the account being excluded
 * is the account that would otherwise have topped the list.
 */

let t;
let alice;
let seq = 90000;
/** `rankings_position_unique` is per account and category, so positions cannot repeat. */
const nextPosition = new Map();

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  alice = await t.createUser({ username: `ss_alice_${seq}` });
  await t.actAs(alice);
});

const user = (name, visibility = 'public') =>
  t.createUser({ username: `ss_${name}_${(seq += 1)}`, visibility });

const movie = (title) => t.createMovie(title, (seq += 1));

/**
 * A ranking, written directly.
 *
 * Going through `set_bucket` and a real session per title would make a two-title fixture a
 * two-comparison ceremony, and nothing under test reads `position`: this function returns
 * counts, deliberately, and never a score.
 */
const rank = async (userId, mediaItemId, createdAt = null) => {
  const position = (nextPosition.get(userId) ?? 0) + 1;
  nextPosition.set(userId, position);
  await t.sql(
    `insert into rankings (user_id, media_item_id, category, bucket, position, created_at)
     values ($1, $2, 'movies', 'loved', $3, coalesce($4::timestamptz, now()))
     on conflict (user_id, media_item_id) do nothing`,
    [userId, mediaItemId, position, createdAt],
  );
};

/**
 * Gives a candidate one title the caller has also ranked.
 *
 * The isolation device this whole file rests on. See the header: a shared title guarantees
 * the candidate outranks every account left behind by an earlier test, so "present" means
 * row one and "absent" means genuinely excluded.
 */
const shareATitleWith = async (candidate, title) => {
  const id = await movie(title);
  await rank(alice, id);
  await rank(candidate, id);
  return id;
};

const follows = (follower, followee, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, $3::follow_state)
       on conflict (follower_id, followee_id) do update set state = excluded.state`,
    [follower, followee, state],
  );

const suggestions = async (limit = 10) => {
  const { rows } = await t.sql(`select * from people_starter_suggestions($1)`, [limit]);
  return rows;
};

const ids = (rows) => rows.map((row) => row.user_id);

describe('people_starter_suggestions', () => {
  it('suggests a public account that has ranked something', async () => {
    const gio = await user('gio');
    await shareATitleWith(gio, 'Heat');

    const rows = await suggestions();
    assert.equal(rows[0].user_id, gio);
    assert.equal(rows[0].shared_count, 1);
    assert.equal(rows[0].ranked_count, 1);
  });

  it('never suggests the caller, however much they have ranked', async () => {
    await rank(alice, await movie('Alien'));
    await rank(alice, await movie('Aliens'));

    assert.ok(!ids(await suggestions()).includes(alice));
  });

  it('says nothing about an account that has ranked nothing', async () => {
    // Not an exclusion for its own sake: following somebody with an empty collection
    // produces a Feed with nothing in it, which is the one thing this step is for.
    const empty = await user('empty');

    assert.ok(!ids(await suggestions()).includes(empty));
  });

  describe('privacy, which is stricter here than in Mutuals', () => {
    /**
     * **The load-bearing difference between this list and `people_mutuals`.**
     *
     * `20260828000400` deliberately lets an eligible private account into Mutuals, marked,
     * with `Request` on the control, because a friend of a friend is socially grounded.
     * This surface has no relationship to trade on, so the same account must not appear —
     * and here it is the account that would otherwise be first.
     */
    it('never suggests a private account, even one that would top the list', async () => {
      const shy = await user('shy', 'private');
      await shareATitleWith(shy, 'Private Life');
      await rank(shy, await movie('Another Private One'));

      assert.ok(!ids(await suggestions()).includes(shy));
    });

    it('drops a candidate the caller has blocked', async () => {
      const gio = await user('gio');
      await shareATitleWith(gio, 'Sicario');
      await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [alice, gio]);

      assert.ok(!ids(await suggestions()).includes(gio));
    });

    it('drops a candidate who has blocked the caller', async () => {
      const gio = await user('gio');
      await shareATitleWith(gio, 'Arrival');
      await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [gio, alice]);

      assert.ok(!ids(await suggestions()).includes(gio));
    });

    it('drops a suspended account', async () => {
      const gio = await user('gio');
      await shareATitleWith(gio, 'Dune');
      await t.sql(`update profiles set status = 'suspended' where id = $1`, [gio]);

      assert.ok(!ids(await suggestions()).includes(gio));
    });
  });

  describe('people who are already answered for', () => {
    it('drops somebody the caller already follows', async () => {
      const gio = await user('gio');
      await shareATitleWith(gio, 'Whiplash');
      await follows(alice, gio);

      assert.ok(!ids(await suggestions()).includes(gio));
    });

    /**
     * A pending request is not a suggestion either. Offering Follow for an account the
     * reader has already asked to follow is the screen forgetting what it just did, and it
     * is the exclusion `people_mutuals` makes for the same reason.
     */
    it('drops somebody the caller has already asked to follow', async () => {
      const gio = await user('gio');
      await shareATitleWith(gio, 'Prisoners');
      await follows(alice, gio, 'pending');

      assert.ok(!ids(await suggestions()).includes(gio));
    });
  });

  describe('the order', () => {
    it('puts shared titles first, and counts them', async () => {
      const overlapping = await user('over');
      await shareATitleWith(overlapping, 'Fargo');

      const busy = await user('busy');
      await rank(busy, await movie('Rushmore'));
      await rank(busy, await movie('Barton Fink'));
      await rank(busy, await movie('Lebowski'));

      const rows = await suggestions();
      assert.equal(rows[0].user_id, overlapping, 'one shared title outranks three unshared');
      assert.equal(rows[0].shared_count, 1);

      const busyRow = rows.find((row) => row.user_id === busy);
      assert.equal(busyRow.shared_count, 0);
      assert.equal(busyRow.ranked_count, 3);
    });

    it('prefers the account that has ranked more recently among equals', async () => {
      const stale = await user('stale');
      await shareATitleWith(stale, 'The Old One');

      const fresh = await user('fresh');
      await shareATitleWith(fresh, 'The New One');
      // Written after the shared title so it is this account's most recent activity.
      await rank(fresh, await movie('Something Newer'), '2030-01-01T00:00:00Z');
      await t.sql(
        `update rankings set created_at = '2020-01-01T00:00:00Z' where user_id = $1`,
        [stale],
      );

      const rows = await suggestions();
      const order = ids(rows);
      assert.ok(
        order.indexOf(fresh) < order.indexOf(stale),
        'the account that ranked most recently comes first',
      );
    });

    /**
     * The property that matters more than the ordering itself: **the same question asked
     * twice gets the same answer.** A list that reshuffles on a refresh teaches the reader
     * that it means nothing, and `username` then `id` is what makes that impossible.
     */
    it('is stable across identical calls', async () => {
      const when = '2026-09-01T00:00:00Z';
      for (const name of ['a', 'b', 'c', 'd']) {
        const person = await user(name);
        const id = await movie(`Tie ${name}`);
        await rank(alice, id);
        await rank(person, id, when);
      }

      assert.deepEqual(ids(await suggestions()), ids(await suggestions()));
    });

    it('honours the limit, and clamps an absurd one', async () => {
      for (let n = 0; n < 12; n += 1) {
        const person = await user(`many${n}`);
        await shareATitleWith(person, `Many ${n}`);
      }

      assert.equal((await suggestions(3)).length, 3);
      // The ceiling is ten. This is a step in onboarding, not a directory.
      assert.equal((await suggestions(9999)).length, 10);
    });
  });

  /**
   * The grant itself is asserted by `function-grants.test.mjs`, which sweeps the whole
   * schema against an allow-list rather than trusting anybody to remember one function.
   * What belongs here is the *shape* of what a permitted caller gets back.
   */
  it('returns counts and no score of any kind', async () => {
    const gio = await user('gio');
    await shareATitleWith(gio, 'Nope');

    const [row] = await suggestions();
    assert.deepEqual(Object.keys(row).sort(), [
      'avatar_path',
      'display_name',
      'ranked_count',
      'shared_count',
      'user_id',
      'username',
      'visibility',
    ]);
  });
});
