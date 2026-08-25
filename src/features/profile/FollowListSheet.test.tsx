import { act, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

/**
 * Followers and Following, as sheets (founder follow-up parts L–N).
 *
 * The privacy is asserted where it lives — `supabase/tests/follow-lists.test.mjs`, under
 * real row security, because `followers_of` is `security invoker` and a harness that
 * skips policies would test nothing. What is left for this file is the half the server
 * cannot enforce:
 *
 *   · the **search goes to the server**, so it can find somebody who is not in the page
 *     already loaded. A client-side filter would pass every other test here and report
 *     "no matches" for a real follower the moment a list is longer than one page.
 *   · **the next page is asked for**, so "first 30 forever" is not what a long list gets.
 *   · the row **does not offer to follow the reader themselves**.
 */

const mockRpc: { calls: { name: string; args: Record<string, unknown> }[]; pages: Record<string, unknown>[][] } =
  { calls: [], pages: [] };

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      mockRpc.calls.push({ name, args });
      if (name === 'follow_state_with') return { data: [], error: null };
      const offset = Number(args.p_offset ?? 0);
      const query = (args.p_query as string | null) ?? null;
      // The server searches the whole list, so a query is answered from a set the client
      // has never seen — which is exactly what the client cannot do for itself.
      const source = query ? mockRpc.pages.flat().filter((r) => matches(r, query)) : null;
      if (source) return { data: source, error: null };
      const page = mockRpc.pages.find((_, index) => index * 50 === offset) ?? [];
      return { data: page, error: null };
    },
  },
  startSessionRefresh: () => () => {},
}));

const matches = (row: Record<string, unknown>, query: string) =>
  String(row.username).includes(query) || String(row.display_name ?? '').includes(query);

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('./FollowControl', () => ({
  // Stood in for, because what this file is about is the list and its paging. The real
  // control's own behaviour — Follow, Requested, the unfollow confirmation — is tested
  // where it lives.
  FollowControl: ({ isSelf, name }: { isSelf: boolean; name: string }) => {
    const { Text } = jest.requireActual('react-native');
    return isSelf ? null : <Text>{`control:${name}`}</Text>;
  },
}));

import { FollowListSheet } from './FollowListSheet';

const person = (n: number, over: Record<string, unknown> = {}) => ({
  user_id: `u${n}`,
  username: `person${n}`,
  display_name: `Person ${n}`,
  avatar_path: null,
  visibility: 'public',
  ...over,
});

const pageOf = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => person(from + i));

beforeEach(() => {
  mockRpc.calls = [];
  mockRpc.pages = [];
});

const open = async (over: Partial<React.ComponentProps<typeof FollowListSheet>> = {}) =>
  renderWithProviders(
    <FollowListSheet
      kind="followers"
      userId="subject-1"
      name="Anna"
      viewerId="viewer-1"
      isSelf={false}
      onClose={jest.fn()}
      {...over}
    />,
  );

describe('which list it is', () => {
  it('asks for followers when it is the Followers list', async () => {
    mockRpc.pages = [[person(1)]];
    const view = await open();

    await waitFor(() => expect(view.getByText('Person 1')).toBeTruthy());
    expect(mockRpc.calls.some((c) => c.name === 'followers_of')).toBe(true);
    expect(mockRpc.calls.some((c) => c.name === 'following_of')).toBe(false);
  });

  it('asks for following when it is the Following list', async () => {
    mockRpc.pages = [[person(1)]];
    const view = await open({ kind: 'following' });

    await waitFor(() => expect(view.getByText('Person 1')).toBeTruthy());
    expect(mockRpc.calls.some((c) => c.name === 'following_of')).toBe(true);
    expect(mockRpc.calls.some((c) => c.name === 'followers_of')).toBe(false);
  });

  it('renders nothing at all when neither is open', async () => {
    const view = await open({ kind: null });
    // The providers the test harness wraps everything in are still there; what must be
    // absent is the sheet.
    expect(view.queryByText('Followers')).toBeNull();
    expect(view.queryByText('Following')).toBeNull();
    // And it runs no query: a sheet that is closed should cost nothing.
    expect(mockRpc.calls).toEqual([]);
  });
});

