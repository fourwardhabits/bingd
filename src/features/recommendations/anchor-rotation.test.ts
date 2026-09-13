import type { RankedEntry } from '@/features/collection/use-collection';

import catalogue from '../../../supabase/seed/catalogue.json';

import {
  ANCHOR_BUDGET,
  MAX_FILLS_PER_SLATE,
  STABLE_ANCHORS,
  candidateIdsFrom,
  meaningfulGenres,
  selectAnchors,
  seriesAlreadyMet,
  socialSeriesFrom,
  type LikedTitle,
} from './anchors';
import {
  ANCHOR_LIMIT,
  SLATE_SIZE,
  diversify,
  scoreSlate,
  tasteFrom,
  type Anchor,
  type Candidate,
  type Scored,
} from './rank';
import { anchorsFrom, likedFrom } from './use-for-you';
import { bandSizes, scoreFor } from '@/features/collection/score';

/**
 * **Coverage-aware anchor selection, and the quality guard that keeps it honest**
 * (2026-09-13).
 *
 * The For You repetition audit found that an established reader's first six liked titles
 * generated the whole candidate universe for ever, so most of their liked titles — often
 * whole genres of their taste — contributed nothing. Selection now keeps the top two, covers
 * the meaningful liked genres, rotates the rest by a launch seed and prefers lists already
 * cached, inside a budget of eight (the comparison is `recommendations.md` §10).
 *
 * The founder's constraint is that novelty alone is not success, so the second half of this
 * file pins the *structure* that makes this a quality change rather than a shuffle:
 *
 *   - titles beyond the first six genuinely become anchors across launches;
 *   - liked genres the first six missed are represented;
 *   - candidate membership changes between launches;
 *   - relevance does not fall below the old wall's band, and the wall stays anchor-led;
 *   - novelty has no door but the anchors' own TMDB lists, social and trending.
 *
 * Structural bounds rather than exact repeat counts: the audit's modelled numbers came from
 * a synthetic TMDB, and a number that tight would pin the fixture rather than the property.
 */

// ---------------------------------------------------------------------------
// selectAnchors
// ---------------------------------------------------------------------------

/** A liked band, best first: scores 10 down to 7, one genre unless told otherwise. */
const band = (count: number, genreOf: (index: number) => string[] = () => ['Drama']): LikedTitle[] =>
  Array.from({ length: count }, (_, index) => ({
    mediaItemId: `liked-${index}`,
    title: `Liked ${index}`,
    score: Math.round((10 - (3 * index) / Math.max(1, count - 1)) * 10) / 10,
    genres: genreOf(index),
  }));

const ids = (titles: readonly { mediaItemId: string }[]) => titles.map((title) => title.mediaItemId);

