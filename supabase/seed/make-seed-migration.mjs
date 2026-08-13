/**
 * Writes catalogue.json out as a migration.
 *
 *   node supabase/seed/make-seed-migration.mjs
 *
 * The catalogue is data, not schema, so a migration is not the obvious home for it. It
 * is the right one anyway: `supabase db push` is already how every environment gets its
 * schema, the test harness already replays every migration, and a seed that arrives by
 * either of those routes needs no second mechanism, no connection string in a script,
 * and no step someone can forget before a build. `app_config` is seeded the same way.
 *
 * The file is generated and must not be hand-edited. Refreshing the catalogue means
 * re-running the fetcher and then this, which writes a *new* migration — the old one
 * stays applied, and the upserts mean the new one corrects rather than duplicates.
 *
 * Titles reach the file as dollar-quoted strings, which cannot be broken by an
 * apostrophe. Any title containing the tag itself is refused rather than escaped: the
 * dataset is reviewed input, so the honest response to something unexpected in it is to
 * stop, not to guess.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TAG = '$seed$';
const MIGRATION = '20260813002500_seed_catalogue.sql';

const text = (value) => {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'string') throw new Error(`not a string: ${value}`);
  if (value.includes(TAG)) throw new Error(`title contains the quoting tag: ${value}`);
  return `${TAG}${value}${TAG}`;
};

const number = (value) => {
  if (value === null || value === undefined) return 'null';
  if (!Number.isInteger(value)) throw new Error(`not an integer: ${value}`);
  return String(value);
};

const date = (value) => {
  if (value === null || value === undefined) return 'null';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`not a date: ${value}`);
  return `'${value}'`;
};

const genres = (values) => {
  if (!Array.isArray(values)) throw new Error('genres must be an array');
  if (values.length === 0) return `'{}'`;
  return `array[${values.map(text).join(', ')}]::text[]`;
};

const qidLiteral = (value) => {
  if (!/^Q\d+$/.test(value)) throw new Error(`not a Wikidata id: ${value}`);
  return `'${value}'`;
};

const main = async () => {
  const source = fileURLToPath(new URL('./catalogue.json', import.meta.url));
  const catalogue = JSON.parse(await readFile(source, 'utf8'));

  if (catalogue.source !== 'wikidata') {
    throw new Error(`unexpected source ${catalogue.source}: provenance below would be wrong`);
  }

  const lines = [];
  const say = (line = '') => lines.push(line);

  say('-- ===========================================================================');
  say('-- Seed catalogue');
  say('--');
  say('-- GENERATED FILE — do not edit. Written by supabase/seed/make-seed-migration.mjs');
  say(`-- from supabase/seed/catalogue.json, fetched ${catalogue.generated_at}.`);
  say('--');
  say('-- Nothing can enter media_items yet: the provider adapter does not exist, and the');
  say("-- licence question that governs it is unanswered. This is the way around both. The");
  say('-- rows are Wikidata, which is CC0 — no attribution obligation, no retention window,');
  say('-- and nothing that has to be renegotiated when a private test stops being private.');
  say('--');
  say('-- Two things are missing compared with a provider catalogue, both deliberate rather');
  say('-- than pending. There are no posters, because a poster is not a free work and');
  say('-- Wikidata has none to give; the client must therefore look right without one, which');
  say('-- is worth learning early rather than after artwork is assumed everywhere. And');
  say('-- popularity is null, because PRD §19 defines it as the provider\'s score and this is');
  say('-- not that — the ordering that chose these titles was sitelink count, which is a');
  say('-- proxy for "widely known" and is not the same measure.');
  say('--');
  say('-- Every row carries its tmdb_id, so when the licence is settled the adapter enriches');
  say('-- these rows in place rather than building a second catalogue beside them.');
  say('--');
  say(`-- ${catalogue.movies.length} films, ${catalogue.series.length} series, ${catalogue.seasons.length} seasons.`);
  say('-- ===========================================================================');
  say();
  say('-- Idempotent by conflict target, not by a guard: this migration runs once, but the');
  say('-- next refresh is another generated file over the same rows, and it must correct');
  say('-- them rather than fail or duplicate. fetched_at is left to its default so the');
  say('-- retention window measures when the row actually arrived.');
  say();

  /**
   * One statement per kind rather than one per row. A statement per row is a 1.2 MB
   * file and two thousand round trips through the harness on every test run, for the
   * same result. Postgres refuses a multi-row upsert whose rows collide with each other
   * on the conflict target, so the generator asserts uniqueness instead of hoping.
   */
  const unique = (items, key, what) => {
    const seen = new Set();
    for (const item of items) {
      const id = key(item);
      if (seen.has(id)) throw new Error(`two ${what} rows share ${id}; the upsert would refuse`);
      seen.add(id);
    }
  };

  const titles = (kind, items) => {
    unique(items, (item) => item.tmdb_id, kind);

    say(`-- ${kind === 'movie' ? 'Films' : 'Series'}`);
    say('insert into media_items (kind, tmdb_id, wikidata_qid, title, release_date,');
    say('                         runtime_minutes, original_language, genres, provenance)');
    say('values');
    say(
      items
        .map(
          (item) =>
            `  ('${kind}', ${number(item.tmdb_id)}, ${qidLiteral(item.wikidata_qid)}, ${text(item.title)},` +
            ` ${date(item.release_date)}, ${number(item.runtime_minutes)},` +
            ` ${item.original_language ? text(item.original_language) : 'null'}, ${genres(item.genres)}, 'wikidata')`,
        )
        .join(',\n'),
    );
    say(`on conflict (kind, tmdb_id) where kind in ('movie', 'series') do update`);
    say('  set wikidata_qid      = excluded.wikidata_qid,');
    say('      title             = excluded.title,');
    say('      release_date      = excluded.release_date,');
    say('      runtime_minutes   = excluded.runtime_minutes,');
    say('      original_language = excluded.original_language,');
    say('      genres            = excluded.genres,');
    say('      provenance        = excluded.provenance,');
    say('      fetched_at        = now();');
    say();
  };

  titles('movie', catalogue.movies);

  say('-- Series are watchlistable but never loggable or rankable (PRD §10): the season is');
  say('-- the unit, and "I watched this series" cannot say which seasons.');
  titles('series', catalogue.series);

  unique(catalogue.seasons, (season) => `${season.parent_qid}:${season.season_number}`, 'season');

  say('-- Seasons. The parent is joined by its Wikidata id rather than named by a literal');
  say('-- uuid, because ids are generated at insert time and a refresh has to land on the');
  say('-- same row. A season whose parent is absent contributes nothing rather than failing:');
  say('-- the join drops it.');
  say('insert into media_items (kind, parent_id, season_number, title, release_date, provenance)');
  say("select 'season', parent.id, seed.season_number, seed.title, seed.release_date, 'wikidata'");
  say('  from (values');
  say(
    catalogue.seasons
      .map(
        (season) =>
          `    (${qidLiteral(season.parent_qid)}, ${number(season.season_number)},` +
          ` ${text(season.title)}, ${date(season.release_date)}::date)`,
      )
      .join(',\n'),
  );
  say('  ) as seed (parent_qid, season_number, title, release_date)');
  say('  join media_items parent');
  say("    on parent.wikidata_qid = seed.parent_qid and parent.kind = 'series'");
  say(`on conflict (parent_id, season_number) where kind = 'season' do update`);
  say('  set title        = excluded.title,');
  say('      release_date = excluded.release_date,');
  say('      provenance   = excluded.provenance,');
  say('      fetched_at   = now();');

  const path = fileURLToPath(new URL(`../migrations/${MIGRATION}`, import.meta.url));
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');

  const rows = catalogue.movies.length + catalogue.series.length + catalogue.seasons.length;
  process.stdout.write(`${rows} rows → supabase/migrations/${MIGRATION}\n`);
};

await main();
