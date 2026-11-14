import { ANCHOR_LIMIT, unitRandom } from './rank';

/**
 * Which liked titles a launch reasons from, and what may enter the candidate pool.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT (For You repetition audit, 2026-09-13)
 *
 * Anchors were the first `ANCHOR_LIMIT` titles in the liked band, in position order. An
 * established reader with twenty-seven liked films therefore had the *same six* films
 * generating the whole candidate universe on every launch, while the other twenty-one —
 * often whole genres of their taste — never contributed a single candidate. Exposure
 * rotation can only reorder a universe; it cannot widen one.
 *
 * ---------------------------------------------------------------------------
 * THE SELECTION, IN FOUR STEPS ({@link selectAnchors})
 *
 *   1. **The strongest two liked titles, always.** The best evidence the reader has given
 *      is never rotated away.
 *   2. **Coverage.** Every *meaningful* liked genre — one carried by enough liked titles to
 *      be evidence rather than an accident — gets an anchor where the budget allows. Drawn
 *      by a seeded, weighted key rather than taken greedily, so a title that covers three
 *      uncovered genres is strongly preferred over one covering one, but two launches need
 *      not cover a genre with the same film.
 *   3. **Rotation.** Remaining slots are drawn from the rest of the liked band, weighted by
 *      the reader's own score.
 *   4. **Cached breadth first.** In steps 2 and 3 a title whose TMDB list is already cached
 *      is weighted up, so breadth is taken from facets that cost no upstream request.
 *
 * All draws are keyed on `unitRandom(seed, id)`, so the same seed over the same collection
 * always returns the same anchors, and ranking one more film does not reshuffle every other
 * title's draw.
 *
 * ---------------------------------------------------------------------------
 * WHAT DOES NOT CHANGE
 *
 *   - Only `loved` titles are ever anchors. `likedFrom` builds the band; this chooses in it.
 *   - Candidates are the union of the anchors' own TMDB lists, social and trending —
 *     {@link candidateIdsFrom} is that union and nothing else.
 *   - Upstream cost per slate is bounded by {@link MAX_FILLS_PER_SLATE}, today's worst case,
 *     however large the budget.
 */

/** A liked title as selection needs it: its id, the reader's score, and its genres. */
export type LikedTitle = {
  mediaItemId: string;
  title: string;
  score: number;
  genres: readonly string[];
  /** ISO 639-1. Read only when language coverage is on (Engine V2). */
  language?: string | null;
};

/** How many anchors a slate reasons from. See `recommendations.md` §10 for the comparison. */
export const ANCHOR_BUDGET = 8;

/** The strongest liked titles every launch keeps. */
export const STABLE_ANCHORS = 2;

/**
 * At most this many anchors per slate may cost an upstream TMDB request.
 *
 * Six, which was the whole anchor limit before rotation — so no slate can make more
 * provider requests than one could before, however large {@link ANCHOR_BUDGET} is. An anchor
 * beyond the cap whose list is not cached simply contributes nothing this launch; the
 * cached-first weighting means that is rare once a reader's band has warmed.
 */
export const MAX_FILLS_PER_SLATE = ANCHOR_LIMIT;

/** How much more likely a title with a cached list is to be drawn than one without. */
const CACHED_WEIGHT = 3;

/**
 * A genre is meaningful when this share of the liked band carries it — and at least two
 * titles do. One liked horror film among thirty is not a taste for horror; four are.
 */
const MEANINGFUL_SHARE = 0.1;

