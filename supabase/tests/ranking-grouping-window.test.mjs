import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb } from './harness.mjs';

/**
 * **A half hour of first rankings is one post** (founder report 2026-11-20,
 * 20261130000200).
 *
 * Two or more eligible first-time rankings by one person inside a fixed 30-minute window
 * are one grouped ranking post, whatever watch date the reader chose. 20261128000100 asked
 * for "historical" watch evidence and so left almost every title-page ranking standalone:
 * the log sheet offers "Today", and almost everybody keeps it. These tests hold the new
 * rule and every guard around it: the window's edges, mixed ladders, watchlist saves,
 * rewatches, reviews, corrections, manual moves and Refine, interactions and protected
 * references, privacy, and that grouping invents no notification, watch or placement.
 */
const here = dirname(fileURLToPath(import.meta.url));
let t;
let user;
let friend;
let stranger;
let seq = 0;
let tmdb = 1_300_000;

before(async () => {
  t = await createTestDb();
  friend = await t.createUser({ username: 'rgw_friend' });
  stranger = await t.createUser({ username: 'rgw_stranger' });
});

after(async () => t?.close());

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `rgw_user_${seq}` });
  await t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
    [friend, user],
  );
  await t.actAs(user);
});

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

/** A new title of `kind`: a movie, a show (series) or a season of a new show. */
async function title(kind, name) {
  if (kind === 'season') {
    const show = await t.createSeries(`${name} ${seq}`, (tmdb += 1));
    return t.createSeason(show, 1, `${name} ${seq} S1`);
  }
  if (kind === 'show') return t.createSeries(`${name} ${seq}`, (tmdb += 1));
  return t.createMovie(`${name} ${seq}`, (tmdb += 1));
}

/**
 * A first-time ranking as the title page makes it after the log sheet: a watch dated
 * "Today" (the default nearly everybody keeps), then the ranking, then the sheet's note.
 */
