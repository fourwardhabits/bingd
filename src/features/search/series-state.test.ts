import type { LoggedEntry } from '@/features/collection/use-collection';

import { seriesChildState, seriesSecondaryLine, seriesStateLabel } from './series-state';

const entry = (over: Partial<LoggedEntry> & { mediaItemId: string }): LoggedEntry => ({
  title: 'Season 1',
  year: 2017,
  posterPath: null,
  genres: [],
  runtimeMinutes: null,
  kind: 'season',
  seriesTitle: 'Terrace House: Aloha State',
  seasonNumber: 1,
  seriesId: 'series-th-aloha',
  language: 'ja',
  bucket: 'loved',
  watchedOn: null,
  addedAt: null,
  ...over,
});

/**
 * The Terrace House case, which is the shape the founder found on a device: a reader who
 * has ranked *Aloha State* S1, a collection that shows it correctly, and a search result
 * for the series that looked like a title they had never opened.
 */
describe('what a series row knows about the reader', () => {
  it('finds the ranked season behind the series', () => {
    const state = seriesChildState(
      [entry({ mediaItemId: 'season-th-1' })],
      (id) => id === 'season-th-1',
    );

    expect(state.get('series-th-aloha')).toEqual({ watched: 1, ranked: 1 });
  });

  it('counts a logged-but-unranked season as watched and not as ranked', () => {
    const state = seriesChildState([entry({ mediaItemId: 'season-th-1' })], () => false);

    expect(state.get('series-th-aloha')).toEqual({ watched: 1, ranked: 0 });
  });

  it('adds up the seasons of one series and keeps two series apart', () => {
    const state = seriesChildState(
      [
        entry({ mediaItemId: 'a1' }),
        entry({ mediaItemId: 'a2', seasonNumber: 2 }),
        entry({ mediaItemId: 'b1', seriesId: 'series-th-tokyo', seasonNumber: 1 }),
      ],
      (id) => id === 'a1',
    );

    expect(state.get('series-th-aloha')).toEqual({ watched: 2, ranked: 1 });
    expect(state.get('series-th-tokyo')).toEqual({ watched: 1, ranked: 0 });
  });

  it('ignores movies and rows with no parent, which cannot be a season of anything', () => {
    const state = seriesChildState(
      [
        entry({ mediaItemId: 'm1', kind: 'movie', seriesId: null }),
        entry({ mediaItemId: 'orphan', seriesId: null }),
        // A logged *series* row is a fact about the show, not evidence about its seasons.
        entry({ mediaItemId: 'series-th-aloha', kind: 'series', seriesId: null }),
      ],
      () => true,
    );

    expect(state.size).toBe(0);
  });

  it('is empty for a reader who has watched nothing', () => {
    expect(seriesChildState([], () => true).size).toBe(0);
  });
});

describe('the clause a series row adds', () => {
  it('says ranked when anything is ranked, because it is the stronger fact', () => {
    expect(seriesStateLabel({ watched: 3, ranked: 1 })).toBe('1 ranked');
  });

  it('says watched when the reader has logged without ranking', () => {
    expect(seriesStateLabel({ watched: 2, ranked: 0 })).toBe('2 watched');
  });

  it('says nothing at all for a series the reader has never touched', () => {
    expect(seriesStateLabel(undefined)).toBeNull();
    expect(seriesStateLabel({ watched: 0, ranked: 0 })).toBeNull();
  });

  it('never invents a score, which a series does not have', () => {
    // The guard on the whole approach: no path through this produces a number that
    // could be read as a rating. Seasons are the rankable unit (PRD §10).
    expect(seriesStateLabel({ watched: 9, ranked: 9 })).toBe('9 ranked');
  });
});

describe('the whole secondary line', () => {
  it('reads kind, size, then what the reader has done', () => {
    expect(seriesSecondaryLine(3, { watched: 1, ranked: 1 })).toBe(
      'Series · 3 seasons · 1 ranked',
    );
  });

  it('is unchanged for a series the reader has never touched', () => {
    expect(seriesSecondaryLine(2, undefined)).toBe('Series · 2 seasons');
  });

  it('omits a season count the catalogue has not fetched yet', () => {
    // "0 seasons" would be the app stating as fact something it has not looked up.
    expect(seriesSecondaryLine(0, undefined)).toBe('Series');
    expect(seriesSecondaryLine(null, { watched: 1, ranked: 1 })).toBe('Series · 1 ranked');
  });
});
