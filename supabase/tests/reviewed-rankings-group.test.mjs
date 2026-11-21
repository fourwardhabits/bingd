import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **A reviewed first ranking joins its half hour** (founder report, live Android,
 * 2026-11-21; 20261130000800).
 *
 * The report: "<the founder> ranked 7 titles" as one carousel, and a reviewed first ranking
 * of *Invincible* four minutes later as a separate post beside it. A published review no
 * longer disqualifies an otherwise eligible first-time ranking from the fixed 30-minute
 * group, and adding or editing one never makes a second post. The review stays the title's:
 * `public_notes` returns it to exactly the readers it returned it to before, and the group's
 * own readers list the title it belongs to.
 *
 * Everything else that keeps a ranking apart still does: a rewatch, a reference (comments,
 * reactions, notifications), and the window's edges.
 */
let t;
let user;
let friend;
let stranger;
let seq = 0;
let tmdb = 1_500_000;

before(async () => {
  t = await createTestDb();
  friend = await t.createUser({ username: 'rrg_friend' });
  stranger = await t.createUser({ username: 'rrg_stranger' });
});

after(async () => t?.close());

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `rrg_user_${seq}` });
  await t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
    [friend, user],
  );
  await t.actAs(user);
});

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

async function title(kind, name) {
  if (kind === 'season') {
    const show = await t.createSeries(`${name} ${seq}`, (tmdb += 1));
    return t.createSeason(show, 1, `${name} ${seq} S1`);
  }
  if (kind === 'show') return t.createSeries(`${name} ${seq}`, (tmdb += 1));
  return t.createMovie(`${name} ${seq}`, (tmdb += 1));
}

/** The client's own review write: `save_note`, public, as the log sheet sends it. */
const review = async (mediaItemId, text, { visibility = 'public', spoilers = false } = {}) =>
  call(`save_note($1, $2, $3, null, $4::note_visibility, $5)`, [
    await uuid(),
    mediaItemId,
    text,
    visibility,
    spoilers,
  ]);

/**
 * A first-time ranking as the title page makes it: the log sheet's watch dated "Today", its
 * review when there is one, the ranking, then the sheet's grouping note.
 */
async function rankFirst(kind, name, { text = null, note = true } = {}) {
  const id = await title(kind, name);
  await call(`log_title($1, $2, 'loved', current_date, 'today_default'::watch_date_basis)`, [
    await uuid(),
    id,
  ]);
  if (text) await review(id, text);
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  const result = note ? await call(`rank_group_note($1, $2)`, [await uuid(), id]) : null;
  return { id, result };
}

/** Moves the actor's posts (and any group's window) `minutes` into the past. */
async function age(minutes) {
  await t.sql(
    `update feed_events
        set created_at = created_at - make_interval(mins => $2::int),
            causal_at  = causal_at  - make_interval(mins => $2::int),
            payload = case when payload ? 'started_at'
                           then jsonb_set(payload, '{started_at}',
                                  to_jsonb((payload ->> 'started_at')::timestamptz - make_interval(mins => $2::int)))
                           else payload end
      where actor_id = $1`,
    [user, minutes],
  );
}

/**
 * Runs `fn` as `viewer` with RLS applied, then acts as the author again: `asUser` leaves
 * its claims set, and the next ranking must be the author's.
 */
const as = async (viewer, fn) => {
  try {
    return await t.asUser(viewer, fn);
  } finally {
    await t.actAs(user);
  }
};

const posts = async () =>
  (
    await t.sql(
      `select id, type, media_item_id, payload, presented_in from feed_events
        where actor_id = $1 order by causal_at, id`,
      [user],
    )
  ).rows;

/** The actor's activity as a client reads it: the policy applied. */
const visibleTo = (viewer) =>
  as(viewer, async () => {
    const { rows } = await t.sql(
      `select id, type, media_item_id, payload from feed_events where actor_id = $1 order by causal_at, id`,
      [user],
    );
    return rows;
  });

/** The member sheet's read, as `viewer`. */
const sheetAs = (viewer, eventId) =>
  as(viewer, async () =>
    (await t.sql(`select media_item_id from ranking_batch_titles($1)`, [eventId])).rows.map(
      (r) => r.media_item_id,
    ),
  );

/** The carousel's read, as `viewer`. */
const railAs = (viewer, eventId) =>
  as(viewer, async () =>
    (
      await t.sql(
        `select media_item_id from feed_group_previews(array[$1]::uuid[], 12) order by ordinal`,
        [eventId],
      )
    ).rows.map((r) => r.media_item_id),
  );

