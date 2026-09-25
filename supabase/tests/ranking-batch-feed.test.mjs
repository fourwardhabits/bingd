import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **A sitting is one post** (`20261020000100`, founder 2026-09-24).
 *
 * Working through an imported library used to be silent, because forty `title_ranked`
 * rows in four minutes is a feed nobody can read. The correction is one grouped row per
 * sitting that grows as titles finish, and what this file has to prove is the pair of
 * claims that makes it safe:
 *
 *   1. **It groups.** The first finished title creates the post; every later one in the
 *      same sitting updates that same row rather than adding another. A different sitting
 *      is a different post.
 *   2. **It is ranking activity and nothing else.** No `watch_events` row, no movement of
 *      `watched_on`, and therefore no effect on Recently watched or on the monthly
 *      leaderboard — which is the whole reason the feature was allowed to exist at all.
 *      The Oasis case is asserted directly: an imported Sep 10 watch, ranked later, keeps
 *      Sep 10 while the post carries the ranking's own time.
 */

let t;
let user;
let seq = 0;
let tmdb = 960_000;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `batch_${seq}` });
  await t.actAs(user);
});

const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const sitting = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const movie = (title) => t.createMovie(title, (tmdb += 1));

const note = async (s, id) =>
  (
    await t.sql(`select rank_batch_note($1, $2, $3) as r`, [await op(), s, id])
  ).rows[0].r;

/**
 * Both states, because since `20261023000100` a sitting is a draft until it ends. Tests
 * about accumulation read the draft; tests about what other people see finalise first and
 * then read `published()`.
 */
const events = async () =>
  (
    await t.sql(
      `select id, type, media_item_id, payload from feed_events
        where actor_id = $1 and type in ('ranking_batch', 'ranking_batch_draft')
        order by created_at`,
      [user],
    )
  ).rows;

/** Only what an activity read would actually fetch — the draft type is in no read's IN. */
const published = async () =>
  (
    await t.sql(
      `select id, type, media_item_id, payload from feed_events
        where actor_id = $1 and type = 'ranking_batch' order by created_at`,
      [user],
    )
  ).rows;

const finalize = async (s_) =>
  (await t.sql(`select rank_batch_finalize($1, $2) as r`, [await op(), s_])).rows[0].r;

