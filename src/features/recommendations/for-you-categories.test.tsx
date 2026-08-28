import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

/**
 * **One selector, three categories** — the founder's final call on For You.
 *
 * People shipped as a `SegmentedControl` above the category dropdown, which left the
 * screen asking its one question twice: a Titles/People strip, and under it a
 * Movies/TV shows control that only meant anything on one side of the strip. Two
 * selectors stacked in a header is a reader working out which one owns which, so People
 * is now a third option in the control that was already there.
 *
 * What is asserted here is the shape of that control and the two things the change could
 * plausibly have broken: that People still draws the discovery lists and none of the
 * title-only chrome, and that a visit to People does not throw away the filter or the
 * Sent to you state the reader had set on the title side.
 *
 * `useForYou` is stood in for, as `SentToYou.test.tsx` does — the engine is not what
 * this file is about, and `for-you-stability.test.tsx` is the file that exercises the
 * real query.
 */

const mockPush = jest.fn();
const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      return Promise.resolve({ data: mockRpcResults[name] ?? null, error: null });
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
}));

jest.mock('expo-router', () => ({
  useFocusEffect: () => {},
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

/**
 * One title on the wall and two genres in the pool, which is everything these tests ask
 * of the engine: something to see in the title modes, and something for the filter sheet
 * to offer.
 */
const poolItem = (id: string, title: string, genre: string) => ({
  mediaItemId: id,
  title,
  seriesTitle: null,
  kind: 'movie',
  year: 2010,
  posterPath: null,
  genres: [genre],
  language: 'en',
  runtimeMinutes: null,
  score: null,
  bucket: null,
  watchedOn: null,
});

const mockSlate = {
  items: [{ mediaItemId: 'film-1', title: 'Inception', year: 2010, posterPath: null }],
  candidatePool: [poolItem('pool-1', 'A Comedy', 'Comedy'), poolItem('pool-2', 'A Horror', 'Horror')],
  anchorsUsed: 0,
  lowData: true,
  taste: null,
};

jest.mock('@/features/recommendations/use-for-you', () => ({
  useForYou: () => ({
    data: mockSlate,
    isPending: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

const person = (over: Record<string, unknown> = {}) => ({
  user_id: 'anna-id',
  username: 'anna',
  display_name: 'Anna',
  avatar_path: null,
  visibility: 'public',
  ...over,
});

const recommendation = () => ({
  id: 'r1',
  sender_id: 'user-2',
  sender_username: 'ada',
  sender_display_name: 'Ada',
  sender_avatar_path: null,
  media_item_id: 'film-9',
  media_kind: 'movie',
  media_title: 'Heat',
  series_title: null,
  poster_path: null,
  release_date: '1995-12-15',
  genres: ['Comedy'],
  original_language: 'en',
  runtime_minutes: 170,
  recommended_at: '2026-08-15T10:00:00.000Z',
  opened_at: null,
});

const open = async () => {
  const view = await renderWithProviders(<RecommendationsScreen />);
  await waitFor(() => expect(view.getByLabelText(/^Showing /)).toBeTruthy());
  return view;
};

/** The category control is a dropdown: open it, then choose — as Collection's is. */
const choose = async (view: Awaited<ReturnType<typeof open>>, category: string) => {
  await fireEvent.press(view.getByLabelText(/^Showing /));
  await fireEvent.press(view.getByRole('button', { name: new RegExp(`^${category}`) }));
};

/** What the trigger says it is showing, which is the only place the choice is stated. */
const showing = (view: Awaited<ReturnType<typeof open>>) =>
  view.getByLabelText(/^Showing /).props.accessibilityLabel;

beforeEach(() => {
  mockPush.mockReset();
  mockRpc.mockReset();
  mockRpcResults = {
    my_notifications: [],
    recommendations_to_me: [],
    recommendation_requests: { total: 0, senders: [] },
    people_mutuals: [],
    people_taste_matches: [],
  };
});

describe('the one selector', () => {
  /**
   * The removed control, asserted by its absence in three ways: the word, the group
   * label it wore, and the role. `SegmentedControl` is a `radiogroup` of `radio`s, so a
   * screen with no radio on it cannot have grown a second copy of it under another name.
   */
  it('offers no Titles/People strip beside the category control', async () => {
    const view = await open();

    expect(view.queryByText('Titles')).toBeNull();
    expect(view.queryByLabelText('What to look at')).toBeNull();
    expect(view.queryAllByRole('radio')).toHaveLength(0);
  });

  it('offers Movies, TV shows and People, and nothing else', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText(/^Showing /));

    // Matched at the start rather than exactly: the chosen option carries a checkmark,
    // and the glyph is a `Text` node that lands in the accessible name behind the label.
    expect(view.getByRole('button', { name: /^Movies/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /^TV shows/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /^People/ })).toBeTruthy();
    // The For You override. Collection lists the rankable unit, which is the season;
    // this wall holds series, and calling them seasons here would name something that is
    // not on screen.
    expect(view.queryByRole('button', { name: /^TV seasons/ })).toBeNull();
  });

  it('opens on Movies and says which one it is showing', async () => {
    const view = await open();

    expect(showing(view)).toBe('Showing Movies');
  });
});

describe('People', () => {
  it('draws the discovery modes', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 3, mutual_names: ['Ben'] })];
    mockRpcResults.people_taste_matches = [
      person({ user_id: 'bo-id', username: 'bo', display_name: 'Bo', match_score: 91 }),
    ];

    const view = await open();
    await choose(view, 'People');

    // The two discovery modes as chips — Mutuals showing, Matches one press away.
    await waitFor(() => expect(view.getByText('Ben + 2 more')).toBeTruthy());
    expect(view.getByText('Matches')).toBeTruthy();
    expect(showing(view)).toBe('Showing People');
  });

  /**
   * A chip that narrows a wall of films, over a list of people, would be a control with
   * nothing to act on. All four sit inside the title branch, so this is really an
   * assertion that the branch is drawn from the selector and not from something that can
   * drift away from it.
   */
  it('draws none of the title-only controls', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 3, mutual_names: ['Ben'] })];
    mockRpcResults.recommendations_to_me = [recommendation()];

    const view = await open();
    await waitFor(() => expect(view.getByText(/^Sent to you/)).toBeTruthy());
    await choose(view, 'People');

    await waitFor(() => expect(view.getByText('Ben + 2 more')).toBeTruthy());
    expect(view.queryByText(/^Sent to you/)).toBeNull();
    expect(view.queryByText(/^Filters/)).toBeNull();
    expect(view.queryByText('Refresh')).toBeNull();
    expect(view.queryByText('Clear all')).toBeNull();
    // The wall itself, which is the largest thing that would otherwise be left under a
    // heading that says Mutuals.
    expect(view.queryByLabelText(/^Save Inception to watchlist$/)).toBeNull();
  });
});