describe('searching', () => {
  /**
   * The defect a client-side filter would have.
   *
   * `person60` is on the second page and has never been fetched. Typing its name must
   * still find it, which is only possible if the query reached the server.
   */
  it('finds somebody who is not in the page already loaded', async () => {
    mockRpc.pages = [pageOf(1, 50), pageOf(51, 12)];
    const view = await open();

    await waitFor(() => expect(view.getByText('Person 1')).toBeTruthy());
    expect(view.queryByText('Person 60')).toBeNull();

    await act(async () => {
      fireEvent.changeText(view.getByLabelText('Search followers'), 'person60');
    });

    await waitFor(() => expect(view.getByText('Person 60')).toBeTruthy());
    const search = mockRpc.calls.filter((c) => c.args.p_query === 'person60');
    expect(search.length).toBeGreaterThan(0);
  });

  it('sends no query for an empty box, rather than an empty string', async () => {
    mockRpc.pages = [[person(1)]];
    const view = await open();
    await waitFor(() => expect(view.getByText('Person 1')).toBeTruthy());

    // `null` and `''` behave the same server-side, but only one of them says "no filter"
    // in the log the founder will read when a list looks wrong.
    const first = mockRpc.calls.find((c) => c.name === 'followers_of');
    expect(first?.args.p_query).toBeNull();
  });

  it('says so when a search finds nothing, and differently from an empty list', async () => {
    mockRpc.pages = [[person(1)]];
    const view = await open();
    await waitFor(() => expect(view.getByText('Person 1')).toBeTruthy());

    await act(async () => {
      fireEvent.changeText(view.getByLabelText('Search followers'), 'nobody');
    });

    await waitFor(() => expect(view.getByText('No matches')).toBeTruthy());
  });
});

describe('a list longer than one page', () => {
  it('asks for the next page when the reader reaches the end of this one', async () => {
    mockRpc.pages = [pageOf(1, 50), pageOf(51, 12)];
    const view = await open();

    await waitFor(() => expect(view.getByText('Person 1')).toBeTruthy());
    expect(view.queryByText('Person 60')).toBeNull();

    await act(async () => {
      fireEvent.scroll(view.getByText('Person 1'), {
        nativeEvent: {
          layoutMeasurement: { height: 400, width: 300 },
          contentOffset: { y: 4000, x: 0 },
          contentSize: { height: 4200, width: 300 },
        },
      });
    });

    await waitFor(() => expect(view.getByText('Person 60')).toBeTruthy());
    expect(mockRpc.calls.some((c) => c.name === 'followers_of' && c.args.p_offset === 50)).toBe(
      true,
    );
  });

  it('does not ask for a second page when the first one was short', async () => {
    mockRpc.pages = [pageOf(1, 3)];
    const view = await open();
    await waitFor(() => expect(view.getByText('Person 1')).toBeTruthy());

    await act(async () => {
      fireEvent.scroll(view.getByText('Person 1'), {
        nativeEvent: {
          layoutMeasurement: { height: 400, width: 300 },
          contentOffset: { y: 4000, x: 0 },
          contentSize: { height: 4200, width: 300 },
        },
      });
    });

    // A short page is the last page. Asking again would be one empty round trip every
    // time somebody flicks the bottom of a three-person list.
    expect(mockRpc.calls.filter((c) => c.name === 'followers_of').length).toBe(1);
  });
});

describe('the rows', () => {
  it('offers a follow control for other people', async () => {
    mockRpc.pages = [[person(1)]];
    const view = await open();

    await waitFor(() => expect(view.getByText('control:Person 1')).toBeTruthy());
  });

  /**
   * A real case rather than a defensive one: anybody looking at their own Followers list
   * may also appear in somebody else's, and a button offering to follow yourself is one
   * the server would refuse.
   */
  it('offers none for the reader themselves', async () => {
    mockRpc.pages = [[person(1, { user_id: 'viewer-1' })]];
    const view = await open();

    await waitFor(() => expect(view.getByText('Person 1')).toBeTruthy());
    expect(view.queryByText('control:Person 1')).toBeNull();
  });

  it('names somebody by handle when they have set no display name', async () => {
    mockRpc.pages = [[person(1, { display_name: null })]];
    const view = await open();

    await waitFor(() => expect(view.getByText('person1')).toBeTruthy());
    expect(view.queryByText('Someone')).toBeNull();
  });
});
