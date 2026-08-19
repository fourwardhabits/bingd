import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `search_users` — 20260817000300.
 *
 * The founder's regression list, in order: exact handle · partial handle ·
 * display-name match · case differences · no blocked or private leak ·
 * deactivated/suspended handling · title search not regressed.
 *
 * The one thing to keep hold of while reading this file: **a search that returns a row
 * it should not is a privacy failure, and a search that misses a row is an
 * inconvenience.** So the visibility cases below assert absence, and they assert it
 * against a database where the account definitely exists and definitely matches the
 * query — otherwise a passing test proves only that the fixture was wrong.
 */

let t;
let viewer;

const found = async (query, asUser) => {
  if (asUser) await t.actAs(asUser);
  const { rows } = await t.sql(`select username from search_users($1, 30)`, [query]);
  if (asUser) await t.actAs(viewer);
  return rows.map((r) => r.username);
};

before(async () => {
  t = await createTestDb();
  viewer = await t.createUser({ username: 'searcher' });
  await t.actAs(viewer);

  await t.createUser({ username: 'anna' });
  await t.createUser({ username: 'deanna' });
  await t.createUser({ username: 'tim_burton' });
  const named = await t.createUser({ username: 'xq_handle' });
  await t.sql(`update profiles set display_name = 'Greta Gerwig' where id = $1`, [named]);
  const accented = await t.createUser({ username: 'amelie_p' });
  await t.sql(`update profiles set display_name = 'Amélie Poulain' where id = $1`, [accented]);
});

after(async () => t?.close());

// ---------------------------------------------------------------------------

describe('matching', () => {
  it('finds an exact handle, and puts it first', async () => {
    const rows = await found('anna');
    assert.equal(rows[0], 'anna');
    // And "deanna" is still found — the exact match is a ranking tier, not a filter.
    assert.ok(rows.includes('deanna'));
  });

  it('finds a partial handle', async () => {
    assert.deepEqual(await found('dean'), ['deanna']);
  });

  it('matches inside a handle, not only at its start', async () => {
    // A handle is often a surname with a first name in front of it.
    assert.deepEqual(await found('burton'), ['tim_burton']);
  });

  it('prefers a prefix over a substring', async () => {
    const rows = await found('ann');
    assert.equal(rows[0], 'anna');
    assert.equal(rows[1], 'deanna');
  });

  it('ignores case, on both sides', async () => {
    assert.deepEqual(await found('ANNA'), await found('anna'));
    assert.ok((await found('TIM_bur')).includes('tim_burton'));
  });

  it('finds somebody by display name when the handle says nothing', async () => {
    assert.deepEqual(await found('gerwig'), ['xq_handle']);
  });

  it('folds accents, so "amelie" finds "Amélie"', async () => {
    // media_fold is reused rather than reimplemented: a second fold would be a second
    // set of rules to keep in step with title search.
    assert.deepEqual(await found('amelie poul'), ['amelie_p']);
  });

  it('returns nothing for a blank or whitespace-only query', async () => {
    // The difference between a search box and a directory dump.
    assert.deepEqual(await found(''), []);
    assert.deepEqual(await found('   '), []);
    assert.deepEqual(await found(null), []);
  });

  it('does not return the caller themselves', async () => {
    // Reversed by 20260819000100. Searching your own handle and getting nothing is a
    // little surprising; a "You" row in a list of people to follow is a control that
    // cannot exist, and leaving the exclusion to the client meant every future caller
    // had to remember it. Discovery is about other people.
    assert.deepEqual(await found('searcher'), []);
  });
});

// ---------------------------------------------------------------------------

