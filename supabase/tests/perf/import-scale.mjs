#!/usr/bin/env node
/**
 * The Letterboxd import at library scale, against a REAL PostgreSQL 17.
 *
 *   node supabase/tests/perf/import-scale.mjs                      # 24, 250, 1000, 2500
 *   node supabase/tests/perf/import-scale.mjs --sizes 2500 --json out.json
 *   node supabase/tests/perf/import-scale.mjs --scenarios          # survival only
 *
 * ---------------------------------------------------------------------------
 * WHY A SCRIPT AND NOT A TEST FILE
 *
 * "The parser accepts N rows" proves nothing about the pipeline, and the fixtures in
 * `import-pipeline.test.mjs` all finish in a handful of ticks. This drives the real worker
 * over libraries the size a film-club member actually has — through the real
 * `import_stage` / `import_ready` RPCs as the signed-in user, the real
 * `_drain_import_jobs`, and the real claim/resolve pair the provider tier calls — and times
 * every tick. It takes minutes, so it is not in any `*.test.mjs` glob; the correctness
 * properties it depends on are pinned at small sizes in `races/import-worker.mjs`, and this
 * file asserts them again at scale before it reports a number.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL AND WHAT IS STOOD IN
 *
 * Real: every migration, the matcher (T0 cache, T1 squashed title), apply, settle, the
 * notification trigger, the redaction trigger, the dead letter, `for update skip locked`
 * across real connections, the award evaluation at settle.
 *
 * Stood in, deliberately: **the provider**. No HTTP request is made. The Edge Function is
 * a loop of `_import_provider_claim` -> TMDB -> `tmdb_upsert_titles` ->
 * `_import_provider_resolve`; this runs the two SQL ends for real and replaces the middle
 * with a deterministic oracle (found / not found / transient failure). Provider-bound wall
 * time is then modelled from the call count and the per-call latency measured on staging,
 * which is reported separately rather than folded into "compute".
 *
 * pg_cron and pg_net do not exist here, so a "tick" is one call of the cron statement, and
 * wall-clock is reported as ticks x the configured cadence plus the compute actually spent.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { createRaceDb, fixtures, startCluster, stopCluster } from '../concurrency/harness.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

const SIZES = option('--sizes', '24,250,1000,2500').split(',').map(Number);
const JSON_OUT = option('--json', null);
/** Seconds between cron ticks, for the wall-clock model. Read from the schedule if set. */
const CADENCE = Number(option('--cadence', '0')) || null;
/** Provider round-trip per title, measured on staging (search + upsert + resolve). */
const PROVIDER_MS = Number(option('--provider-ms', '450'));

// ---------------------------------------------------------------------------
// A deterministic library
// ---------------------------------------------------------------------------

/** mulberry32: small, seeded, and the same library on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The mix a real cold import meets.
 *
 * local      a catalogue movie whose squashed title and year agree (T1)
 * cached     a film the shared URI cache already maps (T0), under a title T1 would miss
 * provider   not in the catalogue; the provider finds it
 * unknown    not in the catalogue; the provider has nothing
 * ambiguous  two catalogue movies share the title and year
 */
const MIX = { local: 0.6, cached: 0.12, provider: 0.18, unknown: 0.05, ambiguous: 0.05 };

function library(n, seed = 7) {
  const r = rng(seed * 1000 + n);
  const titles = [];
  const kinds = Object.entries(MIX);
  for (let i = 0; i < n; i += 1) {
    let roll = r();
    let kind = kinds[kinds.length - 1][0];
    for (const [k, share] of kinds) {
      if (roll < share) {
        kind = k;
        break;
      }
      roll -= share;
    }
    const year = 1950 + Math.floor(r() * 75);
    const name = `Scale ${kind} ${seed} ${i}`;
    const rated = r() < 0.6;
    const diary = r() < 0.4;
    const viewings = diary ? 1 + Math.floor(r() * 3) : 0;
    const watches = Array.from({ length: viewings }, (_, v) => ({
      diaryUri: `https://boxd.it/d${seed}x${n}x${i}x${v}`,
      watchedOn: `${2015 + ((i + v) % 10)}-0${1 + ((i + v) % 9)}-1${v}`,
      isRewatch: v > 0,
    }));
    titles.push({
      kind,
      name,
      year,
      filmUri: `https://letterboxd.com/film/scale-${seed}-${n}-${i}/`,
      rating: rated ? [0.5, 1, 2, 2.5, 3, 3.5, 4, 4.5, 5][Math.floor(r() * 9)] : null,
      bucket: rated ? (r() < 0.5 ? 'loved' : r() < 0.7 ? 'fine' : 'not_for_me') : null,
      watches,
      native: kind === 'local' && r() < 0.05,
      watchlist: false,
    });
  }
  // A watchlist of a tenth the size, drawn from films that were not watched.
  const wl = Math.max(2, Math.floor(n / 10));
  for (let i = 0; i < wl; i += 1) {
    const year = 1980 + Math.floor(r() * 45);
    titles.push({
      kind: r() < 0.8 ? 'local' : 'provider',
      name: `Scale watchlist ${seed} ${i}`,
      year,
      filmUri: `https://letterboxd.com/film/scale-wl-${seed}-${n}-${i}/`,
      rating: null,
      bucket: null,
      watches: [],
      native: false,
      watchlist: true,
    });
  }
  return titles;
}

