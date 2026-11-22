import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **Two posts per shared window** (founder, 2026-11-22; 20261130001000, correcting
 * 20261130000900).
 *
 * Per author one fixed 30-minute window, anchored at the first qualifying event of either
 * kind (a first-time ranking, reviewed or not, or a save) and shared by both. Inside it at
 * most two posts: the ranking post (rankings only) and the watchlist post (saves only),
 * each newest first, each moving forward to its own latest activity, keeping its id and
 * conversation as it grows, and notifying nobody. Everything that kept an event apart
 * still does.
 */
let t;
let user;
let friend;
let stranger;
let seq = 0;
let tmdb = 3_100_000;

before(async () => {
  t = await createTestDb();
  friend = await t.createUser({ username: 'as_friend' });
  stranger = await t.createUser({ username: 'as_stranger' });
});

after(async () => t?.close());

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `as_user_${seq}` });
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

/** A first ranking from the title page: log "Today", optional review, rank, then the note. */
async function rank(name, { kind = 'movie', id = null, text = null, note = true } = {}) {
  const mediaItemId = id ?? (await title(kind, name));
  await call(`log_title($1, $2, 'loved', current_date, 'today_default'::watch_date_basis)`, [
    await uuid(),
    mediaItemId,
  ]);
  if (text) {
    await call(`save_note($1, $2, $3, null, 'public'::note_visibility, false)`, [
      await uuid(),
      mediaItemId,
      text,
    ]);
  }
  await t.rankToCompletion(mediaItemId, 'loved', (pivot, subject) => subject);
  const result = note
    ? await call(`rank_group_note($1, $2)`, [await uuid(), mediaItemId])
    : null;
  return { id: mediaItemId, result };
}

async function save(name, { id = null } = {}) {
  const mediaItemId = id ?? (await title('movie', name));
  await call(`set_watchlist($1, $2, true)`, [await uuid(), mediaItemId]);
  return mediaItemId;
}

/** Moves every one of the actor's posts, and any window they anchor, `minutes` back. */
async function age(minutes) {
  await t.sql(
    `update feed_events
        set created_at = created_at - make_interval(mins => $2::int),
            causal_at  = causal_at  - make_interval(mins => $2::int),
            payload = payload
              || case when payload ? 'started_at'
                      then jsonb_build_object('started_at',
                             (payload ->> 'started_at')::timestamptz - make_interval(mins => $2::int))
                      else '{}'::jsonb end
              || case when payload ? 'last_activity_at'
                      then jsonb_build_object('last_activity_at',
                             (payload ->> 'last_activity_at')::timestamptz - make_interval(mins => $2::int))
                      else '{}'::jsonb end
      where actor_id = $1`,
    [user, minutes],
  );
  await t.sql(
    `update feed_watchlist_titles set added_at = added_at - make_interval(mins => $2::int)
      where actor_id = $1`,
    [user, minutes],
  );
}

/** Runs `fn` as `viewer` under RLS, then acts as the author again. */
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
      `select id, type, media_item_id, payload, presented_in, created_at, causal_at, causal_step
         from feed_events where actor_id = $1 order by causal_at, id`,
      [user],
    )
  ).rows;

const visibleTo = (viewer) =>
  as(viewer, async () => {
    const { rows } = await t.sql(
      `select id, type, media_item_id, payload from feed_events where actor_id = $1
        order by causal_at desc, causal_step desc, id`,
      [user],
    );
    return rows;
  });

const railAs = (viewer, eventId) =>
  as(
    viewer,
    async () =>
      (
        await t.sql(
          `select media_item_id, action, score, ranked from feed_group_previews(array[$1]::uuid[], 12)
          order by ordinal`,
          [eventId],
        )
      ).rows,
  );

const sheetAs = (viewer, eventId) =>
  as(
    viewer,
    async () =>
      (
        await t.sql(
          `select media_item_id, action, position, score from ranking_batch_titles($1)`,
          [eventId],
        )
      ).rows,
  );

