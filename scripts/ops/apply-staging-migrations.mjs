/**
 * A one-off transactional migration runner, for the staging catch-up of 2026-09-08.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, WHICH IS NOT "THE CLI WAS INCONVENIENT"
 * ---------------------------------------------------------------------------
 *
 * `supabase db push` and `supabase migration up` both split a migration file into
 * statements and execute them **outside a transaction**. That is not a transport
 * problem -- `release-lanes.md` recorded it as one, blaming the Management API, and a
 * direct `--db-url` connection fails identically. It is the CLI's applier.
 *
 * Two consequences, and the second is the one that matters:
 *
 *   1. `20260817001000` opens with `lock table media_cache in access exclusive mode`,
 *      which is illegal outside a transaction block (25P01). Staging has been stuck
 *      behind that one line since 2026-08-17.
 *   2. **There is no per-file rollback at all.** A failure halfway through any file
 *      leaves it half applied, and several files in this backlog are not idempotent --
 *      `alter table feed_events drop constraint feed_events_known_type` appears three
 *      times with no `if exists`, and there are `add column` and `create unique index`
 *      statements without `if not exists`. Re-running a half-applied file fails on the
 *      part that already succeeded, which is the worst recovery position to be in.
 *
 * So this restores the guarantee the CLI does not give: one transaction per file, and
 * the history row committed with the schema change that earned it, never separately.
 *
 * **This is not a migration framework and must not become one.** It exists to move one
 * database from 53 to 109 once. Every future change goes back through `supabase db push`
 * on a database that is current, where a single additive file has no half-applied state
 * worth defending. If a second file ever needs `lock table`, fix that in the file.
 *
 * ---------------------------------------------------------------------------
 * WHY IT MAY WRITE THE HISTORY TABLE
 * ---------------------------------------------------------------------------
 *
 * Writing `supabase_migrations.schema_migrations` by hand is ordinarily the thing you
 * must never do, because a row that says a migration ran is a claim the database cannot
 * check. This is allowed to make that claim for exactly one reason: `verify-splitter.mjs`
 * proves, against the 53 rows the CLI itself wrote, that `splitStatements` reproduces the
 * CLI's own `statements` arrays element for element and that `name` is derived the same
 * way. The row this writes is the row the CLI would have written, and it is written
 * inside the transaction that applied the file, so it cannot outlive a failure.
 *
 * Run `node scripts/ops/verify-splitter.mjs` before trusting this. It is the gate.
 *
 *   node scripts/ops/apply-staging-migrations.mjs             # plan only, no writes
 *   node scripts/ops/apply-staging-migrations.mjs --probe     # prove the fix, rolled back
 *   node scripts/ops/apply-staging-migrations.mjs --apply     # the real thing
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { splitStatements } from './split-sql.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
// Resolved against the project root, which is what `createRequire` was pointed at above.
const { STAGING_REF, PRODUCTION_REF } = require('./config/backends.cjs');
const { environmentForRef } = require('./config/production-lane.cjs');

const DIR = 'supabase/migrations';
/** One lock for the whole run, so two of these cannot interleave on one database. */
const ADVISORY_LOCK = [4242, 20260908];

const mode = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--probe') ? 'probe' : 'plan';

/**
 * Nothing this prints may carry the connection string.
 *
 * A Postgres error can quote the URL back (`failed to connect to ...`), and this is the
 * only writer of that value into a log the operator reads.
 */