/** The wire rows `payload.ts` sends, one per title. */
const wireRow = (t) => ({
  kind: t.watchlist ? 'watchlist' : 'watched',
  correlation: t.filmUri,
  name: t.name,
  year: t.year,
  filmUri: t.filmUri,
  rating: t.rating,
  bucket: t.bucket,
  watchedOn: t.watches.at(-1)?.watchedOn ?? null,
  watches: t.watches,
});

// ---------------------------------------------------------------------------
// The world the library meets
// ---------------------------------------------------------------------------

async function prepare(db, titles) {
  const fx = fixtures(db);
  const user = await fx.createUser();

  // Provider tier "configured", exactly as `push-drain.test.mjs` stands it up: a base URL
  // and a vault secret. `net.http_post` is a recorder, so the nudge is counted, not sent.
  await db.sql(`create schema if not exists vault`);
  await db.sql(
    `create table if not exists vault.secrets (name text primary key, secret text not null)`,
  );
  await db.sql(
    `create or replace view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets`,
  );
  await db.sql(
    `insert into vault.secrets values ('service_role_key', 'bench') on conflict do nothing`,
  );
  await db.sql(
    `insert into app_config (key, value) values ('functions.base_url', '"https://bench.invalid/functions/v1"')
     on conflict (key) do update set value = excluded.value`,
  );
  await db.sql(`create schema if not exists net`);
  await db.sql(
    `create table if not exists net.bench_posts (id bigserial, url text, body jsonb, at timestamptz default now())`,
  );
  await db.sql(
    `create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
       headers jsonb default '{}', timeout_milliseconds integer default 5000)
     returns bigint language sql as $f$
       insert into net.bench_posts (url, body) values (url, body) returning id
     $f$`,
  );

  // Catalogue. Bulk-inserted: this is the world, not the thing being timed.
  const movies = [];
  let tmdb = 1;
  for (const t of titles) {
    const date = `${t.year}-06-01`;
    if (t.kind === 'local') movies.push([t.name, date, (tmdb += 1)]);
    if (t.kind === 'ambiguous') {
      movies.push([t.name, date, (tmdb += 1)]);
      movies.push([t.name, `${t.year}-09-01`, (tmdb += 1)]);
    }
    // A cached film lives in the catalogue under a title the export does not use.
    if (t.kind === 'cached') movies.push([`${t.name} (catalogue title)`, date, (tmdb += 1)]);
  }
  for (let i = 0; i < movies.length; i += 500) {
    const chunk = movies.slice(i, i + 500);
    await db.sql(
      `insert into media_items (kind, tmdb_id, title, release_date, provenance)
       select 'movie', -(x->>2)::integer, x->>0, (x->>1)::date, 'manual'
         from jsonb_array_elements($1::jsonb) x`,
      [JSON.stringify(chunk)],
    );
  }
  const cached = titles.filter((t) => t.kind === 'cached');
  if (cached.length) {
    await db.sql(
      `insert into letterboxd_matches (letterboxd_uri, media_item_id)
       select x->>0, mi.id
         from jsonb_array_elements($1::jsonb) x
         join media_items mi on mi.title = (x->>1) || ' (catalogue title)'`,
      [JSON.stringify(cached.map((t) => [t.filmUri, t.name]))],
    );
  }
  // A few films this person already logged in the app, which the import must not overwrite.
  const native = titles.filter((t) => t.native);
  if (native.length) {
    await db.sql(
      `insert into user_media (user_id, media_item_id, bucket, source)
       select $1, mi.id, 'fine', 'in_app'
         from media_items mi where mi.title = any($2::text[])
       on conflict do nothing`,
      [user, native.map((t) => t.name)],
    );
  }
  return user;
}

