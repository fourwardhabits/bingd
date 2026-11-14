import { useQuery } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { resetMarkSentSeen, useMarkSentSeen } from './use-mark-sent-seen';
import { unreadCount, type SentRecommendation } from './use-sent-to-you';

/**
 * `useMarkSentSeen` (FU1113-E): what Sent to you is drawing, once loaded and on screen, is
 * marked seen — optimistically, per account, once in flight, and rolled back on failure.
 *
 * The rows come from a real query under the real key (`['sent-to-you', viewerId]`), so the
 * optimistic write and the rollback are asserted on the same cache the tab's dot reads.
 */

const mockRpc = jest.fn();
let mockAnswer: () => Promise<{ data: unknown; error: unknown }> = () =>
  Promise.resolve({ data: { status: 'ok', marked: 1 }, error: null });

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      return mockAnswer();
    },
  },
}));

let mockOp = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${++mockOp}` }));

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({
  ...jest.requireActual('@/lib/analytics'),
  track: (...args: unknown[]) => mockTrack(...args),
}));

/** A navigator whose focus the test drives, the way React Navigation emits it. */
const mockListeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
const mockListenersFor = (event: string): Set<() => void> | undefined =>
  event === 'focus' || event === 'blur' ? mockListeners[event] : undefined;
const mockNavigation = {
  focused: true,
  isFocused: () => mockNavigation.focused,
  addListener: (event: string, handler: () => void) => {
    mockListenersFor(event)?.add(handler);
    return () => mockListenersFor(event)?.delete(handler);
  },
};
jest.mock('expo-router', () => ({ useNavigation: () => mockNavigation }));

const setFocused = async (focused: boolean) => {
  mockNavigation.focused = focused;
  await act(async () => {
    for (const handler of mockListeners[focused ? 'focus' : 'blur']) handler();
  });
};

const row = (id: string, over: Partial<SentRecommendation> = {}): SentRecommendation => ({
  id,
  senderId: 's1',
  senderUsername: 'ada',
  senderName: 'Ada',
  senderAvatarUri: null,
  mediaItemId: `film-${id}`,
  kind: 'movie',
  title: `Film ${id}`,
  seriesTitle: null,
  posterPath: null,
  year: 2020,
  genres: [],
  language: null,
  runtimeMinutes: null,
  recommendedAt: '2026-11-01T00:00:00Z',
  openedAt: null,
  message: null,
  seenAt: null,
  ...over,
});

/** What each account's server would return. */
let server: Record<string, SentRecommendation[]> = {};
let viewer = 'account-a';
let shown = true;

/** The screen, reduced to what the hook needs: the list query and the hook. */
const useScreen = () => {
  const query = useQuery({
    queryKey: ['sent-to-you', viewer],
    queryFn: async () => server[viewer] ?? [],
    staleTime: Infinity,
  });
  useMarkSentSeen(viewer, query.data ?? [], shown && query.isSuccess);
  return query;
};

const markCalls = () => mockRpc.mock.calls.filter(([name]) => name === 'mark_recommendations_seen');

beforeEach(() => {
  mockRpc.mockReset();
  mockTrack.mockReset();
  mockAnswer = () => Promise.resolve({ data: { status: 'ok', marked: 1 }, error: null });
  mockNavigation.focused = true;
  mockListeners.focus.clear();
  mockListeners.blur.clear();
  server = {};
  viewer = 'account-a';
  shown = true;
  resetMarkSentSeen();
  mockOp = 0;
});

describe('useMarkSentSeen', () => {
  it('marks the unread rows in hand once the list is shown, and only those', async () => {
    server['account-a'] = [
      row('new-1'),
      row('new-2'),
      row('opened', { openedAt: '2026-11-02T00:00:00Z' }),
      row('seen', { seenAt: '2026-11-02T00:00:00Z' }),
    ];
    const { result } = await renderHookWithProviders(useScreen);

    await waitFor(() => expect(markCalls()).toHaveLength(1));
    expect(markCalls()[0][1]).toEqual({ p_operation_id: 'op-1', p_ids: ['new-1', 'new-2'] });
    await waitFor(() => expect(unreadCount(result.current.data)).toBe(0));
    // Seen is not opened, and nothing is reported as one.
    expect(result.current.data?.every((r) => r.id === 'opened' || r.openedAt === null)).toBe(true);
    expect(mockRpc).not.toHaveBeenCalledWith('mark_recommendation_opened', expect.anything());
    expect(mockTrack).not.toHaveBeenCalled();
    // The rows stay: reading removes nothing.
    expect(result.current.data).toHaveLength(4);
  });

  it('does nothing while the list is not the thing on screen (For You, Top Rated)', async () => {
    shown = false;
    server['account-a'] = [row('new-1')];
    const { result } = await renderHookWithProviders(useScreen);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(markCalls()).toHaveLength(0);
    expect(unreadCount(result.current.data)).toBe(1);
  });

  it('does nothing on a failed load', async () => {
    server = {};
    const useFailing = () => {
      const query = useQuery({
        queryKey: ['sent-to-you', 'account-a'],
        queryFn: (): Promise<SentRecommendation[]> => Promise.reject(new Error('offline')),
        retry: false,
        // This stand-in reads only `isSuccess`, which a failure does not change, so without
        // this react-query's tracked props would never re-render it. The screen reads
        // `isError` itself.
        notifyOnChangeProps: 'all',
      });
      useMarkSentSeen('account-a', query.data ?? [], query.isSuccess);
      return query;
    };
    const { result } = await renderHookWithProviders(useFailing);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(markCalls()).toHaveLength(0);
  });

  it('waits for this screen to be focused, and marks when it is', async () => {
    mockNavigation.focused = false;
    server['account-a'] = [row('new-1')];
    const { result } = await renderHookWithProviders(useScreen);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(markCalls()).toHaveLength(0);

    await setFocused(true);
    await waitFor(() => expect(markCalls()).toHaveLength(1));
  });

  it('rolls back to unread on failure, does not loop, and retries on the next focus', async () => {
    mockAnswer = () => Promise.resolve({ data: null, error: { code: '08006', message: 'down' } });
    server['account-a'] = [row('new-1')];
    const { result, rerender } = await renderHookWithProviders(useScreen);

    await waitFor(() => expect(markCalls()).toHaveLength(1));
    await waitFor(() => expect(unreadCount(result.current.data)).toBe(1));
    // Still on screen: no retry loop against a server that is down.
    await rerender({});
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(markCalls()).toHaveLength(1);

    // Leave and come back: one new attempt, with a new operation id.
    mockAnswer = () => Promise.resolve({ data: { status: 'ok', marked: 1 }, error: null });
    await setFocused(false);
    await setFocused(true);
    await waitFor(() => expect(markCalls()).toHaveLength(2));
    expect(markCalls()[1][1]).toMatchObject({ p_ids: ['new-1'] });
    expect(markCalls()[1][1].p_operation_id).not.toBe(markCalls()[0][1].p_operation_id);
    await waitFor(() => expect(unreadCount(result.current.data)).toBe(0));
  });

  /**
   * **Codex review, #290.** Leave while the call is pending, and let it fail after the
   * visit has ended: that failure belongs to the visit that sent it. It used to land after
   * the reset and block the next visit's retry until a further focus.
   */
  it('retries on the next focus when a call from the last visit fails after leaving', async () => {
    let fail: () => void = () => {};
    mockAnswer = () =>
      new Promise((done) => {
        fail = () => done({ data: null, error: { code: '08006', message: 'down' } });
      });
    server['account-a'] = [row('new-1')];
    const { result } = await renderHookWithProviders(useScreen);
    await waitFor(() => expect(markCalls()).toHaveLength(1));

    // Leave while it is pending; it fails while nobody is looking.
    await setFocused(false);
    await act(async () => fail());
    await waitFor(() => expect(unreadCount(result.current.data)).toBe(1));
    expect(markCalls()).toHaveLength(1);

    // Back: this visit has had no failure of its own, so it tries again.
    mockAnswer = () => Promise.resolve({ data: { status: 'ok', marked: 1 }, error: null });
    await setFocused(true);
    await waitFor(() => expect(markCalls()).toHaveLength(2));
    expect(markCalls()[1][1]).toMatchObject({ p_ids: ['new-1'] });
    await waitFor(() => expect(unreadCount(result.current.data)).toBe(0));
  });

  it('a thrown network error rolls back the same way', async () => {
    mockAnswer = () => Promise.reject(new Error('network'));
    server['account-a'] = [row('new-1')];
    const { result } = await renderHookWithProviders(useScreen);

    await waitFor(() => expect(markCalls()).toHaveLength(1));
    await waitFor(() => expect(unreadCount(result.current.data)).toBe(1));
  });

  it('keeps one call in flight per account', async () => {
    let finish: (value: { data: unknown; error: unknown }) => void = () => {};
    mockAnswer = () => new Promise((done) => (finish = done));
    server['account-a'] = [row('new-1')];

    const useBoth = () => {
      const first = useScreen();
      useMarkSentSeen(viewer, first.data ?? [], first.isSuccess);
      return first;
    };
    const { result } = await renderHookWithProviders(useBoth);

    await waitFor(() => expect(markCalls()).toHaveLength(1));
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(markCalls()).toHaveLength(1);

    await act(async () => finish({ data: { status: 'ok', marked: 1 }, error: null }));
    await waitFor(() => expect(unreadCount(result.current.data)).toBe(0));
    expect(markCalls()).toHaveLength(1);
  });

  it('a recommendation that arrives after the mark, while not on screen, stays unread', async () => {
    server['account-a'] = [row('first')];
    const { result, rerender, client } = await renderHookWithProviders(useScreen);
    await waitFor(() => expect(markCalls()).toHaveLength(1));
    await waitFor(() => expect(result.current.data?.[0]?.seenAt).not.toBeNull());

    shown = false;
    await rerender({});
    server['account-a'] = [row('later'), row('first', { seenAt: '2026-11-03T00:00:00Z' })];
    await act(async () => {
      await client.refetchQueries({ queryKey: ['sent-to-you', 'account-a'] });
    });

    await waitFor(() => expect(result.current.data?.[0]?.id).toBe('later'));
    expect(unreadCount(result.current.data)).toBe(1);
    expect(markCalls()).toHaveLength(1);
  });

  it('keeps each account’s cache its own across an account switch', async () => {
    server['account-a'] = [row('a-1')];
    server['account-b'] = [row('b-1'), row('b-2')];
    shown = false;
    const { result, rerender, client } = await renderHookWithProviders(useScreen);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Account A looks at Sent to You.
    shown = true;
    await rerender({});
    await waitFor(() => expect(markCalls()).toHaveLength(1));
    expect(markCalls()[0][1]).toMatchObject({ p_ids: ['a-1'] });

    // Switch to B on For You: B's own two are unread, A's mark did not touch them.
    shown = false;
    viewer = 'account-b';
    await rerender({});
    await waitFor(() => expect(result.current.data?.[0]?.id).toBe('b-1'));
    expect(unreadCount(result.current.data)).toBe(2);
    expect(markCalls()).toHaveLength(1);

    // B opens Sent to You: only B's ids, only B's cache.
    shown = true;
    await rerender({});
    await waitFor(() => expect(markCalls()).toHaveLength(2));
    expect(markCalls()[1][1]).toMatchObject({ p_ids: ['b-1', 'b-2'] });
    await waitFor(() => expect(unreadCount(result.current.data)).toBe(0));
    expect(
      unreadCount(client.getQueryData<SentRecommendation[]>(['sent-to-you', 'account-a'])),
    ).toBe(0);
  });
});
