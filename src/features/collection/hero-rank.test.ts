import { heroRankFor, type HeroRankRow } from './hero-rank';

/**
 * **At most one rank line, and only for a top-ten placement** (founder, 2026-08-28).
 *
 * The report was a hero reading `#17 in English`, and the two rules that produced it
 * are both gone: language never competes, and a placement outside the top ten is not
 * printed at all rather than falling back to the bare overall position.
 *
 * The order is overall, then genre, then nothing — and overall wins even when the
 * genre number is smaller, because "#4 of everything I have ranked" and "#1 of the
 * dramas" are not the same kind of claim.
 *
 * Everything here derives from ranking rows the client already holds. The tests that
 * matter most are the ones proving nothing is invented: a genre too small to mean
 * anything, and a title that is simply not near the top, must both produce silence.
 */

const row = (id: string, position: number, genres: string[] = []): HeroRankRow => ({
  mediaItemId: id,
  position,
  genres,
});

/** `n` filler rows carrying the given genre, so a genre can reach its minimum size. */
const filler = (count: number, genres: string[], from = 100) =>
  Array.from({ length: count }, (_, i) => row(`filler-${from + i}`, from + i, genres));

describe('a top-ten overall placement', () => {
  it('is the label, with no qualifier', () => {
    const rows = [row('a', 3, ['Sci-Fi']), ...filler(10, ['Sci-Fi'])];
    expect(heroRankFor('a', rows, 'movies')).toEqual({ label: '#3 in Movies', basis: 'overall' });
  });

  it('names the TV list by the category the caller ranked in', () => {
    const rows = [row('a', 2, [])];
    expect(heroRankFor('a', rows, 'tv_seasons')).toEqual({ label: '#2 in TV', basis: 'overall' });
  });

  /**
   * Movies and TV are separate rankings and the label follows the one the title is
   * actually in — the same rows must never be described as "#2 in Movies" and
   * "#2 in TV" depending on who asked.
   */
  it('keeps movie and TV semantics apart', () => {
    const rows = [row('a', 2, [])];
    expect(heroRankFor('a', rows, 'movies')?.label).toBe('#2 in Movies');
    expect(heroRankFor('a', rows, 'tv_seasons')?.label).toBe('#2 in TV');
  });

  it('includes the tenth and excludes the eleventh', () => {
    expect(heroRankFor('a', [row('a', 10, [])], 'movies')?.label).toBe('#10 in Movies');
    expect(heroRankFor('a', [row('a', 11, [])], 'movies')).toBeNull();
  });

  /**
   * **The founder's first example, and the rule the old code got backwards.**
   * #4 in Movies against #1 in Drama: the broader claim wins, even though the genre
   * number is better and even though the old proportional comparison preferred it.
   */
  it('beats a better genre number', () => {
    const rows = [
      row('a', 4, ['Drama']),
      ...filler(9, ['Drama']),
      // Nine more titles above `a` overall, so its own position stands at 4.
      row('x1', 1, []),
      row('x2', 2, []),
      row('x3', 3, []),
    ];

    expect(heroRankFor('a', rows, 'movies')).toEqual({ label: '#4 in Movies', basis: 'overall' });
  });
});

