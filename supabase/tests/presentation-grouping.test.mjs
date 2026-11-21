import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **A group that presents its members** (Feed PR 2, 20261128000100).
 *
 * Title-page backfill rankings group within a fixed window, across ladders; an Unranked
 * sitting joins the same group; a historical burst can be consolidated and reverted. In
 * every case a member is hidden from client reads rather than deleted, and nothing that a
 * person has reacted to, commented on or been notified about is ever hidden. (A reviewed
 * title was kept apart too until 20261130000800; its review is now read inside the group.)
 */
let t;
let user;
let friend;
let stranger;
let seq = 0;
let tmdb = 1_200_000;

before(async () => {
  t = await createTestDb();
  friend = await t.createUser({ username: 'pg_friend' });
  stranger = await t.createUser({ username: 'pg_stranger' });
});

after(async () => t?.close());

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `pg_user_${seq}` });
  await t.actAs(user);
});

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

/** A title the reader watched long ago (or as `basis`/`daysAgo` say), then ranked. */
async function ranked(kind, name, { basis = 'none', daysAgo = null } = {}) {
  let id;
  if (kind === 'season') {
    const show = await t.createSeries(`${name} ${seq}`, (tmdb += 1));
    id = await t.createSeason(show, 1, `${name} ${seq} S1`);
  } else {
    id = await t.createMovie(`${name} ${seq}`, (tmdb += 1));
  }
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  await t.sql(
    `insert into watch_events (user_id, media_item_id, watched_on, basis)
     values ($1, $2, case when $4::int is null then null else current_date - $4::int end, $3::watch_date_basis)`,
    [user, id, basis, daysAgo],
  );
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return id;
}

const group = (mediaItemId) => call(`rank_group_note($1, $2)`, [uuid(), mediaItemId]);
const groupNote = async (mediaItemId, op) =>
  call(`rank_group_note($1, $2)`, [op ?? (await uuid()), mediaItemId]);

const allPosts = async (actor = user) =>
  (
    await t.sql(
      `select id, type, media_item_id, payload, presented_in, causal_at, created_at
         from feed_events where actor_id = $1 order by causal_at, id`,
      [actor],
    )
  ).rows;

/** What a client sees: the policy applied, as the Feed reads it. */
const visibleTo = (viewer, actor = user) =>
  t.asUser(viewer, async () => {
    const { rows } = await t.sql(
      `select id, type, payload from feed_events where actor_id = $1 order by causal_at, id`,
      [actor],
    );
    return rows;
  });

const notificationCount = async () =>
  Number((await t.sql(`select count(*)::int as n from notifications`)).rows[0].n);

