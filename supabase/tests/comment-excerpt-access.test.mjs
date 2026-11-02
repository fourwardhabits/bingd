import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * A comment's text reaches only somebody who could open that comment right now.
 * Security audit 2026-11-01, M-2 and m-5.
 *
 * Every case runs against **both** surfaces: `claim_push_batch`, which had no access check
 * at all, and `my_notifications`, which checked the author and not the activity. The table
 * below is the point of this file. A rule stated per surface is how the two came to differ.
 *
 * The proactive-notifications branch redefines both functions, so this file has to keep
 * passing there.
 */

let t;
let seq = 0;

const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const user = (prefix, visibility = 'public') =>
  t.createUser({ username: `${prefix}_${(seq += 1)}`, visibility });

const act = (who, sql, ...args) =>
  t.asUser(who, async () => {
    await t.sql(sql, [await op(), ...args]);
  });

const follow = (who, target) => act(who, `select follow($1, $2)`, target);
const approve = (owner, follower) => act(owner, `select respond_follow_request($1, $2, true)`, follower);
const comment = (who, event, body, spoiler = false) =>
  act(who, `select add_comment($1, $2, $3, $4, null, '{}'::uuid[])`, event, body, spoiler);

const eventOf = async (owner) => {
  const film = await t.createMovie(`Excerpt Film ${seq}`, 7_100_000 + (seq += 1));
  const { rows } = await t.sql(
    `insert into feed_events (actor_id, type, media_item_id) values ($1, 'watchlist_added', $2)
     returning id`,
    [owner, film],
  );
  return rows[0].id;
};

const giveDevice = (who) =>
  t.sql(`insert into device_tokens (user_id, token, platform) values ($1, $2, 'ios')`, [
    who,
    `ExponentPushToken[${String(who).replaceAll('-', '').slice(0, 20)}]`,
  ]);

/** Drains whatever is queued, as the sender would. */
const claim = () =>
  t.asRole('service_role', null, async () => (await t.sql(`select claim_push_batch(50) as j`)).rows[0].j);

const pushedTo = async (recipient) => {
  const { rows } = await t.sql(
    `select id from notifications where recipient_id = $1`, [recipient]);
  const mine = new Set(rows.map((r) => r.id));
  return (await claim()).filter((job) => mine.has(job.notification_id));
};

const inboxOf = (reader) =>
  t.asUser(reader, async () =>
    (await t.sql(`select kind, comment_excerpt, comment_spoilers from my_notifications(50)`)).rows,
  );

const SAID = 'something meant for people who can still see this';

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.sql(`delete from push_outbox`);
});

describe('a reader with current access', () => {
  it('keeps the excerpt on both surfaces', async () => {
    const owner = await user('owner');
    const friend = await user('friend');
    await giveDevice(owner);
    const event = await eventOf(owner);

    await comment(friend, event, SAID);

    const [job] = await pushedTo(owner);
    assert.equal(job.type, 'comment');
    assert.equal(job.comment_excerpt, SAID);

    const [row] = await inboxOf(owner);
    assert.equal(row.comment_excerpt, SAID);
  });

  it('keeps it for an approved follower of a private owner', async () => {
    const owner = await user('owner', 'private');
    const follower = await user('follower');
    await follow(follower, owner);
    await approve(owner, follower);
    await giveDevice(follower);
    const event = await eventOf(owner);
    await comment(follower, event, 'first');
    await t.sql(`delete from push_outbox`);

    await comment(owner, event, SAID);

    const [job] = await pushedTo(follower);
    assert.equal(job.comment_excerpt, SAID);
  });
});

