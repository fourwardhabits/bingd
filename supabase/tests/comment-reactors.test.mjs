import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `comment_reactors` — 20260827000900.
 *
 * Founder tranche 2026-08-27 §18: long-pressing a comment's reaction cluster opens
 * the people behind the aggregate — each person, and which reaction they used.
 *
 * The function's contract is *consistency with the number*: the identities it returns
 * are exactly the set `activity_comments` counted for this reader, no more and no
 * fewer. That is why the interesting tests here are the three visibility gates,
 * restated from that function in its own order:
 *
 *   1. the event's actor is viewable — a reader outside a private actor's circle gets
 *      an empty list, indistinguishable from an unreacted comment;
 *   2. the comment's author is viewable — a comment absent from the thread cannot
 *      grow a visible reactor list;
 *   3. each reactor is viewable — a blocked account is absent, not anonymised.
 *
 * And why the count-parity test calls both functions for the same viewer: the number
 * on the row and the people behind it disagreeing is the failure this RPC exists to
 * make impossible, so it is asserted directly rather than implied.
 */

let t;
let alice; // the actor whose event carries the thread, and the usual viewer
let bob; // the commenter
let carol; // reacts 'funny'
let dave; // reacts 'love'
let event;
let comment;
let seq = 97000;

const movie = (title) => t.createMovie(title, seq++);
const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const eventOf = async (actor, mediaItemId) => {
  const { rows } = await t.sql(
    `insert into feed_events (actor_id, type, media_item_id, payload)
     values ($1, 'title_ranked', $2, '{"position":1,"bucket":"loved","category":"movies","score":10}')
     returning id`,
    [actor, mediaItemId],
  );
  return rows[0].id;
};

