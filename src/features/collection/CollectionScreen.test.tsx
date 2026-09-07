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
/** Tables whose read fails, and a counter proving a retry re-issued the request. */
const mockFailing = new Set<string>();
const mockReads: Record<string, number> = {};

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
        then: (resolve: (value: unknown) => unknown) => {
          mockReads[table] = (mockReads[table] ?? 0) + 1;
          return Promise.resolve(
            mockFailing.has(table)
              ? { data: null, error: { code: '08006', message: 'connection failure' } }
              : { data: mockTables[table] ?? [], error: null },
          ).then(resolve);
        },
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

/** Mutable so a test can arrive with `?medium=` the way See all does. */
const mockParams: { medium?: string } = {};

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

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
 * A real store rather than a stub that always answers null.
 *
 * Two things on this screen persist locally — the remembered Movies/TV side and the
 * unranked card's dismissal — and both are only worth anything across a restart, which
 * is what a store you can seed and then read back lets a test express. Named `mock…`
 * because `jest.mock` is hoisted above every other binding in the file and that prefix
 * is what makes a reference out of the factory legal.
 */
const mockPrefStore: Record<string, unknown> = {};
const mockPrefWrites: { name: string; value: unknown }[] = [];

/** Keys whose read rejects, so a store failure is expressible rather than only absence. */
const mockPrefFailing = new Set<string>();

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) =>
    mockPrefFailing.has(name)
      ? Promise.reject(new Error('store unavailable'))
      : Promise.resolve(mockPrefStore[name] ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefWrites.push({ name, value });
    mockPrefStore[name] = value;
    return Promise.resolve();
  },
}));

const MEDIUM_KEY = 'user-1.collection.medium';
const VIEW_MODE_KEY = 'user-1.collection.view-mode';
const NUDGE_KEY = 'user-1.collection.unranked-nudge';

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
  mockProfile.id = 'user-1';
  delete mockParams.medium;
  for (const key of Object.keys(mockPrefStore)) delete mockPrefStore[key];
  mockPrefWrites.length = 0;
  mockPrefFailing.clear();
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  mockTables.user_media = [];
  // Nothing is ranked in any of these: `rankings` is what turns a logged title into a
  // ranked one, and an empty table is what makes every logged row unranked.
  mockTables.rankings = [];
  mockTables.watchlist = [];
  mockFailing.clear();
  for (const key of Object.keys(mockReads)) delete mockReads[key];
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
  medium: 'Movies' | 'TV',
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
    await switchTo(view, 'TV');

    await waitFor(() => expect(tab(view, 'Unranked')).toBeTruthy());
  });

  it('does not appear on TV because a movie is unranked', async () => {
    // The mirror of the founder's bug, which the same fix has to cover.
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();
    await switchTo(view, 'TV');

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
    await switchTo(view, 'TV');
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
    await switchTo(view, 'TV');
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

    await switchTo(view, 'TV');

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

    await switchTo(view, 'TV');
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

    await switchTo(view, 'TV');

    await waitFor(() => expect(selected(view, 'Unranked')).toBe(true));
  });
});

/**
 * **Collection reopens where the reader left it.**
 *
 * A TV-heavy reader was landing on Movies every single time and switching across by
 * hand, which is a tax that grows with how much someone uses the app. Movies stays the
 * first-ever default — a new account has no habit to remember — and after that the side
 * is remembered locally, per account.
 */