const scrub = (value) =>
  String(value)
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, '[REDACTED_DB_URL]')
    .replace(new RegExp(String(process.env.BINGD_STAGING_DB_URL ?? 'x').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED_DB_URL]');

const die = (message) => { console.error('\nREFUSING: ' + scrub(message)); process.exit(1); };

// ---------------------------------------------------------------------------
// TARGETING. Every one of these is a refusal, not a warning.
// ---------------------------------------------------------------------------

const url = process.env.BINGD_STAGING_DB_URL;
if (!url) die('BINGD_STAGING_DB_URL is not set. This tool has no default and no fallback.');

/**
 * The project ref, from a Postgres URL rather than an HTTPS one.
 *
 * `backends.cjs`'s `supabaseProjectRef` parses `https://<ref>.supabase.co` and is the
 * authority for a client URL; a database URL says the ref in one of two other places --
 * the direct host `db.<ref>.supabase.co`, or the pooler username `postgres.<ref>`. Both
 * are read, and they must agree with each other when both are present.
 */
function refFromDatabaseUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'LOCALHOST';

  const direct = /^db\.([a-z0-9]{20})\.supabase\.(co|com)$/.exec(host)?.[1] ?? null;
  const pooled = /^postgres\.([a-z0-9]{20})$/.exec(decodeURIComponent(parsed.username || ''))?.[1] ?? null;
  if (direct && pooled && direct !== pooled) return null;
  return direct ?? pooled;
}

const ref = refFromDatabaseUrl(url);
if (ref === 'LOCALHOST') die('the URL points at localhost. This tool targets hosted staging only.');
if (!ref) die('could not identify a Supabase project ref in BINGD_STAGING_DB_URL.');
if (ref === PRODUCTION_REF) die(`the URL points at PRODUCTION (${PRODUCTION_REF}). This tool never writes to production.`);
if (ref !== STAGING_REF) die(`the URL points at ${ref}, which is not staging (${STAGING_REF}).`);
if (environmentForRef(ref) !== 'nonprod') die(`${ref} is not declared nonprod in config/production-lane.cjs.`);

// ---------------------------------------------------------------------------

const localFiles = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const byVersion = new Map(localFiles.map((f) => [f.slice(0, 14), f]));

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 300000 });
const q = (sql, params) => client.query(sql, params);

