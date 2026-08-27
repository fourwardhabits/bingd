import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Threads, replies, likes and deletion — `20260826000600`.
 *
 * `comments.test.mjs` still owns everything `20260817000100` established: the P0002 that
 * is the same for every unresolvable id, the two read predicates, the per-day ceiling.
 * This file owns the four things that migration added, and it is organised around the
 * ways each of them could be got wrong rather than around the functions:
 *
 *   1. **Depth.** A reply to a reply must join the thread it was aimed at, not start a
 *      second level. Asserted from the writer's normalisation *and* from the trigger, so
 *      a future writer that forgets the first still cannot break the invariant.
 *   2. **Cross-post.** A parent on other activity must be refused, or a comment id
 *      learned in one thread could attach writing to another.
 *   3. **Deletion.** The founder's bug: "it disappears for me and other users still see
 *      it." The server half is that a retracted comment's *text* stops existing, tombstone
 *      or not — so no cache, no read path and no client version can show it.
 *   4. **Likes.** Idempotent, refused on anything the caller cannot see, and never on a
 *      comment that has been retracted.
 *
 * Alice is the actor whose activity is commented on; Bob and Carol are commenters; Dave
 * is a stranger who follows nobody, and is how every visibility assertion is made from
 * the outside.
 */

let t;
let alice;
let bob;
let carol;
let dave;
let seq = 61000;

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

/** Posts as `who`, and returns the parsed result of `add_comment`. */
const comment = async (who, event, body, { parent = null, spoilers = false } = {}) => {
  await t.actAs(who);
  const { rows } = await t.sql(
    `select add_comment(gen_random_uuid(), $1, $2, $3, $4) as r`,
    [event, body, spoilers, parent],
  );
  return rows[0].r;
};

const remove = async (who, commentId) => {
  await t.actAs(who);
  const { rows } = await t.sql(`select delete_comment(gen_random_uuid(), $1) as r`, [commentId]);
  return rows[0].r;
};

/**
 * The like, through the **boolean** signature — which is now the compatibility one.
 *
 * 20260827000500 gave comments the six meanings and added a `text` overload beside this.
 * PostgREST tells the two apart by argument *name* (`p_on` versus `p_kind`), so the
 * client path is never ambiguous — but raw SQL with an untyped `$2` resolves to `text`
 * and would pass the string 'true'. The cast is what keeps these tests exercising the
 * signature they are about: every phone published before that migration calls this one,
 * and it has to keep working until the last of them has relaunched.
 *
 * The canonical `text` path has its own file, `comment-reactions.test.mjs`.
 */
const like = async (who, commentId, on) => {
  await t.actAs(who);
  const { rows } = await t.sql(
    `select set_comment_reaction(gen_random_uuid(), $1, $2::boolean) as r`,
    [commentId, on],
  );
  return rows[0].r;
};

/** The thread as `who` sees it, through the canonical read. */
const thread = async (who, event) => {
  await t.actAs(who);
  const { rows } = await t.sql(
    `select id, parent_id, username, body, deleted_at, reaction_count, reacted_by_me
       from activity_comments($1)`,
    [event],
  );
  return rows;
};

const errorFrom = async (who, query, params) => {
  await t.actAs(who);
  return t.errorFrom(query, params);
};

before(async () => {
  t = await createTestDb();

  alice = await t.createUser({ username: 'ct_alice' });
  bob = await t.createUser({ username: 'ct_bob' });
  carol = await t.createUser({ username: 'ct_carol' });
  dave = await t.createUser({ username: 'ct_dave' });

  // Everybody but Dave can see everybody else. Alice is public, so this is really only
  // establishing that Bob and Carol are mutually visible for the author predicate.
  for (const a of [bob, carol]) {
    await follow(a, alice);
    await follow(alice, a);
  }
  await follow(bob, carol);
  await follow(carol, bob);
});

after(async () => {
  await t.close();
});

