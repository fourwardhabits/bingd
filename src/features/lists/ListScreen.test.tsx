import { fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

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

  it('attributes it, without saying which mode it is in', async () => {
    const screen = await open();

    await waitFor(() => screen.getByText('Best breakup movies'));
    screen.getByText('Maya Chen · @maya');
    // A viewer is deliberately not told whether they are reading a public or a
    // link-only list.
    for (const chip of ['Only you', 'Link', 'Profile']) {
      expect(screen.queryByText(chip)).toBeNull();
    }
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

  it('shows the progress line as plain text, and never as a bar', async () => {
    const screen = await open();

    await waitFor(() => screen.getByText(/You’ve seen 5 of 14/));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('says "my Watchlist" on the bulk button', async () => {
    const screen = await open();

    // §H: on somebody else's list the bare noun is ambiguous about whose it is.
    await waitFor(() => screen.getByRole('button', { name: /to my Watchlist$/ }));
  });

  it('reports what the bulk add actually did', async () => {
    const screen = await open();
    await waitFor(() => screen.getByRole('button', { name: /to my Watchlist$/ }));
    await fireEvent.press(screen.getByRole('button', { name: /to my Watchlist$/ }));

    await waitFor(() => screen.getByText("Added 9 to your Watchlist. 5 you've seen were skipped."));
    expect(mockTracked).toContainEqual({
      name: 'list_watchlist_bulk_added',
      props: { added: 9, skipped_seen: 5 },
    });
  });

  it('offers no Share when the server says it is not shareable', async () => {
    const screen = await open();

    await waitFor(() => screen.getByText('Best breakup movies'));
    expect(screen.queryByLabelText(/^Share /)).toBeNull();
  });

  it('offers Report rather than Edit', async () => {
    const screen = await open();

    await waitFor(() => screen.getByText('Best breakup movies'));
    await fireEvent.press(screen.getByLabelText('More options for Best breakup movies'));

    await waitFor(() => screen.getByLabelText('Report list'));
    expect(screen.queryByLabelText('Edit list')).toBeNull();
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

  it('shows the progress line too, which is the reason to reopen it', async () => {
    const screen = await open();

    // §Q.5: the headline utility list is the one somebody made for themselves.
    await waitFor(() => screen.getByText(/You’ve seen 4 of 12/));
  });

  it('suppresses the progress line on an empty list', async () => {
    mockProgress = { seen: 0, total: 0 };
    mockItems = [];
    const screen = await open();

    await waitFor(() => screen.getByText('Best breakup movies'));
    expect(screen.queryByText(/You’ve seen/)).toBeNull();
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

  it('asks before turning a private list into a link', async () => {
    const screen = await open();

    await waitFor(() => screen.getByLabelText('Share Best breakup movies'));
    await fireEvent.press(screen.getByLabelText('Share Best breakup movies'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls.at(-1)?.[0]).toBe(
      'Anyone with this link can view this list.',
    );
    // The reassurance is absent on a public profile, where it would be a promise the
    // product is not making.
    expect(alertSpy.mock.calls.at(-1)?.[1]).not.toContain("They won't see your profile");
    // Nothing is converted until the prompt is answered.
    expect(mockRpc).not.toHaveBeenCalledWith('update_list', expect.anything());
  });

  it('adds the private-profile line when that is the true and reassuring fact', async () => {
    mockProfile.visibility = 'private';
    const screen = await open();

    await waitFor(() => screen.getByLabelText('Share Best breakup movies'));
    await fireEvent.press(screen.getByLabelText('Share Best breakup movies'));

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

    await waitFor(() => screen.getByLabelText('Save Film a'));
    await fireEvent.press(screen.getByLabelText('Save Film a'));

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