// ---------------------------------------------------------------------------
// The client half, as the signed-in person
// ---------------------------------------------------------------------------

async function upload(db, user, titles) {
  const s = await db.session('client');
  const t0 = performance.now();
  try {
    await s.actAs(user);
    const job = (await s.one(`select import_create() as r`)).r;
    const jobId = job.job_id ?? job.id ?? job;
    const rows = titles.map(wireRow);
    let pages = 0;
    for (let i = 0; i < rows.length; i += 500) {
      await s.q(`select import_stage($1, $2::jsonb)`, [
        jobId,
        JSON.stringify(rows.slice(i, i + 500)),
      ]);
      pages += 1;
    }
    await s.q(`select import_ready($1)`, [jobId]);
    return { jobId, pages, stageMs: performance.now() - t0 };
  } finally {
    await s.end();
  }
}

// ---------------------------------------------------------------------------
// The provider tier, with TMDB replaced by an oracle
// ---------------------------------------------------------------------------

function providerOracle(titles, { transient = 0, seed = 11, limitAfter = null } = {}) {
  let finalSupported = null;
  const byName = new Map(titles.map((t) => [t.name, t]));
  const r = rng(seed);
  let tmdb = 5_000_000;
  const stats = { invocations: 0, claimed: 0, found: 0, empty: 0, failed: 0, released: 0 };

  /** One Edge Function invocation: claim a batch, resolve each. Returns rows claimed. */
  async function invoke(db, batch = 50) {
    stats.invocations += 1;
    if (finalSupported === null) {
      const [{ n }] = await db.rows(
        `select count(*)::int as n from pg_proc where proname = '_import_provider_resolve' and pronargs = 3`,
      );
      finalSupported = n > 0;
    }
    const claims = await db.rows(`select * from _import_provider_claim($1)`, [batch]);
    let sent = 0;
    for (const c of claims) {
      // A 429 after `limitAfter` requests: the Edge Function stops and hands the rest back.
      if (limitAfter !== null && sent >= limitAfter) {
        const rest = claims.slice(sent).map((x) => x.row_id);
        const [{ n }] = await db.rows(`select _import_provider_release($1::uuid[]) as n`, [
          rest,
        ]);
        stats.released += n;
        break;
      }
      sent += 1;
      stats.claimed += 1;
      if (r() < transient) {
        // A thrown fetch: the attempt is spent by the claim and the row is left alone.
        stats.failed += 1;
        continue;
      }
      const t = byName.get(c.name);
      if (t && t.kind === 'provider') {
        const [{ id }] = await db.rows(
          `insert into media_items (kind, tmdb_id, title, release_date, provenance)
           values ('movie', $1, $2, $3::date, 'tmdb')
           returning id`,
          [(tmdb += 1), t.name, `${t.year}-06-01`],
        );
        await db.sql(`select _import_provider_resolve($1, $2)`, [c.row_id, id]);
        stats.found += 1;
      } else {
        // TMDB answered with nothing confident: final, as the Edge Function now says.
        await db.sql(
          finalSupported
            ? `select _import_provider_resolve($1, null, true)`
            : `select _import_provider_resolve($1, null)`,
          [c.row_id],
        );
        stats.empty += 1;
      }
    }
    return claims.length;
  }
  return { invoke, stats };
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/**
 * What the scheduler runs, read back from the installer rather than restated here: the drain
 * statement, the maintenance statement if there is one, and the drain's cadence in seconds.
 * Before 20260917001700 there is one job, once a minute, running all three functions.
 */
async function schedule(db) {
  const [{ src }] = await db.rows(
    `select pg_get_functiondef('schedule_import_drain(text)'::regprocedure) as src`,
  );
  const statements = [...src.matchAll(/'(select public\.[^']+)'/g)].map((m) => m[1]);
  const drainSql =
    statements.find((s) => s.includes('_drain_import_jobs')) ??
    'select public._drain_import_jobs()';
  const maintenanceSql =
    statements.find((s) => s !== drainSql && s.includes('_import_sweep_abandoned')) ?? null;
  const fallback = /default\s+'([^']+)'/i.exec(src)?.[1] ?? '* * * * *';
  const seconds = /^(\d+)\s*seconds?$/i.exec(fallback)
    ? Number(/^(\d+)/.exec(fallback)[1])
    : 60;
  return { drainSql, maintenanceSql, seconds };
}

