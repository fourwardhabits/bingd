import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Row level security, tested from the position of an attacker rather than an
 * owner.
 *
 * Every test here runs inside `asUser` or `asAnon`, which switch into a real
 * Supabase role. That matters because Postgres skips policies for the table
 * owner: the rest of the suite runs as owner and therefore cannot see a policy
 * defect at all. An independent review found four holes in that blind spot on
 * 2026-08-13, and each of them has a test below.
 *
 * The shape of every test is the same. Set up as owner, switch to the role of
 * somebody who should not be able to see a thing, and assert they get nothing
 * back. A policy test that only checks the permitted case is close to worthless,
 * because the permitted case is what an owner-privileged run already proves.
 */

let t;

// Shared cast, created once. Alice and Bob are strangers with public profiles;
// Priya is private; Mallory is the one who should never get anything.
let alice;
let bob;
let priya;
let mallory;

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice', dob: '1990-03-04' });
  bob = await t.createUser({ username: 'bob', dob: '1988-07-11' });
  priya = await t.createUser({ username: 'priya', visibility: 'private', dob: '1995-01-20' });
  mallory = await t.createUser({ username: 'mallory', dob: '1992-09-30' });
});

after(async () => {
  await t?.close();
});

describe('the harness enforces policies at all', () => {
  // If this fails, every other test in this file is meaningless, so it is first
  // and it asserts the contrast directly.
  it('hides a private profile from a stranger but not from the owner role', async () => {
    const asOwner = await t.sql(`select id from profiles where id = $1`, [priya]);
    assert.equal(asOwner.rows.length, 1, 'owner should bypass RLS — that is the point');

    const asStranger = await t.asUser(mallory, () =>
      t.sql(`select id from profiles where id = $1`, [priya]),
    );
    assert.equal(asStranger.rows.length, 0, 'a private profile leaked to a stranger');
  });

  it('gives an anonymous reader public profiles only', async () => {
    const { rows } = await t.asAnon(() => t.sql(`select username from profiles order by username`));
    const names = rows.map((r) => r.username);
    assert.ok(names.includes('alice'), 'public profiles are readable on the web pages');
    assert.ok(!names.includes('priya'), 'a private profile was exposed to an anonymous reader');
  });
});

describe('date of birth', () => {
  /**
   * profiles.date_of_birth is documented as "never returned by any API,
   * including the owner's own". RLS is row-level: a policy that admits the row
   * admits every column of it, so the guarantee cannot be written as a policy.
   * It has to be a separate table with no read path.
   */
  it('is not readable for another user', async () => {
    const err = await t.asUser(mallory, () =>
      t.errorFrom(`select date_of_birth from profiles where id = $1`, [alice]),
    );
    assert.ok(err, 'date_of_birth is still selectable from profiles');
    assert.match(err.message, /column .*date_of_birth.* does not exist/i);
  });

  it('is not readable even for yourself', async () => {
    const err = await t.asUser(alice, () =>
      t.errorFrom(`select date_of_birth from profiles where id = $1`, [alice]),
    );
    assert.ok(err, 'the documented guarantee excludes the owner too');
  });

  it('still answers the only question the product asks of it', async () => {
    const { rows } = await t.sql(`select is_over_13($1) as ok`, [alice]);
    assert.equal(rows[0].ok, true);
  });
});

describe('capability state', () => {
  /**
   * resolve_capabilities is SECURITY DEFINER and takes an arbitrary target, and
   * Postgres grants EXECUTE to PUBLIC on every new function. Between them, any
   * signed-in user could read anyone's entitlements.
   */
  it('cannot be resolved for an arbitrary user', async () => {
    const err = await t.asUser(mallory, () =>
      t.errorFrom(`select resolve_capabilities($1)`, [alice]),
    );
    assert.ok(err, 'capability state is readable for arbitrary users');
    assert.match(err.message, /permission denied/i);
  });

  it('is readable for yourself through the wrapper', async () => {
    const { rows } = await t.asUser(alice, () => t.sql(`select my_capabilities() as caps`));
    assert.deepEqual(rows[0].caps, ['base_free']);
  });

  it('does not leak age-gate state for an arbitrary user', async () => {
    const err = await t.asUser(mallory, () => t.errorFrom(`select is_over_13($1)`, [alice]));
    assert.ok(err, 'is_over_13 is callable for arbitrary users');
    assert.match(err.message, /permission denied/i);
  });

  it('does not expose another user grant rows', async () => {
    await t.sql(
      `insert into capability_grants (user_id, capability, source, expires_at)
       values ($1, 'alpha_early_access', 'alpha_early_access', now() + interval '30 days')`,
      [alice],
    );
    const { rows } = await t.asUser(mallory, () =>
      t.sql(`select capability from capability_grants where user_id = $1`, [alice]),
    );
    assert.equal(rows.length, 0);
  });
});

