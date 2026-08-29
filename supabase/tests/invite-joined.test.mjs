import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The inviter's half of an acceptance, 20260831000100.
 *
 * `redeem_invite` has always told the inviter something. Until this migration it told
 * them the wrong thing: a plain `follow` row — "Ada Lovelace started following you" —
 * with nothing in it saying this person came through their invitation. The sentence
 * that says so, "joined bingd. from your invite", belonged to `invite_activated`, which
 * fires at the invitee's *tenth ranking*. So the interesting fact arrived days late or
 * never, and the moment it actually happened was reported as something duller.
 *
 * The properties that carry this row:
 *
 *   1. **It replaces the `follow` row rather than joining it.** One acceptance, one
 *      notification. Two rows naming the same person for the same act is the redundancy
 *      PRD §15 exists to prevent, and it is the property most easily lost by a later
 *      edit that adds an insert instead of moving one.
 *   2. **Exactly once per pair, by position.** The insert is reachable only when the
 *      `invite_attributions` row was genuinely new, and `invitee_id` is that table's
 *      primary key. `notifications_one_join_per_pair` is the backstop.
 *   3. **Acceptance and activation stay two events.** A later activation files
 *      `invite_activated` and does *not* file a second `invite_joined`. This is the
 *      distinction the old copy collapsed, and it is asserted directly.
 *   4. **A private inviter keeps `follow_request`.** Deliberate, and not an oversight:
 *      that row carries Approve and Decline and is the only place in the app they
 *      exist. Replacing it would strand the request; adding `invite_joined` beside it
 *      would be the redundant pair property 1 refuses.
 *   5. **It answers to the `invites` category and is push-eligible**, the latter because
 *      the `follow` row it replaced already was, and taking a push away silently would
 *      be a regression dressed as a copy change.
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

/** Every notification one account holds *about* another, in the order they were filed. */
const noticesTo = async (recipient, actor) => {
  const { rows } = await t.sql(
    `select type from notifications
      where recipient_id = $1 and actor_id = $2
      order by created_at, type`,
    [recipient, actor],
  );
  return rows.map((row) => row.type);
};

/**
 * Ranks `count` distinct titles for `user` through the real session, which is what
 * activation counts. Copied from `invite.test.mjs` deliberately: a fixture that wrote
 * `rankings` rows directly would skip `_rank_finalize`, and `_rank_finalize` is the one
 * caller of `_maybe_activate_invite` — so the activation half of this file would be
 * asserting against a transition nothing had actually run.
 */
const rankOne = async (user, film) => {
  await t.actAs(user);
  await t.sql(
    `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')
     on conflict (user_id, media_item_id) do nothing`,
    [user, film],
  );

  let step = await call(`rank_start($1, 'loved')`, [film]);
  for (let guard = 0; !step.done && guard < 20; guard += 1) {
    step = await call(`rank_answer($1, $2)`, [step.session_id, film]);
  }
  assert.equal(step.done, true, 'the ranking walk did not terminate');
  return step;
};

