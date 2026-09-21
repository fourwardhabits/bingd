import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * T5 — Refine your rankings (`20261013000100`, calibration epic §G, §H).
 *
 * What this file has to prove, in the order the brief states it:
 *
 *   1. **Only an explicit answer moves a title.** Refine never writes a watch event, a
 *      feed event, a notification, a list change, a watchlist change or a collection
 *      change, and it keeps `rankings.created_at` (the streak's clock).
 *   2. **Selection follows evidence, not chance.** A title whose neighbours were
 *      compared with it directly is not offered; a title placed without comparisons,
 *      or that later rankings grew around, is.
 *   3. **It ends.** Refining a title removes it from the pool by construction, a library
 *      converges to `nothing_waiting`, and a day has a ceiling the server enforces.
 *
 * Libraries are seeded directly as the owner (one statement each), with `backfill`
 * placements, which is the shape every pre-T2 ranking has in production.
 */

let t;
let user;
let seq = 0;

before(async () => {
  t = await createTestDb();
  await setConfig('ranking.refine_enabled', true);
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `refine_${seq}` });
  await t.actAs(user);
});

async function setConfig(key, value) {
  await t.sql(
    `insert into app_config (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

/**
 * `n` ranked movies in one band, in a known order, with a backfill placement each.
 * `offset` is the category position of the first one (for a second band below the first).
 */
async function library(
  n,
  { bucket = 'loved', offset = 0, confirmedDaysAgo = 200, triggers = false } = {},
) {
  const base = (seq += 1) * 100_000;
  // Seeded with triggers off: the award and watch-event trigger stack costs a scan of the
  // collection per inserted row, which is quadratic in a fixture of 1,200 and is not what
  // this file measures. Every row written here is the shape those triggers would leave.
  if (!triggers) await t.sql(`set session_replication_role = replica`);
  try {
    const { rows } = await t.sql(
      `with items as (
       insert into media_items (kind, tmdb_id, title, provenance)
       select 'movie', -($2::int + g), 'Lib ' || $2::int || ' ' || g, 'manual'
         from generate_series(1, $3::int) g
       returning id, tmdb_id
     ), numbered as (
       select id, row_number() over (order by tmdb_id desc)::int as n from items
     ), logged as (
       insert into user_media (user_id, media_item_id, bucket)
       select $1, id, $4::taste_bucket from numbered
       returning media_item_id
     ), ranked as (
       insert into rankings (user_id, media_item_id, category, bucket, position, created_at)
       select $1, id, 'movies', $4::taste_bucket, $5::int + n,
              now() - make_interval(days => $6::int)
         from numbered
       returning media_item_id, position
     ), placed as (
       insert into ranking_placements (user_id, media_item_id, category, kind, outcome,
         bucket, position, band_rank, band_size, category_size, score, adjustable, created_at)
       select $1, id, 'movies', 'backfill', 'placed', $4::taste_bucket, $5::int + n, n, $3::int,
              $5::int + $3::int, 8.0, true, now() - make_interval(days => $6::int)
         from numbered
       returning media_item_id
     )
     select n.id from numbered n
      where exists (select 1 from ranked r where r.media_item_id = n.id)
        and exists (select 1 from placed p where p.media_item_id = n.id)
        and exists (select 1 from logged l where l.media_item_id = n.id)
      order by n.n`,
      [user, base, n, bucket, offset, confirmedDaysAgo],
    );
    return rows.map((r) => r.id);
  } finally {
    await t.sql(`set session_replication_role = default`);
  }
}

/** One answer, written as the owner, `daysAgo` days in the past. */
async function answered(winner, loser, daysAgo = 120) {
  await t.sql(
    `insert into comparisons (user_id, winner_id, loser_id, created_at)
     values ($1, $2, $3, now() - make_interval(days => $4::int))`,
    [user, winner, loser, daysAgo],
  );
}

/** A heavily compared library: every adjacent pair answered, in the current order. */
async function compareAdjacent(ids, daysAgo = 120) {
  await t.sql(
    `insert into comparisons (user_id, winner_id, loser_id, created_at)
     select $1, w, l, now() - make_interval(days => $3::int)
       from unnest($2::uuid[]) with ordinality a(w, i)
       join unnest($2::uuid[]) with ordinality b(l, j) on j = i + 1`,
    [user, ids, daysAgo],
  );
}

const candidates = async ({ limit = 5, seed = 1, recent = [] } = {}) =>
  call(`refine_candidates('movies', $1, $2, $3::uuid[])`, [limit, seed, recent]);

/**
 * Refines `id`, answering every comparison from `truth` (ids, best first). `mode` can be
 * `skip` (Too tough until the session gives up).
 */
async function refine(id, truth, { mode = 'answer' } = {}) {
  let r = await call(`refine_start($1, $2)`, [id, await op()]);
  const opened = r;
  const pivots = [];
  let answers = 0;
  let guard = 0;
  while (!r.done) {
    pivots.push(r.pivot);
    if (mode === 'skip') {
      r = await call(`rank_skip($1, $2)`, [r.session_id, await op()]);
    } else {
      const winner = truth.indexOf(id) < truth.indexOf(r.pivot) ? id : r.pivot;
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, winner, await op()]);
      answers += 1;
    }
    if ((guard += 1) > 64) throw new Error('refine did not converge');
  }
  return { ...r, answers, pivots, opened };
}

const positionOf = async (id) =>
  (
    await t.sql(
      `select position, created_at from rankings where user_id = $1 and media_item_id = $2`,
      [user, id],
    )
  ).rows[0];

const order = async () =>
  (
    await t.sql(
      `select media_item_id from rankings where user_id = $1 and category = 'movies'
        order by position`,
      [user],
    )
  ).rows.map((r) => r.media_item_id);

/** Everything Refine must never write. Compared before and after, as JSON. */
const sideEffects = async () =>
  (
    await t.sql(
      `select
         (select count(*) from feed_events where actor_id = $1)::int as feed,
         (select count(*) from notifications where recipient_id = $1 or actor_id = $1)::int as notes,
         (select coalesce(jsonb_agg(to_jsonb(w) order by w.id), '[]')
            from watch_events w where w.user_id = $1) as watches,
         (select coalesce(jsonb_agg(to_jsonb(um) order by um.media_item_id), '[]')
            from user_media um where um.user_id = $1) as collection,
         (select coalesce(jsonb_agg(to_jsonb(wl) order by wl.media_item_id), '[]')
            from watchlist wl where wl.user_id = $1) as watchlist,
         (select coalesce(jsonb_agg(to_jsonb(li) order by li.media_item_id), '[]')
            from list_items li join lists l on l.id = li.list_id where l.owner_id = $1) as listed,
         (select coalesce(jsonb_agg(r.created_at order by r.media_item_id), '[]')
            from rankings r where r.user_id = $1) as ranked_at`,
      [user],
    )
  ).rows[0];

const valid = async () => {
  await t.sql(`select assert_ranking_valid($1, 'movies')`, [user]);
  await t.sql(`select assert_placements_valid($1)`, [user]);
};

// ---------------------------------------------------------------------------

describe('gating', () => {
  it('is disabled until the flag is flipped, and refuses to start', async () => {
    const ids = await library(30);
    await setConfig('ranking.refine_enabled', false);
    try {
      const r = await candidates();
      assert.equal(r.status, 'disabled');
      assert.deepEqual(r.candidates, []);
      const err = await t.errorFrom(`select refine_start($1)`, [ids[3]]);
      assert.equal(err?.code, '0A000');
    } finally {
      await setConfig('ranking.refine_enabled', true);
    }
  });

  it('is disabled by the prior-search kill switch too', async () => {
    await library(30);
    await setConfig('ranking.prior_search_enabled', false);
    try {
      assert.equal((await candidates()).status, 'disabled');
    } finally {
      await setConfig('ranking.prior_search_enabled', true);
    }
  });

  it('ships with the flag off', async () => {
    const { rows } = await t.sql(
      `select value from app_config where key = 'ranking.refine_enabled'`,
    );
    // The file inserts false; this suite flipped it in `before`, so read the file's intent
    // from the migration text rather than the row.
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(
      new URL(
        '../migrations/20261013000100_a_ranking_worth_a_second_look.sql',
        import.meta.url,
      ),
      'utf8',
    );
    assert.match(sql, /\('ranking\.refine_enabled',\s+'false'::jsonb\)/);
    assert.equal(rows.length, 1);
  });
});

describe('library shapes', () => {
  it('10 ranked titles: too small, nothing offered', async () => {
    await library(10);
    const r = await candidates();
    assert.equal(r.status, 'too_small');
    assert.equal(r.min_ranked, 20);
  });

  it('a heavily compared library has nothing waiting', async () => {
    const ids = await library(40);
    await compareAdjacent(ids);
    const r = await candidates();
    assert.equal(r.status, 'nothing_waiting');
  });

  it('100 imported titles with no comparisons: the top of the list is offered first', async () => {
    await library(100);
    const r = await candidates({ limit: 5 });
    assert.equal(r.status, 'ready');
    assert.equal(r.candidates.length, 5);
    assert.equal(new Set(r.candidates.map((c) => c.media_item_id)).size, 5);
    for (const c of r.candidates) {
      assert.ok(c.position <= 25, `rank weight puts the top first (got #${c.position})`);
      assert.equal(c.reason, 'never_compared');
      assert.equal(c.tolerance, 0);
      assert.ok(c.title && c.bucket === 'loved');
    }
  });

  it('only the uncompared stretch of an otherwise dense library is offered', async () => {
    // 60 titles, every adjacent pair answered — except that #21..#25 arrived later and
    // were never compared with anything. Their neighbours now have a gap too.
    const ids = await library(60);
    const dense = [...ids.slice(0, 20), ...ids.slice(25)];
    await compareAdjacent(dense);
    const r = await candidates({ limit: 20 });
    assert.equal(r.status, 'ready');
    const offered = r.candidates.map((c) => c.position);
    for (const p of offered) assert.ok(p >= 20 && p <= 26, `#${p} is outside the gap`);
    assert.ok(offered.includes(23), 'the middle of the uncompared stretch');
  });

  it('never offers an unranked title', async () => {
    const ids = await library(30);
    const extra = await t.createMovie('Logged, never ranked', 90_000_000 + (seq += 1));
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
      [user, extra],
    );
    const r = await candidates({ limit: 20 });
    assert.ok(!r.candidates.some((c) => c.media_item_id === extra));
    const err = await t.errorFrom(`select refine_start($1)`, [extra]);
    assert.equal(err?.code, 'P0002');
    assert.ok(ids.length === 30);
  });

  it('1,200 ranked titles: a bounded answer, top-weighted, with deep titles tolerant', async () => {
    const ids = await library(1200);
    // A dense top 100 so the pool has to reach below it.
    await compareAdjacent(ids.slice(0, 100));
    const started = Date.now();
    const r = await candidates({ limit: 5 });
    const elapsed = Date.now() - started;
    assert.equal(r.status, 'ready');
    assert.equal(r.candidates.length, 5);
    for (const c of r.candidates) {
      assert.ok(c.position >= 100, `#${c.position} was already evidenced`);
      assert.equal(c.tolerance, c.position <= 100 ? 1 : c.position <= 300 ? 3 : 7);
    }
    // PGlite, single-threaded wasm: a sanity bound, not the measurement. The real
    // PostgreSQL numbers are in perf/refine-scale.mjs.
    assert.ok(elapsed < 5000, `candidates took ${elapsed}ms`);
  });
});

