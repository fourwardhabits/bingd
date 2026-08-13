import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Tests for a class of leak that policy-helper functions invite.
 *
 * A row level security policy is evaluated as the *querying* role, so any helper
 * a policy calls must be executable by clients. That grant is unavoidable. What
 * is avoidable is the helper's *signature*: a SECURITY DEFINER function bypasses
 * RLS by design, so if it accepts the identity to check as an argument, a caller
 * can substitute someone else's identity and read answers about relationships
 * they have no part in.
 *
 * `can_view_profile(viewer, subject)` is the sharpest case. It is the schema's
 * single visibility rule, granted to `anon` because policies in eight migrations
 * call it. Taking `viewer` as a parameter means an unauthenticated stranger can
 * ask "can Alice see Bob?" — and since the answer folds in blocks, suspension,
 * and approved follows, the reply discloses a private social graph one bit at a
 * time.
 *
 * The fix is to derive the identity internally from auth.uid() rather than
 * accepting it, so the only question a caller can ask is about themselves. These
 * tests exist to keep it that way.
 */

test('a stranger cannot ask whether one user can see another', async () => {
  const t = await createTestDb();
  try {
    const alice = await t.createUser({ username: 'alice' });
    const bob = await t.createUser({ username: 'bob', visibility: 'private' });

    // Alice follows Bob, and Bob approved. That is private between them.
    await t.sql(
      `insert into follows (follower_id, followee_id, state)
       values ($1, $2, 'approved')`,
      [alice, bob],
    );

    await t.asAnon(async () => {
      const err = await t.errorFrom(`select can_view_profile($1, $2)`, [alice, bob]);
      assert.ok(
        err,
        'an anonymous caller answered "can Alice see Bob?", which discloses that ' +
          'Alice follows a private account. The viewer must come from auth.uid(), ' +
          'not from an argument.',
      );
      assert.match(err.message, /permission denied|does not exist/i);
    });
  } finally {
    await t.close();
  }
});

test('a signed-in user cannot ask about a relationship they are not part of', async () => {
  const t = await createTestDb();
  try {
    const alice = await t.createUser({ username: 'alice' });
    const bob = await t.createUser({ username: 'bob', visibility: 'private' });
    const eve = await t.createUser({ username: 'eve' });

    await t.sql(
      `insert into follows (follower_id, followee_id, state)
       values ($1, $2, 'approved')`,
      [alice, bob],
    );

    // Eve is a stranger to both. Holding an account must not upgrade her to
    // observer of other people's follow graph.
    await t.asUser(eve, async () => {
      const err = await t.errorFrom(`select can_view_profile($1, $2)`, [alice, bob]);
      assert.ok(err, 'Eve learned whether Alice can see Bob');
    });
  } finally {
    await t.close();
  }
});

test('the block graph is not readable by an unauthenticated caller', async () => {
  const t = await createTestDb();
  try {
    const alice = await t.createUser({ username: 'alice' });
    const carol = await t.createUser({ username: 'carol' });

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [carol, alice]);

    // blocks_read exists so that a block is visible only to the person who made
    // it. A definer helper taking both parties as arguments hands that same fact
    // to the entire internet.
    await t.asAnon(async () => {
      const err = await t.errorFrom(`select blocked_between($1, $2)`, [carol, alice]);
      assert.ok(
        err,
        'an anonymous caller read the private block graph through blocked_between',
      );
    });
  } finally {
    await t.close();
  }
});

test('a signed-in stranger cannot enumerate blocks between other people', async () => {
  const t = await createTestDb();
  try {
    const alice = await t.createUser({ username: 'alice' });
    const carol = await t.createUser({ username: 'carol' });
    const eve = await t.createUser({ username: 'eve' });

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [carol, alice]);

    await t.asUser(eve, async () => {
      const err = await t.errorFrom(`select blocked_between($1, $2)`, [carol, alice]);
      assert.ok(err, 'Eve read a block she has no part in');
    });
  } finally {
    await t.close();
  }
});

test('the visibility rule still works for the caller themselves', async () => {
  const t = await createTestDb();
  try {
    // The replacement must remain usable, or every read in the schema breaks.
    const alice = await t.createUser({ username: 'alice' });
    const bob = await t.createUser({ username: 'bob', visibility: 'private' });

    await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select can_i_view($1) as v`, [bob]);
      assert.equal(rows[0].v, false, 'a private non-followed profile is not visible');
    });

    await t.sql(
      `insert into follows (follower_id, followee_id, state)
       values ($1, $2, 'approved')`,
      [alice, bob],
    );

    await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select can_i_view($1) as v`, [bob]);
      assert.equal(rows[0].v, true, 'an approved follower can see a private profile');
    });
  } finally {
    await t.close();
  }
});

test('policies still filter correctly once the helper takes no viewer argument', async () => {
  const t = await createTestDb();
  try {
    // The regression that matters most: can_view_profile is named by policies
    // across eight migrations, so a botched swap fails entire queries rather than
    // filtering them, and the symptom looks nothing like a grant problem.
    const alice = await t.createUser({ username: 'alice' });
    const bob = await t.createUser({ username: 'bob', visibility: 'private' });

    const anonSees = await t.asAnon(async () => {
      const { rows } = await t.sql(`select username from profiles order by username`);
      return rows.map((r) => r.username);
    });
    assert.deepEqual(anonSees, ['alice'], 'a signed-out reader sees only public profiles');

    const bobSees = await t.asUser(bob, async () => {
      const { rows } = await t.sql(`select username from profiles order by username`);
      return rows.map((r) => r.username);
    });
    assert.deepEqual(bobSees, ['alice', 'bob'], 'bob sees the public profile and his own');

    void alice;
  } finally {
    await t.close();
  }
});
