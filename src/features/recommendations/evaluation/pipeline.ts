import { bandSizes, scoreFor } from '@/features/collection/score';

import type { LoggedEntry, RankedEntry } from '@/features/collection/use-collection';

import {
  ANCHOR_BUDGET,
  candidateIdsFrom,
  selectAnchors,
  seriesUnitWeights,
  type LikedTitle,
} from '../anchors';
import { coverageFill } from '../coverage';
import { profileFrom, sourceDecades, sourceLanguages, type ProfileEntry } from '../profile';
import {
  ENGINES,
  SLATE_SIZE,
  scoreCandidateV2,
  scoreSlate,
  tasteFrom,
  unitRandom,
  type Anchor,
  type Candidate,
  type Collaborative,
  type EngineWeights,
  type Scored,
} from '../rank';
import { drawSlate } from '../selection';
import { likedFrom, profileEntriesFrom } from '../use-for-you';

import { hashUnit, type TestReader, type Title, type World } from './world';

/**
 * One reader's For You wall under one variant, through the shipped modules.
 *
 * This is `use-for-you.ts`'s queryFn with the network replaced by the synthetic world: the
 * same profile, anchor selection, source order (`candidateIdsFrom`), coverage fill, scorer
 * and draw. What it does **not** reproduce: the TMDB fill path (every synthetic title has a
 * list), filters, dismissals, exposure memory and Refresh, the watchlist. The catalogue and
 * social sources are JS mirrors of `catalogue_candidates` and `social_candidates`; the
 * collaborative source is the real SQL, run separately (`scripts/rec-eval/collaborative.mjs`)
 * and passed in.
 */

export type Variant = {
  id: string;
  label: string;
  group: 'engine' | 'ablation' | 'sweep' | 'diagnostic';
  /** `v1` runs V1's scorer and sources; anything else runs V2 with these weights. */
  engine: 'v1' | 'v2';
  weights?: EngineWeights;
  languageAnchors: boolean;
  catalogue: boolean;
  /** Collaborative ids join the pool. */
  collaborativeSource: boolean;
  /** Collaborative evidence is attached to candidates and scored. */
  collaborativeTerm: boolean;
  /** False: Not-for-me titles count as watched, with no opinion. */
  negativeEvidence: boolean;
  /**
   * Diagnostics only (reconcile, 2026-11-13), never a shipped configuration: `social` puts the
   * follow-graph source back into a V2 variant, or (false) takes it out of V1, to attribute the
   * pool-recall gap; `showsInProfile: false` reproduces the pre-reconcile V2 profile, which
   * read films and seasons and ignored whole-show rankings. Absent means as shipped.
   */
  social?: boolean;
  /**
   * Which walls ask the follow-graph source, overriding `social`. The `v2_metadata_social`
   * prototype engine asks on the Films wall only (`SOCIAL_SOURCE` in `rank.ts`).
   */
  socialWalls?: readonly ('movies' | 'tv')[];
  showsInProfile?: boolean;
};

/**
 * How a reader's ranked titles are recorded when the wall is TV (reconcile, 2026-11-13).
 *
 * The synthetic world has one kind of title. On the TV wall every title is read as a show:
 *
 * - `whole_show`: each ranked title is a whole-show ranking (`tv_shows`). The slice WS5 added.
 * - `by_season`: each is one to three ranked seasons of the show (`tv_seasons`), the only way
 *   TV could be ranked before WS5.
 * - `show_and_seasons`: the whole show **and** two of its seasons, in the same band — the
 *   double-count case `seriesUnitWeights` exists for.
 */
export type TvShape = 'whole_show' | 'by_season' | 'show_and_seasons';

export type CollaborativeRows = ReadonlyMap<number, Collaborative>;

export type PoolSource = 'anchored' | 'social' | 'collaborative' | 'catalogue' | 'trending';
export const POOL_SOURCES: PoolSource[] = [
  'anchored',
  'social',
  'collaborative',
  'catalogue',
  'trending',
];

