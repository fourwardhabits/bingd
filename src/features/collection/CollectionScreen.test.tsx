import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { fontFamily, theme } from '@/ui/tokens';

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
/** How long a table's read takes to answer, in ms: a slow server, for the open-menu race. */
const mockDelayMs: Record<string, number> = {};
/**
 * RPC answers by function name. Unset answers null, which the backlog and Refine reads
 * parse as `disabled` — the flags-off world every test before the unified design assumes.
 */
const mockRpcAnswers: Record<string, unknown> = {};
/** Every RPC this screen made, by name, so an absence can be gated on the read happening. */
const mockRpcCalls: string[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string) => {
      mockRpcCalls.push(fn);
      return Promise.resolve({ data: mockRpcAnswers[fn] ?? null, error: null });
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (resolve: (value: unknown) => unknown) => {
          mockReads[table] = (mockReads[table] ?? 0) + 1;
          const answer = () =>
            mockFailing.has(table)
              ? { data: null, error: { code: '08006', message: 'connection failure' } }
              : { data: mockTables[table] ?? [], error: null };
          const delay = mockDelayMs[table] ?? 0;
          return (
            delay > 0
              ? new Promise((done) => setTimeout(() => done(answer()), delay))
              : Promise.resolve(answer())
          ).then(resolve);
        },
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

/** Mutable so a test can arrive with `?medium=` the way See all does. */
const mockParams: { medium?: string; show?: string } = {};
const mockSetParams = jest.fn();
/** Stable, so a navigation this screen makes can actually be asserted. */
const mockPush = jest.fn();

/** See the `useNavigation` stand-in below. */
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
  // The tab bar, captured rather than mounted: the screen subscribes to its navigator's
  // `tabPress`, and `pressTab` calls what it subscribed with, which is exactly what React
  // Navigation does with it. `focused` is mutable because "already-selected" is the whole
  // of the contract.
  useNavigation: () => mockNavigation,
  useRouter: () => ({ push: mockPush, setParams: mockSetParams }),
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
  delete mockParams.show;
  for (const key of Object.keys(mockRpcAnswers)) delete mockRpcAnswers[key];
  mockRpcCalls.length = 0;
  mockSetParams.mockClear();
  mockPush.mockClear();
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
  for (const key of Object.keys(mockDelayMs)) delete mockDelayMs[key];
});

type View = Awaited<ReturnType<typeof renderWithProviders>>;

/**
 * **The page's marquee** (founder, marquee cohesion sprint, 2026-11-07): Watched, Watchlist,
 * and Unranked while this side has an unranked title, as the toolbar's dropdown.
 */
const SEGMENTS = ['Watched', 'Watchlist', 'Unranked'] as const;
const menu = (view: View) => view.getByTestId('collection-mode');

const open = async () => {
  const view = await renderWithProviders(<CollectionScreen />);
  await waitFor(() => expect(menu(view)).toBeTruthy());
  return view;
};

/** Which section the marquee says is showing. */
const shown = (view: View) =>
  SEGMENTS.find((name) => view.queryByTestId('collection-mode-label')?.props.children === name);

/**
 * The sections on offer, in order: the open menu's items, read and then closed again by
 * choosing the one already showing (which changes nothing).
 */
const offered = async (view: View) => {
  await fireEvent.press(menu(view));
  const items = await view.findAllByRole('menuitem');
  const names = items.map((item) => item.props.accessibilityLabel as string);
  const current = items.find((item) => item.props.accessibilityState?.selected);
  if (current) await fireEvent.press(current);
  return SEGMENTS.filter((name) => names.includes(name));
};

/** Choose a section from the marquee's menu. */
const choose = async (view: View, name: (typeof SEGMENTS)[number]) => {
  await fireEvent.press(menu(view));
  await fireEvent.press(await view.findByRole('menuitem', { name }));
};

/** The medium is the Movies | TV switch beside the dropdown. */
const switchTo = async (view: View, medium: 'Movies' | 'TV') => {
  await fireEvent.press(view.getByRole('radio', { name: medium }));
};

/** Which side the switch is on. */
const side = (view: View) =>
  (['Movies', 'TV'] as const).find(
    (name) => view.getByRole('radio', { name }).props.accessibilityState?.selected,
  );

