import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * 20261110000100: a reaction comes from somebody else.
 *
 * The founder was offered a heart on their own ranking. The client no longer draws one;
 * these pin the server half — a new self-reaction is refused on an activity and on a
 * comment — and the two things the change must not do: delete the self-reactions already
 * stored, or stop their author taking one back.
 */

let t;
let alice;
let bob;
let event;
let comment;

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const reactToEvent = (who, kind) =>
  t.asUser(who, () =>
    t.errorFrom(`select set_reaction(gen_random_uuid(), $1, $2)`, [event, kind]),
  );

const reactToComment = (who, kind) =>
  t.asUser(who, () =>
    t.errorFrom(`select set_comment_reaction(gen_random_uuid(), $1, $2::text)`, [comment, kind]),
  );

const eventRows = async () =>
  (
    await t.sql(`select user_id, kind from reactions where feed_event_id = $1 order by user_id`, [
      event,
    ])
  ).rows;

const commentRows = async () =>
  (
    await t.sql(`select user_id, kind from comment_reactions where comment_id = $1 order by user_id`, [
      comment,
    ])
  ).rows;

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_self' });
  bob = await t.createUser({ username: 'bob_self' });

  const movie = await t.createMovie('Logan', 930001);
  event = (
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload)
       values ($1, 'title_ranked', $2, '{"position":1,"bucket":"loved","category":"movies","score":9}')
       returning id`,
      [alice, movie],
    )
  ).rows[0].id;

  await t.actAs(alice);
  comment = (
    await t.sql(`select (add_comment(gen_random_uuid(), $1, $2, false)->>'comment_id') as id`, [
      event,
      'Best of the run.',
    ])
  ).rows[0].id;
});

after(async () => t?.close());

describe('an activity', () => {
  it('refuses its author a new reaction, and writes nothing', async () => {
    const error = await reactToEvent(alice, 'love');
    assert.equal(error?.code, '42501');
    assert.match(error?.message ?? '', /own activity/);
    assert.deepEqual(await eventRows(), []);
  });

  it('still takes everybody else’s', async () => {
    assert.equal(await reactToEvent(bob, 'love'), null);
    assert.deepEqual(await eventRows(), [{ user_id: bob, kind: 'love' }]);
  });

  it('keeps a self-reaction written before the rule, and lets its author take it back', async () => {
    // Written as the owner, the way a row from before 20261110000100 already exists.
    await t.sql(`insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'wow')`, [
      event,
      alice,
    ]);
    const kinds = () => eventRows().then((rows) => rows.map((row) => row.kind).sort());
    assert.deepEqual(await kinds(), ['love', 'wow'], 'the migration deleted nothing');

    // Changing it is a new reaction to yourself, and is refused like one.
    assert.equal((await reactToEvent(alice, 'agree'))?.code, '42501');
    assert.deepEqual(await kinds(), ['love', 'wow']);

    // Removing it is not a reaction at all.
    assert.equal(await reactToEvent(alice, null), null);
    assert.deepEqual(await eventRows(), [{ user_id: bob, kind: 'love' }]);
  });

  it('still answers a hidden activity with P0002 before anything else', async () => {
    const error = await t.asUser(alice, async () =>
      t.errorFrom(`select set_reaction(gen_random_uuid(), $1, 'love')`, [await uuid()]),
    );
    assert.equal(error?.code, 'P0002');
  });
});

describe('a comment', () => {
  it('refuses its author a new reaction through either signature', async () => {
    assert.equal((await reactToComment(alice, 'love'))?.code, '42501');
    const legacy = await t.asUser(alice, () =>
      t.errorFrom(`select set_comment_reaction(gen_random_uuid(), $1, true)`, [comment]),
    );
    assert.equal(legacy?.code, '42501');
    assert.deepEqual(await commentRows(), []);
  });

  it('still takes everybody else’s', async () => {
    assert.equal(await reactToComment(bob, 'funny'), null);
    assert.deepEqual(await commentRows(), [{ user_id: bob, kind: 'funny' }]);
  });

  it('keeps a historical self-reaction and lets its author remove it', async () => {
    await t.sql(
      `insert into comment_reactions (comment_id, user_id, kind) values ($1, $2, 'love')`,
      [comment, alice],
    );
    assert.equal((await commentRows()).length, 2, 'the migration deleted nothing');

    assert.equal(await reactToComment(alice, null), null);
    assert.deepEqual(await commentRows(), [{ user_id: bob, kind: 'funny' }]);
  });
});