describe('one level, whatever the client aims at', () => {
  it('stores a reply against the comment it answers', async () => {
    const event = await eventOf(alice, await movie('ct_reply'));
    const top = await comment(bob, event, 'the top-level remark');
    const reply = await comment(carol, event, 'answering it', { parent: top.comment_id });

    assert.equal(reply.status, 'ok');
    assert.equal(reply.parent_id, top.comment_id);
  });

  /**
   * The founder's rule, and the reason the client never has to think about it: tapping
   * Reply on a reply is an ordinary thing to do, and the result must join that
   * conversation rather than indent a third time.
   */
  it('re-points a reply-to-a-reply at the root of the same thread', async () => {
    const event = await eventOf(alice, await movie('ct_deep'));
    const top = await comment(bob, event, 'root');
    const first = await comment(carol, event, 'first reply', { parent: top.comment_id });
    const second = await comment(bob, event, 'reply to the reply', { parent: first.comment_id });

    assert.equal(second.parent_id, top.comment_id, 'a second level must not be created');

    const rows = await thread(alice, event);
    assert.deepEqual(
      rows.map((r) => r.parent_id),
      [null, top.comment_id, top.comment_id],
      'roots first, then their replies, and no row points at a reply',
    );
  });

  /**
   * The writer normalises, so the trigger should never fire from the app. It is asserted
   * directly because that is the whole reason it exists: the invariant has to survive a
   * writer that forgets, and a rule nothing exercises is a rule nobody knows is there.
   */
  it('refuses a second level at the table, not merely in the writer', async () => {
    const event = await eventOf(alice, await movie('ct_trigger'));
    const top = await comment(bob, event, 'root');
    const reply = await comment(carol, event, 'reply', { parent: top.comment_id });

    const error = await errorFrom(
      bob,
      `insert into comments (feed_event_id, author_id, body, parent_id)
       values ($1, $2, 'smuggled', $3)`,
      [event, bob, reply.comment_id],
    );
    assert.ok(error, 'a direct insert must not be able to build a second level');
    assert.match(error.message, /one level deep/);
  });

  it('refuses a comment that is its own parent', async () => {
    const event = await eventOf(alice, await movie('ct_self'));
    const top = await comment(bob, event, 'root');

    const error = await errorFrom(bob, `update comments set parent_id = id where id = $1`, [
      top.comment_id,
    ]);
    assert.ok(error);
    assert.match(error.message, /reply to itself/);
  });
});

describe('a parent from another conversation', () => {
  /**
   * An id travels — a screenshot, a crash report, another user's copy of a row. Holding
   * one must buy nothing, which is `20260817000100`'s rule; this is that rule applied to
   * the one new thing an id can now be used for.
   */
  it('refuses a parent belonging to different activity, as the same P0002', async () => {
    const here = await eventOf(alice, await movie('ct_here'));
    const elsewhere = await eventOf(alice, await movie('ct_elsewhere'));
    const foreign = await comment(bob, elsewhere, 'on the other post');

    await t.actAs(carol);
    const error = await t.errorFrom(
      `select add_comment(gen_random_uuid(), $1, 'spoofed', false, $2)`,
      [here, foreign.comment_id],
    );

    assert.ok(error);
    assert.equal(error.code, 'P0002');
    // The same words a genuinely missing comment gets, so the caller cannot tell the
    // two apart and the id confirms nothing.
    assert.match(error.message, /no such comment/);
  });

  it('refuses a parent that does not exist at all, identically', async () => {
    const event = await eventOf(alice, await movie('ct_ghost'));
    await t.actAs(bob);
    const error = await t.errorFrom(
      `select add_comment(gen_random_uuid(), $1, 'to nobody', false, gen_random_uuid())`,
      [event],
    );
    assert.ok(error);
    assert.equal(error.code, 'P0002');
    assert.match(error.message, /no such comment/);
  });
});

describe('being told about a reply', () => {
  it('tells the person whose comment was answered', async () => {
    const event = await eventOf(alice, await movie('ct_notify'));
    const top = await comment(bob, event, 'bob says something');
    await comment(carol, event, 'carol answers bob', { parent: top.comment_id });

    // Scoped to this event: every test in this file writes inbox rows, and a query that
    // only filters on the actor counts the whole suite.
    const { rows } = await t.sql(
      `select recipient_id, payload ->> 'reply_to' as reply_to
         from notifications
        where type = 'comment' and actor_id = $1 and subject_id = $2`,
      [carol, event],
    );
    assert.equal(rows.length, 2, 'the activity owner and the person replied to');
    assert.deepEqual(
      rows.map((r) => r.recipient_id).sort(),
      [alice, bob].sort(),
    );
    assert.ok(rows.some((r) => r.reply_to === top.comment_id));
  });

  /**
   * The ordinary case: somebody replying under a remark on their own ranking. Alice is
   * both the activity's actor and the author being answered, and one event should ring
   * once.
   */
  it('does not tell one person twice when they are both the actor and the author', async () => {
    const event = await eventOf(alice, await movie('ct_once'));
    const hers = await comment(alice, event, 'alice comments on her own activity');
    await comment(bob, event, 'bob answers alice', { parent: hers.comment_id });

    const { rows } = await t.sql(
      `select count(*)::int as n from notifications
        where type = 'comment' and actor_id = $1 and recipient_id = $2 and subject_id = $3`,
      [bob, alice, event],
    );
    assert.equal(rows[0].n, 1);
  });

  it('never tells you about your own reply to yourself', async () => {
    const event = await eventOf(alice, await movie('ct_selfreply'));
    const hers = await comment(alice, event, 'root');
    await comment(alice, event, 'and another thought', { parent: hers.comment_id });

    const { rows } = await t.sql(
      `select count(*)::int as n from notifications
        where type = 'comment' and recipient_id = $1 and actor_id = $1 and subject_id = $2`,
      [alice, event],
    );
    assert.equal(rows[0].n, 0);
  });
});