describe('only answers move a title', () => {
  it('an answer that agrees with the list leaves everything alone', async () => {
    const ids = await library(30, { triggers: true });
    const target = ids[10];
    const before = await positionOf(target);
    const effects = await sideEffects();

    const r = await refine(target, ids);
    assert.equal(r.movement.outcome, 'unchanged');
    assert.equal(r.movement.kind, 'refine');
    assert.equal(r.answers, 2, 'the neighbour above and the neighbour below');
    assert.deepEqual(r.pivots, [ids[9], ids[11]]);

    const now = await positionOf(target);
    assert.equal(now.position, before.position);
    assert.equal(now.created_at.getTime(), before.created_at.getTime());
    assert.deepEqual(await sideEffects(), effects);
    await valid();
  });

  it('a title the reader places higher moves, and nothing else is written', async () => {
    // Seeded WITH the trigger stack, so the collection it starts from carries every row
    // those triggers write (watch events, provenance) and "nothing else" means something.
    const ids = await library(40, { triggers: true });
    const target = ids[20]; // #21
    // The reader now likes it better than #15..#20.
    const truth = [...ids.slice(0, 14), target, ...ids.slice(14, 20), ...ids.slice(21)];

    // A watchlist entry added after the ranking, and a list holding the title: both must
    // survive a move (the watchlist chronology rule reads the preserved created_at).
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
      user,
      target,
    ]);
    const list = (
      await t.sql(`insert into lists (owner_id, title) values ($1, 'Mine') returning id`, [
        user,
      ])
    ).rows[0].id;
    await t.sql(
      `insert into list_items (list_id, media_item_id, position) values ($1, $2, 1)`,
      [list, target],
    );

    const before = await positionOf(target);
    const effects = await sideEffects();
    const r = await refine(target, truth);

    assert.equal(r.movement.outcome, 'moved');
    assert.equal(r.movement.from_position, 21);
    assert.equal(r.position, 15);
    assert.deepEqual(await order(), truth);

    const now = await positionOf(target);
    assert.equal(now.created_at.getTime(), before.created_at.getTime(), 'the streak clock');

    const after = await sideEffects();
    assert.deepEqual(
      after,
      effects,
      'no watch, feed, notification, list, watchlist or row change',
    );
    await valid();

    const { rows } = await t.sql(
      `select kind, outcome, tolerance, strategy from ranking_placements
        where user_id = $1 and media_item_id = $2 order by created_at desc limit 1`,
      [user, target],
    );
    assert.deepEqual(rows[0], {
      kind: 'refine',
      outcome: 'moved',
      tolerance: 0,
      strategy: 'prior',
    });
  });

  it('a title the reader places lower moves down', async () => {
    const ids = await library(30);
    const target = ids[3]; // #4
    const truth = [...ids.slice(0, 3), ...ids.slice(4, 12), target, ...ids.slice(12)];
    const r = await refine(target, truth);
    assert.equal(r.movement.outcome, 'moved');
    assert.equal(r.position, 12);
    assert.deepEqual(await order(), truth);
    await valid();
  });

  it('identical displayed scores are not ties: positions decide, and answers reorder them', async () => {
    // In a band of 160, a run of titles in the #26–100 stretch prints one one-decimal
    // score. The list still orders them, and an answer reorders them. The move is three
    // places because that stretch's tolerance is ±1: a one-place swap there is, by design,
    // "still in the right place" (§H.5), which the next test pins.
    const ids = await library(160);
    const { rows } = await t.sql(
      `select r.media_item_id, r.position, score_for(r.bucket, r.position, 160)::numeric(3,1) as s
         from rankings r where r.user_id = $1 order by r.position`,
      [user],
    );
    const at = rows.findIndex(
      (row, i) =>
        i > 30 && i < 90 && [1, 2, 3].every((k) => Number(rows[i + k].s) === Number(row.s)),
    );
    assert.ok(at > 0, 'four neighbours share a displayed score');
    const lower = rows[at + 3].media_item_id;

    const truth = [...ids];
    truth.splice(at + 3, 1);
    truth.splice(at, 0, lower);
    const r = await refine(lower, truth);
    assert.equal(r.movement.outcome, 'moved');
    assert.equal(r.movement.from_position, at + 4);
    assert.equal(r.position, at + 1);
    assert.deepEqual(await order(), truth);
    await valid();
  });

  it('inside its tolerance a one-place disagreement deep in the list is "still" (by design)', async () => {
    const ids = await library(160);
    const at = 60; // #61: tolerance ±1
    const truth = [...ids];
    truth.splice(at, 2, ids[at + 1], ids[at]);
    const r = await refine(ids[at + 1], truth);
    assert.equal(r.movement.outcome, 'unchanged');
    assert.equal(r.answers, 2);
    assert.deepEqual(await order(), ids, 'nothing moved without an answer outside the window');
  });

  it('a reader who cannot call it keeps the title where it was (kept)', async () => {
    const ids = await library(30);
    const target = ids[12];
    const r = await refine(target, ids, { mode: 'skip' });
    assert.equal(r.movement.outcome, 'kept');
    assert.equal(r.position, 13);
    await valid();
  });

  it('Undo withdraws the answer and it links to nothing', async () => {
    const ids = await library(30);
    const target = ids[10];
    let r = await call(`refine_start($1, $2)`, [target, await op()]);
    r = await call(`rank_answer($1, $2, $3)`, [r.session_id, target, await op()]); // "better"
    r = await call(`rank_back($1, $2)`, [r.session_id, await op()]);
    assert.equal(r.done, false);
    // Now answer honestly.
    while (!r.done) {
      const winner = ids.indexOf(target) < ids.indexOf(r.pivot) ? target : r.pivot;
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, winner, await op()]);
    }
    assert.equal(r.movement.outcome, 'unchanged');
    await valid();
  });
});

