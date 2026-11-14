import { act, fireEvent, waitFor, within } from '@testing-library/react-native';

import { prefStore } from '@/test-utils/prefs-store';
import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

/**
 * **For You reopens where the reader left it** (founder, 2026-11-12).
 *
 * It used to reset to Movies / Recommended on every launch, deliberately. It now
 * remembers `{ medium, topMedium }` per account, device-local, under
 * `${profile.id}.for-you.selection`, so the selector restores to exactly one of
 * Recommended Movies, Recommended TV, Top Rated Movies or Top Rated TV — and the
 * personalised side underneath Top Rated comes back with it.
 *
 * What this file holds shut: a restart restores; the default is never written; an account
 * never sees another's selection, not even while its own read is out; a slow read never
 * overrules a tap; anything unreadable is the default; a re-press of the tab is a choice;
 * and restoring a wall asks for that wall's own query and no other.
 */

jest.mock('@/lib/prefs', () => jest.requireActual('@/test-utils/prefs-store').prefsModule);

const mockPush = jest.fn();
const mockRpc = jest.fn();

type Row = { media_item_id: string; score: number; rating_count: number; min_ratings: number };
const mockTopRatedRows: Row[] = [];
const mockCatalogue: Record<string, Record<string, unknown>> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpc(name, args);
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

/** The tab bar, captured rather than mounted, as `SentToYou.test.tsx` does. */
const mockTabPress: (() => void)[] = [];
const mockNavigation = {
  focused: true,
  addListener: (event: string, handler: () => void) => {
    if (event === 'tabPress') mockTabPress.push(handler);
    return () => {};
  },
  isFocused: () => mockNavigation.focused,
};
const pressTab = () => {
  const handler = mockTabPress.at(-1);
  if (!handler) throw new Error('the screen subscribed to no tabPress');
  handler();
};