describe('selecting anchors', () => {
  it('uses every liked title, in order, when the budget holds them all', () => {
    for (const count of [0, 1, 5, ANCHOR_BUDGET]) {
      for (const seed of [1, 99, 123456]) {
        expect(selectAnchors(band(count), { seed })).toEqual(band(count));
      }
    }
  });

  it('keeps the two strongest liked titles on every launch', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      expect(ids(selectAnchors(band(27), { seed })).slice(0, STABLE_ANCHORS)).toEqual([
        'liked-0',
        'liked-1',
      ]);
    }
  });

  it('returns exactly the budget, without duplicates, drawn only from the liked band', () => {
    const liked = band(27);
    const known = new Set(ids(liked));
    for (let seed = 1; seed <= 200; seed += 1) {
      const chosen = ids(selectAnchors(liked, { seed }));
      expect(chosen).toHaveLength(ANCHOR_BUDGET);
      expect(new Set(chosen).size).toBe(ANCHOR_BUDGET);
      for (const id of chosen) expect(known.has(id)).toBe(true);
    }
  });

  it('keeps the reader’s own order among the titles it chose', () => {
    const liked = band(27);
    const order = new Map(liked.map((title, index) => [title.mediaItemId, index]));
    for (let seed = 1; seed <= 50; seed += 1) {
      const positions = ids(selectAnchors(liked, { seed })).map((id) => order.get(id)!);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it('is a pure function of its inputs — the same launch always draws the same anchors', () => {
    const liked = band(27);
    expect(selectAnchors(liked, { seed: 4242 })).toEqual(selectAnchors([...liked], { seed: 4242 }));
  });

  it('does not reshuffle every draw when the reader likes one more film', () => {
    // Keyed on the id, not the index: a new title can take a slot, but it cannot move the
    // draw of every other title.
    const liked = band(27);
    const grown = [...liked, { mediaItemId: 'liked-new', title: 'New', score: 7, genres: ['Drama'] }];
    const drawn = ANCHOR_BUDGET - STABLE_ANCHORS;
    let kept = 0;
    for (let seed = 1; seed <= 100; seed += 1) {
      const before = ids(selectAnchors(liked, { seed })).slice(STABLE_ANCHORS);
      const after = new Set(ids(selectAnchors(grown, { seed })));
      kept += before.filter((id) => after.has(id)).length;
    }
    // At most one slot per seed can go to the new title.
    expect(kept).toBeGreaterThanOrEqual(100 * (drawn - 1));
  });

  it('prefers the stronger end of the liked band without excluding its floor', () => {
    const drawn = new Map<string, number>();
    for (let seed = 1; seed <= 2000; seed += 1) {
      for (const id of ids(selectAnchors(band(27), { seed })).slice(STABLE_ANCHORS)) {
        drawn.set(id, (drawn.get(id) ?? 0) + 1);
      }
    }
    expect(drawn.get('liked-2')!).toBeGreaterThan(drawn.get('liked-26')!);
    expect(drawn.get('liked-26')!).toBeGreaterThan(0);
  });
});

describe('covering the reader’s taste', () => {
  /**
   * Thirty liked titles: the top twenty-one are dramas, then four comedies, three horrors,
   * one science-fiction film and one more drama. The first eight — the old way, and any
   * strictly top-ranked selection — would never reach a comedy or a horror.
   */
  const genreOf = (index: number) =>
    index < 21 ? ['Drama'] : index < 25 ? ['Comedy'] : index < 28 ? ['Horror'] : index === 28 ? ['Science Fiction'] : ['Drama'];
  const liked = band(30, genreOf);

  it('counts a genre as taste only when enough liked titles carry it', () => {
    const meaningful = meaningfulGenres(liked);
    expect([...meaningful.keys()].sort()).toEqual(['Comedy', 'Drama', 'Horror']);
    // One science-fiction film among thirty is not a taste for science fiction.
    expect(meaningful.has('Science Fiction')).toBe(false);
  });

  it('represents every meaningful genre on every launch, which the first eight never did', () => {
    const covers = (chosen: readonly LikedTitle[], genre: string) =>
      chosen.some((title) => title.genres.includes(genre));
    expect(covers(liked.slice(0, ANCHOR_BUDGET), 'Comedy')).toBe(false);
    for (let seed = 1; seed <= 200; seed += 1) {
      const chosen = selectAnchors(liked, { seed });
      expect(covers(chosen, 'Comedy')).toBe(true);
      expect(covers(chosen, 'Horror')).toBe(true);
    }
  });

  it('covers different titles of a genre on different launches', () => {
    const comedies = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      for (const title of selectAnchors(liked, { seed })) {
        if (title.genres.includes('Comedy')) comedies.add(title.mediaItemId);
      }
    }
    expect(comedies.size).toBeGreaterThan(1);
  });

  it('uses a title that covers two missing genres rather than spending two anchors on them', () => {
    // One horror-comedy among single-genre comedies and horrors. It is not required — the
    // draw is weighted, not greedy — but it should win the coverage slot most often.
    const mixed = band(30, (index) =>
      index < 21 ? ['Drama'] : index < 25 ? ['Comedy'] : index < 28 ? ['Horror'] : index === 28 ? ['Comedy', 'Horror'] : ['Drama'],
    );
    const drawn = new Map<string, number>();
    for (let seed = 1; seed <= 500; seed += 1) {
      for (const id of ids(selectAnchors(mixed, { seed }))) drawn.set(id, (drawn.get(id) ?? 0) + 1);
    }
    for (const single of ['liked-21', 'liked-22', 'liked-25', 'liked-26']) {
      expect(drawn.get('liked-28') ?? 0).toBeGreaterThan(drawn.get(single) ?? 0);
    }
  });
});

