import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb, createTestDbBefore } from './harness.mjs';

/**
 * 20261115000100: a reaction from anyone, the author included.
 *
 * Founder decision, 2026-11-11: an author can react to their own post and to their own
 * comment. 20261110000100 refused both with 42501; these pin the reversal — the row is
 * saved, it counts, nothing errors — and the rule that did not move with it: an author
 * is never notified of their own reaction (20260816000200).
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

/** Every inbox row Alice, the author, has — of any kind, from anybody. */
const inboxRows = async () =>
  (
    await t.sql(
      `select recipient_id, actor_id, type from notifications where recipient_id = $1 order by created_at`,
      [alice],
    )
  ).rows;

const sortedIds = (...ids) => [...ids].sort();

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

  // Alice opts into reaction notifications through the real writer. Reactions default
  // off (20260819000300), and without this the trigger would drop any inbox row for her
  // and "no notification" below would pass whether or not `set_reaction` wrote one.
  await t.actAs(alice);
  await t.sql(`select set_notification_preference('reactions', true)`);

  comment = (
    await t.sql(`select (add_comment(gen_random_uuid(), $1, $2, false)->>'comment_id') as id`, [
      event,
      'Best of the run.',
    ])
  ).rows[0].id;
});

after(async () => t?.close());

describe('an author reacting to their own activity', () => {
  it('is saved, with no error and no inbox row', async () => {
    const before = (await inboxRows()).length;
    assert.equal(await reactToEvent(alice, 'love'), null);
    assert.deepEqual(await eventRows(), [{ user_id: alice, kind: 'love' }]);
    assert.equal((await inboxRows()).length, before, 'an author is never notified of their own reaction');
  });

  it('can be changed and taken back like anybody else’s', async () => {
    assert.equal(await reactToEvent(alice, 'wow'), null);
    assert.deepEqual(await eventRows(), [{ user_id: alice, kind: 'wow' }]);
    assert.equal(await reactToEvent(alice, null), null);
    assert.deepEqual(await eventRows(), []);
    assert.equal(await reactToEvent(alice, 'love'), null);
  });

  it('counts alongside other people’s, through the read the app uses', async () => {
    assert.equal(await reactToEvent(bob, 'funny'), null);
    assert.deepEqual(
      (await eventRows()).map((row) => row.user_id),
      sortedIds(alice, bob),
    );

    // `reactions_read` is what `use-reactions.ts` counts over; the author's own row is in it.
    const seen = await t.asUser(alice, () =>
      t.sql(`select user_id from reactions where feed_event_id = $1`, [event]),
    );
    assert.deepEqual(seen.rows.map((row) => row.user_id).sort(), sortedIds(alice, bob));

    // Bob's reaction still rings for Alice, once; her own never does.
    const inbox = await inboxRows();
    assert.deepEqual(
      inbox.filter((row) => row.type === 'reaction'),
      [{ recipient_id: alice, actor_id: bob, type: 'reaction' }],
    );
  });

  it('still answers a hidden activity with P0002 before anything else', async () => {
    const error = await t.asUser(alice, async () =>
      t.errorFrom(`select set_reaction(gen_random_uuid(), $1, 'love')`, [await uuid()]),
    );
    assert.equal(error?.code, 'P0002');
  });
});

describe('an author reacting to their own comment', () => {
  it('is saved through either signature, with no error and no inbox row', async () => {
    const before = (await inboxRows()).length;
    assert.equal(await reactToComment(alice, 'love'), null);
    assert.deepEqual(await commentRows(), [{ user_id: alice, kind: 'love' }]);

    const legacy = await t.asUser(alice, () =>
      t.errorFrom(`select set_comment_reaction(gen_random_uuid(), $1, false)`, [comment]),
    );
    assert.equal(legacy, null);
    assert.deepEqual(await commentRows(), []);
    const legacyOn = await t.asUser(alice, () =>
      t.errorFrom(`select set_comment_reaction(gen_random_uuid(), $1, true)`, [comment]),
    );
    assert.equal(legacyOn, null);
    assert.deepEqual(await commentRows(), [{ user_id: alice, kind: 'love' }]);

    assert.equal((await inboxRows()).length, before);
  });

  it('counts in the thread’s aggregate alongside other people’s', async () => {
    assert.equal(await reactToComment(bob, 'funny'), null);
    const { rows } = await t.asUser(alice, () =>
      t.sql(
        `select reaction_count, reacted_by_me, my_reaction from activity_comments($1) where id = $2`,
        [event, comment],
      ),
    );
    assert.equal(rows[0].reaction_count, 2);
    assert.equal(rows[0].reacted_by_me, true);
    assert.equal(rows[0].my_reaction, 'love');
  });
});

/**
 * The migration removes the refusal and nothing else. Proved against the database it
 * replaces rather than against a copy of the text: each body after it is the body
 * before it with the one `if ... raise ... '42501'; end if;` block taken out (comments
 * and blank lines aside), and each function's grants are what they were.
 */
describe('20261115000100 against 20261114000400', () => {
  const MIGRATION = '20261115000100_a_reaction_from_anyone.sql';
  const FUNCTIONS = ['set_reaction(uuid, uuid, text)', '_set_comment_reaction(uuid, text)'];

  const describeFunctions = async (db) => {
    const out = {};
    for (const signature of FUNCTIONS) {
      const { rows } = await db.sql(
        `select prosrc, coalesce(proacl::text, '') as acl, prosecdef, proconfig::text as config
           from pg_proc where oid = $1::regprocedure`,
        [signature],
      );
      out[signature] = rows[0];
    }
    return out;
  };

  const normalise = (src) =>
    src
      .split('\n')
      .map((line) => line.replace(/--.*$/, '').trimEnd())
      .filter((line) => line.trim() !== '')
      .join('\n');

  const SELF_REFUSAL =
    /\n\s*if v_(actor|author) = auth\.uid\(\) then\n\s*raise exception 'cannot react to your own [a-z]+' using errcode = '42501';\n\s*end if;/;

  let before;
  let after;

  it('changes only the self-reaction refusal, and keeps the grants', async () => {
    const db = await createTestDbBefore(MIGRATION);
    try {
      before = await describeFunctions(db);
      await db.applyMigration(MIGRATION);
      after = await describeFunctions(db);
    } finally {
      await db.close();
    }

    for (const signature of FUNCTIONS) {
      const old = normalise(before[signature].prosrc);
      assert.match(old, SELF_REFUSAL, `${signature} refused self-reactions before`);
      assert.equal(normalise(after[signature].prosrc), old.replace(SELF_REFUSAL, ''), signature);
      assert.doesNotMatch(after[signature].prosrc, /cannot react to your own/);
      assert.equal(after[signature].acl, before[signature].acl, `${signature} grants`);
      assert.equal(after[signature].prosecdef, true);
      assert.equal(after[signature].config, before[signature].config);
    }
  });

  it('leaves set_reaction to authenticated alone, and the internal writer to no client', async () => {
    const can = async (role, signature) =>
      (
        await t.sql(`select has_function_privilege($1, $2::regprocedure, 'execute') as ok`, [
          role,
          signature,
        ])
      ).rows[0].ok;
    assert.equal(await can('authenticated', 'set_reaction(uuid, uuid, text)'), true);
    assert.equal(await can('anon', 'set_reaction(uuid, uuid, text)'), false);
    assert.equal(await can('authenticated', '_set_comment_reaction(uuid, text)'), false);
    assert.equal(await can('anon', '_set_comment_reaction(uuid, text)'), false);
    assert.equal(await can('authenticated', 'set_comment_reaction(uuid, uuid, text)'), true);
  });
});