/** A ranked title, so `rank_batch_note` has something it is willing to announce. */
async function ranked(name, { watchedOn = null } = {}) {
  const id = await movie(`${name} ${seq}`);
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  if (watchedOn) {
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, $3::date, 'diary')`,
      [user, id, watchedOn],
    );
  }
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return id;
}

describe('one post per sitting', () => {
  it('the first finished title creates it', async () => {
    const s = await sitting();
    const heat = await ranked('Heat');

    const result = await note(s, heat);

    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
    const rows = await events();
    assert.equal(rows.length, 1);
    // The row names the first title, which is the one the feed sentence says aloud.
    assert.equal(rows[0].media_item_id, heat);
    assert.equal(rows[0].payload.count, 1);
  });

  it('later titles update the same row rather than adding another', async () => {
    const s = await sitting();
    const heat = await ranked('Heat');
    const ronin = await ranked('Ronin');
    const collateral = await ranked('Collateral');

    await note(s, heat);
    await note(s, ronin);
    const third = await note(s, collateral);

    assert.equal(third.count, 3);
    const rows = await events();
    assert.equal(rows.length, 1, 'three placements must be one post');
    assert.equal(rows[0].payload.count, 3);
    // Named by the LAST placed (20261023000100): at the moment the post appears, the
    // thing the reader most recently finished is the thing to show them. Nobody sees it
    // change on the way there, because the draft is in no read's IN clause.
    assert.equal(rows[0].media_item_id, collateral);
  });

  it('a later sitting is a second post', async () => {
    const heat = await ranked('Heat');
    const ronin = await ranked('Ronin');

    await note(await sitting(), heat);
    await note(await sitting(), ronin);

    assert.equal((await events()).length, 2);
  });

  it('the same title twice in one sitting counts once', async () => {
    const s = await sitting();
    const heat = await ranked('Heat');

    await note(s, heat);
    const again = await note(s, heat);

    assert.equal(again.count, 1);
    assert.equal((await events())[0].payload.count, 1);
  });

  it('refuses a title the caller has not ranked', async () => {
    // A skipped title never reaches this call in the client, and a title that was never
    // placed must not be announceable even if it did.
    const s = await sitting();
    const unranked = await movie(`Unplaced ${seq}`);
    await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [
      user,
      unranked,
    ]);

    const result = await note(s, unranked);

    assert.equal(result.status, 'not_ranked');
    assert.equal((await events()).length, 0);
  });

  it('keeps its place in the feed as it grows', async () => {
    // The Feed is paged by a keyset over causal_at, so a post that bumped it on every
    // placement would jump the page and could be served twice or skipped.
    const s = await sitting();
    const heat = await ranked('Heat');
    const ronin = await ranked('Ronin');

    await note(s, heat);
    const [before_] = await events();
    await note(s, ronin);
    const [after_] = await events();

    const at = async (id) =>
      (await t.sql(`select causal_at from feed_events where id = $1`, [id])).rows[0].causal_at;
    assert.deepEqual(await at(before_.id), await at(after_.id));
  });
});

describe('ranking activity is not a watch', () => {
  it('writes no watch event and moves no watch date', async () => {
    // The Oasis case: imported with a Sep 10 diary date, ranked later. The post records
    // the ranking; the watch chronology is untouched.
    const s = await sitting();
    const oasis = await ranked('Oasis', { watchedOn: '2026-09-10' });

    const countWatches = async () =>
      (
        await t.sql(
          `select count(*)::int as n from watch_events where user_id = $1 and media_item_id = $2`,
          [user, oasis],
        )
      ).rows[0].n;
    const before_ = await t.sql(
      `select watched_on from user_media where user_id = $1 and media_item_id = $2`,
      [user, oasis],
    );
    const watchesBefore = await countWatches();
    await note(s, oasis);
    const after_ = await t.sql(
      `select watched_on from user_media where user_id = $1 and media_item_id = $2`,
      [user, oasis],
    );

    assert.equal(String(after_.rows[0].watched_on), String(before_.rows[0].watched_on));
    // Unchanged, whatever the fixture's own ranking did before it: the post adds none.
    assert.equal(await countWatches(), watchesBefore, 'the post must not add a watch');
    const diary = await t.sql(
      `select watched_on::text as watched from watch_events
        where user_id = $1 and media_item_id = $2 and basis = 'diary'`,
      [user, oasis],
    );
    assert.equal(diary.rows[0].watched, '2026-09-10');
  });

  it('leaves the row that Recently added and Recently watched sort on', async () => {
    const s = await sitting();
    const heat = await ranked('Heat', { watchedOn: '2018-05-25' });
    const before_ = (
      await t.sql(
        `select created_at, watched_on from user_media where user_id = $1 and media_item_id = $2`,
        [user, heat],
      )
    ).rows[0];

    await note(s, heat);

    const after_ = (
      await t.sql(
        `select created_at, watched_on from user_media where user_id = $1 and media_item_id = $2`,
        [user, heat],
      )
    ).rows[0];
    assert.deepEqual(after_.created_at, before_.created_at);
    assert.deepEqual(after_.watched_on, before_.watched_on);
  });
});

describe('the expanded list', () => {
  it('returns every title in the order it was placed, with its current score', async () => {
    const s = await sitting();
    const heat = await ranked('Heat');
    const ronin = await ranked('Ronin');
    await note(s, heat);
    await note(s, ronin);
    const [event] = await events();

    await finalize(s);
    const { rows } = await t.sql(`select * from ranking_batch_titles($1)`, [event.id]);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].media_item_id, heat, 'placement order, not alphabetical');
    for (const row of rows) {
      assert.ok(row.position > 0, 'a canonical position');
      assert.ok(Number(row.score) > 0, 'and the score it holds now');
    }
  });

  it('shows nothing to somebody who may not see the actor', async () => {
    const s = await sitting();
    const heat = await ranked('Heat');
    await note(s, heat);
    const [event] = await events();

    const stranger = await t.createUser({ username: `stranger_${seq}` });
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [user]);
    await t.actAs(stranger);

    const { rows } = await t.sql(`select * from ranking_batch_titles($1)`, [event.id]);
    assert.equal(rows.length, 0);
  });
});

/**
 * **The founder's QA sitting, as it actually happened** (#209 QA, 2026-09-25;
 * `20261022000100`).
 *
 * Three titles ranked from Unranked. Two had been logged moments earlier and left at "How
 * was it?", so each had an open *native* session; the backlog resumed those as themselves
 * and `_rank_finalize` posted an ordinary `title_ranked` for each. The sitting's post then
 * named the same titles again. Every test above used `rankToCompletion` — a native
 * placement — and read only `ranking_batch` rows, so the duplicate was there all along and
 * never looked at.
 */
describe('the sitting is the only post (20261022000100)', () => {
  const setConfig = (key, value) =>
    t.sql(
      `insert into app_config (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify(value)],
    );
  const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

  /** Every feed row this actor has, as the Feed and their profile would be offered it. */
  const activity = async (actor = user) =>
    (
      await t.sql(
        `select type, media_item_id from feed_events where actor_id = $1 order by created_at`,
        [actor],
      )
    ).rows;

  /** In the collection, unranked — what Collection → Unranked lists. */
  async function logged(name) {
    const id = await movie(`${name} ${seq}`);
    await t.sql(`insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`, [
      user,
      id,
    ]);
    return id;
  }

  /** Answers to completion, placing `id` at the bottom of the band. */
  async function finish(first) {
    let r = first;
    let guard = 0;
    while (!r.done) {
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, r.pivot, await op()]);
      if ((guard += 1) > 32) throw new Error('did not converge');
    }
    return r;
  }

  before(async () => {
    await setConfig('ranking.backlog_enabled', true);
  });

  it('two resumed native placements and a fresh one are one post, and nothing else', async () => {
    // Something already in the band, posted the ordinary way long before the sitting.
    const earlier = await ranked('Earlier');
    const sheroes = await logged('Sheroes');
    const king = await logged('King of Killers');
    const hounds = await logged('Hounds of War');

    // The log flow's "How was it?" opens a native session and the reader walks away.
    for (const id of [sheroes, king]) await call(`rank_start($1, 'loved', $2)`, [id, await op()]);

    const s = await sitting();
    for (const id of [sheroes, king, hounds]) {
      const placed = await finish(await call(`rank_backlog_start($1, null, $2)`, [id, await op()]));
      assert.equal(placed.done, true);
      await note(s, id);
    }

    const rows = await activity();
    assert.deepEqual(
      rows.filter((r) => r.type.startsWith('ranking_batch')).map((r) => r.media_item_id),
      // Named by the LAST placed since 20261023000100: the representative is what the
      // reader most recently finished, and nobody watches it change on the way there.
      [hounds],
      'exactly one post for the sitting, named by its last title',
    );
    for (const id of [sheroes, king, hounds]) {
      assert.equal(
        rows.filter((r) => r.type === 'title_ranked' && r.media_item_id === id).length,
        0,
        'a title in the sitting must not also post on its own',
      );
    }
    // The ordinary activity that was already there is untouched.
    assert.equal(
      rows.filter((r) => r.type === 'title_ranked' && r.media_item_id === earlier).length,
      1,
    );
    assert.equal((await events())[0].payload.count, 3);
  });

  it('leaves a post from an earlier placement alone, even if the title is named', async () => {
    // rank_batch_note accepts any title the caller has ranked; a stale call must not
    // reach back and delete last spring's post.
    const old = await ranked('Last spring');
    await t.sql(
      `update feed_events set created_at = created_at - interval '90 days'
        where actor_id = $1 and media_item_id = $2`,
      [user, old],
    );
    await t.sql(
      `update ranking_placements set created_at = created_at - interval '90 days'
        where user_id = $1 and media_item_id = $2`,
      [user, old],
    );

    await note(await sitting(), old);

    assert.equal(
      (await activity()).filter((r) => r.type === 'title_ranked' && r.media_item_id === old)
        .length,
      1,
    );
  });

  it('a second sitting is a second post, each once', async () => {
    // Something to compare against, so rank_start opens a session rather than placing.
    const anchor = await ranked('Anchor');
    const a = await logged('First sitting');
    const b = await logged('Second sitting');
    for (const [id, s] of [
      [a, await sitting()],
      [b, await sitting()],
    ]) {
      await call(`rank_start($1, 'loved', $2)`, [id, await op()]);
      await finish(await call(`rank_backlog_start($1, null, $2)`, [id, await op()]));
      await note(s, id);
    }
    const rows = await activity();
    assert.equal(rows.filter((r) => r.type.startsWith('ranking_batch')).length, 2);
    assert.deepEqual(
      rows.filter((r) => r.type === 'title_ranked').map((r) => r.media_item_id),
      [anchor],
      'only the anchor, ranked the ordinary way, posts on its own',
    );
  });

  it('shows once in a follower\'s feed and once on its own profile, never on another', async () => {
    await ranked('Anchor');
    const heat = await logged('Heat');
    await call(`rank_start($1, 'loved', $2)`, [heat, await op()]);
    await finish(await call(`rank_backlog_start($1, null, $2)`, [heat, await op()]));
    const s_ = await sitting();
    await note(s_, heat);
    // Ended, because a draft is in no read IN clause: what a follower sees is what a
    // FINALISED sitting publishes (20261023000100).
    await finalize(s_);
    const [post] = await events();

    const follower = await t.createUser({ username: `follower_${seq}` });
    await t.actAs(follower);
    await t.sql(`select follow($1, $2)`, [await op(), user]);

    // Under RLS, as the follower's client reads it.
    const seen = await t.asUser(follower, async () =>
      (
        await t.sql(
          `select actor_id, type, media_item_id from feed_events
            where actor_id in ($1, $2) and media_item_id = $3`,
          [user, follower, heat],
        )
      ).rows,
    );
    assert.deepEqual(
      seen.map((r) => [r.actor_id, r.type]),
      [[user, 'ranking_batch']],
      'once, as the sitting, and on the actor alone',
    );

    const expanded = await t.asUser(follower, async () =>
      (await t.sql(`select media_item_id from ranking_batch_titles($1)`, [post.id])).rows,
    );
    assert.deepEqual(
      expanded.map((r) => r.media_item_id),
      [heat],
      'and "+ N more" expands for the follower',
    );
  });

  it('repairs a sitting that was written before the fix', async () => {
    // The pre-fix state, built directly: two native placements that posted, then a
    // sitting's post naming both.
    const x = await ranked('Posted twice X');
    const y = await ranked('Posted twice Y');
    const s = await sitting();
    const { rows } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload, causal_at, causal_step)
       values ($1, 'ranking_batch', $2, jsonb_build_object('sitting', $3::text, 'count', 2), now(), 0)
       returning id`,
      [user, x, s],
    );
    await t.sql(
      `insert into feed_ranking_titles (event_id, media_item_id) values ($1, $2), ($1, $3)`,
      [rows[0].id, x, y],
    );
    assert.equal((await activity()).filter((r) => r.type === 'title_ranked').length, 2);

    // The migration's own repair statement.
    await t.sql(
      `select _ranking_batch_absorb(
                fe.actor_id, frt.media_item_id, frt.placed_at - interval '1 hour', frt.placed_at)
         from feed_events fe
         join feed_ranking_titles frt on frt.event_id = fe.id
        where fe.type like 'ranking_batch%'`,
    );

    const after_ = await activity();
    assert.equal(after_.filter((r) => r.type === 'title_ranked').length, 0);
    assert.equal(after_.filter((r) => r.type.startsWith('ranking_batch')).length, 1, 'the post stays');
  });

  it('is not a junction PostgREST could embed through', async () => {
    // PGRST201: a primary key made of the two foreign keys is a feed_events <-> media_items
    // path, and every bare media_items embed from feed_events answered HTTP 300.
    const { rows } = await t.sql(
      `select a.attname as col
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.conrelid = 'feed_ranking_titles'::regclass and c.contype = 'p'`,
    );
    assert.deepEqual(rows.map((r) => r.col), ['id']);
    const unique = await t.sql(
      `select 1 from pg_constraint
        where conrelid = 'feed_ranking_titles'::regclass and conname = 'feed_ranking_titles_member'
          and contype = 'u'`,
    );
    assert.equal(unique.rows.length, 1, 'membership is still one row per title');
  });
});

/**
 * **A sitting nobody watches you have** (`20261023000100`, founder device QA 2026-09-25).
 *
 * The post used to appear on the first placement and then change under its readers — its
 * poster, its title and its count all moving as the sitting went on. What this file pins
 * is that nothing is visible until the sitting ends, and that when it does appear it names
 * the title the reader most recently finished.
 */
describe('a sitting is published when it ends', () => {
  it('is invisible to every activity read while it runs', async () => {
    const s_ = await sitting();
    await note(s_, await ranked('Heat'));
    await note(s_, await ranked('Ronin'));

    // The rows exist and the membership is real...
    assert.equal((await events()).length, 1);
    assert.equal((await events())[0].type, 'ranking_batch_draft');
    // ...and no read that draws activity asks for that type.
    assert.equal((await published()).length, 0);
  });

  it('publishes on finalize, naming the LAST title finished', async () => {
    const s_ = await sitting();
    await note(s_, await ranked('Heat'));
    await note(s_, await ranked('Ronin'));
    const last = await ranked('Collateral');
    await note(s_, last);

    const result = await finalize(s_);

    assert.equal(result.status, 'ok');
    assert.equal(result.count, 3);
    const rows = await published();
    assert.equal(rows.length, 1);
    // The thing they most recently finished, not the thing they started with.
    assert.equal(rows[0].media_item_id, last);
    assert.equal(rows[0].payload.count, 3);
  });

  it('dates the post when the sitting ended, not when it started', async () => {
    // The Feed pages by a keyset over causal_at, so a post that existed invisibly for ten
    // minutes has to enter the ordering where it became real.
    const s_ = await sitting();
    await note(s_, await ranked('Heat'));
    const [draft] = await events();
    const before_ = (
      await t.sql(`select causal_at from feed_events where id = $1`, [draft.id])
    ).rows[0].causal_at;

    await t.sql(`select pg_sleep(0.05)`);
    await finalize(s_);

    const after_ = (
      await t.sql(`select causal_at from feed_events where id = $1`, [draft.id])
    ).rows[0].causal_at;
    assert.ok(after_ > before_, 'causal_at moves to the end of the sitting');
  });

  it('a sitting that finished nothing leaves no post at all', async () => {
    const s_ = await sitting();

    const result = await finalize(s_);

    assert.equal(result.status, 'empty');
    assert.equal((await events()).length, 0);
    assert.equal((await published()).length, 0);
  });

  it('finalizing twice publishes one post', async () => {
    const s_ = await sitting();
    await note(s_, await ranked('Heat'));

    await finalize(s_);
    const again = await finalize(s_);

    // The second call finds no draft, which is the state it was asked for.
    assert.equal(again.status, 'empty');
    assert.equal((await published()).length, 1);
  });

  it('a later sitting is its own draft and its own post', async () => {
    const first = await sitting();
    await note(first, await ranked('Heat'));
    await finalize(first);

    const second = await sitting();
    await note(second, await ranked('Ronin'));

    // The published one and the running one coexist without contending.
    assert.equal((await published()).length, 1);
    assert.equal((await events()).length, 2);

    await finalize(second);
    assert.equal((await published()).length, 2);
  });
});