/** The anchor every visible row of the window carries, moved `seconds` into the past. */
async function anchorAgo(seconds) {
  await t.sql(
    `update feed_events
        set payload = payload || jsonb_build_object('started_at', now() - make_interval(secs => $2::int))
      where actor_id = $1 and presented_in is null and payload ? 'started_at'`,
    [user, seconds],
  );
}

const anchors = async () =>
  new Set(
    (
      await t.sql(
        `select (payload ->> 'started_at')::timestamptz as a from feed_events
          where actor_id = $1 and presented_in is null and payload ? 'started_at'`,
        [user],
      )
    ).rows.map((r) => r.a.getTime()),
  );

const byType = (rows, type) => rows.filter((p) => p.type === type);

const notificationCount = async () =>
  Number((await t.sql(`select count(*)::int as n from notifications`)).rows[0].n);

describe('two posts per shared window', () => {
  it('3:00 rank A · 3:04 save B · 3:07 save C · 3:10 rank D · 3:14 save E · 3:18 rank F: exactly two posts', async () => {
    const a = await rank('A');
    await age(4);
    const b = await save('B');
    await age(3);
    const c = await save('C');
    await age(3);
    const d = await rank('D');
    await age(4);
    const e = await save('E');
    await age(4);
    const f = await rank('F');

    const seen = await visibleTo(friend);
    assert.equal(seen.length, 2, 'exactly two posts');
    const [ranking] = byType(seen, 'ranking_batch');
    const [watchlist] = byType(seen, 'watchlist_added');
    assert.ok(ranking && watchlist);

    assert.equal(ranking.media_item_id, f.id, 'the newest ranking leads');
    assert.equal(ranking.payload.count, 3);
    assert.equal(ranking.payload.ranked, 3);
    assert.equal(ranking.payload.saved, 0);
    assert.equal(ranking.payload.lead_action, 'ranked');
    const rail = await railAs(friend, ranking.id);
    assert.deepEqual(
      rail.map((r) => r.media_item_id),
      [f.id, d.id, a.id],
      'rankings only, newest first',
    );
    assert.ok(rail.every((r) => r.action === 'ranked' && r.score !== null));

    assert.equal(watchlist.media_item_id, e, 'the newest save leads');
    assert.equal(watchlist.payload.count, 3);
    assert.equal(watchlist.payload.saved, 3);
    assert.equal(watchlist.payload.ranked, 0);
    const saves = await railAs(friend, watchlist.id);
    assert.deepEqual(
      saves.map((r) => r.media_item_id),
      [e, c, b],
      'saves only, newest first',
    );
    assert.ok(saves.every((r) => r.action === 'saved' && r.score === null));

    assert.equal((await anchors()).size, 1, 'both posts carry the one window anchor');
    const first = (await posts()).find(
      (p) => p.media_item_id === a.id && p.type === 'title_ranked',
    );
    assert.equal(
      new Date(ranking.payload.started_at).getTime(),
      first.created_at.getTime(),
      'anchored at the first event, a ranking',
    );
  });

  it('rank, save, rank, save: two posts, each moving to its own latest activity', async () => {
    await rank('R1');
    await age(2);
    await save('S1');
    await age(2);
    await rank('R2');
    await age(2);
    const s2 = await save('S2');
    const seen = await visibleTo(friend);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].type, 'watchlist_added', 'the save is the newest activity');
    assert.equal(seen[0].media_item_id, s2);
    const [r] = byType(seen, 'ranking_batch');
    assert.equal(r.payload.count, 2);
    assert.equal(byType(seen, 'watchlist_added')[0].payload.count, 2);
    const all = await posts();
    const rPost = all.find((p) => p.id === r.id);
    const wPost = all.find((p) => p.id === seen[0].id);
    assert.ok(wPost.causal_at > rPost.causal_at, 'each at its own category’s latest');
  });

  it('rankings only: one ranking post; saves only: one watchlist post', async () => {
    await rank('R1');
    await rank('R2');
    await rank('R3');
    let seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => [p.type, p.payload.count]),
      [['ranking_batch', 3]],
    );
    await age(60);
    await save('S1');
    await save('S2');
    seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => [p.type, p.payload.count]),
      [
        ['watchlist_added', 2],
        ['ranking_batch', 3],
      ],
    );
  });

  it('a save never joins a ranking post, and a ranking never joins a watchlist post', async () => {
    await save('S1');
    const r1 = await rank('R1');
    assert.equal(r1.result.status, 'solo', 'not joined to the watchlist post');
    const r2 = await rank('R2');
    assert.equal(r2.result.status, 'grouped');
    await save('S2');
    const seen = await visibleTo(friend);
    const [r] = byType(seen, 'ranking_batch');
    const [w] = byType(seen, 'watchlist_added');
    const sheet = await sheetAs(friend, r.id);
    assert.equal(sheet.length, 2);
    assert.ok(sheet.every((row) => row.action === 'ranked'));
    const wTitles = await as(
      friend,
      async () =>
        (await t.sql(`select media_item_id from watchlist_group_titles($1)`, [w.id])).rows,
    );
    assert.equal(wTitles.length, 2);
  });

  it('reviewed and unreviewed first rankings group the same way', async () => {
    const a = await rank('Reviewed first', { text: 'A review.' });
    assert.equal(a.result.status, 'solo');
    const b = await rank('Plain');
    assert.equal(b.result.status, 'grouped');
    const c = await rank('Reviewed later', { text: 'Another review.' });
    assert.equal(c.result.status, 'joined');
    const d = await rank('Plain again');
    assert.equal(d.result.status, 'joined');
    const seen = await visibleTo(friend);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].payload.count, 4);
    // The reviews themselves are untouched and readable.
    const notes = await as(
      friend,
      async () =>
        (
          await t.sql(
            `select media_item_id from public_notes(array[$1]::uuid[], array[$2, $3]::uuid[], 10)`,
            [user, a.id, c.id],
          )
        ).rows,
    );
    assert.equal(notes.length, 2);
  });

  it('the same title saved and then ranked is in each category’s post, once in each', async () => {
    const x = await save('Both');
    const r = await rank('Both', { id: x });
    assert.equal(r.result.status, 'solo');
    const y = await rank('Other');
    assert.equal(y.result.status, 'grouped');
    const seen = await visibleTo(friend);
    assert.equal(seen.length, 2);
    const [rp] = byType(seen, 'ranking_batch');
    const [wp] = byType(seen, 'watchlist_added');
    assert.deepEqual(
      (await railAs(friend, rp.id)).map((m) => m.media_item_id).sort(),
      [x, y.id].sort(),
    );
    assert.deepEqual(
      (await railAs(friend, wp.id)).map((m) => m.media_item_id),
      [x],
    );
    await save('Another save');
    const rail = await railAs(friend, wp.id);
    assert.equal(new Set(rail.map((m) => m.media_item_id)).size, rail.length, 'no duplicate');
  });
});

