/**
 * Prove `splitStatements` is the Supabase CLI's splitter, against the CLI's own output.
 *
 * Staging holds 53 rows the CLI wrote itself, each carrying the `statements` array it
 * derived from a file that is still in this repo. If this splitter reproduces all 53
 * arrays element for element, it is the same function for these inputs, and the runner
 * may write a history row the CLI would have written. If a single element differs the
 * runner must not run — a history row in a shape the platform did not produce is worse
 * than a database that is merely behind.
 *
 * Read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { splitStatements } from './split-sql.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');

const DIR = 'supabase/migrations';
const url = process.env.BINGD_STAGING_DB_URL;
if (!url) { console.error('BINGD_STAGING_DB_URL is not set'); process.exit(1); }

const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin transaction read only');
const applied = (await c.query(
  `select version, name, statements from supabase_migrations.schema_migrations order by version`)).rows;
await c.query('commit');
await c.end();

const files = new Map(
  fs.readdirSync(DIR).filter((f) => f.endsWith('.sql'))
    .map((f) => [f.slice(0, 14), f]),
);

let ok = 0;
const problems = [];
for (const row of applied) {
  const file = files.get(row.version);
  if (!file) { problems.push(`${row.version}: no local file`); continue; }

  const expectedName = file.slice(15).replace(/\.sql$/, '');
  if (row.name !== expectedName) {
    problems.push(`${row.version}: name stored ${JSON.stringify(row.name)}, derived ${JSON.stringify(expectedName)}`);
  }

  const mine = splitStatements(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const theirs = row.statements ?? [];
  if (mine.length !== theirs.length) {
    problems.push(`${row.version}: ${theirs.length} statements stored, ${mine.length} derived`);
    continue;
  }
  const differing = mine.map((s, i) => (s === theirs[i] ? null : i)).filter((i) => i !== null);
  if (differing.length) {
    const i = differing[0];
    problems.push(
      `${row.version}: statement[${i}] differs (stored ${theirs[i].length} chars, derived ${mine[i].length})`);
    continue;
  }
  ok += 1;
}

console.log(`rows compared : ${applied.length}`);
console.log(`exact matches : ${ok}`);
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems.slice(0, 10)) console.log('  ' + p);
  process.exit(1);
}
console.log(`\nAll ${ok} stored arrays reproduced exactly, names included.`);