describe('title-page first rankings', () => {
  it('a first ranking stays a single card, marked so the next can pair with it', async () => {
    const heat = await ranked('movie', 'Heat');
    const r = await groupNote(heat);
    assert.equal(r.status, 'solo');
    const [post] = await allPosts();
    assert.equal(post.type, 'title_ranked');
    assert.equal(post.payload.groupable, true, '20261130000200 marks it groupable');
    assert.equal(post.presented_in, null);
  });

  it('two inside the window become one group, across ladders; the members are hidden, not deleted', async () => {
    const before = await notificationCount();
    const heat = await ranked('movie', 'Heat');
    await groupNote(heat);
    const severance = await ranked('season', 'Severance', { basis: 'reader', daysAgo: 400 });
    const r = await groupNote(severance);
    assert.equal(r.status, 'grouped');
    assert.equal(r.count, 2);

    const posts = await allPosts();
    const g = posts.find((p) => p.type === 'ranking_batch');
    const members = posts.filter((p) => p.type === 'title_ranked');
    assert.equal(members.length, 2, 'both rankings still exist');
    assert.ok(members.every((m) => m.presented_in === g.id));
    // 20261130000900: the group stands where its newest activity did.
    assert.equal(
      g.causal_at.getTime(),
      Math.max(...members.map((m) => m.causal_at.getTime())),
      'the group stands where the latest did',
    );

    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => p.type),
      ['ranking_batch'],
      'a reader sees one card, never the group and its members',
    );
    const { rows } = await t.sql(
      `select media_item_id, category, score from ranking_batch_titles($1)`,
      [g.id],
    );
    assert.deepEqual(new Set(rows.map((row) => row.media_item_id)), new Set([heat, severance]));
    assert.equal(rows.find((row) => row.media_item_id === severance).category, 'tv_seasons');
    assert.equal(await notificationCount(), before, 'grouping notifies nobody');
  });

  it('a third joins the open group; past the window a new one starts', async () => {
    const a = await ranked('movie', 'A');
    await groupNote(a);
    await groupNote(await ranked('movie', 'B'));
    const c = await ranked('movie', 'C');
    const joined = await groupNote(c);
    assert.equal(joined.status, 'joined');
    assert.equal(joined.count, 3);

    const g = (await allPosts()).find((p) => p.type === 'ranking_batch');
    await t.sql(
      `update feed_events set payload = jsonb_set(payload, '{started_at}',
         to_jsonb((payload ->> 'started_at')::timestamptz - interval '31 minutes')) where id = $1`,
      [g.id],
    );
    const d = await ranked('movie', 'D');
    assert.equal((await groupNote(d)).status, 'solo', 'a closed window takes nothing');
  });

  it('the watch date no longer decides (20261130000200), and neither does a review (20261130000800)', async () => {
    // "Today", a recent date and no watch at all were refused by 20261128000100's
    // historical test. Under the founder's half-hour rule they group like any other.
    const today = await ranked('movie', 'Today', { basis: 'today_default', daysAgo: 0 });
    assert.equal((await groupNote(today)).status, 'solo');
    const recent = await ranked('movie', 'Recent', { basis: 'reader', daysAgo: 2 });
    assert.equal((await groupNote(recent)).status, 'grouped');

    const reviewed = await ranked('movie', 'Reviewed');
    await t.sql(
      `update user_media set note = 'Loved it.', note_visibility = 'public'
        where user_id = $1 and media_item_id = $2`,
      [user, reviewed],
    );
    assert.equal((await groupNote(reviewed)).status, 'joined', 'a review is no obstacle either');

    const noWatch = await t.createMovie(`No watch ${seq}`, (tmdb += 1));
    await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [
      user,
      noWatch,
    ]);
    await t.rankToCompletion(noWatch, 'loved', (pivot, subject) => subject);
    await t.sql(`delete from watch_events where user_id = $1 and media_item_id = $2`, [
      user,
      noWatch,
    ]);
    assert.equal((await groupNote(noWatch)).status, 'joined', 'no watch event is no obstacle');
    const posts = await allPosts();
    const g = posts.find((p) => p.type === 'ranking_batch');
    assert.equal(g.payload.count, 4);
    assert.equal(
      posts.find((p) => p.media_item_id === reviewed && p.type === 'title_ranked').presented_in,
      g.id,
      'the reviewed ranking is shown through the group, not as a post of its own',
    );
  });

  it('never hides a ranking somebody has already reacted to', async () => {
    const liked = await ranked('movie', 'Liked');
    await groupNote(liked);
    const [post] = await allPosts();
    await t.sql(
      `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
      [post.id, friend],
    );
    const next = await ranked('movie', 'Next');
    const r = await groupNote(next);
    assert.equal(r.status, 'solo', 'the reacted-to peer is not taken');
    assert.ok((await allPosts()).every((p) => p.presented_in === null));
  });

  it('is idempotent, and does nothing with the flag off', async () => {
    const a = await ranked('movie', 'Once');
    const op = await uuid();
    const first = await groupNote(a, op);
    assert.deepEqual(await groupNote(a, op), first);

    await t.sql(
      `update app_config set value = 'false'::jsonb where key = 'feed.ranking_backfill_grouping_enabled'`,
    );
    try {
      const b = await ranked('movie', 'Off');
      assert.equal((await groupNote(b)).reason, 'disabled');
    } finally {
      await t.sql(
        `update app_config set value = 'true'::jsonb where key = 'feed.ranking_backfill_grouping_enabled'`,
      );
    }
  });
});

describe('a hidden member that gains a conversation (Codex, PR 313), or a review (20261130000800)', () => {
  const groupOfThree = async () => {
    for (const name of ['M1', 'M2', 'M3']) await groupNote(await ranked('movie', name));
    const posts = await allPosts();
    return {
      g: posts.find((p) => p.type === 'ranking_batch'),
      members: posts.filter((p) => p.type === 'title_ranked'),
    };
  };

  it('a reaction from a device still showing the old card puts that card back', async () => {
    const { g, members } = await groupOfThree();
    await t.sql(
      `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
      [members[1].id, friend],
    );
    const after = await allPosts();
    assert.equal(after.find((p) => p.id === members[1].id).presented_in, null, 'shown again');
    assert.equal(
      after.find((p) => p.id === g.id).payload.count,
      2,
      'the group drops its title',
    );
    const seen = await visibleTo(friend);
    assert.ok(
      seen.some((p) => p.id === members[1].id),
      'its reaction is reachable',
    );
  });

  it('a group that loses its named title is named by one it still shows', async () => {
    const { g, members } = await groupOfThree();
    const named = members.find((m) => m.media_item_id === g.media_item_id);
    await t.sql(
      `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
      [named.id, friend],
    );
    const after = (await allPosts()).find((p) => p.id === g.id);
    assert.equal(after.payload.count, 2);
    assert.notEqual(after.media_item_id, named.media_item_id);
    assert.ok(
      members.some((m) => m.media_item_id === after.media_item_id && m.id !== named.id),
    );
  });

  it('a group of two that loses one dissolves: both cards come back, the group hides', async () => {
    await groupNote(await ranked('movie', 'Pair 1'));
    await groupNote(await ranked('movie', 'Pair 2'));
    const before = await allPosts();
    const g = before.find((p) => p.type === 'ranking_batch');
    const [a, b] = before.filter((p) => p.type === 'title_ranked');
    await t.sql(`insert into comments (feed_event_id, author_id, body) values ($1, $2, 'oh')`, [
      a.id,
      friend,
    ]);
    const seen = await visibleTo(friend);
    assert.deepEqual(new Set(seen.map((p) => p.id)), new Set([a.id, b.id]));
    const after = (await allPosts()).find((p) => p.id === g.id);
    assert.equal(after.presented_in, a.id, 'the empty group is hidden, not deleted');
    assert.equal(after.payload.dissolved, true);
  });

  it('a comment does the same', async () => {
    const { members } = await groupOfThree();
    await t.sql(
      `insert into comments (feed_event_id, author_id, body) values ($1, $2, 'late')`,
      [members[0].id, friend],
    );
    assert.equal((await allPosts()).find((p) => p.id === members[0].id).presented_in, null);
  });

  it('publishing a review of a grouped title leaves it in its group (20261130000800)', async () => {
    const { g, members } = await groupOfThree();
    await t.sql(
      `update user_media set note = 'Written later.', note_visibility = 'public'
        where user_id = $1 and media_item_id = $2`,
      [user, members[2].media_item_id],
    );
    const after = await allPosts();
    assert.equal(
      after.find((p) => p.id === members[2].id).presented_in,
      g.id,
      'no card of its own: the review is no second post',
    );
    assert.equal(after.find((p) => p.id === g.id).payload.count, 3);
  });

  it('a private note changes nothing', async () => {
    const { members } = await groupOfThree();
    await t.sql(
      `update user_media set note = 'Just for me.', note_visibility = 'private'
        where user_id = $1 and media_item_id = $2`,
      [user, members[2].media_item_id],
    );
    assert.ok((await allPosts()).find((p) => p.id === members[2].id).presented_in !== null);
  });
});

describe('an Unranked sitting and a title-page group', () => {
  it('a sitting that begins inside the window joins the title-page group', async () => {
    await groupNote(await ranked('movie', 'Page 1'));
    await groupNote(await ranked('movie', 'Page 2'));
    const g = (await allPosts()).find((p) => p.type === 'ranking_batch');

    const s = await uuid();
    const sat = await ranked('season', 'Sat');
    await call(`rank_batch_note($1, $2, $3)`, [await uuid(), s, sat]);
    const ended = await call(`rank_batch_finalize($1, $2)`, [await uuid(), s]);
    assert.equal(ended.joined, true);
    assert.equal(ended.event_id, g.id);
    assert.equal(ended.count, 3, 'the count includes the presented rankings');
    const visible = await visibleTo(friend);
    assert.equal(visible.filter((p) => p.type === 'ranking_batch').length, 1);
    assert.equal(visible.filter((p) => p.type === 'title_ranked').length, 0);
  });
});

describe('following a hidden id', () => {
  it('resolves to its group for someone who may see it, and to nothing for a blocked reader', async () => {
    await groupNote(await ranked('movie', 'Link 1'));
    await groupNote(await ranked('movie', 'Link 2'));
    const posts = await allPosts();
    const member = posts.find((p) => p.type === 'title_ranked');
    const g = posts.find((p) => p.type === 'ranking_batch');
    const asFriend = await t.asUser(
      friend,
      async () =>
        (await t.sql(`select feed_event_presentation($1) as g`, [member.id])).rows[0].g,
    );
    assert.equal(asFriend, g.id);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
      user,
      stranger,
    ]);
    const asBlocked = await t.asUser(
      stranger,
      async () =>
        (await t.sql(`select feed_event_presentation($1) as g`, [member.id])).rows[0].g,
    );
    assert.equal(asBlocked, null);
  });
});

describe('historical consolidation', () => {
  /** Old single posts, written directly at a past time, as production holds them. */
  const oldPost = async (type, mediaItemId, minutesAgo, payload = {}) => {
    const at = `now() - make_interval(days => 3, mins => ${minutesAgo})`;
    const { rows } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload, created_at, causal_at)
       values ($1, $2, $3, $4, ${at}, ${at}) returning id`,
      [user, type, mediaItemId, payload],
    );
    if (type === 'watchlist_added') {
      await t.sql(
        `insert into feed_watchlist_titles (event_id, actor_id, media_item_id) values ($1, $2, $3)`,
        [rows[0].id, user, mediaItemId],
      );
    }
    return rows[0].id;
  };
  const since = `now() - interval '5 days'`;
  const consolidate = async (batch, apply) =>
    call(`consolidate_feed_history($1, ${since}, now(), $2, 30, $3)`, [batch, apply, user]);

  it('a dry run writes nothing; applying groups each burst, keeps the conversation, and reverts', async () => {
    const films = [];
    for (let i = 0; i < 4; i += 1) films.push(await ranked('movie', `Old ${i}`));
    // Ranked through the normal path just now: move those posts into the past, as history.
    await t.sql(
      `update feed_events set created_at = now() - interval '3 days' + make_interval(mins => (5 * rn)::int),
                              causal_at  = now() - interval '3 days' + make_interval(mins => (5 * rn)::int)
         from (select id, row_number() over (order by created_at, id) rn from feed_events
                where actor_id = $1 and type = 'title_ranked') x
        where feed_events.id = x.id`,
      [user],
    );
    // And their watches recorded before them, as they were.
    await t.sql(
      `update watch_events set recorded_at = now() - interval '3 days' - interval '1 hour'
        where user_id = $1`,
      [user],
    );
    const ranking = await allPosts();
    // One of them has a comment: it keeps its own card.
    await t.sql(
      `insert into comments (feed_event_id, author_id, body) values ($1, $2, 'what a film')`,
      [ranking[1].id, friend],
    );
    const w = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await t.createMovie(`Saved ${i} ${seq}`, (tmdb += 1));
      w.push(await oldPost('watchlist_added', id, 20 - i * 5, { count: 1 }));
    }
    const positions = (
      await t.sql(
        `select media_item_id, position from rankings where user_id = $1 order by 1`,
        [user],
      )
    ).rows;
    const notesBefore = await notificationCount();

    const dry = await consolidate(`test-${seq}`, false);
    assert.equal(dry.applied, false);
    assert.equal(dry.planned_groups.ranking, 1);
    assert.equal(dry.planned_groups.watchlist, 1);
    assert.equal(
      dry.planned_groups.members,
      6,
      '3 rankings without the commented one, 3 saves',
    );
    assert.ok(
      (await allPosts()).every((p) => p.presented_in === null),
      'a dry run writes nothing',
    );

    const done = await consolidate(`test-${seq}`, true);
    assert.deepEqual(done.applied_groups, { watchlist: 1, ranking: 1 });
    const seen = await visibleTo(friend);
    assert.equal(seen.filter((p) => p.type === 'ranking_batch').length, 1);
    assert.equal(
      seen
        .filter((p) => p.type === 'title_ranked')
        .map((p) => p.id)
        .join(),
      ranking[1].id,
      'only the ranking with a conversation is still its own card',
    );
    assert.equal(seen.filter((p) => p.type === 'watchlist_added').length, 1);
    const wGroup = seen.find((p) => p.type === 'watchlist_added');
    assert.equal(wGroup.payload.count, 3);
    const { rows: wTitles } = await t.asUser(friend, () =>
      t.sql(`select media_item_id from watchlist_group_titles($1)`, [wGroup.id]),
    );
    assert.equal(wTitles.length, 3);

    assert.deepEqual(
      (
        await t.sql(
          `select media_item_id, position from rankings where user_id = $1 order by 1`,
          [user],
        )
      ).rows,
      positions,
      'no ranking moves',
    );
    assert.equal(await notificationCount(), notesBefore, 'nobody is notified');
    await assert.rejects(consolidate(`test-${seq}`, true), /already applied/);

    const reverted = await call(`revert_feed_consolidation($1)`, [`test-${seq}`]);
    assert.equal(reverted.deleted_groups, 1);
    assert.equal(reverted.restored_posts, 1);
    const after = await allPosts();
    assert.ok(
      after.every((p) => p.presented_in === null),
      'every member is shown again',
    );
    assert.equal(after.filter((p) => p.type === 'ranking_batch').length, 0);
    assert.equal(
      after.find((p) => p.id === w[0]).payload.count,
      1,
      'the promoted watchlist post has its own payload back',
    );
  });

  it('a history group is closed to new rankings, and a revert keeps one that gained a conversation', async () => {
    const films = [];
    for (let i = 0; i < 2; i += 1) films.push(await ranked('movie', `Closed ${i}`));
    await t.sql(
      `update feed_events set created_at = now() - interval '2 minutes', causal_at = now() - interval '2 minutes'
        where actor_id = $1 and type = 'title_ranked'`,
      [user],
    );
    await t.sql(
      `update watch_events set recorded_at = now() - interval '1 hour' where user_id = $1`,
      [user],
    );
    await consolidate(`closed-${seq}`, true);
    const g = (await allPosts()).find((p) => p.type === 'ranking_batch');
    assert.ok(g, 'the recent burst was consolidated');
    assert.equal(g.payload.started_at, undefined, 'no open window');
    // A ranking made right now does not join it, though it is minutes old.
    assert.equal((await groupNote(await ranked('movie', 'After'))).status, 'solo');

    await t.sql(
      `insert into comments (feed_event_id, author_id, body) values ($1, $2, 'nice set')`,
      [g.id, friend],
    );
    const reverted = await call(`revert_feed_consolidation($1)`, [`closed-${seq}`]);
    assert.deepEqual(reverted.kept_with_conversation, [g.id]);
    assert.equal(
      (await t.sql(`select count(*)::int n from comments where feed_event_id = $1`, [g.id]))
        .rows[0].n,
      1,
      'the conversation is not cascaded away',
    );
  });

  it('refuses an unbounded range', async () => {
    await assert.rejects(
      call(`consolidate_feed_history('wide', now() - interval '30 days', now(), false)`),
      /at most 8 days/,
    );
  });
});