/** The review text `viewer` can read, by the only cross-user path: `public_notes`. */
const reviewAs = (viewer, mediaItemId) =>
  as(viewer, async () => {
    const { rows } = await t.sql(
      `select note, has_spoilers from public_notes(array[$1]::uuid[], array[$2]::uuid[], 10)`,
      [user, mediaItemId],
    );
    return rows[0]?.note ?? null;
  });

const notificationCount = async () =>
  Number((await t.sql(`select count(*)::int as n from notifications`)).rows[0].n);

describe('the reported case', () => {
  it('seven first rankings are one carousel; a reviewed eighth four minutes later joins that post', async () => {
    const seven = [];
    for (let i = 1; i <= 7; i += 1) seven.push((await rankFirst('movie', `Seven ${i}`)).id);
    const [group] = await visibleTo(friend);
    assert.equal(group.type, 'ranking_batch');
    assert.equal(group.payload.count, 7, '"ranked 7 titles"');

    await age(4);
    const notified = await notificationCount();
    const invincible = await rankFirst('show', 'Invincible', {
      text: 'Brutal, funny, and better every episode.',
    });
    assert.equal(invincible.result.status, 'joined');
    assert.equal(invincible.result.event_id, group.id, 'the same post, not a new group');
    assert.equal(invincible.result.count, 8);

    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => [p.id, p.type]),
      [[group.id, 'ranking_batch']],
      'one post: no separate card for the reviewed ranking',
    );
    assert.equal(seen[0].payload.count, 8, '"ranked 8 titles"');
    // Newest first since 20261130000900: the reviewed eighth leads the sheet and the rail.
    assert.deepEqual(await sheetAs(friend, group.id), [invincible.id, ...seven.reverse()]);
    assert.deepEqual(
      (await railAs(friend, group.id))[0],
      invincible.id,
      'the carousel starts on it',
    );
    assert.equal(
      await reviewAs(friend, invincible.id),
      'Brutal, funny, and better every episode.',
      'the review is still readable, attached to its title',
    );
    assert.equal(
      await reviewAs(stranger, invincible.id),
      'Brutal, funny, and better every episode.',
      'a public author: the same readers as before',
    );
    assert.equal(await notificationCount(), notified, 'nobody is notified');

    // The hidden member is still there, with its id, and a stale link finds the group.
    const member = (await posts()).find(
      (p) => p.type === 'title_ranked' && p.media_item_id === invincible.id,
    );
    assert.equal(member.presented_in, group.id);
    const followed = await as(
      friend,
      async () =>
        (await t.sql(`select feed_event_presentation($1) as g`, [member.id])).rows[0].g,
    );
    assert.equal(followed, group.id);
  });
});

describe('a review written on a grouped title', () => {
  it('adding one afterwards makes no new post, and it is readable', async () => {
    await rankFirst('movie', 'G1');
    const second = await rankFirst('movie', 'G2');
    const before = await posts();
    const notified = await notificationCount();

    await review(second.id, 'Written after it grouped.');
    assert.deepEqual(await posts(), before, 'nothing moved: no card back, no new post');
    assert.equal(await reviewAs(friend, second.id), 'Written after it grouped.');
    assert.equal(await notificationCount(), notified);
  });

  it('editing one makes no new post either', async () => {
    const first = await rankFirst('movie', 'E1', { text: 'First draft.' });
    await rankFirst('movie', 'E2');
    const before = await posts();
    assert.equal(before.filter((p) => p.type === 'ranking_batch').length, 1);

    await review(first.id, 'Second draft, longer.');
    await review(first.id, 'Third draft, with spoilers.', { spoilers: true });
    assert.deepEqual(await posts(), before);
    assert.equal(await reviewAs(friend, first.id), 'Third draft, with spoilers.');
  });

  it('unsharing one changes nothing in the Feed and hides the text', async () => {
    const first = await rankFirst('movie', 'U1', { text: 'Public for now.' });
    await rankFirst('movie', 'U2');
    const before = await posts();
    await review(first.id, 'Public for now.', { visibility: 'private' });
    assert.deepEqual(await posts(), before);
    assert.equal(await reviewAs(friend, first.id), null, 'a private note is nobody else’s');
  });
});