describe('link-visibility lists', () => {
  /**
   * A 'link' list is readable by someone holding the reference. The original
   * policy admitted `visibility in ('public','link')`, which is not the same
   * thing: it let a client list every link list of every visible owner, so the
   * level collapsed into 'public'. Possession of the identifier has to be the
   * gate, and RLS cannot express possession — so retrieval moves to an RPC.
   */
  let linkList;
  let privateList;

  before(async () => {
    const a = await t.sql(
      `insert into lists (owner_id, title, visibility) values ($1, 'Noir', 'link') returning id`,
      [bob],
    );
    linkList = a.rows[0].id;
    const b = await t.sql(
      `insert into lists (owner_id, title, visibility) values ($1, 'Secret', 'private') returning id`,
      [bob],
    );
    privateList = b.rows[0].id;
  });

  it('cannot be enumerated by a stranger', async () => {
    const { rows } = await t.asUser(mallory, () =>
      t.sql(`select id from lists where visibility = 'link'`),
    );
    assert.equal(rows.length, 0, 'link lists are enumerable, which makes them public');
  });

  it('is retrievable by a holder of the identifier', async () => {
    const { rows } = await t.asUser(mallory, () => t.sql(`select * from list_by_id($1)`, [linkList]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Noir');
  });

  it('does not make private lists retrievable by identifier', async () => {
    const { rows } = await t.asUser(mallory, () =>
      t.sql(`select * from list_by_id($1)`, [privateList]),
    );
    assert.equal(rows.length, 0, 'possession of an id must not defeat private');
  });

  it('does not expose the items of a list that cannot be seen', async () => {
    const movie = await t.createMovie('Chinatown', 90001);
    await t.sql(`insert into list_items (list_id, media_item_id, position) values ($1, $2, 1)`, [
      privateList,
      movie,
    ]);
    const { rows } = await t.asUser(mallory, () =>
      t.sql(`select media_item_id from list_items where list_id = $1`, [privateList]),
    );
    assert.equal(rows.length, 0);
  });
});

describe('blocking cuts watch tags both ways', () => {
  /**
   * PRD §22 requires a block to affect tagging along with everything else. The
   * original policy admitted `tagger_id = auth.uid() or tagged_id = auth.uid()`
   * before consulting the visibility helper, so neither party lost sight of the
   * tag and the block did nothing here.
   */
  let tag;

  before(async () => {
    const movie = await t.createMovie('Heat', 90002);
    const { rows } = await t.sql(
      `insert into watch_tags (tagger_id, tagged_id, media_item_id)
       values ($1, $2, $3) returning id`,
      [bob, mallory, movie],
    );
    tag = rows[0].id;
    // The tagged party blocks the tagger.
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [mallory, bob]);
  });

  it('hides the tag from the blocked tagger', async () => {
    const { rows } = await t.asUser(bob, () => t.sql(`select id from watch_tags where id = $1`, [tag]));
    assert.equal(rows.length, 0, 'the blocked tagger can still see the tag');
  });

  it('hides the tag from the blocker', async () => {
    const { rows } = await t.asUser(mallory, () =>
      t.sql(`select id from watch_tags where id = $1`, [tag]),
    );
    assert.equal(rows.length, 0, 'the blocker can still see the blocked user tag');
  });

  it('leaves an unblocked tag visible to both parties', async () => {
    const movie = await t.createMovie('Michael Clayton', 90003);
    const { rows } = await t.sql(
      `insert into watch_tags (tagger_id, tagged_id, media_item_id)
       values ($1, $2, $3) returning id`,
      [bob, alice, movie],
    );
    const ok = rows[0].id;
    for (const who of [bob, alice]) {
      const seen = await t.asUser(who, () => t.sql(`select id from watch_tags where id = $1`, [ok]));
      assert.equal(seen.rows.length, 1, 'a normal tag must remain visible');
    }
  });
});

describe('function and table privileges', () => {
  /**
   * Postgres grants EXECUTE to PUBLIC on every function it creates, and Supabase
   * additionally grants it to anon and authenticated. So a SECURITY DEFINER
   * helper is reachable by any client unless it is explicitly revoked. For the
   * ranking internals that is not theoretical: reaching _rank_finalize directly
   * would place a title without answering a single comparison.
   */
  it('does not expose internal helpers to client roles', async () => {
    const { rows } = await t.sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join unnest(array['anon','authenticated']) as r(rolname)
       where n.nspname = 'public'
         and p.proname like '\\_%'
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    assert.deepEqual(
      rows.map((r) => `${r.rolname} can execute ${r.proname}`),
      [],
    );
  });

  it('does not let a client write to a table directly', async () => {
    // AD-4 rests on RLS denying by default, which it does. The grants are
    // revoked as well, so a later stray policy cannot open a write path on its
    // own. Two independent layers, because this one is expensive to get wrong.
    const { rows } = await t.sql(`
      select table_name, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee in ('anon', 'authenticated', 'public')
         and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
       order by table_name, privilege_type
    `);
    assert.deepEqual(rows, []);
  });

  it('refuses a direct insert attempt from a client role', async () => {
    const err = await t.asUser(mallory, () =>
      t.errorFrom(`insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`, [
        mallory,
        alice,
      ]),
    );
    assert.ok(err, 'a client wrote to a table directly');
  });
});

/**
 * The read behind the Invite Instigator award, which moved onto this table on
 * 2026-08-18.
 *
 * The award used to count `invite_link_creations` — links minted — and now counts
 * people who joined on somebody's invitation and used it. Nothing writes
 * `invite_attributions` yet, so on a real database the count is zero for everybody;
 * these rows are inserted as owner to prove the *read path* is the one the client
 * thinks it is, and that it is scoped.
 *
 * That matters because "the number is zero" and "the request failed" look identical
 * from the client, and the sheet deliberately renders them differently. If the grant
 * or the policy were wrong, every account would see "Could not load this one" on a row
 * that is supposed to read `0 / 3`.
 */
describe('the invite attribution behind the award', () => {
  before(async () => {
    await t.sql(
      `insert into invite_attributions (invitee_id, inviter_id, accepted_at, activated_at)
       values ($1, $2, now(), now())`,
      [bob, alice],
    );
    // Accepted but never activated. The award counts the stricter of the two.
    await t.sql(
      `insert into invite_attributions (invitee_id, inviter_id, accepted_at)
       values ($1, $2, now())`,
      [priya, alice],
    );
  });

  it('lets an inviter count the people who joined and used it', async () => {
    const { rows } = await t.asUser(alice, () =>
      t.sql(
        `select count(*)::int as n from invite_attributions
          where inviter_id = $1 and activated_at is not null`,
        [alice],
      ),
    );
    assert.equal(rows[0].n, 1, 'the inviter cannot read their own attributions');
  });

  it('counts activation rather than acceptance, so a dormant signup is not a badge', async () => {
    const { rows } = await t.asUser(alice, () =>
      t.sql(`select count(*)::int as n from invite_attributions where inviter_id = $1`, [alice]),
    );
    // Two rows exist and only one of them is activated. The award's filter is what
    // makes the difference, and this is the row it deliberately does not count.
    assert.equal(rows[0].n, 2);
  });

  it('shows a stranger nothing at all', async () => {
    const { rows } = await t.asUser(mallory, () =>
      t.sql(`select invitee_id from invite_attributions`),
    );
    assert.deepEqual(rows, [], 'invite attributions leaked to somebody outside the pair');
  });

  it('lets the invitee see who they are attributed to', async () => {
    // Both parties, by policy: the inviter needs their count and the invitee is
    // entitled to know how they were brought in.
    const { rows } = await t.asUser(bob, () =>
      t.sql(`select inviter_id from invite_attributions`),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].inviter_id, alice);
  });

  it('grants the select the client depends on, and no write', async () => {
    const { rows } = await t.sql(`
      select privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public'
         and table_name = 'invite_attributions'
         and grantee = 'authenticated'
       order by privilege_type
    `);
    assert.ok(
      rows.some((row) => row.privilege_type === 'SELECT'),
      'the award read would fail for every account',
    );
    assert.deepEqual(
      rows.filter((row) => ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type)),
      [],
    );
  });
});