/** Moves every lease and activity clock back by one tick's worth of time. */
async function passTime(db, seconds) {
  const interval = `${seconds} seconds`;
  const [{ has }] = await db.rows(
    `select exists (select 1 from information_schema.columns
                     where table_name = 'import_rows' and column_name = 'provider_claimed_at') as has`,
  );
  if (has) {
    await db.sql(
      `update import_rows set provider_claimed_at = provider_claimed_at - $1::interval
        where provider_claimed_at is not null`,
      [interval],
    );
    await db.sql(
      `update import_jobs set provider_touched_at = provider_touched_at - $1::interval
        where provider_touched_at is not null and completed_at is null`,
      [interval],
    );
  }
  await db.sql(
    `update import_jobs set created_at = created_at - $1::interval where completed_at is null`,
    [interval],
  );
}

async function drain(db, jobId, provider, { maxTicks = 5000, worker = null } = {}) {
  const plan = await schedule(db);
  const phases = { matching: 0, applying: 0 };
  let ticks = 0;
  let computeMs = 0;
  let slowest = 0;
  const w = worker ?? db;
  const maintenanceEvery = Math.max(1, Math.round(60 / plan.seconds));
  for (;;) {
    const [job] = await db.rows(`select status, completed_at from import_jobs where id = $1`, [
      jobId,
    ]);
    if (job.completed_at) break;
    if (ticks >= maxTicks)
      throw new Error(`job ${jobId} not finished after ${maxTicks} ticks (${job.status})`);
    if (job.status in phases) phases[job.status] += 1;
    const t0 = performance.now();
    await w.sql(plan.drainSql);
    const elapsed = performance.now() - t0;
    computeMs += elapsed;
    slowest = Math.max(slowest, elapsed);
    ticks += 1;
    if (plan.maintenanceSql && ticks % maintenanceEvery === 0) await w.sql(plan.maintenanceSql);
    // The nudge is asynchronous in production: pg_net posts after the tick commits, and the
    // function runs beside the next tick. Here it runs between ticks, once per nudge.
    const [{ n }] = await db.rows(
      `select count(*)::int as n from net.bench_posts where body->>'action' = 'resolve'`,
    );
    if (n > 0) {
      await db.sql(`delete from net.bench_posts where body->>'action' = 'resolve'`);
      await provider.invoke(db);
    }
    // The clock the grace and the leases are measured against moves one cadence per tick.
    await passTime(db, plan.seconds);
  }
  return { ticks, phases, computeMs, slowestTickMs: slowest, cadenceSeconds: plan.seconds };
}

// ---------------------------------------------------------------------------
// What must be true afterwards, at any size
// ---------------------------------------------------------------------------