describe('forming a group, and staying alone', () => {
  it('a reviewed first ranking forms a group with a later plain one', async () => {
    const reviewed = await rankFirst('movie', 'Reviewed first', { text: 'Loved it.' });
    assert.equal(reviewed.result.status, 'solo', 'alone, it is marked so the next can pair');
    await age(10);
    const plain = await rankFirst('season', 'Plain second');
    assert.equal(plain.result.status, 'grouped');
    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => p.type),
      ['ranking_batch'],
    );
    // 20261130000900: the group names its newest title and lists newest first.
    assert.equal(seen[0].media_item_id, plain.id, 'the group leads with its newest title');
    assert.deepEqual(await sheetAs(friend, seen[0].id), [plain.id, reviewed.id]);
    assert.equal(await reviewAs(friend, reviewed.id), 'Loved it.');
  });

  it('a lone reviewed ranking stays a single card, its review on it', async () => {
    const lone = await rankFirst('movie', 'Alone', { text: 'Just this one.' });
    assert.equal(lone.result.status, 'solo');
    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => [p.type, p.media_item_id]),
      [['title_ranked', lone.id]],
    );
    assert.equal(await reviewAs(friend, lone.id), 'Just this one.');
  });

  it('a whole-show first ranking with a review follows the same rule', async () => {
    const film = await rankFirst('movie', 'Film');
    const show = await rankFirst('show', 'Whole show', { text: 'The whole run holds up.' });
    assert.equal(film.result.status, 'solo');
    assert.equal(show.result.status, 'grouped');
    const [g] = await visibleTo(friend);
    const { rows } = await t.sql(
      `select media_item_id, category from ranking_batch_titles($1)`,
      [g.id],
    );
    assert.deepEqual(
      rows.map((r) => [r.media_item_id, r.category]),
      [
        [show.id, 'tv_shows'],
        [film.id, 'movies'],
      ],
    );
    assert.equal(await reviewAs(friend, show.id), 'The whole run holds up.');
  });

  it('an Unranked sitting adopts a reviewed title-page ranking of its half hour', async () => {
    const page = await rankFirst('movie', 'Page', { text: 'From the title page.' });
    assert.equal(page.result.status, 'solo');
    const s = await uuid();
    for (const name of ['Sat 1', 'Sat 2']) {
      const { id } = await rankFirst('movie', name, { note: false });
      await call(`rank_batch_note($1, $2, $3)`, [await uuid(), s, id]);
    }
    const ended = await call(`rank_batch_finalize($1, $2)`, [await uuid(), s]);
    assert.equal(ended.count, 3);
    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => p.type),
      ['ranking_batch'],
    );
    assert.ok((await sheetAs(friend, seen[0].id)).includes(page.id));
  });
});

describe('the fixed 30-minute window', () => {
  it('a reviewed ranking 29 minutes after the first title joins', async () => {
    await rankFirst('movie', 'Start');
    await rankFirst('movie', 'Start 2');
    await age(29);
    const late = await rankFirst('movie', 'Inside', { text: 'Just in time.' });
    assert.equal(late.result.status, 'joined');
  });

  it('at 30 and at 31 minutes it is outside, and stays its own card', async () => {
    await rankFirst('movie', 'Start');
    await rankFirst('movie', 'Start 2');
    await age(30);
    const edge = await rankFirst('movie', 'Edge', { text: 'Too late.' });
    assert.equal(edge.result.status, 'solo');
    await age(1);
    const later = await rankFirst('movie', 'Past', { text: 'Later still.' });
    assert.equal(later.result.status, 'grouped', 'it pairs with the one just outside');
    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => p.type),
      ['ranking_batch', 'ranking_batch'],
      'two half hours, two posts',
    );
    assert.equal(seen[0].payload.count, 2, 'the first group did not take the late titles');
  });
});