describe('the Unranked tab', () => {
  it('does not appear on Movies because a TV season is unranked', async () => {
    // The founder's bug, exactly.
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();

    await waitFor(async () => expect(await offered(view)).not.toContain('Unranked'));
    expect(await offered(view)).toContain('Watched');
    expect(await offered(view)).toContain('Watchlist');
  });

  it('does appear on TV when that season is the unranked one', async () => {
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();
    await switchTo(view, 'TV');

    await waitFor(async () => expect(await offered(view)).toContain('Unranked'));
  });

  it('does not appear on TV because a movie is unranked', async () => {
    // The mirror of the founder's bug, which the same fix has to cover.
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();
    await switchTo(view, 'TV');

    await waitFor(async () => expect(await offered(view)).not.toContain('Unranked'));
  });

  it('appears on Movies when the unranked title is a film', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(async () => expect(await offered(view)).toContain('Unranked'));
  });

  it('appears on both sides when both have something unranked', async () => {
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    const view = await open();

    await waitFor(async () => expect(await offered(view)).toContain('Unranked'));
    await switchTo(view, 'TV');
    await waitFor(async () => expect(await offered(view)).toContain('Unranked'));
  });

  it('appears on neither when everything is ranked', async () => {
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    // Two reads share this table — the id list that decides what is unranked, and the
    // ranked collection the Watched list draws — so the rows carry a full ranking.
    mockTables.rankings = [ranked('m1', 'movies'), ranked('s1', 'tv_seasons')];
    const view = await open();

    await waitFor(async () => expect(await offered(view)).toContain('Watched'));
    expect(await offered(view)).not.toContain('Unranked');
    await switchTo(view, 'TV');
    await waitFor(async () => expect(await offered(view)).not.toContain('Unranked'));
  });
});

