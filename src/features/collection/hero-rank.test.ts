import { heroRankFor, type HeroRankRow } from './hero-rank';

/**
 * One rank line in the hero, chosen by the founder's rule: top ten overall wins,
 * otherwise the strongest category placement, never more than one.
 *
 * Everything here derives from ranking rows the client already holds. The tests that
 * matter are the ones proving nothing is invented — a genre too small to mean
 * anything must not produce a line.
 */

const row = (
  id: string,
  position: number,
  genres: string[] = [],
  language: string | null = null,
): HeroRankRow => ({ mediaItemId: id, position, genres, language });

/** `n` filler rows carrying the given genre, so a facet can reach its minimum size. */
const filler = (count: number, genres: string[], from = 100, language: string | null = null) =>
  Array.from({ length: count }, (_, i) => row(`filler-${from + i}`, from + i, genres, language));

const named = (code: string) => ({ te: 'Telugu', en: 'English' })[code] ?? null;

describe('top ten overall', () => {
  it('wins outright, with no qualifier', () => {
    const rows = [row('a', 3, ['Sci-Fi']), ...filler(10, ['Sci-Fi'])];
    expect(heroRankFor('a', rows, 'movies')).toEqual({ label: '#3 in Movies', basis: 'overall' });
  });

  it('names the TV list correctly', () => {
    const rows = [row('a', 1, [])];
    expect(heroRankFor('a', rows, 'tv_seasons')?.label).toBe('#1 in TV seasons');
  });

  it('stops at ten', () => {
    const rows = [row('a', 10, [])];
    expect(heroRankFor('a', rows, 'movies')?.basis).toBe('overall');
  });
});

describe('below the top ten', () => {
  it('shows the genre placement instead', () => {
    // 40th overall, but second among the science fiction.
    const rows = [
      row('first-scifi', 1, ['Sci-Fi']),
      row('a', 40, ['Sci-Fi']),
      ...filler(8, ['Sci-Fi']),
    ];

    expect(heroRankFor('a', rows, 'movies')).toEqual({ label: '#2 in Sci-Fi', basis: 'genre' });
  });

  it('prefers the proportionally stronger facet, not the smaller number', () => {
    // #1 of 6 Horror against #2 of 40 Sci-Fi: the second is the better placement,
    // and picking by the bare ordinal would always favour the tiny genre.
    const rows = [
      row('top-scifi', 1, ['Sci-Fi']),
      row('a', 40, ['Sci-Fi', 'Horror']),
      ...filler(38, ['Sci-Fi'], 200),
      ...filler(5, ['Horror'], 400),
    ];

    expect(heroRankFor('a', rows, 'movies')?.label).toBe('#2 in Sci-Fi');
  });

  it('can choose a language when that is the strongest placement', () => {
    const rows = [
      row('a', 40, [], 'te'),
      ...filler(9, [], 500, 'te'),
    ];

    expect(heroRankFor('a', rows, 'movies', named)).toEqual({
      label: '#1 in Telugu',
      basis: 'language',
    });
  });

  it('drops a language it cannot name rather than printing a code', () => {
    // "#1 in xx" is worse than no line at all.
    const rows = [row('a', 40, [], 'xx'), ...filler(9, [], 600, 'xx')];
    expect(heroRankFor('a', rows, 'movies', named)?.basis).toBe('overall');
  });
});

describe('what it refuses to invent', () => {
  it('does not print a genre rank the genre is too small to support', () => {
    // Two comedies. "#1 in Comedy" says nothing about the film and a lot about how
    // little has been ranked, so the overall position is shown instead.
    const rows = [row('a', 40, ['Comedy']), row('b', 41, ['Comedy'])];

    expect(heroRankFor('a', rows, 'movies')).toEqual({
      label: '#40 in Movies',
      basis: 'overall',
    });
  });

  it('falls back to the real overall rank rather than showing nothing', () => {
    const rows = [row('a', 99, [])];
    expect(heroRankFor('a', rows, 'movies')?.label).toBe('#99 in Movies');
  });

  it('returns nothing for a title that is not ranked at all', () => {
    expect(heroRankFor('missing', [row('a', 1, [])], 'movies')).toBeNull();
  });

  it('never returns more than one line', () => {
    const rows = [
      row('top', 1, ['Sci-Fi']),
      row('a', 40, ['Sci-Fi', 'Horror', 'Drama'], 'te'),
      ...filler(10, ['Sci-Fi', 'Horror', 'Drama'], 700, 'te'),
    ];

    const result = heroRankFor('a', rows, 'movies', named);
    expect(result).not.toBeNull();
    expect(result?.label.match(/#/g)).toHaveLength(1);
  });
});
