#!/usr/bin/env node
/**
 * Refine (T5, `20261013000100`) against a REAL PostgreSQL 17: how long selection takes,
 * and whether choosing by evidence beats choosing at random.
 *
 *   node supabase/tests/perf/refine-scale.mjs                 # both parts
 *   node supabase/tests/perf/refine-scale.mjs --sizes 1000,2500 --skip-sim
 *
 * ---------------------------------------------------------------------------
 * PART 1 — latency
 *
 * Per size, two libraries in one band (the worst case for band arithmetic):
 *   compared   every title has answers at distances 1, 2, 4, 8 … above and below — the
 *              evidence a bisection leaves, about 2·log2(n) per title
 *   imported   no answers at all (the imported / pre-T2 shape)
 * Timed as the signed-in user through the real functions: `refine_candidates` (limit 5 and
 * limit 1), and `refine_start` + cancel. Plus the server-side execution time from
 * EXPLAIN ANALYZE of the evidence statement, which excludes the loopback round trip.
 * §G.3's budget is < 50 ms at 2,500 ranked titles.
 *
 * PART 2 — selection value
 *
 * A 200-title band whose stored order differs from a known true order in two ways:
 *   imported  30 titles displaced 5–40 places, with no answers of their own
 *   drifted   10 titles displaced 5–40 places, whose answers agree with where they are
 *             (the reader's opinion moved after they answered — invisible to evidence)
 * Every other title has bisection-like answers that agree with the stored order.
 *
 * Three strategies spend the same budget of answers, each on its own copy, answering from
 * the true order through the real `refine_start` / `rank_answer`:
 *   evidence  `refine_candidates`, one target at a time (what the app does)
 *   random    a uniformly random ranked title, same engine
 *   pairs     two random titles (reported analytically: the chance a random pair reveals
 *             any disagreement at all is inversions / C(n, 2))
 * The measure is inversions against the true order — pairs the list has the wrong way
 * round — before and after.
 *
 * Not a test file, so it is in no `*.test.mjs` glob.
 */
import { performance } from 'node:perf_hooks';

import { createRaceDb, fixtures, stopCluster } from '../concurrency/harness.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const SIZES = option('--sizes', '100,1000,2500').split(',').map(Number);
const SKIP_SIM = args.includes('--skip-sim');
const BUDGET = Number(option('--budget', '120'));
const TRIALS = Number(option('--trials', '3'));

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const max = (v) => Math.max(...v);
const ms = (v) => `${v.toFixed(1)}ms`;

let tmdbBase = 70_000_000;

/** Ranks `order` (media ids, best first) for `user`, with backfill placements. */
async function seedOrder(db, user, order) {
  await db.sql(
    `insert into user_media (user_id, media_item_id, bucket)
     select $1, id, 'loved' from unnest($2::uuid[]) id`,
    [user, order],
  );
  await db.sql(
    `insert into rankings (user_id, media_item_id, category, bucket, position, created_at)
     select $1, id, 'movies', 'loved', n, now() - interval '200 days'
       from unnest($2::uuid[]) with ordinality u(id, n)`,
    [user, order],
  );
  await db.sql(
    `insert into ranking_placements (user_id, media_item_id, category, kind, outcome, bucket,
       position, band_rank, band_size, category_size, score, adjustable, created_at)
     select $1, id, 'movies', 'backfill', 'placed', 'loved', n, n, $3, $3, 8.0, true,
            now() - interval '200 days'
       from unnest($2::uuid[]) with ordinality u(id, n)`,
    [user, order, order.length],
  );
}

async function movies(db, n) {
  const rows = await db.rows(
    `insert into media_items (kind, tmdb_id, title, provenance)
     select 'movie', -($1::int + g), 'Refine scale ' || $1::int || ' ' || g, 'manual'
       from generate_series(1, $2::int) g
     returning id, tmdb_id`,
    [(tmdbBase += 10_000), n],
  );
  return rows.sort((a, b) => b.tmdb_id - a.tmdb_id).map((r) => r.id);
}

/**
 * Answers at distances 1, 2, 4, 8 … in both directions, agreeing with `order`, for every
 * title not in `skip` — the shape a bisection leaves behind.
 */
