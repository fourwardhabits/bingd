/**
 * A synthetic world for evaluating For You engines offline (Engine V2, A3).
 *
 * **Everything here is synthetic.** Titles, people, preferences, follows and rankings are
 * drawn from the generative model below, which is an assumption, not a measurement of bingd's
 * readers. Results computed on it say how the engines behave *under this model*; they are not
 * evidence that any engine is better for real people. Every number the evaluation reports is
 * labelled accordingly.
 *
 * The model, in brief:
 *
 * - **Titles** have a language (a skewed global mix, English about half), 1–3 genres with
 *   language-specific leanings, a year, a popularity that favours English, recent and good
 *   titles, a latent "style" vector partly tied to genre, and a quality term.
 * - **People** belong to taste clusters (the collaborative signal) and archetypes that set
 *   which languages they are open to, which genres they like and dislike, and whether they
 *   prefer an era. Their true utility for a title is a fixed function of all of that plus
 *   per-pair noise, so it can be evaluated for any title, watched or not.
 * - **Exposure** is biased: people watch popular titles, in languages they are open to, that
 *   they expect to like. What they watch is ranked into the app's three bands by utility
 *   (40/40/20), some only bucketed, some only logged — the evidence the client really reads.
 * - **Follows** are mostly random with weak homophily, because following is not taste.
 * - **Similar lists** imitate TMDB's: metadata-led (genres, language, style), popularity-
 *   flavoured, noisy, twenty per title.
 *
 * Deterministic for a seed.
 */

export const WORLD_VERSION = 'rec-eval-world-2026-11-10.1';

export const GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Music',
  'Mystery',
  'Romance',
  'Science Fiction',
  'Thriller',
  'War',
  'Western',
] as const;

/** A global film catalogue's rough language mix. An assumption, stated. */
export const LANGUAGE_MIX: readonly [string, number][] = [
  ['en', 0.5],
  ['ja', 0.07],
  ['ko', 0.06],
  ['hi', 0.06],
  ['es', 0.06],
  ['fr', 0.05],
  ['te', 0.03],
  ['ta', 0.03],
  ['zh', 0.03],
  ['de', 0.03],
  ['it', 0.03],
  ['pt', 0.02],
  ['tr', 0.01],
  ['ml', 0.01],
  ['sv', 0.01],
];

const DECADE_MIX: readonly [number, number][] = [
  [1950, 0.03],
  [1960, 0.04],
  [1970, 0.06],
  [1980, 0.09],
  [1990, 0.13],
  [2000, 0.2],
  [2010, 0.28],
  [2020, 0.17],
];

/** Genres a language's catalogue leans toward (weight multipliers). */
const GENRE_LEAN: Record<string, Partial<Record<(typeof GENRES)[number], number>>> = {
  ja: { Animation: 4, Drama: 1.5, Fantasy: 1.5 },
  ko: { Thriller: 2.5, Drama: 2, Romance: 1.5, Crime: 1.5 },
  hi: { Action: 2, Drama: 2, Romance: 2.5, Music: 3 },
  te: { Action: 3, Drama: 1.5, Romance: 2, Music: 2 },
  ta: { Action: 3, Drama: 1.5, Romance: 2, Music: 2 },
  ml: { Drama: 2.5, Thriller: 1.5, Comedy: 1.5 },
  fr: { Drama: 2.5, Comedy: 1.5, Romance: 1.5 },
  it: { Drama: 2, Comedy: 1.5, Crime: 1.5 },
  es: { Drama: 2, Thriller: 1.5, Comedy: 1.5 },
  zh: { Action: 2, Drama: 1.5, History: 2 },
};

export type Archetype = 'mainstream' | 'polyglot' | 'minority' | 'non_english' | 'classic' | 'niche';

const ARCHETYPE_MIX: readonly [Archetype, number][] = [
  ['mainstream', 0.45],
  ['polyglot', 0.12],
  ['minority', 0.2],
  ['non_english', 0.08],
  ['classic', 0.08],
  ['niche', 0.07],
];

export const LATENT = 6;
const CLUSTERS = 12;
const RARE_CLUSTERS = 3;

export type Bucket = 'loved' | 'fine' | 'not_for_me';

export type Title = {
  index: number;
  id: string;
  title: string;
  year: number;
  language: string;
  genres: string[];
  popularity: number;
  latent: number[];
  quality: number;
};

export type RankedRow = { title: number; bucket: Bucket; position: number };

export type Person = {
  index: number;
  id: string;
  archetype: Archetype;
  cluster: number;
  visibility: 'public' | 'private';
  taste: number[];
  openness: Record<string, number>;
  likedGenres: string[];
  dislikedGenres: string[];
  eraDecade: number | null;
  eraStrength: number;
  /** Position order; bands contiguous, as a real ranking always is. */
  ranked: RankedRow[];
  bucketed: { title: number; bucket: Bucket }[];
  logged: number[];
  follows: number[];
};

