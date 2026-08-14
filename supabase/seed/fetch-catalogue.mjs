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
    let retryAfter = 0;
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
      // A 429 usually says how long to wait, and guessing shorter just earns another one.
      retryAfter = Number(response.headers.get('retry-after')) * 1000 || 0;
    } catch (error) {
      if (attempt === 5) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfter, attempt * 8000)));
  }
};

const sparql = (query) => request(query, 'json');

/**
 * Only ever asked to read two columns of URIs and integers, neither of which can contain
 * a comma or a quote, so this stays a split rather than growing into a CSV parser.
 *
 * A malformed line *raises*. It would be easier to drop it, and that is what this did at
 * first — which quietly defeated the retry above: a body cut mid-line loses that line and
 * every line after it, and returning a short list with no error is how a refresh would
 * have produced a smaller catalogue with nothing to show that anything went wrong.
 */
const parseCsv = (body) => {
  const [header, ...lines] = body.trim().split(/\r?\n/);
  if (!header) throw new Error('empty response');

  const columns = header.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    if (cells.length !== columns.length) {
      throw new Error(`truncated or malformed row: ${line.slice(0, 80)}`);
    }
    return Object.fromEntries(columns.map((name, i) => [name, cells[i]]));
  });
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

const CANDIDATE_LIMIT = 5000;

const candidates = async (classQid, minSitelinks) => {
  const rows = await request(
    `
    SELECT ?item ?sitelinks WHERE {
      ?item wdt:P31 wd:${classQid} ;
            wikibase:sitelinks ?sitelinks .
      FILTER(?sitelinks >= ${minSitelinks})
    }
    ORDER BY DESC(?sitelinks)
    LIMIT ${CANDIDATE_LIMIT}
  `,
    'csv',
  );

  // Hitting the limit means the answer was cut, and an unordered cut is an arbitrary
  // sample rather than the top of the list. Lowering MIN_SITELINKS is the likely way to
  // get here, so it fails rather than quietly reshaping the catalogue.
  if (rows.length >= CANDIDATE_LIMIT) {
    throw new Error(
      `${classQid}: ${rows.length} candidates hit the limit; raise MIN_SITELINKS or page the query`,
    );
  }

  return rows
    .map((row) => ({ qid: qid(row.item), sitelinks: Number(row.sitelinks) }))
    .filter((row) => /^Q\d+$/.test(row.qid) && Number.isInteger(row.sitelinks))
    .sort((a, b) => b.sitelinks - a.sitelinks);
};

/** Wikidata's duration units. Anything else is refused rather than assumed. */
const UNIT_TO_MINUTES = {
  Q7727: 1, // minute
  Q11574: 1 / 60, // second
  Q25235: 60, // hour
};

/**
 * Runtime in whole minutes, or null.
 *
 * The unit is not decoration. `P2047` is a quantity *with* a unit, and some items record
 * it in seconds — Oppenheimer is stored as 10809, which read as a bare number shipped a
 * three-hour film as a seven-day one. Taking the shortest of several values does not save
 * you either: it only helps when a correct value in minutes is also present.
 *
 * An unrecognised unit yields null, and so does anything outside a plausible range. A
 * missing runtime is a gap; a wrong one is on the screen.
 */
const runtimeMinutes = (amount, unitUri) => {
  const factor = UNIT_TO_MINUTES[qid(unitUri ?? '')];
  if (!factor || !Number.isFinite(Number(amount))) return null;

  const minutes = Math.round(Number(amount) * factor);
  return minutes >= 1 && minutes <= 600 ? minutes : null;
};

/**
 * A date, only if Wikidata knows the actual day.
 *
 * `wikibase:timePrecision` is 11 for a day, 10 for a month, 9 for a year — and a
 * year-precision value is *rendered* as 1 January, indistinguishable from a real one
 * unless the precision is asked for. Without this check, 86 titles claimed a 1 January
 * release, and taking the earliest value made it worse: an item with both a year and a
 * real date resolved to 1 January of that year. Once Upon a Time in the West came out in
 * December 1968 and the catalogue said January.
 */
const preciseDate = (value, precision) =>
  Number(precision) >= 11 ? isoDate(value) : null;

/**
 * One row per (date × runtime × language) combination, because Wikidata records a release
 * date per country, a runtime per cut, and a language per language spoken. Every value is
 * therefore collected first and reduced afterwards — the earlier version took whichever
 * row happened to arrive first for language, which is how Inception came to be a French
 * film and The Godfather an Italian one.
 */