export type Wall = {
  wall: Scored[];
  /** The first `EXTENDED` titles of the same draw (pages are drawn in sequence, so `wall` is its prefix). */
  extended: Scored[];
  scored: Scored[];
  sources: {
    anchored: number;
    social: number;
    collaborative: number;
    catalogue: number;
    trending: number;
  };
  /** Scores arbitrary titles exactly as this wall scored its pool, for ordering metrics. */
  scoreTitles: (titles: readonly Title[]) => Map<number, number>;
  /** The source that put a pooled title in the pool, in the precedence `sources` uses. */
  poolSource: (index: number) => PoolSource;
  ms: number;
};

/** Titles drawn for recall@50. */
export const EXTENDED = 50;

const toCandidate = (
  title: Title,
  collaborative?: Collaborative,
  kind: 'movie' | 'series' = 'movie',
): Candidate => ({
  mediaItemId: title.id,
  title: title.title,
  year: title.year,
  posterPath: `/${title.id}.jpg`,
  kind,
  genres: title.genres,
  language: title.language,
  popularity: title.popularity,
  ...(collaborative ? { collaborative } : {}),
});

export const indexOfId = (id: string) => Number(id.slice(id.indexOf('-') + 1));

/** Everything the reader's client knows they have met. */
export function metOf(reader: TestReader): Set<number> {
  return new Set([
    ...reader.ranked.map((row) => row.title),
    ...reader.bucketed.map((row) => row.title),
    ...reader.logged,
  ]);
}

