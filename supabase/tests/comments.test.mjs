import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Comments V1, 20260817000100.
 *
 * Four things a comment writer can get wrong, and one thing the schema has to refuse:
 *
 *   1. Writing against activity the caller may not see. An event id travels; holding
 *      one must buy nothing.
 *   2. Telling "does not exist" apart from "you may not touch it". Every refusal here
 *      is the same P0002 with the same message, and these tests assert the *sameness*
 *      rather than each message separately.
 *   3. Reading past a block or a private profile. Two predicates carry it — the
 *      author's visibility and the event actor's — and each covers a case the other
 *      does not, so both are mutated below.
 *   4. Acting on somebody else's comment.
 *
 * And the refusal: there is no `parent_id`, so a thread cannot be represented.
 */

let t;
let alice; // the actor whose activity is commented on
let bob; // the commenter
let carol; // a third party, for visibility cases
let seq = 70000;

const movie = (title) => t.createMovie(title, seq++);

const eventOf = async (actor, mediaItemId) => {
  const { rows } = await t.sql(
    `insert into feed_events (actor_id, type, media_item_id, payload)
     values ($1, 'title_ranked', $2, '{"position":1,"bucket":"loved","category":"movies","score":10}')
     returning id`,
    [actor, mediaItemId],
  );
  return rows[0].id;
};

const add = async (eventId, body, spoilers = false) => {
  const { rows } = await t.sql(`select add_comment(gen_random_uuid(), $1, $2, $3) as r`, [
    eventId,
    body,
    spoilers,
  ]);
  return rows[0].r;
};

const edit = async (commentId, body, spoilers = null) => {
  const { rows } = await t.sql(`select edit_comment(gen_random_uuid(), $1, $2, $3) as r`, [
    commentId,
    body,
    spoilers,
  ]);
  return rows[0].r;
};

const remove = async (commentId) => {
  const { rows } = await t.sql(`select delete_comment(gen_random_uuid(), $1) as r`, [commentId]);
  return rows[0].r;
};

const bodiesOn = async (eventId) => {
  const { rows } = await t.sql(
    `select body, has_spoilers, edited_at from comments where feed_event_id = $1 order by created_at`,
    [eventId],
  );
  return rows;
};

