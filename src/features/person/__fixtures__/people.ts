/**
 * Four people, shaped exactly as `person_cache` and `media_items` hold them, for the
 * person page's tests.
 *
 * **Shaped like the real thing, not copied from it.** Titles, years and roles are the
 * public record as far as it matters to a sort; the TMDB scores, popularity order,
 * totals and coverage are invented to exercise the page, and are not TMDB's numbers.
 *
 * - `BRAD_PITT` — a prolific actor-producer: a capped Cast half with coverage gaps, a
 *   Crew half, a series, a self-appearance, an undated announced project and a
 *   thinly voted early film.
 * - `BRYAN_CRANSTON` — primarily television, nothing capped.
 * - `CHRISTOPHER_NOLAN` — crew only: directing, writing, producing.
 * - `NEWCOMER` — a fictional actor with two credits, no portrait, no biography, no dates.
 *
 * `legacy()` strips a fixture back to what a row cached before 2026-11-11 carries: no
 * scores and no coverage.
 */

type Kind = 'movie' | 'series';

type Credit = {
  id: string;
  kind: Kind;
  title: string;
  date: string | null;
  poster?: string | null;
  role: string | null;
  as: 'cast' | 'crew';
  crewRole?: string | null;
  self?: boolean;
  score?: number | null;
};

type Coverage = {
  newest: string | null;
  oldest: string | null;
  undated: boolean;
  rated: number | null;
  unrated: boolean;
};

const NONE: Coverage = {
  newest: null,
  oldest: null,
  undated: false,
  rated: null,
  unrated: false,
};
const COMPLETE = {
  cast: { movie: NONE, series: NONE },
  self: { movie: NONE, series: NONE },
  crew: { movie: NONE, series: NONE },
};

export type PersonFixture = {
  tmdbId: number;
  cache: { tmdb_person_id: number; expires_at: string; payload: Record<string, unknown> };
  items: {
    id: string;
    kind: Kind;
    title: string;
    release_date: string | null;
    poster_path: string | null;
  }[];
};

const FRESH = () => new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

function build(
  tmdbId: number,
  person: Record<string, unknown>,
  credits: Credit[],
  extra: { credit_total: number; cast_total: number; crew_total: number; coverage: unknown },
): PersonFixture {
  return {
    tmdbId,
    cache: {
      tmdb_person_id: tmdbId,
      expires_at: FRESH(),
      payload: {
        person,
        credits: credits.map((credit) => ({
          id: credit.id,
          kind: credit.kind,
          role: credit.role,
          as: credit.as,
          crew_role: credit.crewRole ?? (credit.as === 'crew' ? credit.role : null),
          self: credit.self ?? false,
          tmdb_score: credit.score ?? null,
        })),
        ...extra,
      },
    },
    items: credits.map((credit) => ({
      id: credit.id,
      kind: credit.kind,
      title: credit.title,
      release_date: credit.date,
      poster_path: credit.poster === undefined ? `/${credit.id}.jpg` : credit.poster,
    })),
  };
}

const movie = (
  id: string,
  title: string,
  date: string | null,
  role: string,
  score: number | null,
  extra: Partial<Credit> = {},
): Credit => ({
  id,
  kind: 'movie',
  title,
  date,
  role,
  as: 'cast',
  score,
  ...extra,
});