describe('deleting, which is the bug this migration is named for', () => {
  it('removes a comment nobody replied to, outright', async () => {
    const event = await eventOf(alice, await movie('ct_del_plain'));
    const one = await comment(bob, event, 'nothing hangs off this');

    assert.equal((await remove(bob, one.comment_id)).outcome, 'removed');

    const { rows } = await t.sql(`select count(*)::int as n from comments where id = $1`, [
      one.comment_id,
    ]);
    assert.equal(rows[0].n, 0);
  });

  /**
   * The founder's option A. Cascading would delete Carol's writing because Bob changed
   * his mind about his own, which is the more surprising of the two behaviours.
   */
  it('tombstones a comment with replies, and keeps the replies', async () => {
    const event = await eventOf(alice, await movie('ct_del_thread'));
    const top = await comment(bob, event, 'bob will retract this');
    const reply = await comment(carol, event, "carol's reply survives", {
      parent: top.comment_id,
    });

    assert.equal((await remove(bob, top.comment_id)).outcome, 'tombstoned');

    const rows = await thread(alice, event);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, top.comment_id);
    assert.ok(rows[0].deleted_at, 'the root is marked retracted');
    assert.equal(rows[0].body, null, 'and carries no text');
    assert.equal(rows[1].id, reply.comment_id);
    assert.equal(rows[1].body, "carol's reply survives");
  });

  /**
   * **The half that makes the cross-user report impossible rather than merely fixed.**
   *
   * A stale cache on somebody else's phone is a client problem and is fixed on the
   * client. This is the server's guarantee underneath it: after a delete there is no
   * row anywhere in this database still holding the words, so no cache that outlives the
   * write, no read path anybody adds later, and no older client version can produce
   * them.
   */
  it('stops storing the text at all, tombstone or not', async () => {
    const event = await eventOf(alice, await movie('ct_del_text'));
    const top = await comment(bob, event, 'something regrettable');
    await comment(carol, event, 'a reply that forces a tombstone', { parent: top.comment_id });

    await remove(bob, top.comment_id);

    // Read as the owner, past every policy and every function.
    const { rows } = await t.sql(
      `select count(*)::int as n from comments where body like '%regrettable%'`,
    );
    assert.equal(rows[0].n, 0, 'the retracted words must not exist anywhere');

    const { rows: stored } = await t.sql(
      `select has_spoilers, edited_at from comments where id = $1`,
      [top.comment_id],
    );
    assert.equal(stored[0].has_spoilers, false, 'a claim about text that no longer exists');
    assert.equal(stored[0].edited_at, null, 'a tombstone must not read as "edited"');
  });

  it('shows a second reader no trace of the text either', async () => {
    const event = await eventOf(alice, await movie('ct_del_second'));
    const top = await comment(bob, event, 'visible to carol until it is not');
    await comment(carol, event, 'holding the thread open', { parent: top.comment_id });

    assert.deepEqual(
      (await thread(carol, event)).map((r) => r.body),
      ['visible to carol until it is not', 'holding the thread open'],
    );

    await remove(bob, top.comment_id);

    assert.deepEqual(
      (await thread(carol, event)).map((r) => r.body),
      [null, 'holding the thread open'],
    );
  });

  it('takes the tombstone away with the last reply under it', async () => {
    const event = await eventOf(alice, await movie('ct_del_last'));
    const top = await comment(bob, event, 'root');
    const reply = await comment(carol, event, 'the only reply', { parent: top.comment_id });

    await remove(bob, top.comment_id);
    await remove(carol, reply.comment_id);

    const { rows } = await t.sql(
      `select count(*)::int as n from comments where feed_event_id = $1`,
      [event],
    );
    assert.equal(rows[0].n, 0, '"Comment deleted" alone with nothing under it is an artefact');
  });

  it('refuses to delete the same comment twice, as the same P0002', async () => {
    const event = await eventOf(alice, await movie('ct_del_twice'));
    const top = await comment(bob, event, 'root');
    await comment(carol, event, 'reply', { parent: top.comment_id });
    await remove(bob, top.comment_id);

    await t.actAs(bob);
    const error = await t.errorFrom(`select delete_comment(gen_random_uuid(), $1)`, [
      top.comment_id,
    ]);
    assert.ok(error);
    assert.equal(error.code, 'P0002');
  });

  it('refuses to put text back into a tombstone', async () => {
    const event = await eventOf(alice, await movie('ct_del_edit'));
    const top = await comment(bob, event, 'root');
    await comment(carol, event, 'reply', { parent: top.comment_id });
    await remove(bob, top.comment_id);

    await t.actAs(bob);
    const error = await t.errorFrom(
      `select edit_comment(gen_random_uuid(), $1, 'undeleting myself', false)`,
      [top.comment_id],
    );
    assert.ok(error, 'an edit that succeeded here would resurrect retracted writing');
    assert.equal(error.code, 'P0002');
  });

  it('does not count a tombstone on the feed', async () => {
    const event = await eventOf(alice, await movie('ct_del_count'));
    const top = await comment(bob, event, 'root');
    await comment(carol, event, 'reply', { parent: top.comment_id });

    await t.actAs(alice);
    let { rows } = await t.sql(`select comment_count from activity_comment_counts($1)`, [[event]]);
    assert.equal(rows[0].comment_count, 2);

    await remove(bob, top.comment_id);

    await t.actAs(alice);
    ({ rows } = await t.sql(`select comment_count from activity_comment_counts($1)`, [[event]]));
    // The numeral promises something to read, and a spacer is not something to read.
    assert.equal(rows[0].comment_count, 1);
  });
});

