import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files, so a test living
// next to its route ships the testing library to users. See app-directory.test.ts.
import LogScreen from '../../../app/(tabs)/log';

const mockRpc = jest.fn();
const mockPush = jest.fn();
const tableRows: Record<string, unknown[]> = {};
const mockPrefs = new Map<string, unknown>();

// Prefs are SecureStore underneath, which has no test double here. The screen
// only cares that a value written comes back, so the map is the whole contract.
jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const inFilters: Record<string, unknown[]> = {};
      const rows = () => {
        const source = tableRows[table] ?? [];
        return source.filter((row) => {
          const object = row as Record<string, unknown>;
          for (const [key, value] of Object.entries(filters)) {
            if (object[key] !== value) return false;
          }
          for (const [key, value] of Object.entries(inFilters)) {
            if (!value.includes(object[key])) return false;
          }
          return true;
        });
      };
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          inFilters[column] = values;
          return chain;
        },
        order: () => Promise.resolve({ data: rows(), error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows(), error: null }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// The wider search, which is a real network call in production and must be a decision
// here. Without this it failed by accident in every test, which is not the same as
// failing deliberately in one.
const mockSearchProvider = jest.fn();

jest.mock('@/lib/tmdb-adapter', () => {
  class MockAdapterError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
    get isRateLimit() {
      return this.code === 'BG429';
    }
  }
  return {
    AdapterError: MockAdapterError,
    searchProvider: (...args: unknown[]) => mockSearchProvider(...args),
  };
});

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

let issued = 0;
jest.mock('expo-crypto', () => ({
  randomUUID: () => `operation-${(issued += 1)}`,
}));

const series = {
  id: 'series-1',
  kind: 'series',
  title: 'Breaking Bad',
  release_date: '2008-01-20',
  poster_path: '/bb.jpg',
  provenance: 'wikidata',
};

const film = {
  id: 'film-1',
  kind: 'movie',
  title: 'Inception',
  release_date: '2010-07-16',
  poster_path: null,
  provenance: 'wikidata',
};

beforeEach(() => {
  issued = 0;
  mockSearchProvider.mockReset();
  mockSearchProvider.mockResolvedValue([]);
  mockRpc.mockReset();
  mockPush.mockReset();
  mockPrefs.clear();
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  mockRpc.mockImplementation((fn: string) =>
    fn === 'search_titles'
      ? Promise.resolve({ data: [series, film], error: null })
      : Promise.resolve({ data: { status: 'ok' }, error: null }),
  );
  tableRows.user_media = [];
  tableRows.rankings = [];
  tableRows.media_items = [
    { id: 'series-1', genres: ['Crime', 'Drama'], runtime_minutes: null, kind: 'series' },
    { id: 'film-1', genres: ['Sci-Fi'], runtime_minutes: 148, kind: 'movie' },
    {
      id: 'season-1',
      parent_id: 'series-1',
      season_number: 1,
      title: 'Season 1',
      release_date: '2008-01-20',
      poster_path: null,
      kind: 'season',
    },
    {
      id: 'season-2',
      parent_id: 'series-1',
      season_number: 2,
      title: 'Season 2',
      release_date: '2009-03-08',
      poster_path: null,
      kind: 'season',
    },
  ];
});

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

const search = async (term: string) => {
  const view = await renderWithProviders(<LogScreen />);
  await fireEvent.changeText(view.getByLabelText('Search'), term);
  return view;
};

const SERIES_ROW = 'Breaking Bad, 2008, Series · 2 seasons';
const FILM_ROW = 'Inception, 2010';

/**
 * The Log tab (screens.md §2).
 *
 * The distinction this screen exists to make visible: a series cannot be logged. The season
 * is the rankable unit and `_assert_loggable` refuses a series outright (AD-1), so tapping
 * one has to lead somewhere rather than fail.
 */
