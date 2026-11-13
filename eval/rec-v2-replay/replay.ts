import { bandSizes, scoreFor } from '@/features/collection/score';
import type { LoggedEntry, RankedEntry } from '@/features/collection/use-collection';
import {
  ANCHOR_BUDGET,
  candidateIdsFrom,
  selectAnchors,
  seriesUnitWeights,
} from '@/features/recommendations/anchors';
import { coverageFill } from '@/features/recommendations/coverage';
import {
  profileFrom,
  sourceDecades,
  sourceLanguages,
} from '@/features/recommendations/profile';
import {
  SLATE_SIZE,
  scoreSlate,
  tasteFrom,
  unitRandom,
  type Anchor,
  type Candidate,
} from '@/features/recommendations/rank';
import { drawSlate } from '@/features/recommendations/selection';
import {
  likedFrom,
  profileEntriesFrom,
  type Medium,
} from '@/features/recommendations/use-for-you';
import { productGenres } from '@/lib/media-metadata';

import {
  validateExport,
  type ReplayExport,
  type ReplayMedia,
  type ReplayRanking,
} from './format';

/**
 * The real-history replay for Recommendation V2 (reconcile, 2026-11-13).
 *
 * For each account, the **last 20% of its positives (Liked rankings) by time** are held out —
 * by ranking day, then by the account's own ranking order — and the account's walls are
 * drawn from the rest: V1 and V2 metadata, through the shipped anchor, taste, profile,
 * coverage, scoring and draw functions, the way `use-for-you.ts` composes them. The sources
 * the server provides are mirrored from the export: TMDB similar lists, trending, followees'
 * Liked titles (`social_candidates`, V1 only) and the catalogue windows
 * (`catalogue_candidates`, V2 only).
 *
 * What it prints is **aggregate only**: per-bucket means with 95% intervals and paired V2 − V1
 * differences, plus the distribution of per-account differences as sorted numbers with no key.
 *
 * Known approximations, printed with the report:
 *
 * - Other accounts' rankings are used whole, including those made after the reader's
 *   held-out ones (the export has days, and cutting everyone at each reader's day would leave
 *   a cohort this small with nothing). This leaks the future the way the predicted-score P2
 *   mode does, equally for both engines.
 * - No dismissals, exposure memory, filters or TMDB fills: the walls are first launches.
 * - V2 hybrid is not replayed. At today's size it is not measurable; instead the report
 *   counts the accounts that could receive any collaborative row at all (≥ 2 taste neighbours
 *   with Match ≥ `MIN_MATCH` on ≥ `MIN_COMMON` shared series, computed with the WS5 Match).
 */

export const HOLDOUT_SHARE = 0.2;
export const LAUNCH_SEEDS = [11, 23, 37] as const;
export const EXTENDED = 50;
/** The defaults `recommendations.neighbour_min_match` and `taste.min_common` ship with. */
export const MIN_MATCH = 55;
export const MIN_COMMON = 5;
export const SHRINK_PRIOR = 5;

/**
 * `v2_metadata+social` is a **diagnostic, not a shipped configuration**: V2 metadata with the
 * follow-graph source V2 removes by design put back, so a gap between V1 and V2 can be
 * attributed to that decision (or not). It is scored exactly as V2 metadata.
 */
type Engine = 'v1' | 'v2_metadata' | 'v2_metadata+social';
export const ENGINES: Engine[] = ['v1', 'v2_metadata', 'v2_metadata+social'];

export type Metrics = {
  recall20: number | null;
  recall50: number | null;
  poolRecall: number | null;
  nonEnglishShare: number;
  ownNonEnglish: number | null;
  languages: number;
  genreEntropy: number;
  seenShare: number;
  poolSize: number;
};
const KEYS: (keyof Metrics)[] = [
  'recall20',
  'recall50',
  'poolRecall',
  'nonEnglishShare',
  'ownNonEnglish',
  'languages',
  'genreEntropy',
  'seenShare',
  'poolSize',
];

