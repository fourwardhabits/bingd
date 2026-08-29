import { fireEvent, waitFor, within } from '@testing-library/react-native';

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
 * People in Search (founder addendum 2026-08-16 §2, unified by the external-beta
 * polish).
 *
 * The rules being asserted: filters are All | Movies | TV | People over **one
 * continuous list** — no People section heading, no separator; under All titles stay
 * dominant, person rows appear above them only for meaningful matches; a user row is
 * visually distinct from a title row (the row says its kind, not a heading); tap opens
 * the authorized profile.
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
   * **People is a chip, not a Users chip.**
   *
   * "Users" stays gone, because the founder's word for accounts is People everywhere
   * the app speaks of them. The chip narrows the one list to member rows alone.
   */
  it('offers the three title filters and People, and no Users tab', async () => {
    withPeople([]);
    const view = await search('anna');
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    for (const label of ['All', 'Movies', 'TV', 'People']) {
      expect(view.getByText(label)).toBeTruthy();
    }
    expect(view.queryByText('Users')).toBeNull();
  });

  it('interleaves people above the titles in one list, with no section heading', async () => {
    withPeople([anna]);
    const view = await search('anna');
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna')).toBeTruthy());
    // Titles are still there and still the body of the list.
    expect(view.getByLabelText(FILM_ROW)).toBeTruthy();
    // No "People" heading — the row's own shape is what says it is a person.
    // (`SectionHeader` exposes its title as the accessible name; the chip does not.)
    expect(view.queryByLabelText('People')).toBeNull();
  });

  it('orders the one list people first, titles after', async () => {
    withPeople([anna]);
    const view = await search('anna');
    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna')).toBeTruthy());
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    // Tree order is render order: the person row precedes every title row.
    const labels = view
      .getAllByLabelText(/^(Anna Rivers, @anna|Inception, 2010|Breaking Bad, 2008)/)
      .map((node) => node.props.accessibilityLabel as string);
    expect(labels[0]).toBe('Anna Rivers, @anna');
    expect(labels).toContain(FILM_ROW);
  });

  it('keeps a middle-of-the-handle match out of a plain query', async () => {
    // `deanna` genuinely matches "ann" and the server genuinely returns it. Leading a
    // page of films with a stranger is the wrong answer to a query about a title.
    withPeople([deanna]);
    const view = await search('ann');
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    expect(view.queryByLabelText('Deanna Troi, @deanna')).toBeNull();
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

    // The row names the total it reveals — with no section header to carry a "See
    // all" action, the expansion is a row of the list itself.
    await fireEvent.press(view.getByLabelText('See all 5 people'));

    await waitFor(() => expect(view.getByLabelText('Anna 4, @anna4')).toBeTruthy());
    // No second round trip: the query already asked for the server's ceiling.
    const calls = mockRpc.mock.calls.filter(([fn]: [string]) => fn === 'search_users');
    expect(calls.every(([, args]: [string, { p_limit: number }]) => args.p_limit === 30)).toBe(true);
  });

  it('offers no See all when the preview already holds everybody', async () => {
    withPeople([anna]);
    const view = await search('anna');

    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna')).toBeTruthy());
    expect(view.queryByText(/^See all/)).toBeNull();
  });

  it('says nothing about members when nobody matched', async () => {
    // No person rows, no empty state of their own. A title search that found titles is
    // not a failed member search, and saying so would be noise on every ordinary query.
    withPeople([]);
    const view = await search('anna');
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    expect(view.queryByLabelText(/, @/)).toBeNull();
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

  /**
   * **The People chip lifts the gate and hides the titles.**
   *
   * Choosing People is the statement of intent `meaningfulMatch` exists to infer from
   * a plain query, so the middle-of-the-handle match the gate keeps out of All is shown
   * here — and the title list is simply absent rather than "filtered to nothing".
   */
  it('People shows every name match and no titles', async () => {
    withPeople([deanna]);
    const view = await search('ann');
    // Under All this match is gated out (asserted above) and the titles show.
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    await fireEvent.press(view.getByText('People'));

    await waitFor(() => expect(view.getByLabelText('Deanna Troi, @deanna')).toBeTruthy());
    expect(view.queryByLabelText(FILM_ROW)).toBeNull();
  });

  it('People shows everybody at once, with no See all', async () => {
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

    await fireEvent.press(view.getByText('People'));

    await waitFor(() => expect(view.getByLabelText('Anna 4, @anna4')).toBeTruthy());
    expect(view.queryByText(/^See all/)).toBeNull();
  });

  it('keeps the people on screen when the title search fails (review 61)', async () => {
    // The one-list contract cuts both ways: a failed *title* query must not blank
    // rows the *member* query already delivered. The failure is a footer under them.
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'search_titles')
        return Promise.resolve({ data: null, error: { message: 'boom' } });
      if (fn === 'search_users') return Promise.resolve({ data: [anna], error: null });
      if (fn === 'follow_state_with') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: { status: 'ok' }, error: null });
    });
    const view = await search('anna');

    await waitFor(() => expect(view.getByLabelText('Anna Rivers, @anna')).toBeTruthy());
    await waitFor(() => expect(view.getByText('Could not search titles')).toBeTruthy());
    expect(view.getByText('Try again')).toBeTruthy();
  });

  it('keeps the search field below the brand row, not inside it', async () => {
    // The founder's header rhythm: row one is the bingd. brand, row two is the
    // screen's acting control — the same position the category selector holds on
    // For You and Collection. The compaction that put the field *beside* the
    // lockup is the layout this asserts against.
    const view = await search('');

    type Node = { props?: Record<string, unknown>; children?: unknown[] } | string | null;
    const hasSearchField = (node: Node): boolean => {
      if (!node || typeof node === 'string') return false;
      if (node.props?.accessibilityLabel === 'Search') return true;
      return (node.children ?? []).some((child) => hasSearchField(child as Node));
    };
    const findHeader = (node: Node): Node => {
      if (!node || typeof node === 'string') return null;
      if (node.props?.accessibilityRole === 'header') return node;
      for (const child of node.children ?? []) {
        const found = findHeader(child as Node);
        if (found) return found;
      }
      return null;
    };

    const tree = view.toJSON() as Node;
    const header = findHeader(tree);
    expect(header).toBeTruthy();
    // The brand header exists and the field is not a descendant of it…
    expect(hasSearchField(header)).toBe(false);
    // …while the screen still has the field, below.
    expect(hasSearchField(tree)).toBe(true);
  });

  it('People says who it could not find, in its own words', async () => {
    withPeople([]);
    const view = await search('anna');
    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());

    await fireEvent.press(view.getByText('People'));

    await waitFor(() => expect(view.getByText('Nobody by that name')).toBeTruthy());
    // Not the title empty state: a person search that found nobody is not a
    // catalogue miss.
    expect(view.queryByText('Nothing matches that')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * **The poster beside a title result** (founder, 2026-08-28 §1).
 *
 * This was already how Search drew a title row — `TitleRow` has carried a `Poster`
 * since it was written, and the screen passes `posterUri(result.poster_path)` — so §1
 * required no change to the app. It required *this*, because "already correct" is only
 * worth anything if it stays that way, and nothing in the suite would have noticed the
 * artwork column being dropped in a future density pass.
 *
 * The two states both matter: the list stays a compact list either way, so a title with
 * no artwork must not become a shorter row than the one above it.
 */
describe('artwork on a title result', () => {
  /**
   * How many loaded images the row holds, optionally of one exact URL.
   *
   * Walked from the row rather than queried, for the reason the toggle test in
   * `FeedMode` walks too: the claim is structural — is the artwork *inside this row* —
   * and a screen-wide query would be satisfied by a poster belonging to the row above.
   */
  const posterIn = (
    row: { queryAll: (fn: (node: { props: Record<string, unknown> }) => boolean) => unknown[] },
    uri: string | null,
  ) =>
    row.queryAll((node) => {
      // `expo-image` normalises `source` to an array before it reaches the native view.
      const [source] = (node.props.source as { uri?: string }[] | undefined) ?? [];
      return Boolean(source?.uri) && (uri === null || source?.uri === uri);
    }).length;

  it('shows the catalogue poster beside the title and its metadata', async () => {
    const view = await search('breaking');
    const row = await view.findByLabelText(SERIES_ROW);

    // TMDB's row bucket, built by `posterUri` — the size is a display decision and the
    // stored value is a path, so asserting the whole URL is asserting that seam too.
    expect(posterIn(row, 'https://image.tmdb.org/t/p/w342/bb.jpg')).toBe(1);
    // And the hierarchy the poster sits beside is untouched.
    expect(view.getByText('Breaking Bad (2008)')).toBeTruthy();
  });

  it('falls back to the neutral artwork for a title with none', async () => {
    // `film` carries `poster_path: null`, which is most of the seed catalogue.
    const view = await search('inception');
    const row = await view.findByLabelText(FILM_ROW);

    expect(posterIn(row, null)).toBe(0);
    // The designed placeholder rather than a gap: the title's initials, which for a
    // one-word title is one letter.
    expect(within(row).getByText('I')).toBeTruthy();
  });

  it('keeps the row action beside the artwork', async () => {
    // A poster column that pushed the + off the row would be the founder's "preserve
    // existing row actions" going wrong quietly.
    const view = await search('inception');
    await view.findByLabelText(FILM_ROW);
    expect(view.getByLabelText('Log Inception')).toBeTruthy();
  });
});
