import { nextSortState, spokenSortLabel } from '@/ui/sort';

import {
  BRAD_PITT,
  BRYAN_CRANSTON,
  CHRISTOPHER_NOLAN,
  NEWCOMER,
  type PersonFixture,
} from './__fixtures__/people';
import {
  FILMOGRAPHY_AXES,
  INITIAL_FILMOGRAPHY_SORT,
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

const titles = (credits: PersonCredit[]) => credits.map((credit) => credit.title);

/**
 * **Release date, newest first, is the only sort** (founder QA, 2026-11-12). Popular and
 * Highest rated (TMDB) are no longer offered, whatever the credits carry.
 */
describe('the sorts offered', () => {
  it('opens on Release date, newest first', () => {
    expect(INITIAL_FILMOGRAPHY_SORT).toEqual({ axis: 'released', direction: 'desc' });
  });

  it('offers Release date and nothing else — no Popular, no Highest rated (TMDB)', () => {
    expect(FILMOGRAPHY_AXES.map((axis) => axis.label)).toEqual(['Release date']);
    // Not even for a filmography that carries TMDB scores, which used to add the rating.
    expect(pittCast.some((credit) => credit.score !== null)).toBe(true);
    expect(FILMOGRAPHY_AXES.map((axis) => axis.axis)).toEqual(['released']);
  });

  it('keeps both directions: newest and oldest', () => {
    expect(FILMOGRAPHY_AXES[0]?.directions).toEqual({
      desc: 'newest first',
      asc: 'oldest first',
    });
  });

  it('draws the opening order newest first, with the undated tail last', () => {
    const sorted = sortFilmography(pittMovies, INITIAL_FILMOGRAPHY_SORT);
    expect(titles(sorted).slice(0, 2)).toEqual(['F1', 'Wolfs']);
    expect(sorted.at(-1)?.title).toBe('Untitled Brad Pitt Project');
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
    expect(tailStart(sorted)).toBe(sorted.length - 1);
    // A list that is all tail has nothing to set it apart from.
    const undated = sortFilmography(
      pittMovies.filter((credit) => !credit.releaseDate),
      NEWEST,
    );
    expect(tailStart(undated)).toBeNull();
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
    const axes = FILMOGRAPHY_AXES;
    // It opens on newest first, so the first press flips it to oldest, and the next back.
    const flipped = nextSortState(INITIAL_FILMOGRAPHY_SORT, 'released', axes);
    expect(flipped).toEqual(OLDEST);
    expect(nextSortState(flipped, 'released', axes)).toEqual(NEWEST);
    expect(spokenSortLabel(NEWEST, axes)).toBe('Sort. Release date, newest first');
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
    for (const sort of [NEWEST, OLDEST]) {
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
  });

  it('somebody with two credits and one date', () => {
    const credits = creditsOf(NEWCOMER);
    expect(titles(sortFilmography(credits, NEWEST))).toEqual(['Harbour', 'First Light']);
    expect(titles(sortFilmography(credits, OLDEST))).toEqual(['Harbour', 'First Light']);
  });
});
