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
      'user_id',
      'username',
      'visibility',
    ]);
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