jest.mock('expo-router', () => ({
  useNavigation: () => mockNavigation,
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
 * The personalised wall, stood in for and **recorded**: every medium the screen asked the
 * slate for. The title names the medium, so what is drawn says which slate it came from.
 */
const mockForYouMedia: string[] = [];
jest.mock('@/features/recommendations/use-for-you', () => ({
  ...jest.requireActual('@/features/recommendations/use-for-you'),
  useForYou: (_userId: string, medium: string) => {
    mockForYouMedia.push(medium);
    return {
      data: {
        items: [{ mediaItemId: `slate-${medium}`, title: `Pick for ${medium}`, year: 2011, posterPath: null }],
        candidatePool: [],
        anchorsUsed: 2,
        lowData: false,
        taste: null,
      },
      isPending: false,
      isError: false,
      refetch: () => Promise.resolve(),
    };
  },
}));

/** The real Top Rated hook, with every call recorded: which side, and whether it ran. */
const mockTopRatedCalls: { medium: string; enabled: boolean }[] = [];
jest.mock('@/features/recommendations/use-top-rated', () => {
  const actual = jest.requireActual('@/features/recommendations/use-top-rated');
  return {
    ...actual,
    useTopRated: (userId: string, medium: string, enabled: boolean) => {
      mockTopRatedCalls.push({ medium, enabled });
      return actual.useTopRated(userId, medium, enabled);
    },
  };
});

const KEY = (id: string) => `${id}.for-you.selection`;

beforeEach(() => {
  prefStore.reset();
  mockProfile.id = 'user-1';
  mockPush.mockReset();
  mockRpc.mockReset();
  mockTabPress.length = 0;
  mockNavigation.focused = true;
  mockForYouMedia.length = 0;
  mockTopRatedCalls.length = 0;
  mockTopRatedRows.length = 0;
  mockTopRatedRows.push({ media_item_id: 'best-1', score: 9.4, rating_count: 7, min_ratings: 5 });
  for (const key of Object.keys(mockCatalogue)) delete mockCatalogue[key];
  mockCatalogue['best-1'] = {
    id: 'best-1',
    title: 'The Highest',
    season_number: null,
    release_date: '2014-01-01',
    poster_path: null,
    runtime_minutes: 120,
    kind: 'movie',
    genres: ['Drama'],
    original_language: 'en',
    parent: null,
  };
});

type View = Awaited<ReturnType<typeof renderWithProviders>>;

const open = async () => {
  const view = await renderWithProviders(<RecommendationsScreen />);
  await waitFor(() => expect(view.getByLabelText(/^Showing /)).toBeTruthy());
  return view;
};

/** Until the screen has asked for `key` and its answer has been applied. */
const settled = async (key: string) => {
  await waitFor(() => expect(prefStore.reads).toContain(key));
  await act(async () => {});
};

/** What the two controls say together, as one phrase: "Showing Top Rated Movies". */
const showing = (view: View) => {
  const wall = String(view.getByLabelText(/^Showing /).props.accessibilityLabel).replace(/^Showing /, '');
  const medium = within(view.getByLabelText('Medium'))
    .getAllByRole('radio')
    .find((cell) => cell.props.accessibilityState?.selected)?.props.accessibilityLabel;
  return `Showing ${wall} ${medium}`;
};

/** The Recommended / Top Rated dropdown, opened on a settled wall (see the top-rated suite). */
const pickWall = async (view: View, wall: 'Recommended' | 'Top Rated') => {
  await waitFor(() => expect(view.queryByTestId('skeleton-grid')).toBeNull());
  await fireEvent.press(view.getByLabelText(/^Showing /));
  await fireEvent.press(await view.findByRole('menuitem', { name: new RegExp(`^${wall}`) }));
};

const switchTo = async (view: View, medium: 'Movies' | 'TV') => {
  await fireEvent.press(within(view.getByLabelText('Medium')).getByRole('radio', { name: medium }));
};

const writesTo = (key: string) => prefStore.writes.filter((write) => write.name === key);

describe('a new account', () => {
  it('opens on Recommended Movies and writes nothing on mount', async () => {
    const view = await open();
    await settled(KEY('user-1'));

    expect(showing(view)).toBe('Showing Recommended Movies');
    expect(prefStore.writes).toEqual([]);
    expect(prefStore.get(KEY('user-1'))).toBeUndefined();
  });
});

describe('a restart', () => {
  it('reopens on Top Rated TV, with the Movies wall still underneath it', async () => {
    const first = await open();
    await settled(KEY('user-1'));
    await pickWall(first, 'Top Rated');
    await switchTo(first, 'TV');
    await waitFor(() => expect(showing(first)).toBe('Showing Top Rated TV'));
    expect(prefStore.get(KEY('user-1'))).toEqual({ medium: 'movies', topMedium: 'tv' });
    await first.unmount();

    const view = await open();
    await waitFor(() => expect(showing(view)).toBe('Showing Top Rated TV'));

    // The personalised side was restored too: a re-press of the tab, which leaves Top Rated
    // for the wall underneath it, lands on the Movies wall Top Rated was opened from.
    await act(async () => pressTab());
    expect(showing(view)).toBe('Showing Recommended Movies');
  });

  it('reopens on Recommended TV', async () => {
    prefStore.set(KEY('user-1'), { medium: 'tv', topMedium: null });
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('Showing Recommended TV'));
    expect(view.getByLabelText('Pick for tv, 2011')).toBeTruthy();
  });

  it('reopens on Top Rated Movies over a TV wall, and comes back to TV', async () => {
    prefStore.set(KEY('user-1'), { medium: 'tv', topMedium: 'movies' });
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('Showing Top Rated Movies'));
    await act(async () => pressTab());
    expect(showing(view)).toBe('Showing Recommended TV');
  });

  /**
   * The dropdown's Recommended keeps the side on screen, as it always has (`onChange` on
   * `for-you-mode`): that is unchanged by persistence, and pinned so it stays so.
   */
  it('leaves a restored Top Rated TV for Recommended TV from the dropdown', async () => {
    prefStore.set(KEY('user-1'), { medium: 'movies', topMedium: 'tv' });
    const view = await open();
    await waitFor(() => expect(showing(view)).toBe('Showing Top Rated TV'));

    await pickWall(view, 'Recommended');
    expect(showing(view)).toBe('Showing Recommended TV');
    expect(prefStore.get(KEY('user-1'))).toEqual({ medium: 'tv', topMedium: null });
  });

  /**
   * `changeMode`'s Top Rated side effects, and only those: a restore turns Sent to you off
   * rather than on, and opens no sheet.
   */
  it('restores Top Rated without turning on Sent to you or opening any sheet', async () => {
    prefStore.set(KEY('user-1'), { medium: 'movies', topMedium: 'movies' });
    const view = await open();
    await waitFor(() => expect(showing(view)).toBe('Showing Top Rated Movies'));

    expect(view.queryByLabelText(/^Sent to You/)).toBeNull();
    expect(view.queryByTestId('group-choosing')).toBeNull();

    await pickWall(view, 'Recommended');
    expect(view.getByLabelText(/^Sent to You/).props.accessibilityState?.selected).toBeFalsy();
    expect(view.queryByTestId('group-choosing')).toBeNull();
    // A restore is not a choice: the only write is the reader's own pick of Recommended.
    expect(writesTo(KEY('user-1'))).toEqual([
      { name: KEY('user-1'), value: { medium: 'movies', topMedium: null } },
    ]);
  });
});

/** Recommended and Top Rated stay two queries: a restore asks only for the wall it draws. */
describe('the two walls stay distinct', () => {
  it('restoring Top Rated TV over Movies never asks the slate for TV', async () => {
    prefStore.set(KEY('user-1'), { medium: 'movies', topMedium: 'tv' });
    const view = await open();
    await waitFor(() => expect(showing(view)).toBe('Showing Top Rated TV'));
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('top_rated_titles', expect.objectContaining({ p_medium: 'tv' })),
    );

    expect(new Set(mockForYouMedia)).toEqual(new Set(['movies']));
    expect(mockTopRatedCalls.at(-1)).toEqual({ medium: 'tv', enabled: true });
    expect(mockRpc).not.toHaveBeenCalledWith(
      'top_rated_titles',
      expect.objectContaining({ p_medium: 'movies' }),
    );
  });

  it('restoring Recommended TV never runs Top Rated', async () => {
    prefStore.set(KEY('user-1'), { medium: 'tv', topMedium: null });
    const view = await open();
    await waitFor(() => expect(showing(view)).toBe('Showing Recommended TV'));
    await act(async () => {});

    expect(mockForYouMedia.at(-1)).toBe('tv');
    expect(mockTopRatedCalls.every((call) => !call.enabled)).toBe(true);
    expect(mockRpc).not.toHaveBeenCalledWith('top_rated_titles', expect.anything());
  });
});

