import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Recommendation requests (20260826000400).
 *
 * The tranche's promise is one sentence: **a recommendation is never silently lost**.
 * Everything here is a way of trying to lose one — send it across a one-way follow,
 * dismiss it, follow afterwards, unfollow afterwards, block, replay the call, fill the
 * queue — and asserting where it ended up.
 *
 * WHY ALMOST EVERY READ GOES THROUGH `viewAs`
 *
 * The delivered list is filtered by an RLS policy rather than by a `where` clause
 * (`recommendations_to_me` is `security invoker` and contains no state logic of its
 * own — see §6 of the migration). An owner-run query bypasses policies, so a test that
 * did not assume a role would pass against a policy that admitted every pending row.
 * That is the single most important thing this file has to get right.
 */

let t;
let seq = 96000;
let sender;
let recipient;

const movie = (title) => t.createMovie(title, seq++);

const followRow = (a, b, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, $3::follow_state, case when $3 = 'approved' then now() end)
     on conflict (follower_id, followee_id) do update set state = excluded.state`,
    [a, b, state],
  );

const unfollowRow = (a, b) =>
  t.sql(`delete from follows where follower_id = $1 and followee_id = $2`, [a, b]);

/** Acts as somebody for one call, and puts the acting identity back. */
const as = async (who, fn) => {
  await t.actAs(who);
  try {
    return await fn();
  } finally {
    await t.actAs(sender);
  }
};

/** The same, but as a real `authenticated` role, so RLS actually applies. */
const viewAs = async (who, fn) => {
  try {
    return await t.asUser(who, fn);
  } finally {
    await t.actAs(sender);
  }
};

const send = async (from, to, mediaItemId) =>
  as(from, async () => {
    const { rows } = await t.sql(`select recommend_title(gen_random_uuid(), $1, $2) as r`, [
      to,
      mediaItemId,
    ]);
    return rows[0].r;
  });

/** What the recipient's ordinary Recommendations list holds, through the real path. */
const delivered = (who) =>
  viewAs(who, async () => {
    const { rows } = await t.sql(`select * from recommendations_to_me(200)`);
    return rows;
  });

/** What the Requests sheet holds, through the real path. */
const requests = (who) =>
  viewAs(who, async () => {
    const { rows } = await t.sql(`select * from recommendation_requests(200)`);
    return rows;
  });

/** The stored state, read as the owner. Only ever used to prove a tombstone survives. */
const stateOf = async (id) => {
  const { rows } = await t.sql(`select state from title_recommendations where id = $1`, [id]);
  return rows[0]?.state ?? null;
};

const rpc = (who, sql, params = []) =>
  as(who, async () => {
    const { rows } = await t.sql(`select ${sql} as r`, params);
    return rows[0].r;
  });

const add = (who, id) => rpc(who, 'add_recommendation($1)', [id]);
const dismiss = (who, id) => rpc(who, 'dismiss_recommendation($1)', [id]);
const dismissAll = (who, op) =>
  rpc(who, 'dismiss_all_recommendation_requests($1)', [op ?? null]).catch((e) => {
    throw e;
  });

const notificationsOf = async (who, type = 'recommendation') => {
  const { rows } = await t.sql(
    `select id from notifications where recipient_id = $1 and type = $2`,
    [who, type],
  );
  return rows;
};

before(async () => {
  t = await createTestDb();
  // Every send in this file is a real `recommend_title` call, and the hourly ceiling
  // would otherwise stop the file a third of the way through — with each later failure
  // reading as a defect in whatever it was testing.
  await t.sql(
    `update app_config set value = '10000'::jsonb where key like 'recommendations.max_per_%'`,
  );
});

after(async () => {
  await t?.close();
});

/**
 * A fresh, unrelated pair per test.
 *
 * These tests mutate the follow graph in both directions and delete rows through
 * `block`, so sharing two accounts across the file would make every test depend on the
 * order the ones before it ran in. Accounts are cheap; a false pass is not.
 */
beforeEach(async () => {
  sender = await t.createUser({ username: `s${seq++}` });
  recipient = await t.createUser({ username: `r${seq++}` });
  await followRow(sender, recipient); // the send rule, and nothing more
  await t.actAs(sender);
});

describe('where a recommendation lands', () => {
  it('delivers straight to a mutual follow, with the notification it always filed', async () => {
    await followRow(recipient, sender);
    const id = await movie('req_mutual');

    const result = await send(sender, recipient, id);
    assert.equal(result.status, 'ok');
    assert.equal(result.delivered, true);

    assert.equal((await delivered(recipient)).length, 1);
    assert.equal((await requests(recipient)).length, 0);
    assert.equal((await notificationsOf(recipient)).length, 1);
  });

  it('holds it as a request across a one-way follow, and loses nothing', async () => {
    const id = await movie('req_oneway');

    const result = await send(sender, recipient, id);
    assert.equal(result.status, 'ok', 'the old rule refused this outright');
    assert.equal(result.delivered, false);

    const held = await requests(recipient);
    assert.equal(held.length, 1);
    assert.equal(held[0].media_item_id, id);
    assert.equal(held[0].sender_id, sender);
    assert.equal(Number(held[0].total_pending), 1);

    assert.equal((await delivered(recipient)).length, 0, 'and not in the ordinary list');
  });

  it('files no notification at all for a pending request', async () => {
    await send(sender, recipient, await movie('req_silent'));

    assert.equal(
      (await notificationsOf(recipient)).length,
      0,
      'a request must not reach the Notifications timeline or the Bell badge',
    );

    // The one read path the inbox screen has, asserted rather than inferred from the
    // table: `my_notifications` is definer, so a row would appear here even if a policy
    // hid it.
    const inbox = await viewAs(recipient, async () => {
      const { rows } = await t.sql(`select * from my_notifications(100)`);
      return rows;
    });
    assert.equal(inbox.length, 0);
  });

  it('refuses across a block and stores nothing at all', async () => {
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [recipient, sender]);
    const result = await send(sender, recipient, await movie('req_blocked'));

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'not_following');

    const { rows } = await t.sql(
      `select 1 from title_recommendations where sender_id = $1 and recipient_id = $2`,
      [sender, recipient],
    );
    assert.equal(rows.length, 0, 'a blocked send leaves no pending item to be released later');
  });
});

describe('the requests read model', () => {
  it('is invisible to anybody but the recipient', async () => {
    const id = await movie('req_privacy');
    await send(sender, recipient, id);

    assert.equal(
      (await requests(sender)).length,
      0,
      'the sender must not be able to read their own request back as a request',
    );

    const stranger = await t.createUser({ username: `x${seq++}` });
    assert.equal((await requests(stranger)).length, 0);
  });

  /**
   * The oracle §2 of the migration exists to close.
   *
   * `state` is granted to no client role, so neither party can select it. Asserted
   * through a real `authenticated` role, because column privileges — like policies —
   * do not apply to the owner.
   */
  it('does not let the sender read the state column at all', async () => {
    await send(sender, recipient, await movie('req_oracle'));

    const error = await viewAs(sender, () =>
      t.errorFrom(`select state from title_recommendations where sender_id = $1`, [sender]),
    );
    assert.equal(error?.code, '42501', 'or the sender learns whether it was added or thrown away');

    const asRecipient = await viewAs(recipient, () =>
      t.errorFrom(`select state from title_recommendations where recipient_id = $1`, [recipient]),
    );
    assert.equal(asRecipient?.code, '42501');
  });

  it('still lets the sender count what they sent, which Hype Courier reads', async () => {
    await send(sender, recipient, await movie('req_award'));

    const rows = await viewAs(sender, async () => {
      const { rows } = await t.sql(
        `select id, recommended_at from title_recommendations where sender_id = $1`,
        [sender],
      );
      return rows;
    });
    assert.equal(rows.length, 1);
  });

  it('groups by sender, newest sender first and newest request within', async () => {
    const other = await t.createUser({ username: `o${seq++}` });
    await followRow(other, recipient);

    const first = await movie('req_sort_a');
    const second = await movie('req_sort_b');
    await send(sender, recipient, first);
    await send(sender, recipient, second);
    // Backdate the first sender's whole group, so the other one is the newer activity.
    await t.sql(
      `update title_recommendations set recommended_at = now() - interval '2 days'
        where sender_id = $1`,
      [sender],
    );
    await t.sql(
      `update title_recommendations set recommended_at = now() - interval '3 days'
        where sender_id = $1 and media_item_id = $2`,
      [sender, first],
    );
    await send(other, recipient, await movie('req_sort_c'));

    const rows = await requests(recipient);
    assert.deepEqual(
      rows.map((r) => r.sender_id),
      [other, sender, sender],
      'sender groups stay contiguous, newest activity first',
    );
    assert.deepEqual(
      rows.slice(1).map((r) => r.media_item_id),
      [second, first],
      'and newest first inside a group',
    );
    assert.equal(Number(rows[0].total_pending), 3, 'the count is items, not senders');
  });

  it('drops a suspended sender rather than drawing their request anonymously', async () => {
    await send(sender, recipient, await movie('req_suspended'));
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [sender]);

    assert.equal((await requests(recipient)).length, 0);
  });

  it('names a private sender the recipient could not otherwise see', async () => {
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [sender]);
    await send(sender, recipient, await movie('req_private_sender'));

    const rows = await requests(recipient);
    assert.equal(rows.length, 1, 'or the one screen that decides about them cannot draw them');
    assert.ok(rows[0].sender_username, 'and the name is there to draw');
  });
});

describe('adding one', () => {
  it('moves exactly that one into the ordinary list and leaves the rest held', async () => {
    const kept = await movie('req_add_a');
    const other = await movie('req_add_b');
    await send(sender, recipient, kept);
    await send(sender, recipient, other);

    const held = await requests(recipient);
    const target = held.find((r) => r.media_item_id === kept);
    assert.equal((await add(recipient, target.id)).added, true);

    const list = await delivered(recipient);
    assert.deepEqual(list.map((r) => r.media_item_id), [kept]);

    const left = await requests(recipient);
    assert.deepEqual(left.map((r) => r.media_item_id), [other]);
    assert.equal(Number(left[0].total_pending), 1, 'and the count comes down');
  });

  it('does not follow the sender and does not notify anybody', async () => {
    const id = await movie('req_add_quiet');
    await send(sender, recipient, id);
    const [row] = await requests(recipient);
    await add(recipient, row.id);

    const { rows: edges } = await t.sql(
      `select 1 from follows where follower_id = $1 and followee_id = $2`,
      [recipient, sender],
    );
    assert.equal(edges.length, 0, 'Add is not Accept');
    assert.equal((await notificationsOf(recipient)).length, 0);
    assert.equal((await notificationsOf(sender)).length, 0, 'the sender learns nothing');
  });

  it('is a no-op on replay, and on somebody else’s request', async () => {
    const id = await movie('req_add_replay');
    await send(sender, recipient, id);
    const [row] = await requests(recipient);

    assert.equal((await add(recipient, row.id)).added, true);
    assert.equal((await add(recipient, row.id)).added, false, 'a lost reply retried');
    assert.equal((await delivered(recipient)).length, 1, 'and exactly one copy exists');

    const stranger = await t.createUser({ username: `y${seq++}` });
    assert.equal((await add(stranger, row.id)).added, false);
  });
});

describe('dismissing', () => {
  it('removes it from both lists and never lets a later follow bring it back', async () => {
    const id = await movie('req_dismiss');
    await send(sender, recipient, id);
    const [row] = await requests(recipient);

    assert.equal((await dismiss(recipient, row.id)).dismissed, true);
    assert.equal((await requests(recipient)).length, 0);
    assert.equal((await delivered(recipient)).length, 0);

    // The whole reason dismissal is a tombstone rather than a deletion.
    await as(recipient, () =>
      t.sql(`select follow(gen_random_uuid(), $1)`, [sender]),
    );
    assert.equal((await delivered(recipient)).length, 0, 'a dismissal is final');
    assert.equal(await stateOf(row.id), 'dismissed');
  });

  it('tells the sender nothing and does not stop them sending again', async () => {
    const id = await movie('req_dismiss_resend');
    await send(sender, recipient, id);
    const [row] = await requests(recipient);
    await dismiss(recipient, row.id);

    assert.equal((await notificationsOf(sender)).length, 0);

    // Dismissal is not a block. The same title may arrive again, as a new request.
    const again = await send(sender, recipient, id);
    assert.equal(again.status, 'ok');
    assert.equal(again.delivered, false);
    assert.equal((await requests(recipient)).length, 1);
  });

  it('dismisses everything held, from everybody, and is claimed once', async () => {
    const other = await t.createUser({ username: `z${seq++}` });
    await followRow(other, recipient);
    await send(sender, recipient, await movie('req_all_a'));
    await send(sender, recipient, await movie('req_all_b'));
    await send(other, recipient, await movie('req_all_c'));

    const op = (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
    const result = await dismissAll(recipient, op);
    assert.equal(result.dismissed, 3);
    assert.equal((await requests(recipient)).length, 0);
    assert.equal((await delivered(recipient)).length, 0, 'dismiss all is not add all');

    // A replay under the same id must not sweep anything that arrived since.
    await send(sender, recipient, await movie('req_all_d'));
    assert.equal((await dismissAll(recipient, op)).status, 'already_applied');
    assert.equal((await requests(recipient)).length, 1, 'the new one survives the replay');
  });

  it('follows, unfollows and blocks nobody', async () => {
    await send(sender, recipient, await movie('req_all_quiet'));
    await dismissAll(recipient, (await t.sql(`select gen_random_uuid() as id`)).rows[0].id);

    const { rows: edges } = await t.sql(
      `select 1 from follows where follower_id = $1 or followee_id = $1`,
      [recipient],
    );
    assert.equal(edges.length, 1, 'only the sender’s own inbound follow, untouched');
    const { rows: blocks } = await t.sql(`select 1 from blocks where blocker_id = $1`, [recipient]);
    assert.equal(blocks.length, 0);
  });
});

describe('following releases what was held', () => {
  it('releases every remaining request from a public sender, silently', async () => {
    await send(sender, recipient, await movie('req_rel_a'));
    await send(sender, recipient, await movie('req_rel_b'));

    await as(recipient, () => t.sql(`select follow(gen_random_uuid(), $1)`, [sender]));

    assert.equal((await requests(recipient)).length, 0);
    assert.equal((await delivered(recipient)).length, 2);
    assert.equal(
      (await notificationsOf(recipient)).length,
      0,
      'no burst describing the consequence of the reader’s own tap',
    );
  });

  it('leaves another sender’s requests alone', async () => {
    const other = await t.createUser({ username: `q${seq++}` });
    await followRow(other, recipient);
    await send(sender, recipient, await movie('req_rel_mine'));
    await send(other, recipient, await movie('req_rel_theirs'));

    await as(recipient, () => t.sql(`select follow(gen_random_uuid(), $1)`, [sender]));

    const left = await requests(recipient);
    assert.equal(left.length, 1);
    assert.equal(left[0].sender_id, other);
  });

  it('holds them through a request to a private sender, and releases on approval', async () => {
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [sender]);
    await send(sender, recipient, await movie('req_private_a'));
    await send(sender, recipient, await movie('req_private_b'));

    const asked = await as(recipient, async () => {
      const { rows } = await t.sql(`select follow(gen_random_uuid(), $1) as r`, [sender]);
      return rows[0].r;
    });
    assert.equal(asked.state, 'pending');
    assert.equal((await requests(recipient)).length, 2, 'a request is not a follow');
    assert.equal((await delivered(recipient)).length, 0);

    await as(sender, () =>
      t.sql(`select respond_follow_request(gen_random_uuid(), $1, true)`, [recipient]),
    );

    assert.equal((await requests(recipient)).length, 0);
    assert.equal((await delivered(recipient)).length, 2);
  });

  it('releases nothing when a private sender declines', async () => {
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [sender]);
    await send(sender, recipient, await movie('req_declined'));
    await as(recipient, () => t.sql(`select follow(gen_random_uuid(), $1)`, [sender]));

    await as(sender, () =>
      t.sql(`select respond_follow_request(gen_random_uuid(), $1, false)`, [recipient]),
    );

    assert.equal((await requests(recipient)).length, 1);
    assert.equal((await delivered(recipient)).length, 0);
  });

  /**
   * The third path, and the one that would have been missed.
   *
   * A private account going public approves every pending request at once, without
   * either party pressing Follow again — so the release cannot live only on `follow`
   * and `respond_follow_request`.
   */
  it('releases when a private sender goes public and sweeps its pending requests', async () => {
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [sender]);
    await send(sender, recipient, await movie('req_public_sweep'));
    await as(recipient, () => t.sql(`select follow(gen_random_uuid(), $1)`, [sender]));
    assert.equal((await requests(recipient)).length, 1);

    await as(sender, () =>
      t.sql(`select set_profile_visibility(gen_random_uuid(), 'public'::profile_visibility)`),
    );

    assert.equal((await requests(recipient)).length, 0);
    assert.equal((await delivered(recipient)).length, 1);
  });

  it('is a no-op when the follow already existed', async () => {
    await followRow(recipient, sender);
    await send(sender, recipient, await movie('req_already'));
    assert.equal((await delivered(recipient)).length, 1);

    // Re-following changes nothing, and must not double anything either.
    await as(recipient, () => t.sql(`select follow(gen_random_uuid(), $1)`, [sender]));
    assert.equal((await delivered(recipient)).length, 1);
  });
});

describe('unfollowing', () => {
  it('leaves delivered recommendations exactly where they are', async () => {
    await followRow(recipient, sender);
    await send(sender, recipient, await movie('req_unfollow_kept'));
    assert.equal((await delivered(recipient)).length, 1);

    await as(recipient, () => t.sql(`select unfollow(gen_random_uuid(), $1)`, [sender]));

    assert.equal(
      (await delivered(recipient)).length,
      1,
      'unfollow means "stop trusting new ones", not "erase what they sent"',
    );
    assert.equal((await requests(recipient)).length, 0);
  });

  it('sends the next one to Requests instead', async () => {
    await followRow(recipient, sender);
    await send(sender, recipient, await movie('req_unfollow_old'));
    await unfollowRow(recipient, sender);

    const result = await send(sender, recipient, await movie('req_unfollow_new'));
    assert.equal(result.delivered, false);
    assert.equal((await requests(recipient)).length, 1);
    assert.equal((await delivered(recipient)).length, 1, 'and the old one is untouched');
  });

  it('never demotes a delivered recommendation, even when the same title is resent', async () => {
    const id = await movie('req_no_demote');
    await followRow(recipient, sender);
    await send(sender, recipient, id);
    await unfollowRow(recipient, sender);

    await send(sender, recipient, id);

    assert.equal((await delivered(recipient)).length, 1);
    assert.equal((await requests(recipient)).length, 0, 'or a resend would take it off their list');
  });
});

describe('blocking', () => {
  it('deletes pending requests in both directions and prevents new ones', async () => {
    await send(sender, recipient, await movie('req_block_a'));
    await send(sender, recipient, await movie('req_block_b'));

    await as(recipient, () => t.sql(`select block(gen_random_uuid(), $1)`, [sender]));

    assert.equal((await requests(recipient)).length, 0);
    const { rows } = await t.sql(
      `select 1 from title_recommendations where sender_id = $1 and recipient_id = $2`,
      [sender, recipient],
    );
    assert.equal(rows.length, 0, 'and nothing survives to be released by a later unblock');

    // The follow is gone with the block, so a further send is refused outright.
    assert.equal(
      (await send(sender, recipient, await movie('req_block_c'))).reason,
      'not_following',
    );
  });

  it('keeps a delivered recommendation as history, and hides it while the block stands', async () => {
    await followRow(recipient, sender);
    await send(sender, recipient, await movie('req_block_history'));

    await as(recipient, () => t.sql(`select block(gen_random_uuid(), $1)`, [sender]));

    assert.equal(
      (await delivered(recipient)).length,
      0,
      'profiles_read drops the sender, so nothing leaks',
    );
    const { rows } = await t.sql(
      `select 1 from title_recommendations where sender_id = $1 and recipient_id = $2`,
      [sender, recipient],
    );
    assert.equal(rows.length, 1, 'but the row is the reader’s own history and stays');
  });
});

describe('the pending ceiling', () => {
  it('stops at five per pair and says nothing about what the recipient did', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await send(sender, recipient, await movie(`req_cap_${i}`))).status, 'ok');
    }

    const sixth = await send(sender, recipient, await movie('req_cap_over'));
    assert.equal(sixth.status, 'refused');
    assert.equal(sixth.reason, 'too_many_pending');
    assert.equal((await requests(recipient)).length, 5);
  });

  /**
   * The oracle Codex found in the first version of the cap, and the reason it is now
   * asked of the pair rather than of the row.
   *
   * With the queue full, a resend used to answer differently depending on what the
   * recipient had done with that exact title: `ok` for one still waiting, refused for
   * one they had dismissed. Two answers separated by a decision made in private — the
   * same disclosure §2 revokes a column privilege to prevent, rebuilt out of a refusal
   * code. At the ceiling every resend must now answer identically.
   */
  it('answers identically at the ceiling whatever the recipient did with that title', async () => {
    const waiting = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await movie(`req_cap_probe_${i}`);
      waiting.push(id);
      await send(sender, recipient, id);
    }

    // One of them is dismissed and immediately replaced, so the queue is full again and
    // the pair now holds both a pending row and a dismissed one.
    const [row] = await requests(recipient);
    const dismissedMedia = row.media_item_id;
    await dismiss(recipient, row.id);
    await send(sender, recipient, await movie('req_cap_probe_refill'));
    assert.equal((await requests(recipient)).length, 5);

    const stillWaiting = waiting.find((id) => id !== dismissedMedia);
    const resendPending = await send(sender, recipient, stillWaiting);
    const resendDismissed = await send(sender, recipient, dismissedMedia);

    assert.equal(resendDismissed.status, 'refused');
    assert.equal(resendDismissed.reason, 'too_many_pending');
    assert.deepEqual(
      { status: resendPending.status, reason: resendPending.reason },
      { status: resendDismissed.status, reason: resendDismissed.reason },
      'or the sender learns which of their recommendations was thrown away',
    );
    assert.equal((await requests(recipient)).length, 5, 'and nothing was revived');
  });

  it('does not apply to somebody who follows the sender back', async () => {
    for (let i = 0; i < 5; i += 1) await send(sender, recipient, await movie(`req_cap_then_${i}`));

    // The real writer, not a direct insert: the release lives inside `follow`, and a
    // row put straight into `follows` would leave the queue full and prove nothing.
    await as(recipient, () => t.sql(`select follow(gen_random_uuid(), $1)`, [sender]));

    assert.equal((await send(sender, recipient, await movie('req_cap_after_follow'))).status, 'ok');
    assert.equal((await delivered(recipient)).length, 6);
    assert.equal((await requests(recipient)).length, 0);
  });

  it('frees a slot as soon as the recipient decides about one', async () => {
    for (let i = 0; i < 5; i += 1) await send(sender, recipient, await movie(`req_cap_free_${i}`));
    const [row] = await requests(recipient);
    await dismiss(recipient, row.id);

    assert.equal((await send(sender, recipient, await movie('req_cap_after'))).status, 'ok');
  });

  it('does not apply to a mutual follow, whose sends are delivered rather than queued', async () => {
    await followRow(recipient, sender);
    for (let i = 0; i < 7; i += 1) {
      assert.equal((await send(sender, recipient, await movie(`req_cap_mutual_${i}`))).status, 'ok');
    }
    assert.equal((await delivered(recipient)).length, 7);
  });
});

describe('a dismissed row that is sent again', () => {
  it('arrives delivered, with the notification it never got, when they now follow back', async () => {
    const id = await movie('req_tombstone_deliver');
    await send(sender, recipient, id);
    const [row] = await requests(recipient);
    await dismiss(recipient, row.id);

    await followRow(recipient, sender);
    const again = await send(sender, recipient, id);

    assert.equal(again.delivered, true);
    assert.equal((await delivered(recipient)).length, 1);
    assert.equal(
      (await notificationsOf(recipient)).length,
      1,
      'the recipient was never told about this one, so this is its first notice',
    );
  });

  it('files no second notification when a delivered one is resent', async () => {
    const id = await movie('req_no_second_notice');
    await followRow(recipient, sender);
    await send(sender, recipient, id);
    await send(sender, recipient, id);

    assert.equal((await notificationsOf(recipient)).length, 1);
  });
});

describe('grants', () => {
  it('does not let a client call the internal predicates or the release helper', async () => {
    for (const call of [
      `_may_recommend_to($1)`,
      `_delivers_directly_to($1)`,
      `_release_recommendations($1, $1)`,
    ]) {
      const error = await viewAs(recipient, () =>
        t.errorFrom(`select ${call}`, [sender]),
      );
      assert.equal(error?.code, '42501', `${call} must be server-side only`);
    }
  });

  it('does not let a signed-out client read requests', async () => {
    await send(sender, recipient, await movie('req_anon'));
    const error = await t.asAnon(() => t.errorFrom(`select * from recommendation_requests(10)`));
    await t.actAs(sender);
    assert.equal(error?.code, '42501');
  });
});