async function bisectionEvidence(db, user, order, skip = new Set()) {
  const winners = [];
  const losers = [];
  for (let i = 0; i < order.length; i += 1) {
    if (skip.has(order[i])) continue;
    for (let d = 1; i + d < order.length; d *= 2) {
      if (skip.has(order[i + d])) continue;
      winners.push(order[i]);
      losers.push(order[i + d]);
    }
  }
  for (let at = 0; at < winners.length; at += 5000) {
    await db.sql(
      `insert into comparisons (user_id, winner_id, loser_id, created_at)
       select $1, w, l, now() - interval '120 days'
         from unnest($2::uuid[], $3::uuid[]) as u(w, l)`,
      [user, winners.slice(at, at + 5000), losers.slice(at, at + 5000)],
    );
  }
  return winners.length;
}

async function withTriggersOff(db, fn) {
  // Fixtures only: the award/watch trigger stack is quadratic over a bulk insert and is
  // not what this script measures. The functions under test run with triggers on.
  await db.sql(`set session_replication_role = replica`).catch(() => {});
  try {
    return await fn();
  } finally {
    await db.sql(`set session_replication_role = default`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Part 1
// ---------------------------------------------------------------------------

async function latency(db, fx, size, shape) {
  const user = await fx.createUser();
  const order = await movies(db, size);
  let answers = 0;
  await withTriggersOff(db, async () => {
    await seedOrder(db, user, order);
    if (shape === 'compared') answers = await bisectionEvidence(db, user, order);
  });
  await db.sql(`analyze rankings; analyze comparisons; analyze ranking_placements`);

  const s = await db.session(`lat-${shape}-${size}`);
  await s.actAs(user);

  const time = async (sql, params) => {
    const t0 = performance.now();
    const r = (await s.one(`select ${sql} as r`, params)).r;
    return { took: performance.now() - t0, r };
  };

  await time(`refine_candidates('movies', 5, 1)`); // warm
  const five = [];
  const one = [];
  for (let i = 0; i < 9; i += 1) {
    five.push((await time(`refine_candidates('movies', 5, $1)`, [i])).took);
    one.push((await time(`refine_candidates('movies', 1, $1)`, [i])).took);
  }

  const plan = await db.rows(
    `explain (analyze, format json) select * from _refine_support($1, 'movies')`,
    [user],
  );
  const serverMs = plan[0]['QUERY PLAN'][0]['Execution Time'];

  const starts = [];
  const status = (await time(`refine_candidates('movies', 5, 1)`)).r;
  for (const c of status.candidates.slice(0, 3)) {
    const t0 = performance.now();
    const r = (
      await s.one(`select refine_start($1, gen_random_uuid()) as r`, [c.media_item_id])
    ).r;
    starts.push(performance.now() - t0);
    if (!r.done) await s.one(`select rank_cancel($1) as r`, [r.session_id]);
  }
  await s.end();

  return {
    label: `${shape}-${size}`,
    answers,
    five,
    one,
    serverMs,
    starts,
    status: status.status,
  };
}

// ---------------------------------------------------------------------------
// Part 2
// ---------------------------------------------------------------------------

/** A seeded PRNG, so the scenario is the same on every run. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function inversions(list, truthIndex) {
  let n = 0;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (truthIndex.get(list[i]) > truthIndex.get(list[j])) n += 1;
    }
  }
  return n;
}

async function scenario(db, fx, trial = 0) {
  const N = 200;
  const rand = prng(20261013 + trial * 7919);
  const truth = await movies(db, N);

  // Displace 40 titles, each 5–40 places up or down.
  const stored = [...truth];
  const displaced = [];
  const pool = [...truth];
  for (let k = 0; k < 40; k += 1) {
    const id = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    displaced.push(id);
    const from = stored.indexOf(id);
    stored.splice(from, 1);
    const shift = (5 + Math.floor(rand() * 36)) * (rand() < 0.5 ? -1 : 1);
    const to = Math.max(0, Math.min(stored.length, from + shift));
    stored.splice(to, 0, id);
  }
  const imported = new Set(displaced.slice(0, 30));
  return { truth, stored, imported, N };
}

async function runStrategy(db, fx, sc, strategy) {
  const user = await fx.createUser();
  await withTriggersOff(db, async () => {
    await seedOrder(db, user, sc.stored);
    await bisectionEvidence(db, user, sc.stored, sc.imported);
  });
  const s = await db.session(`sim-${strategy}`);
  await s.actAs(user);

  const truthIndex = new Map(sc.truth.map((id, i) => [id, i]));
  const readOrder = async () =>
    (
      await db.rows(`select media_item_id from rankings where user_id = $1 order by position`, [
        user,
      ])
    ).map((r) => r.media_item_id);

  const before = inversions(await readOrder(), truthIndex);
  const rand = prng(7);
  const shown = [];
  let answers = 0;
  let targets = 0;
  let moved = 0;
  let exhausted = false;

  while (answers < BUDGET) {
    let target;
    if (strategy === 'evidence') {
      const c = (
        await s.one(`select refine_candidates('movies', 1, 3, $1::uuid[]) as r`, [shown])
      ).r;
      if (c.status !== 'ready') {
        exhausted = true;
        break;
      }
      target = c.candidates[0].media_item_id;
    } else {
      const left = sc.truth.filter((id) => !shown.includes(id));
      target = left[Math.floor(rand() * left.length)];
    }
    shown.push(target);
    targets += 1;

    let r = (await s.one(`select refine_start($1, gen_random_uuid()) as r`, [target])).r;
    while (!r.done) {
      const winner = truthIndex.get(target) < truthIndex.get(r.pivot) ? target : r.pivot;
      r = (
        await s.one(`select rank_answer($1, $2, gen_random_uuid()) as r`, [
          r.session_id,
          winner,
        ])
      ).r;
      answers += 1;
    }
    if (r.movement?.outcome === 'moved') moved += 1;
  }
  const after = inversions(await readOrder(), truthIndex);
  await s.end();
  return { strategy, before, after, answers, targets, moved, exhausted };
}

async function main() {
  const db = await createRaceDb();
  const fx = fixtures(db);
  await db.sql(
    `update app_config set value = 'true'::jsonb where key = 'ranking.refine_enabled'`,
  );
  await db.sql(
    `update app_config set value = '100000'::jsonb where key = 'ranking.refine_daily_targets'`,
  );

  try {
    console.log(
      '== part 1: latency (loopback; server = EXPLAIN ANALYZE of _refine_support) ==',
    );
    console.log(
      'library              answers   cand(5) p50  cand(5) max  cand(1) p50  server  start p50  status',
    );
    for (const size of SIZES) {
      for (const shape of ['compared', 'imported']) {
        const r = await latency(db, fx, size, shape);
        console.log(
          [
            r.label.padEnd(20),
            String(r.answers).padStart(7),
            ms(median(r.five)).padStart(12),
            ms(max(r.five)).padStart(12),
            ms(median(r.one)).padStart(12),
            ms(r.serverMs).padStart(7),
            (r.starts.length ? ms(median(r.starts)) : '-').padStart(10),
            ` ${r.status}`,
          ].join(' '),
        );
      }
    }

    if (!SKIP_SIM) {
      console.log(
        `\n== part 2: selection value (N=200, budget ${BUDGET} answers, ${TRIALS} trials) ==`,
      );
      const sum = {
        evidence: { fixed: 0, answers: 0, targets: 0, moved: 0 },
        random: { fixed: 0, answers: 0, targets: 0, moved: 0 },
      };
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const sc = await scenario(db, fx, trial);
        const pairs = (sc.N * (sc.N - 1)) / 2;
        for (const strategy of ['evidence', 'random']) {
          const r = await runStrategy(db, fx, sc, strategy);
          const fixed = r.before - r.after;
          Object.assign(sum[strategy], {
            fixed: sum[strategy].fixed + fixed,
            answers: sum[strategy].answers + r.answers,
            targets: sum[strategy].targets + r.targets,
            moved: sum[strategy].moved + r.moved,
          });
          console.log(
            `trial ${trial} ${strategy.padEnd(9)} inversions ${r.before} -> ${r.after} ` +
              `(fixed ${fixed}, ${(fixed / Math.max(r.answers, 1)).toFixed(1)} per answer), ` +
              `targets ${r.targets}, moved ${r.moved}, answers ${r.answers}` +
              (r.exhausted ? ', stopped: nothing_waiting' : ''),
          );
          if (strategy === 'evidence') {
            console.log(
              `trial ${trial} pairs     a uniformly random pair disagrees with the list with ` +
                `p = ${r.before}/${pairs} = ${((100 * r.before) / pairs).toFixed(1)}%`,
            );
          }
        }
      }
      for (const [strategy, s] of Object.entries(sum)) {
        console.log(
          `TOTAL ${strategy.padEnd(9)} ${(s.fixed / s.answers).toFixed(2)} inversions fixed per ` +
            `answer; ${s.moved}/${s.targets} targets moved`,
        );
      }
    }
  } finally {
    await db.close();
    await stopCluster();
  }
}

await main();
