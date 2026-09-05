import { neighboursFor, type NeighbourRow } from './rank-neighbours';

/**
 * Neighbours are what turn an ordinal into a place.
 *
 * The cases worth holding are the ends of the list, where one side of the pair does not
 * exist and the wrong answer is to invent it, and the season case, where the wrong
 * answer is to print the word "Season 2" under somebody's score.
 */

const film = (id: string, position: number, title: string): NeighbourRow => ({
  mediaItemId: id,
  position,
  kind: 'movie',
  title,
});

const season = (
  id: string,
  position: number,
  series: string,
  seasonNumber: number,
): NeighbourRow => ({
  mediaItemId: id,
  position,
  kind: 'season',
  title: `Season ${seasonNumber}`,
  seriesTitle: series,
  seasonNumber,
});

/** Ten films, `#1` best, so a position reads as its own index. */
const TEN = Array.from({ length: 10 }, (_, i) => film(`m${i + 1}`, i + 1, `Film ${i + 1}`));

describe('neighboursFor', () => {
  it('names both sides of a middle placement', () => {
    expect(neighboursFor('m5', TEN)).toEqual({
      higher: { mediaItemId: 'm4', name: 'Film 4' },
      lower: { mediaItemId: 'm6', name: 'Film 6' },
    });
  });

  it('names nothing above a #1, rather than inventing one', () => {
    expect(neighboursFor('m1', TEN)).toEqual({
      higher: null,
      lower: { mediaItemId: 'm2', name: 'Film 2' },
    });
  });

  it('names nothing below the last title', () => {
    expect(neighboursFor('m10', TEN)).toEqual({
      higher: { mediaItemId: 'm9', name: 'Film 9' },
      lower: null,
    });
  });

  it('names neither for the only ranked title', () => {
    expect(neighboursFor('m1', [film('m1', 1, 'Film 1')])).toEqual({ higher: null, lower: null });
  });

  it('reads the pair around a top-5 and a top-10 placement', () => {
    expect(neighboursFor('m5', TEN).higher?.name).toBe('Film 4');
    expect(neighboursFor('m5', TEN).lower?.name).toBe('Film 6');
    expect(neighboursFor('m10', TEN).higher?.name).toBe('Film 9');
  });

  /**
   * The reveal runs this against the list the placement has just invalidated, so on the
   * render before that refetch resolves the subject is genuinely absent. Empty is the
   * honest answer; naming the pair the title *used* to sit between is a wrong claim
   * rather than a missing one.
   */
  it('answers neither when the subject is not in the list yet', () => {
    expect(neighboursFor('not-ranked-yet', TEN)).toEqual({ higher: null, lower: null });
  });

  it('reads position order even when the caller hands it over unsorted', () => {
    const shuffled = [
      film('m8', 8, 'Film 8'),
      film('m3', 3, 'Film 3'),
      film('m5', 5, 'Film 5'),
      film('m4', 4, 'Film 4'),
      film('m6', 6, 'Film 6'),
      film('m1', 1, 'Film 1'),
    ];
    expect(neighboursFor('m5', shuffled)).toEqual({
      higher: { mediaItemId: 'm4', name: 'Film 4' },
      lower: { mediaItemId: 'm6', name: 'Film 6' },
    });
  });

  it('leaves the caller’s list exactly as it found it', () => {
    const rows = [film('m5', 5, 'Film 5'), film('m2', 2, 'Film 2'), film('m8', 8, 'Film 8')];
    const before = rows.map((row) => row.mediaItemId);
    neighboursFor('m5', rows);
    expect(rows.map((row) => row.mediaItemId)).toEqual(before);
  });

  /**
   * A season is named by its show. Its own title is "Season 2" for everything but the
   * limited series named after itself, and "Season 2" under a score says nothing at all.
   */
  it('names a season by its series', () => {
    const seasons = [
      season('s1', 1, 'The Last of Us', 1),
      season('s2', 2, 'Severance', 1),
      season('s3', 3, 'The Bear', 2),
    ];
    expect(neighboursFor('s2', seasons)).toEqual({
      higher: { mediaItemId: 's1', name: 'The Last of Us, S1' },
      lower: { mediaItemId: 's3', name: 'The Bear, S2' },
    });
  });

  /**
   * **Cross-medium is impossible by construction, not by a check.**
   *
   * Movies and TV seasons are separate rankings and a position only means something
   * inside its own (PRD 11). The caller passes one category's rows, so the only way a
   * season could be named beside a film is if the query that built the list stopped
   * filtering by category. This asserts the contract the reveal depends on: whatever is
   * in, is what comes out.
   */
  it('can only ever name a row from the list it was given', () => {
    const movies = [film('m1', 1, 'Heat'), film('m2', 2, 'Sicario'), film('m3', 3, 'Collateral')];
    const { higher, lower } = neighboursFor('m2', movies);
    const ids = movies.map((row) => row.mediaItemId);
    expect(ids).toContain(higher?.mediaItemId);
    expect(ids).toContain(lower?.mediaItemId);
  });

  it('skips a neighbour with no usable name rather than printing an empty one', () => {
    const rows = [
      { mediaItemId: 'x', position: 1, kind: 'movie' as const, title: '   ' },
      film('m2', 2, 'Sicario'),
      film('m3', 3, 'Collateral'),
    ];
    expect(neighboursFor('m2', rows).higher).toBeNull();
    expect(neighboursFor('m2', rows).lower).toEqual({ mediaItemId: 'm3', name: 'Collateral' });
  });
});
