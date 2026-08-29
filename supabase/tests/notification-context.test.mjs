import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * What an inbox row is allowed to say — `20260830000100`.
 *
 * The founder's report was that "Ravi commented on your activity" does not tell you
 * enough to decide whether to open it, and his constraint in the same breath was that
 * the preview must never carry a spoiler or a retracted remark.
 *
 * Those two pull in opposite directions, and every test here is about the line between
 * them. **The withholding is the server's**, deliberately and unlike every other spoiler
 * decision in this app: `shouldMask` is viewer-relative and lives on the client because
 * a masked body is readable by exactly the accounts an unmasked one is. The inbox is the
 * exception — the reader did not ask to look, the row appears unbidden, and the same
 * string goes to a lock screen. So the client is never handed the text it must not draw,
 * and these tests assert that at the boundary.
 *
 * The second half of the file is the watched-with row's new fact: whether the reader has
 * already ranked the title, which is the whole state the Rank action needs.
 */

let t;
let alice; // the actor: her ranking is the activity
let bob; // the commenter
let seq = 93000;

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

const follow = (a, b) =>
  t.sql(
    `insert into follows (follower_id, followee_id, state)
     values ($1, $2, 'approved') on conflict do nothing`,
    [a, b],
  );

const comment = async (who, event, body, { spoilers = false, mentions = [] } = {}) => {
  await t.actAs(who);
  const { rows } = await t.sql(
    `select add_comment(gen_random_uuid(), $1, $2, $3, null, $4::uuid[]) as r`,
    [event, body, spoilers, mentions],
  );
  return rows[0].r;
};

/** The inbox as `who` reads it, newest first. */
const inbox = async (who) => {
  await t.actAs(who);
  const { rows } = await t.sql(
    `select kind, comment_excerpt, comment_spoilers, viewer_ranked, media_item_id
       from my_notifications(50)`,
  );
  return rows;
};

const newest = async (who, kind) => (await inbox(who)).find((r) => r.kind === kind);

before(async () => {
  t = await createTestDb();

  alice = await t.createUser({ username: 'nc_alice' });
  bob = await t.createUser({ username: 'nc_bob' });

  await follow(alice, bob);
  await follow(bob, alice);
});

