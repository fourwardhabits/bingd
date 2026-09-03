import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { GroupPicksSheet } from './GroupPicksSheet';

/**
 * The Group Picks flow: choose people, get a list, and everything the list may and
 * may not say.
 *
 * The RPC is stood in for (group-picks.test.mjs is where the real arithmetic is
 * exercised against the real policies), so what this file owns is the sheet's side of
 * the contract: the picker step, the reasons, the displayed number being the bingd.
 * score and never the internal one, filters that stay local and never re-run the
 * expensive call, and the analytics vocabulary carrying counts rather than people.
 */

const mockPush = jest.fn();
const mockTrack = jest.fn();
const mockSetWatchlist = jest.fn(async (_args: unknown) => ({ outcome: 'ok' as const }));
const mockRpc = jest.fn();

let mockRpcResults: Record<string, unknown> = {};
let mockFollowRows: unknown[] = [];
let mockMediaRows: unknown[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: () => {}, back: () => {} }),
}));

jest.mock('@/lib/analytics', () => ({
  ...jest.requireActual('@/lib/analytics'),
  track: (event: unknown) => mockTrack(event),
}));

jest.mock('@/features/collection/writes', () => ({
  newOperationId: () => 'op-1',
  mustReconcile: () => false,
  setWatchlist: (args: unknown) => mockSetWatchlist(args),
}));

jest.mock('@/features/collection/invalidate', () => ({
  invalidateAfterWatchlistChange: () => {},
}));

jest.mock('@/features/collection/use-collection', () => ({
  ...jest.requireActual('@/features/collection/use-collection'),
  useWatchlist: () => ({ data: [] }),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const result = mockRpcResults[name];
      if (result instanceof Promise) return result;
      return Promise.resolve({ data: result ?? null, error: null });
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        in: () => chain,
        limit: () => chain,
        order: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          resolve({
            data:
              table === 'follows' ? mockFollowRows : table === 'media_items' ? mockMediaRows : [],
            error: null,
          }),
      };
      return chain;
    },
  },
}));

const followRow = (id: string, username: string, name: string) => ({
  follower_id: 'viewer-1',
  followee_id: id,
  followee: { id, username, display_name: name, avatar_path: null, status: 'active' },
});

const mediaRow = (
  id: string,
  title: string,
  { genre = 'Comedy', year = '2020-01-01' }: { genre?: string; year?: string } = {},
) => ({
  id,
  title,
  release_date: year,
  poster_path: null,
  kind: 'movie',
  genres: [genre],
  original_language: 'en',
  popularity: 10,
});

const pickRow = (id: string, groupScore: number, over: Record<string, unknown> = {}) => ({
  media_item_id: id,
  saved_count: 0,
  watched_count: 0,
  rewatch: false,
  source: 'group',
  group_score: groupScore,
  community_score: null,
  ...over,
});

const props = () => ({
  viewerId: 'viewer-1',
  medium: 'movies' as 'movies' | 'tv',
  onClose: jest.fn(),
});

/** Renders, selects Abby and John, and asks for picks. */
const openResults = async (sheetProps = props()) => {
  await renderWithProviders(<GroupPicksSheet {...sheetProps} />);
  await screen.findByLabelText('Abby, @abby');
  await fireEvent.press(screen.getByLabelText('Abby, @abby'));
  await fireEvent.press(screen.getByLabelText('John, @john'));
  await fireEvent.press(screen.getByText('Get picks for 3'));
  return sheetProps;
};

beforeEach(() => {
  mockPush.mockReset();
  mockTrack.mockReset();
  mockRpc.mockReset();
  mockSetWatchlist.mockClear();
  mockFollowRows = [
    followRow('u-abby', 'abby', 'Abby'),
    followRow('u-john', 'john', 'John'),
    followRow('u-maria', 'maria', 'Maria'),
  ];
  mockMediaRows = [
    mediaRow('m1', 'Game Night', { genre: 'Comedy', year: '2018-02-01' }),
    mediaRow('m2', 'The Menu', { genre: 'Horror', year: '2022-11-01' }),
    mediaRow('m3', 'Palm Springs', { genre: 'Comedy', year: '2019-07-01' }),
    mediaRow('m4', 'Wave of Now', { genre: 'Drama', year: '2021-03-01' }),
  ];
  mockRpcResults = {
    group_picks: {
      status: 'ok',
      effective_member_count: 3,
      picks: [
        pickRow('m1', 0.8, { saved_count: 3, source: 'saved', community_score: 8.4 }),
        pickRow('m2', 0.5),
        pickRow('m3', 0.45, {
          rewatch: true,
          watched_count: 1,
          source: 'rewatch',
          community_score: 8.0,
        }),
        pickRow('m4', 0.15, { source: 'trending' }),
      ],
    },
  };
});