describe('selection and pairs', () => {
  it('a refined title leaves the pool, and a round never repeats a title', async () => {
    const ids = await library(80);
    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      const r = await candidates({ limit: 1, seed: 7, recent: [...seen] });
      const next = r.candidates[0].media_item_id;
      assert.ok(!seen.has(next));
      seen.add(next);
      await refine(next, ids);
    }
    // A new session (new seed, no recent list) does not offer them again: cooldown.
    const again = await candidates({ limit: 20, seed: 99 });
    for (const c of again.candidates) assert.ok(!seen.has(c.media_item_id));
  });

  it('neighbours of a title refined this session are discounted (diversity)', async () => {
    await library(100);
    const first = (await candidates({ limit: 1, seed: 3 })).candidates[0];
    const next = await candidates({ limit: 3, seed: 3, recent: [first.media_item_id] });
    for (const c of next.candidates) {
      assert.ok(
        Math.abs(c.position - first.position) > 3,
        `#${c.position} is next to #${first.position}`,
      );
    }
  });

  it('the seed varies the order among equally useful titles and nothing else', async () => {
    await library(100);
    const a = (await candidates({ limit: 5, seed: 1 })).candidates.map((c) => c.media_item_id);
    const b = (await candidates({ limit: 5, seed: 2 })).candidates.map((c) => c.media_item_id);
    const a2 = (await candidates({ limit: 5, seed: 1 })).candidates.map((c) => c.media_item_id);
    assert.deepEqual(a, a2, 'deterministic for a seed');
    assert.notDeepEqual(a, b, 'different seeds, different order');
  });

  it('a recent answer is not asked again: the session opens past it', async () => {
    const ids = await library(30);
    const target = ids[10];
    // Answered 5 days ago: #10 beat the target. Still true.
    await answered(ids[9], target, 5);
    const r = await refine(target, ids);
    assert.ok(!r.pivots.includes(ids[9]), 'the recent pair was not repeated');
    assert.deepEqual(r.pivots, [ids[11]]);
    assert.equal(r.movement.outcome, 'unchanged');
    assert.equal(r.answers, 1);
  });

  it('an old answer is asked again (it is the thing being re-checked)', async () => {
    const ids = await library(30);
    const target = ids[10];
    await answered(ids[9], target, 400);
    const r = await refine(target, ids);
    assert.deepEqual(r.pivots, [ids[9], ids[11]]);
  });

  it('recent answers that already confirm the window still cost one fresh answer', async () => {
    const ids = await library(30);
    const target = ids[10];
    await answered(ids[9], target, 5);
    await answered(target, ids[11], 5);
    // Evidence is met, so it is not a candidate — but a direct start must not finalize
    // a placement with no answer in it.
    const offered = (await candidates({ limit: 20 })).candidates.map((c) => c.media_item_id);
    assert.ok(!offered.includes(target));
    const r = await refine(target, ids);
    assert.ok(r.answers >= 1);
  });

  it('a contradiction newer than the last confirmation is a reason, and a refine settles it', async () => {
    const ids = await library(40);
    await compareAdjacent(ids, 300);
    const target = ids[5];
    // Last week the reader said #20 beat #6 — the list says the opposite.
    await answered(ids[19], target, 7);
    const r1 = await candidates({ limit: 5 });
    const hit = r1.candidates.find((c) => c.media_item_id === target);
    assert.ok(hit, 'the contradicted title is offered');
    assert.equal(hit.reason, 'contradicted');
    await refine(target, ids); // the reader confirms the list
    const r2 = await candidates({ limit: 20 });
    assert.ok(!r2.candidates.some((c) => c.media_item_id === target));
  });

  it('a deep title one neighbour out is not worth a question; the same gap near the top is', async () => {
    const ids = await library(400);
    await compareAdjacent(ids);
    // Take out the direct answer between #10/#11 and between #350/#351, and leave what a
    // real bisection would have: each of the four still has an answer one title further
    // out. So each has a one-title gap. At the top (w = 0) that is worth a question; at
    // #350 (w = 7) it is well inside the tolerance.
    await t.sql(
      `delete from comparisons where user_id = $1 and
         ((winner_id = $2 and loser_id = $3) or (winner_id = $4 and loser_id = $5))`,
      [user, ids[9], ids[10], ids[349], ids[350]],
    );
    await answered(ids[9], ids[11]);
    await answered(ids[8], ids[10]);
    await answered(ids[349], ids[351]);
    await answered(ids[348], ids[350]);
    const offered = (await candidates({ limit: 20 })).candidates.map((c) => c.position);
    assert.ok(offered.includes(10) || offered.includes(11), 'the top gap is offered');
    assert.ok(!offered.some((p) => p > 300), `nothing deep: ${offered}`);
  });
});

