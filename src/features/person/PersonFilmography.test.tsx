import { fireEvent, waitFor, within } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files.
import PersonScreen from '../../../app/person/[id]';
import {
  BRAD_PITT,
  BRYAN_CRANSTON,
  CHRISTOPHER_NOLAN,
  NEWCOMER,
  legacy,
  type PersonFixture,
} from './__fixtures__/people';
import { shortened } from './biography';

/**
 * The person page's filmography sorting and its 2026-11-11 refresh, rendered.
 *
 * `PersonScreen.test.tsx` holds the page's older contracts — the cache, the claim, the
 * Cast/Crew split, the bookmark — and still runs against this screen; this file is what
 * the refresh added. Fixtures are in `__fixtures__/people.ts`, shaped like a prolific
 * actor, a television actor, a director and somebody with two credits.
 */

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockSetWatchlist = jest.fn(() => Promise.resolve({ outcome: 'ok' as const }));
const mockCachePerson = jest.fn(() => Promise.resolve({ id: 0, written: 0 }));
let mockPersonId = '287';
const tableRows: Record<string, unknown[]> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const rows = () =>
        (tableRows[table] ?? []).filter((row) =>
          Object.entries(filters).every(
            ([key, value]) => (row as Record<string, unknown>)[key] === value,
          ),
        );
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        gt: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows(), error: null, count: rows().length }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useLocalSearchParams: () => ({ id: mockPersonId }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

jest.mock('@/lib/tmdb-adapter', () => ({
  cachePerson: (...args: unknown[]) => mockCachePerson(...(args as [])),
}));

jest.mock('@/features/collection/writes', () => ({
  ...jest.requireActual('@/features/collection/writes'),
  newOperationId: () => 'op-1',
  setWatchlist: (...args: unknown[]) => mockSetWatchlist(...(args as [])),
}));

function use(fixture: PersonFixture) {
  mockPersonId = String(fixture.tmdbId);
  tableRows.person_cache = [fixture.cache];
  tableRows.media_items = fixture.items;
}

beforeEach(() => {
  mockPush.mockReset();
  mockBack.mockReset();
  mockSetWatchlist.mockClear();
  mockCachePerson.mockClear();
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  tableRows.watchlist = [];
  tableRows.rankings = [];
  tableRows.user_media = [];
  use(BRAD_PITT);
});

const open = async (name = 'Brad Pitt') => {
  const view = await renderWithProviders(<PersonScreen />);
  await waitFor(() => expect(view.getByTestId('person-name')).toHaveTextContent(name));
  return view;
};

/** The titles of the rows on screen, top to bottom. */
const rowTitles = (view: Awaited<ReturnType<typeof open>>) =>
  view
    .getAllByRole('button')
    .map((node) => node.props.accessibilityLabel as string | undefined)
    .filter(
      (label): label is string =>
        Boolean(label) &&
        /^Add .+ to your watchlist$|^Remove .+ from your watchlist$/.test(label!),
    )
    .map((label) =>
      label
        .replace(/^Add (.+) to your watchlist$/, '$1')
        .replace(/^Remove (.+) from your watchlist$/, '$1'),
    );

const chooseSort = async (view: Awaited<ReturnType<typeof open>>, label: string) => {
  await fireEvent.press(view.getByLabelText(/^Sort\./));
  await fireEvent.press(
    within(view.getByTestId('filmography-sort-menu')).getByLabelText(
      new RegExp(`^${label.replace(/[()]/g, '\\$&')}`),
    ),
  );
};

describe('the refreshed page', () => {
  it('draws its own detail bar with a Back control, like a title or a list', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText('Back'));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('keeps the compact name out of the accessibility tree until the large one has gone', async () => {
    const view = await open();
    expect(
      view.getByTestId('title-top-bar-title', { includeHiddenElements: true }).props
        .accessibilityElementsHidden,
    ).toBe(true);
  });

  it('calls the list Filmography', async () => {
    const view = await open();
    expect(view.getByLabelText('Filmography')).toBeTruthy();
    expect(view.queryByText(/known for/i)).toBeNull();
  });

  it('keeps the portrait, the name and the facts', async () => {
    const view = await open();
    expect(view.getByTestId('person-meta')).toHaveTextContent(
      'Acting · born 1963 · Shawnee, Oklahoma, USA',
    );
  });

  it('shows the loading language while the first read is pending', async () => {
    tableRows.person_cache = [];
    mockCachePerson.mockImplementationOnce(() => new Promise(() => {}));
    const view = await renderWithProviders(<PersonScreen />);
    await waitFor(() => expect(view.getByTestId('person-loading')).toBeTruthy());
    expect(
      view.getAllByTestId('skeleton-row', { includeHiddenElements: true }).length,
    ).toBeGreaterThan(0);
    // The way back is there while it loads.
    expect(view.getByLabelText('Back')).toBeTruthy();
  });
});

describe('a biography the cache shortened', () => {
  it('ends at a whole sentence rather than mid-word', () => {
    const text = (BRAD_PITT.cache.payload.person as { biography: string }).biography;
    expect(shortened(text).endsWith('producer.')).toBe(true);
    expect(shortened('one two three four five six seven')).toBe('one two three four five six…');
  });

  it('says it was shortened once it is opened, and not before', async () => {
    const view = await open();
    expect(view.queryByTestId('biography-shortened')).toBeNull();
    await fireEvent.press(view.getByLabelText('Expand biography'));
    expect(view.getByTestId('biography-shortened')).toHaveTextContent(
      'Shortened. The full biography is on TMDB.',
    );
  });

  it('makes no such claim about a biography that was whole', async () => {
    use(BRYAN_CRANSTON);
    const view = await open('Bryan Cranston');
    await fireEvent.press(view.getByLabelText('Expand biography'));
    expect(view.queryByTestId('biography-shortened')).toBeNull();
  });
});

describe('sorting a filmography', () => {
  it('opens on Popular, in the cache’s order', async () => {
    const view = await open();
    expect(view.getByLabelText('Sort. Popular')).toBeTruthy();
    expect(rowTitles(view).slice(0, 3)).toEqual([
      'Fight Club',
      'Once Upon a Time… in Hollywood',
      'Se7en',
    ]);
  });

  it('offers Popular, Release date and the TMDB rating, with the current one selected', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText('Sort. Popular'));
    const menu = within(view.getByTestId('filmography-sort-menu'));
    const options = menu.getAllByRole('radio').map((node) => node.props.accessibilityLabel);
    expect(options).toEqual(['Popular', 'Release date', 'Highest rated (TMDB)']);
    expect(menu.getByLabelText('Popular').props.accessibilityState).toEqual({ selected: true });
  });

  it('sorts newest first, and flips to oldest first on a second press', async () => {
    const view = await open();
    await chooseSort(view, 'Release date');
    expect(view.getByLabelText('Sort. Release date, newest first')).toBeTruthy();
    expect(rowTitles(view).slice(0, 4)).toEqual(['F1', 'Wolfs', 'Bullet Train', 'Babylon']);

    await chooseSort(view, 'Release date');
    expect(view.getByLabelText('Sort. Release date, oldest first')).toBeTruthy();
    expect(rowTitles(view).slice(0, 3)).toEqual(['Dallas', 'Cutting Class', 'Thelma & Louise']);
  });

  it('says where a newest-first list over a capped career stops being complete', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Movies' }));
    await chooseSort(view, 'Release date');
    expect(view.getByTestId('coverage-note')).toHaveTextContent(
      'From here on, not every one of their older credits is listed.',
    );
    // The note sits directly above the first row it cannot vouch for: World War Z, 2013.
    const titles = rowTitles(view);
    expect(titles.slice(0, 6)).toEqual([
      'F1',
      'Wolfs',
      'Bullet Train',
      'Babylon',
      'Ad Astra',
      'Once Upon a Time… in Hollywood',
    ]);
    expect(titles[6]).toBe('World War Z');
  });

  it('puts undated credits last in both directions, under their own label', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Movies' }));
    await chooseSort(view, 'Release date');
    await fireEvent.press(view.getByLabelText(/^Show more of/));
    expect(rowTitles(view).at(-1)).toBe('Untitled Brad Pitt Project');
    expect(view.getByTestId('tail-note')).toHaveTextContent('No release date yet');

    await chooseSort(view, 'Release date');
    await fireEvent.press(view.getByLabelText(/^Show more of/));
    expect(rowTitles(view).at(-1)).toBe('Untitled Brad Pitt Project');
  });

  it('orders by the TMDB rating with the thinly voted last', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Movies' }));
    await chooseSort(view, 'Highest rated (TMDB)');
    expect(view.getByLabelText('Sort. Highest rated (TMDB)')).toBeTruthy();
    expect(rowTitles(view).slice(0, 3)).toEqual([
      'Fight Club',
      'Se7en',
      'Inglourious Basterds',
    ]);
    await fireEvent.press(view.getByLabelText(/^Show more of/));
    expect(rowTitles(view).slice(-1)).toEqual(['Cutting Class']);
    expect(view.getByTestId('tail-note')).toHaveTextContent('Too few TMDB ratings to rank');
  });

  it('keeps the order across Movies and TV, and sorts within the filter', async () => {
    const view = await open();
    await chooseSort(view, 'Release date');
    await fireEvent.press(view.getByRole('tab', { name: 'TV' }));
    expect(view.getByLabelText('Sort. Release date, newest first')).toBeTruthy();
    expect(rowTitles(view)).toEqual(['Friends', 'Dallas']);
  });

  it('keeps the order across Cast and Crew, and sorts the crew half by its own dates', async () => {
    const view = await open();
    await chooseSort(view, 'Release date');
    await fireEvent.press(view.getByRole('tab', { name: 'Crew' }));
    expect(rowTitles(view)).toEqual([
      '12 Years a Slave',
      'World War Z',
      'Moneyball',
      'The Departed',
    ]);
  });

  it('goes back to the first page on a new order, and on a new filter', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText(/^Show more of/));
    expect(rowTitles(view).length).toBeGreaterThan(12);
    await chooseSort(view, 'Release date');
    expect(rowTitles(view)).toHaveLength(12);

    await fireEvent.press(view.getByLabelText(/^Show more of/));
    await fireEvent.press(view.getByRole('tab', { name: 'Movies' }));
    expect(rowTitles(view)).toHaveLength(12);
  });

  it('opens the title behind a row in any order', async () => {
    const view = await open();
    await chooseSort(view, 'Release date');
    await fireEvent.press(view.getByLabelText(/^F1, 2025/));
    expect(mockPush).toHaveBeenCalledWith('/title/bp-f1');
  });

  it('saves from a sorted row, and changes nothing about rankings', async () => {
    const view = await open();
    await chooseSort(view, 'Release date');
    await fireEvent.press(view.getByLabelText('Add F1 to your watchlist'));
    expect(mockSetWatchlist).toHaveBeenCalledWith({
      operationId: 'op-1',
      mediaItemId: 'bp-f1',
      present: true,
    });
    expect(mockSetWatchlist).toHaveBeenCalledTimes(1);
  });

  it('writes nothing just by sorting', async () => {
    const view = await open();
    await chooseSort(view, 'Release date');
    await chooseSort(view, 'Highest rated (TMDB)');
    await chooseSort(view, 'Popular');
    expect(mockSetWatchlist).not.toHaveBeenCalled();
  });

  it('keeps a saved title marked whatever the order', async () => {
    tableRows.watchlist = [
      {
        user_id: 'user-1',
        media_item_id: 'bp-f1',
        media_items: BRAD_PITT.items.find((item) => item.id === 'bp-f1'),
      },
    ];
    const view = await open();
    await chooseSort(view, 'Release date');
    await waitFor(() =>
      expect(view.getByLabelText('Remove F1 from your watchlist')).toBeTruthy(),
    );
  });
});