/** The liked genres that count as taste: carried by enough liked titles to be evidence. */
export function meaningfulGenres(liked: readonly LikedTitle[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of liked) {
    for (const genre of new Set(entry.genres)) counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  const floor = Math.max(2, Math.ceil(liked.length * MEANINGFUL_SHARE));
  return new Map([...counts].filter(([, count]) => count >= floor));
}

/**
 * Engine V2: liked languages that earn an anchor, most-carried first.
 *
 * **Two liked titles, with no share requirement**, and that asymmetry with
 * {@link meaningfulGenres} is the point. A genre needs 10% of the band because genres are
 * many and overlapping; a language is one per title, and the reader this exists for is the
 * one whose four loved Japanese films are 8% of a band of fifty. Under a share rule
 * they never anchor, TMDB is never asked what is like them, and the candidate pool stays
 * English however the scorer weighs language.
 */
export function meaningfulLanguages(liked: readonly LikedTitle[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of liked) {
    if (entry.language) counts.set(entry.language, (counts.get(entry.language) ?? 0) + 1);
  }
  return new Map([...counts].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]));
}

/**
 * At most this many anchors are spent on language coverage, so genre coverage and rotation
 * keep at least three of the eight.
 */
export const MAX_LANGUAGE_ANCHORS = 3;

/** Efraimidis–Spirakis: `log(u) / w` orders like `u^(1/w)` and cannot underflow. */
const drawKey = (seed: number, id: string, weight: number) =>
  Math.log(unitRandom(seed, id)) / Math.max(1e-6, weight);

/**
 * Up to `budget` of the liked titles, coverage-aware and seeded. See the header.
 *
 * `liked` is expected best first and already deduplicated (a TV reader's seasons collapsed
 * to their shows). The result keeps that order. **A reader with `budget` or fewer liked
 * titles gets all of them, in order**, whatever the seed — nothing is duplicated to fill a
 * slot and nothing is dropped.
 */
export function selectAnchors<T extends LikedTitle>(
  liked: readonly T[],
  {
    seed,
    budget = ANCHOR_BUDGET,
    cached,
    languages = false,
  }: {
    seed: number;
    budget?: number;
    cached?: ReadonlySet<string>;
    /** Engine V2: cover liked languages before genres. Off is exactly the V1 selection. */
    languages?: boolean;
  },
): T[] {
  if (liked.length <= budget) return [...liked];

  const weightOf = (entry: T) =>
    Math.max(0.1, entry.score / 10) * (cached?.has(entry.mediaItemId) ? CACHED_WEIGHT : 1);

  const chosen = new Set<T>(liked.slice(0, Math.min(STABLE_ANCHORS, budget)));

  // Language coverage (Engine V2): one seeded draw per uncovered liked language, before
  // genre coverage can spend the budget on the majority language's titles.
  if (languages) {
    const uncoveredLanguages = new Set(meaningfulLanguages(liked).keys());
    for (const entry of chosen) if (entry.language) uncoveredLanguages.delete(entry.language);
    let spent = 0;
    for (const language of [...uncoveredLanguages]) {
      if (chosen.size >= budget || spent >= MAX_LANGUAGE_ANCHORS) break;
      let best: { entry: T; key: number } | null = null;
      for (const entry of liked) {
        if (chosen.has(entry) || entry.language !== language) continue;
        const key = drawKey(seed, entry.mediaItemId, weightOf(entry));
        if (!best || key > best.key) best = { entry, key };
      }
      if (!best) continue;
      chosen.add(best.entry);
      spent += 1;
    }
  }

  // Coverage: one seeded draw per round among titles that add an uncovered genre.
  const meaningful = meaningfulGenres(liked);
  const uncovered = new Set(meaningful.keys());
  const cover = (entry: T) => {
    for (const genre of entry.genres) uncovered.delete(genre);
  };
  chosen.forEach(cover);

  while (chosen.size < budget && uncovered.size > 0) {
    let best: { entry: T; key: number } | null = null;
    for (const entry of liked) {
      if (chosen.has(entry)) continue;
      // Evidence-weighted gain, so covering a genre ten liked titles carry counts for more
      // than covering one at the threshold — and a multi-genre title counts once per genre.
      let gain = 0;
      for (const genre of new Set(entry.genres)) {
        if (uncovered.has(genre)) gain += meaningful.get(genre)!;
      }
      if (gain === 0) continue;
      const key = drawKey(seed, entry.mediaItemId, gain * weightOf(entry));
      if (!best || key > best.key) best = { entry, key };
    }
    if (!best) break;
    chosen.add(best.entry);
    cover(best.entry);
  }

  // Rotation: the rest of the budget from the rest of the band.
  const rest = liked
    .filter((entry) => !chosen.has(entry))
    .map((entry) => ({ entry, key: drawKey(seed, entry.mediaItemId, weightOf(entry)) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, budget - chosen.size);
  for (const { entry } of rest) chosen.add(entry);

  return liked.filter((entry) => chosen.has(entry));
}

/**
 * Every id a slate may score: the anchors' TMDB lists, then social, then trending.
 *
 * Deduplicated in first-seen order and **nothing else** — no catalogue scan, no padding.
 * Held as its own function so the quality guard can pin that novelty has no other door.
 */
export function candidateIdsFrom(
  anchors: readonly { similarIds: readonly string[] }[],
  social: readonly string[],
  fallback: readonly string[],
): string[] {
  return [...new Set([...anchors.flatMap((anchor) => anchor.similarIds), ...social, ...fallback])];
}

/**
 * The shows a reader has already met on television: the parent of every season they
 * logged or ranked.
 *
 * The TV wall's candidates are **series** ids and `user_media` records **seasons**, so
 * excluding `watched` alone never removed a show the reader was part-way through — unless
 * it happened to be one of their anchors.
 */
export function seriesAlreadyMet(
  ...lists: readonly (
    | readonly { kind?: string; seriesId?: string | null; mediaItemId?: string }[]
    | undefined
  )[]
): Set<string> {
  const met = new Set<string>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      if (entry.kind === 'season' && entry.seriesId) met.add(entry.seriesId);
      // A whole show logged or ranked in its own right (2026-11-14) has been met too.
      if (entry.kind === 'series' && entry.mediaItemId) met.add(entry.mediaItemId);
    }
  }
  return met;
}