const details = async (items, tmdbProperty, startProperty) => {
  const byQid = new Map(items.map((item) => [item.qid, item]));
  for (const item of items) {
    item.dates = new Set();
    item.runtimes = new Set();
    item.languages = new Set();
  }

  for (const batch of batches([...byQid.keys()])) {
    const rows = await sparql(`
      SELECT ?item ?itemLabel ?tmdb ?date ?datePrecision ?runtime ?runtimeUnit ?languageLabel WHERE {
        VALUES ?item { ${values(batch)} }
        OPTIONAL { ?item wdt:${tmdbProperty} ?tmdb }
        OPTIONAL {
          ?item p:${startProperty}/psv:${startProperty} ?dateValue .
          ?dateValue wikibase:timeValue ?date ;
                     wikibase:timePrecision ?datePrecision .
        }
        OPTIONAL {
          ?item p:P2047/psv:P2047 ?runtimeValue .
          ?runtimeValue wikibase:quantityAmount ?runtime ;
                        wikibase:quantityUnit ?runtimeUnit .
        }
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

      item.title ??= label;
      item.tmdb_id ??= row.tmdb ? Number(row.tmdb.value) : null;

      const date = preciseDate(row.date?.value, row.datePrecision?.value);
      if (date) item.dates.add(date);

      const runtime = runtimeMinutes(row.runtime?.value, row.runtimeUnit?.value);
      if (runtime) item.runtimes.add(runtime);

      if (row.languageLabel) item.languages.add(row.languageLabel.value);
    }
  }

  for (const item of items) {
    // Earliest release and shortest runtime: the original release and, usually, the
    // theatrical cut. Both are choices between real values rather than between a real
    // value and an artefact, which is the part that had to be fixed.
    item.release_date = [...item.dates].sort()[0] ?? null;
    item.runtime_minutes = item.runtimes.size ? Math.min(...item.runtimes) : null;

    // One language means one answer. Several means Wikidata is recording every language
    // spoken in the film, which does not identify the original — Inception lists English,
    // French, Japanese and Swahili — so the honest value is none.
    item.original_language =
      item.languages.size === 1 ? (LANGUAGE_CODES[[...item.languages][0]] ?? null) : null;

    delete item.dates;
    delete item.runtimes;
    delete item.languages;
  }

  // A movie or series with no TMDB id cannot be enriched later and cannot collide on the
  // conflict target that makes a refresh idempotent, so it is not worth carrying.
  return items.filter((item) => item.title && Number.isInteger(item.tmdb_id));
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
      SELECT ?series ?season ?ordinal ?date ?datePrecision WHERE {
        VALUES ?series { ${values(batch)} }
        ?series p:P527 ?statement .
        ?statement ps:P527 ?season ;
                   pq:P1545 ?ordinal .
        ?season wdt:P31 wd:Q3464665 .
        OPTIONAL {
          ?season p:P580/psv:P580 ?dateValue .
          ?dateValue wikibase:timeValue ?date ;
                     wikibase:timePrecision ?datePrecision .
        }
      }
    `);

    for (const row of rows) {
      const parent = qid(row.series.value);
      const number = Number(row.ordinal.value);
      if (!Number.isInteger(number) || number < 1 || number > 100) continue;

      const key = `${parent}:${number}`;
      const date = preciseDate(row.date?.value, row.datePrecision?.value);
      const existing = seasons.get(key);

      if (!existing) {
        // The season's own Wikidata id is kept, and it is the point of this being a
        // bridge rather than a throwaway: without it a season row is identified only by
        // its parent and its number, so a provider could never match it directly. Seasons
        // are the rankable TV unit under PRD §10, which makes it most of the television
        // half of the product.
        //
        // Titled by number rather than by Wikidata's label, which is "Breaking Bad,
        // season 1" — the series name is already beside it wherever a season appears.
        seasons.set(key, {
          parent_qid: parent,
          wikidata_qid: qid(row.season.value),
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

  const kept = new Set(keptSeries.map((item) => item.qid));

  const catalogue = {
    source: 'wikidata',
    license: 'CC0-1.0',
    generated_at: new Date().toISOString().slice(0, 10),
    query: { min_sitelinks: MIN_SITELINKS },
    movies: films.map((item) => shape(item, 'movie')).sort(byTitle),
    series: keptSeries.map((item) => shape(item, 'series')).sort(byTitle),
    // A season whose series was dropped would name a parent that is not in the file, and
    // the migration's join would silently discard it. Dropping it here instead keeps the
    // dataset self-describing: everything in it is something the migration will insert.
    seasons: seasons
      .filter((season) => kept.has(season.parent_qid))
      .sort((a, b) =>
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