type Account = {
  key: number;
  visible: ReplayRanking[];
  logged: { m: string; b: ReplayRanking['b'] | null }[];
  /** Held-out positives, by wall: film ids, and show ids (a season's show, or the show). */
  held: { movies: Set<string>; tv: Set<string> };
};

export type Bucket = 'sparse' | 'medium' | 'heavy';
const bucketOf = (visible: number): Bucket =>
  visible <= 10 ? 'sparse' : visible <= 30 ? 'medium' : 'heavy';

// ---------------------------------------------------------------------------
// Holdout
// ---------------------------------------------------------------------------

/** Positions renumbered 1..n per category, keeping the account's own order. */
function renumber(rows: readonly ReplayRanking[]): ReplayRanking[] {
  const out: ReplayRanking[] = [];
  for (const category of ['movies', 'tv_seasons', 'tv_shows'] as const) {
    rows
      .filter((r) => r.c === category)
      .sort((a, b) => a.p - b.p)
      .forEach((r, i) => out.push({ ...r, p: i + 1 }));
  }
  return out;
}

export function holdOut(doc: ReplayExport): { accounts: Account[]; skipped: number } {
  const media = new Map(doc.media.map((m) => [m.m, m]));
  const byUser = new Map<number, ReplayRanking[]>();
  for (const r of doc.rankings) byUser.set(r.u, [...(byUser.get(r.u) ?? []), r]);
  const loggedBy = new Map<number, Account['logged']>();
  for (const l of doc.logged)
    loggedBy.set(l.u, [...(loggedBy.get(l.u) ?? []), { m: l.m, b: l.b }]);
  const accounts: Account[] = [];
  let skipped = 0;
  for (const [key, rows] of byUser) {
    const byTime = [...rows].sort((a, b) => a.day - b.day || a.seq - b.seq);
    const positives = byTime.filter((r) => r.b === 'loved');
    if (positives.length < 2) {
      skipped += 1;
      continue;
    }
    const count = Math.max(1, Math.round(positives.length * HOLDOUT_SHARE));
    const heldRows = positives.slice(-count);
    const heldIds = new Set(heldRows.map((r) => r.m));
    const held = { movies: new Set<string>(), tv: new Set<string>() };
    for (const r of heldRows) {
      const item = media.get(r.m);
      if (!item) continue;
      if (item.kind === 'movie') held.movies.add(item.m);
      else held.tv.add(item.kind === 'season' ? (item.parent ?? item.m) : item.m);
    }
    const visible = renumber(rows.filter((r) => !heldIds.has(r.m)));
    const loggedVisible = (loggedBy.get(key) ?? []).filter((l) => !heldIds.has(l.m));
    // A held-out season of a show the reader still visibly has (another season, or the show
    // itself) can never reach the TV wall: the show is met, so it is excluded. Counting it as a
    // miss would charge both engines for the exclusion, so it is not a target.
    for (const id of [...visible.map((r) => r.m), ...loggedVisible.map((l) => l.m)]) {
      const m = media.get(id);
      held.tv.delete(m?.kind === 'season' && m.parent ? m.parent : id);
    }
    accounts.push({ key, visible, logged: loggedVisible, held });
  }
  return { accounts, skipped };
}

// ---------------------------------------------------------------------------
// The client's inputs, from the export
// ---------------------------------------------------------------------------

type World = {
  doc: ReplayExport;
  media: Map<string, ReplayMedia>;
  similar: Map<string, string[]>;
  trending: Map<string, string[]>;
  rankingsBy: Map<number, ReplayRanking[]>;
  follows: Map<number, number[]>;
  catalogue: { movie: ReplayMedia[]; series: ReplayMedia[] };
};

