/**
 * Seeded synthetic snapshots, for the tests and for the example report.
 *
 * People have genre tastes and titles have genres and a latent quality. Each person watches
 * what is popular and what suits them (so the data carries the same selection bias as the
 * real thing), and ranks what they watched by how much they liked it. Some placements are
 * later "corrected", which resets `created_at` exactly as a correction does on main before T0.
 * That contamination is what P1's label flags exist to catch.
 *
 * Nothing here is real, and nothing about a real snapshot is inferred from it.
 */

import type { Bucket } from '@/features/collection/score';

import { hash32, mulberry32 } from './random';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type Category,
  type Snapshot,
  type SnapshotMedia,
  type SnapshotRanking,
  type SnapshotStar,
  type SnapshotUser,
} from './snapshot';

const GENRES = [
  'Drama',
  'Comedy',
  'Thriller',
  'Horror',
  'Romance',
  'Science Fiction',
  'Animation',
  'Documentary',
  'Action',
  'Crime',
];
const LANGS = ['en', 'en', 'en', 'en', 'en', 'en', 'fr', 'ja', 'ko', 'es'];
const DAY = 86_400_000_000;
const HOUR = 3_600_000_000;

export type SyntheticOptions = {
  seed: number;
  movies: number;
  series: number;
  /** Library size per person, in movies. One entry per person. */
  movieLibraries: number[];
  /** Seasons ranked per person. One entry per person, or missing for none. */
  seasonLibraries?: number[];
  /** Standard deviation of the noise between taste and opinion. */
  noise: number;
  /** Share of placements later corrected, resetting `created_at`. */
  correctedShare: number;
  importerShare: number;
  includeStars: boolean;
};

/** A cohort shaped like the documented 2026-09-13 production aggregate: sparse. */
export function productionLikeOptions(seed = 7): SyntheticOptions {
  const random = mulberry32(seed);
  // 2026-09-13: twelve at exactly five, then 6–24, three at 52–59 and one at 112. Seven
  // raters reached ten films, so three of the fifteen in the middle do.
  const middle = Array.from({ length: 15 }, (_, i) =>
    i < 3 ? 10 + Math.floor(random() * 15) : 6 + Math.floor(random() * 4),
  );
  const movieLibraries = [...Array<number>(12).fill(5), ...middle, 52, 55, 59, 112];
  const seasonLibraries = movieLibraries.map((_, i) =>
    i === 27 ? 14 : i === 28 ? 11 : i === 29 ? 10 : i % 4 === 0 ? 2 : 0,
  );
  return {
    seed,
    movies: 420,
    series: 60,
    movieLibraries,
    seasonLibraries,
    noise: 0.6,
    correctedShare: 0.06,
    importerShare: 0.15,
    includeStars: false,
  };
}

/** A cohort large and dense enough for every metric to be computed. For the example report. */
export function richOptions(seed = 11, people = 60): SyntheticOptions {
  const random = mulberry32(seed);
  return {
    seed,
    movies: 360,
    series: 50,
    movieLibraries: Array.from({ length: people }, () => 25 + Math.floor(random() * 70)),
    seasonLibraries: Array.from({ length: people }, () =>
      random() < 0.5 ? 6 + Math.floor(random() * 14) : 0,
    ),
    noise: 0.45,
    correctedShare: 0.06,
    importerShare: 0.3,
    includeStars: true,
  };
}

const keyFor = (seed: number, kind: string, i: number): string => {
  const a = hash32(`${seed}|${kind}|${i}|a`).toString(16).padStart(8, '0');
  const b = hash32(`${seed}|${kind}|${i}|b`).toString(16).padStart(8, '0');
  const c = hash32(`${seed}|${kind}|${i}|c`).toString(16).padStart(8, '0');
  return (a + b + c).slice(0, 20);
};

type Title = SnapshotMedia & { quality: number };

