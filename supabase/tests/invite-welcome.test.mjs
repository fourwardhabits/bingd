import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The invitee's own welcome, 20260823000100.
 *
 * `redeem_invite` has always notified the *inviter* and has, since `20260819000500`,
 * created the invitee's follow for them. The invitee themselves was told nothing — so
 * the one person in the exchange who had never seen the app before arrived to a follow
 * they did not watch happen and an empty inbox. A beta tester reported it as a Feed
 * that begins empty.
 *
 * The properties that carry this row:
 *
 *   1. **Exactly one, for good.** Not by a guard but by position: the insert sits after
 *      the `invite_attributions` write, which the primary key on `invitee_id` allows to
 *      succeed exactly once per account. A replay, a second token and a second inviter
 *      each stop earlier. The partial unique index is the backstop for a future writer.
 *   2. **It is the invitee's row and names the inviter.** Recipient and actor are the
 *      two halves that were previously the wrong way round.
 *   3. **It survives a preference the reader has never seen.** It is exempt from the
 *      category gate for the same reason `follow_request` is: it fires once, at account
 *      creation, before anybody could have chosen anything.
 *   4. **A refused redemption writes nothing.** Blocked, self, unknown token and a
 *      suspended inviter all leave the inbox empty — the welcome is a consequence of a
 *      successful attribution and of nothing else.
 *   5. **Nothing else moved.** The follow, the inviter's own notification and the
 *      return shape are `20260819000500`'s and are asserted here unchanged.
 */

let t;

const call = async (sql, params = []) => {
  const { rows } = await t.sql(`select ${sql} as r`, params);
  return rows[0].r;
};

const newUser = (username, visibility = 'public') => t.createUser({ username, visibility });

const mintLink = async (owner) => {
  await t.actAs(owner);
  const result = await call(`create_invite_link(gen_random_uuid())`);
  assert.equal(result.status, 'ok');
  return result.token;
};

const redeem = (token) => call(`redeem_invite(gen_random_uuid(), $1)`, [token]);

