import { fireEvent, waitFor } from '@testing-library/react-native';

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
      data: category === 'movies' ? mockMovies : mockSeasons,
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

  fireEvent.press(view.getByText('TV'));

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

  const enabled = mockAsked.filter((call) => call.enabled).map((call) => call.category);
  expect(enabled).toEqual(['tv_seasons']);
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
 * A subtitle stating the order is a subtitle nobody can act on. Four orders and no more:
 * two directions on rank, two on when the title entered the ranking.
 *
 * **Why the second axis is "Recently ranked" and not "Recently watched".** The founder
 * asked for recency, and the watch date cannot carry it: PRD §22 makes watch dates
 * private "on any profile, at any visibility, to anybody", and `logged_collection` — the
 * projection a visitor's read goes through — omits the column deliberately. A control
 * labelled *Recently watched* over somebody else's list would either sort by something
 * else or reverse that rule in passing. So the axis is when the title entered their
 * ranking, which is the same instant their public "ranked X" activity already carries.
 */
describe('the sort control', () => {
  const openSort = async (view: Awaited<ReturnType<typeof open>>) => {
    await fireEvent.press(view.getByLabelText(/^Sort\./));
  };

  /** The titles in draw order, read off the ordinal-and-title rows. */
  const drawn = (view: Awaited<ReturnType<typeof open>>) =>
    view.getAllByLabelText(/, 20\d\d/).map((node) => String(node.props.accessibilityLabel));

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

    await waitFor(() => expect(view.getByLabelText('Sort. Rank · Highest first')).toBeTruthy());
    // Position 1 is the top of the band, so highest first is ascending position.
    expect(drawn(view)[0]).toMatch(/Second ranked/);
    expect(drawn(view)[2]).toMatch(/First ranked/);
  });

  it('reverses to lowest first', async () => {
    mockMovies = three;
    const view = await open();
    await openSort(view);
    await fireEvent.press(view.getByLabelText('Rank · Lowest first'));

    await waitFor(() => expect(drawn(view)[0]).toMatch(/First ranked/));
    expect(drawn(view)[2]).toMatch(/Second ranked/);
  });

  it('orders by when the title entered the ranking, newest first', async () => {
    mockMovies = three;
    const view = await open();
    await openSort(view);
    await fireEvent.press(view.getByLabelText('Recently ranked · Newest first'));

    await waitFor(() => expect(drawn(view)[0]).toMatch(/Third ranked/));
    expect(drawn(view)[2]).toMatch(/First ranked/);
    expect(view.getByLabelText('Sort. Recently ranked · Newest first')).toBeTruthy();
  });

  it('and oldest first', async () => {
    mockMovies = three;
    const view = await open();
    await openSort(view);
    await fireEvent.press(view.getByLabelText('Recently ranked · Oldest first'));

    await waitFor(() => expect(drawn(view)[0]).toMatch(/First ranked/));
    expect(drawn(view)[2]).toMatch(/Third ranked/);
  });

  it('puts a title with no date last, whichever direction is asked for', async () => {
    // `rankings.created_at` is `not null`, so this can only be a bundle reading a
    // response without the column. "Last, always" is the answer that does not put an
    // unknown at the top of a list claiming to be newest — and it is why the date test
    // comes before the direction rather than inside it.
    mockMovies = [
      entry({ mediaItemId: 'a', title: 'Dated', position: 2, rankedAt: '2026-01-01T00:00:00Z' }),
      entry({ mediaItemId: 'b', title: 'Undated', position: 1, rankedAt: null }),
    ];
    const view = await open();

    await openSort(view);
    await fireEvent.press(view.getByLabelText('Recently ranked · Newest first'));
    await waitFor(() => expect(drawn(view)[1]).toMatch(/Undated/));

    await openSort(view);
    await fireEvent.press(view.getByLabelText('Recently ranked · Oldest first'));
    await waitFor(() => expect(drawn(view)[1]).toMatch(/Undated/));
  });

  it('breaks a tie the same way every time', async () => {
    // `position` is unique per category, so the rank orders have no ties to break. The
    // id tiebreak is there anyway: a comparator that is total only by accident of a
    // constraint elsewhere is one schema change from reordering itself between renders.
    mockMovies = [
      entry({ mediaItemId: 'zz', title: 'Later id', position: 1, rankedAt: '2026-01-01T00:00:00Z' }),
      entry({ mediaItemId: 'aa', title: 'Earlier id', position: 2, rankedAt: '2026-01-01T00:00:00Z' }),
    ];
    const view = await open();
    await openSort(view);
    await fireEvent.press(view.getByLabelText('Recently ranked · Newest first'));

    await waitFor(() => expect(drawn(view)[0]).toMatch(/Earlier id/));
    expect(drawn(view)[1]).toMatch(/Later id/);
  });

  it('keeps the Movies and TV selection, which is a different question', async () => {
    mockMovies = three;
    const onChangeCategory = jest.fn();
    const view = await open({ onChangeCategory });

    await openSort(view);
    await fireEvent.press(view.getByLabelText('Rank · Lowest first'));

    // Sorting is not switching lists, and it must not behave as though it were.
    expect(onChangeCategory).not.toHaveBeenCalled();
    await fireEvent.press(view.getByText('TV'));
    expect(onChangeCategory).toHaveBeenCalledWith('tv_seasons');
  });

  it('scores against the whole category, not against the order on screen', async () => {
    // The band is measured over everything and the sort is applied to the rows, so a
    // reordered list does not re-score anybody. `#N` is the position, which means the
    // same thing under every order.
    mockMovies = three;
    const view = await open();
    await openSort(view);
    await fireEvent.press(view.getByLabelText('Recently ranked · Oldest first'));

    await waitFor(() => expect(view.getByText('#3')).toBeTruthy());
    expect(view.getByText('#1')).toBeTruthy();
    expect(view.getByText('#2')).toBeTruthy();
  });
});
