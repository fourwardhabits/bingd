import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Reactions (PRD §14), 20260816000200.
 *
 * The table and its constraints predate this migration; what is under test is the
 * writer, and specifically the three things a writer of social rows can get wrong:
 * writing against something the caller may not see, writing twice for one intent,
 * and writing on somebody else's behalf.
 */

let t;
let alice;
let bob;
let seq = 60000;

const movie = (title) => t.createMovie(title, seq++);

/** An event of Alice's, the ordinary subject of these tests. */
const eventOf = async (actor, mediaItemId) => {
  const { rows } = await t.sql(
    `insert into feed_events (actor_id, type, media_item_id, payload)
     values ($1, 'title_ranked', $2, '{"position":1,"bucket":"loved","category":"movies","score":10}')
     returning id`,
    [actor, mediaItemId],
  );
  return rows[0].id;
};

const react = async (eventId, kind) => {
  const { rows } = await t.sql(`select set_reaction(gen_random_uuid(), $1, $2) as r`, [
    eventId,
    kind ?? null,
  ]);
  return rows[0].r;
};

const reactionsOn = async (eventId) => {
  const { rows } = await t.sql(
    `select user_id, kind from reactions where feed_event_id = $1 order by kind`,
    [eventId],
  );
  return rows;
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_react' });
  bob = await t.createUser({ username: 'bob_react' });
  await t.actAs(bob);
});

after(async () => {
  await t?.close();
});

describe('one reaction per person per activity', () => {
  it('records a reaction', async () => {
    const event = await eventOf(alice, await movie('react_first'));
    const result = await react(event, 'love');

    assert.equal(result.kind, 'love');
    assert.deepEqual(await reactionsOn(event), [{ user_id: bob, kind: 'love' }]);
  });

  it('changes rather than duplicating', async () => {
    const event = await eventOf(alice, await movie('react_change'));
    await react(event, 'love');
    await react(event, 'agree');

    // The primary key makes this structural rather than a rule the function has to
    // remember: there is nowhere to put a second row.
    assert.deepEqual(await reactionsOn(event), [{ user_id: bob, kind: 'agree' }]);
  });

  it('removes on a null kind, and says so without complaining twice', async () => {
    const event = await eventOf(alice, await movie('react_remove'));
    await react(event, 'wow');
    assert.equal((await react(event, null)).kind, null);
    assert.deepEqual(await reactionsOn(event), []);

    // Removing what is already gone is the state the caller asked for, so it is a
    // success. A retry after a dropped response must not become an error.
    assert.equal((await react(event, null)).status, 'ok');
  });

  it('treats a repeated operation id as the retry it is', async () => {
    const event = await eventOf(alice, await movie('react_idempotent'));
    const { rows } = await t.sql(`select gen_random_uuid() as op`);
    const op = rows[0].op;

    await t.sql(`select set_reaction($1, $2, 'love')`, [op, event]);
    const second = await t.sql(`select set_reaction($1, $2, 'disagree') as r`, [op, event]);

    assert.equal(second.rows[0].r.status, 'already_applied');
    assert.deepEqual(await reactionsOn(event), [{ user_id: bob, kind: 'love' }]);
  });

  it('refuses a kind outside the closed set', async () => {
    const event = await eventOf(alice, await movie('react_unknown'));
    const error = await t.errorFrom(`select set_reaction(gen_random_uuid(), $1, 'fire')`, [event]);
    assert.equal(error?.code, '22023');
  });

  it('includes disagree, which is a founder decision and not an oversight', async () => {
    const event = await eventOf(alice, await movie('react_disagree'));
    assert.equal((await react(event, 'disagree')).kind, 'disagree');
  });
});

describe('reacting to something you are not allowed to see', () => {
  it('refuses an event by a private account the caller does not follow', async () => {
    const carol = await t.createUser({ username: 'carol_react_private', visibility: 'private' });
    const event = await eventOf(carol, await movie('react_private'));

    const error = await t.errorFrom(`select set_reaction(gen_random_uuid(), $1, 'love')`, [event]);
    assert.equal(error?.code, 'P0002');
    assert.deepEqual(await reactionsOn(event), []);
  });

  it('allows it once the follow is approved', async () => {
    const dana = await t.createUser({ username: 'dana_react_private', visibility: 'private' });
    const event = await eventOf(dana, await movie('react_approved'));
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [bob, dana],
    );

    assert.equal((await react(event, 'love')).kind, 'love');
  });

  it('refuses across a block, in either direction', async () => {
    const erin = await t.createUser({ username: 'erin_react_block' });
    const first = await eventOf(erin, await movie('react_block_a'));
    assert.equal((await react(first, 'love')).kind, 'love');

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [erin, bob]);
    const second = await eventOf(erin, await movie('react_block_b'));
    assert.equal(
      (await t.errorFrom(`select set_reaction(gen_random_uuid(), $1, 'love')`, [second]))?.code,
      'P0002',
    );

    const frank = await t.createUser({ username: 'frank_react_block' });
    const third = await eventOf(frank, await movie('react_block_c'));
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [bob, frank]);
    assert.equal(
      (await t.errorFrom(`select set_reaction(gen_random_uuid(), $1, 'love')`, [third]))?.code,
      'P0002',
    );
  });

  it('reports a hidden event exactly as it reports a missing one', async () => {
    // Two different SQLSTATEs here would be an existence oracle: a caller holding a
    // uuid could tell "that activity is real and private" from "no such activity".
    const gina = await t.createUser({ username: 'gina_react_private', visibility: 'private' });
    const hidden = await eventOf(gina, await movie('react_oracle'));
    const { rows } = await t.sql(`select gen_random_uuid() as id`);

    const hiddenError = await t.errorFrom(`select set_reaction(gen_random_uuid(), $1, 'love')`, [
      hidden,
    ]);
    const missingError = await t.errorFrom(`select set_reaction(gen_random_uuid(), $1, 'love')`, [
      rows[0].id,
    ]);

    assert.equal(hiddenError?.code, missingError?.code);
    assert.equal(hiddenError?.message, missingError?.message);
  });

  it('refuses a suspended account', async () => {
    const hank = await t.createUser({ username: 'hank_react_suspended' });
    const event = await eventOf(alice, await movie('react_suspended'));
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [hank]);
    await t.actAs(hank);

    try {
      const error = await t.errorFrom(`select set_reaction(gen_random_uuid(), $1, 'love')`, [event]);
      assert.equal(error?.code, '42501');
    } finally {
      await t.actAs(bob);
    }
  });
});