/** Every welcome this account holds, which should never be more than one row. */
const welcomes = async (recipient) => {
  const { rows } = await t.sql(
    `select type, actor_id, subject_type, subject_id, read_at
       from notifications
      where recipient_id = $1 and type = 'invite_welcome'`,
    [recipient],
  );
  return rows;
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

describe('the welcome an invitation writes back', () => {
  it('files exactly one row, for the invitee, naming the inviter', async () => {
    const inviter = await newUser('welcome_inviter');
    const invitee = await newUser('welcome_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    assert.equal((await redeem(token)).status, 'ok');

    const rows = await welcomes(invitee);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, inviter);
    assert.equal(rows[0].subject_type, 'profile');
    assert.equal(rows[0].subject_id, inviter);
  });

  it('arrives unread, so it reaches the bell', async () => {
    const inviter = await newUser('unread_inviter');
    const invitee = await newUser('unread_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);

    assert.equal((await welcomes(invitee))[0].read_at, null);
  });

  it('does not give the inviter one — their row is the follow', async () => {
    const inviter = await newUser('halves_inviter');
    const invitee = await newUser('halves_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);

    assert.deepEqual(await welcomes(inviter), []);

    const { rows } = await t.sql(
      `select type from notifications where recipient_id = $1 and actor_id = $2`,
      [inviter, invitee],
    );
    assert.deepEqual(
      rows.map((row) => row.type),
      ['follow'],
    );
  });

  /**
   * The replay path. `_claim_operation` answers `already_applied` before any of the
   * work runs, so the second call cannot reach the insert at all.
   */
  it('writes nothing more when the same operation is replayed', async () => {
    const inviter = await newUser('replay_inviter');
    const invitee = await newUser('replay_invitee');
    const token = await mintLink(inviter);
    const operation = (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

    await t.actAs(invitee);
    const first = await call(`redeem_invite($1, $2)`, [operation, token]);
    const second = await call(`redeem_invite($1, $2)`, [operation, token]);

    assert.equal(first.status, 'ok');
    assert.equal(second.status, 'already_applied');
    assert.equal((await welcomes(invitee)).length, 1);
  });

  /**
   * The other retry: a genuinely new operation id, which is what a second device or a
   * lost reply produces. This one runs the body and is stopped by the attribution's
   * primary key.
   */
  it('writes nothing more when the invitation is redeemed a second time', async () => {
    const inviter = await newUser('again_inviter');
    const invitee = await newUser('again_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    assert.equal((await redeem(token)).status, 'ok');
    const second = await redeem(token);

    assert.equal(second.status, 'refused');
    assert.equal(second.reason, 'already_attributed');
    assert.equal((await welcomes(invitee)).length, 1);
  });

  it('writes nothing more when a different inviter is redeemed afterwards', async () => {
    const first = await newUser('first_inviter');
    const other = await newUser('other_inviter');
    const invitee = await newUser('two_inviters_invitee');
    const firstToken = await mintLink(first);
    const otherToken = await mintLink(other);

    await t.actAs(invitee);
    await redeem(firstToken);
    assert.equal((await redeem(otherToken)).reason, 'already_attributed');

    const rows = await welcomes(invitee);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, first, 'the first inviter keeps the credit and the row');
  });

  it('reaches an invitee who has switched every category off', async () => {
    const inviter = await newUser('silent_inviter');
    const invitee = await newUser('silent_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await t.sql(`select set_notification_preferences(_notification_categories(), false)`);
    await redeem(token);

    assert.equal(
      (await welcomes(invitee)).length,
      1,
      'a welcome is exempt from the category gate, like a follow request',
    );
  });
});

describe('a redemption that is refused writes no welcome', () => {
  it('says nothing on an unknown token', async () => {
    const invitee = await newUser('unknown_token_invitee');
    await t.actAs(invitee);

    const result = await call(`redeem_invite(gen_random_uuid(), $1)`, ['0'.repeat(32)]);

    assert.equal(result.reason, 'invalid');
    assert.deepEqual(await welcomes(invitee), []);
  });

  it('says nothing when somebody opens their own link', async () => {
    const owner = await newUser('self_inviter');
    const token = await mintLink(owner);

    await t.actAs(owner);
    const result = await redeem(token);

    assert.equal(result.reason, 'self');
    assert.deepEqual(await welcomes(owner), []);
  });

  it('says nothing across a block', async () => {
    const inviter = await newUser('blocking_inviter');
    const invitee = await newUser('blocked_invitee');
    const token = await mintLink(inviter);

    await t.actAs(inviter);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
      inviter,
      invitee,
    ]);

    await t.actAs(invitee);
    const result = await redeem(token);

    assert.equal(result.reason, 'blocked');
    assert.deepEqual(await welcomes(invitee), []);
  });

  it('says nothing when the inviter is suspended', async () => {
    const inviter = await newUser('suspended_inviter');
    const invitee = await newUser('suspended_invitee');
    const token = await mintLink(inviter);

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [inviter]);

    await t.actAs(invitee);
    const result = await redeem(token);

    assert.equal(result.reason, 'unavailable');
    assert.deepEqual(await welcomes(invitee), []);
  });
});

describe('what the welcome did not change', () => {
  it('still creates the invitee follow, approved for a public inviter', async () => {
    const inviter = await newUser('public_inviter');
    const invitee = await newUser('public_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    const result = await redeem(token);

    assert.equal(result.follow_state, 'approved');
    const { rows } = await t.sql(
      `select state from follows where follower_id = $1 and followee_id = $2`,
      [invitee, inviter],
    );
    assert.equal(rows[0].state, 'approved');
  });

  it('still requests rather than follows a private inviter', async () => {
    const inviter = await newUser('private_inviter', 'private');
    const invitee = await newUser('private_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    const result = await redeem(token);

    assert.equal(result.follow_state, 'pending');
    const { rows } = await t.sql(
      `select state from follows where follower_id = $1 and followee_id = $2`,
      [invitee, inviter],
    );
    assert.equal(rows[0].state, 'pending');
    // And the welcome is filed either way — it is about who invited them, not about
    // whether the follow landed.
    assert.equal((await welcomes(invitee)).length, 1);
  });

  it('still names the inviter in what it returns', async () => {
    const inviter = await newUser('returned_inviter');
    const invitee = await newUser('returned_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    const result = await redeem(token);

    assert.equal(result.inviter_id, inviter);
    assert.equal(result.inviter_username, 'returned_inviter');
  });
});
