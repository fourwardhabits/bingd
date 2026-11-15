import { fireEvent, waitFor, within } from '@testing-library/react-native';

import { prefStore } from '@/test-utils/prefs-store';
import { renderWithProviders } from '@/test-utils/render';
import { bandSizes, formatScore, scoreFor, type Bucket } from '@/features/collection/score';

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
/** Set to a message to make the RPC answer with an error rather than rows. */
let mockTopRatedError: string | null = null;
/**
 * How late `top_rated_titles` answers, in real milliseconds. Zero answers at once. A test
 * sets it to have the wall arrive while the reader is already acting, as it does on a slow
 * runner (`pickWall` below explains why that matters).
 */
let mockTopRatedDelayMs = 0;

const mockCatalogue: Record<string, Record<string, unknown>> = {};
/** The reader's own `rankings` rows: what `useMyScores` derives their score chips from. */
let mockRankings: Record<string, unknown>[] = [];

/**
 * Hermetic: For You remembers its selection per account (2026-11-12), and the real store's
 * memory mirror would carry one test's Top Rated or TV into the next. See `prefs-store`.
 */
jest.mock('@/lib/prefs', () => jest.requireActual('@/test-utils/prefs-store').prefsModule);
beforeEach(() => prefStore.reset());

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpc(name, args);
      if (name === 'top_rated_titles') {
        if (mockTopRatedError)
          return Promise.resolve({ data: null, error: { message: mockTopRatedError } });
        const key = (args.p_after_id as string | null) ?? 'first';
        const answer = { data: mockTopRatedPages[key] ?? [], error: null };
        return mockTopRatedDelayMs > 0
          ? new Promise((resolve) => setTimeout(() => resolve(answer), mockTopRatedDelayMs))
          : Promise.resolve(answer);
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
              table === 'media_items'
                ? wanted.map((id) => mockCatalogue[id]).filter(Boolean)
                : table === 'rankings'
                  ? mockRankings
                  : [],
            error: null,
          }),
      };
      return chain;
    },
  },
}));