describe('a reader who lost access', () => {
  it('a removed follower gets no text, which is the audit case', async () => {
    const owner = await user('owner', 'private');
    const follower = await user('follower');
    await follow(follower, owner);
    await approve(owner, follower);
    await giveDevice(follower);
    const event = await eventOf(owner);
    await comment(follower, event, 'nice');
    await t.sql(`delete from push_outbox`);

    await act(owner, `select remove_follower($1, $2)`, follower);
    await comment(owner, event, SAID);

    const jobs = await pushedTo(follower);
    assert.equal(jobs.length, 1, 'the fixture must actually have queued something');
    assert.equal(jobs[0].comment_excerpt, null);
    for (const row of await inboxOf(follower)) assert.equal(row.comment_excerpt, null);
  });

  it('a reader who unfollowed a private owner gets no text', async () => {
    const owner = await user('owner', 'private');
    const follower = await user('follower');
    await follow(follower, owner);
    await approve(owner, follower);
    await giveDevice(follower);
    const event = await eventOf(owner);
    await comment(follower, event, 'nice');
    await t.sql(`delete from push_outbox`);

    await act(follower, `select unfollow($1, $2)`, owner);
    await comment(owner, event, SAID);

    const jobs = await pushedTo(follower);
    assert.equal(jobs.length, 1, 'the fixture must actually have queued something');
    assert.equal(jobs[0].comment_excerpt, null);
  });

  it('a private stranger’s comment on a public activity shows no text', async () => {
    const owner = await user('owner');
    const stranger = await user('stranger', 'private');
    await giveDevice(owner);
    const event = await eventOf(owner);

    await comment(stranger, event, SAID);

    const [job] = await pushedTo(owner);
    assert.equal(job.type, 'comment');
    assert.equal(job.comment_excerpt, null);

    const [row] = await inboxOf(owner);
    assert.equal(row.comment_excerpt, null);
  });

  it('a block by the activity owner stops the text, though the block names neither actor', async () => {
    // `block()` deletes rows between the two people it names, and the actor here is a third
    // party, so the row survives and only the excerpt rule can answer.
    const owner = await user('owner');
    const author = await user('author');
    const reader = await user('reader');
    await giveDevice(reader);
    const event = await eventOf(owner);

    await comment(author, event, `hello @${(await t.sql(
      `select username::text as u from profiles where id = $1`, [reader])).rows[0].u} ${SAID}`);
    await t.sql(`update push_outbox set state = 'pending'`);

    const before = (await inboxOf(reader)).find((r) => r.kind === 'mention');
    assert.match(before.comment_excerpt, /still see this/);

    await act(owner, `select block($1, $2)`, reader);

    const after = (await inboxOf(reader)).find((r) => r.kind === 'mention');
    assert.equal(after.comment_excerpt, null);
  });

  it('an owner going private stops the text for somebody who was only ever mentioned', async () => {
    const owner = await user('owner');
    const author = await user('author');
    const reader = await user('reader');
    const event = await eventOf(owner);

    await comment(author, event, `hello @${(await t.sql(
      `select username::text as u from profiles where id = $1`, [reader])).rows[0].u} ${SAID}`);
    assert.ok((await inboxOf(reader)).find((r) => r.kind === 'mention').comment_excerpt);

    await act(owner, `select set_profile_visibility($1, 'private')`);

    const after = (await inboxOf(reader)).find((r) => r.kind === 'mention');
    assert.equal(after.comment_excerpt, null);
    assert.equal(after.comment_spoilers, false, 'nor does it say what kind of comment it was');
  });

  it('a push claimed after access went stops the text, even with the row already queued', async () => {
    // The check is at claim, not at write: what matters is the moment the phone would light.
    const owner = await user('owner');
    const friend = await user('friend');
    await giveDevice(owner);
    const event = await eventOf(owner);

    await comment(friend, event, SAID);
    await act(owner, `select block($1, $2)`, friend);

    assert.deepEqual(await pushedTo(owner), [], 'a block removes the notification itself');
  });
});

describe('what the rule leaves alone', () => {
  it('still withholds a spoiler-marked comment, and says so to a reader who may know', async () => {
    const owner = await user('owner');
    const friend = await user('friend');
    await giveDevice(owner);
    const event = await eventOf(owner);

    await comment(friend, event, SAID, true);

    const [job] = await pushedTo(owner);
    assert.equal(job.comment_excerpt, null);

    const [row] = await inboxOf(owner);
    assert.equal(row.comment_excerpt, null);
    assert.equal(row.comment_spoilers, true);
  });

  it('cannot be asked about somebody else by a client', async () => {
    const someone = await user('someone');
    const error = await t.asUser(someone, () =>
      t.errorFrom(`select _can_read_comment($1, gen_random_uuid())`, [someone]),
    );
    assert.equal(error?.code, '42501');
  });
});