after(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
describe('the preview', () => {
  it('carries one line of an ordinary comment', async () => {
    const event = await eventOf(alice, await movie('nc_plain'));
    await comment(bob, event, 'Pretty good');

    const row = await newest(alice, 'comment');
    assert.equal(row.comment_excerpt, 'Pretty good');
    assert.equal(row.comment_spoilers, false);
  });

  it('carries one for a mention too', async () => {
    const event = await eventOf(alice, await movie('nc_mention'));
    await comment(bob, event, 'thoughts @nc_alice?', { mentions: [alice] });

    const row = await newest(alice, 'mention');
    assert.equal(row.comment_excerpt, 'thoughts @nc_alice?');
  });

  /**
   * The bound is the server's, not the renderer's. 140 characters is more than one line
   * of a phone-width row; what it buys is that a thousand-character comment does not
   * cross the wire to be truncated by a `numberOfLines` that a modified client can lift.
   */
  it('bounds what crosses the wire', async () => {
    const event = await eventOf(alice, await movie('nc_long'));
    const long = 'x'.repeat(900);
    await comment(bob, event, long);

    const row = await newest(alice, 'comment');
    assert.equal(row.comment_excerpt.length, 140);
  });

  /**
   * The founder's rule, and the one place in this app where a spoiler claim is enforced
   * rather than rendered around. The row still says *something* — `comment_spoilers`
   * true — because a second line that is simply absent reads as a bug, and "Contains
   * spoilers" is a useful thing to know before opening.
   */
  it('withholds a spoiler-marked comment and says why', async () => {
    const event = await eventOf(alice, await movie('nc_spoiler'));
    await comment(bob, event, 'the twist is that he was dead the whole time', { spoilers: true });

    const row = await newest(alice, 'comment');
    assert.equal(row.comment_excerpt, null, 'the text never leaves the database');
    assert.equal(row.comment_spoilers, true);
  });

  it('withholds a spoiler-marked mention the same way', async () => {
    const event = await eventOf(alice, await movie('nc_spoiler_mention'));
    await comment(bob, event, '@nc_alice the ending is', { spoilers: true, mentions: [alice] });

    const row = await newest(alice, 'mention');
    assert.equal(row.comment_excerpt, null);
    assert.equal(row.comment_spoilers, true);
  });

  /**
   * A comment its author retracted after the notification was filed. The row itself is
   * swept by `delete_comment`, so this reaches the case through a tombstone — a
   * top-level comment with a reply under it, which survives as a row and must still
   * report nothing.
   */
  it('reports nothing for a retracted comment, and does not fail', async () => {
    const event = await eventOf(alice, await movie('nc_deleted'));
    const root = await comment(bob, event, 'a remark that will be withdrawn');
    // A reply keeps the root standing as a tombstone.
    await t.actAs(alice);
    await t.sql(`select add_comment(gen_random_uuid(), $1, 'answering', false, $2)`, [
      event,
      root.comment_id,
    ]);

    await t.actAs(bob);
    await t.sql(`select delete_comment(gen_random_uuid(), $1)`, [root.comment_id]);

    // Alice's own notification for the root is gone with it; the reply's is not, and
    // reads normally. What matters is that nothing raises and no retracted text appears.
    const rows = await inbox(alice);
    assert.ok(!rows.some((r) => r.comment_excerpt?.includes('withdrawn')));
  });

  it('has no excerpt on a kind that is not a comment', async () => {
    const event = await eventOf(alice, await movie('nc_reaction'));
    await t.actAs(bob);
    await t.sql(`select set_reaction(gen_random_uuid(), $1, 'love')`, [event]);

    const row = await newest(alice, 'reaction');
    assert.equal(row.comment_excerpt, null);
    assert.equal(row.comment_spoilers, false, 'false rather than null, so the client has one shape');
  });

  /**
   * A mention lands on somebody else's post by construction, so the join that resolves
   * the title cannot be restricted to the reader's own events — which is exactly what it
   * was before this migration, and would have left every mention row titleless.
   */
  it('resolves the title of a mention on a third party’s activity', async () => {
    const carol = await t.createUser({ username: 'nc_carol' });
    await follow(bob, carol);
    await follow(carol, bob);

    const mediaId = await movie('nc_thirdparty');
    const event = await eventOf(alice, mediaId);
    await comment(bob, event, 'look at this @nc_carol', { mentions: [carol] });

    const row = await newest(carol, 'mention');
    assert.equal(row.media_item_id, mediaId);
  });
});

// ---------------------------------------------------------------------------
describe('the watched-with row', () => {
  const logWatch = (id) => t.sql(`select log_watched(gen_random_uuid(), $1, null, null)`, [id]);

  const rank = (who, mediaItemId, position) =>
    t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', $3)`,
      [who, mediaItemId, position],
    );

  it('says the reader has not ranked the title', async () => {
    const mediaId = await movie('nc_tag_unranked');
    await t.actAs(alice);
    await logWatch(mediaId);
    await t.sql(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [mediaId, [bob]]);

    const row = await newest(bob, 'watch_tag');
    assert.equal(row.media_item_id, mediaId);
    assert.equal(row.viewer_ranked, false, 'so the row may offer Rank');
  });

  /**
   * The CTA has to disappear on its own. There is no write that clears it and no state
   * held on the row — the answer is resolved in the read that draws it, so the next
   * refetch after the reader ranks the title is the last one that offers Rank.
   */
  it('goes true once the reader ranks it, with no other write', async () => {
    const mediaId = await movie('nc_tag_ranked');
    await t.actAs(alice);
    await logWatch(mediaId);
    await t.sql(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [mediaId, [bob]]);

    assert.equal((await newest(bob, 'watch_tag')).viewer_ranked, false);

    await rank(bob, mediaId, 900);

    assert.equal((await newest(bob, 'watch_tag')).viewer_ranked, true);
  });

  it('is false on every other kind', async () => {
    const event = await eventOf(alice, await movie('nc_tag_other'));
    await comment(bob, event, 'not a tag');

    assert.equal((await newest(alice, 'comment')).viewer_ranked, false);
  });

  /**
   * The exactly-once rule `20260816000700` established, restated here because this
   * tranche is what makes the row visible enough for anybody to notice it firing twice.
   * Autosave, an edited log, a companion added later and a companion removed and put
   * back are all one save of a set as far as `set_watch_tags` is concerned.
   */
  it('files one notice per companion however often the log is saved', async () => {
    const carol = await t.createUser({ username: 'nc_carol2' });
    await follow(alice, carol);
    await follow(carol, alice);

    const mediaId = await movie('nc_tag_once');
    await t.actAs(alice);
    await logWatch(mediaId);

    const count = async (who) => {
      const { rows } = await t.sql(
        `select count(*)::int as n from notifications
          where recipient_id = $1 and type = 'watch_tag' and subject_id = $2`,
        [who, mediaId],
      );
      return rows[0].n;
    };

    // The initial companion, saved four times — an autosave storm.
    for (let i = 0; i < 4; i += 1) {
      await t.actAs(alice);
      await t.sql(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [mediaId, [bob]]);
    }
    assert.equal(await count(bob), 1, 'repeated saves of the same list');

    // A second companion added later: only the new one is told.
    await t.actAs(alice);
    await t.sql(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [
      mediaId,
      [bob, carol],
    ]);
    assert.equal(await count(bob), 1, 'the existing companion is not re-notified');
    assert.equal(await count(carol), 1, 'the new one is told, once');

    // Removed and put back — the farming case.
    await t.actAs(alice);
    await t.sql(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [mediaId, [carol]]);
    await t.actAs(alice);
    await t.sql(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [
      mediaId,
      [bob, carol],
    ]);
    assert.equal(await count(bob), 1, 'a re-tag is not a second notice, ever');
  });

  /**
   * Still stricter than a mention, and deliberately: naming somebody in "Who I watched
   * with" is a claim about their evening, so it takes an approved mutual follow. One
   * direction is not enough, which is what separates this rule from `_can_mention`.
   */
  it('refuses a one-way follow', async () => {
    const dan = await t.createUser({ username: 'nc_dan' });
    await follow(dan, alice); // dan follows alice; alice does not follow back

    const mediaId = await movie('nc_tag_oneway');
    await t.actAs(alice);
    await logWatch(mediaId);

    const error = await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [
      mediaId,
      [dan],
    ]);
    assert.equal(error.code, '42501');
  });
});