describe('switching category while standing on Unranked', () => {
  const selected = (view: View, name: string) => shown(view) === name;

  it('falls back to Watched rather than leaving a tab that is not there', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(async () => expect(await offered(view)).toContain('Unranked'));
    await choose(view, 'Unranked');
    await waitFor(() => expect(selected(view, 'Unranked')).toBe(true));

    await switchTo(view, 'TV');

    // The tab is gone and the reader is on Watched, in the same render — not on a
    // hidden segment showing an empty list.
    await waitFor(async () => expect(await offered(view)).not.toContain('Unranked'));
    expect(selected(view, 'Watched')).toBe(true);
  });

  it('does not silently put them back on Unranked when they return', async () => {
    // The reason the fallback also clears the stored segment. Coming back to Movies
    // after choosing nothing should not resume a tab they were moved off.
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await choose(view, 'Unranked');
    await waitFor(() => expect(selected(view, 'Unranked')).toBe(true));

    await switchTo(view, 'TV');
    await waitFor(() => expect(selected(view, 'Watched')).toBe(true));

    await switchTo(view, 'Movies');

    await waitFor(async () => expect(await offered(view)).toContain('Unranked'));
    expect(selected(view, 'Watched')).toBe(true);
  });

  it('keeps them on Unranked when the other category has some too', async () => {
    // The fallback is for a tab that disappears, not a rule that switching resets.
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    const view = await open();

    await choose(view, 'Unranked');
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
  const showing = side;

  it('opens on Movies when this account has never chosen', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    expect(showing(view)).toBe('Movies');
  });

  it('reopens on TV when that is where the reader last was', async () => {
    mockPrefStore[MEDIUM_KEY] = 'tv_seasons';
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('TV'));
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
  /**
   * **"Rank imported movies"** (the Letterboxd summary, 2026-09-12) arrives with
   * `show: 'unranked'`: Movies, on Unranked, whatever this tab was left showing.
   */
  it('opens Movies on Unranked when the importer sends somebody to rank', async () => {
    mockPrefStore[MEDIUM_KEY] = 'tv_seasons';
    mockParams.show = 'unranked';
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(shown(view)).toBe('Unranked'));
    expect(showing(view)).toBe('Movies');
    // Consumed, so choosing Watched afterwards is not undone by a param still in the URL.
    expect(mockSetParams).toHaveBeenCalledWith({ show: undefined });
    // And still Movies once the remembered TV side has certainly been read.
    await waitFor(() => expect(showing(view)).toBe('Movies'));
  });

  it('opens on the side a navigation asked for', async () => {
    mockParams.medium = 'tv_seasons';
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('TV'));
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

    await waitFor(() => expect(showing(view)).toBe('TV'));
    // And still TV after the preference read has certainly resolved.
    await waitFor(() => expect(showing(view)).toBe('TV'));
  });

  /** Arriving from a control is a choice about this visit, not a new device habit. */
  it('does not rewrite the remembered side just because it was navigated to', async () => {
    mockParams.medium = 'tv_seasons';
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('TV'));
    expect(mockPrefWrites).not.toContainEqual({ name: MEDIUM_KEY, value: 'tv_seasons' });
  });

  /** A stale or hand-typed link must not put the selector in a state it cannot draw. */
  it('ignores a medium it has no tab for', async () => {
    mockParams.medium = 'books';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    expect(showing(view)).toBe('Movies');
  });

  it('goes back to Movies when the reader does, rather than remembering only TV', async () => {
    mockPrefStore[MEDIUM_KEY] = 'tv_seasons';
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('TV'));
    await switchTo(view, 'Movies');

    await waitFor(() =>
      expect(mockPrefWrites).toContainEqual({ name: MEDIUM_KEY, value: 'movies' }),
    );
    expect(showing(view)).toBe('Movies');
  });


  /** A key left by an older build must not put the selector in a state it cannot draw. */
  it('ignores a stored value that is not a category', async () => {
    mockPrefStore[MEDIUM_KEY] = 'tv';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    expect(showing(view)).toBe('Movies');
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

    await waitFor(() => expect(showing(view)).toBe('TV'));
  });

  it('falls back to Movies for a next account that has no stored side', async () => {
    mockPrefStore['user-1.collection.medium'] = 'tv_seasons';
    mockTables.user_media = [watched('m1', 'movie'), watched('s1', 'season')];

    const view = await open();
    await waitFor(() => expect(showing(view)).toBe('TV'));

    mockProfile.id = 'user-3';
    await view.rerender(<CollectionScreen />);

    await waitFor(() => expect(showing(view)).toBe('Movies'));
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
  it('offers Rank and Dismiss together, as a pair', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByRole('button', { name: 'Rank' })).toBeTruthy());
    const rank = view.getByRole('button', { name: 'Rank' });
    const dismiss = view.getByRole('button', { name: 'Dismiss' });
    // Same parent, so they are one action area rather than two opposite corners.
    expect(rank.parent).toBe(dismiss.parent);
  });

  /**
   * The X was labelled "Dismiss" for screen readers; the pair's second button now says
   * the same thing in words, so there must be exactly one control that answers to it —
   * and the old "Not now" wording is gone from this card.
   */
  it('offers one dismissal, not two', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByText('You have unranked titles')).toBeTruthy());
    expect(view.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
    expect(view.queryByLabelText('Dismiss')).toBeNull();
    expect(view.queryByRole('button', { name: 'Not now' })).toBeNull();
  });

  it('opens the Unranked tab from Rank', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByRole('button', { name: 'Rank' })).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Rank' }));

    await waitFor(() => expect(shown(view)).toBe('Unranked'));
  });

  it('stays away when this side of the selector has nothing unranked', async () => {
    // The season is unranked; Movies is not what the card is about.
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();

    await waitFor(async () => expect(await offered(view)).not.toContain('Unranked'));
    expect(view.queryByText('You have unranked titles')).toBeNull();
  });

  it('is dismissed by Dismiss, records the dismissal, and keeps the Unranked tab', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    await waitFor(() => expect(view.getByText('You have unranked titles')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(view.queryByText('You have unranked titles')).toBeNull());
    expect(mockPrefWrites.map((write) => write.name)).toContain(NUDGE_KEY);
    expect(await offered(view)).toContain('Unranked');
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
    await fireEvent.press(view.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(view.queryByText('You have unranked titles')).toBeNull());
    expect(await offered(view)).toContain('Unranked');
  });

  it('stays dismissed on the next launch, rather than returning immediately', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const first = await open();
    await waitFor(() => expect(first.getByText('You have unranked titles')).toBeTruthy());
    await fireEvent.press(first.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(first.queryByText('You have unranked titles')).toBeNull());

    // Same store, fresh mount: the dismissal was written, so it survives.
    const second = await open();
    await waitFor(async () => expect(await offered(second)).toContain('Unranked'));
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
/**
 * **The marquee's menu stays open when the section under it finishes loading** (2026-11-11).
 *
 * Loading and failed sections used to draw a toolbar of their own, and the list drew
 * another once the titles landed: a Watched ▾ menu opened while Watchlist was still on its
 * way closed by itself when it arrived. Every state is drawn in the one list now
 * (`CollectionView`'s `placeholder`). The watchlist answers 400ms after it is asked.
 */
describe('a section that lands under an open menu', () => {
  // Hidden from assistive tech on purpose (`SkeletonRow`), so asked for explicitly.
  const skeletons = (view: View) =>
    view.queryAllByTestId('skeleton', { includeHiddenElements: true });

  it('leaves the menu open, on the same marquee', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    mockTables.watchlist = [
      { media_item_id: 'w1', created_at: '2026-11-01T00:00:00Z', media_items: watched('w1', 'movie').media_items },
    ];
    mockDelayMs.watchlist = 400;
    const view = await open();
    await waitFor(() => expect(skeletons(view)).toHaveLength(0));

    await choose(view, 'Watchlist');
    await waitFor(() => expect(skeletons(view).length).toBeGreaterThan(0));
    expect(shown(view)).toBe('Watchlist');

    await fireEvent.press(menu(view));
    await view.findByRole('menuitem', { name: 'Watched' });
    expect(skeletons(view).length).toBeGreaterThan(0);

    // The watchlist arrives while the menu is open.
    await waitFor(() => expect(skeletons(view)).toHaveLength(0), {
      timeout: 3000,
    });
    expect(view.getByTestId('collection-count')).toBeTruthy();
    expect(view.getByRole('menuitem', { name: 'Watched' })).toBeTruthy();
    expect(menu(view).props.accessibilityState).toMatchObject({ expanded: true });

    // And the choice still lands.
    await fireEvent.press(view.getByRole('menuitem', { name: 'Watched' }));
    await waitFor(() => expect(shown(view)).toBe('Watched'));
  });

  it('keeps the marquee and the way to the lists while a section loads', async () => {
    mockDelayMs.watchlist = 400;
    const view = await open();
    await choose(view, 'Watchlist');
    await waitFor(() => expect(skeletons(view).length).toBeGreaterThan(0));
    expect(view.getByTestId('collection-toolbar')).toBeTruthy();
    expect(view.getByTestId('collection-my-lists')).toBeTruthy();
    // The tools act on titles, so they wait for some.
    expect(view.queryByTestId('collection-filter-sort')).toBeNull();
  });
});

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

