#!/usr/bin/env node
/**
 * How long one comparison takes in the database, by ranking-library size, against a REAL
 * PostgreSQL 17.
 *
 *   node supabase/tests/perf/ranking-latency.mjs                  # 50, 250, 700, 1000
 *   node supabase/tests/perf/ranking-latency.mjs --sizes 1000 --subjects 5
 *
 * Written for the "1-3 seconds between comparisons" report (2026-09-16). The question it
 * answers is narrow: **does the server's share of a comparison grow with the size of the
 * ranking, and is it anywhere near a second?** It times each RPC as the signed-in user,
 * through the real functions, over a loopback connection, so the number is database work
 * plus a negligible local round trip. The network between a phone and Supabase is not in
 * it and is reported separately by whoever runs this against a device.
 *
 * Two libraries per size:
 *   ranked    N titles ranked in one band, the worst case for band arithmetic
 *   imported  N titles logged but unranked (a Letterboxd import) beside 20 ranked, which
 *             is the reporting user's shape
 *
 * Not a test file, so it is in no `*.test.mjs` glob. It takes about a minute.
 */
import { performance } from 'node:perf_hooks';

import { createRaceDb, fixtures, stopCluster } from '../concurrency/harness.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

const SIZES = option('--sizes', '50,250,700,1000').split(',').map(Number);
const SUBJECTS = Number(option('--subjects', '4'));

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};
const max = (values) => (values.length ? Math.max(...values) : NaN);
const ms = (value) => `${value.toFixed(2)}ms`;

/** Seeds a library directly, as the owner: the ranking functions are what is measured. */
let seedBase = 10_000_000;

async function seed(db, fx, { ranked, unranked }) {
  const user = await fx.createUser();
  await db.sql(
    `with items as (
       insert into media_items (kind, tmdb_id, title, provenance)
       select 'movie', -($4::int + g), 'seed ' || g, 'manual'
         from generate_series(1, $2::int) g
       returning id, title
     ), numbered as (
       select id, row_number() over (order by title) as n from items
     ), logged as (
       insert into user_media (user_id, media_item_id, bucket)
       select $1, id, case when n <= $3::int then 'loved'::taste_bucket else null end
         from numbered
       returning media_item_id
     )
     insert into rankings (user_id, media_item_id, category, bucket, position)
     select $1, id, 'movies', 'loved', n from numbered where n <= $3::int`,
    [user, ranked + unranked, ranked, (seedBase += 100000)],
  );
  return user;
}

async function measure(db, fx, label, shape) {
  const user = await seed(db, fx, shape);
  const s = await db.session(label);
  await s.actAs(user);

  const timings = { start: [], answer: [], finalize: [], back: [] };
  let comparisons = 0;

  for (let i = 0; i < SUBJECTS; i += 1) {
    const subject = await fx.createMovie(`${label} subject ${i}`);

    let t0 = performance.now();
    let step = (
      await s.one(`select rank_start($1, 'loved', gen_random_uuid()) as r`, [subject])
    ).r;
    timings.start.push(performance.now() - t0);

    // One Undo per subject, after the first answer, then carry on.
    let undone = false;
    while (!step.done) {
      // Alternate winners so the search walks the middle of the band rather than an edge.
      const winner = comparisons % 2 === 0 ? subject : step.pivot;
      t0 = performance.now();
      const next = (
        await s.one(`select rank_answer($1, $2, gen_random_uuid()) as r`, [
          step.session_id,
          winner,
        ])
      ).r;
      const took = performance.now() - t0;
      comparisons += 1;
      (next.done ? timings.finalize : timings.answer).push(took);

      if (!next.done && !undone) {
        undone = true;
        t0 = performance.now();
        step = (await s.one(`select rank_back($1, gen_random_uuid()) as r`, [next.session_id]))
          .r;
        timings.back.push(performance.now() - t0);
        continue;
      }
      step = next;
    }
  }

  return { label, ...shape, comparisons, timings };
}

async function main() {
  const db = await createRaceDb();
  const fx = fixtures(db);
  const rows = [];

  try {
    // Warm the plan cache once so the first size does not pay for everybody.
    await measure(db, fx, 'warm', { ranked: 20, unranked: 0 });

    for (const size of SIZES) {
      for (const [label, shape] of [
        [`ranked-${size}`, { ranked: size, unranked: 0 }],
        [`imported-${size}`, { ranked: 20, unranked: size }],
      ]) {
        const row = await measure(db, fx, label, shape);
        rows.push(row);
        print([row]);
      }
    }
  } finally {
    await db.close();
    await stopCluster();
  }

  print(rows, true);
}

function print(rows, header = false) {
  if (header) console.log('\n== summary ==');
  console.log(
    'library          ranked  unranked  answer p50  answer max  finalize p50  back p50  start p50',
  );
  for (const r of rows) {
    const t = r.timings;
    console.log(
      [
        r.label.padEnd(16),
        String(r.ranked).padStart(6),
        String(r.unranked).padStart(9),
        ms(median(t.answer)).padStart(11),
        ms(max(t.answer)).padStart(11),
        ms(median(t.finalize)).padStart(13),
        ms(median(t.back)).padStart(9),
        ms(median(t.start)).padStart(10),
      ].join(' '),
    );
  }
}

await main();