// ---------------------------------------------------------------------------
describe('the push queue', () => {
  /**
   * The founder's instruction for the mention push, and the one place this tranche
   * deliberately diverges from the comment push shipped by `20260827000300`: a mention
   * reaches somebody who has not asked to be in the conversation, so the lock screen
   * says who and where and never what.
   */
  it('never carries the comment text for a mention', async () => {
    const event = await eventOf(alice, await movie('nc_push_mention'));
    await t.sql(
      `insert into device_tokens (user_id, token, platform) values ($1, $2, 'ios')
       on conflict (token) do nothing`,
      [alice, `nc-token-${seq}`],
    );
    await comment(bob, event, 'you should see this @nc_alice', { mentions: [alice] });

    const { rows } = await t.sql(`select claim_push_batch(50) as jobs`);
    const jobs = rows[0].jobs.filter((j) => j.type === 'mention');
    assert.ok(jobs.length >= 1, 'a mention is push-eligible');
    for (const job of jobs) {
      assert.equal(job.comment_excerpt, null);
      assert.ok(job.feed_event_id, 'but it does carry the conversation, so a tap lands');
    }
  });
});

// ---------------------------------------------------------------------------
/**
 * Independent review 68 — what a mention row is still allowed to say *later*.
 *
 * A mention lands on somebody else's activity, so the row's title comes from an event
 * whose owner is a **third party** to the notification: the actor is the commenter. That
 * is why neither of the two filters already on this read covers them — the outer
 * `can_discover_profile` is about the actor, and `block()` deletes rows between the pair
 * it names rather than rows *about* them.
 *
 * `_can_mention` established that the recipient could see the activity when the mention
 * was written. It says nothing about afterwards, and these are the two afterwards.
 */
describe('a mention row after the activity stops being visible', () => {
  const scene = async (title) => {
    const carol = await t.createUser({ username: `nc_${title}` });
    await follow(bob, carol);
    await follow(carol, bob);

    const mediaId = await movie(title);
    const event = await eventOf(alice, mediaId);
    await comment(bob, event, `look at this @${`nc_${title}`}`, { mentions: [carol] });
    return { carol, mediaId };
  };

  it('keeps the title while the activity is still visible (control)', async () => {
    const { carol, mediaId } = await scene('vis_control');
    assert.equal((await newest(carol, 'mention')).media_item_id, mediaId);
  });

  it('drops the title once the activity’s owner goes private', async () => {
    const { carol } = await scene('vis_private');
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [alice]);

    const row = await newest(carol, 'mention');
    assert.equal(row.media_item_id, null, 'the row survives; the title it names does not');

    await t.sql(`update profiles set visibility = 'public' where id = $1`, [alice]);
  });

  it('drops the title once the activity’s owner blocks the reader', async () => {
    const { carol } = await scene('vis_block');
    await t.actAs(alice);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [alice, carol]);

    assert.equal((await newest(carol, 'mention')).media_item_id, null);

    await t.sql(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [alice, carol]);
  });

  /**
   * And the lock screen, which is the half that matters most: a push composed now and
   * delivered in a moment must not carry a title the recipient may no longer see.
   */
  it('does not push the title after the owner blocks the reader', async () => {
    const { carol } = await scene('vis_push');
    await t.sql(
      `insert into device_tokens (user_id, token, platform) values ($1, $2, 'ios')
       on conflict (token) do nothing`,
      [carol, `nc-block-token-${seq}`],
    );
    await t.actAs(alice);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [alice, carol]);

    const { rows } = await t.sql(`select claim_push_batch(50) as jobs`);
    for (const job of rows[0].jobs.filter((j) => j.type === 'mention')) {
      assert.equal(job.media_title, null, 'no title for an activity the reader lost');
    }

    await t.sql(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [alice, carol]);
  });
});