describe('choosing the group', () => {
  it('pins the reader and asks who is watching', async () => {
    await renderWithProviders(<GroupPicksSheet {...props()} />);
    expect(screen.getByText("Who's watching?")).toBeTruthy();

    const you = await screen.findByLabelText('You');
    expect(you.props.accessibilityState.checked).toBe(true);
    expect(you.props.accessibilityState.disabled).toBe(true);
  });

  it('holds the button until at least one other person is chosen', async () => {
    await renderWithProviders(<GroupPicksSheet {...props()} />);
    await screen.findByLabelText('Abby, @abby');

    const cta = screen.getByRole('button', { name: 'Get picks for 1' });
    expect(cta.props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(screen.getByLabelText('Abby, @abby'));
    const armed = screen.getByRole('button', { name: 'Get picks for 2' });
    expect(armed.props.accessibilityState.disabled).toBe(false);
  });

  it('counts the reader in the button label', async () => {
    await renderWithProviders(<GroupPicksSheet {...props()} />);
    await screen.findByLabelText('Abby, @abby');
    await fireEvent.press(screen.getByLabelText('Abby, @abby'));
    await fireEvent.press(screen.getByLabelText('John, @john'));
    expect(screen.getByText('Get picks for 3')).toBeTruthy();
  });

  it('asks the server for exactly the chosen people and the wall medium', async () => {
    await openResults();
    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    const [name, args] = mockRpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('group_picks');
    expect((args.p_member_ids as string[]).sort()).toEqual(['u-abby', 'u-john']);
    expect(args.p_medium).toBe('movies');
  });

  it('answers for TV when opened from the TV wall', async () => {
    await openResults({ ...props(), medium: 'tv' as const });
    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    const [, args] = mockRpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_medium).toBe('tv');
  });

  it('says so when there is nobody to watch with', async () => {
    mockFollowRows = [];
    await renderWithProviders(<GroupPicksSheet {...props()} />);
    expect(await screen.findByText('Nobody to watch with yet')).toBeTruthy();
    expect(screen.queryByText(/^Get picks/)).toBeNull();
  });
});

