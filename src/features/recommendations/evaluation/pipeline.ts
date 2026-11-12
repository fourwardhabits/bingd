import { bandSizes, scoreFor } from '@/features/collection/score';

import { ANCHOR_BUDGET, candidateIdsFrom, selectAnchors, type LikedTitle } from '../anchors';
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

import type { TestReader, Title, World } from './world';

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
  group: 'engine' | 'ablation' | 'sweep';
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
};

export type CollaborativeRows = ReadonlyMap<number, Collaborative>;

export type Wall = {
  wall: Scored[];
  scored: Scored[];
  sources: { anchored: number; social: number; collaborative: number; catalogue: number; trending: number };
  ms: number;
};

const toCandidate = (title: Title, collaborative?: Collaborative): Candidate => ({
  mediaItemId: title.id,
  title: title.title,
  year: title.year,
  posterPath: `/${title.id}.jpg`,
  kind: 'movie',
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
export function socialMirror(world: World, reader: TestReader, follows: readonly number[]): number[] {
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
      out.set(t.id, toCandidate(t));
    }
  }
  for (const decade of decades.slice(0, 3)) {
    for (const t of draw(world.titles.filter((title) => title.year >= decade && title.year < decade + 10))) {
      out.set(t.id, toCandidate(t));
    }
  }
  return [...out.values()];
}

export function profileEntriesOf(world: World, reader: TestReader, negativeEvidence = true): ProfileEntry[] {
  const sizes = bandSizes(reader.ranked);
  const meta = (index: number) => {
    const title = world.titles[index]!;
    return { mediaItemId: title.id, language: title.language, year: title.year, kind: 'movie' as const, genres: title.genres };
  };
  const entries: ProfileEntry[] = [];
  for (const row of reader.ranked) {
    if (!negativeEvidence && row.bucket === 'not_for_me') {
      entries.push({ ...meta(row.title), score: null, bucket: null });
    } else {
      entries.push({ ...meta(row.title), score: scoreFor(row.bucket, row.position, sizes), bucket: row.bucket });
    }
  }
  for (const row of reader.bucketed) {
    const bucket = !negativeEvidence && row.bucket === 'not_for_me' ? null : row.bucket;
    entries.push({ ...meta(row.title), score: null, bucket });
  }
  for (const title of reader.logged) entries.push({ ...meta(title), score: null, bucket: null });
  return entries;
}

export type WallInput = {
  world: World;
  reader: TestReader;
  variant: Variant;
  collaborative: CollaborativeRows;
  follows?: readonly number[];
  anchorSeed: number;
  drawSeed: number;
};

export function wallFor({ world, reader, variant, collaborative, follows, anchorSeed, drawSeed }: WallInput): Wall {
  const started = performance.now();
  const titles = world.titles;
  const sizes = bandSizes(reader.ranked);
  const scoredRanked = reader.ranked.map((row) => ({ row, score: scoreFor(row.bucket, row.position, sizes) }));
  const taste = tasteFrom(
    scoredRanked.map(({ row, score }) => ({
      score,
      genres: titles[row.title]!.genres,
      language: titles[row.title]!.language,
    })),
  );
  const v2 = variant.engine === 'v2';
  const profile = v2 ? profileFrom(profileEntriesOf(world, reader, variant.negativeEvidence)) : undefined;

  const liked: LikedTitle[] = scoredRanked
    .filter(({ row }) => row.bucket === 'loved')
    .map(({ row, score }) => ({
      mediaItemId: titles[row.title]!.id,
      title: titles[row.title]!.title,
      score,
      genres: titles[row.title]!.genres,
      language: titles[row.title]!.language,
    }));
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

  const social = v2 ? [] : socialMirror(world, reader, follows ?? world.people[reader.person]!.follows).map((t) => titles[t]!.id);
  // As the hook: only endorsed rows (support > 0) are a source; disputed rows are evidence.
  const collaborativeIds = variant.collaborativeSource
    ? [...collaborative].filter(([, evidence]) => evidence.support > 0).map(([t]) => titles[t]!.id)
    : [];
  const trending = world.trending.map((t) => titles[t]!.id);
  const ids = candidateIdsFrom(anchors, [...social, ...collaborativeIds], trending);
  const listed = ids.map((id) => toCandidate(titles[indexOfId(id)]!));

  const exclude = new Set([...metOf(reader)].map((t) => titles[t]!.id));
  let filled: Candidate[] = [];
  if (profile && variant.catalogue) {
    const request = { kind: 'movie' as const, languages: sourceLanguages(profile), decades: sourceDecades(profile, 'movie') };
    filled = coverageFill(
      listed,
      catalogueMirror(world, reader, request.languages, request.decades, anchorSeed),
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
  const wall = drawSlate(scored, { pageSize: SLATE_SIZE, pages: 1, seed: drawSeed, now: 0 });

  const anchoredIds = new Set(anchors.flatMap((anchor) => anchor.similarIds));
  const socialIds = new Set(social);
  const collaborativeSet = new Set(collaborativeIds);
  const catalogueIds = new Set(filled.map((c) => c.mediaItemId));
  const sources = { anchored: 0, social: 0, collaborative: 0, catalogue: 0, trending: 0 };
  for (const item of wall) {
    const id = item.mediaItemId;
    if (anchoredIds.has(id)) sources.anchored += 1;
    else if (socialIds.has(id)) sources.social += 1;
    else if (collaborativeSet.has(id)) sources.collaborative += 1;
    else if (catalogueIds.has(id)) sources.catalogue += 1;
    else sources.trending += 1;
  }
  return { wall, scored, sources, ms: performance.now() - started };
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
  const config = { version: variant.id, weights: variant.weights ?? ENGINES.v2_metadata.weights };
  for (const candidate of candidates) {
    if (exclude.has(candidate.mediaItemId) || seen.has(candidate.mediaItemId)) continue;
    seen.add(candidate.mediaItemId);
    if (anchorIds.has(candidate.mediaItemId)) continue;
    out.push(scoreCandidateV2(candidate, anchors, profile, config));
  }
  return out;
}
