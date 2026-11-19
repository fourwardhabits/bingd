import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Reactions and comments on follow activity (Workstream C, 20261130000100).
 *
 * The founder's decisions, each pinned here against observables:
 *
 *   · followers can react and comment on a follow story, and its author is notified;
 *   · ONE engagement predicate gates writes, reads, counts, mentions and notifications;
 *   · Q1: a story freezes on its first reaction or comment; the next follow starts another;
 *   · Q2: being named grants nothing, and members are never notified for being members;
 *   · Q3: with no eligible member left, the story's conversation is hidden from everyone,
 *     the author included, the data is kept, and a re-follow restores it;
 *   · Heart Magnet ignores follow-story reactions;
 *   · ordinary posts are unchanged.
 */

let t;
let seq = 97000;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(() => {
  seq += 1;
});

const user = (name, visibility = 'public') =>
  t.createUser({ username: `fe_${name}_${(seq += 1)}`, visibility });
const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const as = async (who, query, params = []) => {
  await t.actAs(who);
  return t.asUser(who, () => t.sql(query, params));
};
const refusal = async (who, query, params = []) => {
  await t.actAs(who);
  return t.asUser(who, () => t.errorFrom(query, params));
};

const follow = async (a, b) => as(a, `select follow($1, $2)`, [await uuid(), b]);
const unfollow = async (a, b) => as(a, `select unfollow($1, $2)`, [await uuid(), b]);
const block = async (a, b) => as(a, `select block($1, $2)`, [await uuid(), b]);

const react = async (who, event, kind = 'love') =>
  as(who, `select set_reaction($1, $2, $3) as r`, [await uuid(), event, kind]);
const comment = async (who, event, body, mentions = []) =>
  (
    await as(who, `select add_comment($1, $2, $3, false, null, $4::uuid[]) as r`, [
      await uuid(),
      event,
      body,
      mentions,
    ])
  ).rows[0].r;

/** The newest follow story of an actor, read as the owner (no RLS). */
const latestStory = async (actor) =>
  (
    await t.sql(
      `select id from feed_events where actor_id = $1 and type = 'follow_added'
        order by causal_at desc, id desc limit 1`,
      [actor],
    )
  ).rows[0]?.id;
const storyCount = async (actor) =>
  Number(
    (await t.sql(`select count(*) from feed_events where actor_id = $1 and type = 'follow_added'`, [actor]))
      .rows[0].count,
  );
const members = async (event) =>
  (await t.sql(`select followed_id from feed_follow_targets where event_id = $1`, [event])).rows.map(
    (r) => r.followed_id,
  );
const notified = async (recipient, event, type) =>
  Number(
    (
      await t.sql(
        `select count(*) from notifications
          where recipient_id = $1 and subject_id = $2 and type = $3`,
        [recipient, event, type],
      )
    ).rows[0].count,
  );

/** What one reader can see of a story's conversation, through every read path. */
const view = async (who, event) => {
  const reactions = (await as(who, `select count(*)::int as n from reactions where feed_event_id = $1`, [event])).rows[0].n;
  const comments = (await as(who, `select count(*)::int as n from comments where feed_event_id = $1`, [event])).rows[0].n;
  const thread = (await as(who, `select count(*)::int as n from activity_comments($1)`, [event])).rows[0].n;
  const counted = (
    await as(who, `select coalesce(sum(comment_count), 0)::int as n from activity_comment_counts($1::uuid[])`, [
      [event],
    ])
  ).rows[0].n;
  return { reactions, comments, thread, counted };
};

/** Owner-side totals: what is stored, whoever can see it. */
const stored = async (event) => ({
  reactions: Number((await t.sql(`select count(*) from reactions where feed_event_id = $1`, [event])).rows[0].count),
  comments: Number((await t.sql(`select count(*) from comments where feed_event_id = $1`, [event])).rows[0].count),
});

/** Author A, a follower F who sees A's activity, and a story "A followed B". */
const scene = async () => {
  const a = await user('author');
  // Reaction notifications default off (20260819000300); this suite is about who is told,
  // so the author opts in through the real writer, as reactions.test.mjs does.
  await as(a, `select set_notification_preference('reactions', true)`);
  const b = await user('member');
  const f = await user('fan');
  await follow(f, a);
  await follow(a, b);
  const story = await latestStory(a);
  assert.ok(story, 'the follow posted a story');
  return { a, b, f, story };
};

