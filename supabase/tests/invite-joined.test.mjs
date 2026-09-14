import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The inviter's half of an acceptance, 20260831000100.
 *
 * When `redeem_invite` told the inviter something, until this migration it told them the
 * wrong thing: a plain `follow` row — "Ada Lovelace started following you" — with nothing
 * in it saying this person came through their invitation. The sentence that says so,
 * "joined bingd. from your invite", belonged to `invite_activated`, which fires once the
 * invitee has finished their *first five*. So the interesting fact arrived late or never,
 * moment it actually happened was reported as something duller.
 *
 * (Since `20260912000200` there is one acceptance that tells the inviter nothing at all —
 * a recipient who *already* followed them, where the news was delivered at the time and the
 * only edge that moves is the inviter's own outgoing one. `follow-activity.test.mjs` owns
 * that case; every acceptance this file is about files a row.)
 *
 * The properties that carry this row:
 *
 *   1. **It replaces the `follow` row rather than joining it.** One acceptance, at most one
 *      notification. Two rows naming the same person for the same act is the redundancy
 *      PRD §15 exists to prevent, and it is the property most easily lost by a later
 *      edit that adds an insert instead of moving one.
 *   2. **Exactly once per pair, by position.** The insert is reachable only when the
 *      `invite_attributions` row was genuinely new, and `invitee_id` is that table's
 *      primary key. `notifications_one_join_per_pair` is the backstop.
 *   3. **One arrival, one notice (20260920000100).** Activation is still recorded, but it
 *      files `invite_activated` only for an inviter the acceptance did not already tell.
 *      Since the bar became five (20260916000100) activation is the end of Your First
 *      Five, minutes after acceptance, and the two rows read as the same sentence twice
 *      (founder, physical QA, 2026-09-14: "Leslie joined bingd from your invite", twice).
 *   4. **A private inviter gets `invite_joined` too, since `20260912000200`.** This
 *      property read the other way until then — a private inviter kept `follow_request`,
 *      because that row carries Approve and Decline and is the only place in the app they
 *      exist. The founder's decision removes the decision the row was carrying: a personal
 *      invite now connects both parties whatever either visibility says, so an Approve
 *      would be a control that raises P0002 when pressed. The redundancy property 1
 *      refuses is unchanged; there is simply nothing left to be redundant *with*.
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

  it('gives a private inviter the join row too, because there is nothing left to approve', async () => {
    /**
     * Property 4 is superseded for a personal token (`20260912000200`). It read: a private
     * inviter keeps `follow_request`, because that row carries Approve and Decline and is
     * the only place in the app they exist.
     *
     * The founder's decision removes the decision the row was carrying. Minting a personal
     * link and handing it to somebody is the inviter acting; there is no Approve left to
     * offer, so `follow_request` would be a control that raises P0002 when pressed. The
     * inviter gets what a public inviter gets, and for the same reason: news, once.
     */
    const inviter = await newUser('priv_join_inviter', 'private');
    const invitee = await newUser('priv_join_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);

    assert.deepEqual(await noticesTo(inviter, invitee), ['invite_joined']);
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

/**
 * **One arrival, one notice** (20260920000100).
 *
 * The founder's inbox held "Leslie joined bingd from your invite" twice: `invite_joined` at
 * 17:06:21 when Leslie redeemed, and `invite_activated` at 17:10:52, which was Leslie's
 * fifth ranking. These pin the contract at the writer: whatever the invitee does next, the
 * inviter holds exactly one row saying they joined.
 */
describe('one arrival, one notice', () => {
  /** Every row that tells an inviter this person joined from their invite. */
  const joinNotices = async (inviter, invitee) =>
    (await noticesTo(inviter, invitee)).filter(
      (type) => type === 'invite_joined' || type === 'invite_activated',
    );

  const activatedAt = async (invitee) =>
    (
      await t.sql(`select activated_at from invite_attributions where invitee_id = $1`, [
        invitee,
      ])
    ).rows[0]?.activated_at ?? null;

  it('keeps the acceptance as the only notice when the invitee finishes their first five', async () => {
    const inviter = await newUser('one_notice_inviter');
    const invitee = await newUser('one_notice_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);
    assert.deepEqual(await noticesTo(inviter, invitee), ['invite_joined']);

    // The **fifth** ranking, the bar since 20260916000100: exactly the moment the second
    // row used to arrive.
    await rankTitles(invitee, 5);
    assert.ok(await activatedAt(invitee), 'the fifth ranking still activates');

    // No `invite_activated`, no `follow`: the auto-follow is still silent, and the
    // activation says nothing the acceptance did not.
    assert.deepEqual(await noticesTo(inviter, invitee), ['invite_joined']);
  });

  it('stays at one through retried redemptions and every ranking after the bar', async () => {
    const inviter = await newUser('retry_notice_inviter');
    const invitee = await newUser('retry_notice_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    const op = (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
    await call(`redeem_invite($1, $2)`, [op, token]);
    // A lost reply retried with the same operation, and a fresh second attempt.
    await call(`redeem_invite($1, $2)`, [op, token]);
    await redeem(token);

    await rankTitles(invitee, 8, 100);

    assert.deepEqual(await joinNotices(inviter, invitee), ['invite_joined']);
  });

  it('still tells an inviter the acceptance did not, exactly once, at activation', async () => {
    // An invitee who already followed the inviter: the acceptance moves no edge of theirs
    // and files nothing (20260912000300). Activation is then the first and only notice.
    const inviter = await newUser('late_notice_inviter');
    const invitee = await newUser('late_notice_invitee');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await call(`follow(gen_random_uuid(), $1)`, [inviter]);
    await redeem(token);
    assert.deepEqual(await joinNotices(inviter, invitee), []);

    await rankTitles(invitee, 6, 200);
    assert.ok(await activatedAt(invitee));
    assert.deepEqual(await joinNotices(inviter, invitee), ['invite_activated']);
  });

  it('leaves a later, genuine follow its own ordinary notice', async () => {
    const inviter = await newUser('genuine_follow_inviter');
    const invitee = await newUser('genuine_follow_invitee');
    const stranger = await newUser('genuine_follow_stranger');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);
    await rankTitles(invitee, 5, 300);

    // Somebody who was never invited follows the inviter: the ordinary row, untouched.
    await t.actAs(stranger);
    await call(`follow(gen_random_uuid(), $1)`, [inviter]);
    assert.deepEqual(await noticesTo(inviter, stranger), ['follow']);

    // The invitee ends the auto-follow and later follows again by hand. That is a new act,
    // and it is announced as one; the join row beside it is still the only join notice.
    await t.actAs(invitee);
    await call(`unfollow(gen_random_uuid(), $1)`, [inviter]);
    await call(`follow(gen_random_uuid(), $1)`, [inviter]);
    assert.deepEqual([...(await noticesTo(inviter, invitee))].sort(), [
      'follow',
      'invite_joined',
    ]);
    assert.deepEqual(await joinNotices(inviter, invitee), ['invite_joined']);
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