describe('finite sessions', () => {
  it('a library converges to nothing_waiting and every title ends refined enough', async () => {
    const ids = await library(30);
    let targets = 0;
    for (;;) {
      // Make every cooldown irrelevant: this asserts the EVIDENCE rule terminates.
      await t.sql(
        `update ranking_placements set created_at = created_at - interval '400 days'
          where user_id = $1 and kind = 'refine'`,
        [user],
      );
      const r = await candidates({ limit: 1, seed: targets });
      if (r.status !== 'ready') {
        assert.equal(r.status, 'nothing_waiting');
        break;
      }
      await refine(r.candidates[0].media_item_id, ids);
      targets += 1;
      assert.ok(targets <= 30, 'no title is refined twice when nothing changed');
    }
    const { rows } = await t.sql(
      `select count(*)::int as n from _refine_support($1, 'movies') s
        where s.gap_above > _refine_tolerance(s.position)
           or s.gap_below > _refine_tolerance(s.position)`,
      [user],
    );
    assert.equal(rows[0].n, 0);
  });

  it('the daily ceiling is the server’s: rested, and a new start refuses', async () => {
    const ids = await library(40);
    await setConfig('ranking.refine_daily_targets', 2);
    try {
      await refine((await candidates({ limit: 1 })).candidates[0].media_item_id, ids);
      // An open session for a third title, opened before the ceiling is reached.
      const third = (await candidates({ limit: 3, seed: 5 })).candidates.at(-1).media_item_id;
      const open = await call(`refine_start($1, $2)`, [third, await op()]);
      assert.equal(open.done, false);
      const second = (await candidates({ limit: 5, seed: 9 })).candidates.find(
        (c) => c.media_item_id !== third,
      ).media_item_id;
      await refine(second, ids);

      assert.equal((await candidates()).status, 'rested');
      const fourth = ids.find((id) => id !== third && id !== second);
      const err = await t.errorFrom(`select refine_start($1)`, [fourth]);
      assert.equal(err?.code, '53400');
      // Resuming the one already open is not a new target.
      const resumed = await call(`refine_start($1, $2)`, [third, await op()]);
      assert.equal(resumed.resumed, true);
    } finally {
      await setConfig('ranking.refine_daily_targets', 30);
    }
  });

  it('a kept title rests three times as long as a refined one', async () => {
    const ids = await library(40);
    const target = (await candidates({ limit: 1 })).candidates[0].media_item_id;
    await refine(target, ids, { mode: 'skip' });
    await t.sql(
      `update ranking_placements set created_at = now() - interval '45 days'
        where user_id = $1 and kind = 'refine'`,
      [user],
    );
    let offered = (await candidates({ limit: 20 })).candidates.map((c) => c.media_item_id);
    assert.ok(!offered.includes(target), 'still resting at 45 days');
    await t.sql(
      `update ranking_placements set created_at = now() - interval '95 days'
        where user_id = $1 and kind = 'refine'`,
      [user],
    );
    offered = (await candidates({ limit: 40 })).candidates.map((c) => c.media_item_id);
    assert.ok(offered.includes(target), 'back after 90');
  });

  it('"I don’t remember it" rests the title for 180 days and closes its session', async () => {
    const ids = await library(40);
    const target = (await candidates({ limit: 1 })).candidates[0].media_item_id;
    const before = await positionOf(target);
    await call(`refine_start($1, $2)`, [target, await op()]);
    const s = await call(`refine_snooze($1)`, [target]);
    assert.ok(s.snoozed_until);
    const { rows } = await t.sql(
      `select count(*)::int as n from ranking_sessions where user_id = $1 and media_item_id = $2`,
      [user, target],
    );
    assert.equal(rows[0].n, 0);
    assert.equal((await positionOf(target)).position, before.position);
    const offered = (await candidates({ limit: 40 })).candidates.map((c) => c.media_item_id);
    assert.ok(!offered.includes(target));
    assert.ok(ids.includes(target));
  });
});