describe('a row cached before scores and coverage were stored', () => {
  beforeEach(() => use(legacy(BRAD_PITT)));

  it('offers no TMDB rating it does not have', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText('Sort. Popular'));
    const options = within(view.getByTestId('filmography-sort-menu'))
      .getAllByRole('radio')
      .map((node) => node.props.accessibilityLabel);
    expect(options).toEqual(['Popular', 'Release date']);
  });

  it('says a date sort is within what was kept, not the whole career', async () => {
    const view = await open();
    await chooseSort(view, 'Release date');
    expect(view.getByTestId('sort-scope-note')).toHaveTextContent(
      /^Sorted within the \d+ acting credits kept here, of 89 TMDB lists\.$/,
    );
    expect(view.queryByTestId('coverage-note')).toBeNull();
  });

  it('says nothing extra under Popular, which the count already describes', async () => {
    const view = await open();
    expect(view.queryByTestId('sort-scope-note')).toBeNull();
    expect(view.getByText(/^Showing \d+ of 89 acting credits TMDB lists\.$/)).toBeTruthy();
  });
});

describe('review fixes on the page', () => {
  it('does not trust a coverage record that crossed its own ends', async () => {
    const broken = structuredClone(BRAD_PITT);
    (
      broken.cache.payload.coverage as { cast: { movie: { newest: string | null } } }
    ).cast.movie.newest = null;
    use(broken);
    const view = await open();
    await chooseSort(view, 'Release date');
    // Read as a row with no coverage at all: the cautious caption, not a silent "complete".
    expect(view.getByTestId('sort-scope-note')).toBeTruthy();
  });

  it('does not trust coverage once a credit’s catalogue row has gone', async () => {
    use({ ...BRAD_PITT, items: BRAD_PITT.items.filter((item) => item.id !== 'bp-wolfs') });
    const view = await open();
    await chooseSort(view, 'Release date');
    expect(view.getByTestId('sort-scope-note')).toBeTruthy();
    expect(view.queryByTestId('coverage-note')).toBeNull();
  });

  it('a presenter cached before coverage gets the caveat, whatever the performance count', async () => {
    const presenter = legacy(BRYAN_CRANSTON);
    const payload = presenter.cache.payload as {
      credits: { self: boolean }[];
      cast_total: number;
    };
    payload.credits = payload.credits.map((credit) => ({ ...credit, self: true }));
    payload.cast_total = 0;
    use(presenter);
    const view = await open('Bryan Cranston');
    await chooseSort(view, 'Release date');
    expect(view.getByTestId('sort-scope-note')).toBeTruthy();
  });

  it('reaches the shortened notice outside the biography’s press target', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText('Expand biography'));
    const notice = view.getByTestId('biography-shortened');
    const toggle = view.getByLabelText('Collapse biography');
    expect(within(toggle).queryByTestId('biography-shortened')).toBeNull();
    expect(notice).toBeTruthy();
  });
});