async function rankFirst(kind, name, { basis = 'today_default', note = true } = {}) {
  const id = await title(kind, name);
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  if (basis) {
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, case when $3 = 'none' then null else current_date end, $3::watch_date_basis)`,
      [user, id, basis],
    );
  }
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  const result = note ? await call(`rank_group_note($1, $2)`, [await uuid(), id]) : null;
  return { id, result };
}

/** Moves the actor's existing ranking posts (and any group's window) `minutes` into the past. */
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

const posts = async () =>
  (
    await t.sql(
      `select id, type, media_item_id, payload, presented_in, causal_at, created_at
         from feed_events where actor_id = $1 order by causal_at, id`,
      [user],
    )
  ).rows;

/** What a client sees of the actor's activity: RLS applied, as the Feed reads it. */
const visibleTo = (viewer) =>
  t.asUser(viewer, async () => {
    const { rows } = await t.sql(
      `select id, type, media_item_id, payload from feed_events where actor_id = $1 order by causal_at, id`,
      [user],
    );
    return rows;
  });

const previewsAs = (viewer, eventId) =>
  t.asUser(viewer, async () => {
    const { rows } = await t.sql(
      `select media_item_id, kind, score, ranked from feed_group_previews(array[$1]::uuid[], 12)
        order by ordinal`,
      [eventId],
    );
    return rows;
  });

/** The author's current score for a title, exactly as the Collection derives it. */
const currentScore = async (mediaItemId) =>
  (
    await t.sql(
      `select score_for(r.bucket, (r.position - b.lo + 1)::integer, b.size) as s
         from rankings r cross join lateral band_bounds(r.user_id, r.category, r.bucket) b
        where r.user_id = $1 and r.media_item_id = $2`,
      [user, mediaItemId],
    )
  ).rows[0]?.s;

const counts = async () =>
  (
    await t.sql(
      `select (select count(*)::int from notifications) as notifications,
              (select count(*)::int from watch_events where user_id = $1) as watches,
              (select count(*)::int from ranking_placements where user_id = $1) as placements,
              (select count(*)::int from rankings where user_id = $1) as rankings`,
      [user],
    )
  ).rows[0];

describe('the founder reproduction', () => {
  it('two first-time movie rankings minutes apart are one carousel, with scores, and it persists', async () => {
    const a = await rankFirst('movie', 'First film');
    assert.equal(a.result.status, 'solo', 'one ranking stays its own card until a second');
    await age(4);
    const b = await rankFirst('movie', 'Second film', { note: false });
    const before = await counts();
    b.result = await call(`rank_group_note($1, $2)`, [await uuid(), b.id]);
    assert.equal(b.result.status, 'grouped');
    assert.equal(b.result.count, 2);
    assert.deepEqual(
      await counts(),
      before,
      'grouping wrote no notification, watch event, placement or ranking',
    );

    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => p.type),
      ['ranking_batch'],
      'the friend sees one ranking post, not two cards and not the group as well',
    );
    const group = seen[0];
    assert.equal(group.payload.count, 2);
    const rail = await previewsAs(friend, group.id);
    assert.deepEqual(
      rail.map((r) => r.media_item_id),
      [a.id, b.id],
      'the carousel shows both titles, in the order they were ranked',
    );
    for (const row of rail) {
      assert.equal(row.ranked, true);
      assert.equal(
        Number(row.score),
        Number(await currentScore(row.media_item_id)),
        "each poster carries the author's current score",
      );
    }

    // Grouping is a write, not a read-time view: a refresh and a fresh session read the
    // same stored group. A replayed note changes nothing.
    const again = await visibleTo(friend);
    assert.deepEqual(again, seen);
    const replay = await t.asUser(stranger, () => visibleTo(friend));
    assert.deepEqual(replay, seen);
    assert.equal(
      (await call(`rank_group_note($1, $2)`, [await uuid(), b.id])).reason,
      'no_post',
      'a second note for the same title finds no single card to group',
    );
    assert.deepEqual(await visibleTo(friend), seen, 'the group persists');
    assert.deepEqual(await counts(), before, 'and reading it back invents nothing either');
  });

  it('a "Today" ranking, an undated one and one with no watch at all group the same way', async () => {
    await rankFirst('movie', 'Today');
    await rankFirst('movie', 'Undated', { basis: 'none' });
    const third = await rankFirst('movie', 'No watch', { basis: null });
    assert.equal(third.result.status, 'joined');
    assert.equal(third.result.count, 3);
  });
});

describe('the fixed 30-minute window', () => {
  it('29 minutes after the first title is inside', async () => {
    await rankFirst('movie', 'Early');
    await age(29);
    assert.equal((await rankFirst('movie', 'Late')).result.status, 'grouped');
  });

  it('31 minutes after is outside: both stay single cards, and the late one can pair next', async () => {
    await rankFirst('movie', 'Early');
    await age(31);
    const late = await rankFirst('movie', 'Late');
    assert.equal(late.result.status, 'solo');
    assert.ok(
      (await posts()).every((p) => p.presented_in === null && p.type === 'title_ranked'),
    );
    await age(10);
    const next = await rankFirst('movie', 'Next');
    assert.equal(next.result.status, 'grouped');
    const g = (await posts()).find((p) => p.type === 'ranking_batch');
    const members = (await posts())
      .filter((p) => p.presented_in === g.id)
      .map((p) => p.media_item_id);
    assert.deepEqual(
      new Set(members),
      new Set([late.id, next.id]),
      'the early one is not pulled in',
    );
  });

  it('a note that arrives late groups by the ranking’s own time, and the group stands where the first title did', async () => {
    const early = await rankFirst('movie', 'Ranked first, noted late', { note: false });
    await age(3);
    const later = await rankFirst('movie', 'Ranked second, noted at once');
    assert.equal(later.result.status, 'solo');
    const noted = await call(`rank_group_note($1, $2)`, [await uuid(), early.id]);
    assert.equal(noted.status, 'grouped');
    const all = await posts();
    const g = all.find((p) => p.type === 'ranking_batch');
    const first = all.find((p) => p.media_item_id === early.id);
    assert.equal(g.created_at.getTime(), first.created_at.getTime());
    assert.equal(g.causal_at.getTime(), first.causal_at.getTime());
    assert.equal(g.media_item_id, early.id);
  });

  it('exactly 30 minutes is outside', async () => {
    await rankFirst('movie', 'Edge 1');
    await age(30);
    assert.equal((await rankFirst('movie', 'Edge 2')).result.status, 'solo');
  });

  it('the window is fixed from the first title: a ranking at 31 minutes does not join, even if the last joined at 25', async () => {
    await rankFirst('movie', 'W1');
    await age(25);
    assert.equal((await rankFirst('movie', 'W2')).result.status, 'grouped');
    await age(6);
    const late = await rankFirst('movie', 'W3');
    assert.equal(late.result.status, 'solo', 'not a sliding window');
    const visible = await visibleTo(friend);
    assert.deepEqual(
      visible.map((p) => p.type),
      ['ranking_batch', 'title_ranked'],
    );
  });
});

describe('what may share a group, and what never does', () => {
  it('a movie, a show and a season share one group, each scored on its own ladder', async () => {
    await rankFirst('movie', 'Film');
    await rankFirst('show', 'Show');
    const season = await rankFirst('season', 'Season');
    assert.equal(season.result.status, 'joined');
    const [g] = await visibleTo(friend);
    assert.equal(g.type, 'ranking_batch');
    assert.equal(g.payload.count, 3);
    const rail = await previewsAs(friend, g.id);
    assert.deepEqual(
      rail.map((r) => r.kind),
      ['movie', 'series', 'season'],
    );
    for (const row of rail) {
      assert.notEqual(row.score, null, `${row.kind} carries its score`);
      assert.equal(Number(row.score), Number(await currentScore(row.media_item_id)));
    }
    const { rows } = await t.sql(`select category from ranking_batch_titles($1)`, [g.id]);
    assert.deepEqual(
      rows.map((r) => r.category),
      ['movies', 'tv_shows', 'tv_seasons'],
    );
  });

  it('a watchlist save in the same minutes is never merged into the ranking group', async () => {
    const saved = await title('movie', 'Saved');
    await call(`set_watchlist($1, $2, true)`, [await uuid(), saved]);
    await rankFirst('movie', 'R1');
    await rankFirst('movie', 'R2');
    const visible = await visibleTo(friend);
    assert.deepEqual(
      new Set(visible.map((p) => p.type)),
      new Set(['watchlist_added', 'ranking_batch']),
    );
    const g = visible.find((p) => p.type === 'ranking_batch');
    const titles = (await previewsAs(friend, g.id)).map((r) => r.media_item_id);
    assert.ok(!titles.includes(saved), 'the save is not one of the ranking titles');
    assert.equal(g.payload.count, 2);
  });

  it('a rewatch keeps its own card and is never a peer', async () => {
    const old = await rankFirst('movie', 'Seen before', { note: false });
    await age(120);
    await rankFirst('movie', 'Fresh');
    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await uuid(),
      old.id,
    ]);
    assert.notEqual(logged?.status, 'error');
    const rewatch = (await posts()).find(
      (p) => p.media_item_id === old.id && p.payload.again === true,
    );
    assert.ok(rewatch, 'the rewatch posted its own activity');
    assert.equal(
      (await call(`rank_group_note($1, $2)`, [await uuid(), old.id])).reason,
      'not_first',
    );
    const next = await rankFirst('movie', 'Next');
    assert.equal(next.result.status, 'grouped');
    const after = (await posts()).find((p) => p.id === rewatch.id);
    assert.equal(after.presented_in, null, 'the rewatch is still its own card');
    assert.equal((await posts()).find((p) => p.type === 'ranking_batch').payload.count, 2);
  });

  it('a published review keeps its own card; a review written later restores it', async () => {
    const first = await rankFirst('movie', 'Plain');
    const reviewedId = await title('movie', 'Reviewed');
    await t.sql(
      `insert into user_media (user_id, media_item_id, note, note_visibility) values ($1, $2, 'Superb.', 'public')`,
      [user, reviewedId],
    );
    await t.rankToCompletion(reviewedId, 'loved', (pivot, subject) => subject);
    assert.equal(
      (await call(`rank_group_note($1, $2)`, [await uuid(), reviewedId])).reason,
      'reviewed',
    );
    const third = await rankFirst('movie', 'Third');
    assert.equal(third.result.status, 'grouped');
    const visible = await visibleTo(friend);
    assert.ok(visible.some((p) => p.type === 'title_ranked' && p.media_item_id === reviewedId));

    // Written after grouping: the reviewed title's ranking comes back as its own card and
    // the group, now one title, dissolves rather than pass off one card as a group.
    await t.sql(
      `update user_media set note = 'Later thoughts.', note_visibility = 'public'
        where user_id = $1 and media_item_id = $2`,
      [user, first.id],
    );
    const now = await visibleTo(friend);
    assert.equal(now.filter((p) => p.type === 'ranking_batch').length, 0);
    assert.equal(now.filter((p) => p.type === 'title_ranked').length, 3);
  });

  it('a correction, a manual move and Refine post nothing, and leave the group exactly as it was', async () => {
    const titles = [];
    for (const name of ['C1', 'C2', 'C3']) titles.push((await rankFirst('movie', name)).id);
    const beforePosts = await posts();
    const beforeNotes = (await counts()).notifications;

    // Update your rating, same band (a correction).
    let step = await call(`rank_again($1, 'loved', $2, false)`, [titles[0], await uuid()]);
    while (!step.done) {
      step = await call(`rank_answer($1, $2, $3)`, [step.session_id, step.pivot, await uuid()]);
    }
    // A manual move.
    await t.sql(`select rank_reorder($1, 1, $2)`, [titles[2], await uuid()]);
    // Refine.
    await t.sql(
      `insert into app_config (key, value) values ('ranking.refine_enabled', 'true'::jsonb)
       on conflict (key) do update set value = excluded.value`,
    );
    let r = await call(`refine_start($1, $2)`, [titles[1], await uuid()]);
    while (!r.done) {
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, r.pivot, await uuid()]);
    }
    // The client notes only a first ranking, but the server refuses the rest anyway.
    for (const id of titles) {
      assert.equal(
        (await call(`rank_group_note($1, $2)`, [await uuid(), id])).status,
        'skipped',
      );
    }

    const afterPosts = await posts();
    assert.equal(afterPosts.length, beforePosts.length, 'no post was written');
    assert.deepEqual(
      afterPosts.map((p) => [p.id, p.type, p.presented_in, p.payload.count ?? null]),
      beforePosts.map((p) => [p.id, p.type, p.presented_in, p.payload.count ?? null]),
    );
    assert.equal((await counts()).notifications, beforeNotes);
  });

  it('a single ranking stays a single card', async () => {
    const solo = await rankFirst('movie', 'Alone');
    assert.equal(solo.result.status, 'solo');
    const visible = await visibleTo(friend);
    assert.deepEqual(
      visible.map((p) => [p.type, p.media_item_id]),
      [['title_ranked', solo.id]],
    );
  });
});

describe('what is never hidden', () => {
  it('a ranking somebody reacted to or commented on is neither hidden nor taken as a peer', async () => {
    const liked = await rankFirst('movie', 'Liked');
    const likedPost = (await posts())[0];
    await t.sql(
      `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
      [likedPost.id, friend],
    );
    const talked = await rankFirst('movie', 'Talked', { note: false });
    const talkedPost = (await posts()).find((p) => p.media_item_id === talked.id);
    await t.sql(
      `insert into comments (feed_event_id, author_id, body) values ($1, $2, 'yes!')`,
      [talkedPost.id, friend],
    );
    assert.equal(
      (await call(`rank_group_note($1, $2)`, [await uuid(), talked.id])).reason,
      'referenced',
    );
    const third = await rankFirst('movie', 'Third');
    assert.equal(third.result.status, 'solo', 'neither interacted post is a peer');
    const fourth = await rankFirst('movie', 'Fourth');
    assert.equal(fourth.result.status, 'grouped');
    const all = await posts();
    for (const p of [likedPost.id, talkedPost.id]) {
      assert.equal(all.find((x) => x.id === p).presented_in, null);
    }
    assert.equal(liked.result.status, 'solo');
  });

  it('a ranking a notification names (a recommendation fulfilled) keeps its own card', async () => {
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')
       on conflict do nothing`,
      [user, friend],
    );
    const recommended = await title('movie', 'Recommended');
    await t.asUser(friend, async () => {
      await t.sql(`select recommend_title($1, $2, $3)`, [await uuid(), user, recommended]);
    });
    await t.actAs(user);
    await rankFirst('movie', 'Before');
    await t.sql(
      `insert into user_media (user_id, media_item_id) values ($1, $2) on conflict do nothing`,
      [user, recommended],
    );
    await t.rankToCompletion(recommended, 'loved', (pivot, subject) => subject);
    const post = (await posts()).find((p) => p.media_item_id === recommended);
    const { rows } = await t.sql(
      `select count(*)::int n from notifications where subject_type = 'feed_event' and subject_id = $1`,
      [post.id],
    );
    assert.equal(rows[0].n, 1, 'the sender was told about this post');
    assert.equal(
      (await call(`rank_group_note($1, $2)`, [await uuid(), recommended])).reason,
      'referenced',
    );
    assert.equal((await posts()).find((p) => p.id === post.id).presented_in, null);
  });
});

describe('privacy and visibility', () => {
  it("a private author's group is seen by an approved follower only; a blocked reader sees nothing", async () => {
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [user]);
    await rankFirst('movie', 'P1');
    await rankFirst('movie', 'P2');
    const g = (await posts()).find((p) => p.type === 'ranking_batch');

    assert.deepEqual(
      (await visibleTo(friend)).map((p) => p.type),
      ['ranking_batch'],
    );
    assert.equal((await previewsAs(friend, g.id)).length, 2);

    assert.deepEqual(await visibleTo(stranger), [], 'not a follower: nothing at all');
    assert.deepEqual(await previewsAs(stranger, g.id), []);

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [user, friend]);
    assert.deepEqual(await visibleTo(friend), [], 'blocked: nothing');
    assert.deepEqual(await previewsAs(friend, g.id), []);
    const member = (await posts()).find((p) => p.presented_in === g.id);
    const followed = await t.asUser(
      friend,
      async () =>
        (await t.sql(`select feed_event_presentation($1) as g`, [member.id])).rows[0].g,
    );
    assert.equal(followed, null, 'a stale deep link does not reveal the group');
    await t.sql(`delete from blocks where blocker_id = $1`, [user]);
  });
});

describe('an Unranked sitting in the same half hour', () => {
  const sit = async (names) => {
    const s = await uuid();
    for (const name of names) {
      const { id } = await rankFirst('movie', name, { note: false });
      await call(`rank_batch_note($1, $2, $3)`, [await uuid(), s, id]);
    }
    return call(`rank_batch_finalize($1, $2)`, [await uuid(), s]);
  };

  it('a title-page ranking just before the sitting is presented by the sitting post', async () => {
    const page = await rankFirst('movie', 'Page');
    await age(5);
    const ended = await sit(['Sat 1', 'Sat 2']);
    assert.equal(ended.status, 'ok');
    assert.equal(ended.count, 3);
    const visible = await visibleTo(friend);
    assert.deepEqual(
      visible.map((p) => p.type),
      ['ranking_batch'],
    );
    const rail = (await previewsAs(friend, visible[0].id)).map((r) => r.media_item_id);
    assert.ok(rail.includes(page.id));
  });

  it('a referenced title-page ranking is never adopted, and one outside the window is left alone', async () => {
    await rankFirst('movie', 'Far');
    await age(40);
    const liked = await rankFirst('movie', 'Liked');
    const likedPost = (await posts()).find((p) => p.media_item_id === liked.id);
    await t.sql(
      `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
      [likedPost.id, friend],
    );
    const ended = await sit(['Sat']);
    assert.equal(ended.count, 1);
    assert.ok(
      (await posts())
        .filter((p) => p.type === 'title_ranked')
        .every((p) => p.presented_in === null),
    );
  });

  it('a title-page ranking after the sitting joins its post', async () => {
    await sit(['S1', 'S2']);
    const page = await rankFirst('season', 'After');
    assert.equal(page.result.status, 'joined');
    assert.equal(page.result.count, 3);
  });
});

