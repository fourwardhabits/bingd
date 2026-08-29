import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * @mentions in comments — `20260830000100`.
 *
 * The founder's rule for this feature is one sentence with two halves, and the halves
 * fail in opposite directions:
 *
 *   **you may not mention an arbitrary account** — the eligibility half, tested in
 *   `who may be named`; and
 *   **you may not be told twice about one comment** — the ledger half, tested in
 *   `the edit matrix`, which is the section this whole design exists for.
 *
 * A third section covers the thing neither half describes: a mention must not become a
 * way to tell somebody *about* an activity they were never allowed to see. That is the
 * condition it is easiest to leave out, because it is about the mentioned party's
 * permissions rather than the author's.
 *
 * The cast:
 *
 *   alice   the actor whose ranking is being commented on. Public.
 *   bob     a commenter. Follows and is followed by everybody but the strangers.
 *   carol   a second commenter, so "participant" can be tested apart from "followed".
 *   dave    followed by bob and by nobody else — the pure "A" population.
 *   erin    a stranger: follows nobody, in no thread. Every exclusion is measured
 *           against her.
 *   frank   private, and follows nobody — the visibility case.
 */

let t;
let alice;
let bob;
let carol;
let dave;
let erin;
let frank;
let seq = 91000;

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

const follow = (follower, followee) =>
  t.sql(
    `insert into follows (follower_id, followee_id, state)
     values ($1, $2, 'approved') on conflict do nothing`,
    [follower, followee],
  );

const unfollow = (follower, followee) =>
  t.sql(`delete from follows where follower_id = $1 and followee_id = $2`, [follower, followee]);

/** Posts as `who`, through the six-argument signature, and returns the parsed reply. */
const comment = async (who, event, body, { parent = null, spoilers = false, mentions = [] } = {}) => {
  await t.actAs(who);
  const { rows } = await t.sql(
    `select add_comment(gen_random_uuid(), $1, $2, $3, $4, $5::uuid[]) as r`,
    [event, body, spoilers, parent, mentions],
  );
  return rows[0].r;
};

/** Edits as `who`, through the five-argument signature that restates the mentions. */
const edit = async (who, commentId, body, mentions) => {
  await t.actAs(who);
  const { rows } = await t.sql(
    `select edit_comment(gen_random_uuid(), $1, $2, false, $3::uuid[]) as r`,
    [commentId, body, mentions],
  );
  return rows[0].r;
};

/** How many mention notifications this person has ever been sent, in total. */
const mentionCount = async (who) => {
  const { rows } = await t.sql(
    `select count(*)::int as n from notifications where recipient_id = $1 and type = 'mention'`,
    [who],
  );
  return rows[0].n;
};

const candidates = async (who, event, query = '') => {
  await t.actAs(who);
  const { rows } = await t.sql(`select username, participant from mention_candidates($1, $2)`, [
    event,
    query,
  ]);
  return rows;
};

const usernames = (rows) => rows.map((r) => r.username).sort();

const errorFrom = async (who, query, params) => {
  await t.actAs(who);
  return t.errorFrom(query, params);
};

before(async () => {
  t = await createTestDb();

  alice = await t.createUser({ username: 'cm_alice' });
  bob = await t.createUser({ username: 'cm_bob' });
  carol = await t.createUser({ username: 'cm_carol' });
  dave = await t.createUser({ username: 'cm_dave' });
  erin = await t.createUser({ username: 'cm_erin' });
  frank = await t.createUser({ username: 'cm_frank', visibility: 'private' });

  for (const a of [bob, carol]) {
    await follow(a, alice);
    await follow(alice, a);
  }
  await follow(bob, carol);
  await follow(carol, bob);
  // Dave is followed by Bob and by nobody else, and is in no conversation. He is the
  // whole of population A.
  await follow(bob, dave);
});