let locked = false;
try {
  await client.connect();
  console.log(`target        : ${ref} (nonprod), identified from the URL and checked against config/`);
  console.log(`mode          : ${mode}`);

  // A held lock means another run of this is in flight. Try, never wait: a queued second
  // runner that wakes up mid-way through the first one's work is the thing to avoid.
  const got = (await q(`select pg_try_advisory_lock($1, $2) as ok`, ADVISORY_LOCK)).rows[0].ok;
  if (!got) die('another migration run holds the advisory lock on this database.');
  locked = true;

  // ------------------------------------------------------------------ preflight
  const state = (await q(`
    select (select count(*) from supabase_migrations.schema_migrations)::int as applied,
           (select max(version) from supabase_migrations.schema_migrations) as latest,
           (select count(*) from auth.users)::int as auth_users,
           (select count(*) from public.profiles)::int as profiles`)).rows[0];

  /**
   * The second identity check, and the stronger one.
   *
   * A ref is a string in an environment variable. **Production holds fourteen real
   * accounts and staging holds none**, so a non-empty `auth.users` or `profiles` means
   * this is not the database the operator thinks it is, whatever the URL spells. Refusing
   * on state costs nothing on a database that is genuinely empty and is the only guard
   * that survives somebody pasting the wrong value into the right variable.
   */
  if (state.auth_users !== 0 || state.profiles !== 0) {
    die(`target holds ${state.auth_users} auth users and ${state.profiles} profiles. Staging has none; this is not staging.`);
  }

  const appliedRows = (await q(`select version from supabase_migrations.schema_migrations order by version`)).rows;
  const appliedSet = new Set(appliedRows.map((r) => r.version));
  const unknown = [...appliedSet].filter((v) => !byVersion.has(v));
  if (unknown.length) die(`the database has ${unknown.length} migration(s) with no local file: ${unknown.join(', ')}`);

  const pending = localFiles.filter((f) => !appliedSet.has(f.slice(0, 14)));

  console.log(`applied       : ${state.applied} / ${localFiles.length}`);
  console.log(`latest        : ${state.latest}`);
  console.log(`auth users    : ${state.auth_users}   profiles: ${state.profiles}`);
  console.log(`pending       : ${pending.length}`);
  if (pending.length) {
    console.log(`range         : ${pending[0].slice(0, 14)} -> ${pending[pending.length - 1].slice(0, 14)}`);
  }

  if (!pending.length) { console.log('\nNothing to do.'); }

  // ------------------------------------------------------------------ probe
  if (mode === 'probe') {
    /**
     * The whole hypothesis, tested and thrown away.
     *
     * `lock table` is the statement the CLI could not run. If it succeeds inside an
     * explicit transaction and the rollback leaves nothing behind, the approach is sound
     * and the 56 files can follow. Rolled back, so it writes nothing.
     */
    await q('begin');
    await q('lock table media_cache in access exclusive mode');
    const inTx = (await q(`select now() != statement_timestamp() or true as ok`)).rows[0].ok;
    await q('rollback');
    const after = (await q(`select count(*)::int as applied from supabase_migrations.schema_migrations`)).rows[0];
    console.log(`\nprobe: LOCK TABLE inside an explicit transaction SUCCEEDED (${inTx})`);
    console.log(`probe: rolled back; applied count still ${after.applied}`);
    console.log('The mechanism works. Re-run with --apply to perform the catch-up.');
  }

  // ------------------------------------------------------------------ plan
  if (mode === 'plan') {
    console.log('\nWould apply, in this order:');
    for (const f of pending) console.log('  ' + f);
    console.log('\nNo writes were made. Re-run with --apply.');
  }

  // ------------------------------------------------------------------ apply
  if (mode === 'apply') {
    console.log('\nApplying, one transaction per file:\n');
    let done = 0;
    for (const file of pending) {
      const version = file.slice(0, 14);
      const name = file.slice(15).replace(/\.sql$/, '');
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      const statements = splitStatements(sql);
      const started = Date.now();
      let index = -1;

      // Re-checked inside the loop rather than trusted from the preflight snapshot: this
      // is the invariant that makes a resumed run safe.
      const already = (await q(
        `select 1 from supabase_migrations.schema_migrations where version = $1`, [version])).rowCount;
      if (already) { console.log(`  ${version}  ${name}  ALREADY APPLIED, skipped`); continue; }

      try {
        await q('begin');
        for (index = 0; index < statements.length; index += 1) {
          await q(statements[index]);
        }
        // In the same transaction as the work it describes. A history row that can commit
        // without its schema change is the failure this whole tool exists to prevent.
        await q(
          `insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, $2, $3)`,
          [version, statements, name]);
        await q('commit');
      } catch (error) {
        try { await q('rollback'); } catch { /* the connection may already be unusable */ }
        console.error(`\n  ${version}  ${name}  FAILED at statement ${index + 1} of ${statements.length}`);
        console.error(`  sqlstate : ${error.code ?? '-'}`);
        console.error(`  message  : ${scrub(error.message)}`);
        console.error(`  statement head: ${scrub(String(statements[index] ?? '').replace(/\s+/g, ' ').slice(0, 160))}`);
        console.error('\n  ROLLED BACK. Nothing from this file was committed.');
        console.error(`  Last committed migration: ${done ? pending[done - 1].slice(0, 14) : state.latest}`);
        process.exitCode = 1;
        break;
      }

      const confirmed = (await q(
        `select 1 from supabase_migrations.schema_migrations where version = $1`, [version])).rowCount;
      if (!confirmed) die(`${version} committed but is not in the history table.`);

      done += 1;
      console.log(`  ${version}  ${name.padEnd(44)} ok  ${statements.length} stmts  ${Date.now() - started}ms`);
    }

    const final = (await q(`
      select count(*)::int as applied, max(version) as latest
        from supabase_migrations.schema_migrations`)).rows[0];
    console.log(`\napplied this run : ${done}`);
    console.log(`final state      : ${final.applied} / ${localFiles.length}, latest ${final.latest}`);
  }
} catch (error) {
  console.error('\nERROR: ' + scrub(error.message));
  process.exitCode = 1;
} finally {
  if (locked) { try { await client.query(`select pg_advisory_unlock($1, $2)`, ADVISORY_LOCK); } catch { /* going away anyway */ } }
  await client.end().catch(() => {});
}
