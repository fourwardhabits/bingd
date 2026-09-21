/**
 * The watch-history epic's verification and diff runner.
 *
 * `watch-history-and-ranking-calibration.md` §M.3 (verification), §M.5 (the per-account
 * diff), §D.7 (the cache-change enumeration).
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR
 *
 * Three questions, asked read-only, in this order:
 *
 *   **1. Did T1's backfill land correctly?** `assert_watch_history_valid()` and
 *   `assert_placements_valid()` raise on the first violation and name it. Run this after
 *   applying `20261003000100` and `20261004000100`, on staging and then on production,
 *   before anybody believes either.
 *
 *   **2. Whose cached date moved?** §D.7 says the cache should be unchanged for every
 *   row except native ones whose Letterboxd diary holds a LATER date. This enumerates
 *   the set, so "should" becomes a list somebody has read.
 *
 *   **3. What will T4's flags change?** `watch_history_repoint_diff()` names every
 *   account whose yearly goal or monthly standing moves, and by how much. §M.5 expects
 *   goals to RISE and the monthly board to FALL; a delta in the other direction is the
 *   signal to stop.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER WRITES, AND IT NEVER FLIPS A FLAG
 *
 * Deliberately. The flags are the founder's decision and the point of this script is to
 * put the numbers in front of that decision — a tool that both measures and acts is a
 * tool somebody runs with `--yes` at two in the morning. Flipping is one statement, and
 * it is printed at the end for copying.
 *
 *   BINGD_DB_URL=postgres://... node scripts/ops/watch-history-diff.mjs
 *   BINGD_DB_URL=postgres://... node scripts/ops/watch-history-diff.mjs --json
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { PRODUCTION_REF, STAGING_REF, REF_NAMES } = require('../../config/backends.cjs');

const asJson = process.argv.includes('--json');

/**
 * Nothing this prints may carry the connection string. A Postgres error can quote the
 * URL back ("failed to connect to ..."), and this is the only writer of that value into
 * a log an operator reads. Same guard `apply-staging-migrations.mjs` carries.
 */
const scrub = (value) => String(value).replace(/postgres(ql)?:\/\/[^\s"']+/gi, '[REDACTED_DB_URL]');

const die = (message) => {
  console.error('\nREFUSING: ' + scrub(message));
  process.exit(1);
};

const url = process.env.BINGD_DB_URL;
if (!url) {
  die(
    'BINGD_DB_URL is not set. This tool has no default and no fallback. Point it at ' +
      'staging first, and at production only after staging is clean.',
  );
}

/** The project ref, from a database URL: the direct host, or the pooler username. */
function refFromDatabaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'LOCALHOST';

  const direct = /^db\.([a-z0-9]{20})\.supabase\.(co|com)$/.exec(host)?.[1] ?? null;
  const pooled = /^postgres\.([a-z0-9]{20})$/.exec(decodeURIComponent(parsed.username || ''))?.[1] ?? null;
  if (direct && pooled && direct !== pooled) return null;
  return direct ?? pooled;
}

const ref = refFromDatabaseUrl(url);
if (!ref) die('could not identify a Supabase project ref in BINGD_DB_URL.');

const name =
  ref === PRODUCTION_REF
    ? `${ref} (${REF_NAMES[PRODUCTION_REF]}) — PRODUCTION`
    : ref === STAGING_REF
      ? `${ref} (${REF_NAMES[STAGING_REF]})`
      : ref;

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 300000,
});

const rows = async (sql, params) => (await client.query(sql, params)).rows;

const report = { target: name, checks: {}, cacheMoved: [], repoint: [] };

