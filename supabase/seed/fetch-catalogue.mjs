/**
 * Builds the seed catalogue from Wikidata and writes catalogue.json.
 *
 * Run by hand, never in CI: the output is committed, so a test run does not depend on a
 * third-party endpoint being up, and the dataset a tester sees is the reviewed one
 * rather than whatever Wikidata answered that morning.
 *
 *   node supabase/seed/fetch-catalogue.mjs
 *
 * Why Wikidata rather than TMDB. TMDB's terms turn anything beyond personal use into a
 * commercial licence question, and that question is unanswered while a catalogue is
 * needed for testing now. Wikidata is CC0: no attribution obligation, no retention
 * window, nothing to renegotiate when a private test stops being private. The trade is
 * thinner metadata and no posters, because posters are not free works and Wikidata has
 * none to give. It does carry TMDB ids, so once the licence is settled the adapter
 * enriches these rows in place through `tmdb_id` rather than building a second
 * catalogue beside them.
 *
 * Sitelink count is the ordering: a proxy for "widely known", which is what a seed
 * catalogue needs, since a tester searching for something should find it. It is
 * deliberately not written to `popularity`, which PRD §19 defines as the provider's
 * score, and this is not that.
 *
 * The query shape is dictated by the public endpoint. A single query joining films,
 * their TMDB ids and half a dozen OPTIONALs is answered with a 504, so this asks for a
 * candidate list first — cheap, because it selects two variables and nothing else — and
 * then fills in details in batches restricted by VALUES, which are fast. Requests are
 * paced, because the endpoint answers a burst with 429.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://query.wikidata.org/sparql';

// Wikidata asks for a descriptive agent with a contact, and throttles hard without one.
const HEADERS = {
  Accept: 'application/sparql-results+json',
  'User-Agent': 'BingdSeedBuilder/0.1 (https://bingd.app; hello@bingd.app)',
};

/**
 * A floor on how widely a title is documented, and the only knob that decides the size
 * of the catalogue. 60 yields a few hundred films whose tail is still recognisable;
 * lower thresholds fill it with single-territory releases that make a search result
 * list look like noise. Series get a lower floor because there are far fewer of them.
 */
const MIN_SITELINKS = { movie: 60, series: 40 };

const BATCH = 100;
const PACE_MS = 9000;

let lastRequest = 0;

/**
 * `format` is the wire format, not a detail: a JSON response is six times the size of
 * the same result set as CSV, and a large one comes back truncated often enough to be
 * worth avoiding — a body cut at exactly 64 kB, with a 200 and no error. Every request
 * is therefore checked for completeness by its parser, and a failure is retried like
 * any other transport fault.
 */
