import { SLATE_SIZE } from '../rank';

import { EXTENDED, indexOfId, metOf, wallFor, type CollaborativeRows, type TvShape, type Variant } from './pipeline';
import { EVAL_CONFIG_VERSION, LAUNCH_SEEDS } from './variants';
import { decadeOfYear, isColdStart, rng, utility, type TestReader, type World } from './world';

/**
 * Offline metrics for For You engines on a **synthetic** world (Engine V2, A3).
 *
 * Two families, kept apart in the report because they answer different questions:
 *
 * - **Held-out** (`recall`, `ndcg`, `hit`, `poolRecall`): a quarter of each reader's ranked
 *   titles is hidden; did the wall find the hidden *loved* ones? The classic offline test. It
 *   inherits exposure bias — what people watched was popular and in their languages — so it
 *   under-rewards an engine that surfaces good titles nobody was shown.
 * - **Oracle** (`utility`): the generator's ground-truth utility of what is on the wall, as a
 *   percentile among every title the reader has not met. Only a synthetic world has this,
 *   which is both its value and its limit: it measures fit to the model's own assumptions.
 *
 * Plus coverage (languages, era), negatives, diversity, popularity bias and cost.
 */

export type ReaderMetrics = {
  recall: number | null;
  /** Held-out loved titles in the first fifty drawn (three pages, prefix-stable). */
  recall50: number | null;
  /**
   * Positive-vs-negative ordering: the probability that a held-out **loved** title scores above
   * a held-out **Not-for-me** one when both are scored as this wall scores its pool (ties ½).
   * An AUC over the reader's own held-out opinions, independent of retrieval.
   */
  ordering: number | null;
  ndcg: number | null;
  hit: number | null;
  poolRecall: number | null;
  utility: number;
  nonEnglishShare: number;
  /** Non-English share of the scored pool, before the draw. */
  poolNonEnglish: number | null;
  /** Non-English share of the reader's own visible collection; null with no collection. */
  ownNonEnglish: number | null;
  /** Wall non-English share minus the reader's own: positive is more non-English than they watch. */
  languageGap: number | null;
  languages: number;
  /** Of the non-English languages this reader is truly open to (≥ 0.6), the share on the wall. */
  servedLanguages: number | null;
  /** Share of the wall in the reader's preferred decade, for readers with a strong one. */
  eraShare: number | null;
  /** That decade's share of the titles the reader has not met: the no-preference baseline. */
  eraBase: number | null;
  dislikedShare: number;
  genres: number;
  /** Shannon entropy (bits) of the wall's genre mix, each title's genres sharing one unit. */
  genreEntropy: number;
  /** 1 − total-variation distance between the wall's decades and the reader's loved titles' decades. */
  eraFit: number | null;
  /** Share of the wall also on the next launch's wall (consecutive launch seeds; no exposure memory). */
  repeatNext: number | null;
  /** Share of the wall the reader has already met. Expected 0: exclusion working. */
  seenShare: number;
  popularityPercentile: number;
  fromCollaborative: number;
  fromCatalogue: number;
  fromSocial: number;
  ms: number;
};

export const METRIC_KEYS: (keyof ReaderMetrics)[] = [
  'recall',
  'recall50',
  'ordering',
  'ndcg',
  'hit',
  'poolRecall',
  'utility',
  'nonEnglishShare',
  'poolNonEnglish',
  'ownNonEnglish',
  'languageGap',
  'languages',
  'servedLanguages',
  'eraShare',
  'eraBase',
  'dislikedShare',
  'genres',
  'genreEntropy',
  'eraFit',
  'repeatNext',
  'seenShare',
  'popularityPercentile',
  'fromCollaborative',
  'fromCatalogue',
  'fromSocial',
  'ms',
];

type ReaderContext = {
  reader: TestReader;
  /** True utility of every unmet title, ascending, for percentiles. */
  sortedUtility: number[];
  utilityOf: Map<number, number>;
  hiddenLoved: Set<number>;
  openLanguages: string[];
  eraDecade: number | null;
  eraBase: number | null;
  collaborative: CollaborativeRows;
  hiddenNegative: Set<number>;
  ownNonEnglish: number | null;
  /** Decade → share of the person's loved titles (all of them, visible or held out). */
  lovedDecades: Map<number, number>;
};

