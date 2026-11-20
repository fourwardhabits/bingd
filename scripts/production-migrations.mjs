#!/usr/bin/env node
/**
 * What production's database has applied, as a reviewed file, and the check that a commit's
 * code does not need more than that.
 *
 *   node scripts/production-migrations.mjs check              compare the record, production and HEAD
 *   node scripts/production-migrations.mjs write <evidence>   rewrite the record from production
 *
 * **Why a file, and not a query at publish time.** The EAS jobs that publish an update hold no
 * database credential, and adding one is a founder decision. So the record is committed, like
 * `config/live-runtimes.json`, and updated in the same docs pull request that records a
 * production migration. `scripts/ota-gate.mjs` reads it from the checkout, so the publish is
 * judged against the reviewed copy at that exact commit.
 *
 * **A stale record blocks, it does not admit.** Every migration file at the commit has to be
 * a version the record lists. A record that is behind production refuses an update that would
 * have been safe, which costs one docs pull request. A record that ran ahead of production
 * would admit a broken one, so the record is only ever written from a read of production.
 *
 * The record lists every version, not only the head and a count. A migration merged with a
 * version older than the head is otherwise invisible to a head comparison, and a count cannot
 * say which file is the one production lacks.
 *
 * `check` and `write` are the coordinator's, run where the Supabase Management API is reachable
 * (the session proxy supplies its credential, or SUPABASE_ACCESS_TOKEN). They only read
 * production: the query is sent with `read_only: true`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RECORD = 'config/production-migrations.json';
export const RUNBOOK = 'docs/release/safe-update-runbook.md §8';

const VERSION = /^\d{14}$/;
const FILE = /^supabase\/migrations\/(\d{14})_[^/]+\.sql$/;

/** The paths under `supabase/migrations/` in a commit. `git` throws if it cannot list them. */
export function migrationPaths(git, ref = 'HEAD') {
  return git('ls-tree', '--name-only', ref, '--', 'supabase/migrations/')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Everything wrong with the record's own shape. A record that cannot be trusted admits nothing. */
export function recordProblems(record) {
  if (!record || typeof record !== 'object' || !Array.isArray(record.versions)) {
    return [`${RECORD} has no "versions" list.`];
  }
  const { versions, head, count } = record;
  const problems = [];
  const bad = versions.filter((v) => typeof v !== 'string' || !VERSION.test(v));
  if (bad.length) problems.push(`${RECORD} lists versions that are not 14 digits: ${bad}`);
  if (versions.some((v, i) => i > 0 && !(versions[i - 1] < v))) {
    problems.push(`${RECORD} must list versions once each, in ascending order.`);
  }
  if (head !== versions.at(-1)) {
    problems.push(`${RECORD} says head ${head}, but its last version is ${versions.at(-1)}.`);
  }
  if (count !== versions.length) {
    problems.push(`${RECORD} says count ${count}, but lists ${versions.length} versions.`);
  }
  for (const field of ['recordedAt', 'evidence']) {
    if (typeof record[field] !== 'string' || !record[field]) {
      problems.push(`${RECORD} has no "${field}".`);
    }
  }
  return problems;
}

const list = (items, limit = 10) =>
  items.slice(0, limit).join(', ') +
  (items.length > limit ? `, and ${items.length - limit} more` : '');

/**
 * Whether a commit's migrations are all on production, by the record. Pure, so every refusal
 * has a test. `problems` are what a production publish refuses on; `notes` are only printed.
 */
export function migrationCheck(paths, record) {
  const problems = recordProblems(record);
  if (problems.length) return { problems, notes: [] };

  const byVersion = new Map();
  for (const path of paths) {
    const match = path.match(FILE);
    if (!match) {
      problems.push(
        `${path} is not named <14-digit version>_<name>.sql, so its version cannot be checked.`,
      );
      continue;
    }
    byVersion.set(match[1], [...(byVersion.get(match[1]) ?? []), path]);
  }
  if (!paths.length) {
    problems.push('supabase/migrations/ is empty at this commit, so nothing can be checked.');
  }
  for (const [version, files] of byVersion) {
    if (files.length > 1)
      problems.push(`Version ${version} is used by ${files.join(' and ')}.`);
  }

  const recorded = new Set(record.versions);
  const unrecorded = [...byVersion.keys()].filter((v) => !recorded.has(v)).sort();
  if (unrecorded.length) {
    const lines = unrecorded.map((version) => {
      const name = byVersion.get(version)[0].replace('supabase/migrations/', '');
      const where =
        version > record.head
          ? `newer than production's head ${record.head}`
          : `older than production's head ${record.head}, and not applied`;
      return `      ${name} (${where})`;
    });
    const them = unrecorded.length === 1 ? 'it' : 'them';
    problems.push(
      `Production has not applied ${unrecorded.length === 1 ? 'this migration' : `these ${unrecorded.length} migrations`}, ` +
        `by ${RECORD}, and this commit's code may call into ${them}:\n${lines.join('\n')}\n` +
        `    Apply ${them} to production, record ${them} in ${RECORD} (${RUNBOOK}), then publish ` +
        'a commit that carries the record. If production already has them, the record is stale: ' +
        'update it from a read of production, never by hand.',
    );
  }

  const absent = record.versions.filter((v) => !byVersion.has(v));
  const notes = absent.length
    ? [
        `${RECORD} lists ${absent.length} version(s) with no file at this commit: ${list(absent)}. ` +
          'Production is ahead of this commit, or the record is wrong.',
      ]
    : [];
  return { problems, notes };
}

/**
 * The gate's entry point: the migrations at `ref`, against the record. Reading either can fail,
 * and a failure is a problem, never a pass.
 */
export function commitMigrationCheck({ git, readRecord, ref = 'HEAD' }) {
  let paths;
  let record;
  try {
    paths = migrationPaths(git, ref);
  } catch (error) {
    const reason = String(error.message ?? error).split('\n')[0];
    return { problems: [`Could not list supabase/migrations/: ${reason}`], notes: [] };
  }
  try {
    record = readRecord();
  } catch (error) {
    const reason = String(error.message ?? error).split('\n')[0];
    return { problems: [`Could not read ${RECORD}: ${reason}`], notes: [] };
  }
  return migrationCheck(paths, record);
}

// ---------------------------------------------------------------------------
// The coordinator's commands
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const readCommittedRecord = () => JSON.parse(readFileSync(join(root, RECORD), 'utf8'));

async function productionVersions(fetchImpl, env) {
  const { PRODUCTION_REF } = createRequire(import.meta.url)('../config/backends.cjs');
  const headers = { 'content-type': 'application/json' };
  if (env.SUPABASE_ACCESS_TOKEN) headers.authorization = `Bearer ${env.SUPABASE_ACCESS_TOKEN}`;
  const response = await fetchImpl(
    `https://api.supabase.com/v1/projects/${PRODUCTION_REF}/database/query`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: 'select version from supabase_migrations.schema_migrations order by version',
        read_only: true,
      }),
    },
  );
  if (!response.ok) throw new Error(`The Management API answered ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('Production returned no versions');
  return rows.map((row) => String(row.version));
}

const difference = (a, b) => a.filter((v) => !b.includes(v));

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, evidence] = process.argv.slice(2);
  if (!['check', 'write'].includes(command) || (command === 'write' && !evidence)) {
    console.error(
      'usage: node scripts/production-migrations.mjs check\n' +
        '       node scripts/production-migrations.mjs write <docs/release/... record of the apply>',
    );
    process.exit(2);
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const production = await productionVersions(fetch, process.env);
  const files = migrationPaths(git).map((path) => path.match(FILE)?.[1] ?? path);

  if (command === 'write') {
    if (!/^docs\/.+\.md$/.test(evidence)) {
      console.error(`evidence must be the docs/ record of the apply, got "${evidence}"`);
      process.exit(2);
    }
    if (!existsSync(join(root, evidence)))
      console.warn(`note: ${evidence} is not in this checkout`);
    const record = {
      head: production.at(-1),
      count: production.length,
      recordedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      evidence,
      versions: production,
    };
    const problems = recordProblems(record);
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    writeFileSync(join(root, RECORD), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${RECORD}: head ${record.head}, ${record.count} versions`);
  }

  const record = readCommittedRecord();
  const lines = [
    ...recordProblems(record),
    ...difference(production, record.versions ?? []).map(
      (v) => `production has ${v}, the record does not`,
    ),
    ...difference(record.versions ?? [], production).map(
      (v) => `the record has ${v}, production does not`,
    ),
    ...difference(files, production).map((v) => `HEAD has ${v}, production does not`),
    ...difference(production, files).map((v) => `production has ${v}, HEAD has no file for it`),
  ];
  console.log(`production: head ${production.at(-1)}, ${production.length} versions`);
  console.log(
    `record:     head ${record.head}, ${record.count} versions, ${record.recordedAt}`,
  );
  console.log(`HEAD:       ${files.length} migration files`);
  for (const line of lines) console.log(`  - ${line}`);
  if (lines.length) process.exit(1);
  console.log('All three agree.');
}