describe('interruption, replay and resume', () => {
  it('an interrupted target comes back first, and resumes where it stopped', async () => {
    const ids = await library(60);
    const target = ids[40]; // deep enough to need more than one answer when it moves
    const truth = [...ids.slice(0, 30), target, ...ids.slice(30, 40), ...ids.slice(41)];
    let r = await call(`refine_start($1, $2)`, [target, await op()]);
    const winner = truth.indexOf(target) < truth.indexOf(r.pivot) ? target : r.pivot;
    r = await call(`rank_answer($1, $2, $3)`, [r.session_id, winner, await op()]);
    assert.equal(r.done, false);
    const pivotBefore = r.pivot;

    // The app dies. Next time Refine opens, that target is first.
    const next = await candidates({ limit: 3, seed: 42 });
    assert.equal(next.candidates[0].media_item_id, target);
    assert.equal(next.candidates[0].resume, true);

    const resumed = await call(`refine_start($1, $2)`, [target, await op()]);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.pivot, pivotBefore);
    assert.ok(resumed.pivot_card?.title);

    r = resumed;
    while (!r.done) {
      const w = truth.indexOf(target) < truth.indexOf(r.pivot) ? target : r.pivot;
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, w, await op()]);
    }
    assert.equal(r.movement.outcome, 'moved');
    assert.deepEqual(await order(), truth);
    await valid();
  });

  it('a replayed start and a replayed answer are applied once', async () => {
    const ids = await library(30);
    const target = ids[10];
    const startOp = await op();
    const a = await call(`refine_start($1, $2)`, [target, startOp]);
    const b = await call(`refine_start($1, $2)`, [target, startOp]);
    assert.deepEqual(b, a);

    const answerOp = await op();
    const x = await call(`rank_answer($1, $2, $3)`, [a.session_id, a.pivot, answerOp]);
    const y = await call(`rank_answer($1, $2, $3)`, [a.session_id, a.pivot, answerOp]);
    assert.deepEqual(y, x);
    const { rows } = await t.sql(
      `select count(*)::int as n from comparisons where session_id = $1`,
      [a.session_id],
    );
    assert.equal(rows[0].n, 1);
  });

  it('a band that moved under an open refine session is rebased, not corrupted', async () => {
    const ids = await library(30);
    const target = ids[15];
    let r = await call(`refine_start($1, $2)`, [target, await op()]);
    // Another title is ranked into the band from another screen.
    const fresh = await t.createMovie('Arrived mid-refine', 80_000_000 + (seq += 1));
    let s = await call(`rank_start($1, 'loved', $2)`, [fresh, await op()]);
    while (!s.done)
      s = await call(`rank_answer($1, $2, $3)`, [s.session_id, s.pivot, await op()]);
    const truth = await order();

    while (!r.done) {
      const w = truth.indexOf(target) < truth.indexOf(r.pivot) ? target : r.pivot;
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, w, await op()]);
    }
    assert.equal(r.movement.outcome, 'unchanged');
    assert.deepEqual(await order(), truth);
    await valid();
  });

  it('refuses a title alone in its band, and another reader’s title', async () => {
    const ids = await library(25);
    const lone = (await library(1, { bucket: 'fine', offset: 25 }))[0];
    assert.equal((await t.errorFrom(`select refine_start($1)`, [lone]))?.code, '22023');

    const other = await t.createUser({ username: `refine_other_${seq}` });
    await t.actAs(other);
    assert.equal((await t.errorFrom(`select refine_start($1)`, [ids[3]]))?.code, 'P0002');
    await t.actAs(user);
  });
});

describe('privacy', () => {
  it('snoozes are readable by their owner only', async () => {
    const ids = await library(25);
    await call(`refine_snooze($1)`, [ids[2]]);
    const mine = await t.asUser(user, () =>
      t.sql(`select count(*)::int as n from ranking_snoozes`),
    );
    assert.equal(mine.rows[0].n, 1);
    const other = await t.createUser({ username: `refine_peek_${seq}` });
    const theirs = await t.asUser(other, () =>
      t.sql(`select count(*)::int as n from ranking_snoozes`),
    );
    assert.equal(theirs.rows[0].n, 0);
  });

  it('the new functions are not reachable signed out', async () => {
    for (const q of [
      `select refine_candidates('movies')`,
      `select refine_start(gen_random_uuid())`,
      `select refine_snooze(gen_random_uuid())`,
    ]) {
      const err = await t.asAnon(() => t.errorFrom(q));
      assert.equal(err?.code, '42501', q);
    }
  });
});
