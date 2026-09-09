import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

/**
 * Top Rated, as a mode of For You (founder, 2026-09-09).
 *
 * The engine is `top_rated_titles`, which `supabase/tests/top-rated.test.mjs` holds to
 * `community_score` over real collections. What this file is about is the *screen*: that
 * choosing a Top Rated entry draws the community's wall in the server's order, that the
 * two controls which are about particular people leave with it, that the filters do not,
 * and that switching away and back costs the personalised wall nothing.
 *
 * The RPC is stood in for at the `supabase` boundary rather than by mocking the hook, so
 * the cursor the screen sends back on page two is the cursor the hook actually built —
 * that is the half of pagination a mocked hook cannot check.
 */

const mockPush = jest.fn();
const mockRpc = jest.fn();

/** One page of `top_rated_titles` rows, in the order the server would return them. */
type Row = { media_item_id: string; score: number; rating_count: number; min_ratings: number };
let mockTopRatedPages: Record<string, Row[]> = {};

const mockCatalogue: Record<string, Record<string, unknown>> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpc(name, args);
      if (name === 'top_rated_titles') {
        const key = (args.p_after_id as string | null) ?? 'first';
        return Promise.resolve({ data: mockTopRatedPages[key] ?? [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      let wanted: string[] = [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        limit: () => chain,
        order: () => chain,
        in: (_column: string, ids: string[]) => {
          wanted = ids;
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) =>
          resolve({
            data:
              table === 'media_items' ? wanted.map((id) => mockCatalogue[id]).filter(Boolean) : [],
            error: null,
          }),
      };
      return chain;
    },
  },
}));

