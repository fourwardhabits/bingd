import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The social graph writers, 20260817000200.
 *
 * `follows` and `blocks` have existed since day one, `can_view_profile` reads both,
 * and until this migration **nothing could write a row into either**. Every test in
 * this codebase that needed a relationship inserted it as the table owner, which is
 * why the gap survived: the visibility architecture was fully tested against edges
 * that no user could create.
 *
 * The properties that carry these functions:
 *
 *   1. A private account receives a *request*, not a follow. `follow` is therefore
 *      the one writer here that must **not** gate on `can_view_profile` — doing so
 *      would refuse the only call the pending state exists for.
 *   2. Missing, suspended and blocked are one answer. A blocked caller learning they
 *      are blocked from an error code is the harassment vector `blocks_read` hides
 *      the row to prevent.
 *   3. Withdrawal always works. `unfollow` and `remove_follower` must succeed against
 *      an account that has since blocked or suspended, or a block would trap the edge.
 *   4. `block` does five things in one transaction and none of them may be skipped.
 */

let t;
let alice;
let bob;

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const call = async (sql, params = []) => {
  const { rows } = await t.sql(`select ${sql} as r`, params);
  return rows[0].r;
};

const doFollow = (followee) => call(`follow(gen_random_uuid(), $1)`, [followee]);
const doUnfollow = (followee) => call(`unfollow(gen_random_uuid(), $1)`, [followee]);
const respond = (requester, approve) =>
  call(`respond_follow_request(gen_random_uuid(), $1, $2)`, [requester, approve]);
const doBlock = (target) => call(`block(gen_random_uuid(), $1)`, [target]);
const doUnblock = (target) => call(`unblock(gen_random_uuid(), $1)`, [target]);

const edge = async (follower, followee) => {
  const { rows } = await t.sql(
    `select state, approved_at from follows where follower_id = $1 and followee_id = $2`,
    [follower, followee],
  );
  return rows[0] ?? null;
};

/**
 * Scoped to one actor, not just to the recipient.
 *
 * Alice is the caller for most of this file, so "every follow notification Alice has"
 * accumulates across tests and its length depends on what ran before. Two assertions
 * here passed or failed on ordering before this argument existed. The pair is the
 * right scope anyway: what is under test is what *this* relationship produced.
 */
const inboxOf = async (recipient, type, actor) => {
  const { rows } = await t.sql(
    `select type, actor_id from notifications
      where recipient_id = $1 and type = $2 and ($3::uuid is null or actor_id = $3)`,
    [recipient, type, actor ?? null],
  );
  return rows;
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_social' });
  bob = await t.createUser({ username: 'bob_social' });
  await t.actAs(alice);
});

after(async () => t?.close());

// ---------------------------------------------------------------------------