describe('the shared window', () => {
  it('a ranking at 29:59 after a save joins its window; at 30:00 it opens the next', async () => {
    await save('Opens');
    await anchorAgo(29 * 60 + 59);
    const a = await rank('At 29:59');
    const first = (await posts()).find((p) => p.media_item_id === a.id);
    assert.equal((await anchors()).size, 1, 'the ranking took the save’s anchor');
    assert.notEqual(
      new Date(first.payload.started_at).getTime(),
      first.created_at.getTime(),
      'anchored on the save, not itself',
    );

    await anchorAgo(30 * 60);
    const b = await rank('At 30:00');
    assert.equal(b.result.status, 'solo', 'a new window, so no pair with the earlier ranking');
    await save('Also at 30:00');
    const seen = await visibleTo(friend);
    assert.equal(byType(seen, 'watchlist_added').length, 2, 'the save opened a new post');
  });

  it('switching kinds never restarts the window: rank, save at 20, rank at 35 opens the next', async () => {
    await rank('R at 0');
    await anchorAgo(20 * 60);
    await save('S at 20');
    await anchorAgo(35 * 60);
    const late = await rank('R at 35');
    assert.equal(late.result.status, 'solo', 'not paired with R at 0: that window has ended');
    const seen = await visibleTo(friend);
    assert.equal(byType(seen, 'title_ranked').length, 2);
  });

  it('with sessions switched off, each kind keeps its own window (the 20261130000800 rule)', async () => {
    await t.sql(
      `update app_config set value = 'false'::jsonb where key = 'feed.activity_sessions_enabled'`,
    );
    try {
      await save('S at 0');
      await anchorAgo(20 * 60);
      await rank('R at 20');
      const r = (await posts()).find((p) => p.type === 'title_ranked');
      assert.equal(
        new Date(r.payload.started_at).getTime(),
        r.created_at.getTime(),
        'the ranking’s own window, not the save’s',
      );
      await t.sql(
        `update feed_events
            set payload = payload || jsonb_build_object('started_at', now() - interval '15 minutes'),
                created_at = now() - interval '15 minutes'
          where id = $1`,
        [r.id],
      );
      const late = await rank('R at 35');
      assert.equal(late.result.status, 'grouped', 'inside the ranking’s own window');
    } finally {
      await t.sql(
        `update app_config set value = 'true'::jsonb where key = 'feed.activity_sessions_enabled'`,
      );
    }
  });

  it('a ranking noted late, after a save opened the window, is the window’s first event', async () => {
    const r = await rank('Ranked first, noted late', { note: false });
    await t.sql(
      `update feed_events set created_at = created_at - interval '5 minutes',
              causal_at = causal_at - interval '5 minutes'
        where actor_id = $1 and type = 'title_ranked'`,
      [user],
    );
    await save('Saved meanwhile');
    const noted = await call(`rank_group_note($1, $2)`, [await uuid(), r.id]);
    assert.equal(noted.status, 'solo');
    const all = await posts();
    const ranking = all.find((p) => p.type === 'title_ranked');
    const watchlist = all.find((p) => p.type === 'watchlist_added');
    assert.equal(
      new Date(watchlist.payload.started_at).getTime(),
      ranking.created_at.getTime(),
      'the watchlist post’s window now starts at the ranking',
    );
    assert.equal((await anchors()).size, 1);
    // 30 minutes after the ranking, not after the save: the next save starts a new post.
    await anchorAgo(30 * 60);
    await save('Too late');
    assert.equal(byType(await visibleTo(friend), 'watchlist_added').length, 2);
  });
});