describe('liking a comment', () => {
  it('is one row however many times it is set', async () => {
    const event = await eventOf(alice, await movie('ct_like'));
    const one = await comment(bob, event, 'likeable');

    assert.equal((await like(alice, one.comment_id, true)).on, true);
    // A fresh operation id, which is what a client that lost its reply and retried
    // sends. The ledger cannot help here, and the primary key and `p_on` both must.
    assert.equal((await like(alice, one.comment_id, true)).on, true);

    const rows = await thread(alice, event);
    assert.equal(rows[0].reaction_count, 1);
    assert.equal(rows[0].reacted_by_me, true);
  });

  it('clears when asked for the cleared state, and stays cleared', async () => {
    const event = await eventOf(alice, await movie('ct_unlike'));
    const one = await comment(bob, event, 'likeable');

    await like(alice, one.comment_id, true);
    await like(alice, one.comment_id, false);
    await like(alice, one.comment_id, false);

    const rows = await thread(alice, event);
    assert.equal(rows[0].reaction_count, 0);
    assert.equal(rows[0].reacted_by_me, false);
  });

  it('counts other people without claiming them as yours', async () => {
    const event = await eventOf(alice, await movie('ct_like_others'));
    const one = await comment(bob, event, 'likeable');

    await like(alice, one.comment_id, true);
    await like(carol, one.comment_id, true);

    const asBob = await thread(bob, event);
    assert.equal(asBob[0].reaction_count, 2);
    assert.equal(asBob[0].reacted_by_me, false);
  });

  it('refuses a retracted comment', async () => {
    const event = await eventOf(alice, await movie('ct_like_dead'));
    const top = await comment(bob, event, 'root');
    await comment(carol, event, 'reply', { parent: top.comment_id });
    await remove(bob, top.comment_id);

    await t.actAs(alice);
    const error = await t.errorFrom(`select set_comment_reaction(gen_random_uuid(), $1, true)`, [
      top.comment_id,
    ]);
    assert.ok(error);
    assert.equal(error.code, 'P0002');
  });

  /**
   * Independent review 43, as a Major: the policy admitted a like on the strength of the
   * *comment* alone, so a blocked account's `user_id` was selectable by anybody who could
   * read the comment they liked. `reactions_read` has required both predicates since
   * 20260816000200 and this one now does too.
   */
  it('hides a blocked account’s like from a direct read', async () => {
    const event = await eventOf(alice, await movie('ct_like_blocked'));
    const one = await comment(bob, event, 'likeable by everybody');

    await like(carol, one.comment_id, true);

    // Dave can read Alice's activity and Bob's comment, and has blocked Carol.
    await t.actAs(dave);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`, [
      dave,
      carol,
    ]);

    const rows = await t.asUser(dave, async () => {
      const { rows } = await t.sql(
        `select user_id from comment_reactions where comment_id = $1`,
        [one.comment_id],
      );
      return rows;
    });
    assert.deepEqual(rows, [], 'a comment being readable says nothing about who liked it');
  });

  it('does not count a blocked account’s like in the number shown', async () => {
    const event = await eventOf(alice, await movie('ct_like_count_blocked'));
    const one = await comment(bob, event, 'likeable');

    await like(alice, one.comment_id, true);
    await like(carol, one.comment_id, true);

    await t.actAs(dave);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`, [
      dave,
      carol,
    ]);

    const rows = await thread(dave, event);
    // Two people liked it; Dave may see one of them. A number that counted the other
    // anonymously would tell him something the list deliberately does not.
    assert.equal(rows[0].reaction_count, 1);
  });

  it('refuses a comment on activity the caller cannot see', async () => {
    const hidden = await t.createUser({ username: 'ct_hidden', visibility: 'private' });
    const event = await eventOf(hidden, await movie('ct_like_private'));
    await t.actAs(hidden);
    const { rows } = await t.sql(
      `select add_comment(gen_random_uuid(), $1, 'private thoughts', false, null) as r`,
      [event],
    );
    const own = rows[0].r;

    await t.actAs(dave);
    const error = await t.errorFrom(`select set_comment_reaction(gen_random_uuid(), $1, true)`, [
      own.comment_id,
    ]);
    assert.ok(error, 'a comment id must not become a write handle on activity you cannot read');
    assert.equal(error.code, 'P0002');
  });
});