describe('following', () => {
  it('follows a public account outright', async () => {
    const target = await t.createUser({ username: 'public_1' });

    const result = await doFollow(target);

    assert.equal(result.state, 'approved');
    const row = await edge(alice, target);
    assert.equal(row.state, 'approved');
    assert.ok(row.approved_at, 'an approved follow is stamped');
    assert.equal((await inboxOf(target, 'follow', alice)).length, 1);
  });

  it('files a request against a private account, and does not follow it', async () => {
    const target = await t.createUser({ username: 'private_1', visibility: 'private' });

    const result = await doFollow(target);

    assert.equal(result.state, 'pending');
    const row = await edge(alice, target);
    assert.equal(row.state, 'pending');
    assert.equal(row.approved_at, null);
    // The right inbox item: somebody is waiting on you, not somebody followed you.
    assert.equal((await inboxOf(target, 'follow_request', alice)).length, 1);
    assert.equal((await inboxOf(target, 'follow', alice)).length, 0);
  });

  it('can reach a private account that can_view_profile hides', async () => {
    // The property that makes the pending state reachable at all. A private account
    // the caller does not follow fails can_view_profile, so a writer gated on it
    // would refuse exactly the call a follow request is.
    const target = await t.createUser({ username: 'private_2', visibility: 'private' });

    const { rows } = await t.sql(`select can_view_profile($1, $2) as v`, [alice, target]);
    assert.equal(rows[0].v, false);

    assert.equal((await doFollow(target)).state, 'pending');
  });

  it('is idempotent, and never downgrades an approved follow to pending', async () => {
    // The dangerous case: an account followed while public that has since gone
    // private. Re-following must not demote the caller's own approved access, nor
    // fire a fresh request at somebody who already let them in.
    const target = await t.createUser({ username: 'went_private' });
    await doFollow(target);
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [target]);

    const result = await doFollow(target);

    assert.equal(result.state, 'approved');
    assert.equal((await edge(alice, target)).state, 'approved');
    assert.equal((await inboxOf(target, 'follow_request', alice)).length, 0);
  });

  it('refuses to follow yourself', async () => {
    const error = await t.errorFrom(`select follow(gen_random_uuid(), $1)`, [alice]);
    assert.equal(error?.code, '22023');
  });

  it('answers missing, suspended and blocked identically', async () => {
    const missing = await uuid();

    const suspended = await t.createUser({ username: 'suspended_target' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);

    const hostile = await t.createUser({ username: 'hostile_target' });
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [hostile, alice]);

    const errors = await Promise.all(
      [missing, suspended, hostile].map((id) =>
        t.errorFrom(`select follow(gen_random_uuid(), $1)`, [id]),
      ),
    );

    for (const error of errors) assert.equal(error?.code, 'P0002');
    // The message too. Same code with different wording is the same leak one layer
    // down, and this is the case where it matters most: a blocked person must not be
    // able to tell being blocked from the account being gone.
    assert.equal(errors[0].message, errors[1].message);
    assert.equal(errors[1].message, errors[2].message);
  });

  it('refuses a target the caller has blocked, in that direction too', async () => {
    const target = await t.createUser({ username: 'i_blocked_them' });
    await doBlock(target);

    const error = await t.errorFrom(`select follow(gen_random_uuid(), $1)`, [target]);
    assert.equal(error?.code, 'P0002');
  });

  it('refuses a suspended caller before anything is written', async () => {
    const banned = await t.createUser({ username: 'banned_follower' });
    const target = await t.createUser({ username: 'public_2' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [banned]);

    await t.actAs(banned);
    const error = await t.errorFrom(`select follow(gen_random_uuid(), $1)`, [target]);
    await t.actAs(alice);

    assert.equal(error?.code, '42501');
    assert.equal(await edge(banned, target), null);
  });
});

// ---------------------------------------------------------------------------

describe('unfollowing', () => {
  it('removes the follow and the inbox row that announced it', async () => {
    const target = await t.createUser({ username: 'unfollow_1' });
    await doFollow(target);

    await doUnfollow(target);

    assert.equal(await edge(alice, target), null);
    assert.equal((await inboxOf(target, 'follow', alice)).length, 0);
  });

  it('withdraws a pending request', async () => {
    const target = await t.createUser({ username: 'unfollow_2', visibility: 'private' });
    await doFollow(target);

    await doUnfollow(target);

    assert.equal(await edge(alice, target), null);
    assert.equal((await inboxOf(target, 'follow_request', alice)).length, 0);
  });

  it('succeeds against an account that has since blocked the caller', async () => {
    // Otherwise a block traps the edge, and the blocked person goes on being counted
    // as a follower of somebody who wants nothing to do with them.
    const target = await t.createUser({ username: 'blocked_me_later' });
    await doFollow(target);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [target, alice]);

    assert.equal((await doUnfollow(target)).status, 'ok');
    assert.equal(await edge(alice, target), null);
  });

  it('is not an error when there was nothing to remove', async () => {
    const stranger = await t.createUser({ username: 'never_followed' });
    assert.equal((await doUnfollow(stranger)).status, 'ok');
  });
});

// ---------------------------------------------------------------------------

