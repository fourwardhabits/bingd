import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the route: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
import TasteScreen from '../../../app/onboarding/taste';

const mockRpc = jest.fn();
const mockReplace = jest.fn();
const mockPrefs = new Map<string, unknown>();
const mockTableRows: Record<string, unknown[]> = {};
/** Rows a `count: 'exact', head: true` select should report, keyed by table. */
const mockCounts: Record<string, number> = {};

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
      const chain: Record<string, unknown> = {};
      const rows = () => mockTableRows[table] ?? [];
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        filter: () => chain,
        limit: () => chain,
        order: () => Promise.resolve({ data: rows(), error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows(), error: null, count: mockCounts[table] ?? rows().length }),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `operation-${(issued += 1)}` }));

const film = {
  id: 'film-1',
  kind: 'movie',
  title: 'Inception',
  release_date: '2010-07-16',
  poster_path: null,
  provenance: 'wikidata',
};

const series = {
  id: 'series-1',
  kind: 'series',
  title: 'Inception: The Series',
  release_date: '2015-01-01',
  poster_path: null,
  provenance: 'wikidata',
};

beforeEach(() => {
  issued = 0;
  mockRpc.mockReset();
  mockReplace.mockReset();
  mockPrefs.clear();
  for (const key of Object.keys(mockTableRows)) delete mockTableRows[key];
  for (const key of Object.keys(mockCounts)) delete mockCounts[key];
  mockRpc.mockImplementation((fn: string) =>
    fn === 'search_titles'
      ? Promise.resolve({ data: [film, series], error: null })
      : Promise.resolve({ data: { status: 'ok' }, error: null }),
  );
  mockTableRows.media_items = [];
  mockTableRows.rankings = [];
  mockTableRows.user_media = [];
  mockCounts.rankings = 0;
  mockCounts.user_media = 0;
});

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

const open = async () => {
  const view = await renderWithProviders(<TasteScreen />);
  await waitFor(() => expect(view.getByText('Build your taste')).toBeTruthy());
  return view;
};

const search = async (view: Awaited<ReturnType<typeof open>>, term: string) => {
  await fireEvent.changeText(view.getByLabelText('Search for a film'), term);
  await waitFor(() => expect(view.getByLabelText(/Inception, 2010/)).toBeTruthy());
};

describe('the first five', () => {
  it('starts at zero of five', async () => {
    const view = await open();
    expect(view.getByLabelText('0 of 5 films ranked')).toBeTruthy();
  });

  it('offers films and never a series, because a series cannot be ranked', async () => {
    const view = await open();
    await search(view, 'inception');

    expect(view.queryByText('Inception: The Series')).toBeNull();
  });

  /**
   * The founder decision this screen exists to honour.
   *
   * The first five may be films somebody saw fifteen years ago. `LogSheet` follows a
   * bucket save with `log_watched` for today, because the sheet it belongs to displays
   * a date — and that would put five historical films into this year's Goals. This
   * screen goes straight to `set_bucket`, which writes no date, and `goals.ts` refuses
   * to count a null one.
   */
  it('records no watch date, so an old film does not land in this year’s goals', async () => {
    const view = await open();
    await search(view, 'inception');

    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Loved it'));

    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('goes straight into the real comparison flow, with no second tap', async () => {
    const view = await open();
    await search(view, 'inception');

    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Loved it'));

    // `rank_start` is the same session opener the Log tab drives. Nothing about the
    // ranking algorithm is reimplemented here.
    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(callsTo('rank_start')[0][1]).toEqual({
      p_media_item_id: 'film-1',
      p_bucket: 'loved',
    });
  });

  it('resumes where the account already is, rather than from a local counter', async () => {
    // Three placed in an earlier session. Nothing local records that; it is read back
    // off `rankings`, so closing the app is not a way to lose progress or repeat it.
    mockCounts.rankings = 3;
    mockCounts.user_media = 3;

    const view = await open();
    await waitFor(() => expect(view.getByLabelText('3 of 5 films ranked')).toBeTruthy());
  });

  it('offers the way out once five are placed', async () => {
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    const view = await renderWithProviders(<TasteScreen />);

    await waitFor(() => expect(view.getByText('That is a start')).toBeTruthy());
    expect(view.getByRole('button', { name: 'Explore For You' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'See my collection' })).toBeTruthy();
  });

  it('does not claim to know what kind of viewer five films makes somebody', async () => {
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    const view = await renderWithProviders(<TasteScreen />);
    await waitFor(() => expect(view.getByText('That is a start')).toBeTruthy());

    // No taste archetype, no "you are a…". Five films orders a list; it does not
    // characterise a person, and inventing that in the first minute would undermine
    // every honest number the app shows afterwards.
    expect(view.queryByText(/you are a/i)).toBeNull();
  });

  it('lets somebody leave who cannot think of five, and remembers that', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/feed'));
    expect(mockPrefs.get('user-1.onboarding.taste.skipped')).toBe(true);
  });
});