describe('a series in the results', () => {
  it('opens title detail from the row', async () => {
    const view = await search('breaking');

    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
    await fireEvent.press(view.getByLabelText(SERIES_ROW));
    expect(mockPush).toHaveBeenCalledWith('/title/series-1');
    expect(view.queryByText('How was it?')).toBeNull();
  });

  it('starts season logging from the + action', async () => {
    const view = await search('breaking');

    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Log Breaking Bad'));
    await waitFor(() => expect(view.getByText('Season 2')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Season 2, 2009'));

    // The series title travels with the season, or the header reads "Season 2" alone.
    // "Parks and Recreation, S2" is the approved season identity (founder
    // decision D5, 2026-08-15): an em dash, not a colon, and never a bare "Season 2".
    await waitFor(() => expect(view.getByText('Breaking Bad, S2')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('I liked it'));
    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));

    expect(callsTo('set_bucket')[0][1]).toMatchObject({ p_media_item_id: 'season-2' });
  });
});

describe('a film in the results', () => {
  it('starts logging from the + action', async () => {
    const view = await search('inception');

    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Log Inception'));

    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('It was fine'));

    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    expect(callsTo('set_bucket')[0][1]).toMatchObject({
      p_media_item_id: 'film-1',
      p_bucket: 'fine',
    });
  });

  /**
   * End to end across the two sheets: the bucket save and the comparison it opens are
   * separate components wired by the screen, and the title has to survive the hand-off.
   * Sending `rank_start` a different id than `set_bucket` got would rank the wrong film
   * and look entirely normal doing it.
   *
   * No "Find where it lands" step any more — the comparison opens on the bucket tap.
   */
  it('hands the comparison the same title it just logged, with no second tap', async () => {
    const view = await search('inception');

    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Log Inception'));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('It was fine'));

    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(callsTo('rank_start')[0][1]).toMatchObject({
      p_media_item_id: 'film-1',
      p_bucket: 'fine',
    });
  });
});