describe('taking breadth from lists already cached', () => {
  it('draws a liked title whose list is cached more often than an uncached neighbour', () => {
    const liked = band(27);
    const cached = new Set(['liked-20']);
    let cachedDraws = 0;
    let neighbourDraws = 0;
    for (let seed = 1; seed <= 1000; seed += 1) {
      const chosen = new Set(ids(selectAnchors(liked, { seed, cached })));
      if (chosen.has('liked-20')) cachedDraws += 1;
      // liked-19 sits one place higher, so without the preference it would win slightly.
      if (chosen.has('liked-19')) neighbourDraws += 1;
    }
    // Measured: 497 against 221 with the preference, 230 against 229 without it. A bare
    // "greater than" passed on that single draw, so the bound is a real margin.
    expect(cachedDraws).toBeGreaterThanOrEqual(neighbourDraws * 1.5);
  });

  it('bounds upstream fills per slate at the old anchor limit, whatever the budget', () => {
    expect(MAX_FILLS_PER_SLATE).toBe(ANCHOR_LIMIT);
    expect(ANCHOR_BUDGET).toBeGreaterThan(MAX_FILLS_PER_SLATE);
  });
});

// ---------------------------------------------------------------------------
// The liked-band rules still hold under selection
// ---------------------------------------------------------------------------

const entry = (over: Partial<RankedEntry> & { mediaItemId: string }): RankedEntry => ({
  title: over.mediaItemId,
  year: 2020,
  posterPath: null,
  genres: ['Drama'],
  runtimeMinutes: 120,
  kind: 'movie',
  seriesTitle: null,
  seriesId: null,
  language: 'en',
  bucket: 'loved',
  position: 1,
  category: 'movies',
  rankedAt: '2026-08-01T00:00:00Z',
  ...over,
});

describe('anchors under a launch seed', () => {
  it('never anchors on a title that was not liked, whatever the seed', () => {
    const ranked = Array.from({ length: 40 }, (_, index) =>
      entry({
        mediaItemId: `m-${index}`,
        position: index + 1,
        bucket: index < 20 ? 'loved' : index < 32 ? 'fine' : 'not_for_me',
        // The disliked and fine titles carry a genre no liked title does: coverage must
        // not reach outside the band to represent it.
        genres: index < 20 ? ['Drama'] : ['Horror'],
      }),
    );
    for (let seed = 1; seed <= 100; seed += 1) {
      for (const anchor of anchorsFrom(ranked, 'movies', undefined, { seed })) {
        expect(Number(anchor.mediaItemId.slice(2))).toBeLessThan(20);
      }
    }
  });

  it('selects shows, not seasons, on television', () => {
    const ranked = Array.from({ length: 36 }, (_, index) =>
      entry({
        mediaItemId: `s-${index}`,
        kind: 'season',
        category: 'tv_seasons',
        // Three seasons per show: twelve shows behind thirty-six liked seasons.
        seriesId: `show-${Math.floor(index / 3)}`,
        seriesTitle: `Show ${Math.floor(index / 3)}`,
        position: index + 1,
      }),
    );
    expect(likedFrom(ranked, 'tv')).toHaveLength(12);
    for (let seed = 1; seed <= 50; seed += 1) {
      const chosen = ids(anchorsFrom(ranked, 'tv', undefined, { seed }));
      expect(chosen).toHaveLength(ANCHOR_BUDGET);
      expect(new Set(chosen).size).toBe(ANCHOR_BUDGET);
      expect(chosen.slice(0, 2)).toEqual(['show-0', 'show-1']);
    }
  });

  it('without a selection, is the first titles of the band in order — unrotated', () => {
    const ranked = Array.from({ length: 30 }, (_, index) =>
      entry({ mediaItemId: `m-${index}`, position: index + 1 }),
    );
    expect(ids(anchorsFrom(ranked, 'movies'))).toEqual(
      Array.from({ length: ANCHOR_BUDGET }, (_, index) => `m-${index}`),
    );
  });
});

// ---------------------------------------------------------------------------
// TV correctness helpers
// ---------------------------------------------------------------------------

describe('what the TV wall counts as already met', () => {
  it('is the show of every logged or ranked season, and nothing else', () => {
    const met = seriesAlreadyMet(
      [
        { kind: 'season', seriesId: 'show-a' },
        { kind: 'movie', seriesId: null },
        { kind: 'season', seriesId: null },
      ],
      [{ kind: 'season', seriesId: 'show-b' }],
      undefined,
    );
    expect([...met].sort()).toEqual(['show-a', 'show-b']);
  });
});