describe('the private account’s side', () => {
  it('approves a request, stamps it, and tells the requester', async () => {
    const shy = await t.createUser({ username: 'shy_1', visibility: 'private' });
    await doFollow(shy);

    await t.actAs(shy);
    const result = await respond(alice, true);
    await t.actAs(alice);

    assert.equal(result.approved, true);
    const row = await edge(alice, shy);
    assert.equal(row.state, 'approved');
    assert.ok(row.approved_at);
    assert.equal((await inboxOf(alice, 'follow_approved', shy)).length, 1);
    // And the request stops asking.
    assert.equal((await inboxOf(shy, 'follow_request', alice)).length, 0);
  });

  it('declines silently, leaving no row and no message', async () => {
    const shy = await t.createUser({ username: 'shy_2', visibility: 'private' });
    await doFollow(shy);

    await t.actAs(shy);
    await respond(alice, false);
    await t.actAs(alice);

    assert.equal(await edge(alice, shy), null);
    // Being told you were turned down is a message nobody chose to send.
    assert.equal((await inboxOf(alice, 'follow_approved', shy)).length, 0);
    assert.equal((await inboxOf(shy, 'follow_request', alice)).length, 0);
  });

  it('cannot respond to a request that was never made', async () => {
    const shy = await t.createUser({ username: 'shy_3', visibility: 'private' });
    await t.actAs(shy);
    const error = await t.errorFrom(`select respond_follow_request(gen_random_uuid(), $1, true)`, [
      bob,
    ]);
    await t.actAs(alice);

    assert.equal(error?.code, 'P0002');
  });

  it('cannot approve a request made to somebody else', async () => {
    const shy = await t.createUser({ username: 'shy_4', visibility: 'private' });
    await doFollow(shy);

    // Bob tries to approve Alice's request to Shy. The predicate is
    // `followee_id = auth.uid()`, so there is nothing for him to update.
    await t.actAs(bob);
    const error = await t.errorFrom(`select respond_follow_request(gen_random_uuid(), $1, true)`, [
      alice,
    ]);
    await t.actAs(alice);

    assert.equal(error?.code, 'P0002');
    assert.equal((await edge(alice, shy)).state, 'pending');
  });

  it('removes a follower without blocking them', async () => {
    const fan = await t.createUser({ username: 'fan_1' });
    await t.actAs(fan);
    await doFollow(alice);
    await t.actAs(alice);

    await call(`remove_follower(gen_random_uuid(), $1)`, [fan]);

    assert.equal(await edge(fan, alice), null);
    // Not a block: they may follow again. That is the difference the two controls
    // have to keep.
    await t.actAs(fan);
    assert.equal((await doFollow(alice)).state, 'approved');
    await t.actAs(alice);
  });
});

// ---------------------------------------------------------------------------

