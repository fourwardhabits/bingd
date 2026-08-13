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