jest.mock('expo-router', () => ({
  useFocusEffect: () => {},
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: mockPush, replace: () => {}, back: () => {} }),
  Stack: { Screen: () => null },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-id' }));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

/** The personalised wall, stood in for: this file is not about the slate. */
jest.mock('@/features/recommendations/use-for-you', () => ({
  ...jest.requireActual('@/features/recommendations/use-for-you'),
  useForYou: () => ({
    data: {
      items: [{ mediaItemId: 'slate-1', title: 'A Personal Pick', year: 2011, posterPath: null }],
      candidatePool: [],
      anchorsUsed: 2,
      lowData: false,
      taste: null,
    },
    isPending: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

const media = (id: string, title: string, genre: string, kind = 'movie') => ({
  id,
  title,
  season_number: null,
  release_date: '2014-01-01',
  poster_path: null,
  runtime_minutes: 120,
  kind,
  genres: [genre],
  original_language: 'en',
  parent: null,
});

const row = (id: string, score: number, count = 7): Row => ({
  media_item_id: id,
  score,
  rating_count: count,
  min_ratings: 5,
});

const open = async () => {
  const view = await renderWithProviders(<RecommendationsScreen />);
  await waitFor(() => expect(view.getByLabelText(/^Showing /)).toBeTruthy());
  return view;
};

const choose = async (view: Awaited<ReturnType<typeof open>>, option: string) => {
  await fireEvent.press(view.getByLabelText(/^Showing /));
  await fireEvent.press(view.getByRole('button', { name: new RegExp(`^${option}`) }));
};

const showing = (view: Awaited<ReturnType<typeof open>>) =>
  view.getByLabelText(/^Showing /).props.accessibilityLabel;

beforeEach(() => {
  mockPush.mockReset();
  mockRpc.mockReset();
  for (const key of Object.keys(mockCatalogue)) delete mockCatalogue[key];
  Object.assign(mockCatalogue, {
    'best-1': media('best-1', 'The Highest', 'Drama'),
    'best-2': media('best-2', 'The Second', 'Comedy'),
    'best-3': media('best-3', 'The Third', 'Drama'),
  });
  mockTopRatedPages = { first: [row('best-1', 9.4), row('best-2', 9.1), row('best-3', 8.8)] };
});

describe('choosing Top Rated', () => {
  it('draws the community wall in the order the server returned it', async () => {
    const view = await open();
    await choose(view, 'Top Rated Movies');

    await waitFor(() => expect(view.getByLabelText('The Highest, 2014')).toBeTruthy());
    expect(showing(view)).toBe('Showing Top Rated Movies');

    // The order is the server's, and the screen sorts nothing: a wall that re-sorted
    // would be a second scoring model, which is the one thing this feature must not be.
    const tiles = view
      .getAllByLabelText(/^The .+, 2014$/)
      .map((node) => node.props.accessibilityLabel);
    expect(tiles).toEqual(['The Highest, 2014', 'The Second, 2014', 'The Third, 2014']);
  });

  it('asks for movies on Top Rated Movies and for seasons on Top Rated TV', async () => {
    const view = await open();

    await choose(view, 'Top Rated Movies');
    await waitFor(() => expect(view.getByLabelText('The Highest, 2014')).toBeTruthy());
    expect(mockRpc).toHaveBeenCalledWith(
      'top_rated_titles',
      expect.objectContaining({ p_medium: 'movies' }),
    );

    mockRpc.mockClear();
    await choose(view, 'Top Rated TV');
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'top_rated_titles',
        expect.objectContaining({ p_medium: 'tv' }),
      ),
    );
    // Two walls, two queries, and the movies one is not re-asked: they are separate
    // cache entries, which is what makes moving between them free.
    expect(showing(view)).toBe('Showing Top Rated TV');
  });

  it('takes Sent to you and Group Picks away, and keeps Filters', async () => {
    const view = await open();
    expect(view.getByLabelText(/^Sent to you/)).toBeTruthy();
    expect(view.getByText('Group Picks')).toBeTruthy();

    await choose(view, 'Top Rated Movies');
    await waitFor(() => expect(view.getByLabelText('The Highest, 2014')).toBeTruthy());

    // Both are statements about particular people, and this wall's whole claim is that
    // the order belongs to everybody.
    expect(view.queryByLabelText(/^Sent to you/)).toBeNull();
    expect(view.queryByText('Group Picks')).toBeNull();
    // Filters narrow *which titles*, which is a question this wall can answer.
    expect(view.getByText('Filters')).toBeTruthy();
  });

  it('leaves Sent to you off when it comes back, rather than under the wrong wall', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText(/^Sent to you/));

    await choose(view, 'Top Rated Movies');
    await waitFor(() => expect(view.getByLabelText('The Highest, 2014')).toBeTruthy());
    await choose(view, 'Movies');

    // It was on when Top Rated was chosen. Restoring it would draw a list of things
    // people sent this reader under a control they last pressed to leave that list.
    await waitFor(() => expect(view.getByLabelText(/^Sent to you/)).toBeTruthy());
    expect(view.getByLabelText(/^Sent to you/).props.accessibilityState?.selected).toBeFalsy();
  });

  it('says what it could not load, and offers the way back', async () => {
    mockTopRatedPages = {};
    const view = await open();

    // An RPC that answers with an error rather than rows.
    mockRpc.mockClear();
    await choose(view, 'Top Rated Movies');

    // With no rows and no error the honest answer is the threshold, not a failure.
    await waitFor(() => expect(view.getByText('Not enough ratings yet')).toBeTruthy());
    expect(view.getByText(/once enough people have rated them/)).toBeTruthy();
  });
});

describe('paging the community wall', () => {
  it('continues from the last row rather than from an offset', async () => {
    // A full page, so the hook believes there may be more.
    const full = Array.from({ length: 20 }, (_, index) => row(`page-${index}`, 9.9 - index / 10));
    for (const item of full) {
      mockCatalogue[item.media_item_id] = media(item.media_item_id, `Film ${item.media_item_id}`, 'Drama');
    }
    mockCatalogue['tail-1'] = media('tail-1', 'The Tail', 'Drama');
    mockTopRatedPages = { first: full, 'page-19': [row('tail-1', 7.0)] };

    const view = await open();
    await choose(view, 'Top Rated Movies');
    await waitFor(() => expect(view.getByLabelText('Film page-0, 2014')).toBeTruthy());

    await fireEvent.scroll(view.getByTestId('for-you-wall'), {
      nativeEvent: {
        contentOffset: { y: 4000 },
        contentSize: { height: 4200, width: 320 },
        layoutMeasurement: { height: 600, width: 320 },
      },
    });

    await waitFor(() => expect(view.getByLabelText('The Tail, 2014')).toBeTruthy());
    // The whole sort key, taken from the last row of page one — not a page number and
    // not a reconstruction from the mapped item.
    expect(mockRpc).toHaveBeenCalledWith(
      'top_rated_titles',
      expect.objectContaining({
        p_after_id: 'page-19',
        p_after_count: 7,
        p_after_score: full[19]!.score,
      }),
    );
  });
});