describe('a follower engages with a follow story', () => {
  it('reacts and comments; the author is notified once per reactor; the member is not', async () => {
    const { a, b, f, story } = await scene();
    // B follows A too, so B would see A's activity: still never notified as a member.
    await follow(b, a);
    await react(f, story, 'love');
    await react(f, story, 'wow');
    const c = await comment(f, story, 'Good follow');
    assert.equal(c.status, 'ok');

    assert.equal(await notified(a, story, 'reaction'), 1, 'one reaction notification per reactor');
    assert.equal(await notified(a, story, 'comment'), 1);
    assert.equal(await notified(b, story, 'reaction'), 0, 'members are never notified as members');
    assert.equal(await notified(b, story, 'comment'), 0);

    assert.deepEqual(await view(f, story), { reactions: 1, comments: 1, thread: 1, counted: 1 });
    assert.deepEqual(await view(a, story), { reactions: 1, comments: 1, thread: 1, counted: 1 });
  });

  it('a viewer who cannot see the author is refused, as on any post', async () => {
    const { story } = await scene();
    const stranger = await user('stranger');
    // A public author: a stranger can see the activity, so the predicate is what decides.
    // A private author makes the existing check refuse first.
    const shy = await user('shy', 'private');
    const target = await user('target');
    await follow(shy, target);
    const hidden = await latestStory(shy);
    assert.equal((await refusal(stranger, `select set_reaction($1, $2, 'love')`, [await uuid(), hidden]))?.code, 'P0002');
    assert.ok(story);
  });
});

describe('Q2: being named grants nothing', () => {
  it('the only member cannot react or comment on a story about themselves', async () => {
    const { b, story } = await scene();
    await follow(b, (await t.sql(`select actor_id from feed_events where id = $1`, [story])).rows[0].actor_id);
    assert.equal((await refusal(b, `select set_reaction($1, $2, 'love')`, [await uuid(), story]))?.code, 'P0002');
    assert.equal(
      (await refusal(b, `select add_comment($1, $2, 'hi', false, null, '{}'::uuid[])`, [await uuid(), story]))?.code,
      'P0002',
    );
  });

  it('a member may join as an ordinary follower when another member is open to them', async () => {
    const { a, b, story } = await scene();
    const c = await user('second');
    await follow(a, c); // same window, not yet engaged: appended to the same story
    assert.deepEqual((await members(story)).sort(), [b, c].sort());
    await follow(b, a);
    const r = await react(b, story, 'love');
    assert.equal(r.rows[0].r.status, 'ok');
  });

  it('a mention cannot name somebody into a story closed to them', async () => {
    const { a, b, f, story } = await scene();
    await follow(b, a);
    await follow(f, b); // F may otherwise mention B anywhere
    const handle = (await t.sql(`select username from profiles where id = $1`, [b])).rows[0].username;

    // Picked explicitly: refused outright, the strict rule every ineligible pick meets.
    const picked = await refusal(
      f,
      `select add_comment($1, $2, $3, false, null, $4::uuid[])`,
      [await uuid(), story, `hey @${handle}`, [b]],
    );
    assert.equal(picked?.code, '42501');

    // Typed but not picked: the comment posts and the name is simply not resolved.
    const typed = await comment(f, story, `hey @${handle}`);
    assert.equal(typed.status, 'ok');
    const active = Number(
      (await t.sql(`select count(*) from comment_mentions where mentioned_id = $1 and active`, [b])).rows[0].count,
    );
    assert.equal(active, 0);
    assert.equal(await notified(b, story, 'mention'), 0, 'the sole member is not mentioned in');

    // And the composer never offers them.
    const offered = (
      await as(f, `select id from mention_candidates($1, $2)`, [story, handle.slice(0, 4)])
    ).rows.map((r) => r.id);
    assert.equal(offered.includes(b), false);
  });
});

describe('Q1: a story freezes on its first reaction or comment', () => {
  it('a follow after the first reaction opens a new story', async () => {
    const { a, b, f, story } = await scene();
    await react(f, story);
    const c = await user('later');
    await follow(a, c);
    assert.equal(await storyCount(a), 2);
    assert.deepEqual(await members(story), [b], 'the engaged story did not grow');
    assert.deepEqual(await members(await latestStory(a)), [c]);
  });

  it('a follow after the first comment opens a new story', async () => {
    const { a, f, story } = await scene();
    await comment(f, story, 'nice');
    await follow(a, await user('later2'));
    assert.equal(await storyCount(a), 2);
  });

  it('a story nobody has engaged with still groups', async () => {
    const { a, story } = await scene();
    await follow(a, await user('more'));
    assert.equal(await storyCount(a), 1);
    assert.equal((await members(story)).length, 2);
  });
});