describe('the results', () => {
  it('names the group and counts the picks', async () => {
    await openResults();
    expect(await screen.findByText('Game Night (2018)')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Abby')).toBeTruthy();
    expect(screen.getByText('John')).toBeTruthy();
    expect(screen.getByText('4 picks')).toBeTruthy();
  });

  it('gives each row its one honest reason', async () => {
    await openResults();
    expect(await screen.findByText('3 people saved this')).toBeTruthy();
    expect(screen.getByText('Fits the group')).toBeTruthy();
    expect(screen.getByText('Worth a rewatch')).toBeTruthy();
    expect(screen.getByText('Trending now')).toBeTruthy();
  });

  it('shows the bingd. score and never the internal group score', async () => {
    await openResults();
    expect(await screen.findByText('8.4')).toBeTruthy();
    expect(screen.getByText('8.0')).toBeTruthy();
    // The internal ranking numbers exist on every pick and must appear nowhere.
    expect(screen.queryByText('0.8')).toBeNull();
    expect(screen.queryByText('0.5')).toBeNull();
    expect(screen.queryByText('0.45')).toBeNull();
  });

  it('opens a row into the title page, closing the sheet first', async () => {
    const sheetProps = await openResults();
    await fireEvent.press(await screen.findByText('Game Night (2018)'));
    expect(sheetProps.onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/title/m1');
  });

  it('saves a pick to the watchlist under the group_picks surface', async () => {
    await openResults();
    await screen.findByText('Game Night (2018)');
    await fireEvent.press(screen.getByLabelText('Add Game Night to your watchlist'));
    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith({
        name: 'watchlist_added',
        props: { surface: 'group_picks' },
      }),
    );
  });

  it('says the quiet line when nothing rests on a shared save', async () => {
    mockRpcResults.group_picks = {
      status: 'ok',
      effective_member_count: 3,
      picks: [pickRow('m2', 0.5), pickRow('m3', 0.45)],
    };
    await openResults();
    await screen.findByText('The Menu (2022)');
    expect(
      screen.getByText("Nobody has saved the same titles yet, so these come from everyone's taste."),
    ).toBeTruthy();
  });

  it('offers honest emptiness when the group has nothing to pick from', async () => {
    mockRpcResults.group_picks = { status: 'ok', effective_member_count: 3, picks: [] };
    await openResults();
    expect(await screen.findByText('Nothing to pick yet')).toBeTruthy();
  });
});

describe('filters', () => {
  it('narrows client-side without re-running the expensive call', async () => {
    await openResults();
    await screen.findByText('Game Night (2018)');
    expect(mockRpc).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText('Filters'));
    await screen.findByText('Comedy');
    await fireEvent.press(screen.getByText('Comedy'));
    await fireEvent.press(screen.getByText('Apply'));

    await waitFor(() => expect(screen.queryByText('The Menu (2022)')).toBeNull());
    expect(screen.getByText('Game Night (2018)')).toBeTruthy();
    expect(screen.getByText('Palm Springs (2019)')).toBeTruthy();
    expect(screen.getByText('2 picks')).toBeTruthy();
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('shows the few that match rather than padding past a filter', async () => {
    await openResults();
    await screen.findByText('Game Night (2018)');
    await fireEvent.press(screen.getByText('Filters'));
    await screen.findByText('Horror');
    await fireEvent.press(screen.getByText('Horror'));
    await fireEvent.press(screen.getByText('Apply'));

    await waitFor(() => expect(screen.getByText('1 pick')).toBeTruthy());
    expect(screen.getByText('The Menu (2022)')).toBeTruthy();
    expect(screen.queryByText('Game Night (2018)')).toBeNull();
  });

  it('shows the filter empty state with a way back', async () => {
    await openResults();
    await screen.findByText('Game Night (2018)');
    await fireEvent.press(screen.getByText('Filters'));
    await screen.findByText('Comedy');
    await fireEvent.press(screen.getByText('Comedy'));
    await fireEvent.press(screen.getByText('2020s'));
    await fireEvent.press(screen.getByText('Apply'));

    expect(await screen.findByText('Nothing matches your filters')).toBeTruthy();
    const clears = screen.getAllByText('Clear all');
    await fireEvent.press(clears[clears.length - 1]!);
    expect(await screen.findByText('Game Night (2018)')).toBeTruthy();
  });
});

describe('analytics', () => {
  it('emits one generation event carrying counts and never a person', async () => {
    await openResults();
    await screen.findByText('Game Night (2018)');

    await waitFor(() => {
      const generated = mockTrack.mock.calls
        .map(([event]) => event as { name: string; props?: Record<string, unknown> })
        .filter((event) => event.name === 'group_picks_generated');
      expect(generated).toHaveLength(1);
      expect(generated[0]!.props).toEqual({
        group_size: 3,
        result_count: 4,
        source_mix: 'saved:1|group:1|rewatch:1|trending:1',
        filter_count: 0,
      });
    });
  });

  it('does not emit a second generation when filters change', async () => {
    await openResults();
    await screen.findByText('Game Night (2018)');
    await fireEvent.press(screen.getByText('Filters'));
    await screen.findByText('Comedy');
    await fireEvent.press(screen.getByText('Comedy'));
    await fireEvent.press(screen.getByText('Apply'));
    await waitFor(() => expect(screen.queryByText('The Menu (2022)')).toBeNull());

    const generated = mockTrack.mock.calls
      .map(([event]) => event as { name: string })
      .filter((event) => event.name === 'group_picks_generated');
    expect(generated).toHaveLength(1);
  });

  it('emits the position, and only the position, when a row is opened', async () => {
    await openResults();
    await fireEvent.press(await screen.findByText('Palm Springs (2019)'));

    const opened = mockTrack.mock.calls
      .map(([event]) => event as { name: string; props?: Record<string, unknown> })
      .find((event) => event.name === 'group_picks_result_opened');
    expect(opened?.props).toEqual({ position: 3 });
  });

  it('never lets a member id or name into any event', async () => {
    await openResults();
    await screen.findByText('Game Night (2018)');
    await fireEvent.press(screen.getByText('Game Night (2018)'));

    const raw = JSON.stringify(mockTrack.mock.calls);
    for (const leak of ['u-abby', 'u-john', 'viewer-1', 'Abby', 'abby', 'John']) {
      expect(raw).not.toContain(leak);
    }
  });
});

describe('the group is ephemeral', () => {
  it('forgets everything when the sheet closes and reopens', async () => {
    const first = await openResults();
    await screen.findByText('Game Night (2018)');
    screen.unmount();

    await renderWithProviders(<GroupPicksSheet {...first} />);
    expect(await screen.findByText("Who's watching?")).toBeTruthy();
    const abby = await screen.findByLabelText('Abby, @abby');
    expect(abby.props.accessibilityState.checked).toBe(false);
  });
});
