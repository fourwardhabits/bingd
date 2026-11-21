import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb } from './harness.mjs';

/**
 * **The historical consolidation into sessions** (20261130000900: `consolidate_feed_sessions`,
 * `revert_feed_session_consolidation`, and the read-only docs/feed/session-consolidation-candidates.sql).
 *
 * History is made the way production made it before sessions: with sessions switched off, a
 * ranking group, a watchlist group, a standalone reviewed ranking and a standalone plain one
 * in one half hour; a commented watchlist post and a plain ranking in another; a liked
 * ranking beside a plain one in a third. Then the dry run must agree with the function's own
 * plan, a first batch scoped to one author folds each window into one post (the commented
 * post kept as the post, the liked ranking left alone, the reviewed one left alone unless the
 * founder's flag says otherwise), every old link resolves in one hop, nobody is notified, and
 * the revert restores every row exactly.
 */
const here = dirname(fileURLToPath(import.meta.url));
let t;
let user;
let other;
let friend;
let tmdb = 3_700_000;

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

async function rank(actor, name, { note = true, text = null } = {}) {
  await t.actAs(actor);
  const id = await t.createMovie(name, (tmdb += 1));
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [actor, id]);
  if (text) {
    await call(`save_note($1, $2, $3, null, 'public'::note_visibility, false)`, [
      await uuid(),
      id,
      text,
    ]);
  }
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  if (note) await call(`rank_group_note($1, $2)`, [await uuid(), id]);
  return id;
}
async function save(actor, name) {
  await t.actAs(actor);
  const id = await t.createMovie(name, (tmdb += 1));
  await call(`set_watchlist($1, $2, true)`, [await uuid(), id]);
  return id;
}
/** Everything the actor wrote moves `hours` into the past, windows and memberships too. */
async function age(actor, hours) {
  await t.sql(
    `update feed_events
        set created_at = created_at - make_interval(hours => $2::int),
            causal_at = causal_at - make_interval(hours => $2::int),
            payload = payload || case when payload ? 'started_at'
              then jsonb_build_object('started_at',
                     (payload ->> 'started_at')::timestamptz - make_interval(hours => $2::int))
              else '{}'::jsonb end
      where actor_id = $1`,
    [actor, hours],
  );
  await t.sql(
    `update feed_watchlist_titles set added_at = added_at - make_interval(hours => $2::int)
      where actor_id = $1`,
    [actor, hours],
  );
  await t.sql(
    `update feed_ranking_titles set placed_at = placed_at - make_interval(hours => $2::int)
      where event_id in (select id from feed_events where actor_id = $1)`,
    [actor, hours],
  );
}
const snapshot = async (actor) =>
  (
    await t.sql(
      `select id, type, media_item_id, payload, presented_in, created_at, causal_at, causal_step
         from feed_events where actor_id = $1 order by id`,
      [actor],
    )
  ).rows;
const visible = async (actor) => (await snapshot(actor)).filter((r) => r.presented_in === null);
const notificationCount = async () =>
  Number((await t.sql(`select count(*)::int as n from notifications`)).rows[0].n);

// History only: an applied batch must end at least one window ago, and every fixture here is
// at least two hours old.
const range = () => ({
  since: new Date(Date.now() - 86400e3).toISOString(),
  until: new Date(Date.now() - 31 * 60e3).toISOString(),
});

async function dryRun({ actor = '', includeReviewed = false } = {}) {
  const raw = await readFile(
    join(here, '..', '..', 'docs', 'feed', 'session-consolidation-candidates.sql'),
    'utf8',
  );
  const { since, until } = range();
  const sql = raw
    .replace(/^--.*$/gm, '')
    .replace(":'since'", `'${since}'`)
    .replace(":'until'", `'${until}'`)
    .replace(":'include_reviewed'", `'${includeReviewed}'`)
    .replace(":'actor'", `'${actor}'`);
  return (await t.sql(sql)).rows[0].report;
}
const consolidate = async (
  batch,
  { apply = false, actor = null, includeReviewed = false } = {},
) => {
  const { since, until } = range();
  return call(`consolidate_feed_sessions($1, $2, $3, $4, $5, $6)`, [
    batch,
    since,
    until,
    apply,
    actor,
    includeReviewed,
  ]);
};

const ids = {};

