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
   * The founder's restraint clause, and `20260909000100` narrowed what it is about
   * rather than removing it.
   *
   * It used to mean "a stranger is not mentionable". It now means **a bare `@` does not
   * offer strangers**: the list that appears mid-word is the people you are likely to
   * mean, not a slice of the user table. Erin is nobody's follow and in nobody's thread,
   * so she is not here — until somebody types her name, which is the next test.
   */
  it('does not offer an unrelated stranger to a bare @', async () => {
    const event = await eventOf(alice, await movie('cm_stranger'));
    const rows = await candidates(bob, event);

    assert.ok(!usernames(rows).includes('cm_erin'));
  });

  /**
   * The widening, from the composer's side. Typing a name is how you say you meant
   * somebody, and a person the author could find in People search must be findable here
   * too — otherwise they are server-mentionable and the composer says they are not,
   * which is the worst of both.
   */
  it('offers an unrelated account once its name is typed', async () => {
    const event = await eventOf(alice, await movie('cm_stranger_typed'));
    const rows = await candidates(bob, event, 'cm_erin');

    assert.ok(usernames(rows).includes('cm_erin'));
  });

  it('accepts a comment that names somebody the author could look up', async () => {
    const event = await eventOf(alice, await movie('cm_stranger_write'));
    const before = await mentionCount(erin);

    const posted = await comment(bob, event, 'hello @cm_erin', { mentions: [erin] });

    assert.equal(posted.status, 'ok');
    assert.equal(await mentionCount(erin), before + 1);
  });

  /**
   * Private is not unreachable, which is `20260819000100`'s whole point: a private
   * account is findable by name so somebody who knows them can ask to follow, and
   * everything they wrote stays behind `can_view_profile`. A mention carries identity,
   * so it follows discovery.
   *
   * Frank is private and follows nobody. Alice is public here, so Frank can see the
   * activity — which is the *other* clause, and the next test is what happens when he
   * cannot.
   */
  it('offers and accepts a private account the author does not follow', async () => {
    const event = await eventOf(alice, await movie('cm_private_ok'));
    const before = await mentionCount(frank);

    assert.ok(usernames(await candidates(bob, event, 'cm_frank')).includes('cm_frank'));

    const posted = await comment(bob, event, 'hello @cm_frank', { mentions: [frank] });
    assert.equal(posted.status, 'ok');
    assert.equal(await mentionCount(frank), before + 1);
  });

  /**
   * The bound on the widening, and the reason `can_discover_profile` alone would have
   * been wrong. Everybody active is discoverable; only an actor's own followers can see
   * a private actor's post, so that is who may be named under it.
   */
  it('offers nobody undiscoverable, however specific the fragment', async () => {
    const event = await eventOf(alice, await movie('cm_fragment_probe'));

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [erin]);
    const suspended = usernames(await candidates(bob, event, 'cm_erin'));
    await t.sql(`update profiles set status = 'active' where id = $1`, [erin]);

    assert.ok(!suspended.includes('cm_erin'), 'a suspended account is not a search result');
  });

  /**
   * Task 8's agreement property, asserted as a property rather than case by case.
   *
   * Every row the composer offers must be a row the server would accept. A list that can
   * offer somebody the write then refuses is the one failure mode a widened rule makes
   * easy, because the population and the predicate are now computed in two places.
   */
  it('offers nobody the write would refuse', async () => {
    const event = await eventOf(alice, await movie('cm_agreement'));
    await comment(carol, event, 'carol is in the room');

    for (const fragment of ['', 'cm_', 'cm_e', 'cm_frank', 'cm_dave']) {
      for (const row of await candidates(bob, event, fragment)) {
        await t.actAs(bob);
        const { rows } = await t.sql(
          `select _can_mention($1, (select id from profiles where username = $2)) as ok`,
          [event, row.username],
        );
        assert.equal(rows[0].ok, true, `offered but not mentionable: ${row.username}`);
      }
    }
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
  /**
   * The founder's rule, and it reverses 20260830000100's.
   *
   * That migration filed both rows on the argument that "there is a new remark on your
   * post" and "this remark is addressed to you" are two different statements. They are,
   * but one action by one person may put at most one line in somebody's Bell, and where
   * the two collide the specific one wins: "mentioned you in a comment" already implies
   * a new remark on your post, and the reverse is not true. `20260908000100`.
   */
  it('files the mention instead of the comment row when the owner is also named', async () => {
    const event = await eventOf(alice, await movie('cm_owner'));
    await comment(bob, event, 'thoughts, @cm_alice?', { mentions: [alice] });

    const { rows } = await t.sql(
      `select type, count(*)::int as n from notifications
        where recipient_id = $1 and subject_id = $2 group by type order by type`,
      [alice, event],
    );
    assert.deepEqual(rows, [{ type: 'mention', n: 1 }]);
  });

  /** The same rule one level down: a reply that names the person it is replying to. */
  it('files one row, not two, for a reply that names its own recipient', async () => {
    const event = await eventOf(alice, await movie('cm_reply_dedupe'));
    const parent = (await comment(carol, event, 'the score is the film')).comment_id;
    await comment(bob, event, '@cm_carol exactly', { parent, mentions: [carol] });

    const { rows } = await t.sql(
      `select type, count(*)::int as n from notifications
        where recipient_id = $1 and subject_id = $2 group by type order by type`,
      [carol, event],
    );
    assert.deepEqual(rows, [{ type: 'mention', n: 1 }]);
  });

  /**
   * The suppression is per person, not per comment. A reply that names a third party
   * must still tell the person being replied to that they were replied to.
   */
  it('still tells the reply recipient when somebody else is the one named', async () => {
    const event = await eventOf(alice, await movie('cm_reply_third'));
    const parent = (await comment(carol, event, 'worth a rewatch')).comment_id;
    await comment(bob, event, '@cm_dave you would like this', { parent, mentions: [dave] });

    const { rows } = await t.sql(
      `select type, count(*)::int as n from notifications
        where recipient_id = $1 and subject_id = $2 and type = 'comment' group by type`,
      [carol, event],
    );
    assert.deepEqual(rows, [{ type: 'comment', n: 1 }]);
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

  /**
   * The half of `20260909000100` that is not about eligibility at all.
   *
   * The `mentioned` CTE filtered identities through `can_view_profile`, which was
   * invisible while every mention was a follow or a participant. Widen the rule and it
   * becomes a regression you can see: a valid mention of a discoverable private account
   * fires a notification and then renders as plain text, because the reader is not
   * allowed to *view* them. Identity is not content — `20260819000100`'s line.
   */
  it('returns a private mentioned account to a reader who does not follow them', async () => {
    const event = await eventOf(alice, await movie('cm_read_private'));
    await comment(bob, event, 'hello @cm_frank', { mentions: [frank] });

    // Carol follows neither Frank nor anybody relevant to him, and Frank is private.
    await t.actAs(carol);
    const { rows } = await t.sql(
      `select mentions from activity_comments($1) order by created_at desc limit 1`,
      [event],
    );
    const named = (rows[0].mentions ?? []).map((m) => m.username);
    assert.deepEqual(named, ['cm_frank'], 'the link must be drawable, so the row must arrive');
  });

  /** And a reader may always see their own name light up in a comment that names them. */
  it('returns the reader to themselves when they are the one named', async () => {
    const event = await eventOf(alice, await movie('cm_read_self'));
    await comment(bob, event, 'hello @cm_dave', { mentions: [dave] });

    await t.actAs(dave);
    const { rows } = await t.sql(
      `select mentions from activity_comments($1) order by created_at desc limit 1`,
      [event],
    );
    assert.deepEqual((rows[0].mentions ?? []).map((m) => m.username), ['cm_dave']);
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
/**
 * What the founder actually reported: `@silky thoughts?`, typed rather than tapped,
 * notified nobody. Until `20260908000100` a mention was an id the client had been handed
 * by the suggestion list, so a handle somebody typed because they already knew it was
 * prose — spelled like a mention, read like a mention, and inert.
 *
 * The body is the source now, resolved server-side through the same `_can_mention` a
 * picked id always faced. What changed is the *route* to a person the author was always
 * allowed to name, not who that set contains — so every exclusion is re-asserted here
 * from the typed side rather than inherited from the picked one. A resolution path that
 * skipped the eligibility rule would pass every test in the sections above.
 *
 * All of these post through the **five-argument** signature, which carries no mention
 * array at all: whatever they prove, they prove about the text alone.
 */
describe('a handle nobody tapped', () => {
  const typedOnly = async (who, event, body, parent = null) => {
    await t.actAs(who);
    const { rows } = await t.sql(
      `select add_comment(gen_random_uuid(), $1, $2, false, $3) as r`,
      [event, body, parent],
    );
    return rows[0].r;
  };

  const typedEdit = async (who, commentId, body) => {
    await t.actAs(who);
    const { rows } = await t.sql(
      `select edit_comment(gen_random_uuid(), $1, $2, false, '{}'::uuid[]) as r`,
      [commentId, body],
    );
    return rows[0].r;
  };

  /** Who a comment actively names, by current handle, in a stable order. */
  const mentionedOn = async (commentId) => {
    const { rows } = await t.sql(
      `select p.username from comment_mentions m
         join profiles p on p.id = m.mentioned_id
        where m.comment_id = $1 and m.active order by p.username`,
      [commentId],
    );
    return rows.map((r) => r.username);
  };

  it('notifies somebody named by typing alone', async () => {
    const event = await eventOf(alice, await movie('cm_typed'));
    const before = await mentionCount(dave);

    const posted = await typedOnly(bob, event, '@cm_dave thoughts?');

    assert.deepEqual(await mentionedOn(posted.comment_id), ['cm_dave']);
    assert.equal(await mentionCount(dave), before + 1);
  });

  it('ends the handle at the punctuation, and at the space', async () => {
    const event = await eventOf(alice, await movie('cm_typed_punct'));
    const posted = await typedOnly(bob, event, 'ask @cm_dave. and @cm_carol, both');
    assert.deepEqual(await mentionedOn(posted.comment_id), ['cm_carol', 'cm_dave']);
  });

  it('names one person once however many times the body says them', async () => {
    const event = await eventOf(alice, await movie('cm_typed_twice'));
    const before = await mentionCount(dave);

    const posted = await typedOnly(bob, event, '@cm_dave ... @cm_dave');

    assert.deepEqual(await mentionedOn(posted.comment_id), ['cm_dave']);
    assert.equal(await mentionCount(dave), before + 1, 'one comment, one notification');
  });

  it('matches whatever case the author typed', async () => {
    const event = await eventOf(alice, await movie('cm_typed_case'));
    const posted = await typedOnly(bob, event, 'hey @CM_Dave');
    assert.deepEqual(await mentionedOn(posted.comment_id), ['cm_dave']);
  });

  /**
   * The half that must stay lenient, and the reason the two sources are treated
   * differently at all. An id the client asserts is a control the author used, so an
   * ineligible one still refuses the whole call (the sections above). A handle in prose
   * is prose, and a comment *about* somebody's handle must not become unpostable.
   */
  it('is not a mention when nobody holds the name, and does not refuse the comment', async () => {
    const event = await eventOf(alice, await movie('cm_typed_nobody'));
    const posted = await typedOnly(bob, event, '@nobody_at_all thoughts?');
    assert.equal(posted.status, 'ok');
    assert.deepEqual(await mentionedOn(posted.comment_id), []);
  });

  /**
   * The case the founder actually reported, end to end and with nothing tapped: a handle
   * you know is real because you looked it up, belonging to somebody you do not follow.
   * Before `20260909000100` this was silently inert.
   */
  it('notifies somebody the author has no relationship with at all', async () => {
    const event = await eventOf(alice, await movie('cm_typed_stranger'));
    const before = await mentionCount(erin);

    const posted = await typedOnly(bob, event, '@cm_erin thoughts?');

    assert.equal(posted.status, 'ok');
    assert.deepEqual(await mentionedOn(posted.comment_id), ['cm_erin']);
    assert.equal(await mentionCount(erin), before + 1);
  });

  /** Discoverable, not merely public. A private account is findable and so is nameable. */
  it('notifies a private account that can see the activity', async () => {
    const event = await eventOf(alice, await movie('cm_typed_private'));
    const before = await mentionCount(frank);

    const posted = await typedOnly(bob, event, '@cm_frank thoughts?');

    assert.deepEqual(await mentionedOn(posted.comment_id), ['cm_frank']);
    assert.equal(await mentionCount(frank), before + 1);
  });

  it('does not mention somebody blocked in either direction', async () => {
    const event = await eventOf(alice, await movie('cm_typed_block'));
    const before = await mentionCount(dave);

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [dave, bob]);

    const posted = await typedOnly(bob, event, '@cm_dave thoughts?');
    assert.deepEqual(await mentionedOn(posted.comment_id), []);
    assert.equal(await mentionCount(dave), before);

    await t.sql(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [dave, bob]);
    await follow(bob, dave);
  });

  it('does not mention a suspended account', async () => {
    const event = await eventOf(alice, await movie('cm_typed_suspended'));
    const before = await mentionCount(dave);

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [dave]);
    const posted = await typedOnly(bob, event, '@cm_dave thoughts?');
    await t.sql(`update profiles set status = 'active' where id = $1`, [dave]);

    assert.deepEqual(await mentionedOn(posted.comment_id), []);
    assert.equal(await mentionCount(dave), before);
  });

  /**
   * The condition about the *mentioned* party rather than the author, and the one it is
   * easiest to leave out of a new resolution path. Frank follows nobody, so a private
   * Alice is somebody he cannot see — and naming him would be a way to tell him what a
   * private account watched.
   */
  it('does not mention somebody who cannot see the activity', async () => {
    const event = await eventOf(alice, await movie('cm_typed_unseeable'));
    const before = await mentionCount(frank);

    await follow(bob, frank);
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [alice]);

    const posted = await typedOnly(bob, event, '@cm_frank thoughts?');

    await t.sql(`update profiles set visibility = 'public' where id = $1`, [alice]);
    await unfollow(bob, frank);

    assert.deepEqual(await mentionedOn(posted.comment_id), []);
    assert.equal(await mentionCount(frank), before);
  });

  it('never mentions the author themselves', async () => {
    const event = await eventOf(alice, await movie('cm_typed_self'));
    const before = await mentionCount(bob);

    const posted = await typedOnly(bob, event, 'as @cm_bob always says');

    assert.deepEqual(await mentionedOn(posted.comment_id), []);
    assert.equal(await mentionCount(bob), before);
  });

  /** An @ inside a word is not a mention, which is what keeps an email address out. */
  it('does not read a handle out of an email address', async () => {
    const event = await eventOf(alice, await movie('cm_typed_email'));
    const posted = await typedOnly(bob, event, 'write to me@cm_dave.example');
    assert.deepEqual(await mentionedOn(posted.comment_id), []);
  });

  it('does not read a name out of a longer run of handle characters', async () => {
    const event = await eventOf(alice, await movie('cm_typed_run'));
    const posted = await typedOnly(bob, event, '@cm_davetheseconds');
    assert.deepEqual(await mentionedOn(posted.comment_id), []);
  });

  // -------------------------------------------------------------------------
  /**
   * The edit matrix again, from the typed side.
   *
   * The ledger is what makes these hold and `20260908000100` does not touch it — but
   * what feeds the ledger has changed, and "the guarantee still holds because the code
   * under it is the same" is the reasoning this section exists to refuse.
   */
  it('tells a person added by a later edit, once', async () => {
    const event = await eventOf(alice, await movie('cm_typed_edit_add'));
    const before = await mentionCount(dave);
    const posted = await typedOnly(bob, event, 'good film');
    assert.equal(await mentionCount(dave), before, 'nobody named yet');

    await typedEdit(bob, posted.comment_id, 'good film @cm_dave');
    assert.equal(await mentionCount(dave), before + 1);
  });

  it('does not tell them again when a later edit leaves the name alone', async () => {
    const event = await eventOf(alice, await movie('cm_typed_edit_same'));
    const posted = await typedOnly(bob, event, '@cm_dave thoughts?');
    const after = await mentionCount(dave);

    await typedEdit(bob, posted.comment_id, '@cm_dave thoughts??');
    await typedEdit(bob, posted.comment_id, '@cm_dave thoughts???');

    assert.equal(await mentionCount(dave), after, 'repeated edits are not repeated pings');
  });

  it('says nothing when an edit removes the name, and nothing when it comes back', async () => {
    const event = await eventOf(alice, await movie('cm_typed_edit_remove'));
    const posted = await typedOnly(bob, event, '@cm_dave thoughts?');
    const after = await mentionCount(dave);

    await typedEdit(bob, posted.comment_id, 'thoughts?');
    assert.deepEqual(await mentionedOn(posted.comment_id), [], 'deleting the name removes it');
    assert.equal(await mentionCount(dave), after);

    await typedEdit(bob, posted.comment_id, '@cm_dave thoughts?');
    assert.deepEqual(await mentionedOn(posted.comment_id), ['cm_dave'], 'and re-adding restores it');
    assert.equal(await mentionCount(dave), after, 'but the stamp is spent for good');
  });

  /**
   * Handle recycling: the one hazard reading the body introduces, and the reason
   * resolution consults this comment's own frozen spelling *before* it consults the
   * username table.
   *
   * Somebody is named, renames, and a third party takes the name they left. An ordinary
   * typo fix on the unchanged body must go on meaning the person it always meant, and
   * must not hand the new holder of that handle a notification the author never wrote.
   * Fresh accounts, because this test permanently rearranges the two it uses.
   */
  it('keeps a renamed person, and does not hand their old name to whoever takes it', async () => {
    const renamer = await t.createUser({ username: 'cm_renamer' });
    await follow(bob, renamer);

    const event = await eventOf(alice, await movie('cm_typed_recycle'));
    const posted = await typedOnly(bob, event, 'ask @cm_renamer');
    assert.deepEqual(await mentionedOn(posted.comment_id), ['cm_renamer']);
    const renamerBefore = await mentionCount(renamer);

    await t.sql(`update profiles set username = 'cm_renamed' where id = $1`, [renamer]);
    const taker = await t.createUser({ username: 'cm_taker' });
    await follow(bob, taker);
    // The trigger from 20260813001500 reserves a released handle, so the impostor takes
    // it the only way anybody could: after the reservation is gone.
    await t.sql(`delete from username_history where username = 'cm_renamer'`);
    await t.sql(`update profiles set username = 'cm_renamer' where id = $1`, [taker]);
    const takerBefore = await mentionCount(taker);

    await typedEdit(bob, posted.comment_id, 'ask @cm_renamer please');

    assert.deepEqual(
      await mentionedOn(posted.comment_id),
      ['cm_renamed'],
      'the body still means the person it always meant',
    );
    assert.equal(await mentionCount(renamer), renamerBefore, 'and nobody is told twice');
    assert.equal(await mentionCount(taker), takerBefore, 'least of all the new holder');
  });
});

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