const follow = async (follower, followee, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, $3::follow_state, case when $3 = 'approved' then now() end)
     on conflict (follower_id, followee_id) do update
       set state = excluded.state, approved_at = excluded.approved_at`,
    [follower, followee, state],
  );

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_comment' });
  bob = await t.createUser({ username: 'bob_comment' });
  carol = await t.createUser({ username: 'carol_comment' });
  await t.actAs(bob);
});

after(async () => {
  await t?.close();
});

// ---------------------------------------------------------------------------

describe('the shape the founder specified', () => {
  /**
   * **Two of the assertions that were here have been deliberately inverted**, and the
   * inversion is the record of a product decision rather than a test being loosened.
   *
   * `20260817000100` excluded replies and comment reactions *by absence of a column*,
   * and this file asserted that absence — for nine days, successfully: nothing drifted
   * into threading by accident. `20260826000600` is the founder lifting both
   * exclusions, and it replaces each absence with a rule that is enforced rather than
   * merely unavailable. So these now assert the new rules, in the same spirit:
   *
   *   replies    -> `parent_id` exists, and `_comments_are_one_deep` refuses a second
   *                 level. See `comment-threads.test.mjs`, which is where the depth
   *                 bound, the cross-post guard and the tombstone contract are proved.
   *   reactions  -> `comment_reactions` exists, and has no `kind` column: the six
   *                 meanings in `reactions` are about a whole activity, and a single
   *                 remark gets a like or nothing.
   *
   * Everything else in that migration's exclusion list is untouched and still asserted
   * below: one `text` column, so there is nowhere to put a URL, a GIF or rich text.
   */
  it('can represent a reply, and exactly one level of them', async () => {
    const { rows } = await t.sql(
      `select column_name from information_schema.columns
        where table_name = 'comments' order by column_name`,
    );
    const columns = rows.map((r) => r.column_name);
    assert.deepEqual(columns, [
      'author_id',
      'body',
      'created_at',
      'deleted_at',
      'edited_at',
      'feed_event_id',
      'has_spoilers',
      'id',
      'parent_id',
    ]);

    // The depth bound is a trigger because it is a question about another row, which a
    // check constraint cannot ask. Its absence would make "one level" a convention.
    const { rows: triggers } = await t.sql(
      `select tgname from pg_trigger
        where tgrelid = 'comments'::regclass and not tgisinternal
        order by tgname`,
    );
    assert.ok(
      triggers.some((r) => r.tgname === 'comments_are_one_deep'),
      'the one-level rule must be enforced by the table, not by whichever writer arrives next',
    );
  });

  it('still has exactly one column anybody can write words into', async () => {
    // The exclusions that were *not* lifted. No media column, no url column, no
    // rich-text column: a client can render this as anything it likes and there is
    // still nowhere to put a link.
    const { rows } = await t.sql(
      `select column_name, data_type from information_schema.columns
        where table_name = 'comments' and data_type = 'text'`,
    );
    assert.deepEqual(rows.map((r) => r.column_name), ['body']);
  });

  /**
   * Superseded on 2026-08-27, and worth saying why rather than quietly rewriting.
   *
   * This test used to assert the *absence* of a `kind` column — "reacts with a like and
   * not with the six" — which was 20260826000600's deliberate decision: the six meanings
   * were about a whole activity, and a single remark deserved a toggle and a count.
   *
   * The founder overturned it on a device (20260827000500). The reason outranks the
   * original argument: a reaction is one interaction in this product, and holding the
   * control offered six on a feed row and nothing on a comment one swipe away. So the
   * assertion inverts — but it stays an assertion about the *taxonomy being shared*,
   * which is the thing that must not drift, rather than a list of column names.
   */
  it('reacts to a comment with the same six an activity takes', async () => {
    const { rows } = await t.sql(
      `select column_name from information_schema.columns
        where table_name = 'comment_reactions' order by column_name`,
    );
    assert.deepEqual(rows.map((r) => r.column_name), [
      'comment_id',
      'created_at',
      'kind',
      'user_id',
    ]);

    // The list is the list. Read off both tables' check constraints and compared, so
    // adding a seventh meaning to one and not the other fails here rather than on a
    // phone showing a glyph the other surface cannot store.
    const clauseFor = async (table) =>
      (
        await t.sql(
          `select pg_get_constraintdef(c.oid) as def
             from pg_constraint c
            where c.conrelid = $1::regclass and c.contype = 'c'
              and pg_get_constraintdef(c.oid) like '%kind%'`,
          [table],
        )
      ).rows.map((r) => r.def);

    const comment = await clauseFor('comment_reactions');
    const activity = await clauseFor('reactions');
    assert.equal(comment.length, 1, 'comment_reactions constrains its kind');
    assert.deepEqual(comment, activity, 'and constrains it to exactly what reactions does');

    for (const kind of ['love', 'agree', 'disagree', 'funny', 'wow', 'moved']) {
      assert.ok(comment[0].includes(`'${kind}'`), `${kind} is one of the six`);
    }
  });

  /**
   * The column a writer must speak for.
   *
   * `add column not null default 'love'` is what turns every existing heart into the
   * canonical reaction; dropping the default afterwards is what stops a later writer
   * storing a row that means "whatever the column decided". The second half is the one
   * a migration can silently forget, so it is pinned.
   */
  it('makes every reaction state its meaning', async () => {
    const { rows } = await t.sql(
      `select is_nullable, column_default from information_schema.columns
        where table_name = 'comment_reactions' and column_name = 'kind'`,
    );
    assert.equal(rows[0].is_nullable, 'NO');
    assert.equal(rows[0].column_default, null, 'the backfill default was dropped after it ran');
  });

  it('is referenced only by the two things that are meant to reference it', async () => {
    const { rows } = await t.sql(
      `select c.conrelid::regclass::text as referencing
         from pg_constraint c
        where c.contype = 'f' and c.confrelid = 'comments'::regclass
        order by referencing`,
    );
    // `comments` twice is `parent_id`; the third is the like. Anything else appearing
    // here is a table that has attached itself to a comment without a migration saying
    // why — which is the check the original "nothing may reference a comment" was for.
    assert.deepEqual(
      rows.map((r) => r.referencing),
      ['comment_reactions', 'comments'],
    );
  });
});

describe('writing one', () => {
  it('posts on activity the caller can see', async () => {
    const id = await movie('c_basic');
    const event = await eventOf(alice, id);

    const result = await add(event, 'Loved this one.');
    assert.equal(result.status, 'ok');
    assert.ok(result.comment_id);

    assert.deepEqual(
      (await bodiesOn(event)).map((r) => r.body),
      ['Loved this one.'],
    );
  });

  it('is idempotent, so a retry after a dropped response does not post twice', async () => {
    const id = await movie('c_idem');
    const event = await eventOf(alice, id);
    const op = (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

    await t.sql(`select add_comment($1, $2, $3, false)`, [op, event, 'Once.']);
    const { rows } = await t.sql(`select add_comment($1, $2, $3, false) as r`, [
      op,
      event,
      'Once.',
    ]);

    assert.equal(rows[0].r.status, 'already_applied');
    assert.equal((await bodiesOn(event)).length, 1);
  });

  it('trims, and refuses a comment that is only whitespace', async () => {
    const id = await movie('c_blank');
    const event = await eventOf(alice, id);

    const error = await t.errorFrom(`select add_comment(gen_random_uuid(), $1, '   ', false)`, [
      event,
    ]);
    assert.equal(error?.code, '22023');

    await add(event, '  padded  ');
    assert.equal((await bodiesOn(event))[0].body, 'padded');
  });

  it('bounds the length, so a modified client cannot store a megabyte per event', async () => {
    const id = await movie('c_long');
    const event = await eventOf(alice, id);

    const error = await t.errorFrom(`select add_comment(gen_random_uuid(), $1, $2, false)`, [
      event,
      'x'.repeat(1001),
    ]);
    assert.equal(error?.code, '22023');

    assert.equal((await add(event, 'x'.repeat(1000))).status, 'ok');
  });

  it('refuses an event that does not exist, with P0002', async () => {
    const { rows } = await t.sql(`select gen_random_uuid() as id`);
    const error = await t.errorFrom(`select add_comment(gen_random_uuid(), $1, 'hi', false)`, [
      rows[0].id,
    ]);
    assert.equal(error?.code, 'P0002');
  });

  it('refuses a suspended account before anything is written', async () => {
    const id = await movie('c_suspended');
    const event = await eventOf(alice, id);
    const banned = await t.createUser({ username: 'banned_commenter' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [banned]);

    await t.actAs(banned);
    const error = await t.errorFrom(`select add_comment(gen_random_uuid(), $1, 'hi', false)`, [
      event,
    ]);
    await t.actAs(bob);

    assert.equal(error?.code, '42501');
    assert.equal((await bodiesOn(event)).length, 0);
  });
});

// ---------------------------------------------------------------------------
// The founder's rule: an inaccessible event must not be distinguishable from one
// that is not there.

describe('an event id buys nothing', () => {
  it('answers a private account’s event exactly as it answers a missing one', async () => {
    const id = await movie('c_private');
    const shy = await t.createUser({ username: 'shy_actor', visibility: 'private' });
    const event = await eventOf(shy, id);
    const { rows } = await t.sql(`select gen_random_uuid() as id`);

    const refused = await t.errorFrom(`select add_comment(gen_random_uuid(), $1, 'hi', false)`, [
      event,
    ]);
    const missing = await t.errorFrom(`select add_comment(gen_random_uuid(), $1, 'hi', false)`, [
      rows[0].id,
    ]);

    // Both halves matter. Different codes would be a leak; the same code with
    // different messages would be the same leak one layer down.
    assert.equal(refused?.code, 'P0002');
    assert.equal(missing?.code, 'P0002');
    assert.equal(refused?.message, missing?.message);
    assert.equal((await bodiesOn(event)).length, 0);
  });

  it('lets an approved follower of a private account comment', async () => {
    // The other side of the same rule: the refusal above must be about authorisation
    // and not about private accounts being uncommentable.
    const id = await movie('c_private_ok');
    const shy = await t.createUser({ username: 'shy_actor_2', visibility: 'private' });
    const event = await eventOf(shy, id);
    await follow(bob, shy);

    assert.equal((await add(event, 'in the circle')).status, 'ok');
  });

  it('refuses activity by someone who has blocked the caller', async () => {
    const id = await movie('c_blocked');
    const hostile = await t.createUser({ username: 'hostile_actor' });
    const event = await eventOf(hostile, id);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [hostile, bob]);

    const error = await t.errorFrom(`select add_comment(gen_random_uuid(), $1, 'hi', false)`, [
      event,
    ]);
    assert.equal(error?.code, 'P0002');
  });

  it('refuses activity by a suspended account', async () => {
    const id = await movie('c_susp_actor');
    const gone = await t.createUser({ username: 'suspended_actor' });
    const event = await eventOf(gone, id);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [gone]);

    const error = await t.errorFrom(`select add_comment(gen_random_uuid(), $1, 'hi', false)`, [
      event,
    ]);
    assert.equal(error?.code, 'P0002');
  });
});

// ---------------------------------------------------------------------------

describe('reading them back', () => {
  /**
   * What one viewer's client would receive for an event, under RLS.
   *
   * `asRole` resets the *role* in its finally block and deliberately leaves the JWT
   * claims where it put them — so a bare `t.asUser(carol, ...)` silently makes carol
   * the acting identity for everything after it, and the next `add_comment` in the
   * file is written by the wrong person. That cost two green-looking failures here.
   * Every read below goes through this, which puts the identity back.
   */
  const seenBy = async (viewer, eventId) => {
    const bodies = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(
        `select body from comments where feed_event_id = $1 order by created_at`,
        [eventId],
      );
      return rows.map((r) => r.body);
    });
    await t.actAs(bob);
    return bodies;
  };

  const anonError = async (eventId) => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select body from comments where feed_event_id = $1`, [eventId]),
    );
    await t.actAs(bob);
    return error;
  };

  it('hides a comment whose author the viewer cannot see', async () => {
    const id = await movie('c_read_author');
    const event = await eventOf(alice, id);

    const shy = await t.createUser({ username: 'shy_author', visibility: 'private' });
    await t.actAs(shy);
    await add(event, 'from behind a wall');
    await t.actAs(bob);
    await add(event, 'in the open');

    assert.deepEqual(await seenBy(carol, event), ['in the open']);
  });

  it('hides every comment on activity the viewer cannot see, including its own', async () => {
    // The second predicate. Without it, a public account commenting on a private
    // account's event would publish the event's id and the fact that it exists.
    const id = await movie('c_read_actor');
    const shy = await t.createUser({ username: 'shy_actor_3', visibility: 'private' });
    const event = await eventOf(shy, id);
    await follow(bob, shy);
    await add(event, 'visible to the circle');

    assert.deepEqual(await seenBy(carol, event), []);
    assert.deepEqual(await seenBy(bob, event), ['visible to the circle']);
  });

  it('hides a blocked account’s comment from the person they blocked', async () => {
    const id = await movie('c_read_block');
    const event = await eventOf(alice, id);
    const rude = await t.createUser({ username: 'rude_author' });

    await t.actAs(rude);
    await add(event, 'unwelcome');
    await t.actAs(bob);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [rude, carol]);

    assert.deepEqual(await seenBy(carol, event), []);
  });

  it('refuses an anonymous reader at the grant, not merely at the policy', async () => {
    // The policy alone would *admit* anon here — a public author on a public actor's
    // event satisfies both halves of can_i_view, which is right for feed_events and
    // reactions and wrong for free text. The revoke is what makes comments follow
    // notes rather than reactions, and this asserts the revoke rather than the
    // emptiness a policy would have produced.
    const id = await movie('c_read_anon');
    const event = await eventOf(alice, id);
    await add(event, 'signed in only');

    const error = await anonError(event);
    assert.equal(error?.code, '42501');
  });

  it('gives a count that is already viewer-relative, so nothing has to filter twice', async () => {
    // The client counts rows it received rather than asking for a total, which is
    // what makes a blocked author's comment absent rather than counted anonymously.
    const id = await movie('c_count');
    const event = await eventOf(alice, id);
    const rude = await t.createUser({ username: 'rude_author_2' });

    await t.actAs(rude);
    await add(event, 'one');
    await t.actAs(bob);
    await add(event, 'two');
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [rude, carol]);

    assert.deepEqual(await seenBy(carol, event), ['two']);
    assert.deepEqual(await seenBy(bob, event), ['one', 'two']);
  });
});