describe('the title categories', () => {
  it('still draws the wall and the filter row on Movies', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByLabelText(/^Save Inception to watchlist$/)).toBeTruthy());
    expect(view.getByText(/^Sent to you/)).toBeTruthy();
    expect(view.getByText('Filters')).toBeTruthy();

  });

  it('still draws them on TV shows', async () => {
    const view = await open();
    await choose(view, 'TV shows');

    await waitFor(() => expect(showing(view)).toBe('Showing TV shows'));
    expect(view.getByLabelText(/^Save Inception to watchlist$/)).toBeTruthy();
    expect(view.getByText(/^Sent to you/)).toBeTruthy();
    expect(view.getByText('Filters')).toBeTruthy();

  });
});

/**
 * **A look at People is not a reset.**
 *
 * The reader's filters and their Sent to you chip are state of the screen rather than of
 * the wall, so a category that has neither must leave both alone — a filter that has to
 * be set again after every glance at a suggestion list is one nobody sets twice.
 */
describe('coming back from People', () => {
  it('keeps an applied filter', async () => {
    const view = await open();

    await fireEvent.press(view.getByText('Filters'));
    await waitFor(() => expect(view.getByText('Comedy')).toBeTruthy());
    await fireEvent.press(view.getByText('Comedy'));
    await fireEvent.press(view.getByText('Apply'));
    await waitFor(() => expect(view.getByText('Filters · 1')).toBeTruthy());

    await choose(view, 'People');
    await waitFor(() => expect(view.queryByText('Filters · 1')).toBeNull());
    await choose(view, 'Movies');

    await waitFor(() => expect(view.getByText('Filters · 1')).toBeTruthy());
  });

  it('keeps Sent to you turned on', async () => {
    mockRpcResults.recommendations_to_me = [recommendation()];
    const view = await open();

    await fireEvent.press(view.getByText(/^Sent to you/));
    await waitFor(() => expect(view.getByText('Heat (1995)')).toBeTruthy());

    await choose(view, 'People');
    await waitFor(() => expect(view.queryByText('Heat (1995)')).toBeNull());
    await choose(view, 'Movies');

    // Still the list rather than the wall, which is what the chip being on means.
    await waitFor(() => expect(view.getByText('Heat (1995)')).toBeTruthy());
  });
});
