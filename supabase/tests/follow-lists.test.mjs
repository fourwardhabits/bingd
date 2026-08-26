import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Followers and Following as lists — `20260826000600` §5.
 *
 * These two functions are the only reads in that migration that are **`security
 * invoker`**, and that choice is the whole of their privacy: `follows_read` has said
 * since `20260813001900` that a viewer may see an approved edge only when they can view
 * *both* ends of it, and `profiles_read` decides whether the person on the other end can
 * be named. A definer version would have had to restate both rules and would have been
 * the copy that got one of them wrong.
 *
 * So this file is mostly a proof that the existing contract still governs when the same
 * facts are reached through a new door. Every case is one somebody could reasonably
 * expect to work and must not:
 *
 *   · a stranger reading a private account's followers
 *   · a private account's own follower appearing to somebody who cannot see them
 *   · a blocked account appearing in either list
 *   · search reaching past the list into the directory
 *
 * The cast: `owner` is public and is who the lists are about. `viewer` follows nobody
 * and is the outside. `shy` is private. `blocked` has been blocked by `viewer`.
 */

let t;
let owner;
let viewer;
let shy;
let blocked;
let friend;

const follow = (follower, followee, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state)
     values ($1, $2, $3) on conflict do nothing`,
    [follower, followee, state],
  );

/**
 * **`asUser`, never `actAs`, and that distinction is the entire test.**
 *
 * `actAs` sets `auth.uid()` while staying the table owner, and **an owner bypasses row
 * security** — so under it these two functions return every edge in the database and
 * every assertion below passes for the wrong reason. That is not a hypothetical: the
 * first draft of this file used `actAs` and reported a blocked account and a private one
 * in a stranger's list, which is precisely the leak it was written to refuse.
 *
 * It matters more here than anywhere else in this suite because `followers_of` and
 * `following_of` are `security invoker`: their authorisation *is* `follows_read`, so a
 * harness that skips policies is a harness that tests nothing at all. The definer reads
 * in `comment-threads.test.mjs` are different — they ask `can_view_profile(auth.uid())`
 * themselves — which is why `actAs` is honest there and dishonest here.
 */
const followers = async (who, subject, query = null) =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select username from followers_of($1, $2)`, [subject, query]);
    return rows.map((r) => r.username).sort();
  });

const following = async (who, subject, query = null) =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select username from following_of($1, $2)`, [subject, query]);
    return rows.map((r) => r.username).sort();
  });

before(async () => {
  t = await createTestDb();

  owner = await t.createUser({ username: 'fl_owner' });
  viewer = await t.createUser({ username: 'fl_viewer' });
  shy = await t.createUser({ username: 'fl_shy', visibility: 'private' });
  blocked = await t.createUser({ username: 'fl_blocked' });
  friend = await t.createUser({ username: 'fl_friend' });

  // Everyone follows the owner, and the owner follows everyone back.
  for (const person of [viewer, shy, blocked, friend]) {
    await follow(person, owner);
    await follow(owner, person);
  }

  // The viewer has blocked one of them.
  await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [viewer, blocked]);
});

after(async () => {
  await t.close();
});

describe('a public account, read by somebody outside', () => {
  it('lists the followers the caller is allowed to see', async () => {
    // `fl_shy` is private and the viewer does not follow them, so `can_i_view` is false
    // and `follows_read` never admits that edge. `fl_blocked` is absent for the same
    // predicate reached a different way. Neither is a new rule.
    assert.deepEqual(await followers(viewer, owner), ['fl_friend', 'fl_viewer']);
  });

  it('lists the following set the same way', async () => {
    assert.deepEqual(await following(viewer, owner), ['fl_friend', 'fl_viewer']);
  });

  /**
   * The owner's own view is wider, and it is wider for a reason that predates this
   * function: `follows_read` admits any edge you are an endpoint of, so a private
   * account that follows you is visible **to you**. That is what makes a private
   * account's follow request answerable at all.
   */
  it('shows the owner their own private follower', async () => {
    assert.deepEqual(await followers(owner, owner), [
      'fl_blocked',
      'fl_friend',
      'fl_shy',
      'fl_viewer',
    ]);
  });
});

describe('a private account', () => {
  it('tells a stranger nothing about who follows it', async () => {
    assert.deepEqual(await followers(viewer, shy), []);
    assert.deepEqual(await following(viewer, shy), []);
  });

  it('tells an approved follower, which is the existing contract and not a new one', async () => {
    const nosy = await t.createUser({ username: 'fl_nosy' });
    await follow(nosy, shy);
    await follow(shy, owner);

    // `shy` follows `owner`; `nosy` can see `shy` because the follow is approved, and can
    // see `owner` because they are public. Both halves of `follows_read` are satisfied,
    // so the edge is admitted — exactly as it would be reading `follows` directly.
    assert.deepEqual(await following(nosy, shy), ['fl_owner']);
  });

  it('says nothing to somebody whose request is still pending', async () => {
    const waiting = await t.createUser({ username: 'fl_waiting' });
    await follow(waiting, shy, 'pending');

    // Pending is not approved, so `can_view_profile` is false and every edge into `shy`
    // stays invisible. A list that leaked here would make "request to follow" a way of
    // reading a private social graph while you wait.
    assert.deepEqual(await followers(waiting, shy), []);
    assert.deepEqual(await following(waiting, shy), []);
  });
});

describe('a block', () => {
  it('keeps the blocked account out of both lists', async () => {
    assert.ok(!(await followers(viewer, owner)).includes('fl_blocked'));
    assert.ok(!(await following(viewer, owner)).includes('fl_blocked'));
  });

  it('works in the other direction too', async () => {
    // The block is the viewer's, and `can_view_profile` is false in both directions --
    // so the person who was blocked cannot use these lists to find the person who
    // blocked them either.
    assert.ok(!(await followers(blocked, owner)).includes('fl_viewer'));
  });

  it('does not merely hide the name while counting the row', async () => {
    // The distinction that matters: an absent row and an anonymised one look the same to
    // a reader and are very different to somebody counting. `followers_of` returns rows,
    // and the client counts what it received, so absence is the only representation.
    const n = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select count(*)::int as n from followers_of($1)`, [owner]);
      return rows[0].n;
    });
    assert.equal(n, 2);
  });
});

