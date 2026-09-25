import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **The author answering without tapping Reply** (`20261021000100`, founder 2026-09-25).
 *
 * Reported from real use: the founder commented on somebody's post, the author answered
 * with a new top-level comment rather than a reply, and nobody was notified. Neither
 * existing rule could fire — the owner rule is guarded by `v_actor <> auth.uid()` and the
 * author *is* the owner; the reply rule needs a parent and a top-level comment has none.
 *
 * What this file pins is the **narrowness** as much as the fix. The dangerous version of
 * this feature is "everyone who ever commented hears about every later comment", so the
 * third-party case below matters more than the happy path: it is the assertion that would
 * catch somebody widening the rule later.
 */

let t;
let author;
let alice;
let bob;
let stranger;
let event;
let seq = 0;
let tmdb = 970_000;

before(async () => {
  t = await createTestDb();
  author = await t.createUser({ username: 'author' });
  alice = await t.createUser({ username: 'alice' });
  bob = await t.createUser({ username: 'bob' });
  stranger = await t.createUser({ username: 'stranger' });
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  const movie = await t.createMovie(`Stalker ${seq}`, (tmdb += 1));
  event = (
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload)
       values ($1, 'title_ranked', $2, '{"position":1,"bucket":"loved","category":"movies","score":10}')
       returning id`,
      [author, movie],
    )
  ).rows[0].id;
  await t.sql(`delete from notifications`);
});

/** Posts a comment as `who`, optionally under `parent`. Returns its id. */
const comment = async (who, body, parent = null) =>
  t.asUser(who, async () =>
    (
      await t.sql(
        `select (add_comment(gen_random_uuid(), $1, $2, false, $3) ->> 'comment_id') as id`,
        [event, body, parent],
      )
    ).rows[0].id,
  );

/** Every notification filed for `who` on this event, newest first. */
const inbox = async (who) =>
  (
    await t.sql(
      `select type, actor_id, payload from notifications
        where recipient_id = $1 and subject_id = $2 order by created_at desc`,
      [who, event],
    )
  ).rows;

describe('the rules that already existed', () => {
  it('a comment on somebody else’s post notifies the post author', async () => {
    await comment(alice, 'The zone is a state of mind.');

    const rows = await inbox(author);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, alice);
    assert.equal(rows[0].payload.participant, undefined, 'the owner row, not the new one');
  });

  it('a direct reply notifies the comment’s author', async () => {
    const first = await comment(alice, 'The zone is a state of mind.');
    await comment(bob, 'Say more?', first);

    const rows = await inbox(alice);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, bob);
    assert.equal(rows[0].payload.reply_to, first);
  });

  it('nobody is ever notified about their own comment', async () => {
    await comment(alice, 'One.');
    await comment(alice, 'Two.');

    assert.equal((await inbox(alice)).length, 0);
  });
});

describe('the author following up', () => {
  it('a new top-level comment by the author reaches the person who commented', async () => {
    await comment(alice, 'What did you make of the ending?');
    await t.sql(`delete from notifications`);

    await comment(author, 'I thought it earned it.');

    const rows = await inbox(alice);
    assert.equal(rows.length, 1, 'the gap this migration exists to close');
    assert.equal(rows[0].actor_id, author);
    assert.equal(rows[0].payload.participant, true);
  });

  it('reaches every prior participant independently', async () => {
    await comment(alice, 'Question one.');
    await comment(bob, 'Question two.');
    await t.sql(`delete from notifications`);

    await comment(author, 'Both good points.');

    assert.equal((await inbox(alice)).length, 1);
    assert.equal((await inbox(bob)).length, 1);
    assert.equal((await inbox(stranger)).length, 0, 'never somebody who was not there');
  });

  it('counts a participant once however often they commented', async () => {
    await comment(alice, 'One.');
    await comment(alice, 'Two.');
    await comment(alice, 'Three.');
    await t.sql(`delete from notifications`);

    await comment(author, 'Answering all three.');

    assert.equal((await inbox(alice)).length, 1);
  });

  it('never notifies the author about their own follow-up', async () => {
    await comment(alice, 'A question.');
    await t.sql(`delete from notifications`);

    await comment(author, 'An answer.');

    assert.equal((await inbox(author)).length, 0);
  });
});

describe('the narrowness, which is the point', () => {
  it('a third party’s top-level comment notifies the author alone', async () => {
    // The rule everybody would be tempted to widen. Alice commented first; Bob then
    // comments at top level. Bob is not the post's author, so Alice hears nothing —
    // otherwise every participant would hear about every later remark, forever.
    await comment(alice, 'First.');
    await t.sql(`delete from notifications`);

    await comment(bob, 'Unrelated thought.');

    assert.equal((await inbox(alice)).length, 0, 'this is the thread-spam guard');
    assert.equal((await inbox(author)).length, 1, 'the author still hears about it');
  });

  it('the author replying directly files one notification, not two', async () => {
    const first = await comment(alice, 'A question.');
    await t.sql(`delete from notifications`);

    await comment(author, 'Answering you directly.', first);

    const rows = await inbox(alice);
    assert.equal(rows.length, 1, 'the reply row, and no follow-up row beside it');
    assert.equal(rows[0].payload.reply_to, first);
    assert.equal(rows[0].payload.participant, undefined);
  });

  it('a mention wins over the follow-up row, as it does over the others', async () => {
    await comment(alice, 'A question.');
    await t.sql(`delete from notifications`);

    await comment(author, 'Good point @alice.');

    const rows = await inbox(alice);
    assert.equal(rows.length, 1, 'one action, one notification');
    assert.equal(rows[0].type, 'mention');
  });

  it('ignores a participant whose comment was deleted', async () => {
    const gone = await comment(alice, 'Withdrawn.');
    await t.asUser(alice, () =>
      t.sql(`select delete_comment(gen_random_uuid(), $1)`, [gone]),
    );
    await t.sql(`delete from notifications`);

    await comment(author, 'Carrying on.');

    assert.equal((await inbox(alice)).length, 0);
  });

  it('files nothing twice when the same call is retried', async () => {
    await comment(alice, 'A question.');
    await t.sql(`delete from notifications`);

    // One operation id, sent twice — the idempotency the whole write layer is built on.
    const op = (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
    await t.asUser(author, async () => {
      await t.sql(`select add_comment($1, $2, $3, false, null)`, [op, event, 'Answer.']);
      await t.sql(`select add_comment($1, $2, $3, false, null)`, [op, event, 'Answer.']);
    });

    assert.equal((await inbox(alice)).length, 1);
  });
});
