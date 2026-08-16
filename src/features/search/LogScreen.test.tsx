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
    await waitFor(() => expect(view.getByText('Breaking Bad: Season 2')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Loved it'));
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

  it('hands the comparison the same title it just logged', async () => {
    const view = await search('inception');

    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Log Inception'));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('It was fine'));

    const find = () => view.getByRole('button', { name: 'Find where it lands' });
    await waitFor(() => expect(find().props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(find());

    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(callsTo('rank_start')[0][1]).toEqual({
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

  it('remembers a search that found something', async () => {
    const view = await search('breaking');
    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());

    // Recorded on results, not on keystrokes, so the history is searches that
    // worked rather than every prefix typed on the way to one.
    await waitFor(() => expect(mockPrefs.get('user-1.search.recent')).toEqual(['breaking']));
  });

  it('clears the history', async () => {
    mockPrefs.set('user-1.search.recent', ['breaking bad']);
    const view = await renderWithProviders(<LogScreen />);

    await waitFor(() => expect(view.getByText('RECENT SEARCHES')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(view.getByText('What did you watch?')).toBeTruthy());
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
