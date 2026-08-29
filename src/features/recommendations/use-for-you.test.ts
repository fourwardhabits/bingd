import type { RankedEntry } from '@/features/collection/use-collection';

import { applyFilters, emptyFilters, type CollectionFilters } from '@/features/collection/filters';

import { anchorScope, anchorsFrom, asCollectionItem } from './use-for-you';
import { ANCHOR_LIMIT } from './rank';

/**
 * Which of the viewer's titles a slate is allowed to reason from.
 *
 * Two rules carry real weight here, and both are about TV. TMDB has no season-level
 * recommendations, so a ranked season must anchor on its show — and five seasons of
 * one show must be one anchor rather than five, or a single favourite series owns the
 * whole TV wall before diversity has a chance to run.
 */

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

const season = (id: string, seriesId: string | null, position: number): RankedEntry =>
  entry({
    mediaItemId: id,
    kind: 'season',
    category: 'tv_seasons',
    title: `Season ${position}`,
    seriesTitle: seriesId ? `Show ${seriesId}` : null,
    seriesId,
    position,
  });

describe('only what the viewer loved', () => {
  it('ignores a title they merely finished', () => {
    // Every anchor is quoted on screen as "Because you loved X". A viewer whose
    // whole collection is `fine` still has a top-ranked title, and the first version
    // of this anchored on it — saying "you loved" about a film they had marked
    // otherwise. Independent review, 2026-08-16.
    const anchors = anchorsFrom(
      [entry({ mediaItemId: 'meh', bucket: 'fine', position: 1 })],
      'movies',
    );

    expect(anchors).toEqual([]);
  });

  it('ignores a title they disliked, which would poison the slate anyway', () => {
    // A `not_for_me` title's associations are titles like something they disliked.
    const anchors = anchorsFrom(
      [entry({ mediaItemId: 'no', bucket: 'not_for_me', position: 1 })],
      'movies',
    );

    expect(anchors).toEqual([]);
  });

  it('takes the loved ones past the ones it skipped', () => {
    const anchors = anchorsFrom(
      [
        entry({ mediaItemId: 'meh', bucket: 'fine', position: 1 }),
        entry({ mediaItemId: 'yes', bucket: 'loved', position: 2 }),
      ],
      'movies',
    );

    expect(anchors.map((anchor) => anchor.mediaItemId)).toEqual(['yes']);
  });
});

describe('choosing anchors for films', () => {
  it('takes the highest ranked, in order', () => {
    const anchors = anchorsFrom(
      [entry({ mediaItemId: 'first', position: 1 }), entry({ mediaItemId: 'second', position: 2 })],
      'movies',
    );

    expect(anchors.map((anchor) => anchor.mediaItemId)).toEqual(['first', 'second']);
    expect(anchors[0]!.score).toBeGreaterThanOrEqual(anchors[1]!.score);
  });

  it('stops at the cap', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      entry({ mediaItemId: `m-${index}`, position: index + 1 }),
    );

    // Each anchor costs a provider request the first time it is used. "A bounded set
    // of strong taste anchors" is the decision; a request per ranked title is not.
    expect(anchorsFrom(many, 'movies')).toHaveLength(ANCHOR_LIMIT);
  });
});

describe('choosing anchors for television', () => {
  it('anchors on the show, not on the season', () => {
    const anchors = anchorsFrom([season('s1', 'show-a', 1)], 'tv');

    expect(anchors[0]).toEqual({
      mediaItemId: 'show-a',
      title: 'Show show-a',
      score: expect.any(Number),
    });
  });

  it('counts five seasons of one show as one anchor', () => {
    const anchors = anchorsFrom(
      [
        season('s1', 'show-a', 1),
        season('s2', 'show-a', 2),
        season('s3', 'show-a', 3),
        season('s4', 'show-b', 4),
      ],
      'tv',
    );

    expect(anchors.map((anchor) => anchor.mediaItemId)).toEqual(['show-a', 'show-b']);
  });

  it('keeps the best-ranked season’s score for the show', () => {
    const anchors = anchorsFrom([season('s1', 'show-a', 1), season('s9', 'show-a', 9)], 'tv');

    // Position 1 came first, so the show carries the score of the season the viewer
    // ranked highest rather than of whichever row happened to arrive last.
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.score).toBe(
      anchorsFrom([season('s1', 'show-a', 1)], 'tv')[0]!.score,
    );
  });

  it('skips a season whose show did not come back', () => {
    // Anchoring on the season id would ask TMDB a question it has no endpoint for,
    // and caching the empty answer would poison the facet for everyone.
    expect(anchorsFrom([season('orphan', null, 1)], 'tv')).toEqual([]);
  });
});

/**
 * What the slate is allowed to reason from once the reader has narrowed the wall.
 *
 * The founder's report: filters applied, recommendations still coming from titles
 * outside the filtered subset. They were — the filters reached the candidate pool and
 * stopped there, so a wall narrowed to Comedy was anchored on whatever the reader loved
 * most overall and then asked TMDB for comedies near it. The wall said one thing and the
 * reasoning underneath it was about another.
 */
