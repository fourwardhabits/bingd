#!/usr/bin/env node
/**
 * The collaborative half of the For You offline evaluation (Engine V2, A3).
 *
 *   node scripts/rec-eval/collaborative.mjs <world-input.json> <collaborative-output.json>
 *
 * Loads a **synthetic** world — titles, people, and each person's ranked titles (test readers'
 * held-out titles already removed) — into an ephemeral PGlite database built from this repo's
 * migrations, turns `v2_hybrid` on for everybody **in that throwaway database only**, and calls
 * the real `collaborative_candidates` as each test reader. Nothing here connects to any other
 * database.
 *
 * Output, per test reader: the rows (title index, support, endorsers), how many neighbours the
 * refresh kept, and the call's wall time. PGlite is single-connection WASM, so the timings are
 * for orientation only; capacity is measured on real PostgreSQL by the scale benchmarks.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { createTestDb } from '../../supabase/tests/harness.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: collaborative.mjs <world-input.json> <collaborative-output.json>');
  process.exit(2);
}

const world = JSON.parse(readFileSync(input, 'utf8'));
const started = Date.now();
const t = await createTestDb();

const arrayLiteral = (values) => `{${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')}}`;
const chunks = (rows, size) => {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

await t.sql(`create table ev_titles (i integer primary key, id uuid not null)`);
for (const chunk of chunks(world.titles, 2000)) {
  await t.sql(
    `with x as (
       select * from json_to_recordset($1::json)
         as x(i integer, title text, lang text, year integer, pop real, genres text)
     ), ins as (
       insert into media_items (kind, tmdb_id, title, provenance, original_language, release_date,
                                popularity, genres, poster_path)
       select 'movie', -(800000 + x.i), x.title, 'manual', x.lang, make_date(x.year, 6, 1),
              x.pop, x.genres::text[], '/synthetic.jpg'
         from x
       returning id, tmdb_id
     )
     insert into ev_titles (i, id) select -(tmdb_id) - 800000, id from ins`,
    [
      JSON.stringify(
        chunk.map((title) => ({
          i: title.index,
          title: title.title,
          lang: title.language,
          year: title.year,
          pop: title.popularity,
          genres: arrayLiteral(title.genres),
        })),
      ),
    ],
  );
}

await t.sql(`create table ev_people (i integer primary key, id uuid not null default gen_random_uuid(), vis text)`);
for (const chunk of chunks(world.people, 2000)) {
  await t.sql(
    `insert into ev_people (i, vis) select x.i, x.vis from json_to_recordset($1::json) as x(i integer, vis text)`,
    [JSON.stringify(chunk.map((person) => ({ i: person.index, vis: person.visibility })))],
  );
}
await t.sql(`insert into auth.users (id) select id from ev_people`);
await t.sql(
  `insert into profiles (id, username, display_name, visibility)
   select id, 'ev_' || i, 'ev_' || i, vis::profile_visibility from ev_people`,
);
await t.sql(`insert into profile_private (profile_id, date_of_birth) select id, '1990-01-01' from ev_people`);

const BUCKET = ['loved', 'fine', 'not_for_me'];
let rankingRows = 0;
for (const chunk of chunks(world.rankings, 20000)) {
  rankingRows += chunk.length;
  console.error(`collaborative: loading rankings ${rankingRows}/${world.rankings.length}`);
  await t.sql(
    `insert into rankings (user_id, media_item_id, category, bucket, position)
     select p.id, ti.id, 'movies', x.b::taste_bucket, x.pos
       from json_to_recordset($1::json) as x(p integer, t integer, b text, pos integer)
       join ev_people p on p.i = x.p
       join ev_titles ti on ti.i = x.t`,
    [JSON.stringify(chunk.map(([p, title, b, pos]) => ({ p, t: title, b: BUCKET[b], pos })))],
  );
}

// What each test reader's client knows they have met, so the server excludes the same titles.
for (const chunk of chunks(world.met ?? [], 20000)) {
  await t.sql(
    `insert into user_media (user_id, media_item_id, bucket)
     select p.id, ti.id, x.b::taste_bucket
       from json_to_recordset($1::json) as x(p integer, t integer, b text)
       join ev_people p on p.i = x.p
       join ev_titles ti on ti.i = x.t
     on conflict do nothing`,
    [JSON.stringify(chunk.map(([p, title, b]) => ({ p, t: title, b: b == null ? null : BUCKET[b] })))],
  );
}

const setConfig = (key, value) =>
  t.sql(
    `insert into app_config (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );
await setConfig('recommendations.v2_engine', 'v2_hybrid');
await setConfig('recommendations.v2_rollout_percent', 100);
const loadMs = Date.now() - started;

const { rows: idRows } = await t.sql(`select i, id from ev_people`);
const idOf = new Map(idRows.map((row) => [row.i, row.id]));
const { rows: titleRows } = await t.sql(`select i, id from ev_titles`);
const titleOf = new Map(titleRows.map((row) => [row.id, row.i]));

const readers = {};
for (const person of world.readers) {
  const id = idOf.get(person);
  await t.actAs(id);
  const before = performance.now();
  const { rows } = await t.sql(`select media_item_id, support, endorsers from collaborative_candidates('movie', 40)`);
  const ms = performance.now() - before;
  await t.actAs(null);
  const { rows: kept } = await t.sql(
    `select neighbours from taste_neighbour_refresh where reader_id = $1`,
    [id],
  );
  readers[person] = {
    rows: rows.map((row) => [titleOf.get(row.media_item_id), Number(row.support), row.endorsers]),
    neighbours: kept[0]?.neighbours ?? 0,
    ms,
  };
  const done = Object.keys(readers).length;
  if (done % 50 === 0) console.error(`collaborative: ${done}/${world.readers.length} readers`);
}

writeFileSync(
  output,
  JSON.stringify({ loadMs, rankingRows, totalMs: Date.now() - started, readers }),
);
await t.db.close();
console.log(
  `collaborative: ${world.readers.length} readers, ${rankingRows} rankings, load ${loadMs} ms, total ${Date.now() - started} ms`,
);