/** In the cache's popularity order, which is the order this array is in. */
export const BRAD_PITT = build(
  287,
  {
    name: 'Brad Pitt',
    profile_path: '/pitt.jpg',
    known_for: 'Acting',
    // Long, and cut by the adapter's 1,200-character cap: the case the page must not
    // promise in full.
    biography:
      'William Bradley Pitt is an American actor and film producer. '.repeat(19) +
      'He has received several accolades, including two Academy Awards and two British Academy Film Awards',
    biography_truncated: true,
    birthday: '1963-12-18',
    place_of_birth: 'Shawnee, Oklahoma, USA',
  },
  [
    movie('bp-fight-club', 'Fight Club', '1999-10-15', 'Tyler Durden', 8.43),
    movie('bp-ouatih', 'Once Upon a Time… in Hollywood', '2019-07-24', 'Cliff Booth', 7.4),
    movie('bp-se7en', 'Se7en', '1995-09-22', 'Detective David Mills', 8.37),
    movie('bp-basterds', 'Inglourious Basterds', '2009-08-02', 'Lt. Aldo Raine', 8.2),
    movie('bp-troy', 'Troy', '2004-05-13', 'Achilles', 7.1),
    movie('bp-oceans', "Ocean's Eleven", '2001-12-07', 'Rusty Ryan', 7.4),
    movie('bp-f1', 'F1', '2025-06-25', 'Sonny Hayes', 7.8),
    movie('bp-bullet-train', 'Bullet Train', '2022-08-03', 'Ladybug', 7.3),
    // Two titles on one day, the deterministic tie-break's case.
    movie('bp-babylon', 'Babylon', '2022-08-03', 'Jack Conrad', 7.0),
    {
      id: 'bp-friends',
      kind: 'series',
      title: 'Friends',
      date: '1994-09-22',
      role: 'Will Colbert',
      as: 'cast',
      score: 8.4,
    },
    movie('bp-moneyball', 'Moneyball', '2011-09-22', 'Billy Beane', 7.1, {
      crewRole: 'Producer',
    }),
    movie(
      'bp-button',
      'The Curious Case of Benjamin Button',
      '2008-12-25',
      'Benjamin Button',
      7.6,
    ),
    movie('bp-wwz', 'World War Z', '2013-06-20', 'Gerry Lane', 6.8, { crewRole: 'Producer' }),
    movie('bp-ad-astra', 'Ad Astra', '2019-09-17', 'Roy McBride', 6.1),
    movie('bp-wolfs', 'Wolfs', '2024-09-20', 'Nick', 6.5),
    movie('bp-thelma', 'Thelma & Louise', '1991-05-24', 'J.D.', 7.4),
    // An announced project TMDB has no date for.
    movie('bp-untitled', 'Untitled Brad Pitt Project', null, 'Lead', null),
    // Two votes of ten would have headed a raw-average sort; under the threshold it has no score.
    movie('bp-cutting-class', 'Cutting Class', '1989-03-03', 'Dwight Ingalls', null),
    {
      id: 'bp-dallas',
      kind: 'series',
      title: 'Dallas',
      date: '1978-04-02',
      role: 'Randy',
      as: 'cast',
      score: 7.2,
    },
    {
      id: 'bp-graham',
      kind: 'series',
      title: 'The Graham Norton Show',
      date: '2007-02-22',
      role: 'Self',
      as: 'cast',
      self: true,
      score: 7.0,
    },
    {
      id: 'bp-12-years',
      kind: 'movie',
      title: '12 Years a Slave',
      date: '2013-10-18',
      role: 'Producer',
      as: 'crew',
      score: 7.9,
    },
    {
      id: 'bp-departed',
      kind: 'movie',
      title: 'The Departed',
      date: '2006-10-05',
      role: 'Producer',
      as: 'crew',
      score: 8.2,
    },
  ],
  {
    credit_total: 240,
    cast_total: 89,
    crew_total: 60,
    coverage: {
      cast: {
        // Every film after 15 Nov 2016 is kept, and every one before 2 Aug 1989.
        movie: {
          newest: '2016-11-15',
          oldest: '1989-08-01',
          undated: true,
          rated: 7.0,
          unrated: true,
        },
        series: {
          newest: '2003-01-01',
          oldest: '1987-01-01',
          undated: false,
          rated: null,
          unrated: true,
        },
      },
      self: {
        movie: NONE,
        series: { ...NONE, newest: '2019-01-01', oldest: '1995-01-01', unrated: true },
      },
      crew: {
        movie: {
          newest: '2020-02-01',
          oldest: '2005-01-01',
          undated: false,
          rated: 7.5,
          unrated: false,
        },
        series: NONE,
      },
    },
  },
);