const rankTitles = async (user, count, from = 0) => {
  for (let i = 0; i < count; i += 1) {
    await rankOne(user, await t.createMovie(`Joined fixture ${from + i}`, 950000 + from + i));
  }
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

describe('the row an acceptance files for the inviter', () => {
  it('names the join, and is the only notice the acceptance files them', async () => {
    const inviter = await newUser('joined_inviter');
    const invitee = await newUser('joined_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);

    // One row, and it is the join. **Not `follow` and not both**: the generic follower
    // notice was replaced, so the inviter reads one sentence about one act.
    assert.deepEqual(await noticesTo(inviter, invitee), ['invite_joined']);
  });

  it('names the invitee as its actor, so the row draws their face and opens them', async () => {
    const inviter = await newUser('actor_inviter');
    const invitee = await newUser('actor_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);

    const { rows } = await t.sql(
      `select recipient_id, actor_id, subject_type, subject_id, read_at
         from notifications where recipient_id = $1 and type = 'invite_joined'`,
      [inviter],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, invitee);
    assert.equal(rows[0].subject_type, 'profile');
    assert.equal(rows[0].subject_id, invitee);
    // Unread, so it reaches the bell count like every other arriving row.
    assert.equal(rows[0].read_at, null);
  });

  it('still creates the follow it no longer announces', async () => {
    const inviter = await newUser('edge_inviter');
    const invitee = await newUser('edge_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);

    // The point of property 1: the *row* changed, the *relationship* did not.
    const { rows } = await t.sql(
      `select state from follows where follower_id = $1 and followee_id = $2`,
      [invitee, inviter],
    );
    assert.deepEqual(
      rows.map((row) => row.state),
      ['approved'],
    );
  });

  it('gives a private inviter the request, and not a join beside it', async () => {
    const inviter = await newUser('priv_join_inviter', 'private');
    const invitee = await newUser('priv_join_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);

    // `follow_request` alone. It carries Approve and Decline and is the only place in
    // the app they exist, so it is not replaceable — and a join row beside it would be
    // two notifications for one act.
    assert.deepEqual(await noticesTo(inviter, invitee), ['follow_request']);
  });

  it('files nothing more when the same operation is replayed', async () => {
    const inviter = await newUser('replay_join_inviter');
    const invitee = await newUser('replay_join_invitee');
    const token = await mintLink(inviter);
    const operation = await call(`gen_random_uuid()`);

    await t.actAs(invitee);
    await call(`redeem_invite($1, $2)`, [operation, token]);
    const again = await call(`redeem_invite($1, $2)`, [operation, token]);

    assert.equal(again.status, 'already_applied');
    assert.deepEqual(await noticesTo(inviter, invitee), ['invite_joined']);
  });

  it('files nothing more when the invitation is redeemed a second time', async () => {
    const inviter = await newUser('second_join_inviter');
    const invitee = await newUser('second_join_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);
    // A fresh operation id against the same live token: the attribution primary key is
    // what stops it, one layer below the operation ledger.
    const again = await redeem(token);

    assert.equal(again.reason, 'already_attributed');
    assert.deepEqual(await noticesTo(inviter, invitee), ['invite_joined']);
  });

  it('refuses a second join row for the same pair even if a future writer tries', async () => {
    const inviter = await newUser('backstop_inviter');
    const invitee = await newUser('backstop_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);

    // The backstop stated directly. The mechanism is the insert's position; this is the
    // index that would catch a writer added later without that reasoning.
    await assert.rejects(
      () =>
        t.sql(
          `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
           values ($1, 'invite_joined', $2, 'profile', $2)`,
          [inviter, invitee],
        ),
      /notifications_one_join_per_pair|duplicate key/i,
    );
  });

  it('is silenced by the invites category, the one that already covers invitations', async () => {
    const inviter = await newUser('pref_join_inviter');
    const invitee = await newUser('pref_join_invitee');
    const token = await mintLink(inviter);

    await t.actAs(inviter);
    await t.sql(
      `insert into notification_preferences (user_id, category, enabled)
       values ($1, 'invites', false)
       on conflict (user_id, category) do update set enabled = false`,
      [inviter],
    );

    await t.actAs(invitee);
    await redeem(token);

    // The switch that already says Invites governs both halves of the invite story.
    assert.deepEqual(await noticesTo(inviter, invitee), []);
    // And the attribution is unaffected: a preference silences a notification, never a
    // fact about the funnel.
    const { rows } = await t.sql(
      `select inviter_id from invite_attributions where invitee_id = $1`,
      [invitee],
    );
    assert.deepEqual(
      rows.map((row) => row.inviter_id),
      [inviter],
    );
  });

  it('may reach a phone, exactly as the follow row it replaced could', async () => {
    // Parity, stated as a test because the regression it guards against is invisible:
    // an inviter who simply stops being pushed when somebody joins.
    assert.equal(await call(`_push_eligible('invite_joined')`), true);
    assert.equal(await call(`_push_eligible('follow')`), true);
  });
});

describe('acceptance and activation stay two events', () => {
  it('files invite_activated later without a second join row', async () => {
    const inviter = await newUser('two_events_inviter');
    const invitee = await newUser('two_events_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);
    assert.deepEqual(await noticesTo(inviter, invitee), ['invite_joined']);

    // The tenth ranking, which is what `_maybe_activate_invite` counts (PRD §28) and
    // which `_rank_finalize` is the only caller of.
    await rankTitles(invitee, 10);
    const { rows: attributed } = await t.sql(
      `select activated_at from invite_attributions where invitee_id = $1`,
      [invitee],
    );
    assert.ok(attributed[0].activated_at, 'the tenth ranking activates');

    // Both rows, one of each. This is the property the old copy collapsed: the inviter
    // learns that somebody joined *when they joined*, and separately that they stuck
    // around. Neither row stands in for the other and neither is duplicated.
    //
    // Compared as a sorted multiset rather than in filing order, because the two rows
    // are written by different transactions and pinning their timestamps would make
    // this test about the clock.
    assert.deepEqual([...(await noticesTo(inviter, invitee))].sort(), [
      'invite_activated',
      'invite_joined',
    ]);
  });
});

describe('what the join row does and does not survive', () => {
  it('outlives the invitee unfollowing, because joining stayed true', async () => {
    const inviter = await newUser('unfollow_inviter');
    const invitee = await newUser('unfollow_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);
    await call(`unfollow(gen_random_uuid(), $1)`, [inviter]);

    // `unfollow` clears `follow` and `follow_request` because those rows announce an
    // edge that has stopped existing. This one announces that somebody joined, which is
    // a fact about the past — the same reading `invite_activated` has always had.
    assert.deepEqual(await noticesTo(inviter, invitee), ['invite_joined']);
  });

  it('is removed by a block, in both directions and whatever its type', async () => {
    const inviter = await newUser('block_join_inviter');
    const invitee = await newUser('block_join_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);
    assert.deepEqual(await noticesTo(inviter, invitee), ['invite_joined']);

    await t.actAs(inviter);
    await call(`block(gen_random_uuid(), $1)`, [invitee]);

    // `block` deletes generically rather than by an enumerated list of types, which is
    // why a new type is safe by default here. Asserted so it stays that way.
    assert.deepEqual(await noticesTo(inviter, invitee), []);
    assert.deepEqual(await noticesTo(invitee, inviter), []);
  });
});
