#!/usr/bin/env node
/**
 * `community_score` with contributor eligibility (20261119000100) against a REAL
 * PostgreSQL 17: latency and plan shape for one title with about a thousand raters.
 *
 *   node supabase/tests/perf/community-score-scale.mjs
 *   node supabase/tests/perf/community-score-scale.mjs --raters 1000 --runs 30 --plans
 *
 * The question is the one founder §6 asks ("avoid N+1 reads and excessive recalculation"):
 * eligibility is a live count per rater, so the single-title read must stay bounded by
 * that title's raters (a show: its raters plus its seasons' raters), each counted with an
 * index range on `rankings_lookup (user_id, category, position)`, never a scan of every
 * user's collection.
 *
 * Fixture, per rater: a library of 5–60 movies (about a third under ten, so ineligible)
 * including the target movie, and a TV library of 1–25 entries including 1–6 seasons of
 * one target show, about a third of them with an explicit ranking of the show too.
 * Rows are bulk inserted with triggers off (fixture only, as in refine-scale.mjs); the
 * function under test runs normally, as a signed-in reader.
 *
 * `--plans` prints the nested statement plans through auto_explain (log_nested_statements),
 * which is the only way to see inside a SECURITY DEFINER SQL function: it is never
 * inlined, so a plain EXPLAIN of the call shows a Function Scan and nothing else.
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
const RATERS = Number(option('--raters', '1000'));
const RUNS = Number(option('--runs', '30'));
const PLANS = args.includes('--plans');

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const p95 = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.95)];
const ms = (v) => `${v.toFixed(2)}ms`;

/** Deterministic, so two runs build the same population. */
let state = 20261119;
const rand = () => {
  state = (state * 1103515245 + 12345) % 2147483648;
  return state / 2147483648;
};
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

async function withTriggersOff(db, fn) {
  await db.sql(`set session_replication_role = replica`).catch(() => {});
  try {
    return await fn();
  } finally {
    await db.sql(`set session_replication_role = default`).catch(() => {});
  }
}

async function catalogue(db, kind, n, base, parent = null) {
  const rows =
    kind === 'season'
      ? await db.rows(
          `insert into media_items (kind, parent_id, season_number, title, provenance)
           select 'season', $2::uuid, g, 'Scale season ' || g, 'manual'
             from generate_series(1, $1::int) g returning id`,
          [n, parent],
        )
      : await db.rows(
          `insert into media_items (kind, tmdb_id, title, provenance)
           select $3::media_kind, -($1::int + g), 'Scale ' || $3::text || ' ' || g, 'manual'
             from generate_series(1, $2::int) g returning id`,
          [base, n, kind],
        );
  return rows.map((r) => r.id);
}

/** Inserts one pool for one user: ids best first, bands split loved / fine / not_for_me. */
async function pool(db, user, category, ids) {
  const third = Math.ceil(ids.length / 3);
  await db.sql(
    `insert into rankings (user_id, media_item_id, category, bucket, position)
     select $1, id, $3::ranking_category,
            (case when n <= $4 then 'loved' when n <= 2 * $4 then 'fine' else 'not_for_me' end)::taste_bucket,
            n
       from unnest($2::uuid[]) with ordinality u(id, n)`,
    [user, ids, category, third],
  );
}

const shuffle = (v) => {
  const out = [...v];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

async function main() {
  const db = await createRaceDb();
  try {
    const fx = fixtures(db);
    const films = await catalogue(db, 'movie', 2000, 80_000_000);
    const shows = await catalogue(db, 'series', 300, 81_000_000);
    const target = films[0];
    const show = shows[0];
    const seasons = await catalogue(db, 'season', 6, 0, show);
    const otherSeasons = [];
    for (const s of shows.slice(1, 40))
      otherSeasons.push(...(await catalogue(db, 'season', 8, 0, s)));

    let eligibleMovie = 0;
    let eligibleTv = 0;
    const started = performance.now();
    await withTriggersOff(db, async () => {
      for (let i = 0; i < RATERS; i += 1) {
        const user = await fx.createUser();
        const movieCount = rand() < 0.33 ? between(1, 9) : between(10, 60);
        await pool(db, user, 'movies', [
          target,
          ...shuffle(films.slice(1)).slice(0, movieCount - 1),
        ]);
        if (movieCount >= 10) eligibleMovie += 1;

        const own = shuffle(seasons).slice(0, between(1, 6));
        const extra = shuffle(otherSeasons).slice(
          0,
          rand() < 0.33 ? between(0, 2) : between(4, 18),
        );
        await pool(db, user, 'tv_seasons', shuffle([...own, ...extra]));
        const explicit = rand() < 0.33;
        const showPool = shuffle([
          ...(explicit ? [show] : []),
          ...shuffle(shows.slice(1)).slice(0, between(0, 3)),
        ]);
        if (showPool.length) await pool(db, user, 'tv_shows', showPool);
        if (own.length + extra.length + showPool.length >= 10) eligibleTv += 1;
      }
    });
    await db.sql(`analyze rankings; analyze media_items; analyze profiles`);
    console.log(
      `seeded ${RATERS} raters in ${ms(performance.now() - started)}: ` +
        `${eligibleMovie} movie-eligible, ${eligibleTv} TV-eligible`,
    );

    const reader = await fx.createUser();
    const session = await db.session('reader');
    await session.actAs(reader);

    for (const [label, id] of [
      ['movie  (1 title, all raters)', target],
      ['season (1 season)', seasons[0]],
      ['series (show + 6 seasons)', show],
    ]) {
      const times = [];
      let last;
      for (let r = 0; r < RUNS; r += 1) {
        const t0 = performance.now();
        last = (await session.client.query(`select * from community_score($1)`, [id])).rows[0];
        times.push(performance.now() - t0);
      }
      console.log(
        `${label.padEnd(30)} median ${ms(median(times))}  p95 ${ms(p95(times))}  ` +
          `-> score ${last.score} from ${last.rating_count} eligible contributors`,
      );
    }

    // group_picks('tv') reads community_score laterally for every candidate series (up to
    // 200), so time that shape too: the 200 fixture shows other than the big one (each with
    // a handful of raters), in one statement.
    {
      const times = [];
      for (let r = 0; r < Math.min(RUNS, 5); r += 1) {
        const t0 = performance.now();
        await session.client.query(
          `select count(cs.score) from unnest($1::uuid[]) s(id)
             cross join lateral community_score(s.id) cs`,
          [shows.slice(1, 201)],
        );
        times.push(performance.now() - t0);
      }
      console.log(
        `200 small series, one statement (group_picks shape) median ${ms(median(times))}`,
      );
    }

    if (PLANS) {
      const admin = await db.session('planner');
      const notices = [];
      admin.client.on('notice', (n) => notices.push(n.message));
      await admin.client.query(`load 'auto_explain'`);
      await admin.client.query(`set auto_explain.log_min_duration = 0`);
      await admin.client.query(`set auto_explain.log_analyze = on`);
      await admin.client.query(`set auto_explain.log_nested_statements = on`);
      await admin.client.query(
        `set auto_explain.log_timing = ${args.includes('--timing') ? 'on' : 'off'}`,
      );
      await admin.client.query(`set client_min_messages = log`);
      await admin.actAs(reader);
      for (const id of [target, show]) {
        notices.length = 0;
        await admin.client.query(`select * from community_score($1)`, [id]);
        console.log(`\n---- plans for ${id === target ? 'the movie' : 'the series'} ----`);
        for (const n of notices) console.log(n);
      }
    }
  } finally {
    await db.close();
    await stopCluster();
  }
}

await main();