describe('a late note never joins a later window (Codex, PR 357)', () => {
  it('save at 0:00, rank at 0:20 noted at 0:40 after a group formed at 0:35: it stays in its own window', async () => {
    const s = await save('Opens at 0:00');
    await t.sql(
      `update feed_events
          set created_at = now() - interval '40 minutes', causal_at = now() - interval '40 minutes',
              payload = payload || jsonb_build_object('started_at', now() - interval '40 minutes')
        where actor_id = $1 and media_item_id = $2`,
      [user, s],
    );
    const late = await rank('Ranked at 0:20', { note: false });
    await t.sql(
      `update feed_events set created_at = now() - interval '20 minutes',
              causal_at = now() - interval '20 minutes'
        where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
      [user, late.id],
    );
    await rank('Ranked at 0:35');
    const group = await rank('Ranked at 0:36');
    assert.equal(group.result.status, 'grouped');

    const noted = await call(`rank_group_note($1, $2)`, [await uuid(), late.id]);
    assert.equal(noted.status, 'solo', 'not joined to the later window’s group');
    const all = await posts();
    const row = all.find((p) => p.type === 'title_ranked' && p.media_item_id === late.id);
    assert.equal(row.presented_in, null);
    const w = all.find((p) => p.type === 'watchlist_added');
    assert.equal(row.payload.started_at, w.payload.started_at, 'in the save’s window');
    assert.equal(all.find((p) => p.id === group.result.event_id).payload.count, 2);
  });
});

describe('what keeps its own card', () => {
  it('a rewatch and a TV update are never members', async () => {
    const old = await rank('Seen before', { note: false });
    await age(120);
    await save('Saved now');
    await call(`log_rewatch($1, $2, current_date, 'today_default')`, [await uuid(), old.id]);
    const again = await call(`rank_group_note($1, $2)`, [await uuid(), old.id]);
    assert.notEqual(again.status, 'joined');
  });

  it('a referenced single ranking stays standalone beside the window’s watchlist post', async () => {
    const a = await rank('Liked', { note: false });
    const [post] = await posts();
    await t.actAs(friend);
    await t.sql(`select set_reaction($1, $2, 'love')`, [await uuid(), post.id]);
    await t.actAs(user);
    const r = await call(`rank_group_note($1, $2)`, [await uuid(), a.id]);
    assert.equal(r.reason, 'referenced');
    await save('After');
    const seen = await visibleTo(friend);
    assert.deepEqual(
      new Set(seen.map((p) => p.type)),
      new Set(['title_ranked', 'watchlist_added']),
    );
  });

  it('a reaction on a hidden ranking gives it its card back; the group shrinks and stays a ranking post', async () => {
    await rank('R1');
    const b = await rank('R2');
    await rank('R3');
    const member = (await posts()).find(
      (p) => p.type === 'title_ranked' && p.media_item_id === b.id,
    );
    await t.sql(
      `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
      [member.id, friend],
    );
    const all = await posts();
    assert.equal(all.find((p) => p.id === member.id).presented_in, null);
    const group = all.find((p) => p.id === b.result.event_id);
    assert.equal(group.type, 'ranking_batch');
    assert.equal(group.payload.count, 2);
  });
});