/**
 * **Each series is one unit of taste** (TV show & season ranking, 2026-11-14): the share
 * of influence each TV observation carries, so the ranked seasons and the show ranking of
 * one series divide one unit between them. A film is always 1. Nothing is dropped: every
 * observation still informs the taste, a series just cannot outvote everything else by
 * having many seasons.
 */
export function seriesUnitWeights(
  entries: readonly { mediaItemId: string; kind: string; seriesId?: string | null }[],
): Map<string, number> {
  const unitOf = (entry: (typeof entries)[number]) =>
    entry.kind === 'season' ? (entry.seriesId ?? entry.mediaItemId) : entry.mediaItemId;
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === 'movie') continue;
    counts.set(unitOf(entry), (counts.get(unitOf(entry)) ?? 0) + 1);
  }
  return new Map(
    entries.map((entry) => [
      entry.mediaItemId,
      entry.kind === 'movie' ? 1 : 1 / (counts.get(unitOf(entry)) ?? 1),
    ]),
  );
}

/**
 * `social_candidates` ids as the TV wall can use them.
 *
 * The RPC returns whatever the followees ranked, and a ranked TV title is a **season** — so
 * the TV wall's `kind = 'series'` read dropped every social candidate. Rolling each season
 * up to its show keeps the RPC's order (most endorsed first), one entry per show. A row
 * that is not a season with a parent is ignored rather than guessed at.
 */
export function socialSeriesFrom(
  seasonIds: readonly string[],
  rows: readonly { id: string; kind: string | null; parent_id: string | null }[],
): string[] {
  const parentOf = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === 'season' && row.parent_id) parentOf.set(row.id, row.parent_id);
    // A followee's whole-show ranking (2026-11-14) is a signal about that show itself,
    // beside their seasons of it; the set below keeps it to one entry per show.
    if (row.kind === 'series') parentOf.set(row.id, row.id);
  }
  return [
    ...new Set(
      seasonIds.map((id) => parentOf.get(id)).filter((id): id is string => Boolean(id)),
    ),
  ];
}