describe('a stored value this screen cannot draw', () => {
  const cases: [string, unknown, string][] = [
    ['a bare mode string', 'topTv', 'Showing Recommended Movies'],
    ['Collection’s old Lists', 'lists', 'Showing Recommended Movies'],
    ['a number', 42, 'Showing Recommended Movies'],
    ['an array', ['tv', 'tv'], 'Showing Recommended Movies'],
    ['an empty object', {}, 'Showing Recommended Movies'],
    ['a Collection side as the medium', { medium: 'tv_seasons', topMedium: null }, 'Showing Recommended Movies'],
    // Each field falls back on its own: a good one is kept beside a bad one.
    ['a bad Top Rated side beside a good medium', { medium: 'tv', topMedium: 'top' }, 'Showing Recommended TV'],
    ['a bad medium beside a good Top Rated side', { medium: 7, topMedium: 'tv' }, 'Showing Top Rated TV'],
  ];

  it.each(cases)('treats %s as the default', async (_name, stored, expected) => {
    prefStore.set(KEY('user-1'), stored);
    const view = await open();
    await settled(KEY('user-1'));

    await waitFor(() => expect(showing(view)).toBe(expected));
    expect(prefStore.writes).toEqual([]);
  });

  it('treats a stored bad medium beneath Top Rated as Movies when it leaves', async () => {
    prefStore.set(KEY('user-1'), { medium: 'books', topMedium: 'tv' });
    const view = await open();
    await waitFor(() => expect(showing(view)).toBe('Showing Top Rated TV'));

    await act(async () => pressTab());
    expect(showing(view)).toBe('Showing Recommended Movies');
  });

  it('opens on the default when the store refuses', async () => {
    prefStore.failing.add(KEY('user-1'));
    const view = await open();
    await settled(KEY('user-1'));

    expect(showing(view)).toBe('Showing Recommended Movies');
  });
});

