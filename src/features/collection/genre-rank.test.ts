import { MIN_GENRE_SIZE, formatGenreRank, genreRanksFor, type RankedRow } from './genre-rank';

/**
 * Derived genre ranks (screens.md §4, the reveal).
 *
 * The edges here mirror score.test.ts: each one produces a plausible wrong answer
 * rather than an obvious crash, which is what makes them worth asserting.
 */

const rows = (...specs: [string, number, string[]][]): RankedRow[] =>
  specs.map(([mediaItemId, position, genres]) => ({ mediaItemId, position, genres }));

/** Seven comedies, so the size floor is cleared and rank is the only variable. */
const comedies = (subjectPosition: number): RankedRow[] =>
  rows(
    ...(Array.from({ length: 7 }, (_, index) => [
      index + 1 === subjectPosition ? 'subject' : `other-${index + 1}`,
      index + 1,
      ['Comedy'],
    ]) as [string, number, string[]][]),
  );

describe('genreRanksFor', () => {
  it('reads the rank off the filtered order, not the overall one', () => {
    // The subject is 6th overall and 2nd among comedies, because three of the films
    // above it are not comedies. Returning 6 here would be the obvious bug.
    const list = rows(
      ['a', 1, ['Comedy']],
      ['b', 2, ['Drama']],
      ['c', 3, ['Drama']],
      ['d', 4, ['Drama']],
      ['e', 5, ['Comedy']],
      ['subject', 6, ['Comedy']],
      ['f', 7, ['Comedy']],
      ['g', 8, ['Comedy']],
      ['h', 9, ['Comedy']],
    );

    expect(genreRanksFor('subject', list)).toEqual([{ genre: 'Comedy', rank: 3, total: 6 }]);
  });

  it('sorts by standing within the genre, not by the bare ordinal', () => {
    // #1 of 5 is a weaker claim than #2 of 40, and showing the small genre first is
    // what a naive sort does.
    const big = Array.from({ length: 40 }, (_, index) => [
      index === 1 ? 'subject' : `big-${index}`,
      index + 1,
      index === 1 ? ['Epic', 'Tiny'] : ['Epic'],
    ]) as [string, number, string[]][];
    const small = Array.from({ length: 4 }, (_, index) => [
      `small-${index}`,
      100 + index,
      ['Tiny'],
    ]) as [string, number, string[]][];

    const [first] = genreRanksFor('subject', rows(...big, ...small));

    expect(first).toEqual({ genre: 'Epic', rank: 2, total: 40 });
  });

  it('is not fooled by rows arriving out of position order', () => {
    const shuffled = rows(
      ['e', 5, ['Comedy']],
      ['subject', 1, ['Comedy']],
      ['c', 3, ['Comedy']],
      ['b', 2, ['Comedy']],
      ['d', 4, ['Comedy']],
    );

    expect(genreRanksFor('subject', shuffled)).toEqual([{ genre: 'Comedy', rank: 1, total: 5 }]);
  });

  it('suppresses a genre with too few ranked titles', () => {
    // "#1 Comedy" out of two says nothing about the film.
    const list = rows(['subject', 1, ['Comedy']], ['other', 2, ['Comedy']]);
    expect(genreRanksFor('subject', list)).toEqual([]);
  });

  it('includes a genre that exactly meets the floor', () => {
    const list = rows(
      ...(Array.from({ length: MIN_GENRE_SIZE }, (_, index) => [
        index === 0 ? 'subject' : `other-${index}`,
        index + 1,
        ['Comedy'],
      ]) as [string, number, string[]][]),
    );

    expect(genreRanksFor('subject', list)).toHaveLength(1);
  });

  it('caps how many lines it returns', () => {
    const many = Array.from({ length: 8 }, (_, index) => [
      index === 0 ? 'subject' : `other-${index}`,
      index + 1,
      ['A', 'B', 'C', 'D'],
    ]) as [string, number, string[]][];

    expect(genreRanksFor('subject', rows(...many))).toHaveLength(2);
  });

  it('returns nothing for a title carrying no genres', () => {
    const list = rows(['subject', 1, []], ...(comedies(0).slice(0, 6) as RankedRow[]).map(
      (row) => [row.mediaItemId, row.position + 1, row.genres] as [string, number, string[]],
    ));

    expect(genreRanksFor('subject', list)).toEqual([]);
  });

  it('returns nothing when the title is not in the list at all', () => {
    // The reveal renders while the invalidated ranked query is still refetching, so
    // this is a real state and must not throw.
    expect(genreRanksFor('missing', comedies(1))).toEqual([]);
  });

  it('is last in its own genre when it sits at the bottom', () => {
    expect(genreRanksFor('subject', comedies(7))).toEqual([
      { genre: 'Comedy', rank: 7, total: 7 },
    ]);
  });
});

describe('formatGenreRank', () => {
  it('writes the rank without a denominator', () => {
    expect(formatGenreRank({ genre: 'Comedy', rank: 2, total: 40 })).toBe('#2 Comedy');
  });
});
