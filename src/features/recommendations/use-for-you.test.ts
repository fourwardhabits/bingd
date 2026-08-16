import type { RankedEntry } from '@/features/collection/use-collection';

import { anchorsFrom } from './use-for-you';
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
