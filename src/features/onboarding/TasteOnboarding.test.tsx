import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { TAB_ROUTES } from '@/lib/routes';

import { resetTasteIntent } from './use-taste-onboarding';

// Not colocated with the route: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
import TasteScreen from '../../../app/onboarding/taste';

const mockRpc = jest.fn();
const mockReplace = jest.fn();
const mockPrefs = new Map<string, unknown>();
let mockWriteFails = false;
const mockTableRows: Record<string, unknown[]> = {};
/** Rows a `count: 'exact', head: true` select should report, keyed by table. */
const mockCounts: Record<string, number> = {};

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    if (mockWriteFails) return Promise.reject(new Error('secure store unavailable'));
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const rows = () => mockTableRows[table] ?? [];
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        filter: () => chain,
        limit: () => chain,
        order: () => Promise.resolve({ data: rows(), error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows(), error: null, count: mockCounts[table] ?? rows().length }),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `operation-${(issued += 1)}` }));

const film = {
  id: 'film-1',
  kind: 'movie',
  title: 'Inception',
  release_date: '2010-07-16',
  poster_path: null,
  provenance: 'wikidata',
};

const series = {
  id: 'series-1',
  kind: 'series',
  title: 'Inception: The Series',
  release_date: '2015-01-01',
  poster_path: null,
  provenance: 'wikidata',
};

beforeEach(() => {
  issued = 0;
  mockRpc.mockReset();
  mockReplace.mockReset();
  mockPrefs.clear();
  for (const key of Object.keys(mockTableRows)) delete mockTableRows[key];
  for (const key of Object.keys(mockCounts)) delete mockCounts[key];
  mockRpc.mockImplementation((fn: string) =>
    fn === 'search_titles'
      ? Promise.resolve({ data: [film, series], error: null })
      : Promise.resolve({ data: { status: 'ok' }, error: null }),
  );
  mockTableRows.media_items = [];
  mockTableRows.rankings = [];
  mockTableRows.user_media = [];
  mockCounts.rankings = 0;
  mockCounts.user_media = 0;
  // In the flow. The screen enrols only an account the state says is new, and sends
  // anyone else to the feed — so a test that wants the screen has to say which it is.
  mockPrefs.set('user-1.onboarding.taste.phase', 'active');
  mockWriteFails = false;
  resetTasteIntent();
});

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

const open = async () => {
  const view = await renderWithProviders(<TasteScreen />);
  await waitFor(() => expect(view.getByText('Build your taste')).toBeTruthy());
  return view;
};

const search = async (view: Awaited<ReturnType<typeof open>>, term: string) => {
  await fireEvent.changeText(view.getByLabelText('Search for a film'), term);
  await waitFor(() => expect(view.getByLabelText(/Inception, 2010/)).toBeTruthy());
};