export type WorldConfig = {
  seed: number;
  titles: number;
  people: number;
  /** Median watched titles per person (log-normal). */
  watchedMedian: number;
  similarPerTitle: number;
  trending: number;
};

export const DEFAULT_WORLD: WorldConfig = {
  seed: 20261110,
  titles: 4000,
  people: 4000,
  watchedMedian: 32,
  similarPerTitle: 20,
  trending: 20,
};

export type World = {
  version: string;
  config: WorldConfig;
  titles: Title[];
  people: Person[];
  /** Per title, the indices of its TMDB-like similar list. */
  similar: number[][];
  /** The trending list: recent, popular. */
  trending: number[];
};

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

export function rng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(next(), 1e-12);
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const pick = <T>(weights: readonly [T, number][]): T => {
    const total = weights.reduce((sum, [, w]) => sum + w, 0);
    let r = next() * total;
    for (const [value, w] of weights) {
      r -= w;
      if (r <= 0) return value;
    }
    return weights[weights.length - 1]![0];
  };
  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  };
  return { next, normal, pick, shuffle };
}

/** A stable 0–1 value for a key, independent of draw order. */
export function hashUnit(seed: number, a: number, b: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (const value of [a, b]) {
    h ^= value & 0xffff;
    h = Math.imul(h, 0x01000193);
    h ^= value >>> 16;
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return ((h >>> 0) + 0.5) / 4294967296;
}

/** Per-pair Gaussian noise, the same every time it is asked for. */
function pairNoise(seed: number, person: number, title: number): number {
  const u = hashUnit(seed, person, title);
  const v = hashUnit(seed ^ 0x9e3779b9, person, title);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const unitVector = (values: number[]) => {
  const length = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  return values.map((v) => v / length);
};
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);

export const decadeOfYear = (year: number) => Math.floor(year / 10) * 10;

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

/**
 * A person's true utility for a title. **Synthetic ground truth**: the evaluation's oracle
 * metrics read this, which no real system could.
 */
export function utility(world: Pick<World, 'config'>, person: Person, title: Title): number {
  return expectedUtility(person, title) + 0.35 * pairNoise(world.config.seed, person.index, title.index);
}

function expectedUtility(person: Person, title: Title): number {
  const open = person.openness[title.language] ?? 0.05;
  let genre = 0;
  for (const g of title.genres) {
    if (person.likedGenres.includes(g)) genre += 0.5;
    if (person.dislikedGenres.includes(g)) genre -= 0.9;
  }
  genre /= Math.sqrt(title.genres.length);
  let era = 0;
  if (person.eraDecade != null) {
    const gap = Math.abs(decadeOfYear(title.year) - person.eraDecade);
    era = person.eraStrength * (gap === 0 ? 1 : gap === 10 ? 0.5 : 0);
  }
  return 1.1 * dot(person.taste, title.latent) + 0.45 * title.quality + 0.9 * (open - 0.5) + genre + era;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generateWorld(config: WorldConfig = DEFAULT_WORLD): World {
  const r = rng(config.seed);
  const genreDirection = new Map(
    GENRES.map((g) => [g as string, unitVector(Array.from({ length: LATENT }, () => r.normal()))]),
  );

  const titles: Title[] = [];
  for (let index = 0; index < config.titles; index += 1) {
    const language = r.pick(LANGUAGE_MIX);
    const decade = r.pick(DECADE_MIX);
    const year = Math.min(2026, decade + Math.floor(r.next() * 10));
    const lean = GENRE_LEAN[language] ?? {};
    const genreWeights = GENRES.map((g) => [g as string, lean[g] ?? 1] as [string, number]);
    const genres = new Set<string>();
    const count = 1 + Math.floor(r.next() * 3);
    while (genres.size < count) genres.add(r.pick(genreWeights));
    const genreList = [...genres];
    const direction = Array.from({ length: LATENT }, (_, k) =>
      genreList.reduce((sum, g) => sum + genreDirection.get(g)![k]!, 0) / genreList.length,
    );
    const latent = unitVector(direction.map((v) => 0.6 * v + 0.8 * r.normal()));
    const quality = r.normal();
    const recency = decade >= 2020 ? 1.8 : decade >= 2010 ? 1.3 : decade >= 2000 ? 1 : 0.6;
    const popularity =
      Math.exp(3 + 1.2 * r.normal()) * (language === 'en' ? 2.5 : 1) * recency * Math.exp(0.4 * quality);
    titles.push({
      index,
      id: `title-${index}`,
      title: `Synthetic ${index}`,
      year,
      language,
      genres: genreList,
      popularity: Math.round(popularity * 100) / 100,
      latent,
      quality,
    });
  }

  const centres = Array.from({ length: CLUSTERS + RARE_CLUSTERS }, () =>
    unitVector(Array.from({ length: LATENT }, () => r.normal())),
  );
  const nonEnglish = LANGUAGE_MIX.filter(([code]) => code !== 'en');
  const languages = LANGUAGE_MIX.map(([code]) => code);

  const people: Person[] = [];
  for (let index = 0; index < config.people; index += 1) {
    const archetype = r.pick(ARCHETYPE_MIX);
    const cluster =
      archetype === 'niche' ? CLUSTERS + Math.floor(r.next() * RARE_CLUSTERS) : Math.floor(r.next() * CLUSTERS);
    const taste = unitVector(centres[cluster]!.map((v) => v + 0.5 * r.normal()));
    const openness: Record<string, number> = {};
    for (const code of languages) openness[code] = 0.05 + 0.2 * r.next();
    let eraDecade: number | null = null;
    let eraStrength = 0;
    switch (archetype) {
      case 'mainstream':
        openness.en = 1;
        break;
      case 'polyglot': {
        openness.en = 0.8;
        const chosen = new Set<string>();
        while (chosen.size < 3) chosen.add(r.pick(nonEnglish));
        for (const code of chosen) openness[code] = 0.65 + 0.35 * r.next();
        break;
      }
      case 'minority':
        openness[r.pick(nonEnglish)] = 1;
        openness.en = 0.6 + 0.3 * r.next();
        break;
      case 'non_english':
        openness[r.pick(nonEnglish)] = 1;
        openness.en = 0.25;
        break;
      case 'classic':
        openness.en = 1;
        openness[r.pick(nonEnglish)] = 0.4;
        eraDecade = r.pick([[1950, 1], [1960, 1], [1970, 1], [1980, 1]] as [number, number][]);
        eraStrength = 0.9;
        break;
      case 'niche':
        openness.en = 0.7 + 0.3 * r.next();
        for (const code of languages) if (code !== 'en') openness[code] = 0.1 + 0.3 * r.next();
        break;
    }
    if (eraDecade == null && r.next() < 0.25) {
      eraDecade = r.pick(DECADE_MIX);
      eraStrength = 0.4;
    }
    const shuffled = r.shuffle([...GENRES] as string[]);
    const likedGenres = shuffled.slice(0, 2);
    const dislikedGenres = shuffled.slice(2, 2 + 1 + Math.floor(r.next() * 2));
    people.push({
      index,
      id: `person-${index}`,
      archetype,
      cluster,
      visibility: r.next() < 0.12 ? 'private' : 'public',
      taste,
      openness,
      likedGenres,
      dislikedGenres,
      eraDecade,
      eraStrength,
      ranked: [],
      bucketed: [],
      logged: [],
      follows: [],
    });
  }

  const world: World = { version: WORLD_VERSION, config, titles, people, similar: [], trending: [] };

  // Exposure: a Gumbel top-k over popularity, openness and expected liking.
  const logPopularity = titles.map((t) => Math.log(t.popularity));
  for (const person of people) {
    const median = person.archetype === 'niche' ? config.watchedMedian / 2 : config.watchedMedian;
    const watchedCount = Math.max(8, Math.min(150, Math.round(Math.exp(Math.log(median) + 0.7 * r.normal()))));
    const keyed = titles.map((title) => {
      const open = person.openness[title.language] ?? 0.05;
      const weight =
        0.6 * logPopularity[title.index]! + 1.5 * Math.log(open) + 0.8 * expectedUtility(person, title);
      const gumbel = -Math.log(-Math.log(Math.max(r.next(), 1e-12)));
      return { title: title.index, key: weight + gumbel };
    });
    keyed.sort((a, b) => b.key - a.key);
    const watched = keyed.slice(0, watchedCount).map((entry) => entry.title);

    const byUtility = watched
      .map((t) => ({ t, u: utility(world, person, titles[t]!) }))
      .sort((a, b) => b.u - a.u);
    const bucketOf = new Map<number, Bucket>();
    byUtility.forEach(({ t }, rank) => {
      const share = rank / byUtility.length;
      bucketOf.set(t, share < 0.4 ? 'loved' : share < 0.8 ? 'fine' : 'not_for_me');
    });

    const roles = r.shuffle([...watched]);
    const rankedCount = Math.round(roles.length * 0.65);
    const bucketedCount = Math.round(roles.length * 0.15);
    const rankedSet = new Set(roles.slice(0, rankedCount));
    let position = 0;
    for (const { t } of byUtility) {
      if (!rankedSet.has(t)) continue;
      position += 1;
      person.ranked.push({ title: t, bucket: bucketOf.get(t)!, position });
    }
    for (const t of roles.slice(rankedCount, rankedCount + bucketedCount)) {
      person.bucketed.push({ title: t, bucket: bucketOf.get(t)! });
    }
    person.logged = roles.slice(rankedCount + bucketedCount);
  }

  // Follows: mostly random, weakly homophilous.
  const byCluster = new Map<number, number[]>();
  for (const person of people) {
    byCluster.set(person.cluster, [...(byCluster.get(person.cluster) ?? []), person.index]);
  }
  for (const person of people) {
    const count = 5 + Math.floor(r.next() * 21);
    const follows = new Set<number>();
    const sameCluster = byCluster.get(person.cluster) ?? [];
    while (follows.size < count) {
      const pool = r.next() < 0.3 && sameCluster.length > 1 ? sameCluster : null;
      const other = pool ? pool[Math.floor(r.next() * pool.length)]! : Math.floor(r.next() * people.length);
      if (other !== person.index) follows.add(other);
    }
    person.follows = [...follows];
  }

  // Similar lists, TMDB-like.
  const maxLogPop = Math.max(...logPopularity);
  for (const title of titles) {
    const scored: { t: number; s: number }[] = [];
    const genres = new Set(title.genres);
    for (const other of titles) {
      if (other.index === title.index) continue;
      let shared = 0;
      for (const g of other.genres) if (genres.has(g)) shared += 1;
      const jaccard = shared / (genres.size + other.genres.length - shared);
      const s =
        jaccard +
        (other.language === title.language ? 0.4 : 0) +
        0.35 * dot(title.latent, other.latent) +
        0.12 * (logPopularity[other.index]! / maxLogPop) +
        0.25 * hashUnit(config.seed ^ 0x51, title.index, other.index);
      scored.push({ t: other.index, s });
    }
    scored.sort((a, b) => b.s - a.s);
    world.similar.push(scored.slice(0, config.similarPerTitle).map((entry) => entry.t));
  }

  world.trending = titles
    .filter((t) => t.year >= 2023)
    .map((t) => ({ t: t.index, key: Math.log(t.popularity) + 0.3 * r.normal() }))
    .sort((a, b) => b.key - a.key)
    .slice(0, config.trending)
    .map((entry) => entry.t);

  return world;
}

// ---------------------------------------------------------------------------
// Test readers and held-out evidence
// ---------------------------------------------------------------------------

export type Stratum = Archetype | 'cold_start';

export type TestReader = {
  person: number;
  stratum: Stratum;
  /** What the reader's client is allowed to see. Positions renumbered 1..n. */
  ranked: RankedRow[];
  bucketed: { title: number; bucket: Bucket }[];
  logged: number[];
  /** Hidden from every input. Held-out loved titles are the relevance targets. */
  hidden: { title: number; bucket: Bucket }[];
};

export const DEFAULT_QUOTAS: Record<Stratum, number> = {
  mainstream: 100,
  polyglot: 60,
  minority: 80,
  non_english: 40,
  classic: 40,
  niche: 40,
  cold_start: 40,
};

/**
 * A stratified set of readers, each with a quarter of their ranked titles held out.
 *
 * Cold-start readers keep only five ranked titles and nothing logged; everything else they
 * ranked is held out. Readers are disjoint across strata.
 */
export function chooseTestReaders(world: World, quotas = DEFAULT_QUOTAS, seed = world.config.seed + 1): TestReader[] {
  const r = rng(seed);
  const used = new Set<number>();
  const readers: TestReader[] = [];
  const eligible = (person: Person, min: number) => !used.has(person.index) && person.ranked.length >= min;
  const order = r.shuffle(world.people.map((p) => p.index));

  for (const stratum of Object.keys(quotas) as Stratum[]) {
    const want = quotas[stratum];
    let taken = 0;
    for (const index of order) {
      if (taken >= want) break;
      const person = world.people[index]!;
      if (stratum === 'cold_start') {
        if (!eligible(person, 15) || !['mainstream', 'minority', 'polyglot'].includes(person.archetype)) continue;
      } else if (person.archetype !== stratum || !eligible(person, 12)) {
        continue;
      }
      used.add(index);
      taken += 1;
      const shuffled = r.shuffle([...person.ranked]);
      const keep =
        stratum === 'cold_start' ? 5 : person.ranked.length - Math.max(3, Math.round(person.ranked.length * 0.25));
      const kept = new Set(shuffled.slice(0, keep).map((row) => row.title));
      const ranked = person.ranked
        .filter((row) => kept.has(row.title))
        .map((row, i) => ({ ...row, position: i + 1 }));
      const hidden = person.ranked.filter((row) => !kept.has(row.title)).map(({ title, bucket }) => ({ title, bucket }));
      readers.push({
        person: index,
        stratum,
        ranked,
        bucketed: stratum === 'cold_start' ? [] : person.bucketed,
        logged: stratum === 'cold_start' ? [] : person.logged,
        hidden,
      });
    }
  }
  return readers;
}