describe('the remembered category', () => {
  const showing = (view: Awaited<ReturnType<typeof open>>) =>
    view.getByLabelText(/^Showing /).props.accessibilityLabel;

  it('opens on Movies when this account has never chosen', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    expect(showing(view)).toBe('Showing Movies');
  });

  it('reopens on TV when that is where the reader last was', async () => {
    mockPrefStore[MEDIUM_KEY] = 'tv_seasons';
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('Showing TV'));
  });

  it('records the switch, so the next launch starts there', async () => {
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();

    await switchTo(view, 'TV');

    await waitFor(() =>
      expect(mockPrefWrites).toContainEqual({ name: MEDIUM_KEY, value: 'tv_seasons' }),
    );
  });

  /**
   * **See all carries the side it was pressed under** (Codex review of 2026-08-29).
   *
   * The control computes Movies or TV from the wall the reader is looking at, and the
   * own-profile route sends them here. Without the param that choice was dropped and the
   * device habit answered instead — tap See all under Movies, arrive on TV.
   */
  it('opens on the side a navigation asked for', async () => {
    mockParams.medium = 'tv_seasons';
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('Showing TV'));
  });

  /**
   * The precedence that matters: the stored preference is read asynchronously and would
   * otherwise land a moment later and overrule the control the reader just pressed. The
   * param sets `chosenMedium`, which is the same guard a tap on the selector sets.
   */
  it('is not overruled by the remembered side landing afterwards', async () => {
    mockPrefStore[MEDIUM_KEY] = 'movies';
    mockParams.medium = 'tv_seasons';
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('Showing TV'));
    // And still TV after the preference read has certainly resolved.
    await waitFor(() => expect(showing(view)).toBe('Showing TV'));
  });

  /** Arriving from a control is a choice about this visit, not a new device habit. */
  it('does not rewrite the remembered side just because it was navigated to', async () => {
    mockParams.medium = 'tv_seasons';
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('Showing TV'));
    expect(mockPrefWrites).not.toContainEqual({ name: MEDIUM_KEY, value: 'tv_seasons' });
  });

  /** A stale or hand-typed link must not put the selector in a state it cannot draw. */
  it('ignores a medium it has no tab for', async () => {
    mockParams.medium = 'books';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    expect(showing(view)).toBe('Showing Movies');
  });

  it('goes back to Movies when the reader does, rather than remembering only TV', async () => {
    mockPrefStore[MEDIUM_KEY] = 'tv_seasons';
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('Showing TV'));
    await switchTo(view, 'Movies');

    await waitFor(() =>
      expect(mockPrefWrites).toContainEqual({ name: MEDIUM_KEY, value: 'movies' }),
    );
    expect(showing(view)).toBe('Showing Movies');
  });


  /** A key left by an older build must not put the selector in a state it cannot draw. */
  it('ignores a stored value that is not a category', async () => {
    mockPrefStore[MEDIUM_KEY] = 'tv';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    expect(showing(view)).toBe('Showing Movies');
  });

  /**
   * Found by independent review of this change, 2026-08-23.
   *
   * The preference is per account, and the screen is not guaranteed to unmount between
   * two of them. Without the reset in the effect, a reader who had touched the selector
   * left `chosenMedium` true, and the next account's stored side was then discarded as
   * though *they* had just tapped the control — so one person's habit silently became
   * another person's default.
   */
  it('reads the incoming account\u2019s own side, even after the outgoing one touched the control', async () => {
    // The two accounts must want *different* sides, or this passes on the default alone.
    mockPrefStore['user-1.collection.medium'] = 'movies';
    mockPrefStore['user-2.collection.medium'] = 'tv_seasons';
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];

    const view = await open();
    // Touching the control is what used to poison the switch: it latched "the reader has
    // chosen", and the next account's stored side was then thrown away as their choice.
    await switchTo(view, 'TV');
    await switchTo(view, 'Movies');

    mockProfile.id = 'user-2';
    await view.rerender(<CollectionScreen />);

    await waitFor(() => expect(showing(view)).toBe('Showing TV'));
  });

  it('falls back to Movies for a next account that has no stored side', async () => {
    mockPrefStore['user-1.collection.medium'] = 'tv_seasons';
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];

    const view = await open();
    await waitFor(() => expect(showing(view)).toBe('Showing TV'));

    mockProfile.id = 'user-3';
    await view.rerender(<CollectionScreen />);

    await waitFor(() => expect(showing(view)).toBe('Showing Movies'));
  });
});

/**
 * **The unranked card says what it is about.**
 *
 * "Rank a few more and your recommendations get sharper" was true of the app in general
 * and so said nothing about this reader — it read as an advert rather than as a state of
 * their collection. It is only ever drawn when this side of the selector genuinely holds
 * unranked titles, so it can say so.
 */
/**
 * Poster and List — the founder's §11 change, and the properties it turns on.
 *
 * **Poster is the unset default**, not a value written on first mount. A screen that
 * saved its own default could never change that default again for anybody who had opened
 * Collection once, and the assertion that nothing is written until the reader chooses is
 * the only way to hold that shut.
 *
 * **The choice survives a relaunch**, which is the whole point and is simulated by
 * seeding the store and mounting fresh — the same shape `the remembered category` uses,
 * because it is the same mechanism.
 *
 * **It does not leak between accounts.** The mode lives inside `viewState`, which is not
 * tagged with the account it was read for the way `mediumPref` is, so the read has to
 * resolve a *miss* as well as a hit. Without that, one person's List became the next
 * person's default on the same device.
 */