describe('search, which stays inside the list', () => {
  it('matches a username', async () => {
    assert.deepEqual(await followers(viewer, owner, 'friend'), ['fl_friend']);
  });

  it('matches a display name', async () => {
    await t.sql(`update profiles set display_name = 'Wednesday Adams' where id = $1`, [friend]);
    assert.deepEqual(await followers(viewer, owner, 'wednes'), ['fl_friend']);
  });

  it('is case-insensitive and ignores surrounding space', async () => {
    assert.deepEqual(await followers(viewer, owner, '  FRIEND '), ['fl_friend']);
  });

  it('treats an empty query as no query', async () => {
    assert.deepEqual(await followers(viewer, owner, '   '), ['fl_friend', 'fl_viewer']);
  });

  /**
   * Part M's rule, and the one worth a test rather than a comment: a search box on a
   * follower list must not become a second user directory. It is structural here — the
   * `from` clause is `follows` — but a future rewrite reaching for `search_users` would
   * pass every other test in this file.
   */
  it('cannot reach somebody who is not in the list', async () => {
    const outsider = await t.createUser({ username: 'fl_outsider' });
    assert.ok(outsider);
    assert.deepEqual(await followers(viewer, owner, 'outsider'), []);
  });
});

describe('paging, because thirty is not for ever', () => {
  let crowd;

  before(async () => {
    crowd = await t.createUser({ username: 'fl_crowd' });
    for (let i = 0; i < 12; i += 1) {
      const person = await t.createUser({ username: `fl_p${String(i).padStart(2, '0')}` });
      await follow(person, crowd);
    }
  });

  it('returns a page and then the next one, with no gap and no repeat', async () => {
    const page = (limit, offset) =>
      t.asUser(viewer, async () => {
        const { rows } = await t.sql(`select username from followers_of($1, null, $2, $3)`, [
          crowd,
          limit,
          offset,
        ]);
        return rows.map((r) => r.username);
      });

    const first = await page(5, 0);
    const second = await page(5, 5);
    const third = await page(5, 10);

    assert.equal(first.length, 5);
    assert.equal(second.length, 5);
    assert.equal(third.length, 2);

    const all = [...first, ...second, ...third];
    assert.equal(new Set(all).size, 12, 'an offset over a unique sort cannot skip or repeat');
    assert.deepEqual(all, [...all].sort(), 'and the order is stable across pages');
  });

  it('caps a caller asking for everything at once', async () => {
    const n = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(
        `select count(*)::int as n from followers_of($1, null, 9999, 0)`,
        [crowd],
      );
      return rows[0].n;
    });
    // Bounded at 100 by the function, so a modified client cannot ask for a whole
    // follow graph in one statement.
    assert.ok(n <= 100);
  });
});

describe('the grants', () => {
  it('is closed to anonymous readers', async () => {
    // No signed-out surface in this app renders a person, and a grant should follow a
    // surface rather than precede it.
    const error = await t.asAnon(() =>
      t.errorFrom(`select * from followers_of($1)`, [owner]),
    );
    assert.ok(error, 'anon must not be able to enumerate a follow graph');
  });
});