describe('the first five', () => {
  it('starts at zero of five', async () => {
    const view = await open();
    expect(view.getByLabelText('0 of 5 films ranked')).toBeTruthy();
  });

  it('offers films and never a series, because a series cannot be ranked', async () => {
    const view = await open();
    await search(view, 'inception');

    expect(view.queryByText('Inception: The Series')).toBeNull();
  });

  /**
   * The founder decision this screen exists to honour.
   *
   * The first five may be films somebody saw fifteen years ago. `LogSheet` follows a
   * bucket save with `log_watched` for today, because the sheet it belongs to displays
   * a date — and that would put five historical films into this year's Goals. This
   * screen goes straight to `set_bucket`, which writes no date, and `goals.ts` refuses
   * to count a null one.
   */
  it('records no watch date, so an old film does not land in this year’s goals', async () => {
    const view = await open();
    await search(view, 'inception');

    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('I liked it'));

    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('goes straight into the real comparison flow, with no second tap', async () => {
    const view = await open();
    await search(view, 'inception');

    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('I liked it'));

    // `rank_start` is the same session opener the Log tab drives. Nothing about the
    // ranking algorithm is reimplemented here.
    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(callsTo('rank_start')[0][1]).toMatchObject({
      p_media_item_id: 'film-1',
      p_bucket: 'loved',
    });
  });

  it('resumes where the account already is, rather than from a local counter', async () => {
    // Three placed in an earlier session. Nothing local records that; it is read back
    // off `rankings`, so closing the app is not a way to lose progress or repeat it.
    mockCounts.rankings = 3;
    mockCounts.user_media = 3;

    const view = await open();
    await waitFor(() => expect(view.getByLabelText('3 of 5 films ranked')).toBeTruthy());
  });

  it('offers the way out once five are placed', async () => {
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    const view = await renderWithProviders(<TasteScreen />);

    await waitFor(() => expect(view.getByText('That is a start')).toBeTruthy());
    expect(view.getByRole('button', { name: 'Explore For You' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'See my collection' })).toBeTruthy();
  });

  it('does not claim to know what kind of viewer five films makes somebody', async () => {
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    const view = await renderWithProviders(<TasteScreen />);
    await waitFor(() => expect(view.getByText('That is a start')).toBeTruthy());

    // No taste archetype, no "you are a…". Five films orders a list; it does not
    // characterise a person, and inventing that in the first minute would undermine
    // every honest number the app shows afterwards.
    expect(view.queryByText(/you are a/i)).toBeNull();
  });

  /**
   * Independent review, 09c. Routing sends people here and never takes them away —
   * which is what stopped the flow ejecting somebody after their first film, and which
   * makes this screen the only thing between an established account and enrolment.
   * Somebody opening the route from a deep link used to be sent to the feed by routing.
   */
  it('sends an established account away instead of enrolling it', async () => {
    mockPrefs.clear();
    mockCounts.rankings = 12;
    mockCounts.user_media = 12;

    await renderWithProviders(<TasteScreen />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/feed'));
    // And it must not have marked them as in the flow on the way past.
    expect(mockPrefs.get('user-1.onboarding.taste.phase')).toBeUndefined();
  });

  /**
   * Independent review, 09c. `writePref` is SecureStore and can fail. When the decision
   * lived only on disk, "Not now" wrote nothing, the query refetched, the account still
   * looked new, and routing sent the user straight back to the screen they had just
   * declined — a loop produced by a failed preference write.
   */
  it('honours Not now for the session even when the write fails', async () => {
    mockWriteFails = true;

    const view = await open();
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/feed'));
    // Nothing was persisted, so the flow may be offered again on a future launch. What
    // must not happen is this session deciding they still need it — the process holds
    // the decision even when the disk refused it.
    mockReplace.mockReset();
    await renderWithProviders(<TasteScreen />);

    // Sent straight back out rather than enrolled again. (The component keeps rendering
    // until navigation unmounts it, so the assertion is on the decision, not the tree.)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/feed'));
    // The disk still says they are in the flow, because the write failed. Memory is what
    // beat it — which is the whole point of holding the decision in the process.
    expect(mockPrefs.get('user-1.onboarding.taste.phase')).toBe('active');
  });

  it('lets somebody leave who cannot think of five, and remembers that', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/feed'));
    expect(mockPrefs.get('user-1.onboarding.taste.phase')).toBe('skipped');
  });
});

/**
 * "How was it?", as the founder saw it on a device — three circles piled on top of one
 * another with the labels floating over them.
 *
 * The cause was not in the chip. `BucketChip` is written with `flex: 1` so that three
 * of them take equal columns of a row; this sheet mapped them into a container that had
 * a gap and no direction, and `flex: 1` in a column of automatic height resolves each
 * chip to nothing. The row is now a component — `BucketChoices` — that both this sheet
 * and `LogSheet` render, so there is no parent left for either of them to get wrong.
 *
 * These read the layout, not a screenshot: what has to hold is the direction, the equal
 * columns and the words, none of which is a colour.
 */