/**
 * **Re-tapping the Collection tab** (founder, physical iOS 1.0.1 build 8).
 *
 * Watchlist and Unranked are segments of this one route, so pressing the tab you are
 * already on had nothing to pop. The root is the Watched list, which is the one segment
 * that is never absent.
 */
describe('re-tapping the Collection tab', () => {
  beforeEach(() => {
    mockTabPress.length = 0;
    mockNavigation.focused = true;
  });

  it('returns to Watched from the Watchlist', async () => {
    const view = await open();
    await choose(view, 'Watchlist');
    await waitFor(() => expect(shown(view)).toBe('Watchlist'));

    await act(async () => pressTab());

    await waitFor(() => expect(shown(view)).toBe('Watched'));
  });

  it('keeps the side the reader is on, which is remembered on purpose', async () => {
    mockTables.user_media = [watched('s1', 'season')];
    const view = await open();
    await switchTo(view, 'TV');
    await choose(view, 'Watchlist');

    await act(async () => pressTab());

    // Movies-or-TV is a device preference the founder asked to keep. Going back to the
    // top of a section is not a reason to change which collection you are looking at.
    await waitFor(() => expect(side(view)).toBe('TV'));
  });

  it('changes nothing when the press arrives from another tab', async () => {
    const view = await open();
    await choose(view, 'Watchlist');

    mockNavigation.focused = false;
    await act(async () => pressTab());

    await waitFor(() => expect(shown(view)).toBe('Watchlist'));
  });
});