describe('who may read a thread', () => {
  it('returns nothing at all for activity the caller cannot see', async () => {
    const hidden = await t.createUser({ username: 'ct_shut', visibility: 'private' });
    const event = await eventOf(hidden, await movie('ct_read_private'));
    await t.actAs(hidden);
    await t.sql(`select add_comment(gen_random_uuid(), $1, 'not for dave', false, null)`, [event]);

    // Silence rather than a refusal: the same answer an activity with no comments gives,
    // so the emptiness discloses nothing about whether the activity exists.
    assert.deepEqual(await thread(dave, event), []);
  });

  it('omits a comment whose author the caller cannot see, rather than anonymising it', async () => {
    const event = await eventOf(alice, await movie('ct_read_blocked'));
    await comment(bob, event, "bob's remark");
    await comment(alice, event, "alice's remark");

    // Dave can see Alice (public) but has blocked Bob, so `can_view_profile` is false in
    // both directions and Bob's comment must be *absent* — which is what a block means.
    await t.actAs(dave);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [dave, bob]);

    const rows = await thread(dave, event);
    assert.deepEqual(rows.map((r) => r.username), ['ct_alice']);
  });

  /**
   * Independent review 43, as a Minor.
   *
   * `delete_comment` runs as the owner and counts *every* reply, deliberately: a reply
   * the deleting author cannot see is still somebody else's writing and must not be
   * destroyed. The cost is that the author is then left looking at a tombstone whose only
   * reply is invisible to them — a spacer holding nothing apart. The read is the only
   * place that can be right for both readers at once.
   */
  it('hides a tombstone whose only replies this reader cannot see', async () => {
    const event = await eventOf(alice, await movie('ct_orphan_tombstone'));
    const root = await comment(alice, event, 'alice will retract this');
    await comment(bob, event, "bob's reply", { parent: root.comment_id });

    // Alice blocks Bob, then retracts her own root. The root is tombstoned rather than
    // removed, because Bob's reply is still there for everybody else.
    await t.actAs(alice);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [alice, bob]);
    assert.equal((await remove(alice, root.comment_id)).outcome, 'tombstoned');

    // Alice sees an empty conversation rather than "Comment deleted" over nothing.
    assert.deepEqual(await thread(alice, event), []);

    // And Carol, who has blocked nobody, still sees both the tombstone and the reply.
    const asCarol = await thread(carol, event);
    assert.equal(asCarol.length, 2);
    assert.ok(asCarol[0].deleted_at);
    assert.equal(asCarol[1].body, "bob's reply");
  });

  it('counts nothing for an event the caller cannot see', async () => {
    const hidden = await t.createUser({ username: 'ct_shut2', visibility: 'private' });
    const event = await eventOf(hidden, await movie('ct_count_private'));
    await t.actAs(hidden);
    await t.sql(`select add_comment(gen_random_uuid(), $1, 'hidden', false, null)`, [event]);

    await t.actAs(dave);
    const { rows } = await t.sql(`select * from activity_comment_counts($1)`, [[event]]);
    assert.deepEqual(rows, []);
  });
});