before(async () => {
  t = await createTestDb();
  user = await t.createUser({ username: 'sc_user' });
  other = await t.createUser({ username: 'sc_other' });
  friend = await t.createUser({ username: 'sc_friend' });
  for (const followee of [user, other]) {
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [friend, followee],
    );
  }
  await t.sql(
    `update app_config set value = 'false'::jsonb where key = 'feed.activity_sessions_enabled'`,
  );

  for (const actor of [user, other]) {
    // Window 3, oldest: a liked ranking beside a plain one.
    const liked = await rank(actor, `Liked ${actor}`, { note: false });
    await rank(actor, `Beside ${actor}`, { note: false });
    await t.actAs(friend);
    const likedPost = (
      await t.sql(`select id from feed_events where actor_id = $1 and media_item_id = $2`, [
        actor,
        liked,
      ])
    ).rows[0].id;
    await t.sql(`select set_reaction($1, $2, 'love')`, [await uuid(), likedPost]);
    await age(actor, 3);

    // Window 2: a commented watchlist post and a plain ranking.
    await save(actor, `Commented ${actor}`);
    const ws = (
      await t.sql(
        `select id from feed_events where actor_id = $1 and type = 'watchlist_added'`,
        [actor],
      )
    ).rows[0].id;
    await t.actAs(friend);
    await t.sql(`select add_comment($1, $2, 'what a list', false)`, [await uuid(), ws]);
    await rank(actor, `Lone ${actor}`, { note: false });
    await age(actor, 3);

    // Window 1, newest: a ranking group, a watchlist group, a reviewed and a plain ranking.
    await rank(actor, `G1 ${actor}`);
    await rank(actor, `G2 ${actor}`);
    await save(actor, `W1 ${actor}`);
    await save(actor, `W2 ${actor}`);
    await rank(actor, `Reviewed ${actor}`, { note: false, text: 'An old review.' });
    await rank(actor, `Plain ${actor}`, { note: false });
    await age(actor, 3);
    ids[actor] = { ws, likedPost };
  }

  await t.sql(
    `update app_config set value = 'true'::jsonb where key = 'feed.activity_sessions_enabled'`,
  );
  await t.actAs(null);
});

after(async () => t?.close());

describe('the dry run', () => {
  it('the read-only SQL and the function plan the same sessions', async () => {
    const sql = await dryRun();
    const fn = await consolidate('sc-dry');
    assert.equal(fn.applied, false);
    assert.equal(sql.planned.sessions, fn.planned.sessions);
    assert.equal(sql.planned.units, fn.planned.units);
    assert.deepEqual(sql.planned.by_kind.ranking, fn.planned.by_kind.ranking);
    assert.deepEqual(sql.planned.by_kind.save, fn.planned.by_kind.save);
    assert.deepEqual(sql.planned.by_kind.group, fn.planned.by_kind.group);
    assert.equal(sql.planned.cards_after, fn.planned.cards_after);
    // Two authors, two sessions each: window 1 (groups and a plain ranking) and window 2
    // (the commented post and a ranking). Window 3 has one unit once the liked one is out.
    assert.equal(sql.planned.sessions, 4);
    assert.equal(sql.planned.by_kind.group, 4, 'a ranking group and a watchlist group each');
    assert.equal(sql.excluded.reviewed_rankings_left_alone, 2);
    assert.ok(sql.excluded.with_reactions >= 2);
    assert.ok(sql.excluded.with_comments >= 2);
    assert.ok(
      !JSON.stringify(sql).includes(user) && !JSON.stringify(sql).includes('sc_user'),
      'no author id or handle in the report',
    );
    const scoped = await dryRun({ actor: user });
    assert.equal(scoped.planned.sessions, 2);
    assert.equal(scoped.planned.actors, 1);
    const reviewed = await dryRun({ includeReviewed: true });
    assert.equal(reviewed.planned.by_kind.ranking, sql.planned.by_kind.ranking + 2);
  });
});