try {
  await client.connect();
  console.log(`target : ${name}`);
  console.log('mode   : read-only\n');

  // -------------------------------------------------------------------------
  // 1. The invariants.
  // -------------------------------------------------------------------------
  for (const [label, fn] of [
    ['watch history (W1–W5)', 'assert_watch_history_valid()'],
    ['placements (P1–P4)', 'assert_placements_valid()'],
  ]) {
    try {
      await client.query(`select ${fn}`);
      report.checks[label] = 'ok';
      console.log(`  ✓ ${label}`);
    } catch (e) {
      report.checks[label] = scrub(e.message);
      console.log(`  ✗ ${label}: ${scrub(e.message)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Whose cached date the backfill moved (§D.7).
  //
  // The expected set, and the ONLY expected set: a native row whose diary holds a later
  // date, where the cache moves to the authoritative later one. Anything else in this
  // list is a finding.
  // -------------------------------------------------------------------------
  report.cacheMoved = await rows(`
    select um.user_id,
           count(*)::int as titles,
           count(*) filter (
             where exists (
               select 1 from watch_events we
                where we.user_id = um.user_id and we.media_item_id = um.media_item_id
                  and we.basis = 'diary' and we.watched_on = um.watched_on
             )
           )::int as explained_by_a_diary_date
      from user_media um
      join media_items m on m.id = um.media_item_id
     where rankable_category(m.kind) is not null
       and um.source = 'in_app'
       and um.watched_on is not null
       and exists (
         select 1 from watch_events we
          where we.user_id = um.user_id and we.media_item_id = um.media_item_id
            and we.basis = 'unattributed'
            and we.watched_on < um.watched_on
       )
     group by um.user_id
     order by 2 desc
  `);

  console.log(`\n§D.7  cached dates moved by the backfill: ${report.cacheMoved.length} account(s)`);
  for (const row of report.cacheMoved) {
    const flag = row.titles === row.explained_by_a_diary_date ? ' ' : '!';
    console.log(
      `  ${flag} ${row.user_id}  ${row.titles} title(s), ` +
        `${row.explained_by_a_diary_date} explained by an authoritative diary date`,
    );
  }
  if (report.cacheMoved.some((r) => r.titles !== r.explained_by_a_diary_date)) {
    console.log(
      '  ! marks an account with a moved cache NOT explained by a diary date. §D.7 says\n' +
        '    that set should be empty. Read it before going further.',
    );
  }

  // -------------------------------------------------------------------------
  // 3. What T4's flags will change (§M.5).
  // -------------------------------------------------------------------------
  report.repoint = await rows(`select * from watch_history_repoint_diff()`);

  const goals = report.repoint.filter((r) => r.metric.startsWith('goal:'));
  const board = report.repoint.filter((r) => r.metric === 'board:titles');

  console.log(`\n§M.5  T4 repoint: ${report.repoint.length} change(s) across ${
    new Set(report.repoint.map((r) => r.user_id)).size
  } account(s)`);
  console.log(`  goals    : ${goals.length} (expected direction: UP)`);
  console.log(`  monthly  : ${board.length} (expected direction: DOWN)`);

  const surprises = [
    ...goals.filter((r) => r.delta < 0),
    ...board.filter((r) => r.delta > 0),
  ];
  for (const row of report.repoint) {
    console.log(
      `    ${row.user_id}  ${row.metric} ${row.period}  ${row.before_count} → ${row.after_count}  (${
        row.delta > 0 ? '+' : ''
      }${row.delta})`,
    );
  }
  if (surprises.length) {
    console.log(
      `\n  ! ${surprises.length} change(s) move the OPPOSITE way to what §M.5 predicts.\n` +
        '    A goal that falls, or a board standing that rises, is not a thing this\n' +
        '    repoint should produce. Stop and read them.',
    );
  }

  // -------------------------------------------------------------------------
  console.log('\nWhen the numbers above are understood and accepted, the flags flip with:\n');
  console.log(
    "  update app_config set value = 'true'::jsonb, updated_at = now()\n" +
      "   where key in ('goals.count_watch_events', 'leaderboard.monthly_from_events');\n",
  );
  console.log(
    '  Goals FIRST, and only after the client OTA carrying the event-based goal query\n' +
      '  has shipped (§M.2): the reverse order announces completions the bar does not show.\n' +
      "  The rollback is the same statement with 'false'.\n",
  );

  if (asJson) console.log(JSON.stringify(report, null, 2));
} catch (e) {
  die(e.message);
} finally {
  await client.end().catch(() => {});
}