describe('who is not returned', () => {
  /**
   * **A private account is findable, and 20260819000100 is where that changed.**
   *
   * The rule this replaces made private mean *unreachable*: a friend who knew the
   * handle could not send a follow request, so the only way to be found was to publish
   * your collection. Private is now about content — everything behind
   * `can_view_profile` is unmoved — and discovery is its own predicate.
   *
   * What comes back is identity and nothing else: handle, display name, avatar,
   * visibility. The tests below are the boundary; `private-discovery.test.mjs` is where
   * the content half is proved still shut.
   */
  it('includes a private account the caller does not follow', async () => {
    await t.createUser({ username: 'shy_person', visibility: 'private' });

    assert.deepEqual(await found('shy_person'), ['shy_person']);
  });

  it('includes a private account the caller follows', async () => {
    const shy = await t.createUser({ username: 'shy_friend', visibility: 'private' });
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [viewer, shy],
    );

    assert.deepEqual(await found('shy_friend'), ['shy_friend']);
  });

  it('includes a private account with only a pending request', async () => {
    // The state of the request has stopped mattering to *discovery*. It still decides
    // everything about what can be read, which is the point of separating the two: a
    // pending request is exactly the state somebody reaches by finding an account they
    // cannot yet read.
    const shy = await t.createUser({ username: 'shy_pending', visibility: 'private' });
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'pending')`,
      [viewer, shy],
    );

    assert.deepEqual(await found('shy_pending'), ['shy_pending']);
  });

  it('reports the visibility, so a row can say the account is private', async () => {
    // Without this the client would have to guess, and a private account presented as
    // an open one is a Follow control that silently becomes a request.
    await t.createUser({ username: 'shy_labelled', visibility: 'private' });

    const { rows } = await t.sql(
      `select username, visibility from search_users($1, 30)`,
      ['shy_labelled'],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].visibility, 'private');
  });

  it('omits an account that has blocked the caller', async () => {
    const hostile = await t.createUser({ username: 'hostile_person' });
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [hostile, viewer]);

    assert.deepEqual(await found('hostile_person'), []);
  });

  it('omits an account the caller has blocked', async () => {
    // Both directions. A block is not one-way invisibility.
    const unwanted = await t.createUser({ username: 'unwanted_person' });
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [viewer, unwanted]);

    assert.deepEqual(await found('unwanted_person'), []);
  });

  it('omits a suspended account, even from somebody who follows them', async () => {
    const gone = await t.createUser({ username: 'suspended_person' });
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [viewer, gone],
    );
    assert.deepEqual(await found('suspended_person'), ['suspended_person']);

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [gone]);

    assert.deepEqual(await found('suspended_person'), []);
  });

  it('excludes any status that is not active, which is what "deactivated" will be', async () => {
    // Worth stating plainly, because the brief asks for "suspension/deactivation" and
    // **this schema has no deactivated state**: `profile_status` is
    // ('active', 'suspended') and nothing else (20260813001700).
    //
    // So `search_users` filters `status = 'active'` rather than `status <> 'suspended'`.
    // That is belt as well as braces — `can_view_profile` already refuses a suspended
    // subject — and it is the half that keeps working when a third status is added.
    // Deactivation is Phase F's decision; this assertion is what makes adding it safe
    // here without anybody remembering to come back.
    const { rows } = await t.sql(
      `select enumlabel from pg_enum e
         join pg_type t on t.oid = e.enumtypid
        where t.typname = 'profile_status' order by enumlabel`,
    );
    assert.deepEqual(
      rows.map((r) => r.enumlabel),
      ['active', 'suspended'],
      'if a status was added, check that search_users still excludes it',
    );

    const { rows: source } = await t.sql(
      `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'search_users'`,
    );
    assert.match(source[0].prosrc, /status\s*=\s*'active'/);
  });

  it('tells an anonymous caller nothing', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select username from search_users($1, 30)`, ['anna']),
    );
    await t.actAs(viewer);

    // Refused at the grant. `authenticated` only: there is no signed-out surface that
    // lists people, and a grant should follow a surface rather than precede it.
    assert.equal(error?.code, '42501');
  });
});

// ---------------------------------------------------------------------------

describe('the shape of the answer', () => {
  it('cannot be pointed at another viewer’s perspective', async () => {
    // 20260813001900's rule. A definer read that accepted a viewer would let any
    // caller enumerate somebody else's approved follows and blocks.
    const { rows } = await t.sql(
      `select pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'search_users'`,
    );
    assert.equal(rows.length, 1);
    assert.doesNotMatch(rows[0].args, /uuid/);
  });

  it('caps what one call can return', async () => {
    const { rows } = await t.sql(`select count(*)::int as n from search_users($1, 9999)`, ['a']);
    assert.ok(rows[0].n <= 30, `got ${rows[0].n}`);
  });

  it('projects only the fields a result row draws', async () => {
    const { rows } = await t.sql(`select * from search_users($1, 1)`, ['anna']);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      'avatar_path',
      'display_name',
      'id',
      'username',
      'visibility',
    ]);
  });
});

describe('title search is unchanged', () => {
  it('still finds a film, and still returns no people', async () => {
    // The founder's last regression item. `search_titles` was not touched, and this
    // asserts that rather than assuming it.
    const id = await t.createMovie('Anna Karenina', 71001);
    const { rows } = await t.sql(`select id, title from search_titles($1, 20)`, ['anna karenina']);

    assert.ok(rows.some((r) => r.id === id));
    assert.ok(!Object.keys(rows[0]).includes('username'));
  });
});