describe('Q3: no eligible member left hides the conversation from everyone', () => {
  for (const [label, sever] of [
    ['the author unfollows the member', async ({ a, b }) => unfollow(a, b)],
    ['the member blocks the author', async ({ a, b }) => block(b, a)],
    ['the author blocks the member', async ({ a, b }) => block(a, b)],
  ]) {
    it(`${label}: hidden for the follower and the author, refused, kept, restored on re-follow`, async () => {
      const s = await scene();
      const { a, b, f, story } = s;
      await react(f, story);
      const c = await comment(f, story, 'nice');
      const fan2 = await user('fan2');
      await follow(fan2, a);
      await as(fan2, `select set_comment_reaction($1, $2, 'love')`, [await uuid(), c.comment_id]);
      await sever(s);

      // The comment-level paths: reacting to it, who reacted, and the excerpt rule.
      assert.equal(
        (await refusal(f, `select set_comment_reaction($1, $2, 'wow')`, [await uuid(), c.comment_id]))?.code,
        'P0002',
      );
      assert.equal(
        (await as(f, `select count(*)::int as n from comment_reactors($1)`, [c.comment_id])).rows[0].n,
        0,
      );
      assert.equal(
        (await as(f, `select count(*)::int as n from comment_reactions where comment_id = $1`, [c.comment_id]))
          .rows[0].n,
        0,
      );
      assert.equal(
        (await t.sql(`select _can_read_comment($1, $2) as ok`, [f, c.comment_id])).rows[0].ok,
        false,
        'no push or inbox excerpt quotes it',
      );

      const empty = { reactions: 0, comments: 0, thread: 0, counted: 0 };
      assert.deepEqual(await view(f, story), empty, 'hidden from the follower');
      assert.deepEqual(await view(a, story), empty, 'hidden from the author too');
      assert.deepEqual(await stored(story), { reactions: 1, comments: 1 }, 'nothing deleted');

      assert.equal((await refusal(f, `select set_reaction($1, $2, 'wow')`, [await uuid(), story]))?.code, 'P0002');
      assert.equal(
        (await refusal(f, `select add_comment($1, $2, 'x', false, null, '{}'::uuid[])`, [await uuid(), story]))?.code,
        'P0002',
      );
      assert.equal(
        (await refusal(f, `select edit_comment($1, $2, 'edited', false)`, [await uuid(), c.comment_id]))?.code,
        'P0002',
      );
      assert.equal(
        (await as(f, `select count(*)::int as n from follow_activity_people($1::uuid[])`, [[story]])).rows[0].n,
        0,
        'the story names nobody',
      );

      if (label !== 'the member blocks the author' && label !== 'the author blocks the member') {
        await follow(a, b);
        assert.deepEqual(await view(f, story), { reactions: 1, comments: 1, thread: 1, counted: 1 });
      }
    });
  }

  it('a block between one follower and the only member closes the story for that follower alone', async () => {
    const { a, b, f, story } = await scene();
    await react(f, story);
    const other = await user('other');
    await follow(other, a);
    await react(other, story, 'wow');
    await block(b, f);
    assert.deepEqual((await view(f, story)).reactions, 0);
    assert.equal((await view(other, story)).reactions, 2, 'still open to everybody else');
    assert.equal((await view(a, story)).reactions, 2, 'and to the author');
  });

  it('one member leaving does not close a story another member keeps open', async () => {
    const { a, b, f, story } = await scene();
    const c = await user('second');
    await follow(a, c);
    await block(c, a); // C leaves; B keeps the story open
    await react(f, story);
    assert.equal(await notified(a, story, 'reaction'), 1, 'the author is told');
    assert.deepEqual(
      (await as(f, `select user_id from follow_activity_people($1::uuid[])`, [[story]])).rows.map((r) => r.user_id),
      [b],
      'C is no longer named',
    );
  });
});

describe('participants and replies only while the story is open to them', () => {
  it('the author’s comment reaches prior commenters who can still see the story, only', async () => {
    const { a, b, f, story } = await scene();
    const c = await user('second');
    await follow(a, c);
    const other = await user('other');
    await follow(other, a);
    await comment(f, story, 'one');
    await comment(other, story, 'two');
    // F blocks... no: B blocks F and C blocks F, so no member is open to F.
    await block(b, f);
    await block(c, f);
    await comment(a, story, 'thanks all');
    const participant = async (who) =>
      Number(
        (
          await t.sql(
            `select count(*) from notifications
              where recipient_id = $1 and subject_id = $2 and type = 'comment'
                and payload->>'participant' = 'true'`,
            [who, story],
          )
        ).rows[0].count,
      );
    assert.equal(await participant(other), 1);
    assert.equal(await participant(f), 0, 'not told about a conversation closed to them');
  });
});

describe('Heart Magnet and ordinary posts', () => {
  it('reactions on follow stories do not count toward Heart Magnet; a ranking post’s do', async () => {
    const { a, f, story } = await scene();
    await react(f, story);
    await t.actAs(a);
    const film = await t.createMovie('Magnet', seq + 500000);
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const post = (
      await t.sql(`select id from feed_events where actor_id = $1 and type = 'title_ranked' limit 1`, [a])
    ).rows[0].id;
    await react(f, post);
    const metric = (await t.sql(`select _award_metric($1, 'heart-magnet', 10) as v`, [a])).rows[0].v;
    assert.equal(Number(metric), 1);
  });

  it('an ordinary post keeps every behaviour: reaction, comment, notifications, reads', async () => {
    const a = await user('poster');
    await as(a, `select set_notification_preference('reactions', true)`);
    const f = await user('reader');
    await follow(f, a);
    await t.actAs(a);
    const film = await t.createMovie('Ordinary', seq + 600000);
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const post = (
      await t.sql(`select id from feed_events where actor_id = $1 and type = 'title_ranked' limit 1`, [a])
    ).rows[0].id;
    await react(f, post);
    await comment(f, post, 'great');
    assert.equal(await notified(a, post, 'reaction'), 1);
    assert.equal(await notified(a, post, 'comment'), 1);
    assert.deepEqual(await view(f, post), { reactions: 1, comments: 1, thread: 1, counted: 1 });
  });
});
