import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The six-scenario mention smoke, run in sequence against the complete migration tree.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS HERE AND NOT AGAINST STAGING
 *
 * The founder asked for this list to be run as a staging smoke test. It is not, and the
 * reason is the repo's own written convention rather than a shortcut.
 *
 * STAGING (`fjxhcbowoxuzulwirzyr`) stands at 53 of 103+ migrations with the known
 * lock-table backlog. `release-lanes.md` records the repair as its own scheduled project,
 * and `series-watchlist-preflight.md` states the rule this file obeys: **do not push to
 * staging, and do not edit its migration-history table to fake the state.** A
 * `supabase db push` there would attempt the whole outstanding backlog, which would turn
 * one mention migration into the staging repair — the exact failure that document exists
 * to prevent. Production is not an option either: Apple is reviewing iOS 1.0 (7), and
 * comment and notification behaviour is not changing under a review.
 *
 * So this runs where that same document says validation actually happens: the harness
 * replays the **complete** migration tree, this one included, into an isolated
 * PostgreSQL. That is a full-schema environment at exactly the state production will be
 * in after the push.
 *
 * What it therefore does **not** prove is what only a deployed project can: PostgREST
 * argument resolution and the grants as they stand on a running database. Those are
 * `remote-smoke.mjs`'s job, and it needs a project this migration has actually reached.
 * That gap is real and is reported rather than papered over.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS ONE SEQUENCE RATHER THAN SIX CASES
 *
 * `comment-mentions.test.mjs` owns each rule in isolation and owns it better. This file
 * exists for the property isolation cannot show: that the six things the founder listed
 * hold **of one conversation, in order, against one set of accounts** — which is what a
 * person doing this by hand on a phone would be checking.
 */

let t;
let author;
let followed;
let stranger;
let discoverable;
let blocked;
let owner;
let seq = 96000;

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

/** Posts as `who`. `mentions` empty means "typed, nothing tapped". */
const post = async (who, event, body, { parent = null, mentions = [] } = {}) => {
  await t.actAs(who);
  const { rows } = await t.sql(
    `select add_comment(gen_random_uuid(), $1, $2, false, $3, $4::uuid[]) as r`,
    [event, body, parent, mentions],
  );
  return rows[0].r;
};

const notifications = async (who, event) => {
  const { rows } = await t.sql(
    `select type, count(*)::int as n from notifications
      where recipient_id = $1 and subject_id = $2 group by type order by type`,
    [who, event],
  );
  return rows;
};

/** What the composer would offer for this fragment, as this account. */
const offered = async (who, event, fragment) => {
  await t.actAs(who);
  const { rows } = await t.sql(`select username from mention_candidates($1, $2)`, [
    event,
    fragment,
  ]);
  return rows.map((r) => r.username).sort();
};

/** What the thread read hands the renderer for the newest comment. */
const namedOnNewest = async (reader, event) => {
  await t.actAs(reader);
  const { rows } = await t.sql(
    `select mentions from activity_comments($1) order by created_at desc limit 1`,
    [event],
  );
  return (rows[0].mentions ?? []).map((m) => m.username).sort();
};

before(async () => {
  t = await createTestDb();

  owner = await t.createUser({ username: 'sm_owner' });
  author = await t.createUser({ username: 'sm_author' });
  followed = await t.createUser({ username: 'sm_followed' });
  stranger = await t.createUser({ username: 'sm_stranger' });
  discoverable = await t.createUser({ username: 'sm_private', visibility: 'private' });
  blocked = await t.createUser({ username: 'sm_blocked' });

  await t.sql(
    `insert into follows (follower_id, followee_id, state)
     values ($1, $2, 'approved') on conflict do nothing`,
    [author, followed],
  );
  // The block that must survive every widening, made by the other party so it is the
  // direction `blocks_read` would hide from the author.
  await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [blocked, author]);
});

after(async () => {
  await t.close();
});