after(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
describe('who may be named', () => {
  it('offers the people the author follows', async () => {
    const event = await eventOf(alice, await movie('cm_follows'));
    const rows = await candidates(bob, event);

    assert.ok(usernames(rows).includes('cm_dave'), 'a followed account is eligible');
  });

  it('offers a participant the author does not follow', async () => {
    const event = await eventOf(alice, await movie('cm_participant'));
    // Carol is in the thread. Bob does follow Carol, so the interesting party is Alice:
    // the actor, who is a participant by virtue of owning the activity.
    await comment(carol, event, 'first');

    const rows = await candidates(bob, event);
    const alicesRow = rows.find((r) => r.username === 'cm_alice');
    assert.ok(alicesRow, 'the activity’s actor is a participant');
    assert.equal(alicesRow.participant, true);
  });

  /**
   * The founder's central worry about this feature, stated as a test: typing `@` must
   * not become a way to reach the whole app. Erin is nobody's follow and in nobody's
   * thread, so she is not a low-ranked row here — she is not a row.
   */
  it('does not offer an unrelated stranger', async () => {
    const event = await eventOf(alice, await movie('cm_stranger'));
    const rows = await candidates(bob, event);

    assert.ok(!usernames(rows).includes('cm_erin'));
  });

  it('refuses a comment that names a stranger', async () => {
    const event = await eventOf(alice, await movie('cm_stranger_write'));
    const error = await errorFrom(
      bob,
      `select add_comment(gen_random_uuid(), $1, 'hello @cm_erin', false, null, $2::uuid[])`,
      [event, [erin]],
    );
    assert.equal(error.code, '42501');
  });

  it('excludes a blocked account in either direction', async () => {
    const event = await eventOf(alice, await movie('cm_block'));
    await comment(carol, event, 'carol is in the room');

    // Carol is both a participant and a mutual follow of Bob's, so this isolates the
    // block: nothing else about her eligibility changes.
    await t.actAs(carol);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [carol, bob]);

    const rows = await candidates(bob, event);
    assert.ok(!usernames(rows).includes('cm_carol'), 'the blocker is not offered');

    const error = await errorFrom(
      bob,
      `select add_comment(gen_random_uuid(), $1, 'hi @cm_carol', false, null, $2::uuid[])`,
      [event, [carol]],
    );
    assert.equal(error.code, '42501');

    await t.sql(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [carol, bob]);
  });

  it('excludes a suspended account', async () => {
    const event = await eventOf(alice, await movie('cm_suspended'));
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [dave]);

    const rows = await candidates(bob, event);
    assert.ok(!usernames(rows).includes('cm_dave'));

    await t.sql(`update profiles set status = 'active' where id = $1`, [dave]);
  });

  /**
   * The half about the *mentioned* person's permissions rather than the author's.
   *
   * Frank follows nobody and Alice is public, so Frank can see Alice's activity — the
   * mention is allowed. Make Alice private and Frank can no longer see the ranking the
   * notification would be about, so naming him would be a way to tell him what a
   * private account watched. He goes out of the candidate list and the write is refused.
   */
  it('excludes somebody who cannot see the activity', async () => {
    const event = await eventOf(alice, await movie('cm_unviewable'));
    await follow(bob, frank);

    assert.ok(usernames(await candidates(bob, event)).includes('cm_frank'), 'public: eligible');

    await t.sql(`update profiles set visibility = 'private' where id = $1`, [alice]);
    assert.ok(
      !usernames(await candidates(bob, event)).includes('cm_frank'),
      'private actor, and Frank does not follow her: not eligible',
    );

    const error = await errorFrom(
      bob,
      `select add_comment(gen_random_uuid(), $1, '@cm_frank look', false, null, $2::uuid[])`,
      [event, [frank]],
    );
    assert.equal(error.code, '42501');

    await t.sql(`update profiles set visibility = 'public' where id = $1`, [alice]);
    await unfollow(bob, frank);
  });

  it('never offers the author themselves, and never notifies them', async () => {
    const event = await eventOf(alice, await movie('cm_self'));
    assert.ok(!usernames(await candidates(bob, event)).includes('cm_bob'));

    const before = await mentionCount(bob);
    const error = await errorFrom(
      bob,
      `select add_comment(gen_random_uuid(), $1, '@cm_bob talking to myself', false, null, $2::uuid[])`,
      [event, [bob]],
    );
    assert.equal(error.code, '42501');
    assert.equal(await mentionCount(bob), before);
  });

  it('answers nothing at all to somebody who cannot see the activity', async () => {
    const mediaId = await movie('cm_hidden_event');
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [alice]);
    const event = await eventOf(alice, mediaId);

    assert.deepEqual(await candidates(erin, event), []);

    await t.sql(`update profiles set visibility = 'public' where id = $1`, [alice]);
  });

  it('matches a fragment on the handle and on any word of the display name', async () => {
    const event = await eventOf(alice, await movie('cm_fragment'));
    await t.sql(`update profiles set display_name = 'Dave Bowman' where id = $1`, [dave]);

    assert.ok(usernames(await candidates(bob, event, 'cm_da')).includes('cm_dave'), 'handle prefix');
    assert.ok(usernames(await candidates(bob, event, 'bow')).includes('cm_dave'), 'second word');
    assert.ok(
      !usernames(await candidates(bob, event, 'owma')).includes('cm_dave'),
      'infix does not match — a two-letter probe must not enumerate a follow list',
    );
  });
});