describe('before anything is typed', () => {
  it('says what to do instead of showing an empty list', async () => {
    const view = await renderWithProviders(<LogScreen />);

    expect(view.getByText('What did you watch?')).toBeTruthy();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('offers the last search back rather than the prompt', async () => {
    mockPrefs.set('user-1.search.recent', ['breaking bad']);
    const view = await renderWithProviders(<LogScreen />);

    await waitFor(() => expect(view.getByText('RECENT SEARCHES')).toBeTruthy());
    // The prompt is for a first-time user. Someone with a history has already
    // been told how this works.
    expect(view.queryByText('What did you watch?')).toBeNull();
  });

  it('re-runs a recent search when it is tapped', async () => {
    mockPrefs.set('user-1.search.recent', ['breaking bad']);
    const view = await renderWithProviders(<LogScreen />);

    await waitFor(() => expect(view.getByLabelText('Search again for breaking bad')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Search again for breaking bad'));

    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
  });

  it('clears the history', async () => {
    mockPrefs.set('user-1.search.recent', ['breaking bad']);
    const view = await renderWithProviders(<LogScreen />);

    await waitFor(() => expect(view.getByText('RECENT SEARCHES')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(view.getByText('What did you watch?')).toBeTruthy());
  });
});

/**
 * The founder's device showed five entries — `100%`, `100% l`, `100% lo`, `100% lov`,
 * `100% love` — which is one search recorded five times, once per keystroke that
 * happened to return rows. These tests type the way a person types, one character at a
 * time, and assert on what storage holds at the end of it.
 */
describe('recent search history', () => {
  const type = async (view: Awaited<ReturnType<typeof renderWithProviders>>, term: string) => {
    const field = view.getByLabelText('Search');
    for (let length = 1; length <= term.length; length += 1) {
      await fireEvent.changeText(field, term.slice(0, length));
    }
  };

  const stored = () => mockPrefs.get('user-1.search.recent');

  it('writes nothing while the user is still typing', async () => {
    const view = await renderWithProviders(<LogScreen />);
    await type(view, 'breaking');

    // Every one of those eight prefixes returns rows from the stub, which is exactly
    // the condition the old implementation recorded on.
    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
    expect(stored()).toBeUndefined();
  });

  it('records the submitted query, and only it', async () => {
    const view = await renderWithProviders(<LogScreen />);
    await type(view, 'breaking');
    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());

    await fireEvent(view.getByLabelText('Search'), 'submitEditing');

    // One entry. Not `b`, `br`, `bre` … and not `breaking` seven times over.
    await waitFor(() => expect(stored()).toEqual(['breaking']));
  });

  it('records the title when a result is opened, not the query that found it', async () => {
    const view = await renderWithProviders(<LogScreen />);
    await type(view, 'breaking');
    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());

    await fireEvent.press(view.getByLabelText(SERIES_ROW));

    await waitFor(() => expect(stored()).toEqual(['Breaking Bad']));
  });

  it('records the title when logging starts from a result', async () => {
    const view = await renderWithProviders(<LogScreen />);
    await type(view, 'inception');
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Log Inception'));

    await waitFor(() => expect(stored()).toEqual(['Inception']));
  });

  it('does not list one title twice when it is opened twice', async () => {
    const view = await renderWithProviders(<LogScreen />);
    await type(view, 'breaking');
    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());

    await fireEvent.press(view.getByLabelText(SERIES_ROW));
    await waitFor(() => expect(stored()).toEqual(['Breaking Bad']));
    await fireEvent.press(view.getByLabelText(SERIES_ROW));

    await waitFor(() => expect(stored()).toEqual(['Breaking Bad']));
  });
});

describe('the kind filter', () => {
  it('is hidden until there is something to filter', async () => {
    const view = await renderWithProviders(<LogScreen />);
    expect(view.queryByRole('button', { name: 'Movies' })).toBeNull();
  });

  it('narrows the results to one kind', async () => {
    const view = await search('a');
    await fireEvent.changeText(view.getByLabelText('Search'), 'thing');

    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
    expect(view.getByLabelText(FILM_ROW)).toBeTruthy();

    await fireEvent.press(view.getByRole('button', { name: 'Movies' }));

    await waitFor(() => expect(view.queryByLabelText(SERIES_ROW)).toBeNull());
    expect(view.getByLabelText(FILM_ROW)).toBeTruthy();
  });

  it('says the filter is hiding things, not that nothing matched', async () => {
    mockRpc.mockImplementation((fn: string) =>
      fn === 'search_titles'
        ? Promise.resolve({ data: [series], error: null })
        : Promise.resolve({ data: { status: 'ok' }, error: null }),
    );

    const view = await search('breaking');
    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Movies' }));

    // "Nothing matches that" would be a lie: the search worked and the user is
    // looking at their own filter.
    await waitFor(() => expect(view.getByText('Nothing in this filter')).toBeTruthy());
  });
});

/**
 * A short list has to say when it is a short list.
 *
 * Independent review's finding on the search change: the rate-limit and failure
 * messages were only reachable when the results list was *empty*, so the one case that
 * most needed them was the one they missed. Rows found locally, the wider lookup
 * refused, and a reader taking six results as the whole catalogue — which is the
 * founder's original `spiderman` complaint reappearing one step further along, with
 * the app now silent about why.
 */
describe('when the wider search cannot answer', () => {
  const AdapterError = jest.requireMock('@/lib/tmdb-adapter').AdapterError;

  /** Long enough for the 800ms provider debounce to settle. */
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  };

  it('says the list may be incomplete rather than showing it as final', async () => {
    mockSearchProvider.mockRejectedValue(new AdapterError('BG500', 'upstream failed'));

    const view = await search('breaking');
    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
    await settle();

    await waitFor(() =>
      expect(view.getByText('The wider search did not answer, so this may not be everything.')).toBeTruthy(),
    );
    // The local rows are still there and still usable — the message is a footer, not a
    // replacement for the answer the app does have.
    expect(view.getByLabelText(SERIES_ROW)).toBeTruthy();
    expect(view.getByLabelText('Search wider again')).toBeTruthy();
  });

  it('names a rate limit as a rate limit, so it does not read as an empty catalogue', async () => {
    mockSearchProvider.mockRejectedValue(new AdapterError('BG429', 'too many'));

    const view = await search('breaking');
    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
    await settle();

    await waitFor(() =>
      expect(
        view.getByText('Too many searches to look wider just now. These are from your catalogue only.'),
      ).toBeTruthy(),
    );
  });

  it('actually retries the half that failed', async () => {
    mockSearchProvider.mockRejectedValue(new AdapterError('BG500', 'upstream failed'));

    const view = await search('breaking');
    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
    await settle();
    await waitFor(() => expect(view.getByLabelText('Search wider again')).toBeTruthy());

    const before = mockSearchProvider.mock.calls.length;
    await fireEvent.press(view.getByLabelText('Search wider again'));

    // The button used to call the *local* query's refetch. Every failure it is offered
    // for is a provider failure, so it re-ran the half that had already succeeded and
    // left the half that had not — a control that looked like a retry and could not
    // have fixed anything.
    await waitFor(() => expect(mockSearchProvider.mock.calls.length).toBeGreaterThan(before));
  });

  it('says nothing when the wider search worked and had nothing to add', async () => {
    const view = await search('breaking');
    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
    await settle();

    expect(view.queryByLabelText('Search wider again')).toBeNull();
  });
});

/**
 * Users in Search (founder addendum 2026-08-16 §2).
 *
 * The rules being asserted, in the founder's words: filters become All | Movies | TV |
 * Users; a user row is visually distinct from a title row; under All titles stay
 * dominant and a compact Users *section* appears only for meaningful matches; never
 * intermix profile rows into the title ranking; tap opens the authorized profile.
 *
 * What is deliberately **not** asserted here is who may be found. That is
 * `search_users`' job and it is tested against a real database in
 * `supabase/tests/user-search.test.mjs` — a client-side test of a privacy rule would
 * only be asserting the fixture.
 */
describe('finding people', () => {
  const anna = {
    id: 'user-anna',
    username: 'anna',
    display_name: 'Anna Rivers',
    avatar_path: null,
    visibility: 'public',
  };
  const deanna = {
    id: 'user-deanna',
    username: 'deanna',
    display_name: 'Deanna Troi',
    avatar_path: null,
    visibility: 'public',
  };

  const withPeople = (people: unknown[], relationships: unknown[] = []) => {
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'search_titles') return Promise.resolve({ data: [series, film], error: null });
      if (fn === 'search_users') return Promise.resolve({ data: people, error: null });
      if (fn === 'follow_state_with') {
        return Promise.resolve({ data: relationships, error: null });
      }
      return Promise.resolve({ data: { status: 'ok' }, error: null });
    });
  };

  /**
   * **The Users chip is gone, and its absence is the point.**
   *
   * The three that remain narrow *titles*; members are a different kind of thing and
   * were never narrowed by them, so a fourth chip made one control mean two things and
   * put member discovery behind a press nobody had a reason to make.
   */
  it('offers the three title filters and no Users tab', async () => {
    withPeople([]);
    const view = await search('anna');
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    for (const label of ['All', 'Movies', 'TV']) {
      expect(view.getByText(label)).toBeTruthy();
    }
    expect(view.queryByText('Users')).toBeNull();
  });

  it('shows a compact Members section above the titles', async () => {
    withPeople([anna]);
    const view = await search('anna');
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    await waitFor(() => expect(view.getByLabelText('Members')).toBeTruthy());
    expect(view.getByLabelText('Anna Rivers, @anna')).toBeTruthy();
    // Titles are still there and still the body of the list.
    expect(view.getByLabelText(FILM_ROW)).toBeTruthy();
  });

  it('keeps a middle-of-the-handle match out of a plain query', async () => {
    // `deanna` genuinely matches "ann" and the server genuinely returns it. Leading a
    // page of films with a stranger is the wrong answer to a query about a title.
    withPeople([deanna]);
    const view = await search('ann');
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    expect(view.queryByLabelText('Members')).toBeNull();
  });

  /**
   * **`@` is a hint, not a mode.**
   *
   * It lifts the gate — somebody typing a handle sigil is naming a person — and it does
   * **not** suppress titles, because a film can legitimately begin with `@` and a search
   * that stopped looking would simply fail to find those.
   */
  it('lifts the gate for an @ query, and still searches titles', async () => {
    withPeople([deanna]);
    const view = await search('@ann');
    // Titles first, and asserting them is half the point: `@` must not suppress them.
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    await waitFor(() => expect(view.getByLabelText('Deanna Troi, @deanna')).toBeTruthy());
  });

  it('matches the handle without the sigil', async () => {
    withPeople([anna]);
    const view = await search('@anna');

    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna')).toBeTruthy());
    // The stored handle has no `@`, so sending one would match nothing.
    const calls = mockRpc.mock.calls.filter(([fn]: [string]) => fn === 'search_users');
    expect(calls.at(-1)?.[1]).toMatchObject({ p_query: 'anna' });
  });

  /**
   * See all is a display cap, not a route and not a second request.
   *
   * Everything it reveals is already in hand, so it cannot fail, cannot spend a round
   * trip, and cannot land somebody on a screen with its own empty state.
   */
  it('previews three members and reveals the rest in place', async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      id: `user-${index}`,
      username: `anna${index}`,
      display_name: `Anna ${index}`,
      avatar_path: null,
      visibility: 'public',
    }));
    withPeople(many);
    const view = await search('anna');

    await waitFor(() => expect(view.getByLabelText('Anna 0, @anna0')).toBeTruthy());
    expect(view.queryByLabelText('Anna 4, @anna4')).toBeNull();

    await fireEvent.press(view.getByText('See all'));

    await waitFor(() => expect(view.getByLabelText('Anna 4, @anna4')).toBeTruthy());
    // No second round trip: the query already asked for the server's ceiling.
    const calls = mockRpc.mock.calls.filter(([fn]: [string]) => fn === 'search_users');
    expect(calls.every(([, args]: [string, { p_limit: number }]) => args.p_limit === 30)).toBe(true);
  });

  it('offers no See all when the preview already holds everybody', async () => {
    withPeople([anna]);
    const view = await search('anna');

    await waitFor(() => expect(view.getByLabelText('Members')).toBeTruthy());
    expect(view.queryByText('See all')).toBeNull();
  });

  it('says nothing about members when nobody matched', async () => {
    // No section, no empty state of its own. A title search that found titles is not a
    // failed member search, and saying so would be noise on every ordinary query.
    withPeople([]);
    const view = await search('anna');
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    expect(view.queryByLabelText('Members')).toBeNull();
  });

  /**
   * **A private account is findable, and the row says so** (`20260819000100`).
   *
   * Private stopped meaning "nobody can find me" and went back to meaning "my activity
   * is private". A row identical to a public one would set up a surprise — the tap
   * leads to a locked profile and the Follow becomes a request somebody has to answer —
   * so the word is the difference between a considered ask and an accidental one.
   */
  it('marks a private account as private', async () => {
    withPeople([{ ...anna, visibility: 'private' }]);
    const view = await search('anna');

    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna, Private')).toBeTruthy());
  });

  it('prefers the relationship to the word Private, where there is one', async () => {
    // "Following" is the more useful word for an account already approved, and it
    // already implies the rest.
    withPeople(
      [{ ...anna, visibility: 'private' }],
      [{ user_id: 'user-anna', following: 'approved', followed_by: null, blocked: false }],
    );
    const view = await search('anna');

    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna, Following')).toBeTruthy());
  });

  it('says nothing extra on a public account with no relationship', async () => {
    withPeople([anna], [{ user_id: 'user-anna', following: null, followed_by: null, blocked: false }]);
    const view = await search('anna');

    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna')).toBeTruthy());
  });

  it('names the relationship on the row, and offers no control there', async () => {
    withPeople(
      [anna],
      [{ user_id: 'user-anna', following: 'approved', followed_by: null, blocked: false }],
    );
    const view = await search('anna');

    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna, Following')).toBeTruthy());
    // A Follow button in a search result is one mis-tap from a relationship the user
    // did not mean to start, and the other person is notified either way.
    expect(view.queryByText('Follow')).toBeNull();
  });

  it('says nothing where there is no relationship yet', async () => {
    withPeople([anna], [{ user_id: 'user-anna', following: null, followed_by: null, blocked: false }]);
    const view = await search('anna');

    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna')).toBeTruthy());
  });

  it('opens the profile when a person is tapped', async () => {
    withPeople([anna]);
    const view = await search('anna');
    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Anna Rivers, @anna'));

    expect(mockPush).toHaveBeenCalledWith('/u/anna');
  });
});
