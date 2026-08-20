/**
 * Genre Gremlin difficulty, measured rather than felt.
 *
 * The threshold note in `src/features/awards/tracks.ts` carried a table of "median
 * units to reach N distinct genres" that nothing reproduced, and the founder's Preview
 * brief carried a *different* table for the same quantity. Two irreconcilable numbers
 * for the thing the ladder rests on is the reason this script exists: it reads the
 * seeded catalogue, applies the canonical vocabulary, and reports the distribution.
 *
 * Run:
 *
 *   node scripts/awards/genre-ladder-report.mjs [--samples 20000] [--json]
 *   node --test scripts/awards/genre-ladder-report.test.mjs
 *
 * **Deliberately not `npm run` aliases.** `package.json`'s `scripts` block is one of the
 * inputs to the Expo runtime fingerprint (`packageJson:scripts`), so two lines of developer
 * convenience there move `runtimeVersion` and turn a JS-only change into one that cannot be
 * delivered over the air without a new native build. Measured rather than assumed: adding
 * them took the Android fingerprint from `59acd123` to `c8ae7689`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SEED = join(ROOT, 'supabase', 'migrations', '20260814001131_seed_catalogue.sql');

// ---------------------------------------------------------------------------
// The vocabulary. Held identical to `src/features/awards/genres.ts` by the test in
// `scripts/awards/genre-ladder-report.test.mjs`, which reads both and compares — a
// second copy of the patterns is only safe if something fails when they drift.
// ---------------------------------------------------------------------------
export const CANONICAL_GENRES = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama',
  'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance',
  'Science Fiction', 'Thriller', 'War', 'Western',
];

const PATTERNS = {
  Action: /\baction\b/,
  Adventure: /\badventure\b/,
  Animation: /\banimat(ed|ion)\b|\banime\b|\bcartoon\b/,
  Comedy: /\bcomed(y|ies|ic)\b/,
  Crime: /\bcrime\b|\bheist\b|\bgangster\b/,
  Documentary: /\bdocumentar/,
  Drama: /\bdrama\b|\bmelodrama\b/,
  Family: /\bfamily\b|\bchildren'?s\b/,
  Fantasy: /\bfantas(y|tique)\b|\bsword and sorcery\b/,
  History: /\bhistor(y|ical)\b|\bperiod (piece|drama)\b|\bbiographical\b/,
  Horror: /\bhorror\b|\bslasher\b/,
  Music: /\bmusic(al)?\b|\bconcert film\b/,
  Mystery: /\bmyster(y|ies)\b|\bdetective\b|\bwhodunn?it\b/,
  Romance: /\bromance\b|\bromantic\b/,
  'Science Fiction': /\bscience fiction\b|\bsci-?fi\b|\bdystopian\b|\bpost-apocalyptic\b|\bspace opera\b/,
  Thriller: /\bthriller\b|\bsuspense\b|\bneo-noir\b|\bfilm noir\b/,
  War: /\bwar\b|\bmilitary\b/,
  Western: /\bwestern\b/,
};

export function canonicalGenres(labels) {
  const found = new Set();
  for (const raw of labels ?? []) {
    const label = String(raw ?? '').toLowerCase();
    if (!label) continue;
    for (const genre of CANONICAL_GENRES) if (PATTERNS[genre].test(label)) found.add(genre);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The catalogue, out of the seed migration
// ---------------------------------------------------------------------------

/** `array[$seed$a$seed$, $seed$b$seed$]::text[]` -> ['a','b'] */
function genresIn(row) {
  const arrayLiteral = row.match(/array\[(.*?)\]::text\[\]/s);
  if (!arrayLiteral) return [];
  return [...arrayLiteral[1].matchAll(/\$seed\$(.*?)\$seed\$/gs)].map((m) => m[1]);
}

const qidIn = (row) => (row.match(/'(Q\d+)'/) ?? [])[1] ?? null;