describe('engagement, privacy and links', () => {
  it('an engaged post gains members: one card, its reactions and comments kept, nobody notified', async () => {
    await save('First');
    const [w] = await posts();
    await t.actAs(friend);
    await t.sql(`select add_comment($1, $2, 'nice list', false)`, [await uuid(), w.id]);
    await t.sql(`select set_reaction($1, $2, 'love')`, [await uuid(), w.id]);
    await t.actAs(user);
    const notified = await notificationCount();

    await save('Second');
    await rank('Third');
    await rank('Fourth');

    const seen = await visibleTo(friend);
    assert.equal(seen.length, 2);
    const kept = seen.find((p) => p.id === w.id);
    assert.equal(kept.payload.count, 2, 'the saves, and only the saves');
    const { rows } = await t.sql(
      `select (select count(*)::int from comments where feed_event_id = $1) as comments,
              (select count(*)::int from reactions where feed_event_id = $1) as reactions`,
      [w.id],
    );
    assert.deepEqual(rows[0], { comments: 1, reactions: 1 });
    assert.equal(await notificationCount(), notified, 'growth writes no notification');
  });

  it('a stale link to an absorbed ranking resolves in one hop to the ranking post', async () => {
    const a = await rank('A');
    const b = await rank('B');
    assert.equal(b.result.status, 'grouped');
    await save('C');
    const member = (await posts()).find(
      (p) => p.type === 'title_ranked' && p.media_item_id === a.id,
    );
    const resolved = await as(
      friend,
      async () =>
        (await t.sql(`select feed_event_presentation($1) as g`, [member.id])).rows[0].g,
    );
    assert.equal(resolved, b.result.event_id);
  });

  it('a private author: approved followers see both posts, a stranger nothing; a block hides them', async () => {
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [user]);
    await save('P1');
    await save('P2');
    await rank('P3');
    await rank('P4');
    const seen = await visibleTo(friend);
    assert.equal(seen.length, 2);
    for (const post of seen) assert.equal((await railAs(friend, post.id)).length, 2);

    assert.deepEqual(await visibleTo(stranger), []);
    for (const post of seen) {
      assert.deepEqual(await railAs(stranger, post.id), []);
      assert.deepEqual(await sheetAs(stranger, post.id), []);
    }

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [user, friend]);
    try {
      assert.deepEqual(await visibleTo(friend), []);
      for (const post of seen) assert.deepEqual(await railAs(friend, post.id), []);
    } finally {
      await t.sql(`delete from blocks where blocker_id = $1`, [user]);
    }
  });
});

