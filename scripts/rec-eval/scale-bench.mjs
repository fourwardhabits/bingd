#!/usr/bin/env node
/**
 * Scale benchmark for Recommendation Engine V2's server half (founder spec 2026-11-10, §7).
 *
 *   node scripts/rec-eval/scale-bench.mjs [--users 100000] [--titles 60000] [--out DIR]
 *                                         [--concurrency 8] [--plans]
 *
 * **Synthetic data on a throwaway local cluster.** It boots a private PostgreSQL 17
 * (`embedded-postgres`, the same native binaries `test:race` uses) on a free port, applies
 * every migration in `supabase/migrations` verbatim, loads a generated workload, and times
 * the functions A1 and A2 add, as the reader they serve. Nothing here connects to any other
 * database, and the cluster is deleted at the end.
 *
 * Deliberately not an `npm run` alias: `package.json` `scripts` is an input to the Expo
 * runtime fingerprint (`config/push.cjs`).
 *
 * ---------------------------------------------------------------------------
 * The workload, and what it deliberately leaves out
 * ---------------------------------------------------------------------------
 *
 * - **Accounts.** `--users` profiles. 55% have never ranked anything; 35% are casual (3–20
 *   rankings), 8.5% engaged (20–200), 1.5% power users (200–1,500). 85% public, 1% suspended,
 *   a sprinkling of blocks. Follows are not loaded: no function measured here reads them,
 *   which is itself the point of V2 (following has no effect).
 * - **Titles.** `--titles` films plus a sixth as many series with two seasons each, in 14
 *   languages (English 55%), released 1930–2026 and skewed recent, TMDB-like popularity.
 * - **Skew.** Each pick is log-uniform over popularity rank (Zipf, s ≈ 1), so the most
 *   popular film is ranked by a large share of active accounts — the case the rater cap in
 *   `_refresh_taste_neighbours` exists for. Buckets follow eight taste clusters, so Matches
 *   genuinely vary.
 * - **Bulk load** runs with `session_replication_role = replica`, so ranking triggers
 *   (awards, Watchlist exits, provenance) do not fire and foreign keys are not checked. Those
 *   triggers are on the write path, which nothing in V2 adds to; the rows they would have
 *   written are not read by anything measured. `user_media` is loaded for the benchmark
 *   readers only: every V2 read of it is keyed by the caller.
 *
 * ---------------------------------------------------------------------------
 * What it measures
 * ---------------------------------------------------------------------------
 *
 * 1. Build time of A2's `rankings (media_item_id, user_id)` index on the loaded table, plain
 *    (the write-blocking window if built inside the migration) and `concurrently`.
 * 2. Per reader, single connection: `recommendation_engine()`, `catalogue_candidates`, a
 *    **cold** `collaborative_candidates` (its cache cleared, so the call includes
 *    `_refresh_taste_neighbours`) and the **warm** call after it. And the existing
 *    `people_taste_matches(10)` for comparison, since the gap analysis names it as a scale
 *    risk (it is not on the For You path).
 * 3. Concurrency: `--concurrency` sessions doing cold refreshes for different readers at
 *    once, with two writer sessions inserting rankings the whole time; writer latency shows
 *    whether a refresh ever blocks a user-facing write.
 * 4. With `--plans`: `auto_explain` (ANALYZE, BUFFERS, nested statements) for a cold refresh
 *    and a catalogue read by a casual and a power reader, written to `plans.txt`.
 *
 * Results go to `--out` (default: a new directory under the OS temp dir) as `results.json`,
 * `results.md` and, with `--plans`, `plans.txt`. The machine, PostgreSQL version and memory
 * settings are recorded with them: these are **one machine's numbers**, not production's.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, tmpdir } from 'node:os';
import { join } from 'node:path';

import pkg from 'pg';

import { createRaceDb, startCluster, stopCluster } from '../../supabase/tests/concurrency/harness.mjs';

const { Client } = pkg;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = args[at + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};
const USERS = Number(flag('users', 100_000));
const TITLES = Number(flag('titles', 60_000));
const CONCURRENCY = Number(flag('concurrency', 8));
const PLANS = Boolean(flag('plans', false));
const OUT = String(flag('out', join(tmpdir(), `bingd-scale-bench-${process.pid}`)));
const BATCH = 25_000;

if (!Number.isInteger(USERS) || USERS < 1_000 || !Number.isInteger(TITLES) || TITLES < 1_000) {
  console.error('usage: scale-bench.mjs [--users N>=1000] [--titles N>=1000] [--out DIR] [--concurrency N] [--plans]');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;
const now = () => process.hrtime.bigint();
const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};
const round = (value, digits = 1) => (value == null ? null : Number(value.toFixed(digits)));
const summary = (values) => ({
  n: values.length,
  p50: round(quantile(values, 0.5)),
  p95: round(quantile(values, 0.95)),
  max: round(values.length ? Math.max(...values) : null),
});

// ---------------------------------------------------------------------------
// Cluster
// ---------------------------------------------------------------------------

log(`booting PostgreSQL and applying every migration (users=${USERS}, titles=${TITLES})`);
const cluster = await startCluster();
const raceDb = await createRaceDb();
const connect = async () => {
  const client = new Client({
    host: '127.0.0.1',
    port: cluster.port,
    user: 'postgres',
    password: 'postgres',
    database: raceDb.name,
  });
  // A connection the cluster shutdown terminates must not crash the run after the fact.
  client.on('error', () => {});
  await client.connect();
  return client;
};

const admin = await connect();
const q = (sql, params) => admin.query(sql, params);

const results = {
  synthetic: true,
  generated_at: new Date().toISOString(),
  machine: { cpus: cpus().length, cpu_model: cpus()[0]?.model ?? null, memory_gb: round(totalmem() / 2 ** 30) },
  parameters: { users: USERS, titles: TITLES, concurrency: CONCURRENCY },
};

try {
  const settings = await q(
    `select name, setting, unit from pg_settings
      where name in ('server_version', 'shared_buffers', 'work_mem', 'maintenance_work_mem',
                     'effective_cache_size', 'max_parallel_workers_per_gather', 'jit')`,
  );
  results.postgres = Object.fromEntries(settings.rows.map((r) => [r.name, r.unit ? `${r.setting} ${r.unit}` : r.setting]));

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  await q(`
    create or replace function pg_temp.u(p text) returns double precision
    language sql immutable as $$
      select ('x' || substr(md5(p), 1, 13))::bit(52)::bigint / 4503599627370496.0
    $$;
  `);

  const loadStart = now();
  await q(`set session_replication_role = replica`);
  // A2's index is built again below, timed; the other ranking indexes stay as migrated.
  await q(`drop index if exists rankings_by_media_user`);

  log('titles');
  const SERIES = Math.floor(TITLES / 6);
  await q(
    `create table bench_titles (r integer primary key, id uuid not null, kind media_kind not null,
                                category ranking_category not null, cluster integer not null)`,
  );
  // Films and seasons share one popularity order, so a pick rank can land on either.
  await q(
    `
    with langs(code, lo, hi, cluster) as (values
      ('en', 0.00, 0.55, -1), ('ja', 0.55, 0.61, 5), ('ko', 0.61, 0.66, 5), ('hi', 0.66, 0.70, 6),
      ('te', 0.70, 0.73, 6), ('ta', 0.73, 0.75, 6), ('fr', 0.75, 0.80, 7), ('es', 0.80, 0.85, 7),
      ('de', 0.85, 0.88, 7), ('it', 0.88, 0.91, 7), ('zh', 0.91, 0.94, 5), ('pt', 0.94, 0.96, 7),
      ('sv', 0.96, 0.98, 7), ('tr', 0.98, 1.01, 7)),
    films as (
      select i, md5('bench-film:' || i)::uuid as id, pg_temp.u('lang:' || i) as lu,
             pg_temp.u('year:' || i) as yu
        from generate_series(1, $1::integer) i
    )
    insert into media_items (id, kind, tmdb_id, title, release_date, poster_path, original_language,
                             genres, popularity)
    select f.id, 'movie', 50000000 + f.i, 'Bench film ' || f.i,
           make_date(1930 + floor(96 * sqrt(f.yu))::integer, 1 + (f.i % 12), 1 + (f.i % 27)),
           case when pg_temp.u('poster:' || f.i) < 0.95 then '/bench/' || f.i || '.jpg' end,
           l.code,
           (array['Drama','Comedy','Action','Thriller','Romance','Horror','Animation','Documentary',
                  'Crime','Science Fiction'])[1 + (f.i % 10):1 + (f.i % 10) + (f.i % 2)],
           (2000.0 / power(f.i, 0.8))::real
      from films f join langs l on f.lu >= l.lo and f.lu < l.hi`,
    [TITLES],
  );
  await q(
    `insert into media_items (id, kind, tmdb_id, title, release_date, poster_path, original_language,
                              genres, popularity)
     select md5('bench-series:' || i)::uuid, 'series', 60000000 + i, 'Bench series ' || i,
            make_date(1960 + floor(66 * sqrt(pg_temp.u('syear:' || i)))::integer, 1 + (i % 12), 1),
            '/bench/s' || i || '.jpg',
            case when pg_temp.u('slang:' || i) < 0.6 then 'en'
                 else (array['ja','ko','hi','te','fr','es','de','zh'])[1 + (i % 8)] end,
            array['Drama'], (1500.0 / power(i, 0.8))::real
       from generate_series(1, $1::integer) i`,
    [SERIES],
  );
  await q(
    `insert into media_items (id, kind, parent_id, season_number, title, release_date, poster_path,
                              original_language, genres, popularity)
     select md5('bench-season:' || s.id || ':' || n)::uuid, 'season', s.id, n, s.title || ' S' || n,
            s.release_date + (n - 1) * 365, s.poster_path, s.original_language, s.genres, s.popularity
       from media_items s cross join generate_series(1, 2) n
      where s.kind = 'series' and s.tmdb_id >= 60000000`,
  );
  // One popularity order over films and seasons: interleave by each row's popularity.
  await q(
    `insert into bench_titles (r, id, kind, category, cluster)
     select row_number() over (order by m.popularity desc, m.id), m.id, m.kind,
            case when m.kind = 'season' then 'tv_seasons'::ranking_category else 'movies' end,
            case when m.original_language in ('ja','ko','zh') then 5
                 when m.original_language in ('hi','te','ta') then 6
                 when m.original_language = 'en' then abs(hashtext(m.id::text)) % 5
                 else 7 end
       from media_items m
      where m.kind in ('movie', 'season') and (m.tmdb_id >= 50000000 or m.parent_id is not null)
        and m.title like 'Bench %'`,
  );
  const titleCount = Number((await q(`select count(*) from bench_titles`)).rows[0].count);

  log('accounts');
  await q(
    `create table bench_users (i integer primary key, id uuid not null, n_rank integer not null,
                               cluster integer not null, tier text not null)`,
  );
  await q(
    `insert into bench_users (i, id, n_rank, cluster, tier)
     select i, md5('bench-user:' || i)::uuid,
            case when a < 0.55 then 0
                 when a < 0.90 then 3 + floor(17 * b)::integer
                 when a < 0.985 then 20 + floor(180 * b * b)::integer
                 else 200 + floor(1300 * b * b)::integer end,
            floor(8 * pg_temp.u('cluster:' || i))::integer,
            case when a < 0.55 then 'dormant' when a < 0.90 then 'casual'
                 when a < 0.985 then 'engaged' else 'power' end
       from (select i, pg_temp.u('tier:' || i) as a, pg_temp.u('size:' || i) as b
               from generate_series(1, $1::integer) i) g`,
    [USERS],
  );
  await q(
    `insert into profiles (id, username, display_name, visibility, status)
     select u.id, 'bench_' || u.i, 'Bench ' || u.i,
            case when pg_temp.u('vis:' || u.i) < 0.85 then 'public'::profile_visibility else 'private' end,
            case when pg_temp.u('susp:' || u.i) < 0.01 then 'suspended'::profile_status else 'active' end
       from bench_users u`,
  );
  await q(
    `insert into blocks (blocker_id, blocked_id)
     select a.id, b.id from bench_users a
       join bench_users b on b.i = 1 + ((a.i::bigint * 7919) % $1::integer)::integer
      where pg_temp.u('block:' || a.i) < 0.002 and a.id <> b.id
     on conflict do nothing`,
    [USERS],
  );

  log('rankings');
  for (let lo = 1; lo <= USERS; lo += BATCH) {
    const hi = Math.min(USERS, lo + BATCH - 1);
    await q(
      `
      with picks as (
        select distinct u.id as user_id, u.cluster as ucluster, t.id as media_item_id,
               t.category, t.cluster as tcluster
          from bench_users u
         cross join lateral generate_series(1, u.n_rank) k
          join bench_titles t
            on t.r = least($3::integer,
                           greatest(1, floor(exp(pg_temp.u(u.i || ':' || k) * ln($3::integer + 1)))::integer))
         where u.i between $1 and $2 and u.n_rank > 0
      ),
      opinions as (
        select p.*, pg_temp.u(p.user_id::text || p.media_item_id::text) as v
          from picks p
      ),
      bucketed as (
        select o.*,
               case when (o.tcluster = o.ucluster and o.v < 0.75) or o.v < 0.2 then 'loved'::taste_bucket
                    when o.tcluster <> o.ucluster and o.v > 0.8 then 'not_for_me'::taste_bucket
                    else 'fine'::taste_bucket end as bucket
          from opinions o
      )
      insert into rankings (user_id, media_item_id, category, bucket, position, created_at)
      select b.user_id, b.media_item_id, b.category, b.bucket,
             -- Positions are 1-based and contiguous across the bands, loved first.
             (row_number() over (partition by b.user_id, b.category
                                 order by case b.bucket when 'loved' then 0 when 'fine' then 1 else 2 end,
                                          b.v, b.media_item_id))::integer,
             now() - (b.v * interval '700 days')
        from bucketed b`,
      [lo, hi, titleCount],
    );
    if (((hi - lo + 1) === BATCH && (hi / BATCH) % 4 === 0) || hi === USERS) log(`  rankings for ${hi}/${USERS} accounts`);
  }
  await q(`set session_replication_role = origin`);

  log('analyze');
  await q(`analyze`);
  const counts = (
    await q(`select (select count(*) from profiles) as profiles,
                    (select count(*) from rankings) as rankings,
                    (select count(*) from media_items) as media_items,
                    (select count(*) from blocks) as blocks,
                    (select max(c) from (select count(*) c from rankings group by media_item_id) x) as top_title_raters,
                    pg_size_pretty(pg_total_relation_size('rankings')) as rankings_size`)
  ).rows[0];
  results.load = { seconds: round(ms(loadStart) / 1000), ...counts };
  log('loaded', JSON.stringify(results.load));

  // -------------------------------------------------------------------------
  // 1. A2's index, at this size
  // -------------------------------------------------------------------------

  log('index builds');
  let t0 = now();
  await q(`create index rankings_by_media_user on rankings (media_item_id, user_id)`);
  const plain = ms(t0);
  await q(`drop index rankings_by_media_user`);
  t0 = now();
  await q(`create index concurrently rankings_by_media_user on rankings (media_item_id, user_id)`);
  const concurrent = ms(t0);
  results.index_build = {
    rankings_by_media_user_plain_ms: round(plain),
    rankings_by_media_user_concurrently_ms: round(concurrent),
    size: (await q(`select pg_size_pretty(pg_relation_size('rankings_by_media_user')) s`)).rows[0].s,
  };
  await q(`analyze rankings`);

  // -------------------------------------------------------------------------
  // Readers
  // -------------------------------------------------------------------------

  await q(
    `update app_config set value = v.value from (values
       ('recommendations.v2_engine', '"v2_hybrid"'::jsonb),
       ('recommendations.v2_rollout_percent', '100'::jsonb)) v(key, value)
     where app_config.key = v.key`,
  );

  // Public, active readers in each tier; the head-heavy ones are casual readers whose
  // rankings are dominated by the most popular titles.
  const pick = async (where, n) =>
    (
      await q(
        `select u.id, u.tier, u.cluster, (select count(*) from rankings r where r.user_id = u.id) as ranked
           from bench_users u join profiles p on p.id = u.id
          where p.status = 'active' and ${where}
          order by md5(u.id::text) limit $1`,
        [n],
      )
    ).rows;
  const readers = [
    ...(await pick(`u.tier = 'casual' and u.n_rank >= 8`, 8)),
    ...(await pick(`u.tier = 'engaged'`, 8)),
    ...(await pick(`u.tier = 'power'`, 6)),
    ...(await pick(`u.tier in ('casual', 'engaged') and u.cluster in (5, 6)`, 6)),
  ];
  const readerIds = readers.map((r) => r.id);
  // Readers' own collections, so every exclusion the functions apply is real. Triggers off,
  // as for the bulk load: the award, goal and Watchlist triggers write rows nothing measured
  // here reads, and they turned this setup step into five minutes.
  await q(`set session_replication_role = replica`);
  await q(
    `insert into user_media (user_id, media_item_id, bucket, source)
     select r.user_id, r.media_item_id, r.bucket, 'in_app' from rankings r where r.user_id = any($1::uuid[])
     on conflict do nothing`,
    [readerIds],
  );
  await q(`set session_replication_role = origin`);
  await q(`analyze user_media`);
  // Collections shaped like the client's profile asks: the reader's top languages, two decades.
  for (const reader of readers) {
    const langs = await q(
      `select m.original_language as code from rankings r join media_items m on m.id = r.media_item_id
        where r.user_id = $1 and r.bucket = 'loved' and m.original_language is not null
        group by 1 order by count(*) desc, 1 limit 3`,
      [reader.id],
    );
    reader.languages = langs.rows.map((row) => row.code);
  }

  const asReader = async (client, id) => {
    await client.query(`reset role`);
    await client.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: id, role: 'authenticated' }),
    ]);
    await client.query(`set role authenticated`);
  };
  const clearCache = (id) =>
    q(`delete from taste_neighbour_refresh where reader_id = $1`, [id]).then(() =>
      q(`delete from taste_neighbours where reader_id = $1`, [id]),
    );
  const timed = async (client, sql, params) => {
    const start = now();
    const { rows } = await client.query(sql, params);
    return { ms: ms(start), rows };
  };

  // -------------------------------------------------------------------------
  // 2. Per reader, one connection
  // -------------------------------------------------------------------------

  log(`per-reader timings for ${readers.length} readers`);
  const reader = await connect();
  await reader.query(`set statement_timeout = '120s'`);
  const per = [];
  for (const r of readers) {
    await clearCache(r.id);
    await asReader(reader, r.id);
    const engine = await timed(reader, `select recommendation_engine() as e`);
    const catalogue = await timed(
      reader,
      `select count(*)::integer as n from catalogue_candidates('movie', $1::text[], '{1990,2010}'::integer[], 20, 7)`,
      [r.languages],
    );
    const cold = await timed(reader, `select count(*)::integer as n from collaborative_candidates('movie', 40)`);
    const warm = await timed(reader, `select count(*)::integer as n from collaborative_candidates('movie', 40)`);
    let people;
    try {
      people = await timed(reader, `select count(*)::integer as n from people_taste_matches(10)`);
    } catch (e) {
      people = { ms: null, rows: [{ n: null }], error: e.message };
    }
    await reader.query(`reset role`);
    const neighbours = (
      await reader.query(`select neighbours from taste_neighbour_refresh where reader_id = $1`, [r.id])
    ).rows[0]?.neighbours;
    per.push({
      tier: r.tier,
      non_english_cluster: r.cluster >= 5,
      ranked: Number(r.ranked),
      engine: engine.rows[0].e,
      engine_ms: round(engine.ms),
      catalogue_ms: round(catalogue.ms),
      catalogue_rows: catalogue.rows[0].n,
      collaborative_cold_ms: round(cold.ms),
      collaborative_warm_ms: round(warm.ms),
      collaborative_rows: warm.rows[0].n,
      neighbours: neighbours ?? 0,
      people_taste_matches_ms: round(people.ms),
      people_taste_matches_error: people.error ?? undefined,
    });
    log(`  ${r.tier.padEnd(7)} ranked=${String(r.ranked).padStart(4)} cold=${round(cold.ms)}ms warm=${round(warm.ms)}ms catalogue=${round(catalogue.ms)}ms people=${round(people.ms)}ms neighbours=${neighbours}`);
  }
  results.per_reader = per;
  const byTier = {};
  for (const tier of ['casual', 'engaged', 'power']) {
    const rows = per.filter((p) => p.tier === tier);
    byTier[tier] = {
      readers: rows.length,
      ranked_p50: quantile(rows.map((p) => p.ranked), 0.5),
      catalogue_ms: summary(rows.map((p) => p.catalogue_ms)),
      collaborative_cold_ms: summary(rows.map((p) => p.collaborative_cold_ms)),
      collaborative_warm_ms: summary(rows.map((p) => p.collaborative_warm_ms)),
      people_taste_matches_ms: summary(rows.map((p) => p.people_taste_matches_ms).filter((v) => v != null)),
      neighbours_p50: quantile(rows.map((p) => p.neighbours), 0.5),
    };
  }
  results.by_tier = byTier;
  results.all_readers = {
    engine_ms: summary(per.map((p) => p.engine_ms)),
    catalogue_ms: summary(per.map((p) => p.catalogue_ms)),
    collaborative_cold_ms: summary(per.map((p) => p.collaborative_cold_ms)),
    collaborative_warm_ms: summary(per.map((p) => p.collaborative_warm_ms)),
    people_taste_matches_ms: summary(per.map((p) => p.people_taste_matches_ms).filter((v) => v != null)),
  };

  // -------------------------------------------------------------------------
  // 3. Concurrency: cold refreshes in parallel, with writers running
  // -------------------------------------------------------------------------

  log(`concurrency: ${CONCURRENCY} refreshing sessions, 2 writers`);
  const pool = await pick(`u.tier in ('casual', 'engaged', 'power')`, CONCURRENCY * 4);
  for (const r of pool) await clearCache(r.id);
  const sessions = await Promise.all(Array.from({ length: CONCURRENCY }, connect));
  const writerSessions = await Promise.all([connect(), connect()]);
  const writerIds = (await q(`select id from bench_users where tier = 'dormant' order by i limit 400`)).rows.map((r) => r.id);
  const filmIds = (await q(`select id from bench_titles where kind = 'movie' order by r limit 2000`)).rows.map((r) => r.id);
  let writing = true;
  const writeLatencies = [];
  const writers = writerSessions.map(async (w, wi) => {
    await w.query(`set session_replication_role = replica`);
    let k = 0;
    while (writing) {
      // Disjoint accounts per writer, so the two never contend with each other.
      // A (user, film) pair is never repeated, so no write needs a conflict clause.
      const user = writerIds[wi * 200 + (k % 200)];
      const film = filmIds[Math.floor(k / 200) % filmIds.length];
      const start = now();
      await w.query(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', 'fine',
                 coalesce((select max(position) from rankings where user_id = $1 and category = 'movies'), 0) + 1)`,
        [user, film],
      );
      writeLatencies.push(ms(start));
      k += 1;
    }
  });
  const callLatencies = [];
  const wallStart = now();
  await Promise.all(
    sessions.map(async (s, si) => {
      await s.query(`set statement_timeout = '120s'`);
      for (let j = si; j < pool.length; j += CONCURRENCY) {
        await asReader(s, pool[j].id);
        const call = await timed(s, `select count(*) from collaborative_candidates('movie', 40)`);
        callLatencies.push(call.ms);
      }
    }),
  );
  const wall = ms(wallStart);
  writing = false;
  await Promise.all(writers);
  results.concurrency = {
    sessions: CONCURRENCY,
    cold_refreshes: callLatencies.length,
    wall_ms: round(wall),
    refreshes_per_second: round((callLatencies.length / wall) * 1000, 2),
    call_ms: summary(callLatencies),
    writer_inserts: writeLatencies.length,
    writer_insert_ms: summary(writeLatencies),
  };
  await Promise.all([...sessions, ...writerSessions].map((s) => s.end()));

  // -------------------------------------------------------------------------
  // 4. Plans
  // -------------------------------------------------------------------------

  if (PLANS) {
    log('plans (auto_explain)');
    const planned = await connect();
    const notices = [];
    planned.on('notice', (n) => notices.push(n.message));
    await planned.query(`load 'auto_explain'`);
    for (const setting of [
      // Statements under 5 ms are left out: every per-row `score_for` call is a nested
      // statement too, and logging them all buries the plans worth reading.
      `set auto_explain.log_min_duration = 5`,
      `set auto_explain.log_analyze = on`,
      `set auto_explain.log_buffers = on`,
      `set auto_explain.log_nested_statements = on`,
      `set auto_explain.log_timing = on`,
      `set auto_explain.log_level = 'notice'`,
      `set client_min_messages = 'notice'`,
    ]) {
      await planned.query(setting);
    }
    const sections = [];
    for (const tier of ['casual', 'power']) {
      const r = readers.find((x) => x.tier === tier);
      if (!r) continue;
      await clearCache(r.id);
      await asReader(planned, r.id);
      notices.length = 0;
      await planned.query(`select count(*) from collaborative_candidates('movie', 40)`);
      sections.push(`### collaborative_candidates, cold, ${tier} reader (${r.ranked} rankings)\n\n${notices.join('\n\n')}`);
      notices.length = 0;
      await planned.query(
        `select count(*) from catalogue_candidates('movie', $1::text[], '{1990,2010}'::integer[], 20, 7)`,
        [r.languages],
      );
      sections.push(`### catalogue_candidates, ${tier} reader\n\n${notices.join('\n\n')}`);
      await planned.query(`reset role`);
    }
    await planned.end();
    writeFileSync(join(OUT, 'plans.txt'), `SYNTHETIC DATA. users=${USERS} titles=${TITLES}\n\n${sections.join('\n\n')}\n`);
  }

  await reader.end();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await admin.end().catch(() => {});
  await raceDb.close().catch(() => {});
  await stopCluster().catch(() => {});
}
if (process.exitCode) process.exit(process.exitCode);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
const row = (label, s) => `| ${label} | ${s.n} | ${s.p50 ?? '—'} | ${s.p95 ?? '—'} | ${s.max ?? '—'} |`;
const md = [
  `> **SYNTHETIC DATA** on one local PostgreSQL ${results.postgres?.server_version ?? ''} (${results.machine.cpus} CPUs, ${results.machine.memory_gb} GB). Not production numbers.`,
  '',
  `users ${USERS}, titles ${TITLES}; loaded ${results.load.rankings} rankings (${results.load.rankings_size}) over ${results.load.media_items} catalogue rows in ${results.load.seconds} s; the most-ranked title has ${results.load.top_title_raters} raters.`,
  '',
  `Postgres: ${Object.entries(results.postgres ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}`,
  '',
  `A2 index \`rankings (media_item_id, user_id)\`: ${results.index_build.rankings_by_media_user_plain_ms} ms plain (writes to \`rankings\` wait this long), ${results.index_build.rankings_by_media_user_concurrently_ms} ms concurrently; ${results.index_build.size}.`,
  '',
  '| Call (ms), all readers | n | p50 | p95 | max |',
  '|---|---|---|---|---|',
  row('recommendation_engine()', results.all_readers.engine_ms),
  row('catalogue_candidates', results.all_readers.catalogue_ms),
  row('collaborative_candidates, cold (includes the refresh)', results.all_readers.collaborative_cold_ms),
  row('collaborative_candidates, warm', results.all_readers.collaborative_warm_ms),
  row('people_taste_matches(10) (existing, not For You)', results.all_readers.people_taste_matches_ms),
  '',
  '| Tier | readers | rankings p50 | cold p50 / p95 | warm p50 / p95 | catalogue p50 / p95 | people_taste_matches p50 / p95 | neighbours p50 |',
  '|---|---|---|---|---|---|---|---|',
  ...Object.entries(results.by_tier).map(
    ([tier, t]) =>
      `| ${tier} | ${t.readers} | ${t.ranked_p50} | ${t.collaborative_cold_ms.p50} / ${t.collaborative_cold_ms.p95} | ${t.collaborative_warm_ms.p50} / ${t.collaborative_warm_ms.p95} | ${t.catalogue_ms.p50} / ${t.catalogue_ms.p95} | ${t.people_taste_matches_ms.p50 ?? '—'} / ${t.people_taste_matches_ms.p95 ?? '—'} | ${t.neighbours_p50} |`,
  ),
  '',
  `Concurrency: ${results.concurrency.sessions} sessions, ${results.concurrency.cold_refreshes} cold refreshes in ${results.concurrency.wall_ms} ms (${results.concurrency.refreshes_per_second}/s); call p50 ${results.concurrency.call_ms.p50} ms, p95 ${results.concurrency.call_ms.p95} ms. Two writers inserted ${results.concurrency.writer_inserts} rankings meanwhile: p50 ${results.concurrency.writer_insert_ms.p50} ms, p95 ${results.concurrency.writer_insert_ms.p95} ms, max ${results.concurrency.writer_insert_ms.max} ms.`,
  '',
];
writeFileSync(join(OUT, 'results.md'), md.join('\n'));
log(`wrote ${join(OUT, 'results.json')} and results.md`);