export function readCatalogue(sql = readFileSync(SEED, 'utf8')) {
  const movies = [];
  const series = new Map(); // qid -> raw labels
  const seasons = []; // parent qid, one entry per season row
  let block = 'movies';
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '-- Series') { block = 'series'; continue; }
    if (/^-- Seasons\b/.test(trimmed)) { block = 'seasons'; continue; }
    if (block === 'movies' && trimmed.startsWith("('movie',")) movies.push(genresIn(trimmed));
    if (block === 'series' && trimmed.startsWith("('series',")) {
      const qid = qidIn(trimmed);
      if (qid) series.set(qid, genresIn(trimmed));
    }
    if (block === 'seasons' && /^\('Q\d+', \d+,/.test(trimmed)) {
      seasons.push(trimmed.match(/^\('(Q\d+)'/)[1]);
    }
  }
  // A loggable unit is a movie or a season: `_assert_loggable` refuses a series, and
  // PRD §10 makes the season the unit. A season inherits its series' genres, resolved
  // at read time by `src/lib/media-metadata.ts`.
  const units = [
    ...movies.map((labels) => ({ kind: 'movie', genres: canonicalGenres(labels) })),
    ...seasons.map((parent) => ({ kind: 'season', genres: canonicalGenres(series.get(parent) ?? []) })),
  ];
  return { units, movieCount: movies.length, seriesCount: series.size, seasonCount: seasons.length };
}

// ---------------------------------------------------------------------------
// Acquisition simulation
// ---------------------------------------------------------------------------

/** Deterministic PRNG, so a report is a report and not a different number each run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One reader's run: log units in a random order until every target is reached.
 *
 * Two models, and **neither is a bound on real difficulty**. The labels here used to
 * claim one was, and independent review was right to reject it.
 *
 * **Uniform** draws without replacement from the loggable catalogue: every title equally
 * likely, no preferences at all.
 *
 * **Taste-weighted** gives each reader a genre preference vector and weights a title by
 * the *mean* liking across its genres, so a reader over-logs what appeals to them.
 *
 * The intuition was that taste-weighting would be the slower, more realistic model —
 * somebody who dislikes documentaries would not stumble into one. **It measures slightly
 * faster instead**, and the reason is worth recording rather than papering over: on this
 * catalogue Documentary is 6 rows of 1,814 and Animation is 10, so **scarcity dominates
 * preference**. Disliking documentaries costs almost nothing when there is almost nothing
 * to dislike, while the preference measurably speeds up the first fourteen genres, which
 * are plentiful in every direction. The net is a shorter median and a longer p90 at 18.
 *
 * So the ladder is set against the **uniform** column, which is the slower of the two at
 * **every median** — and the median is the comparison the thresholds were chosen on.
 *
 * That is the whole claim, deliberately. Uniform is not slower everywhere: at 18 genres
 * the taste-weighted p90 runs *longer* (around 675 against 615), because the reader who
 * dislikes the tail is the one who waits longest for it, and at 10 genres the two p10s are
 * simply equal. Three review rounds were spent narrowing this one sentence, which is the
 * argument for claiming only what the numbers carry.
 *
 * The caveat that genuinely matters is stated where the thresholds are: a real reader also
 * logs titles this catalogue does not contain, and `media_items` grows as the TMDB adapter
 * caches what people search for. That is unmodelled and points toward the tail being
 * easier in production than these numbers say — a direction, not a guarantee. Nothing here
 * bounds real difficulty in either direction; the beta is what settles it.
 */
function runOnce(units, random, targets, { taste = false } = {}) {
  let order;
  if (!taste) {
    order = [...units.keys()];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  } else {
    /**
     * A preference per genre, and a title's weight is the **mean** liking across its
     * genres.
     *
     * **The mean, not the maximum, and independent review is why.** The first draft took
     * the best-liked genre, which quietly made this the *optimistic* model rather than the
     * pessimistic one it was labelled: a title tagged with four genres gets four chances at
     * a high draw, so `max` rewards breadth per title, and the whole simulation then
     * accelerated toward the broad titles that make distinct genres easy. It reported
     * acquisition **faster** than uniform while claiming to be slower. The mean has no such
     * bias — a title is as appealing as its genres are, on average — so what remains is the
     * effect being modelled: a reader over-logs the genres they like, and the ones they do
     * not come last.
     *
     * The floor is deliberately low. A reader with no interest in Documentary should
     * almost never log one by accident, because "almost never" is what makes the tail
     * genuinely a tail.
     */
    const liking = new Map(CANONICAL_GENRES.map((g) => [g, 0.05 + random() ** 2 * 0.95]));
    order = [...units.keys()]
      .map((index) => {
        const unit = units[index];
        let sum = 0;
        for (const genre of unit.genres) sum += liking.get(genre);
        const weight = unit.genres.size > 0 ? sum / unit.genres.size : 0.05;
        // Exponential race: sorting by -log(u)/w draws without replacement in
        // proportion to w, which is what "this reader mostly logs what they like" is.
        return { index, key: -Math.log(random()) / weight };
      })
      .sort((a, b) => a.key - b.key)
      .map((entry) => entry.index);
  }

  const seen = new Set();
  const reachedAt = new Map();
  let logged = 0;
  for (const index of order) {
    logged += 1;
    const unit = units[index];
    if (unit.genres.size === 0) continue;
    let grew = false;
    for (const genre of unit.genres) if (!seen.has(genre)) { seen.add(genre); grew = true; }
    if (!grew) continue;
    for (const target of targets) {
      if (seen.size >= target && !reachedAt.has(target)) reachedAt.set(target, logged);
    }
    if (targets.every((t) => reachedAt.has(t))) break;
  }
  return reachedAt;
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
};