export const BRYAN_CRANSTON = build(
  17419,
  {
    name: 'Bryan Cranston',
    profile_path: '/cranston.jpg',
    known_for: 'Acting',
    biography: 'Bryan Lee Cranston is an American actor and filmmaker.',
    biography_truncated: false,
    birthday: '1956-03-07',
    place_of_birth: 'Hollywood, California, USA',
  },
  [
    {
      id: 'bc-breaking-bad',
      kind: 'series',
      title: 'Breaking Bad',
      date: '2008-01-20',
      role: 'Walter White',
      as: 'cast',
      score: 8.9,
    },
    {
      id: 'bc-malcolm',
      kind: 'series',
      title: 'Malcolm in the Middle',
      date: '2000-01-09',
      role: 'Hal',
      as: 'cast',
      score: 8.5,
    },
    {
      id: 'bc-your-honor',
      kind: 'series',
      title: 'Your Honor',
      date: '2020-12-06',
      role: 'Michael Desiato',
      as: 'cast',
      score: 7.9,
    },
    {
      id: 'bc-seinfeld',
      kind: 'series',
      title: 'Seinfeld',
      date: '1989-07-05',
      role: 'Tim Whatley',
      as: 'cast',
      score: 8.3,
    },
    movie('bc-argo', 'Argo', '2012-10-11', 'Jack O’Donnell', 7.3),
  ],
  { credit_total: 5, cast_total: 5, crew_total: 0, coverage: COMPLETE },
);

export const CHRISTOPHER_NOLAN = build(
  525,
  {
    name: 'Christopher Nolan',
    profile_path: '/nolan.jpg',
    known_for: 'Directing',
    biography: 'Christopher Edward Nolan is a British and American filmmaker.',
    biography_truncated: false,
    birthday: '1970-07-30',
    place_of_birth: 'Westminster, London, England, UK',
  },
  [
    {
      id: 'cn-inception',
      kind: 'movie',
      title: 'Inception',
      date: '2010-07-15',
      role: 'Director, Writer, Producer',
      as: 'crew',
      score: 8.4,
    },
    {
      id: 'cn-oppenheimer',
      kind: 'movie',
      title: 'Oppenheimer',
      date: '2023-07-19',
      role: 'Director, Screenplay',
      as: 'crew',
      score: 8.1,
    },
    {
      id: 'cn-dark-knight',
      kind: 'movie',
      title: 'The Dark Knight',
      date: '2008-07-16',
      role: 'Director, Screenplay',
      as: 'crew',
      score: 8.5,
    },
    {
      id: 'cn-interstellar',
      kind: 'movie',
      title: 'Interstellar',
      date: '2014-11-05',
      role: 'Director, Writer',
      as: 'crew',
      score: 8.4,
    },
    {
      id: 'cn-odyssey',
      kind: 'movie',
      title: 'The Odyssey',
      date: '2026-07-15',
      role: 'Director, Screenplay',
      as: 'crew',
      score: null,
    },
    {
      id: 'cn-man-of-steel',
      kind: 'movie',
      title: 'Man of Steel',
      date: '2013-06-12',
      role: 'Producer',
      as: 'crew',
      score: 6.6,
    },
    {
      id: 'cn-following',
      kind: 'movie',
      title: 'Following',
      date: '1998-09-12',
      role: 'Director, Writer',
      as: 'crew',
      score: 7.1,
    },
  ],
  { credit_total: 7, cast_total: 0, crew_total: 7, coverage: COMPLETE },
);

export const NEWCOMER = build(
  990001,
  {
    name: 'Ada Okafor',
    profile_path: null,
    known_for: null,
    biography: null,
    biography_truncated: false,
    birthday: null,
    place_of_birth: null,
  },
  [
    movie('ao-short', 'First Light', null, 'June', null, { poster: null }),
    movie('ao-feature', 'Harbour', '2025-03-01', 'Nell', null),
  ],
  { credit_total: 2, cast_total: 2, crew_total: 0, coverage: COMPLETE },
);

/** The same person as a row cached before scores and coverage were stored. */
export function legacy(fixture: PersonFixture): PersonFixture {
  const payload = { ...fixture.cache.payload };
  delete payload.coverage;
  payload.credits = (payload.credits as Record<string, unknown>[]).map((credit) => {
    const copy = { ...credit };
    delete copy.tmdb_score;
    return copy;
  });
  return { ...fixture, cache: { ...fixture.cache, payload } };
}