const shareMap = (values: readonly number[]) => {
  const out = new Map<number, number>();
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1 / values.length);
  return out;
};

const percentile = (sorted: readonly number[], value: number) => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length ? lo / sorted.length : 0;
};

function contextFor(world: World, reader: TestReader, collaborative: CollaborativeRows): ReaderContext {
  const person = world.people[reader.person]!;
  const met = metOf(reader);
  const utilityOf = new Map<number, number>();
  let eraCount = 0;
  for (const title of world.titles) {
    if (met.has(title.index)) continue;
    utilityOf.set(title.index, utility(world, person, title));
    if (person.eraDecade != null && decadeOfYear(title.year) === person.eraDecade) eraCount += 1;
  }
  const strongEra = person.eraDecade != null && person.eraStrength >= 0.8;
  return {
    reader,
    sortedUtility: [...utilityOf.values()].sort((a, b) => a - b),
    utilityOf,
    hiddenLoved: new Set(reader.hidden.filter((row) => row.bucket === 'loved').map((row) => row.title)),
    openLanguages: Object.entries(person.openness)
      .filter(([code, open]) => code !== 'en' && open >= 0.6)
      .map(([code]) => code),
    eraDecade: strongEra ? person.eraDecade : null,
    eraBase: strongEra ? eraCount / Math.max(1, utilityOf.size) : null,
    collaborative,
    hiddenNegative: new Set(reader.hidden.filter((row) => row.bucket === 'not_for_me').map((row) => row.title)),
    ownNonEnglish: met.size > 0 ? [...met].filter((t) => world.titles[t]!.language !== 'en').length / met.size : null,
    lovedDecades: shareMap(
      person.ranked.filter((row) => row.bucket === 'loved').map((row) => decadeOfYear(world.titles[row.title]!.year)),
    ),
  };
}

