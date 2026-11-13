import { HERO_RELEVANCE_WINDOW, pickPersonBackdrop } from './backdrop';
import type { PersonCredit } from './use-person';

/**
 * Which credit lends the person page its hero (founder QA P1-9). The rule is
 * `pickPersonBackdrop`'s doc comment; these pin each clause of it.
 */

const TODAY = '2026-11-13';

let next = 0;
const credit = (overrides: Partial<PersonCredit> & { mediaItemId: string }): PersonCredit => ({
  title: overrides.mediaItemId,
  kind: 'movie',
  year: null,
  posterPath: null,
  backdropPath: `/${overrides.mediaItemId}.jpg`,
  role: 'Somebody',
  as: 'cast',
  crewRole: null,
  self: false,
  releaseDate: '2020-01-01',
  score: null,
  order: next++,
  ...overrides,
});

const picked = (credits: PersonCredit[], today = TODAY) =>
  pickPersonBackdrop(credits, today)?.mediaItemId ?? null;

beforeEach(() => {
  next = 0;
});

describe('pickPersonBackdrop', () => {
  it('is null for nobody’s credits — the page keeps its branded band', () => {
    expect(pickPersonBackdrop([], TODAY)).toBeNull();
  });

  it('is null when no credit has a backdrop', () => {
    expect(
      picked([
        credit({ mediaItemId: 'a', backdropPath: null }),
        credit({ mediaItemId: 'b', backdropPath: null, as: 'crew', crewRole: 'Director' }),
      ]),
    ).toBeNull();
  });

  it('takes the most recently released acting credit, not the most popular', () => {
    expect(
      picked([
        credit({ mediaItemId: 'popular', releaseDate: '2010-07-16' }),
        credit({ mediaItemId: 'latest', releaseDate: '2025-03-01' }),
        credit({ mediaItemId: 'middle', releaseDate: '2019-07-26' }),
      ]),
    ).toBe('latest');
  });

  it('returns the credit itself, so the page reads its backdrop path', () => {
    const credits = [credit({ mediaItemId: 'only', backdropPath: '/only-backdrop.jpg' })];
    expect(pickPersonBackdrop(credits, TODAY)?.backdropPath).toBe('/only-backdrop.jpg');
  });

  it('skips a credit dated after today, and counts one released today', () => {
    expect(
      picked([
        credit({ mediaItemId: 'announced', releaseDate: '2027-05-01' }),
        credit({ mediaItemId: 'tomorrow', releaseDate: '2026-11-14' }),
        credit({ mediaItemId: 'older', releaseDate: '2024-01-01' }),
      ]),
    ).toBe('older');
    expect(
      picked([
        credit({ mediaItemId: 'today', releaseDate: TODAY }),
        credit({ mediaItemId: 'older', releaseDate: '2024-01-01' }),
      ]),
    ).toBe('today');
  });

  it('skips an undated credit: it cannot be shown to be released', () => {
    expect(
      picked([
        credit({ mediaItemId: 'undated', releaseDate: null }),
        credit({ mediaItemId: 'dated', releaseDate: '1999-10-15' }),
      ]),
    ).toBe('dated');
  });

  it('falls further down the list past a newer credit with no backdrop', () => {
    expect(
      picked([
        credit({ mediaItemId: 'newest', releaseDate: '2026-01-01', backdropPath: null }),
        credit({ mediaItemId: 'next', releaseDate: '2023-01-01' }),
        credit({ mediaItemId: 'oldest', releaseDate: '2001-01-01' }),
      ]),
    ).toBe('next');
  });

  it('breaks a tie on the date by popularity, then by id', () => {
    expect(
      picked([
        credit({ mediaItemId: 'z-less-popular', releaseDate: '2024-05-01', order: 7 }),
        credit({ mediaItemId: 'y-more-popular', releaseDate: '2024-05-01', order: 2 }),
      ]),
    ).toBe('y-more-popular');
    // The same order on both — only possible in data that skipped the cache — falls to id,
    // so the answer does not depend on which arrived first.
    const tie = [
      credit({ mediaItemId: 'b', releaseDate: '2024-05-01', order: 3 }),
      credit({ mediaItemId: 'a', releaseDate: '2024-05-01', order: 3 }),
    ];
    expect(picked(tie)).toBe('a');
    expect(picked([...tie].reverse())).toBe('a');
  });

  it('leaves out self-appearances — talk shows, the news, ceremonies — even the newest', () => {
    expect(
      picked([
        credit({
          mediaItemId: 'talk-show',
          kind: 'series',
          self: true,
          releaseDate: '2026-10-01',
        }),
        credit({ mediaItemId: 'awards', kind: 'movie', self: true, releaseDate: '2026-03-10' }),
        credit({ mediaItemId: 'film', releaseDate: '2018-01-01' }),
      ]),
    ).toBe('film');
  });

  it('prefers any acting credit to a newer crew credit', () => {
    expect(
      picked([
        credit({
          mediaItemId: 'produced',
          as: 'crew',
          crewRole: 'Producer',
          releaseDate: '2026-01-01',
        }),
        credit({ mediaItemId: 'acted', releaseDate: '2012-01-01' }),
      ]),
    ).toBe('acted');
  });

  it('counts an acting credit they also directed as acting', () => {
    expect(
      picked([
        credit({ mediaItemId: 'both', crewRole: 'Director', releaseDate: '2015-01-01' }),
      ]),
    ).toBe('both');
  });

  describe('for somebody with no acting credit to use', () => {
    const director = (overrides: Partial<PersonCredit> & { mediaItemId: string }) =>
      credit({ as: 'crew', crewRole: 'Director', role: 'Director', ...overrides });

    it('takes their most recently released crew credit', () => {
      expect(
        picked([
          director({ mediaItemId: 'inception', releaseDate: '2010-07-16' }),
          director({ mediaItemId: 'oppenheimer', releaseDate: '2023-07-21' }),
          director({ mediaItemId: 'next-film', releaseDate: '2027-07-17' }),
        ]),
      ).toBe('oppenheimer');
    });

    it('then any crew credit with a backdrop, most popular first', () => {
      expect(
        picked([
          director({ mediaItemId: 'announced', releaseDate: '2027-07-17', order: 4 }),
          director({ mediaItemId: 'undated', releaseDate: null, order: 1 }),
        ]),
      ).toBe('undated');
    });

    it('is reached when their only acting is unusable, and not for self-appearances', () => {
      expect(
        picked([
          credit({ mediaItemId: 'cameo-no-art', backdropPath: null }),
          credit({ mediaItemId: 'acting-announced', releaseDate: '2028-01-01' }),
          credit({ mediaItemId: 'host', kind: 'series', self: true, crewRole: 'Producer' }),
          director({ mediaItemId: 'directed', releaseDate: '2005-06-15' }),
        ]),
      ).toBe('directed');
    });

    it('is null when no crew credit has a backdrop either', () => {
      expect(
        picked([
          director({ mediaItemId: 'a', backdropPath: null }),
          credit({ mediaItemId: 'self', self: true }),
        ]),
      ).toBeNull();
    });
  });
});