/**
 * **Lists, as one labelled secondary link** (founder, UI cohesion pass, 2026-11-06).
 *
 * It was the dropdown's last entry and an inline mode. With the dropdown replaced by
 * Watched | Watchlist | Unranked tabs, Lists is not a fourth tab: it is `My lists ›` at
 * the right of the count row, a push to the screen Profile's manage link opens, with this
 * door's own `entry`.
 */
describe('the way to Lists', () => {
  it('is not a tab', async () => {
    const view = await open();
    expect(view.queryByRole('tab', { name: 'Lists' })).toBeNull();
    expect(await offered(view)).toEqual(['Watched', 'Watchlist']);
  });

  it('is a labelled link that pushes My lists from this door', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();
    const link = await waitFor(() => view.getByRole('link', { name: 'My lists' }));

    await fireEvent.press(link);
    expect(mockPush).toHaveBeenCalledWith('/lists?entry=collection');
  });

  it('is there on an empty collection too', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Your watched list starts here')).toBeTruthy());
    expect(view.getByRole('link', { name: 'My lists' })).toBeTruthy();
  });

  it('stays there while a segment loads and when its read fails', async () => {
    mockFailing.add('rankings');
    mockFailing.add('watchlist');
    const view = await open();
    await waitFor(() => expect(view.getByText('Could not load')).toBeTruthy());
    expect(view.getByRole('link', { name: 'My lists' })).toBeTruthy();

    await choose(view, 'Watchlist');
    await waitFor(() => expect(shown(view)).toBe('Watchlist'));
    expect(view.getByRole('link', { name: 'My lists' })).toBeTruthy();
  });

  it('is there on the Watchlist', async () => {
    const view = await open();
    await choose(view, 'Watchlist');
    await waitFor(() => expect(shown(view)).toBe('Watchlist'));
    expect(view.getByRole('link', { name: 'My lists' })).toBeTruthy();
  });

  it('opens on Movies when the build before left Lists as the remembered mode', async () => {
    mockPrefStore[MEDIUM_KEY] = 'lists';
    const view = await open();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(side(view)).toBe('Movies');
    expect(shown(view)).toBe('Watched');
  });
});

/**
 * **Movies | TV in the header, Watched | Watchlist | Unranked under it** (founder, UI
 * cohesion pass, 2026-11-06): one switch, not repeated in the body, and tabs in equal
 * columns with the chosen one in Maroon.
 */
