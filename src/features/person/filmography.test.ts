import { nextSortState, spokenSortLabel } from '@/ui/sort';

import {
  BRAD_PITT,
  BRYAN_CRANSTON,
  CHRISTOPHER_NOLAN,
  NEWCOMER,
  type PersonFixture,
} from './__fixtures__/people';
import {
  INITIAL_FILMOGRAPHY_SORT,
  filmographyAxes,
  sortCoverage,
  sortFilmography,
  tailStart,
  type FilmographySort,
} from './filmography';
import type { KindCoverage, PersonCoverage, PersonCredit } from './use-person';

/** The fixture as `usePerson` would hand it to the page. */
function creditsOf(fixture: PersonFixture): PersonCredit[] {
  const byId = new Map(fixture.items.map((item) => [item.id, item]));
  const entries = fixture.cache.payload.credits as {
    id: string;
    kind: 'movie' | 'series';
    role: string | null;
    as: 'cast' | 'crew';
    crew_role: string | null;
    self: boolean;
    tmdb_score?: number | null;
  }[];
  return entries.map((entry, order) => {
    const item = byId.get(entry.id)!;
    return {
      mediaItemId: entry.id,
      title: item.title,
      kind: entry.kind,
      year: item.release_date ? Number(item.release_date.slice(0, 4)) : null,
      releaseDate: item.release_date,
      posterPath: item.poster_path,
      role: entry.role,
      as: entry.as,
      crewRole: entry.crew_role,
      self: entry.self,
      score: entry.tmdb_score ?? null,
      order,
    };
  });
}

const coverageOf = (fixture: PersonFixture) => fixture.cache.payload.coverage as PersonCoverage;

const pitt = creditsOf(BRAD_PITT);
const pittCast = pitt.filter((credit) => credit.as === 'cast' && !credit.self);
const pittMovies = pittCast.filter((credit) => credit.kind === 'movie');

const NEWEST: FilmographySort = { axis: 'released', direction: 'desc' };
const OLDEST: FilmographySort = { axis: 'released', direction: 'asc' };
const RATED: FilmographySort = { axis: 'rating', direction: 'desc' };

const titles = (credits: PersonCredit[]) => credits.map((credit) => credit.title);

describe('Popular, the default', () => {
  it('opens on Popular', () => {
    expect(INITIAL_FILMOGRAPHY_SORT).toEqual({ axis: 'popular', direction: 'desc' });
  });

  it('is exactly the cache’s own order', () => {
    expect(titles(sortFilmography(pittCast, INITIAL_FILMOGRAPHY_SORT))).toEqual(
      titles(pittCast),
    );
  });

  it('restores the cache order from any other order', () => {
    const shuffled = sortFilmography(pittCast, NEWEST);
    expect(titles(sortFilmography(shuffled, INITIAL_FILMOGRAPHY_SORT))).toEqual(
      titles(pittCast),
    );
  });

  it('never claims more or less than the stated count', () => {
    expect(
      sortCoverage(pittCast, INITIAL_FILMOGRAPHY_SORT, coverageOf(BRAD_PITT), 'cast', 'all'),
    ).toEqual({
      kind: 'complete',
    });
  });
});