/**
 * **Highest-rated first** (founder spec §6, 2026-11-13). `score` is TMDB's audience rating,
 * weighted by vote count and null below the vote floor, so a null is "not reliably rated".
 */
describe('pickPersonBackdrop — highest-rated eligible work first', () => {
  it('takes the highest-rated acting credit over the newest one', () => {
    expect(
      picked([
        credit({ mediaItemId: 'newest', releaseDate: '2025-06-01', score: 6.4 }),
        credit({ mediaItemId: 'acclaimed', releaseDate: '2008-07-18', score: 8.5 }),
        credit({ mediaItemId: 'middling', releaseDate: '2016-02-12', score: 7.1 }),
      ]),
    ).toBe('acclaimed');
  });

  it('never lets a title with too few votes to rate win on a rating', () => {
    // Below the vote floor the adapter writes no score at all: it cannot compete.
    expect(
      picked([
        credit({ mediaItemId: 'unreviewed', releaseDate: '2025-01-01', score: null }),
        credit({ mediaItemId: 'rated', releaseDate: '2012-01-01', score: 6.9 }),
      ]),
    ).toBe('rated');
  });

  it('falls back to the newest released acting credit when none is reliably rated', () => {
    expect(
      picked([
        credit({ mediaItemId: 'old', releaseDate: '2001-01-01', score: null }),
        credit({ mediaItemId: 'new', releaseDate: '2024-01-01', score: null }),
      ]),
    ).toBe('new');
  });

  it('keeps the rating contest to their best-known work', () => {
    // Eleven popular credits, then a revered title they have a cameo in, far down the
    // popularity order: the cameo does not stand for them.
    const known = Array.from({ length: HERO_RELEVANCE_WINDOW }, (_, n) =>
      credit({ mediaItemId: `known-${n}`, score: 6 + n / 100, order: n }),
    );
    const cameo = credit({ mediaItemId: 'cameo', score: 9.3, order: 40 });
    expect(picked([...known, cameo])).toBe(`known-${HERO_RELEVANCE_WINDOW - 1}`);
  });

  it('never picks a self-appearance, however well rated', () => {
    expect(
      picked([
        credit({ mediaItemId: 'talk-show', self: true, score: 9.6, order: 0 }),
        credit({ mediaItemId: 'film', score: 7.0, order: 1 }),
      ]),
    ).toBe('film');
  });

  it('never picks an unreleased or undated credit, however well rated', () => {
    expect(
      picked([
        credit({ mediaItemId: 'upcoming', releaseDate: '2027-05-01', score: 9.9 }),
        credit({ mediaItemId: 'undated', releaseDate: null, score: 9.8 }),
        credit({ mediaItemId: 'out', releaseDate: '2019-01-01', score: 6.1 }),
      ]),
    ).toBe('out');
  });

  it('needs a backdrop: the best rating without artwork gives way', () => {
    expect(
      picked([
        credit({ mediaItemId: 'no-art', backdropPath: null, score: 9.1, order: 0 }),
        credit({ mediaItemId: 'art', score: 7.2, order: 1 }),
      ]),
    ).toBe('art');
  });

  it('breaks an equal rating by popularity, then by id', () => {
    expect(
      picked([
        credit({ mediaItemId: 'b-less', score: 8.0, order: 5 }),
        credit({ mediaItemId: 'a-more', score: 8.0, order: 2 }),
      ]),
    ).toBe('a-more');
    expect(
      picked([
        credit({ mediaItemId: 'zz', score: 8.0, order: 3 }),
        credit({ mediaItemId: 'aa', score: 8.0, order: 3 }),
      ]),
    ).toBe('aa');
  });

  it('picks the same credit whatever order the credits arrive in', () => {
    const credits = [
      credit({ mediaItemId: 'x', score: 7.5, order: 4, releaseDate: '2010-01-01' }),
      credit({ mediaItemId: 'y', score: 8.2, order: 1, releaseDate: '2015-01-01' }),
      credit({ mediaItemId: 'z', score: 8.2, order: 6, releaseDate: '2023-01-01' }),
      credit({ mediaItemId: 'w', score: null, order: 0, releaseDate: '2025-01-01' }),
    ];
    const once = picked(credits);
    expect(once).toBe('y');
    expect(picked([...credits].reverse())).toBe(once);
    expect(picked([credits[2]!, credits[0]!, credits[3]!, credits[1]!])).toBe(once);
  });

  it('still falls to their crew work, and then to the band', () => {
    expect(
      picked([
        credit({ mediaItemId: 'directed', as: 'crew', crewRole: 'Director', score: 7.7 }),
        credit({ mediaItemId: 'appearance', self: true, score: 9 }),
      ]),
    ).toBe('directed');
    expect(picked([credit({ mediaItemId: 'appearance', self: true, score: 9 })])).toBeNull();
  });
});