/**
 * The watchlist, after it stopped being a private domain.
 *
 * `20260820000200` replaced `watchlist_own` (`user_id = auth.uid()`) with
 * `watchlist_read` (`can_i_view(user_id)`), so the shelf on a profile is authorised by
 * the same oracle as the rankings above it. That is a *widening*, which is the kind of
 * change that has to be tested from the outside rather than reasoned about: the whole
 * point of this file is that the owner role cannot see a policy at all.
 *
 * Four cases, and the two that matter most are the negative ones. A private account's
 * watchlist must leak neither its titles nor its *count* — a `count(*)` of 3 on a
 * profile that shows nothing is still the disclosure, and it is the one a client-side
 * privacy check would have left open.
 */
describe('watchlist visibility follows the profile', () => {
  let film;
  let second;

  before(async () => {
    film = await t.createMovie('A Watchlisted Film', 90201);
    second = await t.createMovie('Another Watchlisted Film', 90202);
    // Alice is public, Priya is private. Both save both films.
    for (const owner of [alice, priya]) {
      await t.sql(
        `insert into watchlist (user_id, media_item_id) values ($1, $2), ($1, $3)
         on conflict do nothing`,
        [owner, film, second],
      );
    }
  });

  it('lets a stranger read a public account watchlist', async () => {
    const { rows } = await t.asUser(mallory, () =>
      t.sql(`select media_item_id from watchlist where user_id = $1`, [alice]),
    );
    assert.equal(rows.length, 2, 'a public profile shelf would be empty for every visitor');
  });

  it('shows a private account watchlist to nobody who does not follow it', async () => {
    const { rows } = await t.asUser(mallory, () =>
      t.sql(`select media_item_id from watchlist where user_id = $1`, [priya]),
    );
    assert.deepEqual(rows, [], 'a private watchlist leaked its titles');
  });

  it('does not leak the count of a private account watchlist either', async () => {
    // The section hides on an empty read, so a visible-but-empty shelf is the same
    // thing as no shelf. A count that came back non-zero would be the leak on its own.
    const { rows } = await t.asUser(mallory, () =>
      t.sql(`select count(*)::int as n from watchlist where user_id = $1`, [priya]),
    );
    assert.equal(rows[0].n, 0, 'a private watchlist leaked how many titles are on it');
  });

  it('shows a private account watchlist to an approved follower', async () => {
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')
       on conflict (follower_id, followee_id) do update set state = 'approved'`,
      [bob, priya],
    );

    const { rows } = await t.asUser(bob, () =>
      t.sql(`select media_item_id from watchlist where user_id = $1`, [priya]),
    );
    assert.equal(rows.length, 2, 'an approved follower sees the rest of the profile but not this');
  });

  it('hides it across a block in either direction', async () => {
    await t.sql(
      `insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`,
      [alice, mallory],
    );

    const blockedReader = await t.asUser(mallory, () =>
      t.sql(`select media_item_id from watchlist where user_id = $1`, [alice]),
    );
    assert.deepEqual(blockedReader.rows, [], 'a blocked account still read the blocker watchlist');

    const blocker = await t.asUser(alice, () =>
      t.sql(`select media_item_id from watchlist where user_id = $1`, [mallory]),
    );
    assert.deepEqual(blocker.rows, [], 'a blocker still read the blocked account watchlist');

    await t.sql(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [alice, mallory]);
  });

  it('still refuses every direct write, which widening a select must not have changed', async () => {
    for (const statement of [
      [`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [alice, film]],
      [`delete from watchlist where user_id = $1`, [alice]],
      [`update watchlist set media_item_id = $2 where user_id = $1`, [alice, second]],
    ]) {
      const before = await t.sql(`select count(*)::int as n from watchlist where user_id = $1`, [
        alice,
      ]);
      // RLS denies by default: with no insert/update/delete policy these either raise
      // or silently affect nothing. Either is a refusal; a changed row count is not.
      await t.asUser(mallory, () => t.sql(statement[0], statement[1])).catch(() => {});
      const now = await t.sql(`select count(*)::int as n from watchlist where user_id = $1`, [
        alice,
      ]);
      assert.equal(now.rows[0].n, before.rows[0].n, `a client role wrote through: ${statement[0]}`);
    }
  });
});