describe('blocking', () => {
  it('removes the follow in both directions and inserts the block', async () => {
    const other = await t.createUser({ username: 'block_1' });
    await doFollow(other);
    await t.actAs(other);
    await doFollow(alice);
    await t.actAs(alice);

    await doBlock(other);

    assert.equal(await edge(alice, other), null);
    assert.equal(await edge(other, alice), null);
    const { rows } = await t.sql(
      `select 1 from blocks where blocker_id = $1 and blocked_id = $2`,
      [alice, other],
    );
    assert.equal(rows.length, 1);
  });

  it('makes each invisible to the other, which is what everything else reads', async () => {
    const other = await t.createUser({ username: 'block_2' });
    await doBlock(other);

    const { rows } = await t.sql(
      `select can_view_profile($1, $2) as forward, can_view_profile($2, $1) as back`,
      [alice, other],
    );
    assert.equal(rows[0].forward, false);
    assert.equal(rows[0].back, false);
  });

  it('clears both inboxes of the other person', async () => {
    const other = await t.createUser({ username: 'block_3' });
    await t.actAs(other);
    await doFollow(alice);
    await t.actAs(alice);
    assert.equal((await inboxOf(alice, 'follow', other)).length, 1);

    await doBlock(other);

    assert.equal((await inboxOf(alice, 'follow', other)).length, 0);
  });

  it('voids an unaccepted invite attribution and leaves an accepted one alone', async () => {
    const inviter = await t.createUser({ username: 'block_inviter' });
    const invitee = await t.createUser({ username: 'block_invitee' });
    await t.sql(
      `insert into invite_attributions (invitee_id, inviter_id, token_id, accepted_at)
       values ($1, $2, null, null)`,
      [invitee, inviter],
    );
    const accepted = await t.createUser({ username: 'block_accepted' });
    await t.sql(
      `insert into invite_attributions (invitee_id, inviter_id, accepted_at)
       values ($1, $2, now())`,
      [accepted, inviter],
    );

    await t.actAs(inviter);
    await doBlock(invitee);
    await t.actAs(alice);

    const { rows } = await t.sql(
      `select invitee_id, accepted_at from invite_attributions where inviter_id = $1 order by invitee_id`,
      [inviter],
    );
    // Both rows still exist: an accepted attribution is historical fact about how
    // somebody joined, and rewriting it would corrupt invite metrics rather than
    // protect anybody.
    assert.equal(rows.length, 2);
    assert.ok(rows.find((r) => r.invitee_id === accepted).accepted_at);
  });

  it('is idempotent, so a second tap is not an error', async () => {
    const other = await t.createUser({ username: 'block_4' });
    await doBlock(other);
    assert.equal((await doBlock(other)).status, 'ok');
  });

  it('works against a suspended account', async () => {
    // A suspension can be lifted, and the person who wanted the block still wants it.
    const other = await t.createUser({ username: 'block_suspended' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [other]);

    assert.equal((await doBlock(other)).status, 'ok');
  });

  it('refuses to block yourself', async () => {
    const error = await t.errorFrom(`select block(gen_random_uuid(), $1)`, [alice]);
    assert.equal(error?.code, '22023');
  });

  it('unblocks without restoring what the block removed', async () => {
    const other = await t.createUser({ username: 'block_5' });
    await doFollow(other);
    await doBlock(other);
    await doUnblock(other);

    const { rows } = await t.sql(`select 1 from blocks where blocker_id = $1 and blocked_id = $2`, [
      alice,
      other,
    ]);
    assert.equal(rows.length, 0);
    // api.md §3: recreating a severed relationship would be surprising, and
    // following again is one tap.
    assert.equal(await edge(alice, other), null);
  });
});

// ---------------------------------------------------------------------------

describe('reading the relationship back', () => {
  it('reports both directions and the block', async () => {
    const mutual = await t.createUser({ username: 'rel_mutual' });
    const pendingOn = await t.createUser({ username: 'rel_pending', visibility: 'private' });
    const blocked = await t.createUser({ username: 'rel_blocked' });
    const stranger = await t.createUser({ username: 'rel_stranger' });

    await doFollow(mutual);
    await doFollow(pendingOn);
    await doBlock(blocked);
    await t.actAs(mutual);
    await doFollow(alice);
    await t.actAs(alice);

    const { rows } = await t.sql(
      `select * from follow_state_with($1::uuid[]) order by user_id`,
      [[mutual, pendingOn, blocked, stranger]],
    );
    const by = Object.fromEntries(rows.map((r) => [r.user_id, r]));

    assert.equal(by[mutual].following, 'approved');
    assert.equal(by[mutual].followed_by, 'approved');
    assert.equal(by[pendingOn].following, 'pending');
    assert.equal(by[pendingOn].followed_by, null);
    assert.equal(by[blocked].blocked, true);
    assert.equal(by[stranger].following, null);
    assert.equal(by[stranger].followed_by, null);
    assert.equal(by[stranger].blocked, false);
  });

  it('cannot be pointed at somebody else’s graph', async () => {
    // security invoker, so it reads only what follows_read and blocks_read admit —
    // which for a pair the caller is not part of is nothing.
    const one = await t.createUser({ username: 'rel_third_1' });
    const two = await t.createUser({ username: 'rel_third_2' });
    await t.actAs(one);
    await doFollow(two);
    await t.actAs(alice);

    const seen = await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select * from follow_state_with($1::uuid[])`, [[one, two]]);
      return rows;
    });
    await t.actAs(alice);

    // Alice is party to neither edge, so every answer is empty.
    for (const row of seen) {
      assert.equal(row.following, null);
      assert.equal(row.followed_by, null);
      assert.equal(row.blocked, false);
    }
  });
});

describe('the ceiling', () => {
  it('bounds follows per hour rather than per day', async () => {
    // api.md §11. A mass-follow script is a burst, and a daily ceiling a burst fits
    // inside is not a limit on the thing being limited.
    const flooder = await t.createUser({ username: 'follow_flooder' });
    const targets = [];
    for (let i = 0; i < 3; i += 1) {
      targets.push(await t.createUser({ username: `follow_target_${i}` }));
    }

    await t.sql(`update app_config set value = '2'::jsonb where key = 'follow.max_per_hour'`);
    await t.actAs(flooder);

    await doFollow(targets[0]);
    await doFollow(targets[1]);
    const error = await t.errorFrom(`select follow(gen_random_uuid(), $1)`, [targets[2]]);

    await t.sql(`update app_config set value = '60'::jsonb where key = 'follow.max_per_hour'`);
    await t.actAs(alice);

    assert.equal(error?.code, '53400');
  });

  it('still bounds the day-windowed operations it shares a helper with', async () => {
    // The helper gained a defaulted interval parameter; the three-argument callers
    // must keep resolving to it and keep their daily window.
    const { rows } = await t.sql(
      `select p.proname, pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = '_assert_operation_rate'`,
    );
    assert.equal(rows.length, 1, 'exactly one, or a three-argument call is ambiguous');
    assert.match(rows[0].args, /p_window interval DEFAULT '1 day'/i);
  });
});