describe('the subset a filtered wall reasons from', () => {
  const filters = (over: Partial<CollectionFilters>): CollectionFilters => ({
    ...emptyFilters(),
    ...over,
  });

  const comedy = entry({ mediaItemId: 'comedy', genres: ['Comedy'], position: 2 });
  const thriller = entry({ mediaItemId: 'thriller', genres: ['Thriller'], position: 1 });

  it('is the whole collection when nothing is filtered', () => {
    expect(anchorScope([thriller, comedy], undefined)).toEqual([thriller, comedy]);
    expect(anchorScope([thriller, comedy], emptyFilters())).toEqual([thriller, comedy]);
  });

  it('drops what the reader has filtered out, however highly they ranked it', () => {
    const scope = anchorScope([thriller, comedy], filters({ genres: ['Comedy'] }));

    expect(scope.map((row) => row.mediaItemId)).toEqual(['comedy']);
  });

  it('feeds the narrowed subset to the anchors, which is the whole point', () => {
    // Before this, the anchor was 'thriller' — the reader's number one — while the wall
    // above it said Comedy.
    const anchors = anchorsFrom([thriller, comedy], 'movies', filters({ genres: ['Comedy'] }));

    expect(anchors.map((anchor) => anchor.mediaItemId)).toEqual(['comedy']);
  });

  it('still weighs an anchor against its whole band, not against the subset', () => {
    /**
     * A score is a position within its band, so it only means anything against every
     * title in that band. Counting the filtered subset would make this comedy rank
     * last in a band of one and clamp to the floor, so narrowing the wall would
     * quietly weaken every anchor on it.
     */
    const unfiltered = anchorsFrom([thriller, comedy], 'movies');
    const narrowed = anchorsFrom([thriller, comedy], 'movies', filters({ genres: ['Comedy'] }));

    const before = unfiltered.find((anchor) => anchor.mediaItemId === 'comedy');
    expect(narrowed[0]!.score).toBe(before!.score);
  });

  it('narrows on a decade as well, because every facet is one input set', () => {
    const old = entry({ mediaItemId: 'old', year: 1994, position: 1 });
    const recent = entry({ mediaItemId: 'recent', year: 2021, position: 2 });

    const scope = anchorScope([old, recent], filters({ decades: ['2020s'] }));
    expect(scope.map((row) => row.mediaItemId)).toEqual(['recent']);
  });

  it('narrows TV on the season, and still anchors on the show', () => {
    const drama = season('s1', 'show-a', 1);
    const comedySeason = { ...season('s2', 'show-b', 2), genres: ['Comedy'] };

    const anchors = anchorsFrom([drama, comedySeason], 'tv', filters({ genres: ['Comedy'] }));
    expect(anchors.map((anchor) => anchor.mediaItemId)).toEqual(['show-b']);
  });

  it('leaves no anchors rather than borrowing one from outside the subset', () => {
    // A reader who has loved nothing in the filtered subset gets a popularity-led slate
    // inside it. That is the honest answer; the old behaviour was a borrowed one.
    const anchors = anchorsFrom(
      [entry({ mediaItemId: 'thriller-only', genres: ['Thriller'] })],
      'movies',
      filters({ genres: ['Comedy'] }),
    );

    expect(anchors).toEqual([]);
  });
});

/**
 * **Television reasons from its show's metadata, on both halves of the slate.**
 *
 * A season row carries no genres and no language of its own — TMDB publishes both on the
 * series — so before `lib/media-metadata.ts` a TV wall narrowed to Comedy had *no*
 * anchors at all: every ranked season looked genreless and fell out of the subset. The
 * wall then said Comedy and reasoned from nothing.
 *
 * The entries these functions receive now arrive already resolved (proved over the real
 * query shape in `use-collection.test.ts`), so what is asserted here is the half that
 * lives in this file: that the anchor subset and the candidate pool are narrowed by the
 * same filter model, over the same metadata.
 */
describe('a filtered TV wall', () => {
  const filters = (over: Partial<CollectionFilters>): CollectionFilters => ({
    ...emptyFilters(),
    ...over,
  });

  /** A ranked season as the read now hands it over: the show's genres, on the season. */
  const inherited = (id: string, seriesId: string, genres: string[], language = 'en') => ({
    ...season(id, seriesId, 1),
    genres,
    language,
  });

  it('anchors on a season that qualifies through its series genres', () => {
    const drama = inherited('s1', 'show-a', ['Drama', 'Thriller']);
    const comedy = inherited('s2', 'show-b', ['Comedy']);

    const anchors = anchorsFrom([drama, comedy], 'tv', filters({ genres: ['Drama'] }));

    // The show, not the season: TMDB answers "similar" about a series only.
    expect(anchors.map((anchor) => anchor.mediaItemId)).toEqual(['show-a']);
  });

  it('anchors on a season that qualifies through its series language', () => {
    const japanese = inherited('s1', 'show-a', ['Drama'], 'ja');
    const english = inherited('s2', 'show-b', ['Drama'], 'en');

    const anchors = anchorsFrom([japanese, english], 'tv', filters({ languages: ['ja'] }));

    expect(anchors.map((anchor) => anchor.mediaItemId)).toEqual(['show-a']);
  });

  it('keeps the whole TV subset when nothing is filtered', () => {
    const anchors = anchorScope(
      [inherited('s1', 'show-a', ['Drama']), inherited('s2', 'show-b', ['Comedy'])],
      emptyFilters(),
    );
    expect(anchors).toHaveLength(2);
  });

  it('narrows candidates by the same rule it narrows anchors by', () => {
    // The founder's constraint: "the anchor subset and candidate constraints must use
    // the same semantics". Both go through `applyFilters`, so the proof is that one
    // filter accepts an inherited-genre season on the anchor side and the matching
    // series on the candidate side.
    const comedy = filters({ genres: ['Comedy'] });

    const anchors = anchorScope([inherited('s1', 'show-a', ['Comedy'])], comedy);
    expect(anchors).toHaveLength(1);

    const candidate = asCollectionItem({
      mediaItemId: 'show-a',
      title: 'Show A',
      year: 2023,
      posterPath: null,
      kind: 'series',
      genres: ['Comedy'],
      language: 'en',
      popularity: 10,
    });
    expect(applyFilters([candidate], comedy)).toHaveLength(1);
    expect(applyFilters([candidate], filters({ genres: ['Horror'] }))).toEqual([]);
  });
});