describe('the remembered view mode', () => {
  const modeOf = (view: Awaited<ReturnType<typeof open>>) =>
    view.getByLabelText('Poster view').props.accessibilityState?.selected ? 'poster' : 'list';

  const choose = (view: Awaited<ReturnType<typeof open>>, mode: 'Poster' | 'List') =>
    fireEvent.press(view.getByLabelText(`${mode} view`));

  it('opens on Poster when this device has never chosen', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(modeOf(view)).toBe('poster'));
  });

  it('writes nothing until the reader actually chooses', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    await open();

    expect(mockPrefWrites.filter((write) => write.name === VIEW_MODE_KEY)).toEqual([]);
  });

  it('records List when the reader picks it', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await choose(view, 'List');

    await waitFor(() =>
      expect(mockPrefWrites).toContainEqual({ name: VIEW_MODE_KEY, value: 'list' }),
    );
    expect(modeOf(view)).toBe('list');
  });

  it('reopens on List after a relaunch', async () => {
    mockPrefStore[VIEW_MODE_KEY] = 'list';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(modeOf(view)).toBe('list'));
  });

  it('records Poster again when the reader switches back', async () => {
    mockPrefStore[VIEW_MODE_KEY] = 'list';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(modeOf(view)).toBe('list'));
    await choose(view, 'Poster');

    await waitFor(() =>
      expect(mockPrefWrites).toContainEqual({ name: VIEW_MODE_KEY, value: 'poster' }),
    );
    expect(modeOf(view)).toBe('poster');
  });

  it('does not re-save the mode when the reader taps the cell they are already in', async () => {
    // The founder's rule is that choosing List persists List, not that every tap in the
    // control row re-saves whichever mode you happen to be standing in. Without the
    // comparison in `changeView`, a filter or sort change would write too.
    mockPrefStore[VIEW_MODE_KEY] = 'list';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();
    await waitFor(() => expect(modeOf(view)).toBe('list'));
    mockPrefWrites.length = 0;

    await choose(view, 'List');

    expect(mockPrefWrites.filter((write) => write.name === VIEW_MODE_KEY)).toEqual([]);
  });

  it('ignores a stored value the control has no cell for', async () => {
    // Including `wall`, which is what the build before this tranche called Poster.
    mockPrefStore[VIEW_MODE_KEY] = 'wall';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(modeOf(view)).toBe('poster'));
  });

  it('gives a second account the Poster default rather than the first one’s List', async () => {
    mockPrefStore[VIEW_MODE_KEY] = 'list';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();
    await waitFor(() => expect(modeOf(view)).toBe('list'));

    mockProfile.id = 'user-2';
    const second = await open();

    await waitFor(() => expect(modeOf(second)).toBe('poster'));
  });

  /**
   * Independent review's finding: the read's `.catch` swallowed the error and left
   * whatever mode was already there.
   *
   * That is the same cross-account leak the miss branch exists to close, reached by the
   * one path that skipped it — and it is the worse version, because a failed read never
   * resolves later. A store that refuses should cost the reader their preference, not
   * hand them the previous account's.
   */
  it('falls back to Poster when the preference read fails, rather than keeping the last mode', async () => {
    mockPrefStore[VIEW_MODE_KEY] = 'list';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();
    await waitFor(() => expect(modeOf(view)).toBe('list'));

    mockProfile.id = 'user-2';
    mockPrefFailing.add('user-2.collection.view-mode');
    const second = await open();

    await waitFor(() => expect(modeOf(second)).toBe('poster'));
  });

  it('does not corrupt the collection it is drawing', async () => {
    // A view mode is a way of drawing one list. The same titles must be present in both,
    // which is the assertion that would fail if the toggle had been wired to a filter.
    mockTables.user_media = [watched('m1', 'movie'), watched('m2', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByText('2 titles')).toBeTruthy());
    await choose(view, 'List');
    await waitFor(() => expect(view.getByText('2 titles')).toBeTruthy());
  });
});