describe('mention smoke — the founder’s six, in order', () => {
  it('1. a typed exact handle, nothing tapped, reaches its person', async () => {
    const event = await eventOf(owner, await movie('Smoke One'));

    // No mention array at all: whatever this proves, it proves about the text.
    await t.actAs(author);
    const { rows } = await t.sql(
      `select add_comment(gen_random_uuid(), $1, '@sm_stranger thoughts?', false, null) as r`,
      [event],
    );
    assert.equal(rows[0].r.status, 'ok');

    assert.deepEqual(await namedOnNewest(owner, event), ['sm_stranger']);
    assert.deepEqual(await notifications(stranger, event), [{ type: 'mention', n: 1 }]);
  });

  it('2. an autocomplete-selected handle reaches its person, and the list agrees', async () => {
    const event = await eventOf(owner, await movie('Smoke Two'));

    // A bare @ offers the people the author is likely to mean, and not the user table.
    const bare = await offered(author, event, '');
    assert.ok(bare.includes('sm_followed'), 'a follow is offered unprompted');
    assert.ok(bare.includes('sm_owner'), 'so is the activity’s own actor');
    assert.ok(!bare.includes('sm_stranger'), 'a stranger is not');

    // Typing a name is how you say you meant somebody.
    assert.deepEqual(await offered(author, event, 'sm_stranger'), ['sm_stranger']);

    // And picking that row posts what the row said it would.
    await post(author, event, 'hello @sm_stranger', { mentions: [stranger] });
    assert.deepEqual(await namedOnNewest(owner, event), ['sm_stranger']);
  });

  it('3. the rendered mention carries the id and handle a tap needs', async () => {
    const event = await eventOf(owner, await movie('Smoke Three'));
    await post(author, event, 'ask @sm_followed.', { mentions: [followed] });

    await t.actAs(owner);
    const { rows } = await t.sql(
      `select mentions from activity_comments($1) order by created_at desc limit 1`,
      [event],
    );
    const [mention] = rows[0].mentions;

    assert.equal(mention.username, 'sm_followed', 'where the tap goes');
    assert.equal(mention.handle, 'sm_followed', 'what the body spells, so what lights up');
    assert.equal(mention.id, followed, 'and who it is, by id rather than by name');
  });

  it('4. a mentioned user receives exactly one notification, however often they are named', async () => {
    const event = await eventOf(owner, await movie('Smoke Four'));
    await post(author, event, '@sm_followed ... @sm_followed again', { mentions: [followed] });

    assert.deepEqual(await notifications(followed, event), [{ type: 'mention', n: 1 }]);

    // And an edit that leaves the name alone does not ring a second time.
    const { rows } = await t.sql(
      `select id from comments where feed_event_id = $1 order by created_at desc limit 1`,
      [event],
    );
    await t.actAs(author);
    await t.sql(`select edit_comment(gen_random_uuid(), $1, $2, false, $3::uuid[])`, [
      rows[0].id,
      '@sm_followed ... @sm_followed again, truly',
      [followed],
    ]);

    assert.deepEqual(await notifications(followed, event), [{ type: 'mention', n: 1 }]);
  });

  it('5. mention and reply collapse to one row for the same person', async () => {
    const event = await eventOf(owner, await movie('Smoke Five'));
    const parent = (await post(followed, event, 'the score is the film')).comment_id;

    // A reply that names the person being replied to: two reasons to notify, one row.
    await post(author, event, '@sm_followed exactly', { parent, mentions: [followed] });
    assert.deepEqual(await notifications(followed, event), [{ type: 'mention', n: 1 }]);

    // The activity's owner is a third party here and still hears about the remark.
    assert.deepEqual(await notifications(owner, event), [{ type: 'comment', n: 2 }]);
  });

  it('6. a blocked or unreachable account does not resolve, and does not break the comment', async () => {
    const event = await eventOf(owner, await movie('Smoke Six'));

    const posted = await post(author, event, 'hey @sm_blocked and @nobody_at_all');
    assert.equal(posted.status, 'ok', 'prose that names nobody is still postable');
    assert.deepEqual(await namedOnNewest(owner, event), []);
    assert.deepEqual(await notifications(blocked, event), []);
    assert.ok(!(await offered(author, event, 'sm_blocked')).includes('sm_blocked'));

    // Suspension, on an account that is otherwise perfectly nameable.
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [stranger]);
    const suspended = await post(author, event, 'hey @sm_stranger');
    await t.sql(`update profiles set status = 'active' where id = $1`, [stranger]);

    const { rows } = await t.sql(
      `select count(*)::int as n from comment_mentions where comment_id = $1`,
      [suspended.comment_id],
    );
    assert.equal(rows[0].n, 0, 'a suspended account is not nameable');
  });

  /**
   * The bound on the widening, and the one worth a founder reading it twice.
   *
   * A private account is *discoverable*, so it is nameable — on an activity it can see.
   * Make the activity's owner private and the same account can no longer see the post,
   * so naming them would be a way to tell them what a private account watched.
   */
  it('7. discoverable is not the same as told-anything', async () => {
    const open = await eventOf(owner, await movie('Smoke Seven'));
    await post(author, open, 'hello @sm_private', { mentions: [discoverable] });
    assert.deepEqual(await namedOnNewest(owner, open), ['sm_private']);
    assert.deepEqual(await notifications(discoverable, open), [{ type: 'mention', n: 1 }]);

    await t.sql(`update profiles set visibility = 'private' where id = $1`, [owner]);
    await t.sql(
      `insert into follows (follower_id, followee_id, state)
       values ($1, $2, 'approved') on conflict do nothing`,
      [author, owner],
    );
    const shut = await eventOf(owner, await movie('Smoke Seven B'));

    const before = (await notifications(discoverable, shut)).length;
    const posted = await post(author, shut, 'hello @sm_private');

    const { rows } = await t.sql(
      `select count(*)::int as n from comment_mentions where comment_id = $1`,
      [posted.comment_id],
    );
    assert.equal(rows[0].n, 0, 'they cannot see this post, so they cannot be named on it');
    assert.equal((await notifications(discoverable, shut)).length, before);

    await t.sql(`update profiles set visibility = 'public' where id = $1`, [owner]);
  });
});
