import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { expectRowFitsNarrow } from '@/test-utils/narrow-row';
import { prefStore } from '@/test-utils/prefs-store';
import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

/**
 * **For You's Poster / List view mode** (FU1113-C).
 *
 * What this file holds shut:
 *   - the control row: Movies | TV untouched in the header; the view toggle and the
 *     Filters icon opposite the marquee; Filters opens the filter sheet, with no Sort;
 *   - list mode is the wall drawn as rows — the same ids, in the same order, with the same
 *     eligibility (no X on Top Rated) — and its bookmark, X and row press call the same
 *     handlers the poster's do (a fixed slate);
 *   - the mode is remembered per account at `${id}.for-you.view-mode`, written only on a
 *     tap, validated, defaulted on a failed read, never inherited across an account
 *     switch, and the selection pref is left exactly as it was.
 */

jest.mock('@/lib/prefs', () => jest.requireActual('@/test-utils/prefs-store').prefsModule);

const mockPush = jest.fn();
const mockDismiss = jest.fn((_id: string) => Promise.resolve({ ok: true as const }));
const mockSetWatchlist = jest.fn((_args: unknown) => Promise.resolve({ outcome: 'ok' as const }));

type Row = { media_item_id: string; score: number; rating_count: number; min_ratings: number };
const mockTopRatedRows: Row[] = [];
const mockCatalogue: Record<string, Record<string, unknown>> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === 'top_rated_titles') {
        return Promise.resolve({ data: args.p_after_id ? [] : mockTopRatedRows, error: null });
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
            data: table === 'media_items' ? wanted.map((id) => mockCatalogue[id]).filter(Boolean) : [],
            error: null,
          }),
      };
      return chain;
    },
  },
}));

