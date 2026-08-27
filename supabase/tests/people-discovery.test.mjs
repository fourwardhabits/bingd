import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * People discovery — `people_mutuals` and `people_taste_matches`, 20260826000500.
 *
 * Bingd had no way to find anybody: search worked only if you already knew the handle.
 * These two functions are the whole of the founder's answer, and both are read-only
 * definer functions taking no viewer, so the only perspective either can answer from is
 * `auth.uid()`'s own (20260813001900).
 *
 * **What this file is really about is the exclusions.** A suggestion list is a place
 * where a graph query written for one purpose leaks a relationship it was never meant
 * to disclose, so every exclusion is asserted rather than assumed: the caller, people
 * already followed, people already *asked*, blocks in either direction, suspended
 * accounts, and — the one that is easy to miss — an intermediary or a candidate the
 * caller may not view, whose edge would otherwise be counted and become the disclosure.
 */

let t;
let alice;
let seq = 50000;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  alice = await t.createUser({ username: `pd_alice_${seq}` });
  await t.actAs(alice);
});

const user = (name, visibility = 'public') =>
  t.createUser({ username: `pd_${name}_${(seq += 1)}`, visibility });

const movie = (title) => t.createMovie(title, (seq += 1));

/** An approved follow, written directly: `follow` would rate-limit a fixture graph. */
const follows = (follower, followee, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, $3::follow_state)
       on conflict (follower_id, followee_id) do update set state = excluded.state`,
    [follower, followee, state],
  );

const mutuals = async (asUser = alice) => {
  await t.actAs(asUser);
  const { rows } = await t.sql(`select * from people_mutuals(10)`);
  await t.actAs(alice);
  return rows;
};

const matches = async (asUser = alice) => {
  await t.actAs(asUser);
  const { rows } = await t.sql(`select * from people_taste_matches(10)`);
  await t.actAs(alice);
  return rows;
};

const ids = (rows) => rows.map((row) => row.user_id);

// ---------------------------------------------------------------------------

describe('mutuals: people followed by people you follow', () => {
  it('suggests a friend of a friend, with the count of shared connections', async () => {
    const bo = await user('bo');
    const cy = await user('cy');
    const target = await user('target');

    await follows(alice, bo);
    await follows(alice, cy);
    await follows(bo, target);
    await follows(cy, target);

    const rows = await mutuals();

    assert.deepEqual(ids(rows), [target]);
    assert.equal(rows[0].mutual_count, 2);
    assert.equal(rows[0].username.startsWith('pd_target'), true);
  });

  it('orders the most connected first', async () => {
    const bo = await user('bo');
    const cy = await user('cy');
    const popular = await user('popular');
    const quiet = await user('quiet');

    await follows(alice, bo);
    await follows(alice, cy);
    await follows(bo, popular);
    await follows(cy, popular);
    await follows(bo, quiet);

    const rows = await mutuals();

    assert.deepEqual(ids(rows), [popular, quiet]);
    assert.deepEqual(
      rows.map((r) => r.mutual_count),
      [2, 1],
    );
  });

  it('never suggests the caller', async () => {
    const bo = await user('bo');
    await follows(alice, bo);
    // Bo follows Alice back, so Alice is a friend-of-a-friend of herself.
    await follows(bo, alice);

    assert.deepEqual(ids(await mutuals()), []);
  });

  it('never suggests somebody already followed, or already asked', async () => {
    const bo = await user('bo');
    const known = await user('known');
    const asked = await user('asked', 'private');

    await follows(alice, bo);
    await follows(bo, known);
    await follows(bo, asked);
    await follows(alice, known);
    await follows(alice, asked, 'pending');

    assert.deepEqual(ids(await mutuals()), [], 'a request already sent is not a suggestion');
  });

  it('never suggests across a block, in either direction', async () => {
    const bo = await user('bo');
    const blocked = await user('blocked');
    const blocker = await user('blocker');

    await follows(alice, bo);
    await follows(bo, blocked);
    await follows(bo, blocker);

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [alice, blocked]);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [blocker, alice]);

    assert.deepEqual(ids(await mutuals()), []);
  });

  it('never suggests a suspended account', async () => {
    const bo = await user('bo');
    const gone = await user('gone');

    await follows(alice, bo);
    await follows(bo, gone);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [gone]);

    assert.deepEqual(ids(await mutuals()), []);
  });

  /**
   * The intermediary passes the same discoverability predicate as the candidate
   * (review 60). A block raced against a still-standing follow edge, or a suspension,
   * must not leave the account countable — let alone nameable in `mutual_names` —
   * when `mutuals_with` correctly refuses to list it: the count and the sheet must
   * draw from the same set.
   */
  it('does not count or name a path through a blocked intermediary', async () => {
    const bo = await user('bo');
    const vex = await user('vex');
    const target = await user('target');

    await follows(alice, bo);
    await follows(alice, vex);
    await follows(bo, target);
    await follows(vex, target);
    // The block lands after the follow edges exist, which is exactly the race.
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [vex, alice]);

    const rows = await mutuals();
    assert.deepEqual(ids(rows), [target]);
    assert.equal(rows[0].mutual_count, 1, 'the blocked intermediary must not be counted');
    assert.equal(rows[0].mutual_names.length, 1);
    assert.equal(rows[0].mutual_names[0].startsWith('pd_bo'), true);
  });

  it('does not count or name a path through a suspended intermediary', async () => {
    const bo = await user('bo');
    const gone = await user('gone');
    const target = await user('target');

    await follows(alice, bo);
    await follows(alice, gone);
    await follows(bo, target);
    await follows(gone, target);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [gone]);

    const rows = await mutuals();
    assert.deepEqual(ids(rows), [target]);
    assert.equal(rows[0].mutual_count, 1, 'the suspended intermediary must not be counted');
    assert.deepEqual(
      rows[0].mutual_names.filter((name) => name.startsWith('pd_gone')),
      [],
    );
  });

  /**
   * **The privacy property this function turns on**, and the reason both endpoints are
   * tested rather than just the candidate.
   *
   * `follows_read` admits an approved row only when the caller can view *both* parties,
   * so restricting the intermediary and the candidate to `can_view_profile` makes the
   * count an aggregate over rows the caller could already select one at a time. Drop
   * either half and the count becomes a disclosure: it would say that somebody follows a
   * private account, which is exactly the hidden relationship a suggestion may not
   * explain itself with.
   *
   * The consequence — a private account the caller does not follow cannot be suggested
   * here at all — is the existing contract rather than a new restriction, and it is
   * asserted so that widening it later has to be deliberate.
   */
  it('does not surface a private candidate the caller cannot view', async () => {
    const bo = await user('bo');
    const hidden = await user('hidden', 'private');

    await follows(alice, bo);
    await follows(bo, hidden);

    assert.deepEqual(ids(await mutuals()), []);
  });

  it('does not count a path through a private account the caller cannot view', async () => {
    const secretive = await user('secretive', 'private');
    const target = await user('target');
    const bo = await user('bo');

    // Alice has *asked* to follow the private account and has not been approved, so she
    // may not view them — and must not learn who they follow through a count.
    await follows(alice, secretive, 'pending');
    await follows(secretive, target);
    // One legitimate path, so the target is present and only the count is at issue.
    await follows(alice, bo);
    await follows(bo, target);

    const rows = await mutuals();

    assert.deepEqual(ids(rows), [target]);
    assert.equal(rows[0].mutual_count, 1, 'the private intermediary contributed nothing');
  });

  it('counts a path through a private account the caller has been approved for', async () => {
    const approved = await user('approved', 'private');
    const target = await user('target');

    await follows(alice, approved);
    await follows(approved, target);

    const rows = await mutuals();

    assert.deepEqual(ids(rows), [target]);
    assert.equal(rows[0].mutual_count, 1);
  });

  it('ignores a pending edge on the intermediary’s own side', async () => {
    const bo = await user('bo');
    const target = await user('target', 'private');

    await follows(alice, bo);
    await follows(bo, target, 'pending');

    assert.deepEqual(ids(await mutuals()), [], 'asking to follow somebody is not following them');
  });

  it('returns the identity fields the row needs and nothing else', async () => {
    const bo = await user('bo');
    const target = await user('target');
    await follows(alice, bo);
    await follows(bo, target);

    const rows = await mutuals();

    assert.deepEqual(Object.keys(rows[0]).sort(), [
      'avatar_path',
      'display_name',
      'mutual_count',
      'mutual_names',
      'user_id',
      'username',
      'visibility',
    ]);
  });

  /**
   * The names, added 2026-08-27 (20260827000100) when the founder reversed the
   * count-only decision. Every named person is an intermediary the caller approvedly
   * follows — an edge follows_read admits — so what these tests own is the *shape* of
   * the naming: capped, ordered, and falling back to the handle.
   */
  describe('the mutual names', () => {
    it('names the mutuals, at most three, ordered by handle', async () => {
      const target = await user('target');
      const vias = [];
      for (const name of ['d_via', 'a_via', 'c_via', 'b_via']) {
        const via = await user(name);
        vias.push(via);
        await follows(alice, via);
        await follows(via, target);
      }

      const rows = await mutuals();

      assert.equal(rows[0].mutual_count, 4, 'all four connections are counted');
      assert.equal(rows[0].mutual_names.length, 3, 'but at most three are named');
      const sorted = [...rows[0].mutual_names].sort();
      assert.deepEqual(rows[0].mutual_names, sorted, 'named in handle order');
      assert.match(rows[0].mutual_names[0], /^pd_a_via_/, 'the first handle leads');
    });

    // No blank-name test: `profiles.display_name` is NOT NULL and `display_name_shape`
    // forbids the empty string, so the coalesce-to-handle in the function body is a
    // belt over a constraint rather than a reachable branch.
  });
});

// ---------------------------------------------------------------------------

/**
 * `mutuals_with` — the list behind one card's count (20260827000100).
 *
 * The invariant is symmetry: it may only name edges `people_mutuals` would have
 * counted, which are edges `follows_read` would admit to this caller individually.
 * So the exclusions here mirror the count's, and the one deliberate difference is
 * asserted too — a subject the caller has since followed still answers, because the
 * sheet can stay open across the Follow it inspired.
 */
describe('mutuals_with: who the count is', () => {
  const mutualsWith = async (subject, asUser = alice) => {
    await t.actAs(asUser);
    const { rows } = await t.sql(`select * from mutuals_with($1)`, [subject]);
    await t.actAs(alice);
    return rows;
  };

  it('lists exactly the intermediaries the count aggregates, by handle', async () => {
    const bo = await user('z_bo');
    const cy = await user('a_cy');
    const target = await user('target');
    await follows(alice, bo);
    await follows(alice, cy);
    await follows(bo, target);
    await follows(cy, target);

    const counted = await mutuals();
    const named = await mutualsWith(target);

    assert.equal(counted[0].mutual_count, named.length, 'the sheet is the count, unrolled');
    assert.deepEqual(ids(named), [cy, bo], 'ordered by handle');
    assert.deepEqual(Object.keys(named[0]).sort(), [
      'avatar_path',
      'display_name',
      'user_id',
      'username',
      'visibility',
    ]);
  });

  it('does not name somebody the caller merely asked to follow', async () => {
    const bo = await user('bo');
    const target = await user('target');
    await follows(alice, bo, 'pending');
    await follows(bo, target);

    assert.deepEqual(await mutualsWith(target), [], 'a pending edge is not a mutual');
  });

  it('still answers for a subject the caller has since followed', async () => {
    const bo = await user('bo');
    const target = await user('target');
    await follows(alice, bo);
    await follows(bo, target);
    await follows(alice, target);

    assert.deepEqual(ids(await mutualsWith(target)), [bo]);
  });

  it('says nothing about a subject who blocked the caller', async () => {
    const bo = await user('bo');
    const target = await user('target');
    await follows(alice, bo);
    await follows(bo, target);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [target, alice]);

    assert.deepEqual(await mutualsWith(target), [], 'a block hides the whole list');
  });

  it('leaves out a blocked intermediary without hiding the rest', async () => {
    const bo = await user('bo');
    const cy = await user('cy');
    const target = await user('target');
    await follows(alice, bo);
    await follows(alice, cy);
    await follows(bo, target);
    await follows(cy, target);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [bo, alice]);

    assert.deepEqual(ids(await mutualsWith(target)), [cy]);
  });

  it('never answers about yourself', async () => {
    const bo = await user('bo');
    await follows(alice, bo);
    await follows(bo, alice);

    assert.deepEqual(await mutualsWith(alice), [], 'you are not a subject of your own graph');
  });
});

// ---------------------------------------------------------------------------

/**
 * `people_taste_matches` calls `taste_match` itself rather than reimplementing it, so
 * these tests are deliberately not about the arithmetic — `taste-match.test.mjs` owns
 * that, and duplicating it here would be a second place for the formula to be asserted
 * and so a second place for it to drift. What is asserted is the *gate*: who is a
 * candidate, and that a candidate with no score is not returned.
 */
describe('taste matches: people whose rankings agree with yours', () => {
  /** Ranks the same films for both accounts, in the same order, so they agree. */
  const shareRankings = async (other, count, bucket = 'loved') => {
    const films = [];
    for (let i = 0; i < count; i += 1) films.push(await movie(`shared_${i}`));
    for (const film of films) {
      await t.actAs(alice);
      await t.rankToCompletion(film, bucket, async (pivot) => pivot);
      await t.actAs(other);
      await t.rankToCompletion(film, bucket, async (pivot) => pivot);
    }
    await t.actAs(alice);
    return films;
  };

  it('suggests somebody with enough shared rankings, scored by taste_match itself', async () => {
    const bo = await user('bo');
    await shareRankings(bo, 6);

    const rows = await matches();

    assert.deepEqual(ids(rows), [bo]);
    const canonical = (await t.sql(`select * from taste_match($1)`, [bo])).rows[0];
    assert.equal(
      rows[0].match_score,
      canonical.score,
      'the suggestion and the profile show the same number, because it is the same call',
    );
  });

  /**
   * The minimum-data gate is `taste.min_common` and not a second number invented for
   * this screen: below it there is no score, and a candidate with no score is not a row.
   * A percentage here that the profile would refuse to show would be the feature's first
   * lie.
   */
  it('does not suggest somebody below the shared-title minimum', async () => {
    const bo = await user('bo');
    await shareRankings(bo, 3);

    assert.deepEqual(ids(await matches()), []);
  });

  it('does not suggest somebody already followed or already asked', async () => {
    const known = await user('known');
    const asked = await user('asked', 'private');
    await shareRankings(known, 6);
    await shareRankings(asked, 6);
    await follows(alice, known);
    await follows(alice, asked, 'pending');

    assert.deepEqual(ids(await matches()), []);
  });

  it('never suggests the caller, however much they agree with themselves', async () => {
    const bo = await user('bo');
    await shareRankings(bo, 6);

    assert.equal(ids(await matches()).includes(alice), false);
  });

  it('never suggests across a block', async () => {
    const bo = await user('bo');
    await shareRankings(bo, 6);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [bo, alice]);

    assert.deepEqual(ids(await matches()), []);
  });

  it('never suggests a suspended account', async () => {
    const bo = await user('bo');
    await shareRankings(bo, 6);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [bo]);

    assert.deepEqual(ids(await matches()), []);
  });

  /**
   * A private account the caller has not been approved for is unreadable, so its
   * rankings may not be folded into an aggregate about it — `taste_match` refuses the
   * pair through `can_view_profile`, and this function refuses it before paying for the
   * call. Both mechanisms, because a screen that shows a number for somebody it may not
   * read would be a leak whichever layer let it through.
   */
  it('never suggests a private account the caller may not read', async () => {
    const hidden = await user('hidden', 'private');
    await shareRankings(hidden, 6);

    assert.deepEqual(ids(await matches()), []);
    assert.equal((await t.sql(`select * from taste_match($1)`, [hidden])).rows[0].score, null);
  });

  it('orders the best match first', async () => {
    const twin = await user('twin');
    const opposite = await user('opposite');

    const films = [];
    for (let i = 0; i < 6; i += 1) films.push(await movie(`ordered_${i}`));

    for (const film of films) {
      await t.actAs(alice);
      await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
      await t.actAs(twin);
      await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
      await t.actAs(opposite);
      await t.rankToCompletion(film, 'not_for_me', async (pivot) => pivot);
    }
    await t.actAs(alice);

    const rows = await matches();

    assert.deepEqual(ids(rows), [twin, opposite]);
    assert.ok(rows[0].match_score > rows[1].match_score);
  });
});

// ---------------------------------------------------------------------------

describe('both functions answer only about the caller', () => {
  it('give an anonymous caller nothing', async () => {
    // Granted to `authenticated` alone, so this is a floor rather than a reachable path.
    // Asserted because the failure would be silent: `auth.uid()` null means every
    // predicate is null, and a query that returns rows anyway would be a directory dump.
    await t.actAs(null);
    assert.deepEqual((await t.sql(`select * from people_mutuals(10)`)).rows, []);
    assert.deepEqual((await t.sql(`select * from people_taste_matches(10)`)).rows, []);
    await t.actAs(alice);
  });

  it('answer differently for two accounts on the same connection', async () => {
    const bo = await user('bo');
    const target = await user('target');
    await follows(alice, bo);
    await follows(bo, target);

    assert.deepEqual(ids(await mutuals(alice)), [target]);
    // Bo follows the target directly, so has no friend-of-a-friend to be shown.
    assert.deepEqual(ids(await mutuals(bo)), []);
  });
});