describe('the header and the tabs', () => {
  it('draws one Movies | TV switch, in the header', async () => {
    const view = await open();
    const switches = view.getAllByLabelText('Medium');
    expect(switches).toHaveLength(1);
    expect(view.queryByLabelText('Notifications')).toBeNull();
  });

  /**
   * **The marquee** (founder, marquee cohesion sprint, 2026-11-07): the section's name in
   * Maroon DM Serif Display, about 22pt, with a Maroon chevron — one 44pt control that opens
   * a menu of the sections, the one showing marked.
   */
  it('names the section in Maroon DM Serif with a Maroon chevron, one 44pt control', async () => {
    const view = await open();
    const label = StyleSheet.flatten(view.getByTestId('collection-mode-label').props.style);
    expect(label.color).toBe(theme.semantic.action);
    expect(label.fontFamily).toBe(fontFamily.serif);
    expect(label.fontSize).toBeGreaterThanOrEqual(21);
    expect(label.fontSize).toBeLessThanOrEqual(23);
    // Wraps rather than truncating.
    expect(view.getByTestId('collection-mode-label').props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(menu(view).props.style).minHeight).toBe(theme.layout.minTapTarget);
    expect(menu(view).props.accessibilityLabel).toBe('Showing Watched');
    // No segmented control is left on the page.
    expect(view.queryByTestId('nav-tabs')).toBeNull();
    expect(view.queryAllByRole('tab')).toHaveLength(0);
  });

  it('opens a menu of the sections with the one showing selected, and switches', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();
    await waitFor(async () => expect(await offered(view)).toEqual([...SEGMENTS]));

    await fireEvent.press(menu(view));
    const items = await view.findAllByRole('menuitem');
    expect(items.map((item) => item.props.accessibilityState?.selected)).toEqual([
      true,
      false,
      false,
    ]);
    await fireEvent.press(view.getByRole('menuitem', { name: 'Watchlist' }));
    await waitFor(() => expect(shown(view)).toBe('Watchlist'));
    expect(view.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('offers two sections where this side has nothing unranked', async () => {
    const view = await open();
    await waitFor(async () => expect(await offered(view)).toEqual(['Watched', 'Watchlist']));
  });

  it('keeps the tab when the side changes and the new side has it too', async () => {
    const view = await open();
    await choose(view, 'Watchlist');
    await switchTo(view, 'TV');
    await waitFor(() => expect(side(view)).toBe('TV'));
    expect(shown(view)).toBe('Watchlist');
  });
});

/**
 * **No long press and no per-row overflow on a Collection row** (§D, §Q.6, §Q.7).
 *
 * Long press already means three different things elsewhere in this app — recall in
 * `RankingSheet`, report on a recommendation card, the reaction picker — and Collection
 * rows have never had one. A fourth meaning discoverable only by accident is not a
 * feature, and every Collection row is one tap from the title page, which owns the ⋯.
 */
describe('a Collection row', () => {
  it('has no long press and no overflow control', async () => {
    // List mode, so the rows draw their titles and this assertion has rows to be about.
    // Poster is the default, and under it there is no text to wait for — the test would
    // pass without ever having rendered a row.
    mockPrefStore[VIEW_MODE_KEY] = 'list';
    mockTables.user_media = [watched('m1', 'movie')];
    const view = await open();

    // The view control's own state, which is how the rest of this file establishes that
    // the list actually drew — a row's text lives inside FlashList and is not reliably
    // queryable from here.
    await waitFor(() =>
      expect(view.getByLabelText('List view').props.accessibilityState?.selected).toBe(true),
    );

    // Every pressable on the screen, not only the rows: the claim is that Collection has
    // no long press *anywhere*, and enumerating only the rows would miss the next
    // control somebody adds one to.
    for (const node of view.queryAllByRole('button', { includeHiddenElements: true })) {
      expect(node.props.onLongPress).toBeUndefined();
    }
    expect(view.queryByLabelText(/more options/i)).toBeNull();
  });
});

/**
 * Founder, final UI simplification 2026-09-21: on the Collection wall an unfinished
 * ranking and an untouched import look the same — no chip, no "ranking not finished" —
 * and only a ranked title carries its score.
 */
describe('the ranking state on the Collection wall', () => {
  it('draws an unfinished ranking exactly like an unranked import', async () => {
    mockTables.user_media = [
      { ...watched('abandoned', 'movie'), bucket: 'fine' },
      { ...watched('imported', 'movie'), bucket: null },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByLabelText(/^Film abandoned/)).toBeTruthy());
    expect(view.getByLabelText(/^Film imported/)).toBeTruthy();
    expect(view.queryByLabelText(/ranking not finished/)).toBeNull();
    expect(view.queryAllByText('Finish', { includeHiddenElements: true })).toHaveLength(0);
  });
});

/**
 * **Unified Backlog + Refine** (founder-approved 2026-09-21). With the flags on, the
 * Watched view has one card slot — the unranked card wins, and it names no count — the
 * Unranked tab carries a persistent Start ranking with the exact count, and Refine's card
 * shows only when the server says the batch is strong and no Not now still holds.
 */
describe('the backlog and Refine cards', () => {
  const backlog = (total: number) => ({
    status: total ? 'ready' : 'empty',
    total,
    remaining: total,
    targets: total
      ? [{ media_item_id: 'm1', title: 'Film m1', kind: 'movie', bucket: null, resume: false }]
      : [],
    checkpoint_every: 10,
  });
  const strongRefine = (placementsTotal = 41) => ({
    status: 'ready',
    candidates: [{ media_item_id: 'r1', title: 'R', position: 3, reason: 'crossed' }],
    placements_total: placementsTotal,
    cta: { show: true, count: 4, qualifying: 9, strong: 4, resurface_after: 3 },
  });

  it('Watched: titles left to rank, with no count, and View unranked', async () => {
    mockTables.user_media = [watched('m1', 'movie'), watched('m2', 'movie')];
    mockRpcAnswers.ranking_backlog = backlog(327);
    const view = await open();

    await waitFor(() => expect(view.getByText('You have titles left to rank')).toBeTruthy());
    expect(view.getByText(/Finish placing the movies you.ve\s+already seen\./)).toBeTruthy();
    expect(view.getByRole('button', { name: 'View unranked' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(view.queryByText(/327/)).toBeNull();
    expect(view.queryByText('You have unranked titles')).toBeNull();
  });

  it('Unranked: a persistent Start ranking with the exact count', async () => {
    mockTables.user_media = [watched('m1', 'movie'), watched('m2', 'movie')];
    mockRpcAnswers.ranking_backlog = backlog(2);
    mockParams.show = 'unranked';
    const view = await open();

    await waitFor(() => expect(view.getByTestId('collection-start-ranking-card')).toBeTruthy());
    expect(view.getByText('Rank your unranked titles')).toBeTruthy();
    expect(view.getByText('2 movies to rank')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('Start ranking opens the backlog session for this medium', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    mockRpcAnswers.ranking_backlog = backlog(1);
    mockParams.show = 'unranked';
    const view = await open();

    await waitFor(() => expect(view.getByRole('button', { name: 'Start ranking' })).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Start ranking' }));
    expect(mockPush).toHaveBeenCalledWith('/rank-session?medium=movies&start=backlog');
  });

  it('Refine: shown when nothing is left to rank and the batch is strong', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    mockRpcAnswers.ranking_backlog = backlog(0);
    mockRpcAnswers.refine_candidates = strongRefine();
    const view = await open();

    await waitFor(() => expect(view.getByText('Fine-tune your rankings')).toBeTruthy());
    expect(view.getByText('4 placements to refine')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Not now' })).toBeTruthy();
  });

  it('Refine opens the refine session for this medium', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    mockRpcAnswers.ranking_backlog = backlog(0);
    mockRpcAnswers.refine_candidates = strongRefine();
    const view = await open();

    await waitFor(() =>
      expect(view.getByRole('button', { name: 'Refine rankings' })).toBeTruthy(),
    );
    await fireEvent.press(view.getByRole('button', { name: 'Refine rankings' }));
    expect(mockPush).toHaveBeenCalledWith('/rank-session?medium=movies&start=refine');
  });

  it('one card slot: the unranked card wins over Refine', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    mockRpcAnswers.ranking_backlog = backlog(3);
    mockRpcAnswers.refine_candidates = strongRefine();
    const view = await open();

    await waitFor(() => expect(view.getByText('You have titles left to rank')).toBeTruthy());
    expect(view.queryByText('Fine-tune your rankings')).toBeNull();
  });

  it('Not now holds until enough new placements, however long ago it was', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    mockRpcAnswers.ranking_backlog = backlog(0);
    mockRpcAnswers.refine_candidates = strongRefine(42);
    mockPrefStore['user-1.collection.refine-not-now.movies'] = {
      dismissedAt: '2020-01-01T00:00:00Z',
      placementsAtDismissal: 40,
    };
    const view = await open();

    // Two new placements against a bar of three: still resting, years later. Gated on the
    // read having been made and answered, or the absence below would prove nothing.
    await waitFor(() => expect(mockRpcCalls).toContain('refine_candidates'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.queryByText('Fine-tune your rankings')).toBeNull();
  });

  it('Not now is lifted once the reader has ranked enough since', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    mockRpcAnswers.ranking_backlog = backlog(0);
    mockRpcAnswers.refine_candidates = strongRefine(43);
    mockPrefStore['user-1.collection.refine-not-now.movies'] = {
      dismissedAt: new Date().toISOString(),
      placementsAtDismissal: 40,
    };
    const view = await open();

    await waitFor(() => expect(view.getByText('Fine-tune your rankings')).toBeTruthy());
  });

  it('Not now records the placement total it is measured from', async () => {
    mockTables.user_media = [watched('m1', 'movie')];
    mockRpcAnswers.ranking_backlog = backlog(0);
    mockRpcAnswers.refine_candidates = strongRefine(41);
    const view = await open();

    await waitFor(() => expect(view.getByRole('button', { name: 'Not now' })).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    expect(mockPrefWrites).toContainEqual({
      name: 'user-1.collection.refine-not-now.movies',
      value: expect.objectContaining({ placementsAtDismissal: 41 }),
    });
  });

});
