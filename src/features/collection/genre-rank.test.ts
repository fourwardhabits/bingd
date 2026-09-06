import {
  MAX_GENRE_LINES,
  MIN_GENRE_SIZE,
  TOP_RANK_SHOWN,
  formatGenreRank,
  genreRanksFor,
  shownGenreRanksFor,
  type RankedRow,
} from './genre-rank';

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

/**
 * `shownGenreRanksFor` — the same list, filtered to what a surface will actually print.
 *
 * Added 2026-09-05 with the reveal's top-ten rule. The reveal's own tests exercise this
 * through a rendered screen; what belongs here is the one property those cannot show
 * clearly, which is also the property that makes this a function rather than a
 * `.filter()` at the call site: **the filter has to run before the slice.**
 */
describe('shownGenreRanksFor', () => {
  /** `size` titles in one genre, with the subject at `position`. */
  const oneGenre = (position: number, size: number, genre = 'Thriller'): RankedRow[] =>
    Array.from({ length: size }, (_, index) => ({
      mediaItemId: index + 1 === position ? 'subject' : `f${index + 1}`,
      position: index + 1,
      genres: [genre],
    }));

  it('drops a placement worse than tenth, however strong its proportion', () => {
    // 12th of 60 is a ratio of 0.20 — stronger than most placements this function will
    // ever see, and still not a top-ten placement. The rule is the plain ordinal.
    const list = oneGenre(12, 60);

    expect(genreRanksFor('subject', list)).toEqual([
      { genre: 'Thriller', rank: 12, total: 60 },
    ]);
    expect(shownGenreRanksFor('subject', list)).toEqual([]);
  });

  it('keeps a placement at exactly tenth, which is the boundary', () => {
    expect(shownGenreRanksFor('subject', oneGenre(10, 60))).toEqual([
      { genre: 'Thriller', rank: 10, total: 60 },
    ]);
    expect(shownGenreRanksFor('subject', oneGenre(11, 60))).toEqual([]);
  });

  it('filters before it slices, so a qualifying placement is never crowded out', () => {
    // Three genres. Ordered by proportional strength the two best are both past ten, and
    // the one that qualifies is last — so a filter applied after the slice would return
    // nothing at all where one line is correct.
    const list: RankedRow[] = [];
    for (let i = 1; i <= 60; i += 1) {
      const genres = ['Wide'];
      if (i <= 40) genres.push('Middle');
      if (i <= 12) genres.push('Narrow');
      list.push({ mediaItemId: `f${i}`, position: i, genres });
    }
    list[11] = { mediaItemId: 'subject', position: 12, genres: ['Wide', 'Middle', 'Narrow'] };

    // 12 of 60, 12 of 40, 12 of 12 — best ratio first, and only the last is a top-ten…
    expect(genreRanksFor('subject', list, Number.MAX_SAFE_INTEGER).map((e) => e.genre)).toEqual([
      'Wide',
      'Middle',
      'Narrow',
    ]);
    // …which is to say none of them are, at rank 12. Nothing is printed.
    expect(shownGenreRanksFor('subject', list)).toEqual([]);
  });

  it('keeps the proportional ordering among the placements that do qualify', () => {
    // The ordering rule is untouched by the filter: #2 of 40 still outranks #1 of 6.
    const list: RankedRow[] = [];
    for (let i = 1; i <= 40; i += 1) {
      const genres = ['Big'];
      if (i <= 6) genres.push('Small');
      list.push({ mediaItemId: `f${i}`, position: i, genres });
    }
    list[1] = { mediaItemId: 'subject', position: 2, genres: ['Big', 'Small'] };

    expect(shownGenreRanksFor('subject', list)).toEqual([
      { genre: 'Big', rank: 2, total: 40 },
      { genre: 'Small', rank: 2, total: 6 },
    ]);
  });

  it('never returns more than the reveal draws', () => {
    const list: RankedRow[] = [];
    const all = ['A', 'B', 'C', 'D'];
    for (let i = 1; i <= 30; i += 1) list.push({ mediaItemId: `f${i}`, position: i, genres: all });
    list[1] = { mediaItemId: 'subject', position: 2, genres: all };

    expect(shownGenreRanksFor('subject', list)).toHaveLength(MAX_GENRE_LINES);
  });

  it('is the same number the title-page hero uses', () => {
    // One founder number, one definition. The hero has drawn at most one top-ten label
    // since 2026-08-28 and the reveal joined it on 2026-09-05; two constants would
    // eventually be two rules.
    expect(TOP_RANK_SHOWN).toBe(10);
  });
});