describe('a genre placement, when the overall one is not good enough', () => {
  /** The founder's second example: #12 in Movies and #3 in Drama → `#3 in Drama`. */
  it('is shown when the title is top ten in that genre', () => {
    const rows = [
      row('d1', 1, ['Drama']),
      row('d2', 2, ['Drama']),
      row('a', 12, ['Drama']),
      ...filler(7, ['Drama']),
    ];

    expect(heroRankFor('a', rows, 'movies')).toEqual({ label: '#3 in Drama', basis: 'genre' });
  });

  /**
   * **The plain ordinal decides, not the proportional strength `genreRanksFor` sorts
   * by.** Once the field is "top ten in this genre", #1 is better than #2 and the
   * denominator is not on the page for the reader to weigh. The old rule preferred
   * #2 of 40 over #1 of 6; this one does not.
   */
  it('picks the best numerical rank among several qualifying genres', () => {
    const rows = [
      row('top-scifi', 1, ['Sci-Fi']),
      row('a', 40, ['Sci-Fi', 'Horror']),
      ...filler(38, ['Sci-Fi'], 200),
      ...filler(5, ['Horror'], 400),
    ];

    // #2 of the Sci-Fi, #1 of the Horror. The smaller number wins now.
    expect(heroRankFor('a', rows, 'movies')).toEqual({ label: '#1 in Horror', basis: 'genre' });
  });

  /**
   * A tie has to resolve the same way every render or the hero flickers between two
   * true labels. Ascending by name — the order `CANONICAL_GENRES` is already written
   * in — is the tiebreak.
   */
  it('breaks a tie deterministically, by genre name', () => {
    const rows = [
      row('a', 40, ['Thriller', 'Drama']),
      ...filler(9, ['Thriller', 'Drama'], 300),
    ];

    // #1 in both. "Drama" sorts before "Thriller".
    expect(heroRankFor('a', rows, 'movies')?.label).toBe('#1 in Drama');
  });

  it('gives the same answer however the genres arrive on the row', () => {
    const forwards = [row('a', 40, ['Drama', 'Thriller']), ...filler(9, ['Drama', 'Thriller'], 300)];
    const backwards = [
      row('a', 40, ['Thriller', 'Drama']),
      ...filler(9, ['Thriller', 'Drama'], 300),
    ];

    // The same rows read twice — which is what a refetch is — cannot change the
    // dimension the hero chose.
    expect(heroRankFor('a', forwards, 'movies')).toEqual(heroRankFor('a', backwards, 'movies'));
    expect(heroRankFor('a', forwards, 'movies')?.label).toBe('#1 in Drama');
  });

  it('ignores a genre the title is in but not near the top of', () => {
    // Thirty dramas above it, so it is 31st of them: true, and not worth a line.
    const rows = [...filler(30, ['Drama'], 1), row('a', 40, ['Drama'])];
    expect(heroRankFor('a', rows, 'movies')).toBeNull();
  });
});

describe('what it refuses to say', () => {
  /** The founder's third example: #17 in Movies and #12 in Drama → no label. */
  it('says nothing when neither the overall nor any genre is top ten', () => {
    // Eleven dramas above it: #17 overall, #12 in Drama. Exactly the founder's case,
    // and the one the old third rule answered with "#17 in Movies".
    const rows = [...filler(11, ['Drama'], 1), row('a', 17, ['Drama'])];
    expect(heroRankFor('a', rows, 'movies')).toBeNull();
  });

  /**
   * **The reported line.** Language is not a dimension of this label at all — not
   * deprioritised, not a fallback. A row carrying one produces the same answer as a
   * row carrying none, because the type no longer has the field to consult.
   */
  it('never names a language, however many titles share it', () => {
    const rows = [row('a', 17, []), ...filler(30, [], 700)];
    const result = heroRankFor('a', rows, 'movies');

    expect(result).toBeNull();
    expect(result?.label ?? '').not.toMatch(/English|Telugu/);
  });

  /**
   * The bare overall position was the old third rule and is the reason a 17 reached a
   * hero. Seventeenth out of everything is a statement about how much somebody has
   * used the app, not about the film.
   */
  it('does not fall back to the overall rank outside the top ten', () => {
    expect(heroRankFor('a', [row('a', 99, [])], 'movies')).toBeNull();
  });

  it('does not print a genre rank the genre is too small to support', () => {
    // Two comedies. "#1 in Comedy" says nothing about the film, and there is nothing
    // else to say, so the hero says nothing.
    const rows = [row('a', 40, ['Comedy']), row('b', 41, ['Comedy'])];
    expect(heroRankFor('a', rows, 'movies')).toBeNull();
  });

  it('returns nothing for a title that is not ranked at all', () => {
    expect(heroRankFor('missing', [row('a', 1, [])], 'movies')).toBeNull();
  });

  it('never returns more than one line', () => {
    const rows = [
      row('top', 1, ['Sci-Fi']),
      row('a', 40, ['Sci-Fi', 'Horror', 'Drama']),
      ...filler(10, ['Sci-Fi', 'Horror', 'Drama'], 800),
    ];

    const result = heroRankFor('a', rows, 'movies');
    expect(result).not.toBeNull();
    expect(result?.label.match(/#/g)).toHaveLength(1);
  });
});