jest.mock('expo-router', () => ({
  // The tab-press listener every tab screen subscribes to (`useTabReset`). A navigator
  // that never fires is the right stand-in: these files are not about that behaviour.
  useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
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

const media = (id: string, title: string, genre: string, kind = 'movie', year = 2014) => ({
  id,
  title,
  season_number: null,
  release_date: `${year}-01-01`,
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

/**
 * Opens the Recommended / Top Rated dropdown and picks a wall — **once the wall on screen
 * has finished arriving**.
 *
 * This is the For You flake (CI run 42943045415, attempt 1: "Unable to find an element
 * with role: menuitem"). The toolbar that holds the dropdown is drawn *above* a wall that
 * is still loading and *inside* the wall's scroller once it has loaded (`wallScrolls` in
 * `app/(tabs)/recommendations.tsx`), so the dropdown is unmounted and mounted afresh when
 * a wall lands. And its anchored menu opens a beat after the press: it measures the
 * control first, and under Jest `measureInWindow` never answers, so it opens from its
 * 120ms fallback timer. A wall that lands at any point between the press and the press on
 * the menu item moves the toolbar: before the timer, the timer opens the menu on the
 * dropdown that has just been unmounted; after it, the remount takes the open menu down
 * before `findByRole` (which polls) sees it. Either way the dropdown on screen is closed
 * and there is no menu to find, however long the test waits. Whether the wall landed in
 * that window was down to how fast the runner was (the CI snapshot shows the wall loaded
 * and the dropdown `expanded: false`).
 *
 * So the test opens the dropdown on a settled wall, as a person does: they tap the control
 * they can see, not one that is about to move. The `a slow server` case below sets the
 * race up every run — the wall answers after the press — so this helper is what keeps it
 * passing. It guards the helper, not the screen: the remount itself is screen behaviour
 * (see the PR).
 *
 * The screen no longer remounts the dropdown (2026-11-11): the toolbar is in the same
 * scroller in every state, and `a wall that lands under an open menu` below pins that. The
 * wait stays, because it is still how a person uses the control.
 */
const pickWall = async (view: Awaited<ReturnType<typeof open>>, wall: 'Recommended' | 'Top Rated') => {
  await waitFor(() => expect(view.queryByTestId('skeleton-grid')).toBeNull());
  await fireEvent.press(view.getByLabelText(/^Showing /));
  await fireEvent.press(await view.findByRole('menuitem', { name: new RegExp(`^${wall}`) }));
};

/**
 * The wall and the medium are two controls (founder final polish, 2026-11-04): the page's
 * dropdown on the left (Recommended / Top Rated) and the Movies | TV switch on the right,
 * the same pair Collection uses. `choose` takes the four walls by their full names.
 */
const choose = async (view: Awaited<ReturnType<typeof open>>, category: string) => {
  const [, wall, medium] = /^(Recommended|Top Rated) (Movies|TV)$/.exec(category) ?? [];
  if ((wall !== 'Recommended' && wall !== 'Top Rated') || !medium)
    throw new Error(`not a For You wall: ${category}`);
  if (view.getByLabelText(/^Showing /).props.accessibilityLabel !== `Showing ${wall}`) {
    await pickWall(view, wall);
  }
  await fireEvent.press(within(view.getByLabelText('Medium')).getByRole('radio', { name: medium }));
};

/** What the two controls say together, as one phrase: "Showing Top Rated Movies". */
const showing = (view: Awaited<ReturnType<typeof open>>) => {
  const wall = String(view.getByLabelText(/^Showing /).props.accessibilityLabel).replace(/^Showing /, '');
  const medium = within(view.getByLabelText('Medium'))
    .getAllByRole('radio')
    .find((cell) => cell.props.accessibilityState?.selected)?.props.accessibilityLabel;
  return `Showing ${wall} ${medium}`;
};

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
  mockTopRatedError = null;
  mockTopRatedDelayMs = 0;
  mockRankings = [];
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

  it('asks for movies on Top Rated Movies and for seasons on Top Rated TV Shows', async () => {
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

  it('takes Sent to You and Find for a Group away, and keeps Filters', async () => {
    const view = await open();
    expect(view.getByLabelText(/^Sent to You/)).toBeTruthy();
    expect(view.getByText('Find for a Group')).toBeTruthy();

    await choose(view, 'Top Rated Movies');
    await waitFor(() => expect(view.getByLabelText('The Highest, 2014')).toBeTruthy());

    // Both are statements about particular people, and this wall's whole claim is that
    // the order belongs to everybody.
    expect(view.queryByLabelText(/^Sent to You/)).toBeNull();
    expect(view.queryByText('Find for a Group')).toBeNull();
    // Filters narrow *which titles*, which is a question this wall can answer.
    expect(view.getByRole('button', { name: 'Filters' })).toBeTruthy();
  });

  it('leaves Sent to you off when it comes back, rather than under the wrong wall', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText(/^Sent to You/));

    await choose(view, 'Top Rated Movies');
    await waitFor(() => expect(view.getByLabelText('The Highest, 2014')).toBeTruthy());
    await choose(view, 'Recommended Movies');

    // It was on when Top Rated was chosen. Restoring it would draw a list of things
    // people sent this reader under a control they last pressed to leave that list.
    await waitFor(() => expect(view.getByLabelText(/^Sent to You/)).toBeTruthy());
    expect(view.getByLabelText(/^Sent to You/).props.accessibilityState?.selected).toBeFalsy();
  });

  it('says nobody has rated enough yet when the wall is simply empty', async () => {
    mockTopRatedPages = {};
    const view = await open();

    mockRpc.mockClear();
    await choose(view, 'Top Rated Movies');

    // With no rows and no error the honest answer is the threshold, not a failure.
    await waitFor(() => expect(view.getByText('Not enough ratings yet')).toBeTruthy());
    expect(view.getByText(/once enough people have rated them/)).toBeTruthy();
    // And emphatically not the failure state, which is a different claim.
    expect(view.queryByText('Could not load Top Rated')).toBeNull();
  });

  /**
   * The failure branch, which had no test at all: the case above is named for it but
   * asserts the *empty* state, so `wall.isError` — the branch that decides a Top Rated
   * failure says "Top Rated" rather than "recommendations" — was never executed.
   * Independent review, 2026-09-09.
   */
  it('says which wall it could not load, and offers the way back', async () => {
    mockTopRatedError = 'network down';
    const view = await open();

    await choose(view, 'Top Rated Movies');

    await waitFor(() => expect(view.getByText('Could not load Top Rated')).toBeTruthy());
    // The slate's wording would be wrong here: it is not the recommendations that failed.
    expect(view.queryByText('Could not load recommendations')).toBeNull();

    // Try again refetches *this* wall, not the slate's.
    mockTopRatedError = null;
    mockRpc.mockClear();
    await fireEvent.press(view.getByText('Try again'));
    await waitFor(() => expect(view.getByLabelText('The Highest, 2014')).toBeTruthy());
    expect(mockRpc).toHaveBeenCalledWith(
      'top_rated_titles',
      expect.objectContaining({ p_medium: 'movies' }),
    );
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

/**
 * The two things a keyset over live data cannot promise, and what the screen does about
 * them. Both added by independent review, 2026-09-09.
 */
describe('a wall whose order moves under the reader', () => {
  it('draws a title once even when two pages both return it', async () => {
    // The scenario: page one ends at `page-19`; before page two is asked for, a title
    // from page one loses ratings and falls below the cursor, so the server hands it
    // back a second time. A keyset names the row it continues from — it does not freeze
    // the ordering — so this is a thing the server may legitimately do.
    const full = Array.from({ length: 20 }, (_, index) => row(`page-${index}`, 9.9 - index / 10));
    for (const item of full) {
      mockCatalogue[item.media_item_id] = media(item.media_item_id, `Film ${item.media_item_id}`, 'Drama');
    }
    mockTopRatedPages = {
      first: full,
      // `page-3` again, now scored below the cursor, beside a genuinely new row.
      'page-19': [row('page-3', 7.2), row('page-0', 7.1)],
    };

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

    // Both repeats resolve to the tile that was already there rather than a second one.
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'top_rated_titles',
        expect.objectContaining({ p_after_id: 'page-19' }),
      ),
    );
    await waitFor(() => {
      expect(view.getAllByLabelText('Film page-3, 2014')).toHaveLength(1);
      expect(view.getAllByLabelText('Film page-0, 2014')).toHaveLength(1);
    });
  });
});


/**
 * A filter that matches nothing on the pages loaded so far.
 *
 * The reachable shape of this is a *combination*, not an unseen genre: the filter sheet's
 * options are built from the loaded pool, so a reader cannot pick a genre no loaded title
 * has. They can pick Comedy and the 1990s when the pool holds a Comedy and holds a 1990s
 * title but holds no 1990s Comedy — and the catalogue may well have one further down.
 *
 * The screen used to answer that with "Nothing matches those filters" and a wall with
 * nothing on it to scroll, which is both an unearned claim and the terminal cutoff the
 * founder's brief rules out, arriving through the filter path. Independent review,
 * 2026-09-09.
 */
describe('a filter that matches nothing on the pages loaded so far', () => {
  it('offers to keep looking rather than claiming nothing matches', async () => {
    // Eighteen 2010s Dramas, one 2010s Comedy and one 1990s Drama: both facets are on
    // offer, and no loaded title carries them both.
    const full = Array.from({ length: 20 }, (_, index) => row(`p-${index}`, 9.9 - index / 100));
    full.forEach((item, index) => {
      const isComedy = index === 5;
      const isNineties = index === 9;
      mockCatalogue[item.media_item_id] = media(
        item.media_item_id,
        `Film ${item.media_item_id}`,
        isComedy ? 'Comedy' : 'Drama',
        'movie',
        isNineties ? 1994 : 2014,
      );
    });
    // Every cursor answers with another full page of the same rows, so the wall never
    // ends on its own — the budget is what stops the search, which is the point.
    mockTopRatedPages = { first: full };
    mockTopRatedPages[full[19]!.media_item_id] = full;

    const view = await open();
    await choose(view, 'Top Rated Movies');
    await waitFor(() => expect(view.getByLabelText('Film p-0, 2014')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Filters' }));
    await waitFor(() => expect(view.getByText('Comedy')).toBeTruthy());
    await fireEvent.press(view.getByText('Comedy'));
    await fireEvent.press(view.getByText('1990s'));
    await fireEvent.press(view.getByText('Apply'));

    // Not "Nothing matches those filters": there is more wall behind this, and it says so.
    await waitFor(() => expect(view.getByText('Nothing yet in the highest rated')).toBeTruthy());
    expect(view.queryByText('Nothing matches those filters')).toBeNull();

    // Pressing it spends another allowance, which is what makes the match reachable.
    mockCatalogue['late-1'] = media('late-1', 'A Nineties Comedy', 'Comedy', 'movie', 1994);
    mockTopRatedPages[full[19]!.media_item_id] = [row('late-1', 6)];
    await fireEvent.press(view.getByText('Keep looking'));
    await waitFor(() => expect(view.getByLabelText('A Nineties Comedy, 1994')).toBeTruthy());
  });

  it('still says nothing matches when the wall has genuinely ended', async () => {
    // A short page is the end of the wall, so there is nothing further to look through
    // and "nothing matches" is the true sentence rather than a premature one.
    mockCatalogue['only-1'] = media('only-1', 'The Only Drama', 'Drama');
    mockCatalogue['only-2'] = media('only-2', 'The Only Comedy', 'Comedy', 'movie', 1994);
    mockTopRatedPages = { first: [row('only-1', 9), row('only-2', 8)] };

    const view = await open();
    await choose(view, 'Top Rated Movies');
    await waitFor(() => expect(view.getByLabelText('The Only Drama, 2014')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Filters' }));
    await waitFor(() => expect(view.getByText('Comedy')).toBeTruthy());
    await fireEvent.press(view.getByText('Comedy'));
    await fireEvent.press(view.getByText('2010s'));
    await fireEvent.press(view.getByText('Apply'));

    await waitFor(() => expect(view.getByText('Nothing matches those filters')).toBeTruthy());
    expect(view.queryByText('Keep looking')).toBeNull();
    expect(view.getByText('Clear filters')).toBeTruthy();
  });
});

/**
 * Keep looking, on a wall that was already scrolled deep.
 *
 * The budget is an absolute page count that resets when the question changes; the pages
 * do not reset with it, and manual paging has no budget at all. So a reader can be
 * further into the wall than the budget they were just handed — and a press that only
 * added to the budget then bought a ceiling still below the current depth and did
 * nothing at all. Independent review, 2026-09-09.
 *
 * This drives the wall past twenty pages by scrolling, which is the only way to get
 * there: the auto-advance itself stops at ten. Only a handful of tiles are ever on
 * screen, because the standing filter matches three titles.
 */
describe('keep looking on a deeply scrolled wall', () => {
  it('advances on the first press however many pages are already cached', async () => {
    // Forty chained pages of twenty, so no cursor ever ends the wall.
    const pageOf = (n: number) =>
      Array.from({ length: 20 }, (_, i) => row(`q${n}-${i}`, 9.9 - n / 100 - i / 10000));
    const pages = Array.from({ length: 40 }, (_, n) => pageOf(n));
    pages.forEach((page, n) =>
      page.forEach((item, i) => {
        // Page one carries the two facets: three Comedies, and one 1990s Drama.
        const comedy = n === 0 && i > 0 && i < 4;
        const nineties = n === 0 && i === 4;
        mockCatalogue[item.media_item_id] = media(
          item.media_item_id,
          `F ${item.media_item_id}`,
          comedy ? 'Comedy' : 'Drama',
          'movie',
          nineties ? 1994 : 2014,
        );
      }),
    );
    mockTopRatedPages = { first: pages[0]! };
    pages.forEach((page, n) => {
      if (n + 1 < pages.length) mockTopRatedPages[page[19]!.media_item_id] = pages[n + 1]!;
    });

    const view = await open();
    await choose(view, 'Top Rated Movies');
    await waitFor(() => expect(view.getByLabelText('F q0-0, 2014')).toBeTruthy());

    // Comedy alone matches three, so the wall renders and can be scrolled — and the
    // auto-advance spends its ten pages getting there.
    await fireEvent.press(view.getByRole('button', { name: 'Filters' }));
    await waitFor(() => expect(view.getByText('Comedy')).toBeTruthy());
    await fireEvent.press(view.getByText('Comedy'));
    await fireEvent.press(view.getByText('Apply'));
    await waitFor(() => expect(view.getByLabelText('F q0-1, 2014')).toBeTruthy());

    // Twelve manual pages on top of the auto-advance's ten: past twenty either way.
    const scroll = async () => {
      await fireEvent.scroll(view.getByTestId('for-you-wall'), {
        nativeEvent: {
          contentOffset: { y: 4000 },
          contentSize: { height: 4200, width: 320 },
          layoutMeasurement: { height: 600, width: 320 },
        },
      });
    };
    for (let i = 0; i < 12; i += 1) {
      const before = mockRpc.mock.calls.length;
      await scroll();
      await waitFor(() => expect(mockRpc.mock.calls.length).toBeGreaterThan(before));
    }

    // Now a filter combination nothing loaded satisfies, which resets the budget to ten
    // while the wall sits far deeper than that.
    await fireEvent.press(view.getByTestId('for-you-filters'));
    await waitFor(() => expect(view.getByText('1990s')).toBeTruthy());
    await fireEvent.press(view.getByText('1990s'));
    await fireEvent.press(view.getByText('Apply'));
    await waitFor(() => expect(view.getByText('Nothing yet in the highest rated')).toBeTruthy());

    // The press must buy real work on the *first* press, not the third.
    mockRpc.mockClear();
    await fireEvent.press(view.getByText('Keep looking'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(mockRpc).toHaveBeenCalledWith('top_rated_titles', expect.objectContaining({}));
  });
});

/**
 * **Each control keeps the other's value** (founder final polish, 2026-11-04). The dropdown
 * chooses the wall and the switch the medium; together they are the four walls, so changing
 * one must never reset the other.
 */
/**
 * **The dropdown stays open when the wall under it finishes loading** (2026-11-11).
 *
 * The screen bug behind #260's flake, which #260 fixed only in the test: the toolbar that
 * holds Recommended ▾ was drawn above a loading wall and inside the wall's scroller once
 * it landed, so a wall arriving under an open menu remounted the dropdown and closed it.
 * A person meets it by changing wall or medium and opening the menu straight away. The
 * server answers 400ms after the request here, well after the menu has opened.
 */
describe('a wall that lands under an open menu', () => {
  it('leaves the menu open, on the same dropdown', async () => {
    mockTopRatedDelayMs = 400;
    const view = await open();
    await pickWall(view, 'Top Rated');
    await waitFor(() => expect(view.getByTestId('skeleton-grid')).toBeTruthy());

    await fireEvent.press(view.getByLabelText(/^Showing /));
    await view.findByRole('menuitem', { name: /^Recommended/ });
    expect(view.getByTestId('skeleton-grid')).toBeTruthy();

    // The wall arrives while the menu is open.
    await waitFor(() => expect(view.queryByTestId('skeleton-grid')).toBeNull(), {
      timeout: 3000,
    });
    expect(view.getByTestId('for-you-wall')).toBeTruthy();
    expect(view.getByRole('menuitem', { name: /^Recommended/ })).toBeTruthy();
    expect(view.getByLabelText(/^Showing /).props.accessibilityState).toMatchObject({
      expanded: true,
    });

    // And it still works: the choice lands.
    await fireEvent.press(view.getByRole('menuitem', { name: /^Recommended/ }));
    await waitFor(() => expect(showing(view)).toBe('Showing Recommended Movies'));
  });
});

describe('the dropdown and the switch together', () => {
  /**
   * Run twice: with the server answering at once, and with it answering 60ms after each
   * request — after the press and before the menu item is pressed, the CI flake's window
   * (see `pickWall`). Without `pickWall`'s wait the slow run failed every time, until the
   * screen stopped remounting the dropdown (2026-11-11); the wait stays. The 60ms
   * sits inside that window only because the menu opens from the 120ms fallback timer; if
   * `MEASURE_TIMEOUT_MS` changes a lot, revisit it.
   */
  it.each([
    ['a fast server', 0],
    ['a slow server', 60],
  ])(
    'keeps the medium across a change of wall, and the wall across a change of medium (%s)',
    async (_server, delay) => {
      mockTopRatedDelayMs = delay;
      const view = await open();

      await choose(view, 'Recommended TV');
      await waitFor(() => expect(showing(view)).toBe('Showing Recommended TV'));

      await pickWall(view, 'Top Rated');
      await waitFor(() => expect(showing(view)).toBe('Showing Top Rated TV'));

      await fireEvent.press(
        within(view.getByLabelText('Medium')).getByRole('radio', { name: 'Movies' }),
      );
      await waitFor(() => expect(showing(view)).toBe('Showing Top Rated Movies'));

      await pickWall(view, 'Recommended');
      await waitFor(() => expect(showing(view)).toBe('Showing Recommended Movies'));
    },
  );
});

/**
 * **The reader's own score, on the titles they have ranked** (founder hotfix, 2026-11-07).
 *
 * Top Rated is the community's order and keeps titles the reader has seen, so a poster
 * there can be one they ranked — and it now carries the same Maroon chip the Collection
 * wall draws, from the same `PosterGrid` tile. Nothing is chipped onto an unranked title,
 * and the community's order is untouched.
 */
describe('your own score on Top Rated', () => {
  const ranking = (id: string, bucket: Bucket, position: number) => ({
    media_item_id: id,
    bucket,
    position,
    category: 'movies',
  });

  it('chips your score onto a title you ranked, and nothing onto the rest', async () => {
    mockRankings = [ranking('best-2', 'loved', 1), ranking('elsewhere', 'loved', 2)];
    const sizes = bandSizes(mockRankings as { bucket: Bucket }[]);
    const yours = formatScore(scoreFor('loved', 1, sizes));

    const view = await open();
    await choose(view, 'Top Rated Movies');

    await waitFor(() =>
      expect(view.getByLabelText(`The Second, 2014, scored ${yours} out of 10`)).toBeTruthy(),
    );
    // The chip itself is hidden from screen readers: the tile's label already says it.
    expect(view.getByText(yours, { includeHiddenElements: true })).toBeTruthy();
    // Unranked titles keep a plain label and no chip; the order is still the server's.
    const tiles = view
      .getAllByLabelText(/^The .+, 2014/)
      .map((node) => node.props.accessibilityLabel);
    expect(tiles).toEqual([
      'The Highest, 2014',
      `The Second, 2014, scored ${yours} out of 10`,
      'The Third, 2014',
    ]);
  });

  it('chips nothing for a reader who has ranked none of the wall', async () => {
    const view = await open();
    await choose(view, 'Top Rated Movies');

    await waitFor(() => expect(view.getByLabelText('The Highest, 2014')).toBeTruthy());
    expect(view.queryByLabelText(/scored .* out of 10/)).toBeNull();
  });

  it('opens a chipped title like any other', async () => {
    mockRankings = [ranking('best-1', 'fine', 1)];
    const view = await open();
    await choose(view, 'Top Rated Movies');

    const tile = await view.findByLabelText(/^The Highest, 2014, scored /);
    await fireEvent.press(tile);
    expect(mockPush).toHaveBeenCalledWith('/title/best-1');
  });
});