describe('Release date', () => {
  it('puts the newest first', () => {
    expect(titles(sortFilmography(pittMovies, NEWEST)).slice(0, 4)).toEqual([
      'F1',
      'Wolfs',
      // Same day: the better-known title first, then by id — never by chance.
      'Bullet Train',
      'Babylon',
    ]);
  });

  it('puts the oldest first', () => {
    expect(titles(sortFilmography(pittMovies, OLDEST)).slice(0, 3)).toEqual([
      'Cutting Class',
      'Thelma & Louise',
      'Se7en',
    ]);
  });

  it('puts undated credits last in both directions', () => {
    expect(sortFilmography(pittMovies, NEWEST).at(-1)?.title).toBe(
      'Untitled Brad Pitt Project',
    );
    expect(sortFilmography(pittMovies, OLDEST).at(-1)?.title).toBe(
      'Untitled Brad Pitt Project',
    );
  });

  it('labels where the undated tail begins', () => {
    const sorted = sortFilmography(pittMovies, NEWEST);
    expect(tailStart(sorted, NEWEST)).toBe(sorted.length - 1);
    // A list that is all tail has nothing to set it apart from.
    const undated = sortFilmography(
      pittMovies.filter((credit) => !credit.releaseDate),
      NEWEST,
    );
    expect(tailStart(undated, NEWEST)).toBeNull();
  });

  it('is stable: the same input sorts the same way every time, whatever order it arrives in', () => {
    const forward = titles(sortFilmography(pittCast, NEWEST));
    const reversed = titles(sortFilmography([...pittCast].reverse(), NEWEST));
    expect(reversed).toEqual(forward);
  });

  it('does not mutate what it was given', () => {
    const before = titles(pittCast);
    sortFilmography(pittCast, NEWEST);
    expect(titles(pittCast)).toEqual(before);
  });

  it('flips between newest and oldest on the shared control', () => {
    const axes = filmographyAxes(pittCast);
    const chosen = nextSortState(INITIAL_FILMOGRAPHY_SORT, 'released', axes);
    expect(chosen).toEqual(NEWEST);
    expect(nextSortState(chosen, 'released', axes)).toEqual(OLDEST);
    expect(spokenSortLabel(chosen, axes)).toBe('Sort. Release date, newest first');
    expect(spokenSortLabel(OLDEST, axes)).toBe('Sort. Release date, oldest first');
  });
});

describe('where a sort over a capped filmography stops being complete', () => {
  it('vouches for every film newer than the newest one the cache dropped', () => {
    const sorted = sortFilmography(pittMovies, NEWEST);
    const result = sortCoverage(sorted, NEWEST, coverageOf(BRAD_PITT), 'cast', 'movie');
    // F1, Wolfs, Bullet Train, Babylon, Ad Astra, Once Upon a Time — then 2013.
    expect(result).toEqual({ kind: 'partial', from: 6, tailOnly: false });
    expect(sorted[6]?.title).toBe('World War Z');
  });

  it('vouches for every film older than the oldest one dropped', () => {
    const sorted = sortFilmography(pittMovies, OLDEST);
    expect(sortCoverage(sorted, OLDEST, coverageOf(BRAD_PITT), 'cast', 'movie')).toEqual({
      kind: 'partial',
      from: 1,
      tailOnly: false,
    });
  });

  it('takes the more cautious kind under All', () => {
    // Television dropped a 1987 credit, so under All only Dallas (1978) is vouched for.
    const sorted = sortFilmography(pittCast, OLDEST);
    expect(titles(sorted).slice(0, 2)).toEqual(['Dallas', 'Cutting Class']);
    expect(sortCoverage(sorted, OLDEST, coverageOf(BRAD_PITT), 'cast', 'all')).toEqual({
      kind: 'partial',
      from: 1,
      tailOnly: false,
    });
  });

  it('is complete for somebody nothing was dropped for', () => {
    const nolan = creditsOf(CHRISTOPHER_NOLAN);
    for (const sort of [NEWEST, OLDEST, RATED]) {
      expect(
        sortCoverage(
          sortFilmography(nolan, sort),
          sort,
          coverageOf(CHRISTOPHER_NOLAN),
          'crew',
          'all',
        ),
      ).toEqual({
        kind: 'complete',
      });
    }
  });

  it('cannot say anything for a row cached before coverage existed', () => {
    expect(sortCoverage(pittCast, NEWEST, null, 'cast', 'all')).toEqual({ kind: 'unknown' });
  });

  it('marks the end of the list when only the undated tail lost anything', () => {
    const credits = creditsOf(BRYAN_CRANSTON);
    const coverage = structuredClone(coverageOf(BRYAN_CRANSTON));
    coverage.cast.series.undated = true;
    const sorted = sortFilmography(credits, NEWEST);
    expect(sortCoverage(sorted, NEWEST, coverage, 'cast', 'all')).toEqual({
      kind: 'partial',
      from: sorted.length,
      tailOnly: true,
    });
  });
});