describe('a catalogue delete', () => {
  it('of a ranking post’s newest title keeps the post, its conversation and its category', async () => {
    await rank('Kept');
    const deleted = await rank('Deleted');
    const [post] = byType(await visibleTo(friend), 'ranking_batch');
    assert.equal(post.media_item_id, deleted.id);
    await t.actAs(friend);
    await t.sql(`select add_comment($1, $2, 'keep this', false)`, [await uuid(), post.id]);
    await t.actAs(user);
    await t.sql(`delete from media_items where id = $1`, [deleted.id]);
    const kept = (await posts()).find((p) => p.id === post.id);
    assert.ok(kept, 'the post survived');
    assert.equal(kept.type, 'ranking_batch');
    assert.equal(kept.payload.count, 1);
  });
});

/**
 * The production bundles cannot be imported here, so their contract is: 55db8b2b (before
 * 20261130000900) reads a group's `type`, `payload.count`, and each preview row's `ranked`
 * and `score`, drawing "ranked 3 titles" and "added 3 titles to their watchlist"; 8e66e9ca
 * (20261130000900) also reads `payload.session`, `ranked`, `saved`, `lead_action`,
 * `last_activity_at` and each row's `action`, drawing "ranked F + 2 more" with no split line
 * (it draws one only when both counts are above zero). Both posts of a window satisfy both.
 */
describe('what the bundles in the field read', () => {
  it('each post is one kind in every field an older bundle reads', async () => {
    await rank('R1');
    await save('S1');
    await rank('R2');
    await save('S2');
    for (const post of await visibleTo(friend)) {
      const p = post.payload;
      const rows = await as(
        friend,
        async () =>
          (
            await t.sql(
              `select ranked, score, action from feed_group_previews(array[$1]::uuid[], 12)`,
              [post.id],
            )
          ).rows,
      );
      assert.equal(rows.length, p.count);
      assert.equal(p.session, true);
      assert.ok(typeof p.last_activity_at === 'string');
      if (post.type === 'ranking_batch') {
        assert.deepEqual([p.ranked, p.saved, p.lead_action], [2, 0, 'ranked']);
        assert.ok(
          rows.every((r) => r.ranked === true && r.score !== null && r.action === 'ranked'),
        );
      } else {
        assert.equal(post.type, 'watchlist_added');
        assert.deepEqual([p.ranked, p.saved, p.lead_action], [0, 2, 'saved']);
        assert.ok(
          rows.every((r) => r.ranked === false && r.score === null && r.action === 'saved'),
        );
      }
    }
  });
});