describe('a first batch, one author', () => {
  it('folds each window into one post, keeps engagement and links, and the revert restores every row', async () => {
    const before = await snapshot(user);
    const otherBefore = await snapshot(other);
    const notified = await notificationCount();
    const hiddenBefore = before.filter((r) => r.presented_in !== null);
    const visibleBefore = before.filter((r) => r.presented_in === null);

    const report = await consolidate('sc-first', { apply: true, actor: user });
    assert.equal(report.applied_sessions, 2);
    assert.deepEqual(await snapshot(other), otherBefore, 'the other author is untouched');
    assert.equal(await notificationCount(), notified, 'nobody is notified');

    const now = await visible(user);
    assert.equal(now.length, visibleBefore.length - report.hidden_posts);
    const commented = now.find((r) => r.id === ids[user].ws);
    assert.ok(commented, 'the commented post is the session post, with its id');
    assert.equal(commented.type, 'ranking_batch', 'it holds a ranking now');
    assert.equal(commented.payload.count, 2);
    assert.ok(
      now.some((r) => r.id === ids[user].likedPost),
      'the liked ranking keeps its card',
    );
    const reviewedId = (
      await t.sql(
        `select fe.id from feed_events fe join user_media um
            on um.user_id = fe.actor_id and um.media_item_id = fe.media_item_id
         where fe.actor_id = $1 and fe.type = 'title_ranked' and um.note_visibility = 'public'`,
        [user],
      )
    ).rows[0].id;
    assert.ok(
      now.some((r) => r.id === reviewedId),
      'the reviewed ranking is left alone',
    );

    // Every row that was visible and is now hidden, and every member hidden before, resolves
    // in one hop to a visible post the friend may read.
    const nowHidden = (await snapshot(user)).filter((r) => r.presented_in !== null);
    await t.actAs(friend);
    try {
      for (const row of [...hiddenBefore, ...nowHidden]) {
        const g = await call(`feed_event_presentation($1)`, [row.id]);
        assert.ok(g, `a link to ${row.type} resolves`);
        assert.ok(
          now.some((r) => r.id === g),
          'to a visible post',
        );
      }
    } finally {
      await t.actAs(null);
    }
    const { rows: c } = await t.sql(
      `select count(*)::int as n from comments where feed_event_id = $1`,
      [ids[user].ws],
    );
    assert.equal(c[0].n, 1, 'the conversation stays on its post');

    await assert.rejects(
      consolidate('sc-first', { apply: true, actor: user }),
      /already applied/,
      'a batch name is used once',
    );
    await assert.rejects(
      call(`consolidate_feed_sessions($1, $2, $3, true)`, [
        'sc-open',
        new Date(Date.now() - 86400e3).toISOString(),
        new Date().toISOString(),
      ]),
      /one window ago/,
      'a range that may hold an open window is refused',
    );

    const reverted = await call(`revert_feed_session_consolidation($1)`, ['sc-first']);
    assert.deepEqual(reverted.kept_with_conversation, []);
    assert.deepEqual(await snapshot(user), before, 'every row is exactly as it was');
    const { rows: log } = await t.sql(
      `select count(*)::int as n from feed_consolidation_log where batch = 'sc-first'`,
    );
    assert.equal(log[0].n, 0);
  });

  it('with the founder flag, a reviewed ranking folds too', async () => {
    const report = await consolidate('sc-reviewed', {
      apply: true,
      actor: user,
      includeReviewed: true,
    });
    assert.equal(report.applied_sessions, 2);
    const reviewedId = (
      await t.sql(
        `select fe.id, fe.presented_in from feed_events fe join user_media um
            on um.user_id = fe.actor_id and um.media_item_id = fe.media_item_id
         where fe.actor_id = $1 and fe.type = 'title_ranked' and um.note_visibility = 'public'`,
        [user],
      )
    ).rows[0];
    assert.notEqual(reviewedId.presented_in, null);
    await call(`revert_feed_session_consolidation($1)`, ['sc-reviewed']);
  });

  it('a created post that gains a conversation is kept by the revert, and reported', async () => {
    const lone = await t.createUser({ username: 'sc_lone' });
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [friend, lone],
    );
    await rank(lone, 'Lone A', { note: false });
    await rank(lone, 'Lone B', { note: false });
    await age(lone, 2);
    await t.actAs(null);
    const report = await consolidate('sc-created', { apply: true, actor: lone });
    assert.equal(report.applied_sessions, 1);
    assert.equal(report.posts[0].created, true);
    const post = report.posts[0].post;
    await t.actAs(friend);
    await t.sql(`select add_comment($1, $2, 'late reply', false)`, [await uuid(), post]);
    await t.actAs(null);
    const reverted = await call(`revert_feed_session_consolidation($1)`, ['sc-created']);
    assert.deepEqual(reverted.kept_with_conversation, [post]);
    assert.equal((await visible(lone)).length, 1, 'the post and its conversation stay');
  });
});