export function syntheticSnapshot(o: SyntheticOptions): Snapshot {
  const random = mulberry32(o.seed);
  const normal = () => {
    const u = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const genresOf = () => {
    const count = 1 + Math.floor(random() * 3);
    const set = new Set<string>();
    while (set.size < count) set.add(pick(GENRES));
    return [...set];
  };
  const shuffle = <T>(xs: T[]): T[] => {
    for (let i = xs.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  };
  const popularity = () => Math.round(Math.exp(3 + normal()) * 10) / 10;

  const movies: Title[] = Array.from({ length: o.movies }, (_, i) => ({
    m: keyFor(o.seed, 'movie', i),
    kind: 'movie',
    parent: null,
    season: null,
    genres: genresOf(),
    lang: pick(LANGS),
    year: 2026 - Math.floor(Math.abs(normal()) * 20),
    popularity: popularity(),
    quality: normal(),
  }));
  const series: Title[] = [];
  const seasons: Title[] = [];
  for (let i = 0; i < o.series; i += 1) {
    const show: Title = {
      m: keyFor(o.seed, 'series', i),
      kind: 'series',
      parent: null,
      season: null,
      genres: genresOf(),
      lang: pick(LANGS),
      year: 2026 - Math.floor(Math.abs(normal()) * 12),
      popularity: popularity(),
      quality: normal(),
    };
    series.push(show);
    const count = 1 + Math.floor(random() * 4);
    for (let s = 1; s <= count; s += 1) {
      seasons.push({
        ...show,
        m: keyFor(o.seed, `season${i}`, s),
        kind: 'season',
        parent: show.m,
        season: s,
        year: (show.year ?? 2020) + s - 1,
        quality: show.quality + normal() * 0.35,
      });
    }
  }

  // TMDB-like association lists: titles sharing genres, with noise, for movies and series.
  const similar = [...movies, ...series].map((t) => {
    const pool = t.kind === 'movie' ? movies : series;
    const scored = pool
      .filter((x) => x.m !== t.m)
      .map((x) => ({
        m: x.m,
        s: x.genres.filter((g) => t.genres.includes(g)).length + random() * 1.5,
      }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 12);
    return { m: t.m, ids: scored.map((x) => x.m) };
  });

  const exportedAt = 1_789_000_000_000_000;
  const users: SnapshotUser[] = [];
  const rankings: SnapshotRanking[] = [];
  const stars: SnapshotStar[] = [];
  const people = o.movieLibraries.length;
  const keys = Array.from({ length: people }, (_, i) => keyFor(o.seed, 'user', i));

  keys.forEach((u, i) => {
    const affinity = new Map(GENRES.map((g) => [g, normal() * 0.9] as const));
    // People watch what suits them, so their watched titles skew high. These thresholds put
    // roughly half to two thirds of a list in the top band, which is loved-heavy like a real
    // list without making the M0 prior trivially right.
    const lovedAt = 0.75 + normal() * 0.3;
    const dislikedAt = lovedAt - 0.9 - Math.abs(normal()) * 0.3;
    const taste = (t: Title) =>
      t.quality + t.genres.reduce((s, g) => s + (affinity.get(g) ?? 0), 0) / t.genres.length;
    const bucketOf = (utility: number): Bucket =>
      utility >= lovedAt ? 'loved' : utility >= dislikedAt ? 'fine' : 'not_for_me';
    const joined = exportedAt - Math.floor((10 + random() * 50) * DAY);
    const importer = random() < o.importerShare;

    // Watch what is popular and what suits you: the selection bias the real data has.
    const watch = (pool: readonly Title[], count: number) => {
      const chosen: Title[] = [];
      const left = [...pool];
      while (chosen.length < count && left.length > 0) {
        const weights = left.map(
          (t) => Math.pow(t.popularity ?? 1, 0.6) * Math.exp(0.8 * taste(t)),
        );
        let r = random() * weights.reduce((s, w) => s + w, 0);
        let index = 0;
        while (index < left.length - 1 && r > weights[index]!) r -= weights[index++]!;
        chosen.push(left.splice(index, 1)[0]!);
      }
      return chosen;
    };

    const place = (titles: readonly Title[], c: Category) => {
      const scored = titles.map((t) => ({ t, utility: taste(t) + normal() * o.noise }));
      const byOpinion = [...scored].sort((a, b) => b.utility - a.utility);
      // The order they were placed in: the most popular five first (onboarding), then random.
      const byTime = [...scored].sort((a, b) => (b.t.popularity ?? 0) - (a.t.popularity ?? 0));
      const firstFive = byTime.slice(0, 5);
      const rest = shuffle(byTime.slice(5));
      let clock = joined;
      const placedAt = new Map<string, number>();
      for (const s of [...firstFive, ...rest]) {
        clock += Math.floor(random() * 2 * DAY) + 10_000_000;
        placedAt.set(s.t.m, Math.min(clock, exportedAt - HOUR));
      }
      const ordered = [...firstFive, ...rest];
      byOpinion.forEach((s, index) => {
        const t = placedAt.get(s.t.m)!;
        const bucket = bucketOf(s.utility);
        const earlierInBand = ordered.filter(
          (x) => placedAt.get(x.t.m)! < t && bucketOf(x.utility) === bucket,
        ).length;
        const corrected = random() < o.correctedShare;
        const window =
          earlierInBand === 0 || random() < 0.08
            ? 0
            : Math.ceil(Math.log2(earlierInBand + 1)) + (random() < 0.05 ? 1 : 0);
        const resetTo = corrected ? t + Math.floor(random() * (exportedAt - t)) : t;
        rankings.push({
          u,
          m: s.t.m,
          c,
          b: bucket,
          p: index + 1,
          t: resetTo,
          cmp_window: corrected ? Math.ceil(Math.log2(earlierInBand + 2)) : window,
          cmp_earlier: corrected ? Math.max(1, window) : 0,
          cmp_later: Math.floor(random() * 3),
          // A corrected title was first compared at its original placement, before the reset.
          cmp_first: corrected || window > 0 ? t - HOUR : null,
          imported: false,
        });
        if (importer && c === 'movies' && o.includeStars && random() < 0.7) {
          const star = Math.min(
            5,
            Math.max(0.5, Math.round((3.2 + 1.1 * (s.utility - lovedAt)) * 2) / 2),
          );
          stars.push({ u, m: s.t.m, rating: star, t: joined + DAY });
          rankings[rankings.length - 1]!.imported = true;
        }
      });
    };

    const watchedMovies = watch(movies, o.movieLibraries[i] ?? 0);
    place(watchedMovies, 'movies');
    const seasonCount = o.seasonLibraries?.[i] ?? 0;
    if (seasonCount > 0) place(watch(seasons, seasonCount), 'tv_seasons');

    // An importer also brings stars for films they never ranked here.
    if (importer && o.includeStars) {
      const ranked = new Set(watchedMovies.map((t) => t.m));
      for (const t of watch(
        movies.filter((x) => !ranked.has(x.m)),
        40,
      )) {
        const utility = taste(t) + normal() * o.noise;
        stars.push({
          u,
          m: t.m,
          rating: Math.min(
            5,
            Math.max(0.5, Math.round((3.2 + 1.1 * (utility - lovedAt)) * 2) / 2),
          ),
          t: joined + DAY,
        });
      }
    }

    users.push({
      u,
      visibility: random() < 0.8 ? 'public' : 'private',
      status: random() < 0.97 ? 'active' : 'suspended',
      imported_titles: importer ? 50 + Math.floor(random() * 300) : 0,
    });
  });

  const follows = keys.flatMap((u) =>
    Array.from({ length: Math.floor(random() * 6) }, () => pick(keys))
      .filter((v) => v !== u)
      .map((followee) => ({
        follower: u,
        followee,
        t: exportedAt - Math.floor(random() * 40 * DAY),
      })),
  );
  const unique = new Map(follows.map((f) => [`${f.follower}|${f.followee}`, f]));
  const blocks =
    random() < 0.5 && keys.length > 3 ? [{ blocker: keys[0]!, blocked: keys[3]! }] : [];

  const strip = ({ quality: _quality, ...media }: Title): SnapshotMedia => media;
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exported_at: exportedAt,
    includes_letterboxd_stars: o.includeStars,
    users,
    follows: [...unique.values()],
    blocks,
    rankings,
    media: [...movies, ...series, ...seasons].map(strip),
    similar,
    stars,
  };
}