// ---------------------------------------------------------------------------

describe('editing and deleting your own', () => {
  it('edits, and stamps edited_at', async () => {
    const id = await movie('c_edit');
    const event = await eventOf(alice, id);
    const { comment_id: commentId } = await add(event, 'frist');

    const result = await edit(commentId, 'first');
    assert.equal(result.status, 'ok');

    const [row] = await bodiesOn(event);
    assert.equal(row.body, 'first');
    assert.ok(row.edited_at);
  });

  it('leaves the spoiler claim alone when the caller does not name one', async () => {
    const id = await movie('c_edit_spoiler');
    const event = await eventOf(alice, id);
    const { comment_id: commentId } = await add(event, 'the twist is', true);

    await edit(commentId, 'the twist is...');
    assert.equal((await bodiesOn(event))[0].has_spoilers, true);

    await edit(commentId, 'nothing spoiled now', false);
    assert.equal((await bodiesOn(event))[0].has_spoilers, false);
  });

  it('deletes', async () => {
    const id = await movie('c_delete');
    const event = await eventOf(alice, id);
    const { comment_id: commentId } = await add(event, 'never mind');

    assert.equal((await remove(commentId)).status, 'ok');
    assert.deepEqual(await bodiesOn(event), []);
  });

  it('answers someone else’s comment exactly as it answers a missing one', async () => {
    const id = await movie('c_not_yours');
    const event = await eventOf(alice, id);
    await t.actAs(carol);
    const { comment_id: theirs } = await add(event, 'mine, not yours');
    await t.actAs(bob);

    const { rows } = await t.sql(`select gen_random_uuid() as id`);
    const notYoursEdit = await t.errorFrom(
      `select edit_comment(gen_random_uuid(), $1, 'hijacked', null)`,
      [theirs],
    );
    const missingEdit = await t.errorFrom(
      `select edit_comment(gen_random_uuid(), $1, 'hijacked', null)`,
      [rows[0].id],
    );
    const notYoursDelete = await t.errorFrom(`select delete_comment(gen_random_uuid(), $1)`, [
      theirs,
    ]);
    const missingDelete = await t.errorFrom(`select delete_comment(gen_random_uuid(), $1)`, [
      rows[0].id,
    ]);

    assert.equal(notYoursEdit?.code, 'P0002');
    assert.equal(notYoursEdit?.message, missingEdit?.message);
    assert.equal(notYoursDelete?.code, 'P0002');
    assert.equal(notYoursDelete?.message, missingDelete?.message);

    // And it is still there, unchanged.
    assert.deepEqual(
      (await bodiesOn(event)).map((r) => r.body),
      ['mine, not yours'],
    );
  });

  it('still lets an author retract after the actor blocks them', async () => {
    // Deliberate. Re-checking the event's visibility on edit would strand somebody's
    // words in a thread they can no longer reach.
    const id = await movie('c_retract');
    const hostile = await t.createUser({ username: 'hostile_actor_2' });
    const event = await eventOf(hostile, id);
    const { comment_id: commentId } = await add(event, 'said too much');

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [hostile, bob]);

    assert.equal((await edit(commentId, 'said less')).status, 'ok');
    assert.equal((await remove(commentId)).status, 'ok');
  });
});