jest.mock('expo-router', () => ({
  useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
  useFocusEffect: () => {},
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: mockPush, replace: () => {}, back: () => {} }),
  Stack: { Screen: () => null },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-id' }));

/** Mutable so a test can sign one reader out and another in without unmounting. */
const mockProfile = { id: 'user-1' };
jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: mockProfile.id,
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

/**
 * **A fixed slate**, in an order no sort would produce (not by title, not by year), so a
 * list that re-ordered anything would be caught.
 */
const SLATE = [
  { mediaItemId: 'rec-c', title: 'Cobalt', year: 2003, kind: 'movie', posterPath: null },
  { mediaItemId: 'rec-a', title: 'Amber', year: 2019, kind: 'movie', posterPath: null },
  { mediaItemId: 'rec-d', title: 'Dusk', year: 1998, kind: 'movie', posterPath: null },
  { mediaItemId: 'rec-b', title: 'Birch', year: 2011, kind: 'movie', posterPath: null },
];

jest.mock('@/features/recommendations/use-for-you', () => ({
  ...jest.requireActual('@/features/recommendations/use-for-you'),
  useForYou: () => ({
    data: {
      items: SLATE,
      // What the filter sheet offers its options from: a genre to choose (C9's filtered row).
      candidatePool: SLATE.map((item) => ({
        ...item,
        seriesTitle: null,
        genres: ['Drama'],
        language: 'en',
        runtimeMinutes: null,
        score: null,
        bucket: null,
        watchedOn: null,
        addedAt: null,
      })),
      anchorsUsed: 2,
      lowData: false,
      taste: null,
    },
    isPending: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

jest.mock('@/features/recommendations/use-dismissed', () => ({
  ...jest.requireActual('@/features/recommendations/use-dismissed'),
  useDismissTitle: () => mockDismiss,
}));

jest.mock('@/features/collection/writes', () => ({
  ...jest.requireActual('@/features/collection/writes'),
  newOperationId: () => 'op-1',
  setWatchlist: (args: unknown) => mockSetWatchlist(args),
}));

const VIEW_KEY = (id: string) => `${id}.for-you.view-mode`;
const SELECTION_KEY = (id: string) => `${id}.for-you.selection`;

beforeEach(() => {
  prefStore.reset();
  mockProfile.id = 'user-1';
  mockPush.mockReset();
  mockDismiss.mockClear();
  mockSetWatchlist.mockClear();
  mockTopRatedRows.length = 0;
  mockTopRatedRows.push(
    { media_item_id: 'best-2', score: 9.6, rating_count: 9, min_ratings: 5 },
    { media_item_id: 'best-1', score: 9.4, rating_count: 7, min_ratings: 5 },
  );
  for (const key of Object.keys(mockCatalogue)) delete mockCatalogue[key];
  for (const [id, title] of [
    ['best-1', 'The Highest'],
    ['best-2', 'Above It'],
  ] as const) {
    mockCatalogue[id] = {
      id,
      title,
      season_number: null,
      release_date: '2014-01-01',
      poster_path: null,
      runtime_minutes: 120,
      kind: 'movie',
      genres: ['Drama'],
      original_language: 'en',
      parent: null,
    };
  }
});

type View = Awaited<ReturnType<typeof renderWithProviders>>;

const open = async () => {
  const view = await renderWithProviders(<RecommendationsScreen />);
  await waitFor(() => expect(view.getByTestId('for-you-controls')).toBeTruthy());
  return view;
};

/** Until the screen has read `key` and applied the answer. */
const settled = async (key: string) => {
  await waitFor(() => expect(prefStore.reads).toContain(key));
  await act(async () => {});
};

const mode = (view: View) =>
  within(view.getByTestId('for-you-view-mode'))
    .getAllByRole('radio')
    .find((cell) => cell.props.accessibilityState?.selected)?.props.accessibilityLabel;

/** The wall's titles, in drawn order, read off the bookmark each tile and row carries. */
const drawnOrder = (view: View) =>
  view
    .getAllByLabelText(/^(Save|Remove) .+ (to|from) watchlist$/)
    .map((node) => String(node.props.accessibilityLabel).replace(/^(Save|Remove) (.+) (to|from) watchlist$/, '$2'));

const choose = async (view: View, name: 'Poster view' | 'List view') => {
  await fireEvent.press(within(view.getByTestId('for-you-view-mode')).getByRole('radio', { name }));
};

describe('the control row (C2)', () => {
  it('keeps Movies | TV in the header, and puts the view toggle and Filters opposite the marquee', async () => {
    const view = await open();
    // Movies | TV, unchanged: the header's own switch.
    expect(
      within(view.getByLabelText('Medium'))
        .getAllByRole('radio')
        .map((cell) => cell.props.accessibilityLabel),
    ).toEqual(['Movies', 'TV']);

    const row = view.getByTestId('for-you-controls-row');
    expect(within(row).getByLabelText(/^Showing /)).toBeTruthy();
    const trailing = view.getByTestId('for-you-controls-row-trailing');
    expect(within(trailing).getByTestId('for-you-view-mode')).toBeTruthy();
    const filters = within(trailing).getByTestId('for-you-filters');
    expect(filters.props.accessibilityLabel).toBe('Filters');
    expect(mode(view)).toBe('Poster view');
  });

  it('opens the filter sheet from the icon, with no Sort in it', async () => {
    const view = await open();
    await fireEvent.press(view.getByTestId('for-you-filters'));
    await waitFor(() => expect(view.getByTestId('collection-filter-scroll')).toBeTruthy());
    expect(view.queryByTestId('collection-sort-section')).toBeNull();
    expect(view.queryByRole('header', { name: 'Sort' })).toBeNull();
    expect(view.getByText('Apply')).toBeTruthy();
  });

  it('draws no view toggle over Sent to You, which is always a list', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText(/^Sent to You/));
    await waitFor(() => expect(view.queryByTestId('for-you-view-mode')).toBeNull());
    expect(view.getByTestId('for-you-filters')).toBeTruthy();
  });
});

describe('list mode is the wall, drawn as rows (C3)', () => {
  it('holds the same recommendation ids in the same order as poster mode', async () => {
    const view = await open();
    await waitFor(() => expect(view.queryByTestId('for-you-list')).toBeNull());
    const poster = drawnOrder(view);
    expect(poster).toEqual(['Cobalt', 'Amber', 'Dusk', 'Birch']);

    await choose(view, 'List view');
    await waitFor(() => expect(view.getByTestId('for-you-list')).toBeTruthy());
    expect(drawnOrder(view)).toEqual(poster);
    // One row per recommendation, each keyed by its id, in the slate's order.
    const rows = within(view.getByTestId('for-you-list'))
      .getAllByTestId(/^for-you-row-actions-/)
      .map((node) => String(node.props.testID).replace('for-you-row-actions-', ''));
    expect(rows).toEqual(SLATE.map((item) => item.mediaItemId));
  });

  it('draws the poster thumbnail, the title, the year and the kind on each row', async () => {
    const view = await open();
    await choose(view, 'List view');
    const list = await view.findByTestId('for-you-list');
    expect(within(list).getByText('Cobalt (2003)')).toBeTruthy();
    expect(within(list).getAllByText('Movie')).toHaveLength(SLATE.length);
    expect(within(list).getByLabelText('Cobalt, 2003, Movie')).toBeTruthy();
  });

  it('opens the title from a row, as the poster does', async () => {
    const view = await open();
    await choose(view, 'List view');
    await fireEvent.press(await view.findByLabelText('Dusk, 1998, Movie'));
    expect(mockPush).toHaveBeenCalledWith('/title/rec-d');
  });

  it('bookmarks through the same write as the poster', async () => {
    const view = await open();
    await choose(view, 'List view');
    await fireEvent.press(await view.findByLabelText('Save Amber to watchlist'));
    await waitFor(() => expect(mockSetWatchlist).toHaveBeenCalledTimes(1));
    expect(mockSetWatchlist).toHaveBeenCalledWith(
      expect.objectContaining({ mediaItemId: 'rec-a', present: true }),
    );
  });

  it('dismisses through the same write as the poster’s X', async () => {
    const view = await open();
    await choose(view, 'List view');
    await fireEvent.press(await view.findByLabelText('Not interested in Birch'));
    expect(mockDismiss).toHaveBeenCalledWith('rec-b');

    // And the poster's own X calls the very same thing.
    await choose(view, 'Poster view');
    await fireEvent.press(await view.findByLabelText('Not interested in Cobalt'));
    expect(mockDismiss.mock.calls.map(([id]) => id)).toEqual(['rec-b', 'rec-c']);
  });

  it('keeps the wall’s eligibility on Top Rated: same order, a bookmark, and no X', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByLabelText(/^Showing /)).toBeTruthy());
    await fireEvent.press(view.getByLabelText(/^Showing /));
    await fireEvent.press(await view.findByRole('menuitem', { name: /^Top Rated/ }));
    await waitFor(() => expect(drawnOrder(view)).toEqual(['Above It', 'The Highest']));
    const poster = drawnOrder(view);

    await choose(view, 'List view');
    await waitFor(() => expect(view.getByTestId('for-you-list')).toBeTruthy());
    expect(drawnOrder(view)).toEqual(poster);
    expect(view.queryByLabelText(/^Not interested in/)).toBeNull();
  });

  it('gives every row control a 44pt target', async () => {
    const view = await open();
    await choose(view, 'List view');
    for (const label of ['Save Cobalt to watchlist', 'Not interested in Cobalt']) {
      const control = await view.findByLabelText(label);
      const slop = control.props.hitSlop as number;
      expect(theme.layout.icon.md + slop * 2).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    }
    const style = StyleSheet.flatten(view.getByTestId('for-you-row-actions-rec-c').props.style);
    expect(style.flexDirection).toBe('row');
  });
});

describe('the view mode is remembered per account (C4)', () => {
  it('opens on Poster and writes nothing on mount', async () => {
    const view = await open();
    await settled(VIEW_KEY('user-1'));
    expect(mode(view)).toBe('Poster view');
    expect(prefStore.writes).toEqual([]);
  });

  it('writes List on a tap, and reopens on List', async () => {
    const first = await open();
    await settled(VIEW_KEY('user-1'));
    await choose(first, 'List view');
    expect(prefStore.writes).toEqual([{ name: VIEW_KEY('user-1'), value: 'list' }]);
    await first.unmount();

    const view = await open();
    await waitFor(() => expect(mode(view)).toBe('List view'));
    expect(view.getByTestId('for-you-list')).toBeTruthy();
  });

  it('keeps the mode across a re-render of the mounted tab (away and back)', async () => {
    const view = await open();
    await settled(VIEW_KEY('user-1'));
    await choose(view, 'List view');
    await view.rerender(<RecommendationsScreen />);
    expect(mode(view)).toBe('List view');
  });

  it.each([
    ['a value from another build', 'wall'],
    ['a number', 7],
    ['an object', { mode: 'list' }],
  ])('treats %s as Poster', async (_name, stored) => {
    prefStore.set(VIEW_KEY('user-1'), stored);
    const view = await open();
    await settled(VIEW_KEY('user-1'));
    expect(mode(view)).toBe('Poster view');
    expect(prefStore.writes).toEqual([]);
  });

  it('falls back to Poster on a failed read', async () => {
    prefStore.set(VIEW_KEY('user-1'), 'list');
    prefStore.failing.add(VIEW_KEY('user-1'));
    const view = await open();
    await settled(VIEW_KEY('user-1'));
    expect(mode(view)).toBe('Poster view');
  });

  it('never hands one account’s List to the next, not even while its read is out', async () => {
    prefStore.set(VIEW_KEY('user-1'), 'list');
    const view = await open();
    await waitFor(() => expect(mode(view)).toBe('List view'));

    // Account B has nothing stored, and its read is held.
    prefStore.holdReads(VIEW_KEY('user-2'));
    mockProfile.id = 'user-2';
    await view.rerender(<RecommendationsScreen />);
    expect(mode(view)).toBe('Poster view');
    await act(async () => prefStore.releaseReads(VIEW_KEY('user-2')));
    expect(mode(view)).toBe('Poster view');
    expect(prefStore.get(VIEW_KEY('user-2'))).toBeUndefined();

    // And back: A's own choice is still A's.
    mockProfile.id = 'user-1';
    await view.rerender(<RecommendationsScreen />);
    await waitFor(() => expect(mode(view)).toBe('List view'));
  });

  it('lets a tap outrank a slow read', async () => {
    prefStore.set(VIEW_KEY('user-1'), 'poster');
    prefStore.holdReads(VIEW_KEY('user-1'));
    const view = await open();
    await choose(view, 'List view');
    await act(async () => prefStore.releaseReads(VIEW_KEY('user-1')));
    expect(mode(view)).toBe('List view');
  });

  it('leaves the selection pref untouched', async () => {
    prefStore.set(SELECTION_KEY('user-1'), { medium: 'tv', topMedium: null });
    const view = await open();
    await settled(VIEW_KEY('user-1'));
    await choose(view, 'List view');
    await choose(view, 'Poster view');
    expect(prefStore.writes.map((write) => write.name)).toEqual([
      VIEW_KEY('user-1'),
      VIEW_KEY('user-1'),
    ]);
    expect(prefStore.get(SELECTION_KEY('user-1'))).toEqual({ medium: 'tv', topMedium: null });
  });
});

/**
 * QA 11-14 §5: Filters first and the view toggle rightmost, with Clear all (when filters are
 * on) between them, as a filter control. Was: the toggle first, then Filters, then Clear
 * all. The same targets as before, so the row's budget at 320pt is unchanged.
 */
describe('at 320pt and the largest text size (C9)', () => {
  it('keeps Recommended ▾, Filters and the view toggle on one line, the toggle rightmost', async () => {
    const view = await open();
    const { targets } = expectRowFitsNarrow(view.getByTestId, 'for-you-controls-row');
    expect(targets.map((target) => target.label)).toEqual(['Filters', 'Poster view', 'List view']);
  });

  it('still fits with Clear beside Filters while filters are on, the toggle still rightmost', async () => {
    const view = await open();
    await fireEvent.press(view.getByTestId('for-you-filters'));
    await waitFor(() => expect(view.getByTestId('collection-filter-scroll')).toBeTruthy());
    await fireEvent.press(view.getAllByRole('checkbox')[0]!);
    await fireEvent.press(view.getByText('Apply'));
    await waitFor(() => expect(view.getByTestId('for-you-clear-filters')).toBeTruthy());
    const { targets } = expectRowFitsNarrow(view.getByTestId, 'for-you-controls-row');
    expect(targets.map((target) => target.label)).toEqual([
      'Filters, 1 on',
      'Clear all',
      'Poster view',
      'List view',
    ]);
  });
});

describe('the trailing order (QA 11-14 §5)', () => {
  const order = (view: Awaited<ReturnType<typeof open>>) => {
    // The controls' testIDs in drawing order, depth first, under the trailing group.
    const wanted = new Set(['for-you-filters', 'for-you-clear-filters', 'for-you-view-mode']);
    const seen: string[] = [];
    type Node = { props: { testID?: string }; children: readonly (Node | string)[] };
    const walk = (node: Node) => {
      const id = node.props.testID;
      if (id && wanted.has(id) && !seen.includes(id)) seen.push(id);
      for (const child of node.children) if (typeof child !== 'string') walk(child);
    };
    walk(view.getByTestId('for-you-controls') as unknown as Node);
    return seen;
  };

  it('is Filters, then the view toggle', async () => {
    const view = await open();
    expect(order(view)).toEqual(['for-you-filters', 'for-you-view-mode']);
  });

  it('is Filters, Clear all, then the view toggle while filters are on', async () => {
    const view = await open();
    await fireEvent.press(view.getByTestId('for-you-filters'));
    await waitFor(() => expect(view.getByTestId('collection-filter-scroll')).toBeTruthy());
    await fireEvent.press(view.getAllByRole('checkbox')[0]!);
    await fireEvent.press(view.getByText('Apply'));
    await waitFor(() => expect(view.getByTestId('for-you-clear-filters')).toBeTruthy());
    expect(order(view)).toEqual(['for-you-filters', 'for-you-clear-filters', 'for-you-view-mode']);
    // Clear all still clears, and the toggle stays where it is.
    await fireEvent.press(view.getByTestId('for-you-clear-filters'));
    await waitFor(() => expect(view.queryByTestId('for-you-clear-filters')).toBeNull());
    expect(order(view)).toEqual(['for-you-filters', 'for-you-view-mode']);
  });

  it('is Filters alone over Sent to You, which has no toggle', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText(/^Sent to You/));
    await waitFor(() => expect(view.queryByTestId('for-you-view-mode')).toBeNull());
    expect(order(view)).toEqual(['for-you-filters']);
  });
});