const request = async (query, format) => {
  for (let attempt = 1; ; attempt += 1) {
    const wait = Math.max(0, lastRequest + PACE_MS - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequest = Date.now();

    try {
      const url = `${ENDPOINT}?query=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          ...HEADERS,
          Accept: format === 'csv' ? 'text/csv' : 'application/sparql-results+json',
        },
      });

      const body = await response.text();
      if (response.ok) {
        return format === 'csv' ? parseCsv(body) : JSON.parse(body).results.bindings;
      }
      if (attempt === 5) {
        throw new Error(`Wikidata answered ${response.status}: ${body.slice(0, 200)}`);
      }
    } catch (error) {
      if (attempt === 5) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 8000));
  }
};

const sparql = (query) => request(query, 'json');

/**
 * Only ever asked to read two columns of URIs and integers, neither of which can
 * contain a comma or a quote, so this stays a split rather than growing into a CSV
 * parser. A row that does not look like that is dropped, and a truncated body loses its
 * final line rather than yielding half a value.
 */
const parseCsv = (body) => {
  const [header, ...lines] = body.trim().split(/\r?\n/);
  if (!header) throw new Error('empty response');

  const columns = header.split(',');
  return lines
    .map((line) => line.split(','))
    .filter((cells) => cells.length === columns.length)
    .map((cells) => Object.fromEntries(columns.map((name, i) => [name, cells[i]])));
};

const qid = (uri) => uri.split('/').pop();

const batches = (items) => {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
};

const values = (qids) => qids.map((q) => `wd:${q}`).join(' ');

/** Wikidata dates arrive as full timestamps, and many are precise only to a year. */
const isoDate = (value) => {
  if (!value) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !day.includes('-00') ? day : null;
};

/**
 * Wikidata's language values are English names; the column holds an ISO 639-1 code,
 * because that is what a provider returns and what the client formats. Anything
 * unmapped stays null rather than being guessed at.
 */
const LANGUAGE_CODES = {
  English: 'en',
  Japanese: 'ja',
  French: 'fr',
  Spanish: 'es',
  German: 'de',
  Italian: 'it',
  Korean: 'ko',
  'Mandarin Chinese': 'zh',
  Cantonese: 'zh',
  Chinese: 'zh',
  Russian: 'ru',
  Hindi: 'hi',
  Portuguese: 'pt',
  'Brazilian Portuguese': 'pt',
  Swedish: 'sv',
  Danish: 'da',
  Norwegian: 'no',
  'Norwegian Bokmål': 'no',
  Dutch: 'nl',
  Polish: 'pl',
  Turkish: 'tr',
  Arabic: 'ar',
  Hebrew: 'he',
  Persian: 'fa',
  Thai: 'th',
  Czech: 'cs',
  Hungarian: 'hu',
  Greek: 'el',
  Finnish: 'fi',
  Romanian: 'ro',
  Ukrainian: 'uk',
  Tamil: 'ta',
  Telugu: 'te',
  'American English': 'en',
  'British English': 'en',
  'Latin American Spanish': 'es',
};

const candidates = async (classQid, minSitelinks) => {
  const rows = await request(
    `
    SELECT ?item ?sitelinks WHERE {
      ?item wdt:P31 wd:${classQid} ;
            wikibase:sitelinks ?sitelinks .
      FILTER(?sitelinks >= ${minSitelinks})
    }
    LIMIT 5000
  `,
    'csv',
  );

  return rows
    .map((row) => ({ qid: qid(row.item), sitelinks: Number(row.sitelinks) }))
    .filter((row) => /^Q\d+$/.test(row.qid) && Number.isInteger(row.sitelinks))
    .sort((a, b) => b.sitelinks - a.sitelinks);
};

/**
 * One row per (date × runtime × language) combination, because Wikidata records a
 * release date per country and a runtime per cut. Collapsing to the earliest date and
 * the shortest runtime picks the original release and the theatrical cut often enough,
 * and always gives one answer rather than an arbitrary one.
 */
const details = async (items, tmdbProperty, startProperty) => {
  const byQid = new Map(items.map((item) => [item.qid, item]));

  for (const batch of batches([...byQid.keys()])) {
    const rows = await sparql(`
      SELECT ?item ?itemLabel ?tmdb ?date ?runtime ?languageLabel WHERE {
        VALUES ?item { ${values(batch)} }
        OPTIONAL { ?item wdt:${tmdbProperty} ?tmdb }
        OPTIONAL { ?item wdt:${startProperty} ?date }
        OPTIONAL { ?item wdt:P2047 ?runtime }
        OPTIONAL { ?item wdt:P364 ?language }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
    `);

    for (const row of rows) {
      const item = byQid.get(qid(row.item.value));
      if (!item) continue;

      const label = row.itemLabel.value;
      // A label that is still a Q-number means there is no English one, and a title
      // nobody can read is worse than a slightly smaller catalogue.
      if (/^Q\d+$/.test(label)) continue;

      const date = isoDate(row.date?.value);
      const runtime = row.runtime ? Math.round(Number(row.runtime.value)) : null;

      item.title ??= label;
      item.tmdb_id ??= row.tmdb ? Number(row.tmdb.value) : null;
      item.original_language ??= LANGUAGE_CODES[row.languageLabel?.value] ?? null;
      if (date && (!item.release_date || date < item.release_date)) item.release_date = date;
      if (runtime && (!item.runtime_minutes || runtime < item.runtime_minutes)) {
        item.runtime_minutes = runtime;
      }
    }
  }

  return items.filter((item) => item.title);
};

const attachGenres = async (items) => {
  const byQid = new Map(items.map((item) => [item.qid, item]));
  for (const item of items) item.genres = [];

  for (const batch of batches([...byQid.keys()])) {
    const rows = await sparql(`
      SELECT ?item ?genreLabel WHERE {
        VALUES ?item { ${values(batch)} }
        ?item wdt:P136 ?genre .
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
    `);

    for (const row of rows) {
      const item = byQid.get(qid(row.item.value));
      const genre = row.genreLabel.value;
      if (!item || /^Q\d+$/.test(genre) || item.genres.includes(genre)) continue;
      item.genres.push(genre);
    }
  }

  for (const item of items) item.genres.sort();
};

/**
 * The season number lives on the series' "has part" statement as a qualifier, not as a
 * claim on the season itself. The tempting shape — the season's own "part of the series"
 * with a `P1545` claim — returns *episode* numbers, so Breaking Bad comes back with a
 * season 62. Reading the ordinal from the qualifier is what makes the numbers real, and
 * the number matters: it is half the identity of a season row.
 */
const seasonsOf = async (series) => {
  const seasons = new Map();

  for (const batch of batches(series.map((item) => item.qid))) {
    const rows = await sparql(`
      SELECT ?series ?season ?ordinal ?date WHERE {
        VALUES ?series { ${values(batch)} }
        ?series p:P527 ?statement .
        ?statement ps:P527 ?season ;
                   pq:P1545 ?ordinal .
        ?season wdt:P31 wd:Q3464665 .
        OPTIONAL { ?season wdt:P580 ?date }
      }
    `);

    for (const row of rows) {
      const parent = qid(row.series.value);
      const number = Number(row.ordinal.value);
      if (!Number.isInteger(number) || number < 1 || number > 100) continue;

      const key = `${parent}:${number}`;
      const date = isoDate(row.date?.value);
      const existing = seasons.get(key);

      if (!existing) {
        // Titled by number rather than by Wikidata's label, which is "Breaking Bad,
        // season 1" — the series name is already beside it wherever a season appears.
        seasons.set(key, {
          parent_qid: parent,
          season_number: number,
          title: `Season ${number}`,
          release_date: date,
        });
      } else if (date && (!existing.release_date || date < existing.release_date)) {
        existing.release_date = date;
      }
    }
  }

  return [...seasons.values()];
};

const say = (message) => process.stdout.write(`${message}\n`);

const main = async () => {
  say('film candidates…');
  const filmCandidates = await candidates('Q11424', MIN_SITELINKS.movie);
  say(`  ${filmCandidates.length}`);

  say('series candidates…');
  const seriesCandidates = await candidates('Q5398426', MIN_SITELINKS.series);
  say(`  ${seriesCandidates.length}`);

  say('film details…');
  const films = await details(filmCandidates, 'P4947', 'P577');
  say(`  ${films.length}`);

  say('series details…');
  const series = await details(seriesCandidates, 'P4983', 'P580');
  say(`  ${series.length}`);

  say('genres…');
  await attachGenres([...films, ...series]);

  say('seasons…');
  const seasons = await seasonsOf(series);
  say(`  ${seasons.length}`);

  // Only series that actually brought seasons. PRD §10 makes the season the rankable
  // unit, so a seasonless series is a dead end in the one loop being tested.
  const withSeasons = new Set(seasons.map((season) => season.parent_qid));
  const keptSeries = series.filter((item) => withSeasons.has(item.qid));

  const shape = (item, kind) => ({
    kind,
    wikidata_qid: item.qid,
    tmdb_id: item.tmdb_id ?? null,
    title: item.title,
    release_date: item.release_date ?? null,
    runtime_minutes: kind === 'movie' ? (item.runtime_minutes ?? null) : null,
    original_language: item.original_language ?? null,
    genres: item.genres ?? [],
  });

  const byTitle = (a, b) => a.title.localeCompare(b.title);

  const catalogue = {
    source: 'wikidata',
    license: 'CC0-1.0',
    generated_at: new Date().toISOString().slice(0, 10),
    query: { min_sitelinks: MIN_SITELINKS },
    movies: films.map((item) => shape(item, 'movie')).sort(byTitle),
    series: keptSeries.map((item) => shape(item, 'series')).sort(byTitle),
    seasons: seasons.sort((a, b) =>
      a.parent_qid === b.parent_qid
        ? a.season_number - b.season_number
        : a.parent_qid.localeCompare(b.parent_qid),
    ),
  };

  const path = fileURLToPath(new URL('./catalogue.json', import.meta.url));
  await writeFile(path, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');

  say(
    `\n${catalogue.movies.length} films, ${catalogue.series.length} series, ` +
      `${catalogue.seasons.length} seasons → supabase/seed/catalogue.json`,
  );
};

await main();
