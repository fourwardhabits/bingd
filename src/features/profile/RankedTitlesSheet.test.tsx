import { fireEvent, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { RankedTitlesSheet } from './RankedTitlesSheet';

/**
 * Somebody's whole ranked collection, behind See all and behind the profile stat.
 *
 * **The order is the point, and it changed** (founder, 2026-08-29). This listed newest
 * addition first; it now lists rank order, because the wall above already shows the best
 * six and the question a reader has after seeing it is what comes seventh. The ordinal is
 * drawn for the same reason — a rank-ordered list without one is indistinguishable from
 * an arbitrary one.
 *
 * **It reads through `useRankedCollection`**, the query the profile behind it already
 * ran, rather than through a second sheet-only read of `rankings`. That is mocked here
 * rather than the table: what these assert is that the canonical entries reach the
 * canonical row in the canonical order, and a hand-built `from('rankings')` chain would
 * only prove a query was shaped. Pagination, the keyset cursor and the position sort all
 * belong to that hook and are covered where it lives.
 *
 * Privacy is not asserted here because it is not decided here: the read is `rankings`
 * under `rankings_read`, exercised in the DB suites.
 */

const mockAsked: { userId: string; category: string; enabled: boolean }[] = [];
let mockMovies: unknown[] = [];
let mockSeasons: unknown[] = [];
let mockShows: unknown[] = [];
let mockPending = false;
let mockError = false;

jest.mock('@/features/collection/use-collection', () => ({
  useRankedCollection: (
    userId: string,
    category: string,
    options: { enabled?: boolean } = {},
  ) => {
    mockAsked.push({ userId, category, enabled: options.enabled ?? true });
    return {
      data:
        category === 'movies' ? mockMovies : category === 'tv_shows' ? mockShows : mockSeasons,
      isPending: mockPending,
      isError: mockError,
      refetch: jest.fn(),
    };
  },
}));

/** A ranked entry in the shape `useRankedCollection` returns. */
const entry = (over: Record<string, unknown> = {}) => ({
  mediaItemId: 'm1',
  title: 'A Film',
  seriesTitle: null,
  seasonNumber: null,
  kind: 'movie',
  year: 2019,
  posterPath: null,
  genres: [],
  language: null,
  bucket: 'loved',
  position: 1,
  category: 'movies',
  // `rankings.created_at`, which the Recently ranked order reads. Never null in the
  // schema, so a fixture that omitted it would be a row the database cannot produce.
  rankedAt: '2026-01-01T00:00:00Z',
  ...over,
});

beforeEach(() => {
  mockAsked.length = 0;
  mockMovies = [];
  mockSeasons = [];
  mockShows = [];
  mockPending = false;
  mockError = false;
});

const open = (over: Partial<Parameters<typeof RankedTitlesSheet>[0]> = {}) =>
  renderWithProviders(
    <RankedTitlesSheet
      category="movies"
      onChangeCategory={jest.fn()}
      userId="anna-id"
      name="Anna"
      isSelf={false}
      onPressTitle={jest.fn()}
      onClose={jest.fn()}
      {...over}
    />,
  );

it('reads the profile owner’s collection, and only theirs', async () => {
  mockMovies = [entry()];

  const view = await open();

  await waitFor(() => expect(view.getByText(/A Film/)).toBeTruthy());
  // Every read is keyed to the person whose profile this is. A viewer id appearing here
  // would be the actor/viewer confusion this sheet exists one tap away from.
  expect(mockAsked.every((call) => call.userId === 'anna-id')).toBe(true);
  expect(mockAsked.map((call) => call.category)).toEqual(
    expect.arrayContaining(['movies', 'tv_seasons']),
  );
});

it('lists in rank order, with the ordinal drawn', async () => {
  mockMovies = [
    entry({ mediaItemId: 'm1', title: 'Best Film', position: 1 }),
    entry({ mediaItemId: 'm2', title: 'Second Film', position: 2 }),
  ];

  const view = await open();

  await waitFor(() => expect(view.getByText(/Best Film/)).toBeTruthy());
  expect(view.getByText('#1')).toBeTruthy();
  expect(view.getByText('#2')).toBeTruthy();

  // Render order follows array order in RN Testing Library's tree walk, and the hook
  // hands the list over already sorted by position.
  const labels = view.getAllByLabelText(/Film, 2019/).map((n) => n.props.accessibilityLabel);
  expect(labels).toEqual(['Best Film, 2019', 'Second Film, 2019']);
});

/**
 * A season is named the way it is named everywhere else. The compact form is the whole
 * reason this reads through `useRankedCollection`: the read it replaced selected `title`
 * alone and had no series or season number to build one from.
 */
it('names a season canonically rather than by its bare title', async () => {
  mockSeasons = [
    entry({
      mediaItemId: 's1',
      kind: 'season',
      title: 'Season 2',
      seriesTitle: 'The Bear',
      seasonNumber: 2,
      category: 'tv_seasons',
    }),
  ];

  const view = await open({ category: 'tv_seasons' });

  await waitFor(() => expect(view.getByText(/The Bear/)).toBeTruthy());
  expect(view.queryByText('Season 2')).toBeNull();
});

it('switches list without closing, through the sheet’s own control', async () => {
  const onChangeCategory = jest.fn();
  mockMovies = [entry()];

  const view = await open({ onChangeCategory });
  await waitFor(() => expect(view.getByText(/A Film/)).toBeTruthy());

  fireEvent.press(view.getByText('TV Shows'));

  expect(onChangeCategory).toHaveBeenCalledWith('tv_seasons');
});

it('opens the tapped title', async () => {
  const onPressTitle = jest.fn();
  mockMovies = [entry()];

  const view = await open({ onPressTitle });
  await waitFor(() => expect(view.getByText(/A Film/)).toBeTruthy());

  fireEvent.press(view.getByText(/A Film/));

  expect(onPressTitle).toHaveBeenCalledWith('m1');
});

/** Read-only: nothing on a row may edit, re-rank, remove or log another person's title. */
it('offers no control that would change the collection it is showing', async () => {
  mockMovies = [entry()];

  const view = await open();
  await waitFor(() => expect(view.getByText(/A Film/)).toBeTruthy());

  expect(view.queryByLabelText(/^(re-?rank|remove|unlog|edit|add to watchlist)/i)).toBeNull();

  // The score badge is the specific hazard: on the Collection tab it is pressable and
  // opens the log sheet, which is an owner action with no meaning on somebody else's
  // ranking. Here it must be a statement — `role="text"`, no handler.
  const badge = view.getByLabelText(/out of 10/);
  expect(badge.props.accessibilityRole).toBe('text');
  expect(badge.props.onClick).toBeUndefined();
});

it('says the category is empty rather than showing a blank sheet', async () => {
  const view = await open({ category: 'tv_seasons' });

  // "TV", capitals intact — the lowercased template that once produced
  // "No tv seasons ranked yet" is exactly what the per-case copy replaced.
  await waitFor(() => expect(view.getByText('No TV ranked yet')).toBeTruthy());
});

/**
 * A list still loading must not read as a person who has ranked nothing — the false zero
 * that the awards sheet had to name a state for.
 */
it('does not report an unread list as an empty one', async () => {
  mockPending = true;

  const view = await open();

  expect(view.queryByText('No movies ranked yet')).toBeNull();
});

it('offers a retry rather than an empty list when the read fails', async () => {
  mockError = true;

  const view = await open();

  await waitFor(() => expect(view.getByText('Could not load the list')).toBeTruthy());
  expect(view.queryByText('No movies ranked yet')).toBeNull();
});

it('asks for nothing at all while it is closed', async () => {
  await open({ category: null });

  expect(mockAsked.every((call) => call.enabled === false)).toBe(true);
});

/**
 * **The render is bounded** (Codex review of 2026-08-29).
 *
 * This is a `ScrollView` and every row it holds is mounted at once — `FollowListSheet`
 * records why it cannot be a virtualised list here: a `FlatList` inside a
 * `maxHeight: 90%` container measures to zero. The read it replaced was capped at 200 by
 * the server; `useRankedCollection` reads to exhaustion, so the cap moved to the render
 * and is said out loud rather than discovered by counting.
 */
describe('a collection larger than the sheet will draw', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      entry({ mediaItemId: `m${i}`, title: `Film ${i}`, position: i + 1 }),
    );

  it('mounts at most two hundred rows', async () => {
    mockMovies = many(260);

    const view = await open();

    await waitFor(() => expect(view.getByText(/Film 0/)).toBeTruthy());
    expect(view.getAllByLabelText(/Film \d+, 2019/).length).toBe(200);
    // The two-hundredth is drawn and the two-hundred-and-first is not.
    expect(view.getByText(/^#200$/)).toBeTruthy();
    expect(view.queryByText(/^#201$/)).toBeNull();
  });

  it('says it was cut, and how much of it there is', async () => {
    mockMovies = many(260);

    const view = await open();

    // Not "their top 200": the sheet has four orders since 2026-08-29 and that
    // sentence is a wrong claim under Oldest first. The bound is what has to be said.
    await waitFor(() => expect(view.getByText('Showing 200 of 260.')).toBeTruthy());
  });

  it('says nothing of the sort when the whole list fits', async () => {
    mockMovies = many(12);

    const view = await open();

    await waitFor(() => expect(view.getByText(/Film 0/)).toBeTruthy());
    expect(view.queryByText(/Showing their top/)).toBeNull();
  });

  /**
   * **The band is the whole category; the cap is only what gets drawn.**
   *
   * The discriminator is the last drawn row. Scored against 260 titles, #200 sits some
   * way above the floor of its band; scored against the 200 on screen it would *be* the
   * floor — which is what applying the cap before `bandSizes` would produce, and the rule
   * `TopRanked` already records ("scoring six titles against themselves gives all six a
   * 10").
   */
  it('scores against the whole category rather than the drawn slice', async () => {
    const scoreOfLastDrawn = async (n: number) => {
      mockMovies = many(n);
      const view = await open();
      await waitFor(() => expect(view.getByText(/Film 0/)).toBeTruthy());
      const badges = view.getAllByLabelText(/out of 10/);
      return badges[199]?.props.accessibilityLabel as string;
    };

    const inA260Band = await scoreOfLastDrawn(260);
    const inA200Band = await scoreOfLastDrawn(200);

    // Same row, same position, different band — so a different number. Equal here would
    // mean the cap had been applied before the band was measured.
    expect(inA260Band).not.toBe(inA200Band);
  });
});

/**
 * Only the category on screen is read. Both were enabled at first, on the reasoning that
 * the profile behind the sheet had already asked for both — true only while those entries
 * are fresh, and the global `staleTime` is 60s. A reader who lingers then opens Movies was
 * refetching TV as well, which is not drawn.
 */
it('reads only the category it is showing', async () => {
  await open({ category: 'movies' });

  const enabled = mockAsked.filter((call) => call.enabled).map((call) => call.category);
  expect(enabled).toEqual(['movies']);
});

it('reads the other category once it is switched to', async () => {
  await open({ category: 'tv_seasons' });

  // TV is two rankings since 2026-11-14, seasons and whole shows; Movies is not read.
  const enabled = mockAsked.filter((call) => call.enabled).map((call) => call.category);
  expect([...new Set(enabled)].sort()).toEqual(['tv_seasons', 'tv_shows']);
});

/**
 * **TV under Candidate A's precedence** (founder brief §4, 2026-11-14): a ranked show is
 * listed only while none of its seasons is ranked, and a mixed list is ordered by the score
 * each row prints, never by ordinal. A show's ordinal is labelled as one.
 */
describe('a whole show on the TV list', () => {
  const show = (over: Record<string, unknown> = {}) =>
    entry({
      mediaItemId: 'show-1',
      title: 'Severance',
      kind: 'series',
      category: 'tv_shows',
      ...over,
    });
  const season = (over: Record<string, unknown> = {}) =>
    entry({
      mediaItemId: 's-1',
      title: 'Season 1',
      seriesTitle: 'The Bear',
      seasonNumber: 1,
      kind: 'season',
      category: 'tv_seasons',
      seriesId: 'bear',
      ...over,
    });

  /**
   * **One row per series** (WS-TVC, founder spec t168u §2, replacing Candidate A): the
   * owner's effective score — their explicit show ranking, else the mean of their ranked
   * seasons — and never a season as its own row.
   */
  it('lists a ranked show once, at its explicit score, with no ladder ordinal', async () => {
    mockShows = [show()];
    const view = await open({ category: 'tv_seasons' });

    await waitFor(() => expect(view.getByText(/Severance/)).toBeTruthy());
    expect(view.queryByText(/^#\d/)).toBeNull();
    expect(view.getByLabelText(/^10\.0 out of 10/)).toBeTruthy();
  });

  it('draws the series, not the season, when only a season is ranked, at the season mean', async () => {
    mockSeasons = [
      season({ mediaItemId: 's-1', position: 1 }),
      season({ mediaItemId: 's-2', title: 'Season 2', seasonNumber: 2, position: 2 }),
    ];
    const view = await open({ category: 'tv_seasons' });

    await waitFor(() => expect(view.getByText(/The Bear/)).toBeTruthy());
    expect(view.queryByText(/The Bear, S1/)).toBeNull();
    expect(view.getAllByText(/The Bear/)).toHaveLength(1);
    // 10.0 and 7.0 → 8.5, in the outlined badge, said as an average.
    expect(view.getByLabelText(/^8\.5 out of 10/)).toBeTruthy();
    expect(view.getByText('Average of 2 ranked seasons')).toBeTruthy();
  });

  it('uses the explicit show score over the season mean when both are ranked', async () => {
    mockShows = [show({ mediaItemId: 'bear', title: 'The Bear', bucket: 'fine' })];
    mockSeasons = [season()];
    const view = await open({ category: 'tv_seasons' });

    await waitFor(() => expect(view.getByText(/The Bear/)).toBeTruthy());
    expect(view.getAllByText(/The Bear/)).toHaveLength(1);
    expect(view.getByLabelText(/^6\.9 out of 10/)).toBeTruthy();
    expect(view.queryByText(/^Average of/)).toBeNull();
  });

  it('orders series by their effective scores', async () => {
    // A loved season of The Bear (10.0, a band of one) above a fine show (6.9).
    mockShows = [show({ bucket: 'fine' })];
    mockSeasons = [season({ bucket: 'loved' })];
    const view = await open({ category: 'tv_seasons' });

    await waitFor(() => expect(view.getByText(/Severance/)).toBeTruthy());
    const texts = JSON.stringify(view.toJSON()).match(/"(The Bear|Severance)"/g) ?? [];
    expect(texts[0]).toContain('The Bear');
  });
});

it('names whose collection it is', async () => {
  mockMovies = [entry()];

  const other = await open();
  await waitFor(() => expect(other.getByText("Anna's collection")).toBeTruthy());

  const self = await open({ isSelf: true });
  await waitFor(() => expect(self.getByText('Your collection')).toBeTruthy());
});

/**
 * **The sort control that replaced "In rank order."** (founder, 2026-08-29).
 *
 * A subtitle stating the order is a subtitle nobody can act on. Two axes and no more:
 * rank, and when the title entered the ranking. Each reverses in place.
 *
 * **Why the second axis is "Recently ranked" and not "Recently watched".** The founder
 * asked for recency, and the watch date cannot carry it: PRD §22 makes watch dates
 * private "on any profile, at any visibility, to anybody", and `logged_collection` — the
 * projection a visitor's read goes through — omits the column deliberately. A control
 * labelled *Recently watched* over somebody else's list would either sort by something
 * else or reverse that rule in passing. So the axis is when the title entered their
 * ranking, which is the same instant their public "ranked X" activity already carries.
 *
 * **Two axes, not four orders** (2026-08-30). It listed four labels, each carrying its
 * own direction; it now lists two, and pressing the one already on flips it. That is
 * `ui/sort.ts`'s contract, shared with the Collection tab, and it is what keeps a label
 * from being able to drift away from the order beside it.
 */
describe('the sort control', () => {
  /**
   * The order lives in Filters & Sort since 2026-11-13 — the main Collection's one entry.
   * It applies on the press, as the Collection tab's does; `choose` then applies the sheet
   * so the list underneath is back in front of the reader.
   */
  const openSort = async (view: Awaited<ReturnType<typeof open>>) => {
    await fireEvent.press(view.getByTestId('ranked-filter-sort'));
  };

  /** The titles in draw order, read off the ordinal-and-title rows. */
  const drawn = (view: Awaited<ReturnType<typeof open>>) =>
    view.getAllByLabelText(/, 20\d\d/).map((node) => String(node.props.accessibilityLabel));

  /** Open the menu and press one axis's row. Pressing the one already on reverses it. */
  const choose = async (view: Awaited<ReturnType<typeof open>>, label: RegExp) => {
    await openSort(view);
    await fireEvent.press(view.getByLabelText(label));
    await fireEvent.press(view.getByRole('button', { name: 'Apply' }));
  };

  const three = [
    entry({
      mediaItemId: 'a',
      title: 'First ranked',
      position: 3,
      rankedAt: '2026-01-01T00:00:00Z',
    }),
    entry({
      mediaItemId: 'b',
      title: 'Second ranked',
      position: 1,
      rankedAt: '2026-02-01T00:00:00Z',
    }),
    entry({
      mediaItemId: 'c',
      title: 'Third ranked',
      position: 2,
      rankedAt: '2026-03-01T00:00:00Z',
    }),
  ];

  it('opens on rank, highest first, and says so', async () => {
    mockMovies = three;
    const view = await open();

    await waitFor(() => expect(view.getByLabelText(/Sorted by Rank, highest first\./)).toBeTruthy());
    // Position 1 is the top of the band, so highest first is ascending position.
    expect(drawn(view)[0]).toMatch(/Second ranked/);
    expect(drawn(view)[2]).toMatch(/First ranked/);
  });

  it('reverses to lowest first when Rank is pressed again', async () => {
    mockMovies = three;
    const view = await open();
    await choose(view, /^Rank,/);

    await waitFor(() => expect(drawn(view)[0]).toMatch(/First ranked/));
    expect(drawn(view)[2]).toMatch(/Second ranked/);
    // Rule 4: the label is the axis and does not move with the direction.
    expect(view.getByLabelText(/Sorted by Rank, lowest first\./)).toBeTruthy();
  });

  it('orders by when the title entered the ranking, newest first', async () => {
    mockMovies = three;
    const view = await open();
    await choose(view, /^Recently ranked$/);

    await waitFor(() => expect(drawn(view)[0]).toMatch(/Third ranked/));
    expect(drawn(view)[2]).toMatch(/First ranked/);
    expect(view.getByLabelText(/Sorted by Recently ranked, newest first\./)).toBeTruthy();
  });

  it('and oldest first, on a second press of the same row', async () => {
    mockMovies = three;
    const view = await open();
    await choose(view, /^Recently ranked$/);
    await choose(view, /^Recently ranked,/);

    await waitFor(() => expect(drawn(view)[0]).toMatch(/First ranked/));
    expect(drawn(view)[2]).toMatch(/Third ranked/);
    expect(view.getByLabelText(/Sorted by Recently ranked, oldest first\./)).toBeTruthy();
  });

  it('starts a new axis in its own direction rather than inheriting the last one', async () => {
    // Rank reversed to lowest-first, then Recently ranked chosen: recency must open at
    // *newest* first, not inherit the ascending direction rank was left in.
    mockMovies = three;
    const view = await open();
    await choose(view, /^Rank,/);
    await waitFor(() => expect(view.getByLabelText(/Sorted by Rank, lowest first\./)).toBeTruthy());

    await choose(view, /^Recently ranked$/);
    await waitFor(() =>
      expect(view.getByLabelText(/Sorted by Recently ranked, newest first\./)).toBeTruthy(),
    );
    expect(drawn(view)[0]).toMatch(/Third ranked/);
  });

  it('puts a title with no date last, whichever direction is asked for', async () => {
    // `rankings.created_at` is `not null`, so this can only be a bundle reading a
    // response without the column. "Last, always" is the answer that does not put an
    // unknown at the top of a list claiming to be newest — and it is why the date test
    // comes before the direction rather than inside it.
    mockMovies = [
      entry({
        mediaItemId: 'a',
        title: 'Dated',
        position: 2,
        rankedAt: '2026-01-01T00:00:00Z',
      }),
      entry({ mediaItemId: 'b', title: 'Undated', position: 1, rankedAt: null }),
    ];
    const view = await open();

    await choose(view, /^Recently ranked$/);
    await waitFor(() => expect(drawn(view)[1]).toMatch(/Undated/));

    await choose(view, /^Recently ranked,/);
    await waitFor(() => expect(drawn(view)[1]).toMatch(/Undated/));
  });

  it('breaks a tie the same way every time', async () => {
    // `position` is unique per category, so the rank orders have no ties to break. The
    // id tiebreak is there anyway: a comparator that is total only by accident of a
    // constraint elsewhere is one schema change from reordering itself between renders.
    mockMovies = [
      entry({
        mediaItemId: 'zz',
        title: 'Later id',
        position: 1,
        rankedAt: '2026-01-01T00:00:00Z',
      }),
      entry({
        mediaItemId: 'aa',
        title: 'Earlier id',
        position: 2,
        rankedAt: '2026-01-01T00:00:00Z',
      }),
    ];
    const view = await open();
    await choose(view, /^Recently ranked$/);

    await waitFor(() => expect(drawn(view)[0]).toMatch(/Earlier id/));
    expect(drawn(view)[1]).toMatch(/Later id/);
  });

  it("never offers a watch-date order over somebody else's collection", async () => {
    // PRD §22: watch dates are private on any profile, at any visibility, to anybody.
    // The menu is the one place a reversal of that would be easy to make in passing.
    mockMovies = three;
    const view = await open();
    await openSort(view);

    expect(view.queryByLabelText(/watched/i)).toBeNull();
    expect(view.queryByText(/watched/i)).toBeNull();
  });

  it('keeps the Movies and TV selection, which is a different question', async () => {
    mockMovies = three;
    const onChangeCategory = jest.fn();
    const view = await open({ onChangeCategory });

    await choose(view, /^Rank,/);

    // Sorting is not switching lists, and it must not behave as though it were.
    expect(onChangeCategory).not.toHaveBeenCalled();
    await fireEvent.press(view.getByText('TV Shows'));
    expect(onChangeCategory).toHaveBeenCalledWith('tv_seasons');
  });

  it('scores against the whole category, not against the order on screen', async () => {
    // The band is measured over everything and the sort is applied to the rows, so a
    // reordered list does not re-score anybody. `#N` is the position, which means the
    // same thing under every order.
    mockMovies = three;
    const view = await open();
    await choose(view, /^Recently ranked$/);
    await choose(view, /^Recently ranked,/);

    await waitFor(() => expect(view.getByText('#3')).toBeTruthy());
    expect(view.getByText('#1')).toBeTruthy();
    expect(view.getByText('#2')).toBeTruthy();
  });
});

/**
 * **The shared sheet structure** (founder spec §4, 2026-11-13): Your Collection in the
 * header, the toggle beside it, Filters & Sort near the top, a list that fills the sheet
 * and scrolls to its last row, and the standard Close footer in its own bar.
 */
describe('the sheet around the list', () => {
  const many = Array.from({ length: 60 }, (_, n) =>
    entry({ mediaItemId: `m${n}`, title: `Film ${n}`, position: n + 1, year: 2000 + (n % 20) }),
  );

  it('takes the whole dense height, with no fixed cap on the list', async () => {
    mockMovies = many;
    const view = await open();
    await waitFor(() => expect(view.getByText(/Film 0/)).toBeTruthy());

    const body = StyleSheet.flatten(view.getByTestId('sheet-body').props.style);
    const list = StyleSheet.flatten(view.getByTestId('ranked-list').props.style);
    expect(body.height).toBe('90%');
    expect(list.maxHeight).toBeUndefined();
    expect(list.flex).toBe(1);
  });

  it('keeps the last row inside the scroll region and the footer outside it', async () => {
    mockMovies = many;
    const view = await open();
    await waitFor(() => expect(view.getByText(/Film 59/)).toBeTruthy());

    const list = view.getByTestId('ranked-list');
    let node = view.getByText(/Film 59/).parent;
    while (node && node !== list) node = node.parent;
    expect(node).toBe(list);

    let up = view.getByTestId('dismiss-footer').parent;
    while (up) {
      expect(up).not.toBe(list);
      up = up.parent;
    }
  });

  it('closes from the quiet Close footer, and has no other Close', async () => {
    const onClose = jest.fn();
    mockMovies = many;
    const view = await open({ onClose });
    await waitFor(() => expect(view.getByText(/Film 0/)).toBeTruthy());

    expect(view.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    await fireEvent.press(view.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says how many titles the list holds', async () => {
    mockMovies = many;
    const view = await open();
    await waitFor(() => expect(view.getByTestId('ranked-count')).toBeTruthy());
    expect(view.getByText('60 titles')).toBeTruthy();
  });
});

describe('the main Collection’s filters, over somebody’s ranking', () => {
  const mixed = [
    entry({ mediaItemId: 'a', title: 'A Comedy', position: 1, genres: ['Comedy'], year: 2021 }),
    entry({ mediaItemId: 'b', title: 'A Horror', position: 2, genres: ['Horror'], year: 1994 }),
    entry({ mediaItemId: 'c', title: 'Another Comedy', position: 3, genres: ['Comedy'], year: 2012 }),
  ];

  it('narrows the list by genre, keeping each row’s ordinal and score', async () => {
    mockMovies = mixed;
    const view = await open();
    await waitFor(() => expect(view.getByText(/A Horror/)).toBeTruthy());

    await fireEvent.press(view.getByTestId('ranked-filter-sort'));
    await fireEvent.press(view.getByLabelText(/^Comedy/));
    await fireEvent.press(view.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(view.queryByText(/A Horror/)).toBeNull());
    expect(view.getByText(/A Comedy/)).toBeTruthy();
    expect(view.getByText(/Another Comedy/)).toBeTruthy();
    // The ordinal is the owner's position, which a filter does not renumber.
    expect(view.getByText('#3')).toBeTruthy();
    expect(view.getByText('2 of 3')).toBeTruthy();
    expect(view.getByLabelText(/1 filter on/)).toBeTruthy();
  });

  it('clears back to the whole list', async () => {
    mockMovies = mixed;
    const view = await open();
    await waitFor(() => expect(view.getByText(/A Horror/)).toBeTruthy());

    await fireEvent.press(view.getByTestId('ranked-filter-sort'));
    await fireEvent.press(view.getByLabelText(/^Horror/));
    await fireEvent.press(view.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(view.queryByText(/A Comedy/)).toBeNull());

    await fireEvent.press(view.getByText('Clear all'));
    await waitFor(() => expect(view.getByText(/A Comedy/)).toBeTruthy());
    expect(view.getByText('3 titles')).toBeTruthy();
  });

  it('offers the main Collection’s title-fact orders, and sorts by release year', async () => {
    mockMovies = mixed;
    const view = await open();
    await waitFor(() => expect(view.getByText(/A Horror/)).toBeTruthy());

    await fireEvent.press(view.getByTestId('ranked-filter-sort'));
    expect(view.getByLabelText(/^Title/)).toBeTruthy();
    await fireEvent.press(view.getByLabelText(/^Release year/));
    await fireEvent.press(view.getByRole('button', { name: 'Apply' }));

    const order = view
      .getAllByLabelText(/, (19|20)\d\d/)
      .map((node) => String(node.props.accessibilityLabel));
    expect(order[0]).toMatch(/A Comedy/); // 2021
    expect(order[2]).toMatch(/A Horror/); // 1994
  });
});

/** Independent review, 2026-11-13: what must not carry over, and what must fall back. */
describe('state that follows the list on screen', () => {
  const films = [
    entry({ mediaItemId: 'a', title: 'A Comedy', position: 1, genres: ['Comedy'] }),
    entry({ mediaItemId: 'b', title: 'A Horror', position: 2, genres: ['Horror'] }),
  ];

  it('clears filters when the sheet is closed and opened on another list', async () => {
    mockMovies = films;
    mockSeasons = [
      entry({
        mediaItemId: 's1',
        title: 'Season 1',
        kind: 'season',
        seriesTitle: 'The Bear',
        seasonNumber: 1,
        category: 'tv_seasons',
        genres: ['Drama'],
      }),
    ];
    const props = {
      onChangeCategory: jest.fn(),
      userId: 'anna-id',
      name: 'Anna',
      isSelf: false,
      onPressTitle: jest.fn(),
      onClose: jest.fn(),
    };
    const view = await renderWithProviders(<RankedTitlesSheet category="movies" {...props} />);
    await waitFor(() => expect(view.getByText(/A Horror/)).toBeTruthy());
    await fireEvent.press(view.getByTestId('ranked-filter-sort'));
    await fireEvent.press(view.getByLabelText(/^Comedy/));
    await fireEvent.press(view.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(view.queryByText(/A Horror/)).toBeNull());

    // Closed (the profile keeps it mounted), then opened on TV from the wall.
    await view.rerender(<RankedTitlesSheet category={null} {...props} />);
    await view.rerender(<RankedTitlesSheet category="tv_seasons" {...props} />);

    await waitFor(() => expect(view.getByText(/The Bear/)).toBeTruthy());
    expect(view.queryByText('Nothing matches your filters')).toBeNull();
    expect(view.getByLabelText(/No filters/)).toBeTruthy();
  });

  it('falls back to Rank when a seasons-only list cannot offer Runtime', async () => {
    mockMovies = films.map((film) => ({ ...film, runtimeMinutes: 100 }));
    mockSeasons = [
      entry({ mediaItemId: 's1', title: 'Season 1', kind: 'season', seriesTitle: 'The Bear', seasonNumber: 1, category: 'tv_seasons' }),
    ];
    const props = {
      onChangeCategory: jest.fn(),
      userId: 'anna-id',
      name: 'Anna',
      isSelf: false,
      onPressTitle: jest.fn(),
      onClose: jest.fn(),
    };
    const view = await renderWithProviders(<RankedTitlesSheet category="movies" {...props} />);
    await waitFor(() => expect(view.getByText(/A Horror/)).toBeTruthy());
    await fireEvent.press(view.getByTestId('ranked-filter-sort'));
    await fireEvent.press(view.getByLabelText(/^Runtime/));
    await fireEvent.press(view.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(view.getByLabelText(/Sorted by Runtime/)).toBeTruthy());

    await view.rerender(<RankedTitlesSheet category="tv_seasons" {...props} />);
    await waitFor(() => expect(view.getByLabelText(/Sorted by Rank, highest first\./)).toBeTruthy());
  });

  it('names somebody else’s collection on the filter sheet', async () => {
    mockMovies = films;
    const view = await open();
    await waitFor(() => expect(view.getByText(/A Horror/)).toBeTruthy());
    await fireEvent.press(view.getByTestId('ranked-filter-sort'));
    expect(view.getByLabelText("Filter and sort Anna's collection")).toBeTruthy();
  });
});