describe('what keeps its treatment', () => {
  it('a reviewed rewatch keeps its own card, and is never a peer', async () => {
    const seen = await rankFirst('movie', 'Seen before', { text: 'First time.', note: false });
    await age(120);
    await rankFirst('movie', 'Fresh');
    await call(`log_rewatch($1, $2, current_date, 'today_default')`, [await uuid(), seen.id]);
    await review(seen.id, 'Even better the second time.');
    const rewatch = (await posts()).find(
      (p) => p.media_item_id === seen.id && p.payload.again === true,
    );
    assert.ok(rewatch, 'the rewatch posted its own activity');
    assert.equal(
      (await call(`rank_group_note($1, $2)`, [await uuid(), seen.id])).reason,
      'not_first',
    );
    const next = await rankFirst('movie', 'Next');
    assert.equal(next.result.status, 'grouped');
    assert.equal((await posts()).find((p) => p.id === rewatch.id).presented_in, null);
    assert.equal(
      (await posts()).find((p) => p.type === 'ranking_batch').payload.count,
      2,
      'the rewatch is not in the group',
    );
  });

  it('a rerank of a reviewed title posts nothing and moves no group', async () => {
    const a = await rankFirst('movie', 'R1', { text: 'Reviewed.' });
    await rankFirst('movie', 'R2');
    const before = await posts();
    let step = await call(`rank_again($1, 'loved', $2, false)`, [a.id, await uuid()]);
    while (!step.done) {
      step = await call(`rank_answer($1, $2, $3)`, [step.session_id, step.pivot, await uuid()]);
    }
    assert.equal(
      (await call(`rank_group_note($1, $2)`, [await uuid(), a.id])).status,
      'skipped',
    );
    const shape = (rows) =>
      rows.map((p) => [p.id, p.type, p.presented_in, p.payload.count ?? null]);
    assert.deepEqual(shape(await posts()), shape(before), 'no post written, none moved');
  });

  it('a standalone reviewed post somebody engaged with stays visible, engagement intact', async () => {
    const engaged = await rankFirst('movie', 'Engaged', { text: 'Worth a conversation.' });
    assert.equal(engaged.result.status, 'solo');
    const post = (await posts()).find((p) => p.media_item_id === engaged.id);
    await t.sql(
      `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
      [post.id, friend],
    );
    await t.sql(
      `insert into comments (feed_event_id, author_id, body) values ($1, $2, 'Agreed')`,
      [post.id, friend],
    );
    const next = await rankFirst('movie', 'Next');
    assert.equal(next.result.status, 'solo', 'the engaged post is not taken as a peer');
    const third = await rankFirst('movie', 'Third');
    assert.equal(third.result.status, 'grouped');

    const seen = await visibleTo(friend);
    assert.ok(
      seen.some((p) => p.id === post.id && p.type === 'title_ranked'),
      'it keeps its card',
    );
    const { rows } = await t.sql(
      `select (select count(*)::int from reactions where feed_event_id = $1) as reactions,
              (select count(*)::int from comments where feed_event_id = $1) as comments`,
      [post.id],
    );
    assert.deepEqual(rows[0], { reactions: 1, comments: 1 });
    assert.equal(await reviewAs(friend, engaged.id), 'Worth a conversation.');
  });

  it('a reviewed ranking reacted to before its note is refused as referenced, as before', async () => {
    const r = await rankFirst('movie', 'Liked', { text: 'Liked.', note: false });
    const post = (await posts()).find((p) => p.media_item_id === r.id);
    await t.sql(
      `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
      [post.id, friend],
    );
    assert.equal(
      (await call(`rank_group_note($1, $2)`, [await uuid(), r.id])).reason,
      'referenced',
    );
  });

  it('a reaction on a hidden reviewed member still gives it its card back', async () => {
    await rankFirst('movie', 'M1');
    await rankFirst('movie', 'M2');
    const m3 = await rankFirst('movie', 'M3', { text: 'Has a review.' });
    const member = (await posts()).find(
      (p) => p.type === 'title_ranked' && p.media_item_id === m3.id,
    );
    assert.notEqual(member.presented_in, null);
    await t.sql(
      `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
      [member.id, friend],
    );
    const after = (await posts()).find((p) => p.id === member.id);
    assert.equal(after.presented_in, null, 'engagement is never orphaned behind a group');
  });
});

describe('privacy, blocks and moderation', () => {
  it("a private author's grouped review reaches approved followers only; a blocked reader gets nothing", async () => {
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [user]);
    await rankFirst('movie', 'P1');
    const reviewed = await rankFirst('movie', 'P2', { text: 'Only for followers.' });
    assert.equal(reviewed.result.status, 'grouped');
    const g = (await posts()).find((p) => p.type === 'ranking_batch');

    assert.equal((await visibleTo(friend)).length, 1);
    assert.ok((await sheetAs(friend, g.id)).includes(reviewed.id));
    assert.equal(await reviewAs(friend, reviewed.id), 'Only for followers.');

    assert.deepEqual(await visibleTo(stranger), []);
    assert.deepEqual(await sheetAs(stranger, g.id), []);
    assert.deepEqual(await railAs(stranger, g.id), []);
    assert.equal(await reviewAs(stranger, reviewed.id), null, 'no leak through the group');

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [user, friend]);
    try {
      assert.deepEqual(await visibleTo(friend), []);
      assert.deepEqual(await sheetAs(friend, g.id), []);
      assert.deepEqual(await railAs(friend, g.id), []);
      assert.equal(await reviewAs(friend, reviewed.id), null);
    } finally {
      await t.sql(`delete from blocks where blocker_id = $1`, [user]);
    }
  });

  it('a blocked reader of a public author sees neither the group nor the review', async () => {
    await rankFirst('movie', 'B1');
    const reviewed = await rankFirst('movie', 'B2', { text: 'Public.' });
    const g = (await posts()).find((p) => p.type === 'ranking_batch');
    assert.equal(await reviewAs(stranger, reviewed.id), 'Public.');
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
      stranger,
      user,
    ]);
    try {
      assert.deepEqual(await visibleTo(stranger), []);
      assert.deepEqual(await sheetAs(stranger, g.id), []);
      assert.equal(await reviewAs(stranger, reviewed.id), null);
    } finally {
      await t.sql(`delete from blocks where blocker_id = $1`, [stranger]);
    }
  });
});