/** `social_candidates`, mirrored: followees' loved titles, most-endorsed first, 40. */
export function socialMirror(
  world: World,
  reader: TestReader,
  follows: readonly number[],
): number[] {
  const met = metOf(reader);
  const counts = new Map<number, number>();
  for (const followee of follows) {
    for (const row of world.people[followee]!.ranked) {
      if (row.bucket !== 'loved' || met.has(row.title)) continue;
      counts.set(row.title, (counts.get(row.title) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 40)
    .map(([title]) => title);
}

/**
 * `catalogue_candidates`, mirrored: per language and per decade, the top `3 × per` by
 * popularity the reader has not met, twenty of them drawn by seed.
 */
export function catalogueMirror(
  world: World,
  reader: TestReader,
  languages: readonly string[],
  decades: readonly number[],
  seed: number,
  per = 20,
  kind: 'movie' | 'series' = 'movie',
): Candidate[] {
  const met = metOf(reader);
  const draw = (pool: Title[]) =>
    pool
      .filter((t) => !met.has(t.index))
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, per * 3)
      .sort((a, b) => unitRandom(seed, a.id) - unitRandom(seed, b.id))
      .slice(0, per);
  const out = new Map<string, Candidate>();
  for (const language of languages.slice(0, 5)) {
    for (const t of draw(world.titles.filter((title) => title.language === language))) {
      out.set(t.id, toCandidate(t, undefined, kind));
    }
  }
  for (const decade of decades.slice(0, 3)) {
    for (const t of draw(
      world.titles.filter((title) => title.year >= decade && title.year < decade + 10),
    )) {
      out.set(t.id, toCandidate(t, undefined, kind));
    }
  }
  return [...out.values()];
}

export function profileEntriesOf(
  world: World,
  reader: TestReader,
  negativeEvidence = true,
): ProfileEntry[] {
  const sizes = bandSizes(reader.ranked);
  const meta = (index: number) => {
    const title = world.titles[index]!;
    return {
      mediaItemId: title.id,
      language: title.language,
      year: title.year,
      kind: 'movie' as const,
      genres: title.genres,
    };
  };
  const entries: ProfileEntry[] = [];
  for (const row of reader.ranked) {
    if (!negativeEvidence && row.bucket === 'not_for_me') {
      entries.push({ ...meta(row.title), score: null, bucket: null });
    } else {
      entries.push({
        ...meta(row.title),
        score: scoreFor(row.bucket, row.position, sizes),
        bucket: row.bucket,
      });
    }
  }
  for (const row of reader.bucketed) {
    const bucket = !negativeEvidence && row.bucket === 'not_for_me' ? null : row.bucket;
    entries.push({ ...meta(row.title), score: null, bucket });
  }
  for (const title of reader.logged)
    entries.push({ ...meta(title), score: null, bucket: null });
  return entries;
}

const seasonsOf = (world: World, title: number) =>
  1 + Math.floor(hashUnit(world.config.seed ^ 0x7e, title, 0) * 3);

/**
 * A reader's collection as the TV wall's client reads it: ranked entries in the `tv_seasons`
 * and `tv_shows` pools (positions renumbered per pool, band order kept) and logged entries,
 * shaped by `TvShape`. Season ids are `<show id>#s<n>`; a season carries its show's id.
 */
export function tvCollectionOf(
  world: World,
  reader: TestReader,
  shape: TvShape,
  negativeEvidence = true,
): { seasons: RankedEntry[]; shows: RankedEntry[]; logged: LoggedEntry[] } {
  const base = (index: number) => {
    const title = world.titles[index]!;
    return {
      title: title.title,
      posterPath: null,
      genres: title.genres,
      runtimeMinutes: null,
      seriesTitle: title.title,
      language: title.language,
      rankedAt: null,
    };
  };
  const show = (
    index: number,
    bucket: RankedEntry['bucket'],
    position: number,
  ): RankedEntry => ({
    ...base(index),
    mediaItemId: world.titles[index]!.id,
    year: world.titles[index]!.year,
    kind: 'series',
    seriesTitle: null,
    seriesId: null,
    bucket,
    position,
    category: 'tv_shows',
  });
  const season = (
    index: number,
    n: number,
    bucket: RankedEntry['bucket'],
    position: number,
  ): RankedEntry => ({
    ...base(index),
    mediaItemId: `${world.titles[index]!.id}#s${n}`,
    year: world.titles[index]!.year + n - 1,
    kind: 'season',
    seasonNumber: n,
    seriesId: world.titles[index]!.id,
    bucket,
    position,
    category: 'tv_seasons',
  });
  const seasons: RankedEntry[] = [];
  const shows: RankedEntry[] = [];
  const logged: LoggedEntry[] = [];
  const toLogged = (entry: RankedEntry, bucket: LoggedEntry['bucket']): LoggedEntry => ({
    mediaItemId: entry.mediaItemId,
    title: entry.title,
    year: entry.year,
    posterPath: null,
    genres: entry.genres,
    runtimeMinutes: null,
    kind: entry.kind,
    seriesTitle: entry.seriesTitle,
    seriesId: entry.seriesId,
    language: entry.language,
    bucket,
    watchedOn: null,
    addedAt: null,
  });
  for (const row of reader.ranked) {
    // As the film path: without negative evidence a Not-for-me title is watched, no opinion.
    if (!negativeEvidence && row.bucket === 'not_for_me') {
      logged.push(toLogged(show(row.title, row.bucket, 0), null));
      continue;
    }
    if (shape !== 'by_season') shows.push(show(row.title, row.bucket, shows.length + 1));
    const count =
      shape === 'whole_show'
        ? 0
        : shape === 'show_and_seasons'
          ? 2
          : seasonsOf(world, row.title);
    for (let n = 1; n <= count; n += 1)
      seasons.push(season(row.title, n, row.bucket, seasons.length + 1));
  }
  const loggedShape = (index: number, bucket: LoggedEntry['bucket']) => {
    if (shape === 'by_season') {
      for (let n = 1; n <= seasonsOf(world, index); n += 1)
        logged.push(toLogged(season(index, n, 'fine', 0), bucket));
    } else {
      logged.push(toLogged(show(index, 'fine', 0), bucket));
    }
  };
  for (const row of reader.bucketed) {
    loggedShape(
      row.title,
      !negativeEvidence && row.bucket === 'not_for_me' ? null : row.bucket,
    );
  }
  for (const title of reader.logged) loggedShape(title, null);
  return { seasons, shows, logged };
}

export type WallInput = {
  world: World;
  reader: TestReader;
  variant: Variant;
  collaborative: CollaborativeRows;
  follows?: readonly number[];
  anchorSeed: number;
  drawSeed: number;
  /** Draw the TV wall instead of the film wall, with the reader's titles ranked this way. */
  tv?: TvShape;
};

/**
 * The TV wall's taste, profile and anchors, through the shipped functions: V1's `tasteFrom`
 * over the seasons and shows pools with `seriesUnitWeights` (as `use-for-you.ts`), the V2
 * profile through `profileEntriesFrom`, and anchors through `likedFrom(…, 'tv')`.
 */
function tvInputs(world: World, reader: TestReader, variant: Variant, shape: TvShape) {
  const { seasons, shows, logged } = tvCollectionOf(
    world,
    reader,
    shape,
    variant.negativeEvidence,
  );
  const signals = [...seasons, ...shows];
  const weights = seriesUnitWeights(signals);
  const sizes = { tv_seasons: bandSizes(seasons), tv_shows: bandSizes(shows) };
  const taste = tasteFrom(
    signals.map((entry) => ({
      score: scoreFor(
        entry.bucket,
        entry.position,
        sizes[entry.category as 'tv_seasons' | 'tv_shows'],
      ),
      genres: entry.genres,
      language: entry.language,
      weight: weights.get(entry.mediaItemId) ?? 1,
    })),
  );
  const profile =
    variant.engine === 'v2'
      ? profileFrom(
          variant.showsInProfile === false
            ? profileEntriesFrom([], seasons, logged)
            : profileEntriesFrom([], seasons, logged, shows),
        )
      : undefined;
  return { taste, profile, liked: likedFrom(signals, 'tv') };
}

export function wallFor({
  world,
  reader,
  variant,
  collaborative,
  follows,
  anchorSeed,
  drawSeed,
  tv,
}: WallInput): Wall {
  const started = performance.now();
  const titles = world.titles;
  const kind = tv ? ('series' as const) : ('movie' as const);
  const v2 = variant.engine === 'v2';
  let taste: ReturnType<typeof tasteFrom>;
  let profile: ReturnType<typeof profileFrom> | undefined;
  let liked: LikedTitle[];
  if (tv) {
    ({ taste, profile, liked } = tvInputs(world, reader, variant, tv));
  } else {
    const sizes = bandSizes(reader.ranked);
    const scoredRanked = reader.ranked.map((row) => ({
      row,
      score: scoreFor(row.bucket, row.position, sizes),
    }));
    taste = tasteFrom(
      scoredRanked.map(({ row, score }) => ({
        score,
        genres: titles[row.title]!.genres,
        language: titles[row.title]!.language,
      })),
    );
    profile = v2
      ? profileFrom(profileEntriesOf(world, reader, variant.negativeEvidence))
      : undefined;
    liked = scoredRanked
      .filter(({ row }) => row.bucket === 'loved')
      .map(({ row, score }) => ({
        mediaItemId: titles[row.title]!.id,
        title: titles[row.title]!.title,
        score,
        genres: titles[row.title]!.genres,
        language: titles[row.title]!.language,
      }));
  }
  const chosen = selectAnchors(liked, {
    seed: anchorSeed,
    budget: ANCHOR_BUDGET,
    cached: new Set(liked.map((entry) => entry.mediaItemId)),
    languages: v2 && variant.languageAnchors,
  });
  const anchors: Anchor[] = chosen.map((entry) => ({
    mediaItemId: entry.mediaItemId,
    title: entry.title,
    score: entry.score,
    similarIds: world.similar[indexOfId(entry.mediaItemId)]!.map((t) => titles[t]!.id),
  }));

  const useSocial = variant.socialWalls
    ? variant.socialWalls.includes(tv ? 'tv' : 'movies')
    : (variant.social ?? !v2);
  const social = useSocial
    ? socialMirror(world, reader, follows ?? world.people[reader.person]!.follows).map(
        (t) => titles[t]!.id,
      )
    : [];
  // As the hook: only endorsed rows (support > 0) are a source; disputed rows are evidence.
  const collaborativeIds = variant.collaborativeSource
    ? [...collaborative]
        .filter(([, evidence]) => evidence.support > 0)
        .map(([t]) => titles[t]!.id)
    : [];
  const trending = world.trending.map((t) => titles[t]!.id);
  const ids = candidateIdsFrom(anchors, [...social, ...collaborativeIds], trending);
  const listed = ids.map((id) => toCandidate(titles[indexOfId(id)]!, undefined, kind));

  const exclude = new Set([...metOf(reader)].map((t) => titles[t]!.id));
  let filled: Candidate[] = [];
  if (profile && variant.catalogue) {
    const request = {
      kind,
      languages: sourceLanguages(profile),
      decades: sourceDecades(profile, kind),
    };
    filled = coverageFill(
      listed,
      catalogueMirror(world, reader, request.languages, request.decades, anchorSeed, 20, kind),
      profile,
      request,
      // As the hook: the collection and the anchors are not coverage.
      new Set([...exclude, ...anchors.map((anchor) => anchor.mediaItemId)]),
    );
  }
  const merged = [...listed, ...filled];
  const candidates = variant.collaborativeTerm
    ? merged.map((candidate) => {
        const evidence = collaborative.get(indexOfId(candidate.mediaItemId));
        return evidence ? { ...candidate, collaborative: evidence } : candidate;
      })
    : merged;

  const scored = scoreWith(variant, candidates, anchors, taste, exclude, profile);
  const extended = drawSlate(scored, {
    pageSize: SLATE_SIZE,
    pages: Math.ceil(EXTENDED / SLATE_SIZE),
    seed: drawSeed,
    now: 0,
  }).slice(0, EXTENDED);
  const wall = extended.slice(0, SLATE_SIZE);
  const scoreTitles = (some: readonly Title[]) => {
    const out = new Map<number, number>();
    const pool = some.map((title) => {
      const evidence = variant.collaborativeTerm ? collaborative.get(title.index) : undefined;
      return toCandidate(title, evidence, kind);
    });
    for (const item of scoreWith(variant, pool, anchors, taste, new Set(), profile)) {
      out.set(indexOfId(item.mediaItemId), item.explanation.total);
    }
    return out;
  };

  const anchoredIds = new Set(anchors.flatMap((anchor) => anchor.similarIds));
  const socialIds = new Set(social);
  const collaborativeSet = new Set(collaborativeIds);
  const catalogueIds = new Set(filled.map((c) => c.mediaItemId));
  const sourceOf = (id: string): PoolSource =>
    anchoredIds.has(id)
      ? 'anchored'
      : socialIds.has(id)
        ? 'social'
        : collaborativeSet.has(id)
          ? 'collaborative'
          : catalogueIds.has(id)
            ? 'catalogue'
            : 'trending';
  const sources = { anchored: 0, social: 0, collaborative: 0, catalogue: 0, trending: 0 };
  for (const item of wall) sources[sourceOf(item.mediaItemId)] += 1;
  const poolSource = (index: number) => sourceOf(titles[index]!.id);
  return {
    wall,
    extended,
    scored,
    sources,
    scoreTitles,
    poolSource,
    ms: performance.now() - started,
  };
}

/** `scoreSlate`, with the engine's weights replaceable for ablations and sweeps. */
export function scoreWith(
  variant: Variant,
  candidates: readonly Candidate[],
  anchors: readonly Anchor[],
  taste: ReturnType<typeof tasteFrom>,
  exclude: ReadonlySet<string>,
  profile: ReturnType<typeof profileFrom> | undefined,
): Scored[] {
  if (variant.engine === 'v1' || !profile) {
    return scoreSlate({ candidates, anchors, taste, exclude: new Set(exclude) });
  }
  const seen = new Set<string>();
  const anchorIds = new Set(anchors.map((anchor) => anchor.mediaItemId));
  const out: Scored[] = [];
  const config = {
    version: variant.id,
    weights: variant.weights ?? ENGINES.v2_metadata.weights,
  };
  for (const candidate of candidates) {
    if (exclude.has(candidate.mediaItemId) || seen.has(candidate.mediaItemId)) continue;
    seen.add(candidate.mediaItemId);
    if (anchorIds.has(candidate.mediaItemId)) continue;
    out.push(scoreCandidateV2(candidate, anchors, profile, config));
  }
  return out;
}