describe('the rating sheet', () => {
  const flatten = (style: unknown) =>
    (Array.isArray(style) ? Object.assign({}, ...style) : (style ?? {})) as Record<
      string,
      unknown
    >;

  const openSheet = async () => {
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    return view;
  };

  it('offers the three choices, in the words the product uses', async () => {
    const view = await openSheet();

    expect(view.getAllByRole('radio').map((chip) => chip.props.accessibilityLabel)).toEqual([
      'I liked it',
      'It was fine',
      'I didn’t like it',
    ]);
  });

  it('draws them as one horizontal row rather than a stack', async () => {
    const view = await openSheet();

    // The regression guard. A column here, or an absolutely positioned chip, is the
    // broken build.
    const row = view.getByTestId('bucket-choices');
    expect(flatten(row.props.style).flexDirection).toBe('row');
    for (const chip of view.getAllByRole('radio')) {
      expect(flatten(chip.props.style).flex).toBe(1);
      expect(flatten(chip.props.style).position).toBeUndefined();
    }
  });

  it('shows the same control the Log tab shows, rather than its own copy', async () => {
    const view = await openSheet();

    // Same testID, same role, same three radios as `LogSheet.test.tsx` asserts. If one
    // surface stops using `BucketChoices`, one of the two tests goes red.
    expect(view.getByTestId('bucket-choices').props.accessibilityRole).toBe('radiogroup');
    expect(view.getAllByRole('radio')).toHaveLength(3);
  });

  it('starts with nothing chosen, because nobody has chosen yet', async () => {
    const view = await openSheet();

    for (const chip of view.getAllByRole('radio')) {
      expect(chip.props.accessibilityState.selected).toBe(false);
    }
  });

  /**
   * The sheet's own content block, found by walking up from the row rather than
   * through a testID added for this test's benefit. Everything asserted about the
   * sheet's shape lives on it: the gutter, the clearance under the drag handle, and
   * the fact that it scrolls at all.
   */
  const contentBlock = (view: Awaited<ReturnType<typeof openSheet>>) => {
    let node = view.getByTestId('bucket-choices').parent;
    while (node && node.props.contentContainerStyle === undefined) node = node.parent;
    if (!node) throw new Error('the choices are not inside a scrolling content block');
    return node;
  };

  it('keeps the sheet content off the edge and clear of the drag handle', async () => {
    const view = await openSheet();

    // The heading sat flush against the left edge of the sheet, because the body
    // carried no horizontal padding at all.
    const body = flatten(contentBlock(view).props.contentContainerStyle);
    expect(body.paddingHorizontal).toBe(16);
    expect(body.paddingTop).toBeGreaterThan(0);
  });

  it('offers a way out that is not the scrim, and writes nothing on the way', async () => {
    const view = await openSheet();

    // `Sheet` hides its backdrop from the accessibility tree, so tapping outside is
    // not a route a screen reader can take. Leaving must not cost a rating, and it
    // must not leave a title behind either.
    // A real 44pt target rather than a word with `hitSlop` around it: slop that
    // reaches past its parent's bounds is not delivered on Android.
    const close = view.getByRole('button', { name: 'Close' });
    expect(flatten(close.props.style).minHeight).toBe(44);

    await fireEvent.press(close);

    await waitFor(() => expect(view.queryByText('How was it?')).toBeNull());
    expect(callsTo('set_bucket')).toHaveLength(0);
    expect(callsTo('rank_start')).toHaveLength(0);
    expect(view.getByLabelText('0 of 5 films ranked')).toBeTruthy();
  });

  it('scrolls, so the largest text sizes cannot put a choice out of reach', async () => {
    const view = await openSheet();

    // `Sheet` caps itself at 90% of the window. The Log tab's sheet scrolls for exactly
    // this reason; this one did not, and at the largest accessibility text sizes the
    // third choice and the helper text went somewhere nobody could get to.
    expect(contentBlock(view).type).toBe('RCTScrollView');
  });

  it('stores the middle bucket the middle words mean', async () => {
    const view = await openSheet();
    await fireEvent.press(view.getByLabelText('It was fine'));

    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    expect(callsTo('set_bucket')[0][1]).toEqual({
      p_media_item_id: 'film-1',
      p_bucket: 'fine',
      p_operation_id: expect.any(String),
    });
    // And the comparison flow still opens on the same bucket, unchanged by the layout.
    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(callsTo('rank_start')[0][1]).toMatchObject({
      p_media_item_id: 'film-1',
      p_bucket: 'fine',
    });
  });

  it('stores not_for_me for the last of the three, not the camelCase id', async () => {
    const view = await openSheet();
    await fireEvent.press(view.getByLabelText('I didn’t like it'));

    // The chip's id is `notForMe`; what is written — and what the comparison session
    // is opened on — is `not_for_me`. This is the one place that mapping is visible
    // from the surface, so it is asserted here.
    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    expect(callsTo('set_bucket')[0][1]).toEqual({
      p_media_item_id: 'film-1',
      p_bucket: 'not_for_me',
      p_operation_id: expect.any(String),
    });
    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(callsTo('rank_start')[0][1]).toMatchObject({
      p_media_item_id: 'film-1',
      p_bucket: 'not_for_me',
    });
  });
});