describe('the other three kinds of person', () => {
  it('a television actor: sorted by first air date, and complete', async () => {
    use(BRYAN_CRANSTON);
    const view = await open('Bryan Cranston');
    await chooseSort(view, 'Release date');
    expect(rowTitles(view)).toEqual([
      'Your Honor',
      'Argo',
      'Breaking Bad',
      'Malcolm in the Middle',
      'Seinfeld',
    ]);
    expect(view.queryByTestId('coverage-note')).toBeNull();
    expect(view.queryByTestId('sort-scope-note')).toBeNull();
  });

  it('a director: opens on Crew, sorts, and names the jobs', async () => {
    use(CHRISTOPHER_NOLAN);
    const view = await open('Christopher Nolan');
    expect(view.queryByRole('tab', { name: 'Cast' })).toBeNull();
    await chooseSort(view, 'Release date');
    expect(rowTitles(view).slice(0, 2)).toEqual(['The Odyssey', 'Oppenheimer']);
    expect(view.getByText('Director, Writer, Producer')).toBeTruthy();
  });

  it('somebody with two credits: no portrait, no biography, no facts, nothing broken', async () => {
    use(NEWCOMER);
    const view = await open('Ada Okafor');
    expect(view.queryByTestId('person-meta')).toBeNull();
    expect(view.queryByLabelText('Expand biography')).toBeNull();
    // Two credits are still worth ordering; no rating axis without any scores.
    await fireEvent.press(view.getByLabelText('Sort. Popular'));
    expect(
      within(view.getByTestId('filmography-sort-menu')).queryByLabelText(
        'Highest rated (TMDB)',
      ),
    ).toBeNull();
    await fireEvent.press(
      within(view.getByTestId('filmography-sort-menu')).getByLabelText('Release date'),
    );
    expect(rowTitles(view)).toEqual(['Harbour', 'First Light']);
    expect(view.queryByText(/^Showing/)).toBeNull();
  });

  it('somebody with one credit is not offered a sort', async () => {
    use({
      ...NEWCOMER,
      cache: {
        ...NEWCOMER.cache,
        payload: {
          ...NEWCOMER.cache.payload,
          credits: (NEWCOMER.cache.payload.credits as unknown[]).slice(1),
        },
      },
    });
    const view = await open('Ada Okafor');
    expect(view.queryByLabelText(/^Sort\./)).toBeNull();
  });
});