export function worldOf(doc: ReplayExport): World {
  const media = new Map(doc.media.map((m) => [m.m, m]));
  const rankingsBy = new Map<number, ReplayRanking[]>();
  for (const r of doc.rankings) rankingsBy.set(r.u, [...(rankingsBy.get(r.u) ?? []), r]);
  const follows = new Map<number, number[]>();
  for (const f of doc.follows)
    follows.set(f.follower, [...(follows.get(f.follower) ?? []), f.followee]);
  const tiles = (kind: 'movie' | 'series') =>
    doc.media
      .filter((m) => m.kind === kind && m.tile)
      .sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1));
  return {
    doc,
    media,
    similar: new Map(doc.similar.map((s) => [s.m, s.ids])),
    trending: new Map(doc.trending.map((t) => [t.list, t.ids])),
    rankingsBy,
    follows,
    catalogue: { movie: tiles('movie'), series: tiles('series') },
  };
}

const genresOf = (m: ReplayMedia, w: World): string[] => {
  // A season's genres are its show's (`resolveMetadata`); the product vocabulary on both sides.
  const source = m.kind === 'season' && m.parent ? (w.media.get(m.parent) ?? m) : m;
  return productGenres({
    kind: m.kind,
    genres: source.genres,
    language: source.lang ?? m.lang,
  });
};

function rankedEntry(r: ReplayRanking, w: World): RankedEntry | null {
  const m = w.media.get(r.m);
  if (!m) return null;
  return {
    mediaItemId: m.m,
    title: m.m,
    year: m.year,
    posterPath: null,
    genres: genresOf(m, w),
    runtimeMinutes: null,
    kind: m.kind,
    seriesTitle: null,
    seriesId: m.kind === 'season' ? m.parent : null,
    language: m.lang,
    bucket: r.b,
    position: r.p,
    category: r.c,
    rankedAt: null,
  };
}

function loggedEntry(l: Account['logged'][number], w: World): LoggedEntry | null {
  const m = w.media.get(l.m);
  if (!m) return null;
  return {
    mediaItemId: m.m,
    title: m.m,
    year: m.year,
    posterPath: null,
    genres: genresOf(m, w),
    runtimeMinutes: null,
    kind: m.kind,
    seriesTitle: null,
    seriesId: m.kind === 'season' ? m.parent : null,
    language: m.lang,
    bucket: l.b ?? null,
    watchedOn: null,
    addedAt: null,
  };
}

const candidateOf = (m: ReplayMedia, w: World): Candidate => ({
  mediaItemId: m.m,
  title: m.m,
  year: m.year,
  posterPath: `/${m.m}.jpg`,
  kind: m.kind === 'series' ? 'series' : 'movie',
  genres: genresOf(m, w),
  language: m.lang,
  popularity: m.popularity,
});

/** Everything the reader has met, as the wall's ids: films, and shows met whole or by a season. */
function metOf(account: Account, w: World): Set<string> {
  const met = new Set<string>();
  for (const id of [...account.visible.map((r) => r.m), ...account.logged.map((l) => l.m)]) {
    met.add(id);
    const m = w.media.get(id);
    if (m?.kind === 'season' && m.parent) met.add(m.parent);
  }
  return met;
}

