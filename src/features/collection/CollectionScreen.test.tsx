import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import CollectionScreen from '../../../app/(tabs)/collection';

/**
 * **The Unranked tab belongs to the category you are looking at.**
 *
 * The founder found this on the device: Movies showed an Unranked tab because a *TV
 * season* had not been ranked. The tab was drawn from `loggedSummary.unranked.length`,
 * which spans the whole collection, while the list underneath has always filtered by
 * medium — so the tab appeared on the wrong side and opened an empty list.
 *
 * These are the four combinations plus the case that made it a state bug rather than a
 * display one: switching category while standing on Unranked.
 */

const mockTables: Record<string, unknown[]> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: mockTables[table] ?? [], error: null }).then(resolve),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

/** The nudge reads a preference on mount; it is not what these tests are about. */
jest.mock('@/lib/prefs', () => ({
  readPref: () => Promise.resolve(null),
  writePref: () => Promise.resolve(),
}));

const watched = (id: string, kind: 'movie' | 'season') => ({
  media_item_id: id,
  bucket: null,
  watched_on: null,
  media_items: {
    kind,
    title: kind === 'movie' ? `Film ${id}` : 'Season 1',
    season_number: kind === 'season' ? 1 : null,
    release_date: '2020-01-01',
    poster_path: null,
    genres: [],
    runtime_minutes: 100,
    original_language: 'en',
    parent: kind === 'season' ? { title: 'A Show' } : null,
  },
});

const ranked = (id: string, category: 'movies' | 'tv_seasons') => ({
  media_item_id: id,
  bucket: 'loved',
  position: 1,
  category,
  media_items: watched(id, category === 'movies' ? 'movie' : 'season').media_items,
});

beforeEach(() => {
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  mockTables.user_media = [];
  // Nothing is ranked in any of these: `rankings` is what turns a logged title into a
  // ranked one, and an empty table is what makes every logged row unranked.
  mockTables.rankings = [];
  mockTables.watchlist = [];
});

const open = async () => {
  const view = await renderWithProviders(<CollectionScreen />);
  await waitFor(() => expect(view.getByRole('tab', { name: 'Watched' })).toBeTruthy());
  return view;
};

const tab = (view: Awaited<ReturnType<typeof open>>, name: string) =>
  view.queryByRole('tab', { name });

/** The category control is a dropdown: open it, then choose. */
const switchTo = async (
  view: Awaited<ReturnType<typeof open>>,
  medium: 'Movies' | 'TV seasons',
) => {
  await fireEvent.press(view.getByLabelText(/^Showing /));
  await fireEvent.press(view.getByRole('button', { name: medium }));
};

describe('the Unranked tab', () => {
  it('does not appear on Movies because a TV season is unranked', async () => {
    // The founder's bug, exactly.
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(tab(view, 'Unranked')).toBeNull());
    expect(tab(view, 'Watched')).toBeTruthy();
    expect(tab(view, 'Watchlist')).toBeTruthy();
  });

  it('does appear on TV when that season is the unranked one', async () => {
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();
    await switchTo(view, 'TV seasons');

    await waitFor(() => expect(tab(view, 'Unranked')).toBeTruthy());
  });

  it('does not appear on TV because a movie is unranked', async () => {
    // The mirror of the founder's bug, which the same fix has to cover.
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();
    await switchTo(view, 'TV seasons');

    await waitFor(() => expect(tab(view, 'Unranked')).toBeNull());
  });

  it('appears on Movies when the unranked title is a film', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(tab(view, 'Unranked')).toBeTruthy());
  });

  it('appears on both sides when both have something unranked', async () => {
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(tab(view, 'Unranked')).toBeTruthy());
    await switchTo(view, 'TV seasons');
    await waitFor(() => expect(tab(view, 'Unranked')).toBeTruthy());
  });

  it('appears on neither when everything is ranked', async () => {
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    // Two reads share this table — the id list that decides what is unranked, and the
    // ranked collection the Watched list draws — so the rows carry a full ranking.
    mockTables.rankings = [ranked('m1', 'movies'), ranked('s1', 'tv_seasons')];
    const view = await open();

    await waitFor(() => expect(tab(view, 'Watched')).toBeTruthy());
    expect(tab(view, 'Unranked')).toBeNull();
    await switchTo(view, 'TV seasons');
    await waitFor(() => expect(tab(view, 'Unranked')).toBeNull());
  });
});

describe('switching category while standing on Unranked', () => {
  const selected = (view: Awaited<ReturnType<typeof open>>, name: string) =>
    Boolean(view.getByRole('tab', { name }).props.accessibilityState?.selected);

  it('falls back to Watched rather than leaving a tab that is not there', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(tab(view, 'Unranked')).toBeTruthy());
    await fireEvent.press(view.getByRole('tab', { name: 'Unranked' }));
    await waitFor(() => expect(selected(view, 'Unranked')).toBe(true));

    await switchTo(view, 'TV seasons');

    // The tab is gone and the reader is on Watched, in the same render — not on a
    // hidden segment showing an empty list.
    await waitFor(() => expect(tab(view, 'Unranked')).toBeNull());
    expect(selected(view, 'Watched')).toBe(true);
  });

  it('does not silently put them back on Unranked when they return', async () => {
    // The reason the fallback also clears the stored segment. Coming back to Movies
    // after choosing nothing should not resume a tab they were moved off.
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await fireEvent.press(view.getByRole('tab', { name: 'Unranked' }));
    await waitFor(() => expect(selected(view, 'Unranked')).toBe(true));

    await switchTo(view, 'TV seasons');
    await waitFor(() => expect(selected(view, 'Watched')).toBe(true));

    await switchTo(view, 'Movies');

    await waitFor(() => expect(tab(view, 'Unranked')).toBeTruthy());
    expect(selected(view, 'Watched')).toBe(true);
  });

  it('keeps them on Unranked when the other category has some too', async () => {
    // The fallback is for a tab that disappears, not a rule that switching resets.
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    const view = await open();

    await fireEvent.press(view.getByRole('tab', { name: 'Unranked' }));
    await waitFor(() => expect(selected(view, 'Unranked')).toBe(true));

    await switchTo(view, 'TV seasons');

    await waitFor(() => expect(selected(view, 'Unranked')).toBe(true));
  });
});
