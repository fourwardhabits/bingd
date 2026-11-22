import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb } from './harness.mjs';

/**
 * **The historical split of mixed session posts** (20261130001000: `split_mixed_sessions`,
 * `revert_session_split`, and the read-only docs/feed/session-split-candidates.sql).
 *
 * History is made the way production made it: with sessions off, five windows per author
 * (a watchlist group beside a ranking group; a ranking group beside a save; a save beside
 * two rankings; a save beside one ranking; a commented save beside two rankings), folded
 * into mixed posts by the retired `consolidate_feed_sessions`, plus a live mixed post the
 * way 20261130000900's writers converted one in place. Then:
 *
 *   * the dry-run SQL and the function plan the same splits, and the report names nobody;
 *   * a founder-first batch splits that author's posts only: each mixed post keeps its id,
 *     its conversation and its original category, the other category moves to an original
 *     hidden post where there is one and to a new post where there is not, both posts carry
 *     the window's anchor and sit at their own category's last activity, every hidden member
 *     resolves in one hop to its own category's post, and nobody is notified;
 *   * the split reverts exactly; the consolidation batch refuses to revert while the split
 *     holds it and reverts exactly once the split is undone; reverted first, it leaves the
 *     split nothing to do;
 *   * a post that cannot be split safely is left alone and listed.
 */
const here = dirname(fileURLToPath(import.meta.url));
let t;
let friend;
let tmdb = 3_900_000;

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