describe('two accounts on one device', () => {
  it('never shows the outgoing account’s Top Rated, even while the incoming read is out', async () => {
    const view = await open();
    await settled(KEY('user-1'));
    await pickWall(view, 'Top Rated');
    await switchTo(view, 'TV');
    await waitFor(() => expect(showing(view)).toBe('Showing Top Rated TV'));
    const before = prefStore.get(KEY('user-1'));

    prefStore.holdReads(KEY('user-2'));
    mockProfile.id = 'user-2';
    await view.rerender(<RecommendationsScreen />);

    // The read is still out, and the screen already belongs to the new reader.
    await waitFor(() => expect(prefStore.pendingReads(KEY('user-2'))).toBe(1));
    expect(showing(view)).toBe('Showing Recommended Movies');

    await act(async () => prefStore.releaseReads(KEY('user-2')));
    expect(showing(view)).toBe('Showing Recommended Movies');

    expect(prefStore.get(KEY('user-1'))).toEqual(before);
    expect(writesTo(KEY('user-2'))).toEqual([]);
  });

  it('applies the incoming account’s own selection once it lands', async () => {
    prefStore.set(KEY('user-2'), { medium: 'tv', topMedium: null });
    const view = await open();
    await settled(KEY('user-1'));
    await pickWall(view, 'Top Rated');

    mockProfile.id = 'user-2';
    await view.rerender(<RecommendationsScreen />);

    await waitFor(() => expect(showing(view)).toBe('Showing Recommended TV'));
  });

  it('falls back to the default, not the previous account, when the incoming read fails', async () => {
    const view = await open();
    await settled(KEY('user-1'));
    await pickWall(view, 'Top Rated');
    await waitFor(() => expect(showing(view)).toBe('Showing Top Rated Movies'));

    prefStore.failing.add(KEY('user-2'));
    mockProfile.id = 'user-2';
    await view.rerender(<RecommendationsScreen />);
    await settled(KEY('user-2'));

    expect(showing(view)).toBe('Showing Recommended Movies');
  });
});

describe('a slow read', () => {
  it('does not overrule a run of taps, and the last tap is what is stored', async () => {
    prefStore.set(KEY('user-1'), { medium: 'movies', topMedium: 'tv' });
    prefStore.holdReads(KEY('user-1'));
    const view = await open();
    await waitFor(() => expect(prefStore.pendingReads(KEY('user-1'))).toBe(1));

    await switchTo(view, 'TV');
    await switchTo(view, 'Movies');
    await switchTo(view, 'TV');
    await act(async () => prefStore.releaseReads(KEY('user-1')));

    expect(showing(view)).toBe('Showing Recommended TV');
    expect(writesTo(KEY('user-1')).at(-1)?.value).toEqual({ medium: 'tv', topMedium: null });
    expect(prefStore.get(KEY('user-1'))).toEqual({ medium: 'tv', topMedium: null });
  });

  it('does not take Sent to you away from a reader who opened it first', async () => {
    prefStore.set(KEY('user-1'), { medium: 'movies', topMedium: 'movies' });
    prefStore.holdReads(KEY('user-1'));
    const view = await open();
    await waitFor(() => expect(prefStore.pendingReads(KEY('user-1'))).toBe(1));

    await fireEvent.press(view.getByLabelText(/^Sent to You/));
    await act(async () => prefStore.releaseReads(KEY('user-1')));

    expect(view.getByLabelText(/^Sent to You/).props.accessibilityState?.selected).toBe(true);
    expect(showing(view)).toBe('Showing Recommended Movies');
  });
});

