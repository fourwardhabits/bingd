import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import ListScreen from '../../../app/lists/[id]';

/**
 * The list screen, owner and viewer.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR CLAIMS
 *
 * **Every refusal is one screen.** `list_view` answers private, deleted, hidden,
 * suspended, blocked and nonexistent with the same zero rows, and this must draw one
 * unavailable state for all of them and name no reason.
 *
 * **Progress is for the viewer and the owner alike, and it is plain text** (§Q.5). It is
 * suppressed on an empty list, where "You've seen 0 of 0" is a fact about nothing, and
 * it is never a bar, a ring or a percentage — those read as a chore tracker.
 *
 * **The bulk button says "my Watchlist".** On somebody else's list the bare noun is
 * genuinely ambiguous about whose it is, and the one word restates the §9 boundary in
 * the place a reader is standing.
 *
 * **Share follows `shareable_by_viewer`**, with one addition the server cannot express:
 * the owner of a *private* list gets a Share control that opens the consent prompt
 * first, because converting to link-only is a consequence they did not name.
 */

type Owner = {
  id?: string;
  username: string;
  display_name: string;
  avatar_path: string | null;
  profile_visible: boolean;
};

type View = {
  id: string;
  title: string;
  description?: string | null;
  order_style: 'ranked' | 'unranked';
  item_count: number;
  updated_at: string;
  is_owner: boolean;
  shareable_by_viewer: boolean;
  visibility?: 'private' | 'link' | 'public';
  hidden?: boolean;
  owner?: Owner | null;
};

type Item = {
  media_item_id: string;
  kind: 'movie' | 'season' | 'series';
  title: string;
  year: number | null;
  poster_path: string | null;
  season_number: number | null;
  parent_title: string | null;
  position: number;
  ordinal: number;
  viewer_seen: boolean | null;
  viewer_watchlisted: boolean | null;
};

/** Plain table reads: `rankings` for the reader's own scores, `media_items` for the hero. */
const mockTables: Record<string, unknown[]> = { rankings: [], media_items: [] };
let mockView: View | null = null;
let mockItems: Item[] = [];
let mockProgress: { seen: number; total: number } | null = null;
const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      mockRpc(fn, args);
      switch (fn) {
        case 'list_view':
          return Promise.resolve({ data: mockView, error: null });
        case 'list_items_page':
          return Promise.resolve({ data: mockItems, error: null });
        case 'list_viewer_progress':
          return Promise.resolve({ data: mockProgress, error: null });
        case 'add_list_to_watchlist':
          return Promise.resolve({
            data: { status: 'ok', added: 9, skipped_seen: 5, skipped_present: 0 },
            error: null,
          });
        default:
          return Promise.resolve({ data: { status: 'ok' }, error: null });
      }
    },
    from: (table: string) => {
      const rows = () => mockTables[table] ?? [];
      const chain: Record<string, unknown> = {
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows(), error: null }).then(resolve),
      };
      for (const method of ['select', 'eq', 'in', 'gt', 'lt', 'gte', 'order', 'limit', 'or']) {
        chain[method] = () => chain;
      }
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const mockTracked: { name: string; props?: Record<string, unknown> }[] = [];
jest.mock('@/lib/analytics', () => ({
  track: (event: { name: string; props?: Record<string, unknown> }) => mockTracked.push(event),
}));

const mockParams: { id?: string; surface?: string } = { id: 'list-1' };
jest.mock('expo-router', () => ({
  /**
   * The header is where this screen keeps Share and the ⋯, so a stand-in that renders
   * nothing would make both untestable — and they are two of the four claims. This
   * renders what the screen asked the navigator to draw, which is as close to the real
   * arrangement as a unit test gets.
   */
  Stack: {
    Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) =>
      options?.headerRight ? options.headerRight() : null,
  },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

const mockProfile = { visibility: 'public' as 'public' | 'private' };
jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
    visibility: mockProfile.visibility,
  }),
}));

let alertSpy: jest.SpyInstance;