describe('the unranked card', () => {
  it('names the unranked titles it is about', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByText('You have unranked titles')).toBeTruthy());
    expect(
      view.getByText(
        'Rank what you have watched to complete your Collection and improve your recommendations.',
      ),
    ).toBeTruthy();
  });

  /**
   * **Both answers in one place.** The card used to put its copy down the left and an
   * X at the far right edge, so the two things a reader could do about it sat as far
   * apart as the card allowed and only one of them looked like a control.
   */
  it('offers Rank and Not now together, as a pair', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByRole('button', { name: 'Rank' })).toBeTruthy());
    const rank = view.getByRole('button', { name: 'Rank' });
    const notNow = view.getByRole('button', { name: 'Not now' });
    // Same parent, so they are one action area rather than two opposite corners.
    expect(rank.parent).toBe(notNow.parent);
  });

  it('offers one dismissal, not two', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByText('You have unranked titles')).toBeTruthy());
    expect(view.queryByLabelText('Dismiss')).toBeNull();
    expect(view.getByRole('button', { name: 'Not now' })).toBeTruthy();
  });

  it('opens the Unranked tab from Rank', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByRole('button', { name: 'Rank' })).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Rank' }));

    await waitFor(() =>
      expect(tab(view, 'Unranked')?.props.accessibilityState.selected).toBe(true),
    );
  });

  it('stays away when this side of the selector has nothing unranked', async () => {
    // The season is unranked; Movies is not what the card is about.
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(tab(view, 'Unranked')).toBeNull());
    expect(view.queryByText('You have unranked titles')).toBeNull();
  });

  it('is dismissed by the X, and records the dismissal', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByText('You have unranked titles')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(view.queryByText('You have unranked titles')).toBeNull());
    expect(mockPrefWrites.map((write) => write.name)).toContain(NUDGE_KEY);
  });

  /**
   * Dismissing the card is not dismissing the work. The tab is drawn from the collection
   * rather than from the preference, so the state stays reachable either way — which is
   * what makes hiding the card a safe thing to offer.
   */
  it('leaves the Unranked tab standing after the card is dismissed', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByText('You have unranked titles')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(view.queryByText('You have unranked titles')).toBeNull());
    expect(tab(view, 'Unranked')).toBeTruthy();
  });

  it('stays dismissed on the next launch, rather than returning immediately', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const first = await open();
    await waitFor(() => expect(first.getByText('You have unranked titles')).toBeTruthy());
    await fireEvent.press(first.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(first.queryByText('You have unranked titles')).toBeNull());

    // Same store, fresh mount: the dismissal was written, so it survives.
    const second = await open();
    await waitFor(() => expect(tab(second, 'Unranked')).toBeTruthy());
    expect(second.queryByText('You have unranked titles')).toBeNull();
  });
});

/**
 * **A Collection that failed to load could not be asked again.**
 *
 * The three panes each render `EmptyState kind="couldNotLoad"` on error, which is the
 * right half of the contract — the reader is told, rather than shown an empty collection
 * that isn't theirs. What was missing was anything to press: no retry action, and this
 * screen has no pull-to-refresh either, so a read that failed once stayed failed until the
 * app was killed. On the founder's build 4 that is indistinguishable from the app being
 * broken.
 */
describe('when a collection read fails', () => {
  it('offers a retry rather than a dead end', async () => {
    mockFailing.add('rankings');

    const view = await renderWithProviders(<CollectionScreen />);

    await waitFor(() => expect(view.getByText('Could not load')).toBeTruthy());
    expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('re-issues the request that failed, and recovers', async () => {
    mockFailing.add('rankings');

    const view = await renderWithProviders(<CollectionScreen />);
    await waitFor(() => expect(view.getByText('Could not load')).toBeTruthy());

    const before = mockReads.rankings ?? 0;
    mockFailing.clear();
    await fireEvent.press(view.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(mockReads.rankings ?? 0).toBeGreaterThan(before));
    await waitFor(() => expect(view.queryByText('Could not load')).toBeNull());
  });

  /**
   * The distinction the fix must not blur: an empty collection is a fact about the
   * account and is still drawn as one.
   */
  it('still tells an empty collection apart from a broken one', async () => {
    const view = await renderWithProviders(<CollectionScreen />);

    await waitFor(() => expect(view.queryByText('Could not load')).toBeNull());
  });
});