describe('social candidates on the TV wall', () => {
  it('rolls seasons up to their shows, keeping the RPC’s order and one entry per show', () => {
    const rows = [
      { id: 'b1', kind: 'season', parent_id: 'show-b' },
      { id: 'a1', kind: 'season', parent_id: 'show-a' },
      { id: 'a2', kind: 'season', parent_id: 'show-a' },
      { id: 'film', kind: 'movie', parent_id: null },
      { id: 'orphan', kind: 'season', parent_id: null },
    ];
    expect(socialSeriesFrom(['a2', 'b1', 'a1', 'film', 'orphan', 'unknown'], rows)).toEqual([
      'show-a',
      'show-b',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The quality guard: a ~60-ranking account on the real scorer
// ---------------------------------------------------------------------------

type SeedMovie = {
  wikidata_qid: string;
  title: string;
  release_date: string | null;
  original_language: string | null;
  genres: string[];
};

/** mulberry32, as in `quality.test.ts`. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = prng(20260913);
const MOVIES = (catalogue as { movies: SeedMovie[] }).movies;
const universe: Candidate[] = MOVIES.map((movie) => ({
  mediaItemId: movie.wikidata_qid,
  title: movie.title,
  year: movie.release_date ? Number(movie.release_date.slice(0, 4)) : null,
  posterPath: null,
  kind: 'movie' as const,
  genres: movie.genres,
  language: movie.original_language,
  popularity: Math.round(500 * random() ** 3 * 100) / 100,
}));
const byId = new Map(universe.map((item) => [item.mediaItemId, item]));

/** A stand-in for TMDB `/recommendations` page 1: twenty ids, 60% genre-sharing. */
const similarCache = new Map<string, string[]>();
function similarFor(id: string): string[] {
  const hit = similarCache.get(id);
  if (hit) return hit;
  const source = byId.get(id)!;
  const rng = prng([...id].reduce((total, char) => total * 31 + char.charCodeAt(0), 7) >>> 0);
  const sameGenre = universe.filter(
    (item) => item.mediaItemId !== id && item.genres.some((genre) => source.genres.includes(genre)),
  );
  const anything = universe.filter((item) => item.mediaItemId !== id);
  const picked: string[] = [];
  while (picked.length < 20) {
    const pool = rng() < 0.6 && sameGenre.length > 0 ? sameGenre : anything;
    const choice = pool[Math.floor(rng() * pool.length)]!;
    if (!picked.includes(choice.mediaItemId)) picked.push(choice.mediaItemId);
  }
  similarCache.set(id, picked);
  return picked;
}

/** Sixty ranked films: 27 liked, 23 fine, 10 not for them — the reporter's shape. */
const account: RankedEntry[] = (() => {
  const rng = prng(60);
  const chosen = [...universe].sort(() => rng() - 0.5).slice(0, 60);
  return chosen.map((movie, index) =>
    entry({
      mediaItemId: movie.mediaItemId,
      title: movie.title,
      genres: [...movie.genres],
      language: movie.language,
      position: index + 1,
      bucket: index < 27 ? 'loved' : index < 50 ? 'fine' : 'not_for_me',
    }),
  );
})();

const trending = universe
  .filter((item) => !account.some((ranked) => ranked.mediaItemId === item.mediaItemId))
  .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
  .slice(0, 20)
  .map((item) => item.mediaItemId);

const sizes = bandSizes(account);
const taste = tasteFrom(
  account.map((ranked) => ({
    score: scoreFor(ranked.bucket, ranked.position, sizes),
    genres: ranked.genres,
    language: ranked.language,
  })),
);
const exclude = new Set(account.map((ranked) => ranked.mediaItemId));
const liked = likedFrom(account, 'movies');
const meaningful = meaningfulGenres(liked);

/** One launch of the real pipeline, from a chosen anchor set down to the first wall. */
function launch(chosen: readonly LikedTitle[]) {
  const anchors: Anchor[] = chosen.map((anchor) => ({
    mediaItemId: anchor.mediaItemId,
    title: anchor.title,
    score: anchor.score,
    similarIds: similarFor(anchor.mediaItemId),
  }));
  const candidateIds = candidateIdsFrom(anchors, [], trending);
  const scored = scoreSlate({
    candidates: candidateIds.map((id) => byId.get(id)!),
    anchors,
    taste,
    exclude,
  });
  const wall = diversify(scored, SLATE_SIZE);
  const covered = [...meaningful.keys()].filter((genre) =>
    chosen.some((anchor) => anchor.genres.includes(genre)),
  ).length;
  return { chosen, anchors, candidateIds, scored, wall, covered };
}

const mean = (items: readonly Scored[]) =>
  items.reduce((total, item) => total + item.explanation.total, 0) / Math.max(1, items.length);
const anchorLed = (items: readonly Scored[]) =>
  items.filter((item) => item.explanation.lead === 'anchors').length / Math.max(1, items.length);

const LAUNCH_SEEDS = [11, 2027, 90210, 424242, 7777777];
/** The old behaviour: the first six liked titles, every launch. */
const before = launch(liked.slice(0, ANCHOR_LIMIT));
const launches = LAUNCH_SEEDS.map((seed) => launch(anchorsFrom(account, 'movies', undefined, { seed })));

describe('the quality guard, on a sixty-ranking account', () => {
  it('has something to rotate: more liked titles than the budget', () => {
    expect(liked.length).toBe(27);
    expect(liked.length).toBeGreaterThan(ANCHOR_BUDGET);
  });

  it('lets several liked titles beyond the first six become anchors across launches', () => {
    const firstSix = new Set(ids(before.chosen));
    const beyond = new Set(launches.flatMap((run) => ids(run.chosen)));
    for (const id of firstSix) beyond.delete(id);
    expect(beyond.size).toBeGreaterThanOrEqual(8);
  });

  it('represents at least as much of the reader’s taste as the first six did, on every launch', () => {
    for (const run of launches) {
      expect(run.covered).toBeGreaterThanOrEqual(before.covered);
      // And, where the budget allows it, all of it.
      expect(run.covered).toBe(meaningful.size);
    }
  });

  it('changes the candidate universe between launches, not merely its order', () => {
    for (let index = 1; index < launches.length; index += 1) {
      const previous = new Set(launches[index - 1]!.candidateIds);
      const fresh = launches[index]!.candidateIds.filter((id) => !previous.has(id));
      expect(fresh.length).toBeGreaterThan(0);
    }
    const distinct = new Set(launches.flatMap((run) => ids(run.wall)));
    expect(distinct.size).toBeGreaterThan(SLATE_SIZE * 1.5);
  });

  it('does not lower relevance below the old wall’s band', () => {
    for (const run of launches) {
      expect(run.wall).toHaveLength(SLATE_SIZE);
      expect(mean(run.wall)).toBeGreaterThanOrEqual(mean(before.wall) * 0.95);
    }
  });

  it('keeps the wall anchor-led — the reader’s own liked titles still carry it', () => {
    for (const run of launches) {
      expect(anchorLed(run.wall)).toBeGreaterThanOrEqual(0.6);
      expect(anchorLed(run.wall)).toBeGreaterThanOrEqual(anchorLed(before.wall) - 0.1);
    }
  });

  it('cannot satisfy novelty by injecting unrelated catalogue rows', () => {
    // 382 films are in the catalogue and every one is scorable. Only the anchors' lists
    // and the trending fallback may reach the pool — and every anchored hit names an
    // anchor this launch actually chose.
    for (const run of launches) {
      const allowed = new Set([...run.anchors.flatMap((anchor) => anchor.similarIds), ...trending]);
      const chosen = new Set(ids(run.chosen));
      expect(run.candidateIds.length).toBeLessThan(universe.length);
      for (const item of run.scored) {
        expect(allowed.has(item.mediaItemId)).toBe(true);
        for (const hit of item.explanation.anchors) expect(chosen.has(hit.mediaItemId)).toBe(true);
      }
    }
  });

  it('is candidateIdsFrom’s whole contract: the union of the sources, in order, once each', () => {
    expect(
      candidateIdsFrom([{ similarIds: ['a', 'b'] }, { similarIds: ['b', 'c'] }], ['s', 'a'], ['t', 'c']),
    ).toEqual(['a', 'b', 'c', 's', 't']);
  });
});
