#!/usr/bin/env node
/**
 * Watch History + Lists at account scale, against a REAL PostgreSQL 17.
 *
 *   node supabase/tests/perf/watch-history-lists-scale.mjs
 *   node supabase/tests/perf/watch-history-lists-scale.mjs --ranked 1200 --json out.json
 *
 * The post-foundation hardening pass (2026-09-20) asked one question of the combined
 * candidate: **what does a heavy account cost?** — 1,000+ ranked titles, many rewatches, a
 * long placement ledger, a hundred lists with several at the 500-item cap — measured
 * through the real RPCs as the signed-in user, beside a background population large
 * enough that a sequential scan is visible rather than free.
 *
 * ---------------------------------------------------------------------------
 * HOW A SEQUENTIAL SCAN IS CAUGHT INSIDE A SECURITY DEFINER FUNCTION
 *
 * `explain` cannot see into a function body. `pg_stat_xact_user_tables` can: it counts the
 * current transaction's scans per table, including every statement a function ran. So
 * each operation runs in its own transaction, the counters are read before it commits,
 * and any table with `seq_scan > 0` and more than `--seq-floor` live rows is reported by
 * name. That is the whole method, and it is why this is a script rather than an
 * `explain` of hand-copied SQL that could drift from the function it claims to describe.
 *
 * Not a test file, so it is in no `*.test.mjs` glob. It takes a few minutes.
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { createRaceDb, fixtures, stopCluster } from '../concurrency/harness.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

const RANKED = Number(option('--ranked', '1200'));
const BACKGROUND_USERS = Number(option('--background', '200'));
const BACKGROUND_TITLES = Number(option('--background-titles', '150'));
const SEQ_FLOOR = Number(option('--seq-floor', '2000'));
const REPEAT = Number(option('--repeat', '7'));
const JSON_OUT = option('--json', null);

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const fmt = (v) => `${v.toFixed(1)}ms`;

let tmdbBase = 50_000_000;

async function main() {
  const db = await createRaceDb();
  const fx = fixtures(db);
  const report = { ranked: RANKED, results: [] };

  try {
    // -----------------------------------------------------------------------
    // Seed. Direct inserts as superuser, then the deferred placeholder trigger
    // gives every logged title its first event at commit — the same shape the T1
    // backfill leaves.
    // -----------------------------------------------------------------------
    const t0 = performance.now();

    // A shared catalogue: RANKED movies + 40 series x 4 seasons.
    await db.sql(
      `insert into media_items (kind, tmdb_id, title, provenance, release_date, poster_path)
       select 'movie', -($1::int + g), 'catalogue ' || g, 'manual',
              date '2000-01-01' + (g % 8000), '/p' || g || '.jpg'
         from generate_series(1, $2::int) g`,
      [(tmdbBase += 1_000_000), RANKED + 600],
    );
    const series = [];
    for (let i = 0; i < 40; i += 1) {
      const s = await fx.createSeries(`series ${i}`);
      for (let n = 1; n <= 4; n += 1) await fx.createSeason(s, n);
      series.push(s);
    }

    const heavy = await fx.createUser({ username: 'heavy' });
    const viewer = await fx.createUser({ username: 'viewer' });
    await fx.mutualFollow(heavy, viewer);

    // The heavy account: RANKED movies across three buckets, positions per bucket
    // band in category order, plus every season of 30 series.
    await db.sql(
      `with picked as (
         select id, row_number() over (order by title) as n
           from media_items where kind = 'movie' order by title limit $2
       )
       insert into user_media (user_id, media_item_id, bucket, source, watched_on, created_at)
       select $1, id,
              (case when n % 3 = 0 then 'loved' when n % 3 = 1 then 'fine' else 'not_for_me' end)::taste_bucket,
              'in_app',
              case when n % 4 = 0 then null else date '2024-01-01' + (n % 600)::int end,
              now() - (n || ' hours')::interval
         from picked`,
      [heavy, RANKED],
    );
    await db.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       select um.user_id, um.media_item_id, 'movies', um.bucket,
              row_number() over (
                order by case um.bucket when 'loved' then 0 when 'fine' then 1 else 2 end,
                         um.media_item_id)
         from user_media um
        where um.user_id = $1`,
      [heavy],
    );
    await db.sql(
      `insert into user_media (user_id, media_item_id, bucket, source, watched_on)
       select $1, m.id, 'fine', 'in_app', date '2025-03-01' + m.season_number
         from media_items m
        where m.kind = 'season' and m.parent_id = any($2::uuid[])`,
      [heavy, series.slice(0, 30)],
    );

    // Rewatches: 300 titles x 3 extra viewings, 20 titles x 12. Inserted directly with
    // the basis the native writer would use, so the event table has the depth a
    // heavy re-watcher produces without paying for 1,000+ RPC round trips here.
    await db.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       select um.user_id, um.media_item_id, date '2025-01-01' + ((g * 37 + k) % 600)::int, 'reader'::watch_date_basis
         from (select user_id, media_item_id, row_number() over (order by media_item_id) as k
                 from user_media where user_id = $1) um
         cross join generate_series(1, 3) g
        where um.k <= 300
       union all
       select um.user_id, um.media_item_id, date '2023-06-01' + ((g * 11 + k) % 800)::int, 'reader'::watch_date_basis
         from (select user_id, media_item_id, row_number() over (order by media_item_id) as k
                 from user_media where user_id = $1) um
         cross join generate_series(1, 12) g
        where um.k <= 20`,
      [heavy],
    );

    // A long placement ledger: five historical placements per ranked title.
    await db.sql(
      `insert into ranking_placements
         (user_id, media_item_id, category, kind, outcome, bucket, position, band_rank,
          band_size, category_size, score, created_at)
       select r.user_id, r.media_item_id, r.category, 'backfill', 'placed', r.bucket,
              r.position, 1, 1, greatest(r.position, $2::int), 7.0,
              now() - ((g * 30) || ' days')::interval
         from rankings r cross join generate_series(1, 5) g
        where r.user_id = $1`,
      [heavy, RANKED],
    );

    /**
     * Background population, so the big tables are big.
     *
     * **Two bulk statements rather than one per account**, which is a measurement
     * decision and not only a speed one: `user_media` carries statement triggers (the
     * deferred placeholder event, the goal crossing, the watchlist clear, the award
     * evaluation), and driving them 120 times over 150 rows each measures the *seeding*
     * rather than anything this script is about. What the background exists for is row
     * count — enough of it that a sequential scan is visible in the numbers below. The
     * heavy account's own collection is written the ordinary way, and every timed
     * operation goes through the real RPCs.
     */
    const others = [];
    for (let u = 0; u < BACKGROUND_USERS; u += 1) {
      const other = await fx.createUser();
      others.push(other);
      if (u % 4 === 0) await fx.follow(heavy, other);
    }
    await db.sql(
      `with picked as (
         select id, row_number() over (order by title) as n
           from media_items where kind = 'movie' order by title limit $2
       )
       insert into user_media (user_id, media_item_id, bucket, source, watched_on)
       select u.id, p.id, 'fine', 'in_app', date '2025-01-01' + (p.n % 500)::int
         from unnest($1::uuid[]) as u(id) cross join picked p`,
      [others, BACKGROUND_TITLES],
    );
    await db.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       select um.user_id, um.media_item_id, 'movies', 'fine',
              row_number() over (partition by um.user_id order by um.media_item_id)
         from user_media um
        where um.user_id = any($1::uuid[])`,
      [others],
    );
    await db.sql(
      `insert into ranking_placements
         (user_id, media_item_id, category, kind, outcome, bucket, position, band_rank,
          band_size, category_size, score)
       select r.user_id, r.media_item_id, r.category, 'backfill', 'placed', r.bucket,
              r.position, 1, 1, 10000, 7.0
         from rankings r cross join generate_series(1, 2)
        where r.user_id <> $1`,
      [heavy],
    );
    await db.sql(
      `with loser as (select id from media_items where kind = 'movie' order by id limit 1)
       insert into comparisons (user_id, winner_id, loser_id, placement_id)
       select p.user_id, p.media_item_id, loser.id, p.id
         from ranking_placements p cross join loser cross join generate_series(1, 3)
        where p.media_item_id <> loser.id`,
    );
    await db.sql(
      `insert into feed_events (actor_id, media_item_id, type)
       select r.user_id, r.media_item_id, 'title_ranked' from rankings r`,
    );

    // Lists: 100 on the heavy account. Five at the 500-item cap, the rest at 20.
    const heavyS = await db.session('heavy');
    await heavyS.actAs(heavy);
    const lists = [];
    for (let i = 0; i < 100; i += 1) {
      const r = await heavyS.one(
        `select create_list(gen_random_uuid(), $1, null, 'public'::list_visibility, 'ranked', null) as r`,
        [`list ${i}`],
      );
      lists.push(r.r.id);
    }
    await db.sql(
      `insert into list_items (list_id, media_item_id, "position")
       select l.id, m.id, m.n
         from unnest($1::uuid[]) with ordinality as l(id, k)
         cross join lateral (
           select id, row_number() over (order by title) as n
             from media_items
            where kind in ('movie', 'season', 'series')
            order by title
            limit case when l.k <= 5 then 500 else 20 end
         ) m`,
      [lists],
    );

    await db.sql('analyze');
    const counts = await db.rows(
      `select relname, n_live_tup::int as rows from pg_stat_user_tables
        where relname in ('watch_events','ranking_placements','comparisons','user_media',
                          'rankings','feed_events','list_items','lists','media_items','watchlist')
        order by relname`,
    );
    report.seedMs = performance.now() - t0;
    report.tables = Object.fromEntries(counts.map((r) => [r.relname, r.rows]));
    console.log(`seeded in ${(report.seedMs / 1000).toFixed(1)}s`, report.tables);

    // -----------------------------------------------------------------------
    // The measuring loop.
    // -----------------------------------------------------------------------
    const bigTables = new Set(
      counts.filter((r) => r.rows >= SEQ_FLOOR).map((r) => r.relname),
    );

    const measure = async (session, label, sql, paramsFor, { repeat = REPEAT, rollback = false } = {}) => {
      const times = [];
      const seq = new Map();
      let lastRows = null;
      for (let i = 0; i < repeat; i += 1) {
        const params = typeof paramsFor === 'function' ? await paramsFor(i) : paramsFor;
        await session.begin();
        const start = performance.now();
        const res = await session.q(sql, params);
        times.push(performance.now() - start);
        lastRows = res.rowCount;
        const scans = await session.q(
          `select relname, seq_scan::int as n, seq_tup_read::bigint as tup
             from pg_stat_xact_user_tables where seq_scan > 0`,
        );
        for (const s of scans.rows) {
          if (!bigTables.has(s.relname)) continue;
          const prev = seq.get(s.relname) ?? { n: 0, tup: 0 };
          seq.set(s.relname, { n: prev.n + s.n, tup: prev.tup + Number(s.tup) });
        }
        if (rollback) await session.rollback();
        else await session.commit();
      }
      const row = {
        label,
        p50: median(times),
        max: Math.max(...times),
        rows: lastRows,
        seqScans: Object.fromEntries(seq),
      };
      report.results.push(row);
      const seqText = seq.size
        ? '  SEQ: ' + [...seq].map(([t, v]) => `${t}×${v.n / repeat}`).join(', ')
        : '';
      console.log(`${label.padEnd(46)} p50 ${fmt(row.p50).padStart(9)}  max ${fmt(row.max).padStart(9)}  rows ${String(lastRows).padStart(5)}${seqText}`);
      return row;
    };

    const ranked = await db.rows(
      `select media_item_id from rankings where user_id = $1 order by position`,
      [heavy],
    );
    const deep = ranked[Math.floor(ranked.length * 0.8)].media_item_id;
    const rewatched = (
      await db.rows(
        `select media_item_id from watch_events where user_id = $1
          group by 1 order by count(*) desc limit 1`,
        [heavy],
      )
    )[0].media_item_id;
    const fresh = await db.rows(
      `select id from media_items m where kind = 'movie'
          and not exists (select 1 from user_media u where u.user_id = $1 and u.media_item_id = m.id)
        limit 40`,
      [heavy],
    );
    let freshAt = 0;

    console.log('\n== reads, as the heavy account ==');
    await measure(heavyS, 'history: events for a 13-watch title',
      `select id, watched_on, basis, import_ref, recorded_at from watch_events
        where media_item_id = $1 order by watched_on nulls first, recorded_at`, [rewatched]);
    await measure(heavyS, 'history: placements for a title',
      `select * from ranking_placements where media_item_id = $1 order by created_at desc`, [deep]);
    await measure(heavyS, 'title: watch count',
      `select count(*) from watch_events where media_item_id = $1`, [rewatched]);
    await measure(heavyS, 'goals: a year of events (client read)',
      `select we.id, we.media_item_id, we.watched_on, m.kind
         from watch_events we join media_items m on m.id = we.media_item_id
        where we.watched_on between '2025-01-01' and '2025-12-31' order by we.id`, []);
    await measure(heavyS, 'collection: user_media + media (client read)',
      `select um.media_item_id, um.bucket, um.watched_on, m.title, m.kind
         from user_media um join media_items m on m.id = um.media_item_id
        where um.user_id = $1 order by um.media_item_id limit 1000`, [heavy]);
    await measure(heavyS, 'collection: rankings for movies (1,200)',
      `select media_item_id, position, bucket from rankings
        where user_id = $1 and category = 'movies' order by position`, [heavy]);
    await measure(heavyS, 'profile_title_counts',
      `select * from profile_title_counts($1)`, [heavy]);
    await measure(heavyS, 'feed: follow feed page (50)',
      `select fe.id, fe.type, fe.actor_id, fe.media_item_id, fe.created_at from feed_events fe
        where fe.actor_id in (select followee_id from follows where follower_id = $1 and state = 'approved')
        order by fe.created_at desc, fe.id desc limit 50`, [heavy]);
    await measure(heavyS, 'leaderboard titles/month (flag off)',
      `select * from leaderboard('titles', 'month', 50)`, []);
    await db.sql(`update app_config set value = 'true'::jsonb where key = 'leaderboard.monthly_from_events'`);
    await measure(heavyS, 'leaderboard titles/month (flag ON)',
      `select * from leaderboard('titles', 'month', 50)`, []);
    await db.sql(`update app_config set value = 'false'::jsonb where key = 'leaderboard.monthly_from_events'`);

    console.log('\n== writes, as the heavy account ==');
    await measure(heavyS, 'log_title (new title, today)',
      `select log_title(gen_random_uuid(), $1, 'fine', current_date, 'today_default')`,
      () => [fresh[freshAt++].id]);
    await measure(heavyS, 'log_rewatch (13-watch title)',
      `select log_rewatch(gen_random_uuid(), $1, current_date, 'today_default')`, [rewatched]);
    await measure(heavyS, 'log_rewatch (deep ranked title)',
      `select log_rewatch(gen_random_uuid(), $1, date '2024-02-02', 'reader')`, [deep]);
    const ev = async () =>
      (await db.rows(`select id from watch_events where user_id = $1 and media_item_id = $2
                        order by recorded_at desc limit 1`, [heavy, deep]))[0].id;
    await measure(heavyS, 'edit_watch_event',
      `select edit_watch_event(gen_random_uuid(), $1, date '2024-03-03', 'reader')`,
      async () => [await ev()], { repeat: 3 });
    await measure(heavyS, 'delete_watch_event',
      `select delete_watch_event(gen_random_uuid(), $1)`,
      async () => [await ev()], { repeat: 3 });

    // A re-check at depth, through the prior-anchored search, winner always the
    // incumbent neighbour so it is the "nothing changed" path.
    {
      const times = [];
      let comparisons = 0;
      for (let i = 0; i < 3; i += 1) {
        const subject = ranked[Math.floor(ranked.length * (0.5 + i * 0.1))].media_item_id;
        const bucket = (await db.rows(`select bucket from rankings where user_id=$1 and media_item_id=$2`, [heavy, subject]))[0].bucket;
        let s0 = performance.now();
        let step = (await heavyS.one(`select rank_again($1, $2::taste_bucket, gen_random_uuid(), false) as r`, [subject, bucket])).r;
        times.push(performance.now() - s0);
        let guard = 0;
        while (step && !step.done && guard++ < 30) {
          const pivotPos = (await db.rows(`select position from rankings where user_id=$1 and media_item_id=$2`, [heavy, step.pivot]))[0]?.position;
          const subjPos = (await db.rows(`select position from rankings where user_id=$1 and media_item_id=$2`, [heavy, subject]))[0]?.position;
          const winner = pivotPos !== undefined && subjPos !== undefined && subjPos < pivotPos ? subject : step.pivot;
          s0 = performance.now();
          step = (await heavyS.one(`select rank_answer($1, $2, gen_random_uuid()) as r`, [step.session_id, winner])).r;
          times.push(performance.now() - s0);
          comparisons += 1;
        }
      }
      const row = { label: 'rank_again re-check at depth (per call)', p50: median(times), max: Math.max(...times), comparisonsPerRecheck: comparisons / 3 };
      report.results.push(row);
      console.log(`${row.label.padEnd(46)} p50 ${fmt(row.p50).padStart(9)}  max ${fmt(row.max).padStart(9)}  comparisons/recheck ${row.comparisonsPerRecheck.toFixed(1)}`);
    }

    console.log('\n== lists ==');
    const big = lists[0];
    await measure(heavyS, 'my_lists (100 lists, first page)', `select * from my_lists(null, 30)`, []);
    await measure(heavyS, 'my_lists_for_title', `select * from my_lists_for_title($1)`, [deep]);
    await measure(heavyS, 'list_view (500 items)', `select list_view($1)`, [big]);
    await measure(heavyS, 'list_items_page (500, first 100)', `select * from list_items_page($1, null, 100)`, [big]);
    await measure(heavyS, 'list_items_page (500, last page)', `select * from list_items_page($1, 400, 100)`, [big]);
    await measure(heavyS, 'list_viewer_progress (500)', `select list_viewer_progress($1)`, [big]);
    await measure(heavyS, 'move_list_item (500, first->last)',
      `select move_list_item(gen_random_uuid(), $1, (select media_item_id from list_items where list_id = $1 order by position limit 1), 499)`,
      [big]);
    await measure(heavyS, 'add_list_item (into a 20-item list)',
      `select add_list_item(gen_random_uuid(), $1, $2)`, () => [lists[50], fresh[freshAt++].id], { repeat: 5 });

    const viewerS = await db.session('viewer');
    await viewerS.actAs(viewer);
    await measure(viewerS, 'viewer: profile_lists', `select * from profile_lists($1, null, 10)`, [heavy]);
    await measure(viewerS, 'viewer: list_items_page (500, first 100)', `select * from list_items_page($1, null, 100)`, [big]);
    await measure(viewerS, 'viewer: add_list_to_watchlist (500)',
      `select add_list_to_watchlist(gen_random_uuid(), $1)`, [big], { repeat: 3, rollback: true });

    console.log('\n== cascades ==');
    await measure(heavyS, 'unlog a deep title (events+placements+comparisons)',
      `select unlog(gen_random_uuid(), $1)`, () => [ranked[Math.floor(ranked.length * 0.6) + freshAt++].media_item_id],
      { repeat: 3, rollback: true });
    const other = (await db.rows(`select user_id from rankings where user_id <> $1 limit 1`, [heavy]))[0].user_id;
    await measure(await db.session('superuser'), 'delete a background account (cascade)',
      `delete from auth.users where id = $1`, [other], { repeat: 1, rollback: true });

    await heavyS.end();
    await viewerS.end();
  } finally {
    await db.close();
    await stopCluster();
  }

  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
}

await main();
