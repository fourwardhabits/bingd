import { pickPersonBackdrop } from './backdrop';
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