describe('recency and pagination', () => {
  /** The Feed's own keyset, as `activityRows` sends it, for `viewer`. */
  const page = (viewer, actors, cursor, limit) =>
    as(viewer, async () => {
      const where = cursor
        ? `and (causal_at < $3 or (causal_at = $3 and causal_step < $4)
                or (causal_at = $3 and causal_step = $4 and id > $5))`
        : '';
      const params = cursor
        ? [actors, limit, cursor.causal_at, cursor.causal_step, cursor.id]
        : [actors, limit];
      const { rows } = await t.sql(
        `select id, causal_at, causal_step from feed_events
          where actor_id = any ($1::uuid[]) ${where}
          order by causal_at desc, causal_step desc, id
          limit $2`,
        params,
      );
      return rows;
    });

  it('a growing session moves forward, never back, and keeps created_at and started_at', async () => {
    await save('One');
    const [w0] = await posts();
    await age(10);
    await save('Two');
    const [w1] = await posts();
    assert.ok(w1.causal_at > w0.causal_at - 10 * 60_000, 'moved forward');
    assert.equal(w1.created_at.getTime(), w0.created_at.getTime() - 10 * 60_000);
    assert.equal(
      new Date(w1.payload.started_at).getTime(),
      new Date(w0.payload.started_at).getTime() - 10 * 60_000,
      'started_at is the anchor and never moves on its own',
    );
    assert.equal(w1.causal_step, 0);
  });

  it('a card that moves while a reader pages is never served twice, and is at the top on refresh', async () => {
    // Three people: the session's author and two others, interleaved in time.
    const other = await t.createUser({ username: `as_other_${seq}` });
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [friend, other],
    );
    const actors = [user, other];
    await save('Session start');
    const [session] = await posts();
    await age(20);
    await t.actAs(other);
    for (let i = 0; i < 4; i += 1) {
      await call(`set_watchlist($1, $2, true)`, [await uuid(), await title('movie', `O${i}`)]);
      // One post each: no window can hold them.
      await t.sql(
        `update feed_events set created_at = created_at - interval '1 hour',
                causal_at = causal_at - make_interval(mins => 10 - $2::int),
                payload = payload || jsonb_build_object('started_at', now() - interval '1 hour')
          where actor_id = $1 and causal_at > now() - interval '1 minute'`,
        [other, i],
      );
    }
    await t.actAs(user);

    const first = await page(friend, actors, null, 2);
    const seenIds = new Set(first.map((r) => r.id));
    assert.ok(!seenIds.has(session.id), 'the session starts below the first page');

    // The reader is mid-scroll; the session gains a member and moves to the top.
    await save('Joins later');
    const second = await page(friend, actors, first.at(-1), 2);
    const third = await page(friend, actors, second.at(-1), 10);
    const later = [...second, ...third].map((r) => r.id);
    assert.ok(
      later.every((id) => !seenIds.has(id)),
      'no duplicate across the boundary',
    );
    assert.equal(new Set(later).size, later.length);

    const refreshed = await page(friend, actors, null, 2);
    assert.equal(refreshed[0].id, session.id, 'on refresh it leads, with the same id');
  });

  it('a card already read that then moves is not served again below the cursor', async () => {
    await save('Top');
    const [session] = await posts();
    const first = await page(friend, [user], null, 1);
    assert.equal(first[0].id, session.id);
    await save('Grows');
    const rest = await page(friend, [user], first[0], 10);
    assert.ok(!rest.some((r) => r.id === session.id));
  });
});

describe('an Unranked sitting', () => {
  async function sittingOf(name, { startedMinutesAgo = 2 } = {}) {
    const s = await uuid();
    const film = await title('movie', name);
    await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [
      user,
      film,
    ]);
    await t.rankToCompletion(film, 'loved', (pivot, subject) => subject);
    await call(`rank_batch_note($1, $2, $3)`, [await uuid(), s, film]);
    await t.sql(
      `update feed_ranking_titles set placed_at = placed_at - make_interval(mins => $2::int)
        where event_id = (select id from feed_events
                           where actor_id = $1 and type = 'ranking_batch_draft')`,
      [user, startedMinutesAgo],
    );
    return { s, film };
  }

  it('in a window a save opened, it publishes the window’s ranking post and never presents the save', async () => {
    const saved = await save('Saved first');
    await anchorAgo(5 * 60);
    const { s } = await sittingOf('Backlog', { startedMinutesAgo: 2 });
    const done = await call(`rank_batch_finalize($1, $2)`, [await uuid(), s]);
    assert.equal(done.status, 'ok');
    const seen = await visibleTo(friend);
    assert.equal(seen.length, 2, 'the ranking post and the watchlist post');
    const [w] = byType(seen, 'watchlist_added');
    assert.equal(w.media_item_id, saved);
    assert.equal(w.payload.count, 1);
    assert.equal((await anchors()).size, 1, 'one window');
  });

  it('a sitting that began during an earlier sitting’s window joins its ranking post', async () => {
    const first = await sittingOf('First sitting', { startedMinutesAgo: 6 });
    await call(`rank_batch_finalize($1, $2)`, [await uuid(), first.s]);
    const second = await sittingOf('Second sitting', { startedMinutesAgo: 1 });
    const done = await call(`rank_batch_finalize($1, $2)`, [await uuid(), second.s]);
    assert.equal(done.joined, true);
    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => [p.type, p.payload.count]),
      [['ranking_batch', 2]],
    );
  });
});