const item = (id: string, over: Partial<Item> = {}): Item => ({
  media_item_id: id,
  kind: 'movie',
  title: `Film ${id}`,
  year: 2024,
  poster_path: null,
  season_number: null,
  parent_title: null,
  position: 1,
  ordinal: 1,
  viewer_seen: false,
  viewer_watchlisted: false,
  ...over,
});

const view = (over: Partial<View> = {}): View => ({
  id: 'list-1',
  title: 'Best breakup movies',
  description: 'Ones that actually help.',
  order_style: 'unranked',
  item_count: 2,
  updated_at: '2026-09-12T10:00:00Z',
  is_owner: false,
  shareable_by_viewer: false,
  owner: {
    id: 'them',
    username: 'maya',
    display_name: 'Maya Chen',
    avatar_path: null,
    profile_visible: true,
  },
  ...over,
});

beforeEach(() => {
  mockTables.rankings = [];
  mockTables.media_items = [];
  mockView = null;
  mockItems = [];
  mockProgress = null;
  mockRpc.mockClear();
  mockTracked.length = 0;
  mockProfile.visibility = 'public';
  mockParams.surface = undefined;
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  alertSpy.mockRestore();
});

const open = () => renderWithProviders(<ListScreen />);

describe('a list that cannot be read', () => {
  it('draws one unavailable state and names no reason', async () => {
    mockView = null;
    const screen = await open();

    await waitFor(() => screen.getByText('List unavailable'));
    // The same words for private, deleted, hidden, suspended, blocked and nonexistent.
    screen.getByText('This list is private, deleted, or not available yet.');
    // One sentence, and nothing beside it. Anything naming a *particular* reason would
    // make the six cases distinguishable, which is the oracle §F exists to prevent.
    expect(
      screen
        .queryAllByText(/./)
        .map((node) => String(node.props.children))
        .filter((line) => line !== 'List unavailable'),
    ).toEqual(['This list is private, deleted, or not available yet.']);
  });

  it('reports no open, because the unavailable state is not one', async () => {
    mockView = null;
    await open();

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(mockTracked.filter((event) => event.name === 'list_opened')).toHaveLength(0);
  });
});