describe('the row belongs to whoever wrote it', () => {
  it('is written as the caller, whatever they claim', async () => {
    // There is no user parameter, which is the point: the only identity the
    // function will write is auth.uid(). A caller cannot react as someone else
    // because there is nowhere to say who.
    const event = await eventOf(alice, await movie('react_ownership'));
    await t.actAs(alice);
    await react(event, 'funny');
    await t.actAs(bob);
    await react(event, 'moved');

    assert.deepEqual((await reactionsOn(event)).map((r) => r.kind).sort(), ['funny', 'moved']);
  });

  it('cannot be written directly, only through the function', async () => {
    const event = await eventOf(alice, await movie('react_no_policy'));

    // `asRole` restores the role but not the claims it set, so every block that
    // switches identity is followed by an explicit `actAs`. Asserting inside the
    // block instead would throw past that restoration and leave the rest of the
    // file acting as somebody else — which is exactly how the notification tests
    // below first came to fail for a reason that had nothing to do with them.
    const error = await t.asUser(bob, () =>
      t.errorFrom(
        `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
        [event, bob],
      ),
    );
    await t.actAs(bob);

    assert.ok(error, 'reactions has no insert policy and must not gain one');
  });

  it('cannot be deleted out from under its author', async () => {
    const event = await eventOf(alice, await movie('react_no_delete'));
    await react(event, 'love');

    // Refused at the privilege layer rather than filtered by a policy, which is
    // the stronger of the two: 20260813001400 revoked table privileges from client
    // roles, so there is nothing for a delete policy to be missing from.
    const error = await t.asUser(alice, () =>
      t.errorFrom(`delete from reactions where feed_event_id = $1`, [event]),
    );
    await t.actAs(bob);

    assert.ok(error, 'a client cannot reach reactions directly at all');
    assert.equal((await reactionsOn(event)).length, 1, 'and nothing was removed');
  });
});

describe('what the activity owner is told', () => {
  it('files one inbox row for the reaction', async () => {
    const event = await eventOf(alice, await movie('react_notify'));
    await react(event, 'love');

    const { rows } = await t.sql(
      `select recipient_id, actor_id, type, subject_id, payload from notifications
        where subject_id = $1`,
      [event],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recipient_id, alice);
    assert.equal(rows[0].actor_id, bob);
    assert.equal(rows[0].type, 'reaction');
    assert.equal(rows[0].payload.kind, 'love');
  });

  it('does not ring again when the same person changes their mind', async () => {
    const event = await eventOf(alice, await movie('react_notify_once'));
    await react(event, 'love');
    await react(event, 'agree');
    await react(event, null);
    await react(event, 'wow');

    const { rows } = await t.sql(`select count(*)::int as n from notifications where subject_id = $1`, [
      event,
    ]);
    assert.equal(rows[0].n, 1);
  });

  it('says nothing about reacting to your own activity', async () => {
    const event = await eventOf(bob, await movie('react_own'));
    await react(event, 'love');

    const { rows } = await t.sql(`select count(*)::int as n from notifications where subject_id = $1`, [
      event,
    ]);
    assert.equal(rows[0].n, 0);
  });

  it('is readable by its recipient and by nobody else', async () => {
    const event = await eventOf(alice, await movie('react_notify_private'));
    await react(event, 'love');

    const asRecipient = await t.asUser(alice, () =>
      t.sql(`select 1 from notifications where subject_id = $1`, [event]),
    );
    const asReactor = await t.asUser(bob, () =>
      t.sql(`select 1 from notifications where subject_id = $1`, [event]),
    );
    await t.actAs(bob);

    assert.equal(asRecipient.rows.length, 1);
    assert.equal(asReactor.rows.length, 0, 'the reactor does not get to read the inbox');
  });
});

describe('counting them', () => {
  it('shows a reader only the reactions they could see the person behind', async () => {
    // No aggregate function exists on purpose: `reactions_read` already answers this
    // per viewer, requiring visibility of both the reactor and the event's actor. A
    // blocked user's reaction is therefore absent from the count rather than counted
    // anonymously, and nothing had to reimplement the rule to get that.
    const event = await eventOf(alice, await movie('react_count'));
    const ivy = await t.createUser({ username: 'ivy_react_count' });
    await t.actAs(ivy);
    await react(event, 'love');
    await t.actAs(bob);
    await react(event, 'agree');

    const countAsAlice = () =>
      t.asUser(alice, () =>
        t.sql(`select count(*)::int as n from reactions where feed_event_id = $1`, [event]),
      );

    const before = await countAsAlice();
    await t.actAs(bob);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [ivy, alice]);
    const after = await countAsAlice();
    await t.actAs(bob);

    assert.equal(before.rows[0].n, 2);
    assert.equal(after.rows[0].n, 1, 'a blocked reactor is not counted');
  });
});