/**
 * **Where the last screen of onboarding actually sends people.**
 *
 * The founder tapped "Explore For You" on a physical device and landed on the Feed.
 *
 * The root cause was not a typo. `leave()` did `complete()` and then
 * `router.replace('/(tabs)/feed')`, with the destination written into the helper rather
 * than passed to it — so one function served two buttons that mean two different things,
 * and the one whose label makes a promise was the one silently broken. A bare
 * `'/(tabs)/feed'` looks correct wherever it appears; nothing about it says which button
 * it belongs to.
 *
 * The second half of the trap is that **the tab labels and the route names disagree on
 * purpose**: the bar reads For you and the route is `recommendations`, because the file
 * was never renamed. So a screen navigating by the word on the bar guesses wrong.
 *
 * These assert the destination by route, which is what `TAB_ROUTES` exists to make
 * checkable — an index would pass today and break the next time the bar is reordered.
 */
describe('where onboarding lets go', () => {
  const finished = () => {
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;
    return renderWithProviders(<TasteScreen />);
  };

  it('sends Explore For You to the For You tab', async () => {
    const view = await finished();
    await waitFor(() => expect(view.getByText('That is a start')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Explore For You' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(TAB_ROUTES.forYou));
    // The bug, named. Not "some route other than feed" — the exact wrong answer.
    expect(mockReplace).not.toHaveBeenCalledWith(TAB_ROUTES.feed);
  });

  it('names the route rather than the label, because those differ', async () => {
    const view = await finished();
    await waitFor(() => expect(view.getByText('That is a start')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Explore For You' }));

    // The tab says "For you" and the file is `recommendations`. Asserted literally so
    // that a future rename of one has to account for the other.
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/recommendations'));
  });

  it('still sends See my collection to the collection', async () => {
    const view = await finished();
    await waitFor(() => expect(view.getByText('That is a start')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'See my collection' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(TAB_ROUTES.collection));
  });

  /**
   * Declining is not exploring. Somebody who would not rank five films is put where the
   * app has something to show them that is not about their own taste yet — which is the
   * Feed, and is the one destination that did not change.
   */
  it('leaves Not now on the feed', async () => {
    mockCounts.rankings = 0;
    mockCounts.user_media = 0;
    const view = await renderWithProviders(<TasteScreen />);
    await waitFor(() => expect(view.getByText('Build your taste')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(TAB_ROUTES.feed));
  });

  it('completes the flow before it navigates, either way', async () => {
    const view = await finished();
    await waitFor(() => expect(view.getByText('That is a start')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Explore For You' }));

    // The destination changed; what it is a destination *from* did not. The phase is
    // recorded in prefs — an account left `active` would be held on this screen again on
    // the next launch, which is the half of `leave` that had to survive the fix.
    await waitFor(() => expect([...mockPrefs.values()]).toContain('done'));
  });
});