describe("somebody else's list", () => {
  beforeEach(() => {
    mockView = view();
    mockItems = [item('a'), item('b', { position: 2, ordinal: 2, viewer_seen: true })];
    mockProgress = { seen: 5, total: 14 };
  });

  it('attributes it, and says what the Share control already implied', async () => {
    const screen = await open();

    await waitFor(() => screen.getByText('Best breakup movies'));
    screen.getByText('Maya Chen · @maya');
    // Founder QA 2026-09-21: "X/N watched · Public/Link · Updated …". A viewer's
    // shareable_by_viewer is true exactly when the list is public, and Share has always
    // followed it, so the word discloses nothing new. Never "Only you" to a viewer.
    screen.getByText('Anyone with the link');
    expect(screen.queryByText('Only you')).toBeNull();
  });

  it('says Public on a public list', async () => {
    mockView = view({ shareable_by_viewer: true });
    const screen = await open();
    await waitFor(() => screen.getByText('Public'));
  });

  it('marks a private owner with a lock, and still leads to the locked shell', async () => {
    mockView = view({
      owner: {
        username: 'maya',
        display_name: 'Maya Chen',
        avatar_path: null,
        profile_visible: false,
      },
    });
    const screen = await open();

    await waitFor(() =>
      screen.getByLabelText('Maya Chen, @maya. Private account'),
    );
  });

  it('shows the progress in the metadata as plain text, and never as a bar', async () => {
    const screen = await open();

    await waitFor(() => screen.getByText('5/14 watched'));
    expect(screen.queryByText(/You’ve seen/)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('has no bulk Add-unseen-to-Watchlist button; each unranked row carries its own', async () => {
    // Founder QA 2026-09-21: the bulk action is gone from the page (the primitive stays).
    const screen = await open();

    await waitFor(() => screen.getByText('Film a'));
    expect(screen.queryByRole('button', { name: /unseen to my Watchlist$/ })).toBeNull();
    screen.getByLabelText('Add Film a to Watchlist');
  });

  it('offers no Share when the server says it is not shareable', async () => {
    const screen = await open();

    await waitFor(() => screen.getByText('Best breakup movies'));
    expect(screen.queryByRole('button', { name: 'Share list' })).toBeNull();
  });

  it('gives a viewer no reorder, no remove and no row menu', async () => {
    const screen = await open();

    await waitFor(() => screen.getByText('Film a'));
    expect(screen.queryByLabelText('Options for Film a')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add titles' })).toBeNull();
  });

  it('offers Report rather than Edit', async () => {
    const screen = await open();

    await waitFor(() => screen.getByText('Best breakup movies'));
    await fireEvent.press(screen.getByLabelText('More options for Best breakup movies'));

    await waitFor(() => screen.getByLabelText('Report list'));
    expect(screen.queryByLabelText('Edit list settings')).toBeNull();
    expect(screen.queryByLabelText('Delete list')).toBeNull();
  });

  it('reports the open without a visibility class it was never told', async () => {
    mockParams.surface = 'profile_shelf';
    await open();

    await waitFor(() => expect(mockTracked.some((e) => e.name === 'list_opened')).toBe(true));
    const opened = mockTracked.find((event) => event.name === 'list_opened');
    expect(opened?.props).toEqual({
      surface: 'profile_shelf',
      is_owner: false,
      relation: 'other',
      visibility_class: undefined,
    });
  });
});

describe('your own list', () => {
  beforeEach(() => {
    mockView = view({
      is_owner: true,
      shareable_by_viewer: false,
      visibility: 'private',
      hidden: false,
      owner: {
        id: 'user-1',
        username: 'sai',
        display_name: 'Sai',
        avatar_path: null,
        profile_visible: true,
      },
    });
    mockItems = [item('a')];
    mockProgress = { seen: 4, total: 12 };
  });

  it('reads "4/12 watched · Only you · Updated …" in one metadata line', async () => {
    const screen = await open();

    // §Q.5: the headline utility list is the one somebody made for themselves.
    await waitFor(() => screen.getByText('4/12 watched'));
    screen.getByText('Only you');
    screen.getByText(/^Updated /);
    expect(screen.queryByText(/You’ve seen/)).toBeNull();
  });

  it('puts Add titles and Share list side by side, Share list trailing', async () => {
    const screen = await open();

    await waitFor(() => screen.getByRole('button', { name: 'Share list' }));
    // One row, the Profile pattern: the secondary act leads, the Maroon fill trails.
    const row = screen.getByTestId('list-actions');
    const labels = screen
      .queryAllByText(/^(Add titles|Share list)$/)
      .map((node) => String(node.props.children));
    expect(labels).toEqual(['Add titles', 'Share list']);
    expect(row).toBeTruthy();
  });

  it('names the list in the page, not in the bar, until the large title scrolls away', async () => {
    const screen = await open();

    await waitFor(() => screen.getByTestId('list-large-title'));
    // The compact bar title is not drawn while the large one is on screen.
    expect(screen.getAllByText('Best breakup movies')).toHaveLength(1);
  });

  it('opens the settings from the visibility in the metadata', async () => {
    const screen = await open();

    await waitFor(() => screen.getByLabelText(/^Who can see it: Only you/));
    await fireEvent.press(screen.getByLabelText(/^Who can see it: Only you/));
    await waitFor(() => screen.getByText('Edit list settings'));
  });

  it('counts titles instead of progress on an empty list', async () => {
    mockProgress = { seen: 0, total: 0 };
    mockItems = [];
    mockView = { ...mockView!, item_count: 0 };
    const screen = await open();

    await waitFor(() => screen.getByText('Best breakup movies'));
    expect(screen.queryByText(/watched$/)).toBeNull();
    screen.getByText('No titles yet');
  });

  it('puts Add titles below the progress and bulk block', async () => {
    const screen = await open();

    await waitFor(() => screen.getByRole('button', { name: 'Add titles' }));

    // §H: the owner's two actions are adjacent rather than separated by a stat line.
    const texts = screen
      .queryAllByText(/./)
      .map((node) => String(node.props.children))
      .filter(Boolean);
    const progressAt = texts.findIndex((line) => line.includes('4'));
    const addAt = texts.findIndex((line) => line === 'Add titles');
    expect(addAt).toBeGreaterThan(progressAt);
  });

  it('draws the visibility chip, which a viewer never sees', async () => {
    const screen = await open();

    await waitFor(() => screen.getByText('Only you'));
  });

  it('asks before turning a private list into a link, with a question and a distinct body', async () => {
    const screen = await open();

    await waitFor(() => screen.getByRole('button', { name: 'Share list' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Share list' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [title, body, actions] = alertSpy.mock.calls.at(-1) ?? [];
    expect(title).toBe('Make this list link-only?');
    expect(body).toBe(
      "Anyone with this link will be able to view the list. It won't appear as a public list on your profile.",
    );
    expect(body).not.toBe(title);
    expect((actions as { text: string }[]).map((a) => a.text)).toEqual(['Cancel', 'Make link-only']);
    // The reassurance is absent on a public profile, where it would be a promise the
    // product is not making.
    expect(alertSpy.mock.calls.at(-1)?.[1]).not.toContain("They won't see your profile");
    // Nothing is converted until the prompt is answered.
    expect(mockRpc).not.toHaveBeenCalledWith('update_list', expect.anything());
  });

  it('adds the private-profile line when that is the true and reassuring fact', async () => {
    mockProfile.visibility = 'private';
    const screen = await open();

    await waitFor(() => screen.getByRole('button', { name: 'Share list' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Share list' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls.at(-1)?.[1]).toContain("They won't see your profile");
  });

  it('shows the moderation banner and keeps the list readable to its owner', async () => {
    mockView = view({ is_owner: true, visibility: 'public', hidden: true, shareable_by_viewer: true });
    const screen = await open();

    await waitFor(() => screen.getByText(/hidden while it is reviewed/));
    screen.getByText('Best breakup movies');
  });

  it('reports the open with the visibility class only the owner is told', async () => {
    mockView = view({ is_owner: true, visibility: 'link', shareable_by_viewer: true });
    mockParams.surface = 'my_lists';
    await open();

    await waitFor(() => expect(mockTracked.some((e) => e.name === 'list_opened')).toBe(true));
    expect(mockTracked.find((event) => event.name === 'list_opened')?.props).toEqual({
      surface: 'my_lists',
      is_owner: true,
      relation: 'self',
      visibility_class: 'link',
    });
  });
});

describe('a list row', () => {
  beforeEach(() => {
    mockView = view({ order_style: 'ranked' });
    mockProgress = { seen: 1, total: 2 };
  });

  it('numbers the rows only when the list is numbered', async () => {
    mockItems = [item('a'), item('b', { position: 2, ordinal: 2 })];
    const numbered = await open();
    await waitFor(() => numbered.getByText('Film a'));
    // The ordinal is spoken as part of the row's own label, so the glyph itself is
    // hidden from assistive technology and needs asking for.
    expect(numbered.queryAllByText('1', { includeHiddenElements: true }).length).toBeGreaterThan(0);
    expect(numbered.queryAllByText('2', { includeHiddenElements: true }).length).toBeGreaterThan(0);
  });

  it('draws a seen title as an inert tick rather than a bookmark', async () => {
    mockItems = [item('a', { viewer_seen: true })];
    const screen = await open();

    await waitFor(() => screen.getByText('Film a'));
    // Nothing useful to offer about a title already watched, from inside a list.
    expect(screen.queryByLabelText(/^Save Film a$/)).toBeNull();
    expect(screen.queryByLabelText(/Remove Film a from your Watchlist/)).toBeNull();
  });

  it('offers the bookmark on an unseen title, and says so once it is saved', async () => {
    mockItems = [item('a')];
    const screen = await open();

    await waitFor(() => screen.getByLabelText('Add Film a to Watchlist'));
    await fireEvent.press(screen.getByLabelText('Add Film a to Watchlist'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'set_watchlist',
        expect.objectContaining({ p_media_item_id: 'a', p_present: true }),
      ),
    );
    expect(mockTracked).toContainEqual({ name: 'watchlist_added', props: { surface: 'list' } });
  });

  it('never shows a score, anybody’s', async () => {
    mockItems = [item('a')];
    const screen = await open();

    await waitFor(() => screen.getByText('Film a'));
    // §F.11. A column of numbers would quietly turn curation into a ranking the owner
    // did not make.
    expect(screen.queryByText(/\d\.\d/)).toBeNull();
  });
});

/**
 * The owner's ⋯ and the row's ⋯ (founder QA, 2026-09-21): *Edit list settings*, *Share*,
 * *Delete list*; and *Remove from list* per title.
 */
describe('the owner menus', () => {
  beforeEach(() => {
    mockView = view({
      is_owner: true,
      shareable_by_viewer: true,
      visibility: 'link',
      hidden: false,
      owner: null,
    });
    mockItems = [item('a'), item('b', { position: 2, ordinal: 2 })];
    mockProgress = { seen: 0, total: 2 };
  });

  it('offers Edit list settings, Share and Delete list', async () => {
    const screen = await open();
    await waitFor(() => screen.getByText('Best breakup movies'));
    await fireEvent.press(screen.getByLabelText('More options for Best breakup movies'));

    await waitFor(() => screen.getByLabelText('Edit list settings'));
    screen.getByLabelText('Share');
    screen.getByLabelText('Delete list');
    expect(screen.queryByLabelText('Who can see it')).toBeNull();
  });

  /**
   * Swipe left, then tap Remove (founder QA, 2026-09-21). There is no permanent ⋯ on a
   * row any more, and the swipe alone never removes anything.
   */
  it('removes one title by swiping its row open and tapping Remove', async () => {
    const screen = await open();
    await waitFor(() => screen.getByText('Film b'));
    expect(screen.queryByLabelText('Options for Film b')).toBeNull();

    const row = screen.getByTestId('swipe-row-Film b');
    const at = (x: number, y = 100) => ({ nativeEvent: { pageX: x, pageY: y } });
    await fireEvent(row, 'touchStart', at(300));
    expect(row.props.onMoveShouldSetResponder(at(290, 100))).toBe(false); // under the slop
    expect(row.props.onMoveShouldSetResponder(at(300, 160))).toBe(false); // a scroll
    expect(row.props.onMoveShouldSetResponder(at(250, 104))).toBe(true); // a swipe
    await fireEvent(row, 'responderMove', at(160, 104));
    await fireEvent(row, 'responderRelease', at(160, 104));

    // Nothing is removed by the swipe itself.
    expect(mockRpc).not.toHaveBeenCalledWith('remove_list_item', expect.anything());
    await fireEvent.press(screen.getByLabelText('Remove Film b from list'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'remove_list_item',
        expect.objectContaining({ p_list_id: 'list-1', p_media_item_id: 'b' }),
      ),
    );
  });

  it('keeps Remove reachable without the gesture, as an accessibility action', async () => {
    const screen = await open();
    await waitFor(() => screen.getByText('Film b'));
    await fireEvent(screen.getByLabelText(/^Film b /), 'accessibilityAction', {
      nativeEvent: { actionName: 'remove' },
    });
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'remove_list_item',
        expect.objectContaining({ p_media_item_id: 'b' }),
      ),
    );
  });
});

/**
 * Reorder on the list's own page (founder QA, 2026-09-21). The drag is a long-press lift
 * and a finger; the same moves are accessibility actions on each row, which is how they
 * are driven here. The arithmetic of the drag itself is `reorder.test.ts`.
 */
describe('reordering a numbered list', () => {
  beforeEach(() => {
    mockView = view({
      is_owner: true,
      shareable_by_viewer: false,
      visibility: 'private',
      hidden: false,
      order_style: 'ranked',
      owner: null,
    });
    mockItems = [
      item('a'),
      item('b', { position: 2, ordinal: 2 }),
      item('c', { position: 3, ordinal: 3 }),
    ];
    mockProgress = { seen: 0, total: 3 };
  });

  const rowLabel = (screen: Awaited<ReturnType<typeof open>>, id: string) =>
    screen.getByLabelText(new RegExp(`^\\d+\\. Film ${id} `));

  it('commits one move naming one title and its new index, and renumbers at once', async () => {
    const screen = await open();
    await waitFor(() => screen.getByText('Film a'));

    await fireEvent(rowLabel(screen, 'a'), 'accessibilityAction', {
      nativeEvent: { actionName: 'moveToBottom' },
    });

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'move_list_item',
        expect.objectContaining({ p_list_id: 'list-1', p_media_item_id: 'a', p_to_index: 2 }),
      ),
    );
    // The numbers follow the drawn order: Film a is now third, before any refetch.
    await waitFor(() => screen.getByLabelText(/^3\. Film a /));
    screen.getByLabelText(/^1\. Film b /);
  });

  it('offers no move up on the first row and no move down on the last', async () => {
    const screen = await open();
    await waitFor(() => screen.getByText('Film a'));

    const first = rowLabel(screen, 'a').props.accessibilityActions.map((a: { name: string }) => a.name);
    const last = rowLabel(screen, 'c').props.accessibilityActions.map((a: { name: string }) => a.name);
    expect(first).not.toContain('moveUp');
    expect(last).not.toContain('moveDown');
  });

  it('numbers only a numbered list', async () => {
    mockView = { ...mockView!, order_style: 'unranked' };
    const screen = await open();
    await waitFor(() => screen.getByText('Film a'));
    expect(screen.queryByLabelText(/^1\. Film a /)).toBeNull();
  });
});

/**
 * The compact-row contract on a list (founder QA, 2026-09-21; TitleRowActions): the
 * reader's own score circle when they have the title ranked, otherwise the Rank/log
 * action and the one-tap Watchlist. Never the owner's score.
 */
describe('a list row\'s trailing actions', () => {
  beforeEach(() => {
    mockView = view();
    mockProgress = { seen: 1, total: 2 };
  });

  it('shows the reader their own score circle, and no bookmark, on a title they ranked', async () => {
    mockItems = [item('a', { viewer_seen: true })];
    mockTables.rankings = [{ media_item_id: 'a', bucket: 'loved', position: 1, category: 'movies' }];
    const screen = await open();

    await waitFor(() => screen.getByLabelText(/^10\.0 out of 10/));
    expect(screen.queryByLabelText('Add Film a to Watchlist')).toBeNull();
  });

  it('shows Log and the Watchlist on a title the reader has not logged', async () => {
    mockItems = [item('a')];
    const screen = await open();

    await waitFor(() => screen.getByLabelText('Log Film a'));
    screen.getByLabelText('Add Film a to Watchlist');
  });
});

/**
 * Numbered: the number sits on the poster's own anchor, so a row does not move when
 * Numbered toggles (founder QA, 2026-09-21).
 */
describe('a numbered row keeps its geometry', () => {
  beforeEach(() => {
    mockProgress = { seen: 0, total: 1 };
    mockItems = [item('a')];
  });

  it('draws the number inside the poster box, not in a column before it', async () => {
    mockView = view({ order_style: 'ranked' });
    const screen = await open();
    await waitFor(() => screen.getByText('Film a'));

    const anchor = screen.getByTestId('list-poster-anchor-a');
    const plate = screen.getByTestId('list-number-a');
    // The plate is a child of the poster's own box, positioned against it.
    expect(within(anchor).getByTestId('list-number-a')).toBe(plate);
    const style = StyleSheet.flatten(plate.props.style) as Record<string, unknown>;
    expect(style.position).toBe('absolute');
    expect(style).toMatchObject({ left: 0, right: 0, alignItems: 'center' });
  });

  it('keeps the poster box the same size when the list is not numbered', async () => {
    mockView = view({ order_style: 'unranked' });
    const screen = await open();
    await waitFor(() => screen.getByText('Film a'));

    expect(screen.queryByTestId('list-number-a')).toBeNull();
    const style = StyleSheet.flatten(screen.getByTestId('list-poster-anchor-a').props.style);
    expect(style).toMatchObject({ width: 38, height: 57 });
  });
});