export function simulate(units, options = {}) {
  const {
    samples = 20000,
    targets = [10, 11, 12, 13, 14, 15, 16, 17, 18],
    seed = 20260820,
    taste = false,
  } = options;
  const random = mulberry32(seed);
  const runs = new Map(targets.map((t) => [t, []]));
  const unreachable = new Map(targets.map((t) => [t, 0]));
  for (let s = 0; s < samples; s += 1) {
    const reached = runOnce(units, random, targets, { taste });
    for (const t of targets) {
      const at = reached.get(t);
      if (at == null) unreachable.set(t, unreachable.get(t) + 1);
      else runs.get(t).push(at);
    }
  }
  return targets.map((t) => {
    const sorted = runs.get(t).sort((a, b) => a - b);
    return {
      genres: t,
      p10: quantile(sorted, 0.1),
      median: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      unreachablePct: (unreachable.get(t) / samples) * 100,
    };
  });
}

// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const samples = Number(argv[argv.indexOf('--samples') + 1]) || 20000;
  const { units, movieCount, seriesCount, seasonCount } = readCatalogue();
  const countable = units.filter((u) => u.genres.size > 0);
  const perGenre = new Map(CANONICAL_GENRES.map((g) => [g, 0]));
  let genreSum = 0;
  for (const unit of countable) {
    genreSum += unit.genres.size;
    for (const g of unit.genres) perGenre.set(g, perGenre.get(g) + 1);
  }

  const uniform = simulate(units, { samples });
  const taste = simulate(units, { samples, taste: true });

  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      catalogue: { movieCount, seriesCount, seasonCount, units: units.length, countable: countable.length },
      meanGenresPerCountableUnit: Number((genreSum / countable.length).toFixed(3)),
      perGenre: Object.fromEntries(perGenre),
      uniform,
      taste,
    }, null, 2));
    return;
  }

  console.log(`Catalogue: ${movieCount} movies + ${seasonCount} seasons (from ${seriesCount} series) = ${units.length} loggable units`);
  console.log(`Carrying at least one canonical genre: ${countable.length}`);
  console.log(`Mean canonical genres per countable unit: ${(genreSum / countable.length).toFixed(2)}\n`);
  console.log('Per-genre unit counts (the tail is what the top tier rests on):');
  for (const [genre, n] of [...perGenre.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${genre.padEnd(16)} ${String(n).padStart(5)}`);
  }
  const table = (label, rows) => {
    console.log(`\n${label} (${samples.toLocaleString('en')} simulated readers):\n`);
    console.log('  genres    p10   median     p90   never');
    for (const row of rows) {
      console.log(
        `  ${String(row.genres).padStart(6)} ${String(row.p10 ?? '-').padStart(6)} ${String(row.median ?? '-').padStart(8)} ${String(row.p90 ?? '-').padStart(7)}   ${row.unreachablePct.toFixed(1)}%`,
      );
    }
  };
  table('Logged units to reach N distinct genres — uniform reader', uniform);
  table('Logged units to reach N distinct genres — taste-weighted reader', taste);
  console.log(
    '\nThresholds are set against the uniform column: it is the slower of the two at every\n' +
      'MEDIAN, which is what they were chosen on. It is not slower everywhere: at 18\n' +
      'genres the taste-weighted p90 runs longer, and at 10 genres the two p10s are equal.\n' +
      'Neither model bounds real difficulty; see the note on runOnce for why taste-\n' +
      'weighting comes out faster at the median rather than slower.',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
