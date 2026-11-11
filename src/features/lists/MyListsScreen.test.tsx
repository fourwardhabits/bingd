import { fireEvent, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import MyListsScreen from '../../../app/lists/index';

/**
 * The My lists screen — zero, one and ~10 (§N).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY BEING PINNED
 *
 * **The three list states**, because an empty management screen is the state most new
 * accounts will meet and it is the one place in this feature that has to explain what a
 * list is for.
 *
 * **`my_lists_opened.entry`**, which is the discoverability tripwire (§M, §Q.6). Both
 * doors reach this identical screen, so the param is the only place the difference
 * survives — and the fallback matters as much as the value: the event's vocabulary is
 * closed, and a typo in a `router.push` must not open it.
 *
 * **That it reads `my_lists`**, the one reader that returns every visibility and takes
 * no owner argument. A management screen reading `profile_lists` would silently lose
 * every private and link-only list the account has.
 */

type Row = {
  id: string;
  title: string;
  item_count: number;
  order_style: 'ranked' | 'unranked';
  visibility: 'private' | 'link' | 'public';
  hidden: boolean;
  updated_at: string;
  posters: string[] | null;
};

let mockRows: Row[] = [];
let mockCalls: { fn: string; args: Record<string, unknown> }[] = [];
let mockFails = false;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      mockCalls.push({ fn, args });
      if (mockFails) {
        return Promise.resolve({ data: null, error: { code: '08006', message: 'no connection' } });
      }
      return Promise.resolve({ data: fn === 'my_lists' ? mockRows : [], error: null });
    },
  },
  startSessionRefresh: () => () => {},
}));

const mockTracked: { name: string; props?: Record<string, unknown> }[] = [];
jest.mock('@/lib/analytics', () => ({
  track: (event: { name: string; props?: Record<string, unknown> }) => mockTracked.push(event),
}));

const mockParams: { entry?: string } = {};
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack, replace: mockReplace, canGoBack: () => mockCanGoBack }),
  useLocalSearchParams: () => mockParams,
  // The header's right corner is drawn in place, so its New list can be pressed.
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => unknown } }) => options?.headerRight?.() ?? null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
    visibility: 'public',
  }),
}));

const list = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  title: `List ${id}`,
  item_count: 8,
  order_style: 'unranked',
  visibility: 'private',
  hidden: false,
  updated_at: '2026-09-12T10:00:00Z',
  posters: null,
  ...over,
});

beforeEach(() => {
  mockRows = [];
  mockCalls = [];
  mockFails = false;
  mockTracked.length = 0;
  mockPush.mockClear();
  delete mockParams.entry;
});

const open = () => renderWithProviders(<MyListsScreen />);

describe('the three states', () => {
  it('explains what a list is when there are none', async () => {
    const view = await open();

    await waitFor(() => view.getByText('No lists yet'));
    // The copy is doing real work here: it is the one place the product says what a
    // list is *for*, and it names the default before anybody has to discover it.
    view.getByText(/It stays private until you choose to share it/);
    view.getByRole('button', { name: 'Create a list' });
  });

  it('draws one list with its three facts', async () => {
    mockRows = [list('a', { title: 'Movies for Dad', item_count: 8 })];
    const view = await open();

    await waitFor(() => view.getByText('Movies for Dad'));
    view.getByText('8 titles');
    view.getByText('Only you');
    view.getByText(/^Updated /);
  });

  it('draws ten, each with its own chip, and Numbered only where it applies', async () => {
    mockRows = [
      list('a', { title: 'Oscar catch-up', visibility: 'link', order_style: 'ranked' }),
      list('b', { title: 'Best breakup movies', visibility: 'public', order_style: 'ranked' }),
      list('c', { title: 'Movies for Dad' }),
      ...Array.from({ length: 7 }, (_, i) => list(`x${i}`, { title: `Spare ${i}` })),
    ];
    const view = await open();

    await waitFor(() => view.getByText('Oscar catch-up'));
    view.getByText('Anyone with the link');
    view.getByText('Public');
    // Three lists carry a `Numbered`-less state; the two ranked ones carry it.
    expect(view.queryAllByText('Numbered')).toHaveLength(2);
  });

  it('offers a retry rather than a blank screen when the read fails', async () => {
    mockFails = true;
    const view = await open();

    await waitFor(() => view.getByText('Could not load your lists'));
    view.getByRole('button', { name: 'Try again' });
  });

  it('keeps New list working while the read has failed', async () => {
    mockFails = true;
    const view = await open();
    await waitFor(() => view.getByText('Could not load your lists'));
    await fireEvent.press(view.getByTestId('my-lists-new'));
    await waitFor(() => view.getByText('Create list'));
  });
});