async function verify(db, user, jobId, titles, feedBefore = 0) {
  const [job] = await db.rows(
    `select status, counts, completed_at from import_jobs where id = $1`,
    [jobId],
  );
  assert.equal(job.status, 'done', `job ended ${job.status}`);

  const [dup] = await db.rows(
    `select
       (select count(*) from (select media_item_id from user_media where user_id = $1
          group by media_item_id having count(*) > 1) x)::int as media,
       (select count(*) from (select diary_uri from imported_watches where user_id = $1
          group by diary_uri having count(*) > 1) x)::int as watches,
       (select count(*) from (select media_item_id from watchlist where user_id = $1
          group by media_item_id having count(*) > 1) x)::int as watchlist`,
    [user],
  );
  assert.deepEqual(dup, { media: 0, watches: 0, watchlist: 0 }, 'no duplicate state');

  const [n] = await db.rows(
    `select
       (select count(*) from notifications where recipient_id = $1 and type = 'import_started')::int as started,
       (select count(*) from notifications where recipient_id = $1 and type in ('import_completed','import_failed'))::int as outcome,
       (select count(*) from feed_events where actor_id = $1)::int as feed,
       (select count(*) from import_rows where job_id = $2 and status in ('pending','matched','applied'))::int as live_rows,
       (select count(*) from user_media where user_id = $1 and source = 'in_app')::int as native_kept,
       (select count(*) from user_media where user_id = $1)::int as media,
       (select count(*) from imported_watches where user_id = $1)::int as watches,
       (select count(*) from watchlist where user_id = $1)::int as watchlist`,
    [user, jobId],
  );
  assert.equal(n.started, 1, 'import_started exactly once');
  assert.equal(n.outcome, 1, 'one terminal notification');
  // Measured against what the fixture itself posted: seeding films logged in the app is an
  // ordinary write, and crossing an award threshold there is announced, correctly.
  if (n.feed !== feedBefore) {
    const kinds = await db.rows(
      `select type, payload, created_at from feed_events where actor_id = $1 order by created_at`,
      [user],
    );
    const notes = await db.rows(
      `select type, payload from notifications where recipient_id = $1 order by created_at`,
      [user],
    );
    assert.fail(
      `an import posted feed activity (${n.feed - feedBefore}): ${JSON.stringify(kinds)} notifications ${JSON.stringify(notes)}`,
    );
  }
  assert.equal(n.live_rows, 0, 'no staging row left live after settle');
  assert.equal(n.native_kept, titles.filter((t) => t.native).length, 'native rows kept native');

  const watchedPlaceable = titles.filter(
    (t) => !t.watchlist && ['local', 'cached', 'provider'].includes(t.kind),
  );
  const viewings = watchedPlaceable.reduce((a, t) => a + t.watches.length, 0);
  assert.equal(n.watches, viewings, 'every placeable viewing recorded once');
  return { ...n, counts: job.counts };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

async function bench(size) {
  const db = await createRaceDb();
  try {
    const titles = library(size);
    const user = await prepare(db, titles);
    const provider = providerOracle(titles);
    const [{ n: feedBefore }] = await db.rows(
      `select count(*)::int as n from feed_events where actor_id = $1`,
      [user],
    );
    const up = await upload(db, user, titles);
    const run = await drain(db, up.jobId, provider);
    const end = await verify(db, user, up.jobId, titles, feedBefore);

    // Idempotent re-import of the same archive: nothing may double.
    const again = await upload(db, user, titles);
    const rerun = await drain(db, again.jobId, providerOracle(titles));
    const [after] = await db.rows(
      `select (select count(*) from user_media where user_id = $1)::int as media,
              (select count(*) from imported_watches where user_id = $1)::int as watches,
              (select count(*) from watchlist where user_id = $1)::int as watchlist`,
      [user],
    );
    assert.deepEqual(
      after,
      { media: end.media, watches: end.watches, watchlist: end.watchlist },
      're-import changed nothing',
    );

    const seconds = CADENCE ?? run.cadenceSeconds;
    const rows = titles.length;
    const providerCalls = provider.stats.claimed;
    return {
      size,
      rows,
      pages: up.pages,
      stageMs: Math.round(up.stageMs),
      ticks: run.ticks,
      phases: run.phases,
      computeMs: Math.round(run.computeMs),
      slowestTickMs: Math.round(run.slowestTickMs),
      msPerRowCompute: +(run.computeMs / rows).toFixed(2),
      providerInvocations: provider.stats.invocations,
      providerCalls,
      providerFound: provider.stats.found,
      providerEmpty: provider.stats.empty,
      modelledWallSeconds: Math.round(
        run.ticks * seconds + (providerCalls * PROVIDER_MS) / 8 / 1000,
      ),
      cadenceSeconds: seconds,
      counts: end.counts,
      reimport: { ticks: rerun.ticks, computeMs: Math.round(rerun.computeMs) },
    };
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// Survival
// ---------------------------------------------------------------------------

async function scenario(name, size, body) {
  const db = await createRaceDb();
  const t0 = performance.now();
  try {
    const titles = library(size, name.length);
    const user = await prepare(db, titles);
    const detail = await body({ db, user, titles });
    return { name, size, ok: true, ms: Math.round(performance.now() - t0), ...detail };
  } catch (error) {
    return { name, size, ok: false, error: String(error?.stack ?? error).slice(0, 900) };
  } finally {
    await db.close();
  }
}

const SCENARIOS = {
  /** A worker killed mid-tick rolls back its slice; the next tick redoes it; nothing doubles. */
  async killedMidTick({ db, user, titles }) {
    const up = await upload(db, user, titles);
    const provider = providerOracle(titles);
    const victim = await db.session('victim');
    let cancelled = 0;
    for (let i = 0; i < 6; i += 1) {
      const running = victim.start(`select public._drain_import_jobs()`).catch((e) => e);
      await new Promise((r) => setTimeout(r, 15));
      const [{ pid }] = await db.rows(`select pg_backend_pid() as pid`);
      void pid;
      await db.sql(`select pg_cancel_backend($1)`, [victim.pid]);
      const outcome = await running;
      if (outcome instanceof Error) cancelled += 1;
    }
    await victim.end();
    await db.sql(
      `update import_jobs set claimed_at = now() - interval '6 minutes' where id = $1 and claimed_at is not null`,
      [up.jobId],
    );
    const run = await drain(db, up.jobId, provider);
    const end = await verify(db, user, up.jobId, titles);
    return { cancelled, ticks: run.ticks, media: end.media };
  },

  /** Two workers draining the same queue the whole way: skip locked at scale. */
  async twoWorkers({ db, user, titles }) {
    const up = await upload(db, user, titles);
    const provider = providerOracle(titles);
    const a = await db.session('worker-a');
    const b = await db.session('worker-b');
    let ticks = 0;
    try {
      for (;;) {
        const [job] = await db.rows(`select completed_at from import_jobs where id = $1`, [
          up.jobId,
        ]);
        if (job.completed_at) break;
        if (ticks > 4000) throw new Error('two workers never finished');
        await Promise.all([
          a.q(`select public._drain_import_jobs()`),
          b.q(`select public._drain_import_jobs()`),
        ]);
        ticks += 1;
        await provider.invoke(db);
      }
    } finally {
      await a.end();
      await b.end();
    }
    const end = await verify(db, user, up.jobId, titles);
    return { ticks, media: end.media };
  },

  /** A third of provider calls throw. Rows retry, then settle honestly; the job completes. */
  async transientProvider({ db, user, titles }) {
    const up = await upload(db, user, titles);
    const provider = providerOracle(titles, { transient: 0.33 });
    const run = await drain(db, up.jobId, provider);
    const [job] = await db.rows(`select status, counts from import_jobs where id = $1`, [
      up.jobId,
    ]);
    assert.equal(job.status, 'done');
    const [left] = await db.rows(
      `select count(*)::int as n from import_rows where job_id = $1 and status = 'needs_provider' and provider_attempts < 3`,
      [up.jobId],
    );
    return {
      ticks: run.ticks,
      failed: provider.stats.failed,
      stillRetryable: left.n,
      counts: job.counts,
    };
  },

  /**
   * A long provider phase must not be cut off by the job's age. Everything local lands, then
   * the job is aged past the grace window WHILE the provider is still working through rows it
   * has never been asked about. Every provider-findable film must still arrive.
   */
  async providerOutlivesGrace({ db, user, titles }) {
    const up = await upload(db, user, titles);
    const provider = providerOracle(titles);
    // Local matching and applying only: the provider tier is held off.
    const held = { invoke: async () => 0, stats: provider.stats };
    for (let i = 0; i < 40; i += 1) {
      await db.sql(`select public._drain_import_jobs()`);
      await db.sql(`delete from net.bench_posts`);
    }
    await db.sql(
      `update import_jobs set created_at = now() - interval '45 minutes' where id = $1`,
      [up.jobId],
    );
    // Provider now keeps working, as it would through a big cold archive.
    await provider.invoke(db);
    await db.sql(`delete from net.bench_posts`);
    await drain(db, up.jobId, provider);
    void held;
    const expected = titles.filter((t) => t.kind === 'provider' && !t.watchlist).length;
    const [got] = await db.rows(
      `select count(*)::int as n from user_media um join media_items mi on mi.id = um.media_item_id
        where um.user_id = $1 and mi.provenance = 'tmdb'`,
      [user],
    );
    assert.equal(got.n, expected, `provider-found films applied (${got.n} of ${expected})`);
    return { expected, applied: got.n };
  },

  /** A provider call still in flight when the rest of the job has landed must not be orphaned. */
  async settleVsInflight({ db, user, titles }) {
    const up = await upload(db, user, titles);
    // Match everything locally.
    for (let i = 0; i < 60; i += 1) {
      const [job] = await db.rows(`select status from import_jobs where id = $1`, [up.jobId]);
      if (job.status === 'applying') break;
      await db.sql(`select public._drain_import_jobs()`);
    }
    await db.sql(`delete from net.bench_posts`);
    // The Edge Function claims a batch and is slow to answer...
    const inflight = await db.rows(`select * from _import_provider_claim(1000)`);
    // ...while ticks keep running and every other row lands.
    for (let i = 0; i < 80; i += 1) {
      await db.sql(`select public._drain_import_jobs()`);
      await db.sql(`delete from net.bench_posts`);
    }
    const [mid] = await db.rows(`select status, completed_at from import_jobs where id = $1`, [
      up.jobId,
    ]);
    // Then it answers.
    const byName = new Map(titles.map((t) => [t.name, t]));
    let tmdb = 9_000_000;
    for (const c of inflight) {
      const t = byName.get(c.name);
      if (t?.kind === 'provider') {
        const [{ id }] = await db.rows(
          `insert into media_items (kind, tmdb_id, title, release_date, provenance)
           values ('movie', $1, $2, $3::date, 'tmdb') returning id`,
          [(tmdb += 1), t.name, `${t.year}-06-01`],
        );
        await db.sql(`select _import_provider_resolve($1, $2)`, [c.row_id, id]);
      } else {
        await db.sql(`select _import_provider_resolve($1, null)`, [c.row_id]);
      }
    }
    await drain(db, up.jobId, providerOracle(titles));
    const [orphans] = await db.rows(
      `select count(*)::int as n from import_rows r join import_jobs j on j.id = r.job_id
        where j.id = $1 and j.completed_at is not null and r.status = 'matched'`,
      [up.jobId],
    );
    assert.equal(orphans.n, 0, 'no matched row stranded in a finished job');
    assert.equal(
      mid.completed_at,
      null,
      'the job waited for the provider batch it had handed out',
    );
    return { inflight: inflight.length, settledEarly: mid.completed_at !== null };
  },

  /**
   * The same race on a row's LAST attempt. Before the lease, a third-attempt claim did not hold
   * its job (no attempts "remained"), so the job settled underneath it and the answer landed on
   * a finished job as a `matched` row nothing would apply.
   */
  async settleVsInflightFinalAttempt({ db, user, titles }) {
    const up = await upload(db, user, titles);
    for (let i = 0; i < 60; i += 1) {
      const [job] = await db.rows(`select status from import_jobs where id = $1`, [up.jobId]);
      if (job.status === 'applying') break;
      await db.sql(`select public._drain_import_jobs()`);
    }
    await db.sql(`delete from net.bench_posts`);
    await db.sql(
      `update import_rows set provider_attempts = 2 where job_id = $1 and status = 'needs_provider'`,
      [up.jobId],
    );
    const inflight = await db.rows(`select * from _import_provider_claim(1000)`);
    for (let i = 0; i < 80; i += 1) {
      await db.sql(`select public._drain_import_jobs()`);
      await db.sql(`delete from net.bench_posts`);
    }
    const [mid] = await db.rows(`select completed_at from import_jobs where id = $1`, [
      up.jobId,
    ]);
    const byName = new Map(titles.map((t) => [t.name, t]));
    let tmdb = 9_500_000;
    let found = 0;
    for (const c of inflight) {
      const t = byName.get(c.name);
      if (t?.kind === 'provider') {
        const [{ id }] = await db.rows(
          `insert into media_items (kind, tmdb_id, title, release_date, provenance)
           values ('movie', $1, $2, $3::date, 'tmdb') returning id`,
          [(tmdb += 1), t.name, `${t.year}-06-01`],
        );
        await db.sql(`select _import_provider_resolve($1, $2)`, [c.row_id, id]);
        found += 1;
      } else {
        await db.sql(`select _import_provider_resolve($1, null)`, [c.row_id]);
      }
    }
    await drain(db, up.jobId, providerOracle(titles));
    const [orphans] = await db.rows(
      `select count(*)::int as n from import_rows where job_id = $1 and status = 'matched'`,
      [up.jobId],
    );
    // Watched films land in the collection and watchlist films on the watchlist.
    const [arrived] = await db.rows(
      `select (select count(*) from user_media um join media_items mi on mi.id = um.media_item_id
                where um.user_id = $1 and mi.provenance = 'tmdb')
            + (select count(*) from watchlist w join media_items mi on mi.id = w.media_item_id
                where w.user_id = $1 and mi.provenance = 'tmdb')::int as n`,
      [user],
    );
    arrived.n = Number(arrived.n);
    assert.equal(mid.completed_at, null, 'a job holds for its last in-flight provider answers');
    assert.equal(orphans.n, 0, 'no matched row stranded in a finished job');
    assert.equal(
      arrived.n,
      found,
      `every film the provider found arrived (${arrived.n} of ${found})`,
    );
    return { inflight: inflight.length, found, arrived: arrived.n };
  },

  /** A provider that never answers still ends the wait: the job settles, honestly unmatched. */
  async providerSilentPastGrace({ db, user, titles }) {
    const up = await upload(db, user, titles);
    const silent = { invoke: async () => 0, stats: {} };
    const run = await drain(db, up.jobId, silent, { maxTicks: 800 });
    const [job] = await db.rows(`select status, counts from import_jobs where id = $1`, [
      up.jobId,
    ]);
    assert.equal(
      job.status,
      'done',
      'a silent provider ends in a summary, not a hang or a failure',
    );
    const unplaced = titles.filter((t) => t.kind === 'provider' || t.kind === 'unknown').length;
    assert.equal(
      job.counts.unmatched,
      unplaced,
      'what the provider never answered is reported unmatched',
    );
    return {
      ticks: run.ticks,
      modelledMinutes: Math.round((run.ticks * run.cadenceSeconds) / 60),
      counts: job.counts,
    };
  },

  /** Every invocation is rate-limited after eight requests. Nothing is lost to it. */
  async rateLimitedProvider({ db, user, titles }) {
    const up = await upload(db, user, titles);
    const provider = providerOracle(titles, { limitAfter: 8 });
    const run = await drain(db, up.jobId, provider);
    const expected = titles.filter((t) => t.kind === 'provider').length;
    const [got] = await db.rows(
      `select (select count(*) from user_media um join media_items mi on mi.id = um.media_item_id
                where um.user_id = $1 and mi.provenance = 'tmdb')
            + (select count(*) from watchlist w join media_items mi on mi.id = w.media_item_id
                where w.user_id = $1 and mi.provenance = 'tmdb') as n`,
      [user],
    );
    assert.equal(
      Number(got.n),
      expected,
      `every provider-findable film arrived (${got.n} of ${expected})`,
    );
    await verify(db, user, up.jobId, titles);
    return {
      ticks: run.ticks,
      released: provider.stats.released,
      expected,
      arrived: Number(got.n),
    };
  },

  /** The same archive twice, the second while nothing else is running: nothing doubles. */
  async reimport({ db, user, titles }) {
    const first = await upload(db, user, titles);
    await drain(db, first.jobId, providerOracle(titles));
    const one = await verify(db, user, first.jobId, titles);
    const second = await upload(db, user, titles);
    await drain(db, second.jobId, providerOracle(titles));
    const [again] = await db.rows(
      `select (select count(*) from user_media where user_id = $1)::int as media,
              (select count(*) from imported_watches where user_id = $1)::int as watches,
              (select count(*) from notifications where recipient_id = $1 and type = 'import_completed')::int as completed`,
      [user],
    );
    assert.equal(again.media, one.media);
    assert.equal(again.watches, one.watches);
    assert.equal(again.completed, 2, 'one completion per job');
    return again;
  },
};

// ---------------------------------------------------------------------------

async function main() {
  await startCluster();
  const out = { at: new Date().toISOString(), sizes: [], scenarios: [] };
  try {
    if (!flag('--scenarios')) {
      for (const size of SIZES) {
        const result = await bench(size);
        out.sizes.push(result);
        console.log(JSON.stringify(result));
      }
    }
    if (flag('--scenarios') || flag('--all')) {
      const size = Number(option('--scenario-size', '600'));
      for (const [name, body] of Object.entries(SCENARIOS)) {
        const result = await scenario(name, size, body);
        out.scenarios.push(result);
        console.log(JSON.stringify(result));
      }
    }
  } finally {
    await stopCluster();
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  if (out.scenarios.some((s) => !s.ok)) process.exitCode = 1;
}

await main();
