import type { RankedEntry } from '@/features/collection/use-collection';

import { seriesAlreadyMet, seriesUnitWeights, socialSeriesFrom } from './anchors';
import { tasteFrom } from './rank';
import { likedFrom } from './use-for-you';

/**
 * **Shows and seasons as distinct signals** (TV show & season ranking, founder brief §7,
 * 2026-11-14).
 *
 * A whole show's ranking informs recommendations beside its seasons and is never treated
 * as a season, and no rating is inferred from one level for the other. A series is not
 * overweighted because many of its seasons are ranked: every observation is kept, and the
 * rows of one series share one unit of influence.
 */

const entry = (over: Partial<RankedEntry>): RankedEntry => ({
  mediaItemId: 'x',
  title: 'X',
  year: 2020,
  posterPath: null,
  genres: ['Drama'],
  runtimeMinutes: null,
  kind: 'season',
  seriesTitle: null,
  seriesId: null,
  language: 'en',
  bucket: 'loved',
  position: 1,
  category: 'tv_seasons',
  rankedAt: null,
  ...over,
});

const season = (
  id: string,
  seriesId: string,
  position: number,
  over: Partial<RankedEntry> = {},
) => entry({ mediaItemId: id, seriesId, seriesTitle: seriesId, position, ...over });
const show = (id: string, position: number, over: Partial<RankedEntry> = {}) =>
  entry({
    mediaItemId: id,
    title: id,
    kind: 'series',
    category: 'tv_shows',
    position,
    ...over,
  });

describe('one unit of influence per series', () => {
  it('splits a series between its ranked seasons and its show ranking, and leaves films at 1', () => {
    const weights = seriesUnitWeights([
      season('s1', 'shameless', 1),
      season('s2', 'shameless', 2),
      season('s3', 'shameless', 3),
      show('shameless', 1),
      show('severance', 2),
      entry({ mediaItemId: 'heat', kind: 'movie', category: 'movies' }),
    ]);
    expect(weights.get('s1')).toBeCloseTo(0.25);
    expect(weights.get('shameless')).toBeCloseTo(0.25);
    expect(weights.get('severance')).toBe(1);
    expect(weights.get('heat')).toBe(1);
  });

  it('lets a series with ten ranked seasons pull no harder than a show ranked once', () => {
    const tenSeasons = Array.from({ length: 10 }, (_, n) =>
      season(`s${n}`, 'long', n + 1, { genres: ['Comedy'] }),
    );
    const one = show('short', 1, { genres: ['Thriller'] });
    const signals = [...tenSeasons, one];
    const weights = seriesUnitWeights(signals);
    const taste = tasteFrom(
      signals.map((e) => ({
        score: 10,
        genres: e.genres,
        language: e.language,
        weight: weights.get(e.mediaItemId) ?? 1,
      })),
    );
    expect(taste.genres.get('Comedy')).toBeCloseTo(taste.genres.get('Thriller') ?? 0);
    // Every observation is still counted as evidence.
    expect(taste.sampleSize).toBe(11);
  });
});

describe('a whole show on the TV wall', () => {
  it('anchors on a loved show itself, once, beside a show anchored through its seasons', () => {
    const liked = likedFrom(
      [season('s1', 'bear', 1), season('s2', 'bear', 2), show('severance', 1)],
      'tv',
    );
    expect(liked.map((anchor) => anchor.mediaItemId).sort()).toEqual(['bear', 'severance']);
  });

  it('scores a show anchor against shows, never against the seasons beside it', () => {
    // Four loved seasons and one loved show. Pooled, the show would be scored in a band of
    // five; on its own it is a band of one and scores the high.
    const liked = likedFrom(
      [
        season('s1', 'a', 1),
        season('s2', 'b', 2),
        season('s3', 'c', 3),
        season('s4', 'd', 4),
        show('solo', 1),
      ],
      'tv',
    );
    expect(liked.find((anchor) => anchor.mediaItemId === 'solo')?.score).toBe(10);
  });

  it('counts a followee’s ranked show, once, beside their seasons of it', () => {
    expect(
      socialSeriesFrom(
        ['s1', 'show-a', 's2', 'show-b'],
        [
          { id: 's1', kind: 'season', parent_id: 'show-a' },
          { id: 'show-a', kind: 'series', parent_id: null },
          { id: 's2', kind: 'season', parent_id: 'show-c' },
          { id: 'show-b', kind: 'series', parent_id: null },
        ],
      ),
    ).toEqual(['show-a', 'show-c', 'show-b']);
  });

  it('treats a show the reader logged or ranked as met', () => {
    const met = seriesAlreadyMet(
      [{ kind: 'series', mediaItemId: 'logged-show' }],
      [season('s1', 'from-season', 1)],
    );
    expect([...met].sort()).toEqual(['from-season', 'logged-show']);
  });
});