describe('the discoverability tripwire', () => {
  it('fires once per mount, with the entry it was pushed with', async () => {
    mockParams.entry = 'profile_manage';
    mockRows = [list('a'), list('b')];
    await open();

    await waitFor(() => expect(mockTracked).toHaveLength(1));
    expect(mockTracked[0]).toEqual({
      name: 'my_lists_opened',
      props: { entry: 'profile_manage', owned_count: 2 },
    });
  });

  it('falls back rather than passing a value the event does not define', async () => {
    // The vocabulary is closed. A typo in a `router.push` must not open it, and an
    // unrecognised value reaching PostHog would be a series nobody could read.
    mockParams.entry = 'somewhere_else';
    await open();

    await waitFor(() => expect(mockTracked).toHaveLength(1));
    expect(mockTracked[0]?.props?.entry).toBe('collection');
  });

  it('waits for the count rather than reporting a zero it does not know', async () => {
    // Firing before the read answered would send `owned_count: 0` for every account — a
    // number that looks like a finding and is an artefact.
    mockRows = [list('a')];
    const view = await open();

    await waitFor(() => view.getByText('List a'));
    expect(mockTracked).toHaveLength(1);
    expect(mockTracked[0]?.props?.owned_count).toBe(1);
  });
});

describe('what it reads', () => {
  it('asks my_lists, which is the reader that returns every visibility', async () => {
    await open();

    await waitFor(() => expect(mockCalls.length).toBeGreaterThan(0));
    expect(mockCalls.every((call) => call.fn === 'my_lists')).toBe(true);
    // No owner argument to pass. That is precisely why this reader may return link and
    // private lists: it cannot be pointed at another account (§F.6).
    expect(mockCalls[0]?.args).not.toHaveProperty('p_owner_id');
  });
});

describe('navigation', () => {
  it('opens a list, and says where from', async () => {
    mockRows = [list('a', { title: 'Movies for Dad' })];
    const view = await open();

    await waitFor(() => view.getByText('Movies for Dad'));
    await fireEvent.press(view.getByLabelText(/^Movies for Dad\./));

    expect(mockPush).toHaveBeenCalledWith('/lists/a?surface=my_lists');
  });
});

/**
 * **New list in the header's corner** (founder, marquee cohesion sprint, 2026-11-07),
 * rather than a bordered button heading the rows.
 */
describe('creating', () => {
  it('offers New list in the header, a 44pt target, and not as a row above the lists', async () => {
    mockRows = [list('a', { title: 'Movies for Dad' })];
    const view = await open();
    await waitFor(() => view.getByText('Movies for Dad'));
    const create = view.getByTestId('my-lists-new');
    expect(create.props.accessibilityLabel).toBe('New list');
    const style = StyleSheet.flatten(
      typeof create.props.style === 'function' ? create.props.style({ pressed: false }) : create.props.style,
    );
    expect(style.minHeight).toBe(44);
    expect(view.getAllByRole('button', { name: 'New list' })).toHaveLength(1);
  });
});

/**
 * **The bingd. header, then MY LISTS** (founder Preview QA, 2026-11-07): the tabs' header
 * with a back chevron, and the page's own section label with New list opposite.
 */
describe('the header', () => {
  it('draws the bingd. header with Back, and MY LISTS with New list beside it', async () => {
    mockRows = [list('a', { title: 'Movies for Dad' })];
    const view = await open();
    await waitFor(() => view.getByText('Movies for Dad'));
    expect(view.getByTestId('app-header')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(view.getByText('MY LISTS')).toBeTruthy();
    expect(view.getByTestId('my-lists-new')).toBeTruthy();
  });

  /**
   * **No blank band above MY LISTS** (founder, UI consistency sprint, 2026-11-10). The row's
   * own 44pt — SectionHeader's minimum and New list's target — is its only vertical space:
   * no padding stacked on top of it, and nothing hidden with a negative margin.
   */
  it('puts the MY LISTS row straight under the header, with no padding of its own above it', async () => {
    mockRows = [];
    const view = await open();
    // The empty state renders under the same header and row as a populated page.
    await waitFor(() => view.getByText('No lists yet'));
    const row = StyleSheet.flatten(view.getByTestId('my-lists-title-row').props.style);
    expect(row.paddingTop ?? 0).toBe(0);
    expect(row.paddingVertical ?? 0).toBe(0);
    expect(row.padding ?? 0).toBe(0);
    expect(row.marginTop ?? 0).toBe(0);
    // The header itself is intact, and New list keeps its full target.
    expect(view.getByTestId('app-header')).toBeTruthy();
    expect(view.getByText('MY LISTS')).toBeTruthy();
    const create = view.getByTestId('my-lists-new');
    const style = StyleSheet.flatten(
      typeof create.props.style === 'function' ? create.props.style({ pressed: false }) : create.props.style,
    );
    expect(style.minHeight).toBe(44);
  });
});

describe('Back', () => {
  beforeEach(() => {
    mockBack.mockClear();
    mockReplace.mockClear();
  });

  it('goes back where there is somewhere to go', async () => {
    mockCanGoBack = true;
    const view = await open();
    await fireEvent.press(view.getByRole('button', { name: 'Back' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  /** Opened cold from a link, with nothing behind it (independent review). */
  it('goes to Collection when the page was opened with nothing behind it', async () => {
    mockCanGoBack = false;
    const view = await open();
    await fireEvent.press(view.getByRole('button', { name: 'Back' }));
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/collection');
    mockCanGoBack = true;
  });
});