const follow = (follower, followee) =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, 'approved', now()) on conflict do nothing`,
    [follower, followee],
  );

/** Posts as `who` through the writer, root or reply. */
const addComment = async (who, onEvent, body, parent = null) => {
  await t.actAs(who);
  const { rows } = await t.sql(`select add_comment(gen_random_uuid(), $1, $2, false, $3) as r`, [
    onEvent,
    body,
    parent,
  ]);
  return rows[0].r.comment_id;
};

/** Sets `who`'s reaction through the canonical text signature. */
const react = async (who, target, kind) => {
  await t.actAs(who);
  await t.sql(`select set_comment_reaction($1, $2, $3::text)`, [await uuid(), target, kind]);
};

/**
 * Pins a reaction's created_at, as the owner. Two reactions written milliseconds
 * apart can land on the same transaction timestamp, and a test of "newest first"
 * must not hinge on the scheduler; the interval makes the order a fixture.
 */
const reactedAgo = (who, target, minutes) =>
  t.sql(
    `update comment_reactions set created_at = now() - make_interval(mins => $3)
      where comment_id = $1 and user_id = $2`,
    [target, who, minutes],
  );

/** The list as `who` sees it. */
const reactorsFor = async (who, target) => {
  await t.actAs(who);
  const { rows } = await t.sql(`select * from comment_reactors($1)`, [target]);
  return rows;
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_cr' });
  bob = await t.createUser({ username: 'bob_cr' });
  carol = await t.createUser({ username: 'carol_cr' });
  dave = await t.createUser({ username: 'dave_cr' });

  event = await eventOf(alice, await movie('Mirror'));
  comment = await addComment(bob, event, 'Every frame a memory.');

  await react(carol, comment, 'funny');
  await react(dave, comment, 'love');
  await reactedAgo(carol, comment, 2);
  await reactedAgo(dave, comment, 1);
});

after(async () => t?.close());

// ---------------------------------------------------------------------------

describe('the visible list', () => {
  it('returns each reactor once with the kind they used, newest first', async () => {
    const rows = await reactorsFor(alice, comment);

    assert.deepEqual(
      rows.map((r) => [r.username, r.kind]),
      [
        ['dave_cr', 'love'],
        ['carol_cr', 'funny'],
      ],
      'dave reacted last, so dave is what the reader opened this to find',
    );
  });

  it('returns exactly the five declared columns and nothing else', async () => {
    // The projection is the disclosure boundary: a person and their one meaning.
    // Not the timestamp, not the comment, not anything a widened return table would
    // quietly start shipping to every long-press.
    const rows = await reactorsFor(alice, comment);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      'avatar_path',
      'display_name',
      'kind',
      'user_id',
      'username',
    ]);
  });

  it('leaves a blocked reactor out, and still agrees with the count on the row', async () => {
    // Gate 3, plus the parity that is the function's whole contract. The count in
    // activity_comments and this list are two reads of the same filtered set; if a
    // block removed the person from one and not the other, the reader would see
    // "3 reactions" above two faces — the review-43 defect shape, one surface over.
    const eve = await t.createUser({ username: 'eve_cr' });
    await react(eve, comment, 'wow');
    assert.equal(
      (await reactorsFor(alice, comment)).length,
      3,
      'CONTROL: eve is visible before the block',
    );

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [eve, alice]);

    const rows = await reactorsFor(alice, comment);
    assert.ok(!rows.some((r) => r.user_id === eve), 'absent rather than anonymised');

    await t.actAs(alice);
    const { rows: counted } = await t.sql(
      `select reaction_count from activity_comments($1) where id = $2`,
      [event, comment],
    );
    assert.equal(rows.length, counted[0].reaction_count, 'the list and the count are one set');
  });

  it('works for a reply exactly as for a root comment', async () => {
    // A reply is a comment; the reaction cluster is the same control one indent in,
    // and §18 makes no distinction. The gates key on the comment's own author and
    // the shared event, so nothing about parenthood may change the answer.
    const reply = await addComment(carol, event, 'And every memory a frame.', comment);
    await react(dave, reply, 'agree');

    const rows = await reactorsFor(alice, reply);
    assert.deepEqual(
      rows.map((r) => [r.username, r.kind]),
      [['dave_cr', 'agree']],
    );
  });
});

// ---------------------------------------------------------------------------

describe('a thread the reader may not open', () => {
  it('answers a private actor’s thread with the same emptiness as an unreacted comment', async () => {
    // Gate 1. bob is inside the circle: he can comment and react. carol is not, and
    // for her the list must be empty rather than refused — a refusal would confirm
    // the thread exists, which is what "indistinguishable" is protecting.
    const shy = await t.createUser({ username: 'shy_cr', visibility: 'private' });
    const privateEvent = await eventOf(shy, await movie('cr_private'));
    await follow(bob, shy);
    const privateComment = await addComment(bob, privateEvent, 'inside the circle');
    await react(bob, privateComment, 'love');

    assert.equal(
      (await reactorsFor(bob, privateComment)).length,
      1,
      'CONTROL: the reaction is there for someone approved to see it',
    );

    const unreacted = await addComment(bob, event, 'nobody has reacted to this');
    const denied = await reactorsFor(carol, privateComment);
    const empty = await reactorsFor(carol, unreacted);
    assert.deepEqual(denied, [], 'an unviewable thread grows no reactor list');
    assert.deepEqual(denied, empty, 'and the two silences are the same shape');
  });

  it('answers emptily when the reader may not see the comment’s author', async () => {
    // Gate 2. The event's actor (alice) is public and viewable; the author has
    // blocked the reader, so the comment is absent from the reader's thread — and a
    // comment the reader cannot see cannot grow a visible reactor list.
    const hostile = await t.createUser({ username: 'hostile_cr' });
    const hostileComment = await addComment(hostile, event, 'you cannot see me');
    await react(dave, hostileComment, 'funny');

    const reader = await t.createUser({ username: 'reader_cr' });
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [hostile, reader]);

    assert.equal(
      (await reactorsFor(alice, hostileComment)).length,
      1,
      'CONTROL: a reader the author has not blocked sees the reactor',
    );
    assert.deepEqual(await reactorsFor(reader, hostileComment), []);
  });

  it('answers an unknown comment id with an empty list, not an error', async () => {
    // The same shape as the two gates above, on purpose: a guessed id must not
    // reveal by its error whether a comment exists somewhere out of sight.
    const rows = await reactorsFor(alice, await uuid());
    assert.deepEqual(rows, []);
  });

  it('is not reachable by an unauthenticated caller at all', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select * from comment_reactors($1)`, [comment]),
    );
    await t.actAs(alice);
    assert.equal(error?.code, '42501', 'anon must not hold EXECUTE on comment_reactors');
  });
});