/**
 * **A re-press of the tab is a choice** (stated in the PR): what the reader sees after it is
 * the personalised wall on their medium, so that is what is stored and what a restart shows.
 */
describe('re-tapping the For You tab', () => {
  it('leaves Top Rated for the wall underneath, keeps the medium, and remembers it', async () => {
    prefStore.set(KEY('user-1'), { medium: 'tv', topMedium: 'movies' });
    const first = await open();
    await waitFor(() => expect(showing(first)).toBe('Showing Top Rated Movies'));

    await act(async () => pressTab());

    expect(showing(first)).toBe('Showing Recommended TV');
    expect(prefStore.get(KEY('user-1'))).toEqual({ medium: 'tv', topMedium: null });
    await first.unmount();

    const view = await open();
    await settled(KEY('user-1'));
    expect(showing(view)).toBe('Showing Recommended TV');
  });

  /** The filters surviving it is pinned in `SentToYou.test.tsx`, unchanged. */
  it('turns Sent to you off on a TV wall, keeps TV, and stores the wall', async () => {
    prefStore.set(KEY('user-1'), { medium: 'tv', topMedium: null });
    const view = await open();
    await waitFor(() => expect(showing(view)).toBe('Showing Recommended TV'));
    await fireEvent.press(view.getByLabelText(/^Sent to You/));
    expect(view.getByLabelText(/^Sent to You/).props.accessibilityState?.selected).toBe(true);

    await act(async () => pressTab());

    expect(view.getByLabelText(/^Sent to You/).props.accessibilityState?.selected).toBeFalsy();
    expect(showing(view)).toBe('Showing Recommended TV');
    expect(writesTo(KEY('user-1'))).toEqual([
      { name: KEY('user-1'), value: { medium: 'tv', topMedium: null } },
    ]);
  });

  it('outranks a stored Top Rated still being read', async () => {
    prefStore.set(KEY('user-1'), { medium: 'movies', topMedium: 'tv' });
    prefStore.holdReads(KEY('user-1'));
    const view = await open();
    await waitFor(() => expect(prefStore.pendingReads(KEY('user-1'))).toBe(1));

    await act(async () => pressTab());
    await act(async () => prefStore.releaseReads(KEY('user-1')));

    expect(showing(view)).toBe('Showing Recommended Movies');
    expect(prefStore.get(KEY('user-1'))).toEqual({ medium: 'movies', topMedium: null });
  });

  it('writes nothing when the press arrives from another tab', async () => {
    prefStore.set(KEY('user-1'), { medium: 'movies', topMedium: 'tv' });
    const view = await open();
    await waitFor(() => expect(showing(view)).toBe('Showing Top Rated TV'));

    mockNavigation.focused = false;
    await act(async () => pressTab());

    expect(showing(view)).toBe('Showing Top Rated TV');
    expect(prefStore.writes).toEqual([]);
  });
});

describe('For You and Collection', () => {
  it('reads and writes only its own key, so Collection on TV does not move For You', async () => {
    prefStore.set('user-1.collection.medium', 'tv_seasons');
    prefStore.set('user-1.collection.segment', 'watchlist');
    const view = await open();
    await settled(KEY('user-1'));

    expect(showing(view)).toBe('Showing Recommended Movies');

    await switchTo(view, 'TV');
    expect(prefStore.reads.every((name) => name === KEY('user-1'))).toBe(true);
    expect(prefStore.writes.map((write) => write.name)).toEqual([KEY('user-1')]);
    expect(prefStore.get('user-1.collection.medium')).toBe('tv_seasons');
    expect(prefStore.get('user-1.collection.segment')).toBe('watchlist');
  });
});