describe('review fixes: what a partial record may and may not claim', () => {
  const NONE: KindCoverage = {
    newest: null,
    oldest: null,
    undated: false,
    rated: null,
    unrated: false,
  };
  const only = (kind: Partial<KindCoverage>) =>
    ({
      cast: { movie: { ...NONE, ...kind }, series: NONE },
      self: { movie: NONE, series: NONE },
      crew: { movie: NONE, series: NONE },
    }) as PersonCoverage;

  it('decides oldest-first by the oldest end, not the newest', () => {
    const sorted = sortFilmography(pittMovies, OLDEST);
    const result = sortCoverage(
      sorted,
      OLDEST,
      only({ oldest: '1990-01-01' }),
      'cast',
      'movie',
    );
    expect(result.kind).toBe('partial');
  });

  it('names the undated tail when that is all that was lost', () => {
    const sorted = sortFilmography(pittMovies, NEWEST);
    const result = sortCoverage(sorted, NEWEST, only({ undated: true }), 'cast', 'movie');
    expect(result).toEqual({ kind: 'partial', from: sorted.length - 1, tailOnly: true });
  });

  it('names the unrated tail when that is all that was lost', () => {
    const sorted = sortFilmography(pittMovies, RATED);
    const result = sortCoverage(sorted, RATED, only({ unrated: true }), 'cast', 'movie');
    expect(result).toEqual({ kind: 'partial', from: sorted.length - 2, tailOnly: true });
  });
});

describe('Highest rated (TMDB)', () => {
  it('is offered only where something has a TMDB score', () => {
    expect(filmographyAxes(pittCast).map((axis) => axis.axis)).toEqual([
      'popular',
      'released',
      'rating',
    ]);
    expect(filmographyAxes(creditsOf(NEWCOMER)).map((axis) => axis.axis)).toEqual([
      'popular',
      'released',
    ]);
  });

  it('names whose rating it is', () => {
    const axes = filmographyAxes(pittCast);
    expect(spokenSortLabel(RATED, axes)).toBe('Sort. Highest rated (TMDB)');
  });

  it('orders by score, with ties to the better-known title', () => {
    const sorted = titles(sortFilmography(pittMovies, RATED));
    expect(sorted.slice(0, 4)).toEqual(['Fight Club', 'Se7en', 'Inglourious Basterds', 'F1']);
    // Once Upon a Time and Ocean's Eleven and Thelma & Louise share 7.4, in popularity order.
    expect(sorted.slice(5, 8)).toEqual([
      'Once Upon a Time… in Hollywood',
      "Ocean's Eleven",
      'Thelma & Louise',
    ]);
  });

  it('sends a credit with too few votes to the end rather than the top', () => {
    const sorted = sortFilmography(pittMovies, RATED);
    expect(titles(sorted).slice(-2)).toEqual(['Untitled Brad Pitt Project', 'Cutting Class']);
    expect(tailStart(sorted, RATED)).toBe(sorted.length - 2);
  });

  it('says where it stops vouching for what is above', () => {
    const sorted = sortFilmography(pittMovies, RATED);
    const result = sortCoverage(sorted, RATED, coverageOf(BRAD_PITT), 'cast', 'movie');
    // A dropped film scored 7.0, so Babylon's 7.0 is the first row it cannot vouch for.
    expect(result.kind).toBe('partial');
    expect(result.kind === 'partial' && sorted[result.from]?.title).toBe('Babylon');
  });
});

describe('the four kinds of person', () => {
  it('a primarily television actor sorts by first air date', () => {
    expect(titles(sortFilmography(creditsOf(BRYAN_CRANSTON), NEWEST))).toEqual([
      'Your Honor',
      'Argo',
      'Breaking Bad',
      'Malcolm in the Middle',
      'Seinfeld',
    ]);
  });

  it('a director’s work, newest first, includes the film not yet rated', () => {
    const sorted = sortFilmography(creditsOf(CHRISTOPHER_NOLAN), NEWEST);
    expect(sorted[0]?.title).toBe('The Odyssey');
    expect(sortFilmography(creditsOf(CHRISTOPHER_NOLAN), RATED).at(-1)?.title).toBe(
      'The Odyssey',
    );
  });

  it('somebody with two credits and one date', () => {
    const credits = creditsOf(NEWCOMER);
    expect(titles(sortFilmography(credits, NEWEST))).toEqual(['Harbour', 'First Light']);
    expect(titles(sortFilmography(credits, OLDEST))).toEqual(['Harbour', 'First Light']);
  });
});