// ---------------------------------------------------------------------------
describe('the notification', () => {
  it('files exactly one, pointing at the conversation', async () => {
    const event = await eventOf(alice, await movie('cm_one'));
    const before = await mentionCount(dave);

    const posted = await comment(bob, event, 'hey @cm_dave', { mentions: [dave] });

    const { rows } = await t.sql(
      `select subject_type, subject_id, actor_id, payload from notifications
        where recipient_id = $1 and type = 'mention'
        order by created_at desc limit 1`,
      [dave],
    );
    assert.equal(await mentionCount(dave), before + 1);
    assert.equal(rows[0].subject_type, 'feed_event');
    assert.equal(rows[0].subject_id, event);
    assert.equal(rows[0].actor_id, bob);
    assert.equal(rows[0].payload.comment_id, posted.comment_id);
    assert.equal(rows[0].payload.reply, false);
  });

  it('works from a reply, and says so', async () => {
    const event = await eventOf(alice, await movie('cm_reply'));
    const root = await comment(carol, event, 'the remark');
    await comment(bob, event, 'answering, @cm_dave', { parent: root.comment_id, mentions: [dave] });

    const { rows } = await t.sql(
      `select payload from notifications where recipient_id = $1 and type = 'mention'
        order by created_at desc limit 1`,
      [dave],
    );
    assert.equal(rows[0].payload.reply, true);
  });

  it('files one per person named, and several in one comment', async () => {
    const event = await eventOf(alice, await movie('cm_several'));
    const beforeDave = await mentionCount(dave);
    const beforeCarol = await mentionCount(carol);

    await comment(bob, event, '@cm_dave @cm_carol both of you', { mentions: [dave, carol] });

    assert.equal(await mentionCount(dave), beforeDave + 1);
    assert.equal(await mentionCount(carol), beforeCarol + 1);
  });

  /**
   * Two rows for one person, on purpose. Alice owns the activity and is also named, and
   * those are two different statements — "there is a new remark on your post" and "this
   * remark is addressed to you". The second is the one the founder asked for, precisely
   * because the first was not enough.
   */
  it('does not swallow the comment notification for an activity owner who is also named', async () => {
    const event = await eventOf(alice, await movie('cm_owner'));
    await comment(bob, event, 'thoughts, @cm_alice?', { mentions: [alice] });

    const { rows } = await t.sql(
      `select type, count(*)::int as n from notifications
        where recipient_id = $1 and subject_id = $2 group by type order by type`,
      [alice, event],
    );
    assert.deepEqual(rows, [
      { type: 'comment', n: 1 },
      { type: 'mention', n: 1 },
    ]);
  });

  it('is silenced by the Comments preference, not a ninth category', async () => {
    const event = await eventOf(alice, await movie('cm_pref'));
    const before = await mentionCount(dave);

    await t.actAs(dave);
    await t.sql(`select set_notification_preference('comments', false)`);

    await comment(bob, event, 'quiet, @cm_dave', { mentions: [dave] });
    assert.equal(await mentionCount(dave), before, 'the trigger dropped it');

    await t.actAs(dave);
    await t.sql(`select set_notification_preference('comments', true)`);
  });
});