/** `social_candidates`, mirrored: followees' Liked titles (seasons as their show), most endorsed first. */
function socialMirror(
  account: Account,
  w: World,
  medium: Medium,
  met: ReadonlySet<string>,
): string[] {
  const counts = new Map<string, number>();
  for (const followee of w.follows.get(account.key) ?? []) {
    const seen = new Set<string>();
    for (const r of w.rankingsBy.get(followee) ?? []) {
      if (r.b !== 'loved') continue;
      const m = w.media.get(r.m);
      if (!m) continue;
      const id =
        medium === 'movies'
          ? m.kind === 'movie'
            ? m.m
            : null
          : m.kind === 'season'
            ? m.parent
            : m.kind === 'series'
              ? m.m
              : null;
      if (!id || met.has(id) || seen.has(id)) continue;
      seen.add(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 40)
    .map(([id]) => id);
}

/** `catalogue_candidates`, mirrored: per language and decade, `per` drawn by seed from the top `3 × per`. */
function catalogueMirror(
  w: World,
  kind: 'movie' | 'series',
  languages: readonly string[],
  decades: readonly number[],
  met: ReadonlySet<string>,
  seed: number,
  per = 20,
): Candidate[] {
  const draw = (pool: ReplayMedia[]) =>
    pool
      .filter((m) => !met.has(m.m))
      .slice(0, per * 3)
      .sort((a, b) => unitRandom(seed, a.m) - unitRandom(seed, b.m))
      .slice(0, per);
  const out = new Map<string, Candidate>();
  for (const language of languages.slice(0, 5)) {
    for (const m of draw(w.catalogue[kind].filter((c) => c.lang === language)))
      out.set(m.m, candidateOf(m, w));
  }
  for (const decade of decades.slice(0, 3)) {
    for (const m of draw(
      w.catalogue[kind].filter(
        (c) => c.year != null && Math.floor(c.year / 10) * 10 === decade,
      ),
    )) {
      out.set(m.m, candidateOf(m, w));
    }
  }
  return [...out.values()];
}

const TRENDING: Record<Medium, string[]> = {
  movies: ['trending.movie.week'],
  tv: ['trending.series.week', 'trending.series.day'],
};

// ---------------------------------------------------------------------------
// One wall
// ---------------------------------------------------------------------------

function wall(account: Account, w: World, medium: Medium, engine: Engine, seed: number) {
  const kind = medium === 'movies' ? 'movie' : 'series';
  const entries = account.visible
    .map((r) => rankedEntry(r, w))
    .filter((e): e is RankedEntry => e != null);
  const pools = {
    movies: entries.filter((e) => e.category === 'movies'),
    tv_seasons: entries.filter((e) => e.category === 'tv_seasons'),
    tv_shows: entries.filter((e) => e.category === 'tv_shows'),
  };
  const sizes = {
    movies: bandSizes(pools.movies),
    tv_seasons: bandSizes(pools.tv_seasons),
    tv_shows: bandSizes(pools.tv_shows),
  };
  const signals = [...pools.movies, ...pools.tv_seasons, ...pools.tv_shows];
  const weights = seriesUnitWeights(signals);
  const taste = tasteFrom(
    signals.map((e) => ({
      score: scoreFor(e.bucket, e.position, sizes[e.category as keyof typeof sizes]),
      genres: e.genres,
      language: e.language,
      weight: weights.get(e.mediaItemId) ?? 1,
    })),
  );
  const logged = account.logged
    .map((l) => loggedEntry(l, w))
    .filter((e): e is LoggedEntry => e != null);
  const v2 = engine !== 'v1';
  const profile = v2
    ? profileFrom(profileEntriesFrom(pools.movies, pools.tv_seasons, logged, pools.tv_shows))
    : undefined;
  const liked = likedFrom(
    medium === 'movies' ? pools.movies : [...pools.tv_seasons, ...pools.tv_shows],
    medium,
  );
  const withLists = new Set(
    liked
      .filter((l) => (w.similar.get(l.mediaItemId)?.length ?? 0) > 0)
      .map((l) => l.mediaItemId),
  );
  const chosen = selectAnchors(liked, {
    seed,
    budget: ANCHOR_BUDGET,
    cached: withLists,
    languages: v2,
  });
  const anchors: Anchor[] = chosen.map((a) => ({
    mediaItemId: a.mediaItemId,
    title: a.title,
    score: a.score,
    similarIds: w.similar.get(a.mediaItemId) ?? [],
  }));
  const met = metOf(account, w);
  const social = engine === 'v2_metadata' ? [] : socialMirror(account, w, medium, met);
  const anchored = anchors.filter((a) => a.similarIds.length > 0).length;
  const lists = medium === 'tv' && anchored > 0 ? TRENDING.tv.slice(0, 1) : TRENDING[medium];
  const trending = [...new Set(lists.flatMap((key) => w.trending.get(key) ?? []))];
  const ids = candidateIdsFrom(anchors, social, trending);
  const listed = ids
    .map((id) => w.media.get(id))
    .filter((m): m is ReplayMedia => m != null && m.tile && m.kind === kind)
    .map((m) => candidateOf(m, w));
  let filled: Candidate[] = [];
  if (profile) {
    const request = {
      kind,
      languages: sourceLanguages(profile),
      decades: sourceDecades(profile, kind),
    } as const;
    filled = coverageFill(
      listed,
      catalogueMirror(w, kind, request.languages, request.decades, met, seed),
      profile,
      request,
      new Set([...met, ...anchors.map((a) => a.mediaItemId)]),
    );
  }
  const scored = scoreSlate({
    candidates: [...listed, ...filled],
    anchors,
    taste,
    exclude: new Set(met),
    engine: v2 ? 'v2_metadata' : 'v1',
    profile,
  });
  const drawn = drawSlate(scored, {
    pageSize: SLATE_SIZE,
    pages: Math.ceil(EXTENDED / SLATE_SIZE),
    seed: seed * 7919,
    now: 0,
  });
  return { scored, extended: drawn.slice(0, EXTENDED), wall: drawn.slice(0, SLATE_SIZE), met };
}

const entropy = (lists: readonly (readonly string[])[]) => {
  const mass = new Map<string, number>();
  let total = 0;
  for (const g of lists) {
    if (g.length === 0) continue;
    for (const x of g) mass.set(x, (mass.get(x) ?? 0) + 1 / g.length);
    total += 1;
  }
  let h = 0;
  for (const v of mass.values()) h -= (v / total) * Math.log2(v / total);
  return total ? h : 0;
};

function measure(account: Account, w: World, medium: Medium, engine: Engine): Metrics {
  const relevant = account.held[medium];
  const sums = new Map<keyof Metrics, number>();
  const add = (k: keyof Metrics, v: number | null) => {
    if (v != null) sums.set(k, (sums.get(k) ?? 0) + v);
  };
  const own = [...account.visible.map((r) => r.m), ...account.logged.map((l) => l.m)]
    .map((id) => w.media.get(id))
    .filter((m): m is ReplayMedia => m != null);
  const ownNonEnglish = own.length
    ? own.filter((m) => m.lang && m.lang !== 'en').length / own.length
    : null;
  for (const seed of LAUNCH_SEEDS) {
    const { scored, extended, wall: items, met } = wall(account, w, medium, engine, seed);
    const n = Math.max(1, items.length);
    if (relevant.size > 0) {
      add(
        'recall20',
        items.filter((s) => relevant.has(s.mediaItemId)).length /
          Math.min(relevant.size, SLATE_SIZE),
      );
      add(
        'recall50',
        extended.filter((s) => relevant.has(s.mediaItemId)).length /
          Math.min(relevant.size, EXTENDED),
      );
      const pool = new Set(scored.map((s) => s.mediaItemId));
      add('poolRecall', [...relevant].filter((id) => pool.has(id)).length / relevant.size);
    }
    const langs = items.map((s) => w.media.get(s.mediaItemId)?.lang ?? null);
    add('nonEnglishShare', langs.filter((l) => l && l !== 'en').length / n);
    add('ownNonEnglish', ownNonEnglish);
    add('languages', new Set(langs.filter(Boolean)).size);
    add('genreEntropy', entropy(items.map((s) => s.genres ?? [])));
    add('seenShare', items.filter((s) => met.has(s.mediaItemId)).length / n);
    add('poolSize', scored.length);
  }
  const out = {} as Metrics;
  for (const k of KEYS) {
    const v = sums.get(k);
    (out as Record<string, number | null>)[k] = v == null ? null : v / LAUNCH_SEEDS.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hybrid coverage: who could receive any collaborative row at all
// ---------------------------------------------------------------------------

/** One account's rankings as `_scored_rankings` returns them: id → 0–10 score, 1 decimal. */
function scoresOf(rows: readonly ReplayRanking[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const category of ['movies', 'tv_seasons', 'tv_shows'] as const) {
    const pool = rows.filter((r) => r.c === category).sort((a, b) => a.p - b.p);
    const sizes = bandSizes(pool.map((r) => ({ bucket: r.b })));
    for (const r of pool) out.set(r.m, Math.round(scoreFor(r.b, r.p, sizes) * 10) / 10);
  }
  return out;
}

const midranks = (values: readonly number[]) => {
  const sorted = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]![0] === sorted[i]![0]) j += 1;
    for (let k = i; k <= j; k += 1) out[sorted[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
};

/**
 * `taste_match` / `_taste_matches` (WS5, 20261114000400) in JS: exact matching, one series one
 * unit, weighted gap and weighted midrank correlation, the n/(n+p) shrink. Null below MIN_COMMON.
 */
export function tasteMatch(
  mine: ReadonlyMap<string, number>,
  theirs: ReadonlyMap<string, number>,
  unitOf: (id: string) => string,
): { score: number | null; units: number } {
  const common = [...mine]
    .filter(([id]) => theirs.has(id))
    .map(([id, a]) => ({ a, b: theirs.get(id)!, unit: unitOf(id) }));
  const units = new Set(common.map((c) => c.unit)).size;
  if (units < MIN_COMMON) return { score: null, units };
  const per = new Map<string, number>();
  for (const c of common) per.set(c.unit, (per.get(c.unit) ?? 0) + 1);
  const w = common.map((c) => 1 / per.get(c.unit)!);
  const ra = midranks(common.map((c) => c.a));
  const rb = midranks(common.map((c) => c.b));
  const sw = w.reduce((s, x) => s + x, 0);
  const gap = common.reduce((s, c, i) => s + w[i]! * Math.abs(c.a - c.b), 0) / sw;
  const mx = ra.reduce((s, x, i) => s + w[i]! * x, 0) / sw;
  const my = rb.reduce((s, x, i) => s + w[i]! * x, 0) / sw;
  const vx = ra.reduce((s, x, i) => s + w[i]! * (x - mx) ** 2, 0);
  const vy = rb.reduce((s, x, i) => s + w[i]! * (x - my) ** 2, 0);
  const rho =
    vx > 0 && vy > 0
      ? ra.reduce((s, x, i) => s + w[i]! * (x - mx) * (rb[i]! - my), 0) / Math.sqrt(vx * vy)
      : null;
  const proximity = Math.max(0, Math.min(100, 100 * (1 - gap / 7)));
  const agreement = rho == null ? null : 50 * (rho + 1);
  const blend = 0.25 * Math.max(0, Math.min(1, (units - 8) / 12));
  const raw = agreement == null ? proximity : (1 - blend) * proximity + blend * agreement;
  return { score: Math.round(50 + (raw - 50) * (units / (units + SHRINK_PRIOR))), units };
}

export function hybridCoverage(accounts: readonly Account[], w: World) {
  const unitOf = (id: string) => {
    const m = w.media.get(id);
    return m?.kind === 'season' && m.parent ? m.parent : id;
  };
  const publicUsers = w.doc.users.filter((u) => u.visibility === 'public').map((u) => u.u);
  const theirScores = new Map(publicUsers.map((u) => [u, scoresOf(w.rankingsBy.get(u) ?? [])]));
  let one = 0;
  let two = 0;
  const neighbourCounts: number[] = [];
  for (const account of accounts) {
    const mine = scoresOf(account.visible);
    let neighbours = 0;
    for (const u of publicUsers) {
      if (u === account.key) continue;
      const { score } = tasteMatch(mine, theirScores.get(u)!, unitOf);
      if (score != null && score > MIN_MATCH) neighbours += 1;
    }
    neighbourCounts.push(neighbours);
    if (neighbours >= 1) one += 1;
    if (neighbours >= 2) two += 1;
  }
  return { accounts: accounts.length, withOne: one, withTwo: two, neighbourCounts };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

type Summary = { mean: number; ci: number; n: number };
const summarise = (xs: readonly (number | null)[]): Summary | null => {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance =
    v.length > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1) : 0;
  return { mean, ci: 1.96 * Math.sqrt(variance / v.length), n: v.length };
};
const fmt = (s: Summary | null, signed = false, digits = 3) =>
  s == null
    ? '—'
    : `${signed && s.mean >= 0 ? '+' : ''}${s.mean.toFixed(digits)} ± ${s.ci.toFixed(digits)} (n=${s.n})`;

export type ReplayReport = {
  accounts: number;
  skipped: number;
  /** wall → bucket → engine → metric → summary; and the paired V2 − V1 delta */
  results: Record<
    string,
    Record<string, Record<string, Partial<Record<keyof Metrics, Summary | null>>>>
  >;
  deltas: Record<
    string,
    Record<string, Record<string, Partial<Record<keyof Metrics, Summary | null>>>>
  >;
  /** Sorted per-account V2 − V1 recall@50 differences, per wall. No keys. */
  perAccount: Record<string, number[]>;
  buckets: Record<string, number>;
  hybrid: ReturnType<typeof hybridCoverage>;
};

/** Whole-show rankers: accounts whose visible TV rankings are mostly (≥ half) whole shows. */
const wholeShowRanker = (a: Account) => {
  const shows = a.visible.filter((r) => r.c === 'tv_shows').length;
  const seasons = a.visible.filter((r) => r.c === 'tv_seasons').length;
  return shows > 0 && shows >= seasons;
};

export function replay(input: unknown): ReplayReport {
  const doc = validateExport(input);
  const w = worldOf(doc);
  const { accounts, skipped } = holdOut(doc);
  const sliceOf = (a: Account) => [
    'all',
    bucketOf(a.visible.length),
    ...(wholeShowRanker(a) ? ['whole_show_rankers'] : []),
  ];
  const slices = ['all', 'sparse', 'medium', 'heavy', 'whole_show_rankers'];
  const results: ReplayReport['results'] = {};
  const deltas: ReplayReport['deltas'] = {};
  const perAccount: ReplayReport['perAccount'] = {};
  for (const medium of ['movies', 'tv'] as Medium[]) {
    const per = new Map<Engine, Metrics[]>(
      ENGINES.map((e) => [e, accounts.map((a) => measure(a, w, medium, e))]),
    );
    results[medium] = {};
    deltas[medium] = {};
    for (const slice of slices) {
      const idx = accounts
        .map((a, i) => (sliceOf(a).includes(slice) ? i : -1))
        .filter((i) => i >= 0);
      if (!idx.length) continue;
      results[medium]![slice] = {};
      for (const engine of ENGINES) {
        const row: Partial<Record<keyof Metrics, Summary | null>> = {};
        for (const k of KEYS) row[k] = summarise(idx.map((i) => per.get(engine)![i]![k]));
        results[medium]![slice]![engine] = row;
      }
      deltas[medium]![slice] = {};
      for (const engine of ENGINES.filter((e) => e !== 'v1')) {
        const d: Partial<Record<keyof Metrics, Summary | null>> = {};
        for (const k of KEYS) {
          d[k] = summarise(
            idx.map((i) => {
              const a = per.get(engine)![i]![k];
              const b = per.get('v1')![i]![k];
              return a == null || b == null ? null : a - b;
            }),
          );
        }
        deltas[medium]![slice]![engine] = d;
      }
    }
    perAccount[medium] = accounts
      .map((_, i) => {
        const a = per.get('v2_metadata')![i]!.recall50;
        const b = per.get('v1')![i]!.recall50;
        return a == null || b == null ? null : Math.round((a - b) * 1000) / 1000;
      })
      .filter((x): x is number => x != null)
      .sort((a, b) => a - b);
  }
  const buckets: Record<string, number> = {};
  for (const a of accounts) for (const s of sliceOf(a)) buckets[s] = (buckets[s] ?? 0) + 1;
  return {
    accounts: accounts.length,
    skipped,
    results,
    deltas,
    perAccount,
    buckets,
    hybrid: hybridCoverage(accounts, w),
  };
}

const COLUMNS: [keyof Metrics, string][] = [
  ['recall20', 'R@20'],
  ['recall50', 'R@50'],
  ['poolRecall', 'Pool recall'],
  ['nonEnglishShare', 'Non-English'],
  ['ownNonEnglish', 'Own non-English'],
  ['languages', 'Languages'],
  ['genreEntropy', 'Genre entropy'],
  ['seenShare', 'Seen on wall'],
  ['poolSize', 'Pool size'],
];

/** Every value, sorted, when there are few (today's cohort); otherwise quantiles. Never a key. */
function distribution(sorted: readonly number[]): string {
  if (sorted.length === 0) return 'no values';
  if (sorted.length <= 60) return `values ${sorted.join(', ')}`;
  const q = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return `min ${sorted[0]}, p10 ${q(0.1)}, p25 ${q(0.25)}, median ${q(0.5)}, p75 ${q(0.75)}, p90 ${q(0.9)}, max ${sorted[sorted.length - 1]}`;
}

export function renderReplay(report: ReplayReport, label: string): string {
  const lines: string[] = [];
  lines.push(`# Recommendation V2 replay: ${label}`);
  lines.push('');
  lines.push(
    `${report.accounts} accounts replayed (${report.skipped} skipped with fewer than two Liked rankings). The last ${HOLDOUT_SHARE * 100}% of each account's Liked rankings by time is held out; launch seeds ${LAUNCH_SEEDS.join(', ')} averaged. Aggregates only: no account key, title or id is printed.`,
  );
  lines.push('');
  lines.push(
    `Slices: ${Object.entries(report.buckets)
      .map(([k, n]) => `${k} ${n}`)
      .join(
        ', ',
      )}. Sparse ≤ 10 visible rankings, medium 11–30, heavy > 30; whole-show rankers have at least as many visible whole-show rankings as season rankings.`,
  );
  lines.push('');
  for (const medium of Object.keys(report.results)) {
    lines.push(`## ${medium === 'movies' ? 'Films' : 'TV'} wall`);
    lines.push('');
    lines.push(`| Slice | Engine | ${COLUMNS.map(([, l]) => l).join(' | ')} |`);
    lines.push(`|---|---|${COLUMNS.map(() => '---').join('|')}|`);
    for (const [slice, engines] of Object.entries(report.results[medium]!)) {
      for (const [engine, row] of Object.entries(engines)) {
        lines.push(
          `| ${slice} | ${engine} | ${COLUMNS.map(([k]) => fmt(row[k] ?? null)).join(' | ')} |`,
        );
      }
      for (const [engine, d] of Object.entries(report.deltas[medium]![slice]!)) {
        lines.push(
          `| ${slice} | ${engine} − v1 | ${COLUMNS.map(([k]) => fmt(d[k] ?? null, true)).join(' | ')} |`,
        );
      }
    }
    lines.push('');
    const xs = report.perAccount[medium]!;
    lines.push(
      `Per-account V2 − V1 recall@50 (no keys; n=${xs.length}): worse ${xs.filter((x) => x < 0).length}, same ${xs.filter((x) => x === 0).length}, better ${xs.filter((x) => x > 0).length}. ${distribution(xs)}.`,
    );
    lines.push('');
  }
  const h = report.hybrid;
  lines.push('## V2 hybrid');
  lines.push('');
  lines.push(
    `**Not measurable at current scale.** A collaborative row needs at least two taste neighbours (Match > ${MIN_MATCH} on ≥ ${MIN_COMMON} shared series, public accounts). Pool coverage: ${h.withTwo}/${h.accounts} accounts have two or more such neighbours, ${h.withOne}/${h.accounts} have one or more. Neighbours per account (no keys): ${distribution([...h.neighbourCounts].sort((a, b) => a - b))}.`,
  );
  lines.push('');
  lines.push(
    '`v2_metadata+social` is a diagnostic, not a shipped configuration: V2 metadata with the follow-graph source put back, to attribute a V1 − V2 gap.',
  );
  lines.push('');
  lines.push(
    'Approximations: other accounts are used whole (future leakage, equal for both engines); first launches only (no dismissals, exposure memory, filters or TMDB fills); server sources are mirrored, not called.',
  );
  return lines.join('\n');
}
