/**
 * Synthetic Letterboxd exports at any size, for the Collection scale gate.
 *
 * ---------------------------------------------------------------------------
 * GENERATED, NOT AUTHORED, AND NOT A REAL LIBRARY
 *
 * The scale question — how large a library the Collection reader can actually serve — needs
 * exports at 2,500, 5,000 and 10,000 titles. Hand-building those is not work anybody should
 * do, and borrowing a real one is worse than useless for this particular job: a real
 * library's match rate is unknown, so a slow run could be the reader or could be two
 * thousand provider lookups, and the measurement would not say which.
 *
 * A generated export has a **known expected match rate**, because it is built from titles
 * whose presence in the catalogue is a fact rather than a hope. That is what makes a
 * timing number mean something.
 *
 * A real power-user export is still worth having, for exactly one thing this cannot give:
 * the true match rate against a real long tail. That is a different measurement and it is
 * not this one.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY REPRODUCES
 *
 * The shapes that cost something at scale, in the proportions the real export suggests:
 * every row rated (the founder's is), roughly one film in twenty carrying diary entries,
 * a scatter of rewatches, and a watchlist that is a small fraction of the whole. Plus a
 * fixed sprinkle of the awkward titles — a comma, an accent, a colon, a year inside the
 * name — so a large run still exercises the parser rather than only the row count.
 *
 * It is **not** a fidelity exercise. Nothing here should be used to argue about match
 * rates, bucket distributions or user behaviour; it exists to make the reader do work.
 */

export type GeneratedExport = {
  readonly 'watched.csv': string;
  readonly 'ratings.csv': string;
  readonly 'diary.csv': string;
  readonly 'watchlist.csv': string;
};

export type GenerateOptions = {
  /** How many watched titles. The watchlist is sized from this. */
  readonly titles: number;
  /** Deterministic, so two runs of the gate measure the same archive. */
  readonly seed?: number;
  /** Fraction of titles that carry at least one diary entry. */
  readonly diaryRate?: number;
  /** Fraction of titles added to the watchlist, none of them watched. */
  readonly watchlistRate?: number;
};

/**
 * A small deterministic generator — mulberry32.
 *
 * `Math.random()` would make every run of the scale gate a different archive, and a
 * measurement you cannot repeat is not a measurement. Seeded, so a regression can be
 * reproduced against the exact bytes that produced it.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The five awkward shapes, kept in every fixture however large. */
const AWKWARD = [
  'Crouching Tiger, Hidden Dragon',
  'Joker: Folie à Deux',
  'Blade Runner 2049',
  "Ocean's Eleven",
  '万引き家族',
] as const;

const WORDS_A = ['Silent', 'Crimson', 'Northern', 'Broken', 'Golden', 'Hollow', 'Distant', 'Electric'];
const WORDS_B = ['River', 'Signal', 'Harvest', 'Lantern', 'Orbit', 'Anthem', 'Winter', 'Machine'];

/** A Letterboxd rating: 0.5 to 5.0 in half steps, skewed high the way real libraries are. */
const STARS = [1, 1.5, 2, 2.5, 3, 3, 3.5, 3.5, 4, 4, 4.5, 5] as const;

const csvCell = (value: string) =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const row = (cells: readonly string[]) => `${cells.map(csvCell).join(',')}\n`;

/**
 * Builds one synthetic export.
 *
 * `Date` is a single constant across every row, which is exactly what the real export does
 * — and a useful secondary property: if a scale run ever produces watch dates on titles
 * that have no diary entry, this constant is what it would be.
 */
export function generateExport(options: GenerateOptions): GeneratedExport {
  const { titles, seed = 1, diaryRate = 0.05, watchlistRate = 0.08 } = options;

  const random = rng(seed);
  const activityDate = '2026-09-11';

  let watched = 'Date,Name,Year,Letterboxd URI\n';
  let ratings = 'Date,Name,Year,Letterboxd URI,Rating\n';
  let diary = 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n';
  let watchlist = 'Date,Name,Year,Letterboxd URI\n';

  for (let i = 0; i < titles; i += 1) {
    const name =
      i < AWKWARD.length
        ? AWKWARD[i]!
        : `${WORDS_A[i % WORDS_A.length]} ${WORDS_B[(i * 7) % WORDS_B.length]} ${i}`;
    const year = 1950 + (i % 76);
    const uri = `https://boxd.it/g${i.toString(36)}`;
    const rating = STARS[Math.floor(random() * STARS.length)]!;

    watched += row([activityDate, name, String(year), uri]);
    // Whole stars without a trailing `.0`, as the real export writes them.
    ratings += row([activityDate, name, String(year), uri, String(rating)]);

    if (random() < diaryRate) {
      const viewings = 1 + Math.floor(random() * 3);
      for (let v = 0; v < viewings; v += 1) {
        const day = 1 + Math.floor(random() * 28);
        const month = 1 + Math.floor(random() * 9);
        const watchedOn = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        diary += row([
          activityDate,
          name,
          String(year),
          // A diary-entry URI, and deliberately not the film's: a generator that reused the
          // film link would quietly stop exercising the one join rule that matters.
          `https://boxd.it/d${i.toString(36)}x${v}`,
          String(rating),
          v > 0 ? 'Yes' : '',
          '',
          watchedOn,
        ]);
      }
    }
  }

  // Watchlist titles are numbered past the watched range, so none of them is also watched —
  // the overlap case is a correctness fixture, not a scale one.
  const wanted = Math.round(titles * watchlistRate);
  for (let i = 0; i < wanted; i += 1) {
    const n = titles + i;
    const name = `${WORDS_A[n % WORDS_A.length]} ${WORDS_B[(n * 7) % WORDS_B.length]} ${n}`;
    watchlist += row([activityDate, name, String(1950 + (n % 76)), `https://boxd.it/w${n.toString(36)}`]);
  }

  return {
    'watched.csv': watched,
    'ratings.csv': ratings,
    'diary.csv': diary,
    'watchlist.csv': watchlist,
  };
}

/** Total bytes of the four files, which is what the archive bounds are measured against. */
export function exportBytes(generated: GeneratedExport): number {
  return Object.values(generated).reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0);
}