async function rank(actor, name, { note = true } = {}) {
  await t.actAs(actor);
  const id = await t.createMovie(name, (tmdb += 1));
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [actor, id]);
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
  await t.actAs(null);
  await t.sql(
    `update feed_events
        set created_at = created_at - make_interval(hours => $2::int),
            causal_at = causal_at - make_interval(hours => $2::int),
            payload = payload
              || case when payload ? 'started_at'
                 then jsonb_build_object('started_at',
                        (payload ->> 'started_at')::timestamptz - make_interval(hours => $2::int))
                 else '{}'::jsonb end
              || case when payload ? 'last_activity_at'
                 then jsonb_build_object('last_activity_at',
                        (payload ->> 'last_activity_at')::timestamptz - make_interval(hours => $2::int))
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

/** Every row the split or the consolidation may touch, for exact before/after comparison. */
async function snapshot(actor) {
  const events = (
    await t.sql(
      `select id, type, media_item_id, payload, presented_in, created_at, causal_at, causal_step
         from feed_events where actor_id = $1 order by id`,
      [actor],
    )
  ).rows;
  const saves = (
    await t.sql(
      `select id, event_id, media_item_id from feed_watchlist_titles where actor_id = $1 order by id`,
      [actor],
    )
  ).rows;
  const ranks = (
    await t.sql(
      `select f.id, f.event_id, f.media_item_id from feed_ranking_titles f
         join feed_events e on e.id = f.event_id or e.id = f.event_id
        where e.actor_id = $1 order by f.id`,
      [actor],
    )
  ).rows;
  return { events, saves, ranks };
}
const visible = async (actor) =>
  (await snapshot(actor)).events.filter((r) => r.presented_in === null);
const notificationCount = async () =>
  Number((await t.sql(`select count(*)::int as n from notifications`)).rows[0].n);
const members = async (eventId) =>
  (
    await t.sql(
      `select media_item_id, action, acted_at from _group_members($1)
        order by acted_at desc, last_tiebreak desc, media_item_id`,
      [eventId],
    )
  ).rows;

const range = () => ({
  since: new Date(Date.now() - 2 * 86400e3).toISOString(),
  until: new Date(Date.now() - 31 * 60e3).toISOString(),
});

async function dryRun({ actor = '' } = {}) {
  const raw = await readFile(
    join(here, '..', '..', 'docs', 'feed', 'session-split-candidates.sql'),
    'utf8',
  );
  const { since, until } = range();
  const sql = raw
    .replace(/^--.*$/gm, '')
    .replaceAll(":'since'", `'${since}'`)
    .replaceAll(":'until'", `'${until}'`)
    .replaceAll(":'actor'", `'${actor}'`);
  return (await t.sql(sql)).rows[0].report;
}
const split = (batch, { apply = false, actor = null } = {}) => {
  const { since, until } = range();
  return call(`split_mixed_sessions($1, $2, $3, $4, $5)`, [batch, since, until, apply, actor]);
};
const consolidate = (batch, actor) =>
  call(`consolidate_feed_sessions($1, $2, $3, true, $4, true)`, [
    batch,
    new Date(Date.now() - 86400e3).toISOString(),
    new Date(Date.now() - 31 * 60e3).toISOString(),
    actor,
  ]);

/**
 * Five windows of history for `actor`, three hours apart, as production had them before
 * 20261130000900, then a live mixed post as 20261130000900 converted one in place.
 * Returns the ids each scenario needs.
 */
async function history(actor) {
  const ids = {};
  await t.sql(
    `update app_config set value = 'false'::jsonb where key = 'feed.activity_sessions_enabled'`,
  );
  try {
    // S5 (oldest): a commented save beside two rankings.
    ids.s5save = await save(actor, `S5 save ${actor}`);
    await rank(actor, `S5 r1 ${actor}`, { note: false });
    await rank(actor, `S5 r2 ${actor}`, { note: false });
    ids.s5post = (
      await t.sql(
        `select id from feed_events where actor_id = $1 and type = 'watchlist_added'
          and media_item_id = $2`,
        [actor, ids.s5save],
      )
    ).rows[0].id;
    await t.actAs(friend);
    await t.sql(`select add_comment($1, $2, 'what a list', false)`, [await uuid(), ids.s5post]);
    await age(actor, 3);

    // S4: a watchlist group beside a ranking group (the founder's screenshot).
    await save(actor, `S4 w1 ${actor}`);
    await save(actor, `S4 w2 ${actor}`);
    await rank(actor, `S4 r1 ${actor}`);
    await rank(actor, `S4 r2 ${actor}`);
    await age(actor, 3);

    // S3: a ranking group beside a save.
    await rank(actor, `S3 r1 ${actor}`);
    await rank(actor, `S3 r2 ${actor}`);
    await save(actor, `S3 save ${actor}`);
    await age(actor, 3);

    // S1: a save beside two rankings.
    await save(actor, `S1 save ${actor}`);
    await rank(actor, `S1 r1 ${actor}`, { note: false });
    await rank(actor, `S1 r2 ${actor}`, { note: false });
    await age(actor, 3);

    // S2: a save beside one ranking.
    await save(actor, `S2 save ${actor}`);
    await rank(actor, `S2 r1 ${actor}`, { note: false });
    await age(actor, 3);
  } finally {
    await t.sql(
      `update app_config set value = 'true'::jsonb where key = 'feed.activity_sessions_enabled'`,
    );
  }

  // S6: a live session 20261130000900 converted in place (a save, then a ranking joined it).
  ids.s6save = await save(actor, `S6 save ${actor}`);
  ids.s6rank = await rank(actor, `S6 r1 ${actor}`, { note: false });
  await t.actAs(null);
  const live = (
    await t.sql(
      `select id from feed_events where actor_id = $1 and media_item_id = $2 and type = 'watchlist_added'`,
      [actor, ids.s6save],
    )
  ).rows[0].id;
  await t.sql(
    `update feed_events set presented_in = $2
      where actor_id = $1 and type = 'title_ranked' and media_item_id = $3`,
    [actor, live, ids.s6rank],
  );
  await t.sql(
    `update feed_events set type = 'ranking_batch', media_item_id = $2,
            payload = payload || jsonb_build_object('count', 2, 'ranked', 1, 'saved', 1,
                                                    'lead_action', 'ranked', 'session', true)
      where id = $1`,
    [live, ids.s6rank],
  );
  ids.s6post = live;
  await age(actor, 2);
  await t.actAs(null);
  return ids;
}

let founder;
let other;
let founderIds;
const pre = {};

before(async () => {
  t = await createTestDb();
  friend = await t.createUser({ username: 'ss_friend' });
  founder = await t.createUser({ username: 'ss_founder' });
  other = await t.createUser({ username: 'ss_other' });
  for (const followee of [founder, other]) {
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [friend, followee],
    );
  }
  founderIds = await history(founder);
  await history(other);
  pre.founder = await snapshot(founder);
  pre.other = await snapshot(other);
  await t.sql(
    `update app_config set value = 'true'::jsonb where key = 'feed.session_consolidation_enabled'`,
  );
  const f = await consolidate('ss-h-founder', founder);
  const o = await consolidate('ss-h-other', other);
  assert.equal(f.applied_sessions, 5, 'five windows folded');
  assert.equal(o.applied_sessions, 5);
  await t.sql(
    `update app_config set value = 'false'::jsonb where key = 'feed.session_consolidation_enabled'`,
  );
});

after(async () => t?.close());

describe('the dry run', () => {
  it('the read-only SQL and the function plan the same splits, naming nobody', async () => {
    const sql = await dryRun();
    const fn = await split('ss-dry');
    assert.equal(fn.applied, false);
    for (const key of [
      'mixed_posts',
      'to_split',
      'actors',
      'keep_ranking',
      'keep_watchlist',
      'partners_reused',
      'partners_created',
      'with_engagement',
      'titles_ranked',
      'titles_saved',
    ]) {
      assert.equal(sql[key], fn.planned[key], key);
    }
    assert.deepEqual(sql.exceptions, fn.planned.exceptions);
    // Six mixed posts each: five consolidated, one live.
    assert.equal(sql.mixed_posts, 12);
    assert.equal(sql.to_split, 12);
    // Kept as watchlist: S5, S4, S1, S2 (prior watchlist posts) and S6 (began as one).
    assert.equal(sql.keep_watchlist, 10);
    assert.equal(sql.keep_ranking, 2, 'S3, a ranking group that hid a save');
    // Reused: S4's hidden ranking group, S3's hidden save, S2's and S6's single ranking.
    assert.equal(sql.partners_reused, 8);
    assert.equal(sql.partners_created, 4, 'S5 and S1 have no original ranking post');
    assert.deepEqual(sql.reused_by_type, {
      ranking_batch: 2,
      watchlist_added: 2,
      title_ranked: 4,
    });
    assert.deepEqual(sql.created_by_type, { ranking_batch: 4 });
    assert.equal(sql.with_engagement, 2, 'S5’s commented save');
    const text = JSON.stringify(sql);
    assert.ok(!text.includes(founder) && !text.includes('ss_founder'), 'no id or handle');
    const scoped = await dryRun({ actor: founder });
    assert.equal(scoped.to_split, 6);
    assert.equal(scoped.actors, 1);
  });
});

describe('a founder-first batch', () => {
  let before;
  let report;
  let notified;
  let otherBefore;

  it('splits that author’s posts only, and nobody is notified', async () => {
    before = await snapshot(founder);
    otherBefore = await snapshot(other);
    notified = await notificationCount();
    report = await split('ss-founder', { apply: true, actor: founder });
    assert.equal(report.applied_posts, 6);
    assert.deepEqual(await snapshot(other), otherBefore, 'the other author is untouched');
    assert.equal(await notificationCount(), notified);
    const after = await snapshot(founder);
    assert.equal(
      after.events.length,
      before.events.length + 2,
      'two partners made (S5, S1); nothing deleted',
    );
    assert.equal(after.saves.length, before.saves.length);
    assert.equal(after.ranks.length, before.ranks.length);
  });

  it('every post holds one category, newest first, at its own last activity, with the window’s anchor', async () => {
    const now = await visible(founder);
    for (const post of now.filter((p) =>
      ['ranking_batch', 'watchlist_added'].includes(p.type),
    )) {
      const m = await members(post.id);
      const kinds = new Set(m.map((x) => x.action));
      assert.equal(kinds.size, 1, 'one category');
      assert.equal(post.type === 'ranking_batch' ? 'ranked' : 'saved', [...kinds][0]);
      assert.equal(post.media_item_id, m[0].media_item_id, 'the newest title leads');
      assert.equal(post.payload.count, m.length);
      assert.equal(post.causal_at.getTime(), new Date(m[0].acted_at).getTime());
    }
    for (const { post, partner } of report.posts) {
      const p = now.find((x) => x.id === post);
      const q = now.find((x) => x.id === partner);
      assert.ok(p && q, 'both visible');
      assert.notEqual(p.type, q.type, 'one post per category');
      if (q.type !== 'title_ranked') {
        assert.equal(p.payload.started_at, q.payload.started_at, 'one window anchor');
      }
    }
  });

  it('keeps each post’s id, conversation and original category; reuses original hidden posts', async () => {
    const byPost = Object.fromEntries(report.posts.map((x) => [x.post, x]));
    const s5 = byPost[founderIds.s5post];
    assert.ok(s5, 'the commented post was split');
    assert.equal(s5.keep, 'watchlist');
    assert.equal(s5.created, true, 'no original ranking post to reuse');
    const p5 = (await visible(founder)).find((x) => x.id === founderIds.s5post);
    assert.equal(p5.type, 'watchlist_added', 'back to what it was');
    assert.equal(p5.media_item_id, founderIds.s5save);
    const { rows } = await t.sql(
      `select count(*)::int as n from comments where feed_event_id = $1`,
      [founderIds.s5post],
    );
    assert.equal(rows[0].n, 1, 'the conversation stays on its post');

    const s6 = byPost[founderIds.s6post];
    assert.equal(s6.keep, 'watchlist', 'a live post that began as a save');
    assert.equal(s6.created, false);
    const single = (await visible(founder)).find((x) => x.id === s6.partner);
    assert.equal(single.type, 'title_ranked', 'its one ranking has its own card again');
    assert.equal(single.media_item_id, founderIds.s6rank);
    assert.equal(report.posts.filter((x) => !x.created).length, 4);
  });

  it('every hidden member resolves in one hop to its own category’s post', async () => {
    const all = (await snapshot(founder)).events;
    const shown = new Map(all.filter((r) => r.presented_in === null).map((r) => [r.id, r]));
    await t.actAs(friend);
    try {
      for (const row of all.filter((r) => r.presented_in !== null)) {
        const g = await call(`feed_event_presentation($1)`, [row.id]);
        const post = shown.get(g);
        assert.ok(post, `a ${row.type} resolves to a visible post`);
        const category = row.type === 'watchlist_added' ? 'watchlist_added' : 'ranking_batch';
        assert.equal(post.type, category, `a ${row.type} lands on its own category`);
      }
    } finally {
      await t.actAs(null);
    }
  });

  it('a batch name is used once, and a range that may hold an open window is refused', async () => {
    await assert.rejects(
      split('ss-founder', { apply: true, actor: founder }),
      /already applied/,
    );
    await assert.rejects(
      call(`split_mixed_sessions($1, $2, $3, true)`, [
        'ss-open',
        new Date(Date.now() - 86400e3).toISOString(),
        new Date().toISOString(),
      ]),
      /one window ago/,
    );
  });

  it('the consolidation batch refuses to revert while the split holds it', async () => {
    await assert.rejects(
      call(`revert_feed_session_consolidation($1)`, ['ss-h-founder']),
      /revert that split first/,
    );
  });

  it('the split reverts exactly; then the consolidation batch reverts exactly', async () => {
    const reverted = await call(`revert_session_split($1)`, ['ss-founder']);
    assert.equal(reverted.reverted_posts, 6);
    assert.equal(reverted.deleted_partners, 2);
    assert.deepEqual(reverted.kept_with_conversation, []);
    assert.deepEqual(
      await snapshot(founder),
      before,
      'every row is as it was before the split',
    );
    await call(`revert_feed_session_consolidation($1)`, ['ss-h-founder']);
    assert.deepEqual(
      await snapshot(founder),
      pre.founder,
      'and as it was before the consolidation',
    );
  });
});

describe('the other order', () => {
  it('a consolidation reverted first leaves the split nothing to do but the live post', async () => {
    await call(`revert_feed_session_consolidation($1)`, ['ss-h-other']);
    const plan = await dryRun({ actor: other });
    assert.equal(plan.to_split, 1, 'only the live post is still mixed');
    const done = await split('ss-other', { apply: true, actor: other });
    assert.equal(done.applied_posts, 1);
    await call(`revert_session_split($1)`, ['ss-other']);
    assert.deepEqual(await snapshot(other), pre.other);
  });
});

describe('what is left alone', () => {
  it('a post whose hidden member presents posts of its own is an exception, unchanged', async () => {
    const odd = await t.createUser({ username: 'ss_odd' });
    const w = await save(odd, 'Odd save');
    await rank(odd, 'Odd r1', { note: false });
    await rank(odd, 'Odd r2', { note: false });
    await t.actAs(null);
    const rows = (
      await t.sql(`select id, type, media_item_id from feed_events where actor_id = $1`, [odd])
    ).rows;
    const wPost = rows.find((r) => r.type === 'watchlist_added');
    const [r1, r2] = rows.filter((r) => r.type === 'title_ranked');
    const { rows: made } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload)
       values ($1, 'ranking_batch', $2, jsonb_build_object('count', 3, 'session', true,
               'started_at', now(), 'origin', 'session')) returning id`,
      [odd, r2.media_item_id],
    );
    await t.sql(`update feed_events set presented_in = $2 where id in ($1, $3)`, [
      wPost.id,
      made[0].id,
      r2.id,
    ]);
    await t.sql(`update feed_events set presented_in = $2 where id = $1`, [r1.id, wPost.id]);
    await age(odd, 2);
    const before = await snapshot(odd);
    const plan = await dryRun({ actor: odd });
    assert.deepEqual(plan.exceptions, { nested_member: 1 });
    const done = await split('ss-odd', { apply: true, actor: odd });
    assert.equal(done.applied_posts, 0);
    assert.deepEqual(await snapshot(odd), before);
    assert.ok(w);
  });

  it('a late sitting placement on a partner the split made goes back with the revert (Codex, PR 357)', async () => {
    const late = await t.createUser({ username: 'ss_late' });
    const sitting = await uuid();
    const save1 = await save(late, 'Late save');
    const r1 = await rank(late, 'Late r1', { note: false });
    const r2 = await rank(late, 'Late r2', { note: false });
    await t.actAs(null);
    const rows = (
      await t.sql(`select id, type, media_item_id from feed_events where actor_id = $1`, [late])
    ).rows;
    const w = rows.find((r) => r.type === 'watchlist_added');
    // A watchlist post a session batch reused, holding a sitting's placements of its own.
    await t.sql(`delete from feed_events where actor_id = $1 and type = 'title_ranked'`, [
      late,
    ]);
    await t.sql(
      `update feed_events set type = 'ranking_batch',
              payload = payload || jsonb_build_object('count', 3, 'session', true)
        where id = $1`,
      [w.id],
    );
    await t.sql(
      `insert into feed_ranking_titles (event_id, media_item_id) values ($1, $2), ($1, $3)`,
      [w.id, r1, r2],
    );
    await t.sql(
      `insert into feed_ranking_sitting_joins (actor_id, sitting, event_id) values ($1, $2, $3)`,
      [late, sitting, w.id],
    );
    await t.sql(
      `insert into feed_consolidation_log
         (batch, kind, group_event_id, member_event_id, created_group, prior_type, prior_payload)
       values ('ss-h-late', 'session', $1, null, false, 'watchlist_added', '{}'::jsonb)`,
      [w.id],
    );
    await age(late, 2);
    const before = await snapshot(late);

    const done = await split('ss-late', { apply: true, actor: late });
    assert.equal(done.applied_posts, 1);
    assert.equal(done.posts[0].keep, 'watchlist');
    assert.equal(done.posts[0].created, true);
    const partner = done.posts[0].partner;

    // A late placement for that sitting reaches the partner through the moved join.
    const r3 = await rank(late, 'Late r3', { note: false });
    const noted = await call(`rank_batch_note($1, $2, $3)`, [await uuid(), sitting, r3]);
    assert.equal(noted.event_id, partner);
    await t.actAs(null);

    const reverted = await call(`revert_session_split($1)`, ['ss-late']);
    assert.equal(reverted.reverted_posts, 1);
    const { rows: back } = await t.sql(
      `select media_item_id from feed_ranking_titles where event_id = $1 order by media_item_id`,
      [w.id],
    );
    assert.deepEqual(
      back.map((r) => r.media_item_id).sort(),
      [r1, r2, r3].sort(),
      'the late placement came back with the others, not lost',
    );
    const { rows: join } = await t.sql(
      `select event_id from feed_ranking_sitting_joins where actor_id = $1 and sitting = $2`,
      [late, sitting],
    );
    assert.deepEqual(join, [{ event_id: w.id }]);
    assert.equal(
      (await snapshot(late)).events.some((e) => e.id === partner),
      false,
    );
    assert.ok(save1 && before);
  });

  it('a partner the split made that gains a conversation is kept by the revert, and reported', async () => {
    const solo = await t.createUser({ username: 'ss_solo' });
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [friend, solo],
    );
    await t.sql(
      `update app_config set value = 'false'::jsonb where key = 'feed.activity_sessions_enabled'`,
    );
    try {
      await save(solo, 'Solo save');
      await rank(solo, 'Solo r1', { note: false });
      await rank(solo, 'Solo r2', { note: false });
    } finally {
      await t.sql(
        `update app_config set value = 'true'::jsonb where key = 'feed.activity_sessions_enabled'`,
      );
    }
    await age(solo, 2);
    await t.sql(
      `update app_config set value = 'true'::jsonb where key = 'feed.session_consolidation_enabled'`,
    );
    await consolidate('ss-h-solo', solo);
    await t.sql(
      `update app_config set value = 'false'::jsonb where key = 'feed.session_consolidation_enabled'`,
    );
    const done = await split('ss-solo', { apply: true, actor: solo });
    assert.equal(done.applied_posts, 1);
    const partner = done.posts[0].partner;
    assert.equal(done.posts[0].created, true);
    await t.actAs(friend);
    await t.sql(`select add_comment($1, $2, 'late reply', false)`, [await uuid(), partner]);
    await t.actAs(null);
    const reverted = await call(`revert_session_split($1)`, ['ss-solo']);
    assert.deepEqual(reverted.kept_with_conversation, [done.posts[0].post]);
    assert.ok(
      (await visible(solo)).some((r) => r.id === partner),
      'the partner and its talk stay',
    );
    await assert.rejects(
      call(`revert_feed_session_consolidation($1)`, ['ss-h-solo']),
      /revert that split first/,
      'the split still holds the batch',
    );
  });
});