// ---------------------------------------------------------------------------
/**
 * The section this design exists for.
 *
 * Every row here is one of the founder's numbered cases, in his order, and they are
 * cumulative on purpose: it is the *sequence* that breaks a naive implementation, not
 * any single step.
 */
describe('the edit matrix', () => {
  it('tells each person once, however the comment is rewritten', async () => {
    const event = await eventOf(alice, await movie('cm_matrix'));
    const daveBefore = await mentionCount(dave);
    const carolBefore = await mentionCount(carol);

    // 1. created mentioning Dave → one.
    const posted = await comment(bob, event, '@cm_dave great film', { mentions: [dave] });
    assert.equal(await mentionCount(dave), daveBefore + 1, 'created: one');

    // 2. edited, still mentioning Dave → still one.
    await edit(bob, posted.comment_id, '@cm_dave great film actually', [dave]);
    assert.equal(await mentionCount(dave), daveBefore + 1, 'edited, still named: still one');

    // 3. Carol added → Dave unchanged, Carol one.
    await edit(bob, posted.comment_id, '@cm_dave @cm_carol great film', [dave, carol]);
    assert.equal(await mentionCount(dave), daveBefore + 1, 'the existing mention is not re-fired');
    assert.equal(await mentionCount(carol), carolBefore + 1, 'the new one is told, once');

    // 4. Dave removed → his delivered notification survives; the row does too.
    await edit(bob, posted.comment_id, '@cm_carol great film', [carol]);
    assert.equal(
      await mentionCount(dave),
      daveBefore + 1,
      'a removed mention does not delete history',
    );

    // 5. Dave re-added → nothing. This is the farming case.
    await edit(bob, posted.comment_id, '@cm_dave @cm_carol great film', [dave, carol]);
    assert.equal(await mentionCount(dave), daveBefore + 1, 're-adding files nothing, ever');

    // And the whole cycle again, because "ever" is the claim.
    for (let i = 0; i < 3; i += 1) {
      await edit(bob, posted.comment_id, 'great film', []);
      await edit(bob, posted.comment_id, '@cm_dave great film', [dave]);
    }
    assert.equal(await mentionCount(dave), daveBefore + 1, 'still one after five removals');
  });

  it('keeps the row and the stamp when a mention is removed', async () => {
    const event = await eventOf(alice, await movie('cm_ledger'));
    const posted = await comment(bob, event, '@cm_dave hi', { mentions: [dave] });
    await edit(bob, posted.comment_id, 'hi', []);

    const { rows } = await t.sql(
      `select active, notified_at is not null as notified from comment_mentions
        where comment_id = $1 and mentioned_id = $2`,
      [posted.comment_id, dave],
    );
    assert.equal(rows.length, 1, 'the row is deactivated, never deleted');
    assert.equal(rows[0].active, false);
    assert.equal(rows[0].notified, true, 'the stamp is what stops the second notification');
  });

  /**
   * A replayed mutation. `_claim_operation` catches a replay carrying the *same* id;
   * this asserts the layer beneath it, which is what protects against two different
   * intents that happen to name the same person — an offline outbox flushing an edit
   * twice under two ids, say.
   */
  it('does not duplicate under a replayed edit with a fresh operation id', async () => {
    const event = await eventOf(alice, await movie('cm_replay'));
    const before = await mentionCount(dave);
    const posted = await comment(bob, event, '@cm_dave once', { mentions: [dave] });

    for (let i = 0; i < 4; i += 1) await edit(bob, posted.comment_id, '@cm_dave once', [dave]);

    assert.equal(await mentionCount(dave), before + 1);
  });

  /**
   * The handle is not the association. Renaming Dave leaves the stored relation pointing
   * at Dave, so an edit that re-sends his id is still "the same mention" and files
   * nothing — which is the whole reason section 1 of the migration is a table.
   */
  it('survives a handle change', async () => {
    const event = await eventOf(alice, await movie('cm_rename'));
    const before = await mentionCount(dave);
    const posted = await comment(bob, event, '@cm_dave hello', { mentions: [dave] });

    await t.sql(`update profiles set username = 'cm_dave2' where id = $1`, [dave]);

    await t.actAs(bob);
    const { rows } = await t.sql(
      `select mentions from activity_comments($1) where id = $2`,
      [event, posted.comment_id],
    );
    assert.equal(rows[0].mentions[0].id, dave, 'the id is unchanged');
    assert.equal(rows[0].mentions[0].username, 'cm_dave2', 'the handle is resolved fresh');
    /**
     * **And the spelling the body actually uses, frozen.**
     *
     * The row returns both because the composer needs both: the body still says
     * `@cm_dave`, and a client that could only match against the *current* handle would
     * resolve nothing on the next ordinary edit and deactivate a mention that is plainly
     * still in the text. Independent review 68 found that; this is the column that
     * closes it.
     */
    assert.equal(rows[0].mentions[0].handle, 'cm_dave', 'what the body spells');

    await edit(bob, posted.comment_id, '@cm_dave2 hello', [dave]);
    assert.equal(await mentionCount(dave), before + 1, 'the same person, not a new one');

    // The stored spelling is *not* rewritten by that save: it records what the body said
    // when the mention was made, and overwriting it would destroy the only thing that
    // lets an older body be matched at all.
    const { rows: after } = await t.sql(
      `select handle from comment_mentions where comment_id = $1 and mentioned_id = $2`,
      [posted.comment_id, dave],
    );
    assert.equal(after[0].handle, 'cm_dave');

    await t.sql(`update profiles set username = 'cm_dave' where id = $1`, [dave]);
  });

  /**
   * A bundle that predates this migration calls the four-argument `edit_comment`, which
   * knows nothing about mentions. It must leave them exactly as they are: silently
   * deactivating a mention because the caller did not mention mentions is the kind of
   * data loss nobody would ever report.
   */
  it('leaves mentions untouched when edited through the old signature', async () => {
    const event = await eventOf(alice, await movie('cm_oldsig'));
    const posted = await comment(bob, event, '@cm_dave hi', { mentions: [dave] });

    await t.actAs(bob);
    await t.sql(`select edit_comment(gen_random_uuid(), $1, 'hi again', false)`, [
      posted.comment_id,
    ]);

    const { rows } = await t.sql(
      `select active from comment_mentions where comment_id = $1 and mentioned_id = $2`,
      [posted.comment_id, dave],
    );
    assert.equal(rows[0].active, true);
  });

  it('lets an author keep a mention that has since become ineligible', async () => {
    const event = await eventOf(alice, await movie('cm_lapsed'));
    const posted = await comment(bob, event, '@cm_dave hi', { mentions: [dave] });
    const before = await mentionCount(dave);

    // Bob stops following Dave, who is in no thread — so Dave is no longer eligible.
    await unfollow(bob, dave);

    const result = await edit(bob, posted.comment_id, '@cm_dave hi there', [dave]);
    assert.equal(result.status, 'ok', 'an author is not locked out of their own words');
    assert.equal(await mentionCount(dave), before, 'and the exemption cannot ring again');

    await follow(bob, dave);
  });
});