/** AUC of `positive` over `negative` under `score`, ties ½; null when either side is empty. */
export function orderingAuc(
  score: ReadonlyMap<number, number>,
  positive: Iterable<number>,
  negative: Iterable<number>,
): number | null {
  const pos = [...positive].map((t) => score.get(t)).filter((v): v is number => v != null);
  const neg = [...negative].map((t) => score.get(t)).filter((v): v is number => v != null);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Shannon entropy in bits of a wall's genre mix; each title's genres share one unit. */
export function genreEntropy(genreLists: readonly (readonly string[])[]): number {
  const mass = new Map<string, number>();
  let total = 0;
  for (const genres of genreLists) {
    if (genres.length === 0) continue;
    for (const g of genres) mass.set(g, (mass.get(g) ?? 0) + 1 / genres.length);
    total += 1;
  }
  let h = 0;
  for (const m of mass.values()) {
    const p = m / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return total > 0 ? h : 0;
}

function measure(
  world: World,
  ctx: ReaderContext,
  variant: Variant,
  popularityRank: ReadonlyMap<number, number>,
  tv?: TvShape,
): ReaderMetrics {
  const person = world.people[ctx.reader.person]!;
  const totals = new Map<keyof ReaderMetrics, number>();
  const add = (key: keyof ReaderMetrics, value: number | null) => {
    if (value == null) return;
    totals.set(key, (totals.get(key) ?? 0) + value);
  };
  const met = metOf(ctx.reader);
  const hiddenTitles = ctx.reader.hidden.map((row) => world.titles[row.title]!);
  const walls: number[][] = [];
  for (const seed of LAUNCH_SEEDS) {
    const { wall, extended, scored, sources, scoreTitles, ms } = wallFor({
      world,
      reader: ctx.reader,
      variant,
      collaborative: ctx.collaborative,
      anchorSeed: seed,
      drawSeed: seed * 7919,
      tv,
    });
    const items = wall.map((item) => indexOfId(item.mediaItemId));
    walls.push(items);
    add('ordering', orderingAuc(scoreTitles(hiddenTitles), ctx.hiddenLoved, ctx.hiddenNegative));
    const relevant = ctx.hiddenLoved.size;
    if (relevant > 0) {
      let dcg = 0;
      let hits = 0;
      items.forEach((t, i) => {
        if (ctx.hiddenLoved.has(t)) {
          hits += 1;
          dcg += 1 / Math.log2(i + 2);
        }
      });
      let ideal = 0;
      for (let i = 0; i < Math.min(relevant, SLATE_SIZE); i += 1) ideal += 1 / Math.log2(i + 2);
      add('recall', hits / Math.min(relevant, SLATE_SIZE));
      const longHits = extended.filter((item) => ctx.hiddenLoved.has(indexOfId(item.mediaItemId))).length;
      add('recall50', longHits / Math.min(relevant, EXTENDED));
      add('ndcg', dcg / ideal);
      add('hit', hits > 0 ? 1 : 0);
      const pool = new Set(scored.map((item) => indexOfId(item.mediaItemId)));
      add('poolRecall', [...ctx.hiddenLoved].filter((t) => pool.has(t)).length / relevant);
    }
    const n = Math.max(1, items.length);
    add('utility', items.reduce((sum, t) => sum + percentile(ctx.sortedUtility, ctx.utilityOf.get(t) ?? 0), 0) / n);
    const langs = items.map((t) => world.titles[t]!.language);
    const nonEnglish = langs.filter((code) => code !== 'en').length / n;
    add('nonEnglishShare', nonEnglish);
    if (scored.length > 0) {
      add(
        'poolNonEnglish',
        scored.filter((item) => world.titles[indexOfId(item.mediaItemId)]!.language !== 'en').length / scored.length,
      );
    }
    add('ownNonEnglish', ctx.ownNonEnglish);
    add('languageGap', ctx.ownNonEnglish == null ? null : nonEnglish - ctx.ownNonEnglish);
    add('languages', new Set(langs).size);
    if (ctx.openLanguages.length > 0) {
      add('servedLanguages', ctx.openLanguages.filter((code) => langs.includes(code)).length / ctx.openLanguages.length);
    }
    if (ctx.eraDecade != null) {
      add('eraShare', items.filter((t) => decadeOfYear(world.titles[t]!.year) === ctx.eraDecade).length / n);
      add('eraBase', ctx.eraBase);
    }
    add(
      'dislikedShare',
      items.filter((t) => world.titles[t]!.genres.some((g) => person.dislikedGenres.includes(g))).length / n,
    );
    add('genres', new Set(items.flatMap((t) => world.titles[t]!.genres)).size);
    add('genreEntropy', genreEntropy(items.map((t) => world.titles[t]!.genres)));
    if (ctx.lovedDecades.size > 0 && items.length > 0) {
      const wallDecades = shareMap(items.map((t) => decadeOfYear(world.titles[t]!.year)));
      let tvd = 0;
      for (const decade of new Set([...wallDecades.keys(), ...ctx.lovedDecades.keys()])) {
        tvd += Math.abs((wallDecades.get(decade) ?? 0) - (ctx.lovedDecades.get(decade) ?? 0));
      }
      add('eraFit', 1 - tvd / 2);
    }
    add('seenShare', items.filter((t) => met.has(t)).length / n);
    add('popularityPercentile', items.reduce((sum, t) => sum + (popularityRank.get(t) ?? 0), 0) / n);
    add('fromCollaborative', sources.collaborative / n);
    add('fromCatalogue', sources.catalogue / n);
    add('fromSocial', sources.social / n);
    add('ms', ms);
  }
  const runs = LAUNCH_SEEDS.length;
  const out = {} as ReaderMetrics;
  for (const key of METRIC_KEYS) {
    const total = totals.get(key);
    (out as Record<string, number | null>)[key] = total == null ? null : total / runs;
  }
  // Repeats compare consecutive launches, so they are per pair of walls, not per seed.
  const overlaps: number[] = [];
  for (let i = 0; i + 1 < walls.length; i += 1) {
    const next = new Set(walls[i + 1]);
    if (walls[i]!.length > 0) overlaps.push(walls[i]!.filter((t) => next.has(t)).length / walls[i]!.length);
  }
  out.repeatNext = overlaps.length ? overlaps.reduce((a, b) => a + b, 0) / overlaps.length : null;
  return out;
}

/** The activity slice of a reader by visible ranked titles (cold-start strata are reported apart). */
export type Activity = 'sparse' | 'medium' | 'heavy';
export const activityOf = (reader: TestReader): Activity | null => {
  if (isColdStart(reader.stratum)) return null;
  const n = reader.ranked.length;
  return n <= 10 ? 'sparse' : n <= 30 ? 'medium' : 'heavy';
};

export type Summary = { mean: number; ci: number; n: number };
export type Delta = { mean: number; ci: number; n: number };

export const summarise = (values: readonly (number | null)[]): Summary | null => {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (xs.length === 0) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) : 0;
  return { mean, ci: 1.96 * Math.sqrt(variance / xs.length), n: xs.length };
};

const paired = (a: readonly (number | null)[], b: readonly (number | null)[]): Delta | null =>
  summarise(a.map((value, i) => (value == null || b[i] == null ? null : value - b[i]!)));

export type Report = {
  configVersion: string;
  worldVersion: string;
  seed: number;
  readers: number;
  strata: Record<string, number>;
  variants: { id: string; label: string; group: string }[];
  /** variant → stratum ('all' included) → metric → summary */
  results: Record<string, Record<string, Partial<Record<keyof ReaderMetrics, Summary | null>>>>;
  /** variant → stratum → metric → paired delta against the reference */
  versusV1: Record<string, Record<string, Partial<Record<keyof ReaderMetrics, Delta | null>>>>;
  versusMetadata: Record<string, Record<string, Partial<Record<keyof ReaderMetrics, Delta | null>>>>;
  /** Activity slices (non-cold readers by visible ranked titles) → reader count. */
  activity: Record<string, number>;
  following: { v2WallsChanged: number; v1WallsChanged: number; readers: number };
  catalogueCoverage: Record<string, number>;
  collaborative: { readersWithEvidence: number; meanRows: number; meanNeighbours: number | null; sqlMsMean: number | null };
};

export type CollaborativeInput = Map<number, { rows: CollaborativeRows; neighbours: number | null; ms: number | null }>;

export function evaluate(
  world: World,
  readers: readonly TestReader[],
  collaborative: CollaborativeInput,
  variants: readonly Variant[],
): Report {
  const byPopularity = [...world.titles].sort((a, b) => a.popularity - b.popularity);
  const popularityRank = new Map(byPopularity.map((t, i) => [t.index, i / byPopularity.length]));
  const empty: CollaborativeRows = new Map();
  const contexts = readers.map((reader) =>
    contextFor(world, reader, collaborative.get(reader.person)?.rows ?? empty),
  );
  const activityKeys = (['sparse', 'medium', 'heavy'] as const)
    .filter((a) => readers.some((r) => activityOf(r) === a))
    .map((a) => `activity:${a}`);
  const strata = ['all', ...new Set(readers.map((r) => r.stratum)), ...activityKeys] as string[];

  const perVariant = new Map<string, ReaderMetrics[]>();
  const shown = new Map<string, Set<number>>();
  for (const variant of variants) {
    const metrics = contexts.map((ctx) => measure(world, ctx, variant, popularityRank));
    perVariant.set(variant.id, metrics);
    const titles = new Set<number>();
    for (const ctx of contexts) {
      const { wall } = wallFor({ world, reader: ctx.reader, variant, collaborative: ctx.collaborative, anchorSeed: LAUNCH_SEEDS[0], drawSeed: LAUNCH_SEEDS[0] * 7919 });
      for (const item of wall) titles.add(indexOfId(item.mediaItemId));
    }
    shown.set(variant.id, titles);
  }

  const inStratum = (slice: string) =>
    contexts
      .map((ctx, i) =>
        slice === 'all' ||
        ctx.reader.stratum === slice ||
        (slice.startsWith('activity:') && `activity:${activityOf(ctx.reader)}` === slice)
          ? i
          : -1,
      )
      .filter((i) => i >= 0);

  const results: Report['results'] = {};
  const versusV1: Report['versusV1'] = {};
  const versusMetadata: Report['versusMetadata'] = {};
  for (const variant of variants) {
    const metrics = perVariant.get(variant.id)!;
    results[variant.id] = {};
    versusV1[variant.id] = {};
    versusMetadata[variant.id] = {};
    for (const stratum of strata) {
      const idx = inStratum(stratum);
      const row: Partial<Record<keyof ReaderMetrics, Summary | null>> = {};
      const d1: Partial<Record<keyof ReaderMetrics, Delta | null>> = {};
      const dm: Partial<Record<keyof ReaderMetrics, Delta | null>> = {};
      for (const key of METRIC_KEYS) {
        const values = idx.map((i) => metrics[i]![key]);
        row[key] = summarise(values);
        const v1 = perVariant.get('v1');
        const meta = perVariant.get('v2_metadata');
        if (v1 && variant.id !== 'v1') d1[key] = paired(values, idx.map((i) => v1[i]![key]));
        if (meta && variant.id !== 'v2_metadata') dm[key] = paired(values, idx.map((i) => meta[i]![key]));
      }
      results[variant.id]![stratum] = row;
      versusV1[variant.id]![stratum] = d1;
      versusMetadata[variant.id]![stratum] = dm;
    }
  }

  // Following has no effect under V2: give every reader a different follow graph.
  const r = rng(world.config.seed + 99);
  let v2Changed = 0;
  let v1Changed = 0;
  const v1 = variants.find((v) => v.id === 'v1');
  const v2 = variants.find((v) => v.id === 'v2_hybrid') ?? variants.find((v) => v.engine === 'v2');
  for (const ctx of contexts) {
    const shuffled = Array.from({ length: 15 }, () => Math.floor(r.next() * world.people.length));
    const wallIds = (variant: Variant, follows?: number[]) =>
      wallFor({ world, reader: ctx.reader, variant, collaborative: ctx.collaborative, follows, anchorSeed: 5, drawSeed: 5 })
        .wall.map((item) => item.mediaItemId)
        .join(',');
    if (v2 && wallIds(v2) !== wallIds(v2, shuffled)) v2Changed += 1;
    if (v1 && wallIds(v1) !== wallIds(v1, shuffled)) v1Changed += 1;
  }

  const rowsPerReader = contexts.map((ctx) => ctx.collaborative.size);
  const neighbours = readers.map((reader) => collaborative.get(reader.person)?.neighbours ?? null);
  const sqlMs = readers.map((reader) => collaborative.get(reader.person)?.ms ?? null);
  return {
    configVersion: EVAL_CONFIG_VERSION,
    worldVersion: world.version,
    seed: world.config.seed,
    readers: readers.length,
    strata: Object.fromEntries(
      strata.filter((s) => s !== 'all' && !s.startsWith('activity:')).map((s) => [s, inStratum(s).length]),
    ),
    activity: Object.fromEntries(activityKeys.map((s) => [s, inStratum(s).length])),
    variants: variants.map(({ id, label, group }) => ({ id, label, group })),
    results,
    versusV1,
    versusMetadata,
    following: { v2WallsChanged: v2Changed, v1WallsChanged: v1Changed, readers: contexts.length },
    catalogueCoverage: Object.fromEntries([...shown].map(([id, set]) => [id, set.size / world.titles.length])),
    collaborative: {
      readersWithEvidence: rowsPerReader.filter((n) => n > 0).length,
      meanRows: rowsPerReader.reduce((a, b) => a + b, 0) / Math.max(1, rowsPerReader.length),
      meanNeighbours: summarise(neighbours)?.mean ?? null,
      sqlMsMean: summarise(sqlMs)?.mean ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// TV: whole-show rankers (reconcile, 2026-11-13)
// ---------------------------------------------------------------------------

export type TvReport = {
  readers: number;
  shapes: TvShape[];
  variants: { id: string; label: string }[];
  /** shape → variant → metric → summary */
  results: Record<string, Record<string, Partial<Record<keyof ReaderMetrics, Summary | null>>>>;
  /** shape → variant → metric → paired delta against V1 */
  versusV1: Record<string, Record<string, Partial<Record<keyof ReaderMetrics, Delta | null>>>>;
  /** shape → variant → metric → paired delta against `reference` (the pre-reconcile V2 profile) */
  versusReference: Record<string, Record<string, Partial<Record<keyof ReaderMetrics, Delta | null>>>>;
  reference: string;
};

/**
 * The TV wall, with the same readers' titles read as shows (see `TvShape`), through the
 * shipped TV taste, profile and anchor functions. Cold-start readers are left out: their few
 * titles say little about how TV evidence is pooled.
 *
 * The collaborative evidence is the film wall's (the SQL is run once, on films): in this world a
 * show is the same title with the same neighbours' opinions, and since the reconcile the SQL
 * reads one opinion per neighbour per series however they ranked it, so the rows are the ones
 * the TV read would return. Stated as an approximation.
 */
export function evaluateTv(
  world: World,
  readers: readonly TestReader[],
  collaborative: CollaborativeInput,
  variants: readonly Variant[],
  shapes: readonly TvShape[] = ['whole_show', 'by_season', 'show_and_seasons'],
  reference = 'v2m-pre-ws5',
): TvReport {
  const byPopularity = [...world.titles].sort((a, b) => a.popularity - b.popularity);
  const popularityRank = new Map(byPopularity.map((t, i) => [t.index, i / byPopularity.length]));
  const empty: CollaborativeRows = new Map();
  const tvReaders = readers.filter((r) => !isColdStart(r.stratum));
  const contexts = tvReaders.map((reader) => contextFor(world, reader, collaborative.get(reader.person)?.rows ?? empty));
  const out: TvReport = {
    readers: tvReaders.length,
    shapes: [...shapes],
    variants: variants.map(({ id, label }) => ({ id, label })),
    results: {},
    versusV1: {},
    versusReference: {},
    reference,
  };
  for (const shape of shapes) {
    const per = new Map<string, ReaderMetrics[]>();
    for (const variant of variants) {
      per.set(variant.id, contexts.map((ctx) => measure(world, ctx, variant, popularityRank, shape)));
    }
    out.results[shape] = {};
    out.versusV1[shape] = {};
    out.versusReference[shape] = {};
    for (const variant of variants) {
      const metrics = per.get(variant.id)!;
      const row: Partial<Record<keyof ReaderMetrics, Summary | null>> = {};
      const d1: Partial<Record<keyof ReaderMetrics, Delta | null>> = {};
      const dr: Partial<Record<keyof ReaderMetrics, Delta | null>> = {};
      for (const key of METRIC_KEYS) {
        const values = metrics.map((m) => m[key]);
        row[key] = summarise(values);
        const v1 = per.get('v1');
        const ref = per.get(reference);
        if (v1 && variant.id !== 'v1') d1[key] = paired(values, v1.map((m) => m[key]));
        if (ref && variant.id !== reference) dr[key] = paired(values, ref.map((m) => m[key]));
      }
      out.results[shape]![variant.id] = row;
      out.versusV1[shape]![variant.id] = d1;
      out.versusReference[shape]![variant.id] = dr;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const fmt = (s: Summary | Delta | null | undefined, digits = 3, signed = false) =>
  s == null ? '—' : `${signed && s.mean >= 0 ? '+' : ''}${s.mean.toFixed(digits)} ± ${s.ci.toFixed(digits)}`;

const HEADLINE: [keyof ReaderMetrics, string][] = [
  ['recall', 'Held-out recall@20'],
  ['ndcg', 'Held-out nDCG@20'],
  ['poolRecall', 'Pool recall'],
  ['utility', 'Oracle utility pct'],
  ['nonEnglishShare', 'Non-English share'],
  ['servedLanguages', 'Open languages served'],
  ['eraShare', 'Era share (era readers)'],
  ['dislikedShare', 'Disliked-genre share'],
  ['genres', 'Distinct genres'],
  ['popularityPercentile', 'Popularity pct'],
];

/** The reconcile's added metrics (2026-11-13). */
const EXTRA: [keyof ReaderMetrics, string][] = [
  ['recall50', 'Held-out recall@50'],
  ['ordering', 'Loved-over-disliked AUC'],
  ['poolNonEnglish', 'Pool non-English'],
  ['ownNonEnglish', 'Own non-English'],
  ['languageGap', 'Wall − own non-English'],
  ['languages', 'Languages on wall'],
  ['genreEntropy', 'Genre entropy (bits)'],
  ['eraFit', 'Era fit vs loved'],
  ['repeatNext', 'Repeat next launch'],
  ['seenShare', 'Seen on wall'],
];

/** One compact row per slice: the questions the reconcile brief asks of every slice. */
const SLICE: [keyof ReaderMetrics, string][] = [
  ['recall', 'R@20'],
  ['recall50', 'R@50'],
  ['poolRecall', 'Pool recall'],
  ['ordering', 'AUC loved>disliked'],
  ['utility', 'Oracle utility'],
  ['languageGap', 'Wall − own non-En'],
  ['servedLanguages', 'Open langs served'],
  ['genreEntropy', 'Genre entropy'],
  ['eraFit', 'Era fit'],
  ['repeatNext', 'Repeat next'],
];

export function renderReport(report: Report, tv?: TvReport): string {
  const lines: string[] = [];
  lines.push('> **SYNTHETIC DATA.** Every number below comes from a generated world whose people, tastes and');
  lines.push('> rankings are assumptions (`evaluation/world.ts`). It shows how the engines behave under that');
  lines.push('> model. It is **not** evidence that any engine is better for real bingd readers.');
  lines.push('');
  lines.push(`Config \`${report.configVersion}\`, world \`${report.worldVersion}\`, seed ${report.seed}, ${report.readers} test readers.`);
  lines.push(`Strata: ${Object.entries(report.strata).map(([s, n]) => `${s} ${n}`).join(', ')}.`);
  lines.push('Each cell is a mean over readers ± a 95% normal-approximation interval; wall metrics average three launch seeds per reader.');
  lines.push('');

  const table = (
    title: string,
    rows: Report['results'] | Report['versusV1'],
    stratum: string,
    ids: string[],
    signed: boolean,
    columns: [keyof ReaderMetrics, string][] = HEADLINE,
  ) => {
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(`| Variant | ${columns.map(([, label]) => label).join(' | ')} |`);
    lines.push(`|---|${columns.map(() => '---').join('|')}|`);
    for (const id of ids) {
      const row = rows[id]?.[stratum];
      if (!row) continue;
      const label = report.variants.find((v) => v.id === id)?.label ?? id;
      lines.push(`| ${label} | ${columns.map(([key]) => fmt(row[key] as Summary | null, key === 'genres' ? 2 : 3, signed)).join(' | ')} |`);
    }
    lines.push('');
  };

  const engines = report.variants.filter((v) => v.group === 'engine').map((v) => v.id);
  const others = report.variants.filter((v) => v.group !== 'engine').map((v) => v.id);
  table('Engines, all readers', report.results, 'all', engines, false);
  table('Engines, all readers: reconcile metrics', report.results, 'all', engines, false, EXTRA);
  table('Engines vs V1, paired differences, all readers', report.versusV1, 'all', engines.filter((id) => id !== 'v1'), true);
  table('Engines vs V1, paired differences, all readers: reconcile metrics', report.versusV1, 'all', engines.filter((id) => id !== 'v1'), true, EXTRA);

  // Every slice in one table per engine pair: absolute V1, then each engine's paired delta.
  const slices = [...Object.keys(report.strata), ...Object.keys(report.activity ?? {})];
  const count = (slice: string) => report.strata[slice] ?? report.activity?.[slice] ?? 0;
  lines.push('### By slice: V1 absolute, then each V2 engine minus V1 (paired)');
  lines.push('');
  lines.push('Activity slices are non-cold-start readers by *visible* ranked titles: sparse ≤ 10, medium 11–30, heavy > 30.');
  lines.push('');
  lines.push(`| Slice (n) | Engine | ${SLICE.map(([, label]) => label).join(' | ')} |`);
  lines.push(`|---|---|${SLICE.map(() => '---').join('|')}|`);
  for (const slice of slices) {
    const v1 = report.results.v1?.[slice];
    if (v1) lines.push(`| ${slice} (${count(slice)}) | V1 | ${SLICE.map(([key]) => fmt(v1[key] as Summary | null)).join(' | ')} |`);
    for (const id of engines.filter((e) => e !== 'v1')) {
      const d = report.versusV1[id]?.[slice];
      if (!d) continue;
      lines.push(`| ${slice} | ${id} − V1 | ${SLICE.map(([key]) => fmt(d[key] as Delta | null, 3, true)).join(' | ')} |`);
    }
  }
  lines.push('');
  for (const stratum of Object.keys(report.strata)) {
    table(`Engines vs V1, paired, stratum \`${stratum}\``, report.versusV1, stratum, engines.filter((id) => id !== 'v1'), true);
  }
  table('Ablations and sweeps vs V2 metadata, paired, all readers', report.versusMetadata, 'all', others, true);
  const diagnostics = report.variants.filter((v) => v.group === 'diagnostic').map((v) => v.id);
  if (diagnostics.length > 0) {
    table('Diagnostics vs V1, paired, all readers (not shipped configurations)', report.versusV1, 'all', diagnostics, true, SLICE);
    for (const stratum of ['cold_start_0', 'cold_start_3', 'cold_start']) {
      if (report.strata[stratum]) {
        table(`Diagnostics vs V1, paired, stratum \`${stratum}\``, report.versusV1, stratum, diagnostics, true, SLICE);
      }
    }
  }

  lines.push('### Following');
  lines.push('');
  lines.push(
    `Giving every reader a different random follow graph changed the wall for ${report.following.v2WallsChanged}/${report.following.readers} readers under V2 hybrid and ${report.following.v1WallsChanged}/${report.following.readers} under V1.`,
  );
  lines.push('');
  lines.push('### Catalogue coverage (distinct titles on first walls ÷ catalogue)');
  lines.push('');
  lines.push(`| Variant | Coverage |`);
  lines.push(`|---|---|`);
  for (const [id, value] of Object.entries(report.catalogueCoverage)) lines.push(`| ${id} | ${value.toFixed(3)} |`);
  lines.push('');
  lines.push('### Collaborative source (real SQL in PGlite)');
  lines.push('');
  const c = report.collaborative;
  lines.push(
    `${c.readersWithEvidence}/${report.readers} readers received collaborative rows; mean ${c.meanRows.toFixed(1)} rows; mean neighbours ${c.meanNeighbours?.toFixed(1) ?? '—'}; mean SQL time ${c.sqlMsMean?.toFixed(0) ?? '—'} ms per first (refreshing) call in single-connection PGlite, which is not production Postgres.`,
  );
  lines.push('');
  const ms = (id: string) => report.results[id]?.all?.ms;
  lines.push(`Client scoring cost per slate (JS, this machine): ${engines.map((id) => `${id} ${fmt(ms(id), 1)} ms`).join('; ')}.`);
  if (tv) lines.push('', renderTv(tv));
  return lines.join('\n');
}

const TV_COLUMNS: [keyof ReaderMetrics, string][] = [
  ['recall', 'R@20'],
  ['recall50', 'R@50'],
  ['poolRecall', 'Pool recall'],
  ['ordering', 'AUC loved>disliked'],
  ['utility', 'Oracle utility'],
  ['nonEnglishShare', 'Non-English'],
  ['servedLanguages', 'Open langs served'],
  ['genreEntropy', 'Genre entropy'],
];

export function renderTv(tv: TvReport): string {
  const lines: string[] = [];
  const label = (id: string) => tv.variants.find((v) => v.id === id)?.label ?? id;
  lines.push('## TV wall: whole-show rankers (synthetic)');
  lines.push('');
  lines.push(
    `${tv.readers} non-cold-start test readers, each evaluated three times with their titles recorded as TV: \`whole_show\` (every ranked title a whole-show ranking — the whole-show-ranker slice), \`by_season\` (one to three seasons each) and \`show_and_seasons\` (the show and two seasons, the double-count case). \`${tv.reference}\` is V2 metadata with the pre-reconcile profile, which ignored whole-show rankings.`,
  );
  lines.push('');
  for (const shape of tv.shapes) {
    lines.push(`### \`${shape}\``);
    lines.push('');
    lines.push(`| Variant | ${TV_COLUMNS.map(([, l]) => l).join(' | ')} |`);
    lines.push(`|---|${TV_COLUMNS.map(() => '---').join('|')}|`);
    for (const { id } of tv.variants) {
      const row = tv.results[shape]?.[id];
      if (row) lines.push(`| ${label(id)} | ${TV_COLUMNS.map(([key]) => fmt(row[key] as Summary | null)).join(' | ')} |`);
    }
    for (const { id } of tv.variants) {
      if (id === 'v1') continue;
      const d = tv.versusV1[shape]?.[id];
      if (d) lines.push(`| ${label(id)} − V1 | ${TV_COLUMNS.map(([key]) => fmt(d[key] as Delta | null, 3, true)).join(' | ')} |`);
    }
    for (const { id } of tv.variants) {
      if (id === tv.reference || id === 'v1') continue;
      const d = tv.versusReference[shape]?.[id];
      if (d) lines.push(`| ${label(id)} − pre-reconcile | ${TV_COLUMNS.map(([key]) => fmt(d[key] as Delta | null, 3, true)).join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