describe('the operator consolidation follows the same rule', () => {
  it('a burst of "Today" rankings is a planned group, and the candidates SQL agrees', async () => {
    for (const name of ['H1', 'H2', 'H3']) await rankFirst('movie', name, { note: false });
    await age(60 * 24 * 2);
    const dry = await call(
      `consolidate_feed_history($1, now() - interval '5 days', now(), false, 30, $2)`,
      [`rgw-${seq}`, user],
    );
    assert.equal(dry.planned_groups.ranking, 1);
    assert.equal(dry.planned_groups.members, 3);
    assert.equal(
      dry.excluded.after_watch_or_ambiguous,
      undefined,
      'no date exclusion any more',
    );

    // The read-only candidates script, scoped to this account, gives the same plan.
    const raw = await readFile(
      join(here, '..', '..', 'docs', 'feed', 'consolidation-candidates.sql'),
      'utf8',
    );
    const sql = raw
      .replace(/^--.*$/gm, '')
      .replace(":'since'", `'${new Date(Date.now() - 5 * 86400e3).toISOString()}'`)
      .replace(":'until'", `'${new Date(Date.now() + 60e3).toISOString()}'`)
      .replace(
        /from feed_events e, params p\s+where/,
        `from feed_events e, params p where e.actor_id = '${user}' and`,
      );
    const { rows } = await t.sql(sql);
    const report = rows[0].report;
    assert.equal(report.groups.ranking, 1);
    assert.equal(report.members_consolidated.ranking, 3);
    assert.equal(report.excluded.after_watch_or_ambiguous, undefined);
  });
});