// ---------------------------------------------------------------------------
describe('reading a thread back', () => {
  it('returns the ids and handles the composer needs', async () => {
    const event = await eventOf(alice, await movie('cm_read'));
    const posted = await comment(bob, event, '@cm_dave @cm_carol hello', {
      mentions: [dave, carol],
    });

    await t.actAs(bob);
    const { rows } = await t.sql(`select mentions from activity_comments($1) where id = $2`, [
      event,
      posted.comment_id,
    ]);
    assert.deepEqual(
      rows[0].mentions.map((m) => m.username).sort(),
      ['cm_carol', 'cm_dave'],
    );
  });

  /**
   * **Through the `authenticated` role, not as the owner**, which is the one thing the
   * rest of this file cannot check: `actAs` sets the JWT claims and leaves the session as
   * the table owner, so a missing `grant execute` is invisible to every assertion above.
   *
   * Section 8 of the migration *drops* `activity_comments` to widen its row type, and a
   * dropped function takes its ACL with it — so the read that draws every conversation in
   * the app can silently come back ungranted. It did, on the first draft, and
   * `comment-reactions.test.mjs` caught it because it is one of the few suites that reads
   * this way. This is the mentions suite carrying its own half of that.
   */
  it('is readable by an ordinary signed-in account, not only by the owner', async () => {
    const event = await eventOf(alice, await movie('cm_grant'));
    const posted = await comment(bob, event, '@cm_dave hello', { mentions: [dave] });

    const rows = await t.asUser(bob, async () =>
      (await t.sql(`select mentions from activity_comments($1) where id = $2`, [
        event,
        posted.comment_id,
      ])).rows,
    );
    assert.deepEqual(rows[0].mentions.map((m) => m.username), ['cm_dave']);
  });

  it('is an empty array rather than null when nobody is named', async () => {
    const event = await eventOf(alice, await movie('cm_none'));
    const posted = await comment(bob, event, 'nobody in particular');

    await t.actAs(bob);
    const { rows } = await t.sql(`select mentions from activity_comments($1) where id = $2`, [
      event,
      posted.comment_id,
    ]);
    assert.deepEqual(rows[0].mentions, []);
  });

  it('names nobody on a tombstone', async () => {
    const event = await eventOf(alice, await movie('cm_tomb'));
    const root = await comment(bob, event, '@cm_dave hello', { mentions: [dave] });
    await comment(carol, event, 'a reply that keeps it standing', { parent: root.comment_id });

    await t.actAs(bob);
    await t.sql(`select delete_comment(gen_random_uuid(), $1)`, [root.comment_id]);

    const { rows } = await t.sql(`select body, mentions from activity_comments($1) where id = $2`, [
      event,
      root.comment_id,
    ]);
    assert.equal(rows[0].body, null);
    assert.deepEqual(rows[0].mentions, [], 'a retracted comment names nobody');
  });

  it('takes the mention notification with the comment', async () => {
    const event = await eventOf(alice, await movie('cm_delnotif'));
    const posted = await comment(bob, event, '@cm_dave hello', { mentions: [dave] });

    await t.actAs(bob);
    await t.sql(`select delete_comment(gen_random_uuid(), $1)`, [posted.comment_id]);

    const { rows } = await t.sql(
      `select count(*)::int as n from notifications
        where type = 'mention' and payload ->> 'comment_id' = $1`,
      [posted.comment_id],
    );
    assert.equal(rows[0].n, 0);
  });
});

// ---------------------------------------------------------------------------
describe('the compatibility signature', () => {
  it('still posts a comment with no mentions', async () => {
    const event = await eventOf(alice, await movie('cm_compat'));
    await t.actAs(bob);
    const { rows } = await t.sql(
      `select add_comment(gen_random_uuid(), $1, 'no mentions here', false, null) as r`,
      [event],
    );
    assert.equal(rows[0].r.status, 'ok');

    const { rows: mentions } = await t.sql(
      `select count(*)::int as n from comment_mentions where comment_id = $1`,
      [rows[0].r.comment_id],
    );
    assert.equal(mentions[0].n, 0);
  });

  it('keeps both signatures distinguishable', async () => {
    const { rows } = await t.sql(
      `select count(*)::int as n from pg_proc where proname = 'add_comment'`,
    );
    assert.equal(rows[0].n, 2, 'five arguments and six, so PostgREST resolves either payload');
  });
});