// ---------------------------------------------------------------------------

describe('the inbox rows', () => {
  /**
   * Scoped to one event, not to the recipient.
   *
   * Alice is the actor for most of this file, so "every comment notification Alice
   * has" accumulates across tests and an assertion on its length would pass or fail
   * depending on what ran before it. The subject is the right scope anyway: what is
   * under test is what one event's comments produced.
   */
  const inbox = async (recipient, eventId) => {
    const { rows } = await t.sql(
      `select type, actor_id, subject_id, payload from notifications
        where recipient_id = $1 and type = 'comment' and subject_id = $2
        order by created_at`,
      [recipient, eventId],
    );
    return rows;
  };

  it('tells the actor, once per comment rather than once per commenter', async () => {
    // The opposite of a reaction, which is a state and rings once. A conversation
    // where only the opening remark is announced is not a conversation.
    const id = await movie('c_notify');
    const event = await eventOf(alice, id);

    await add(event, 'one');
    await add(event, 'two');

    const rows = await inbox(alice, event);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].actor_id, bob);
    assert.equal(rows[0].subject_id, event);
  });

  it('does not tell you about your own', async () => {
    const id = await movie('c_notify_self');
    const event = await eventOf(bob, id);
    await add(event, 'talking to myself');

    assert.deepEqual(await inbox(bob, event), []);
  });

  it('takes the notification away with the comment', async () => {
    const id = await movie('c_notify_delete');
    const event = await eventOf(alice, id);
    const { comment_id: first } = await add(event, 'kept');
    const { comment_id: second } = await add(event, 'retracted');

    await remove(second);

    const rows = await inbox(alice, event);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.comment_id, first);
  });
});

describe('the ceiling', () => {
  it('stops a commenter well before they can flood an inbox', async () => {
    const flooder = await t.createUser({ username: 'flooder' });
    const id = await movie('c_flood');
    const event = await eventOf(alice, id);

    await t.sql(`update app_config set value = '2'::jsonb where key = 'comments.max_per_day'`);
    await t.actAs(flooder);

    await add(event, 'one');
    await add(event, 'two');
    const error = await t.errorFrom(`select add_comment(gen_random_uuid(), $1, 'three', false)`, [
      event,
    ]);

    await t.sql(`update app_config set value = '100'::jsonb where key = 'comments.max_per_day'`);
    await t.actAs(bob);

    assert.equal(error?.code, '53400');
  });
});
