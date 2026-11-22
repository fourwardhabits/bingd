import { useQuery, useQueryClient } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useDismissReceived } from './use-dismiss-received';
import type { SentRecommendation } from './use-sent-to-you';
import type { TitleRecommendation } from './use-title-recommendations';

/**
 * `useDismissReceived` (20261130001200): Remove from Sent to You, optimistic, with Undo.
 *
 * The rows live in a real query under the real key (`['sent-to-you', viewerId]`), so every
 * optimistic write, rollback and reconciliation is asserted on the cache the list draws.
 */

type Answer = { data: unknown; error: unknown };
const mockRpc = jest.fn();
let mockAnswers: Record<string, () => Promise<Answer>> = {};
/** What the server holds as dismissed, written by the default answers below. */
const mockDismissed = new Set<string>();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const answer = mockAnswers[name];
      if (answer) return answer();
      const id = (args as { p_recommendation_id?: string }).p_recommendation_id ?? '';
      if (name === 'dismiss_received_recommendation') mockDismissed.add(id);
      if (name === 'restore_received_recommendation') mockDismissed.delete(id);
      return Promise.resolve({ data: { status: 'ok' }, error: null });
    },
  },
}));

let mockOp = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${++mockOp}` }));

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

const VIEWER = 'account-a';
let server: SentRecommendation[] = [];
let sentFetches = 0;
/** When set, the next list read waits for it and answers with what the server held then. */
let gate: Promise<void> | null = null;
let bannerFetches = 0;

/** The tab's list, the title page's card and the hook, on one client. */
const useScreen = () => {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['sent-to-you', VIEWER],
    queryFn: async () => {
      sentFetches += 1;
      const answer = server.filter((r) => !mockDismissed.has(r.id));
      const wait = gate;
      gate = null;
      if (wait) await wait;
      return answer;
    },
    staleTime: Infinity,
  });
  const banner = useQuery({
    queryKey: ['title-recommendations', VIEWER, 'film-b'],
    queryFn: async (): Promise<TitleRecommendation[]> => {
      bannerFetches += 1;
      return [];
    },
    staleTime: Infinity,
  });
  return { list, banner, removal: useDismissReceived(VIEWER), queryClient };
};

const ids = (rows: SentRecommendation[] | undefined) => (rows ?? []).map((r) => r.id);
const calls = (name: string) => mockRpc.mock.calls.filter(([n]) => n === name);

const deferred = () => {
  let resolve: (answer: Answer) => void = () => {};
  const promise = new Promise<Answer>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const mount = async () => {
  const hook = await renderHookWithProviders(useScreen);
  await waitFor(() => expect(hook.result.current.list.isSuccess).toBe(true));
  await waitFor(() => expect(hook.result.current.banner.isSuccess).toBe(true));
  return hook;
};

beforeEach(() => {
  mockRpc.mockReset();
  mockAnswers = {};
  mockOp = 0;
  server = [row('a'), row('b'), row('c')];
  sentFetches = 0;
  bannerFetches = 0;
  gate = null;
  mockDismissed.clear();
});

describe('useDismissReceived', () => {
  it('removes the row at once, sends one operation id, and offers Undo', async () => {
    const { result } = await mount();

    await act(async () => {
      await result.current.removal.remove(row('b'));
    });

    expect(ids(result.current.list.data)).toEqual(['a', 'c']);
    expect(calls('dismiss_received_recommendation')).toEqual([
      ['dismiss_received_recommendation', { p_operation_id: 'op-1', p_recommendation_id: 'b' }],
    ]);
    expect(result.current.removal.notice).toMatchObject({
      message: 'Removed “Film b” from Sent to You',
      action: { kind: 'undo', label: 'Undo' },
      tone: 'info',
    });
    // Nothing else: not opened, not seen, not the watchlist, not a request, not For You.
    expect(mockRpc.mock.calls.map(([n]) => n)).toEqual(['dismiss_received_recommendation']);
  });

  it('refreshes the title page’s card, and reads the list again once the server agrees', async () => {
    const { result } = await mount();
    const listBefore = sentFetches;
    const bannerBefore = bannerFetches;
    server = [row('a'), row('c')];

    await act(async () => {
      await result.current.removal.remove(row('b'));
    });

    await waitFor(() => expect(bannerFetches).toBeGreaterThan(bannerBefore));
    await waitFor(() => expect(sentFetches).toBeGreaterThan(listBefore));
    expect(
      ids(
        result.current.queryClient.getQueryData<SentRecommendation[]>(['sent-to-you', VIEWER]),
      ),
    ).toEqual(['a', 'c']);
  });

  it('Undo restores it in the same place with a fresh operation id', async () => {
    const { result } = await mount();
    await act(async () => {
      await result.current.removal.remove(row('b'));
    });

    await act(async () => {
      await result.current.removal.undo();
    });

    expect(ids(result.current.list.data)).toEqual(['a', 'b', 'c']);
    expect(calls('restore_received_recommendation')).toEqual([
      ['restore_received_recommendation', { p_operation_id: 'op-2', p_recommendation_id: 'b' }],
    ]);
    expect(result.current.removal.notice).toBeNull();
  });

  it('a list read started while the dismissal is out cannot bring the row back (Codex, #371)', async () => {
    const pending = deferred();
    mockAnswers.dismiss_received_recommendation = () => pending.promise;
    const { result } = await mount();

    await act(async () => {
      void result.current.removal.remove(row('b'));
    });
    // A pull to refresh leaves while the dismissal is out, before it commits: it reads the
    // server's list with the row still on it, and answers late.
    let release: () => void = () => {};
    gate = new Promise((done) => {
      release = done;
    });
    await act(async () => {
      void result.current.queryClient.refetchQueries({ queryKey: ['sent-to-you', VIEWER] });
    });

    server = [row('a'), row('c')];
    await act(async () => {
      pending.resolve({ data: { status: 'ok', dismissed: true }, error: null });
    });
    await act(async () => {
      release();
      await new Promise((done) => setTimeout(done, 20));
    });

    await waitFor(() =>
      expect(
        ids(
          result.current.queryClient.getQueryData<SentRecommendation[]>([
            'sent-to-you',
            VIEWER,
          ]),
        ),
      ).toEqual(['a', 'c']),
    );
  });

  it('a list read in flight when Undo is pressed cannot drop the restored row (Codex, #371)', async () => {
    const { result } = await mount();
    await act(async () => {
      await result.current.removal.remove(row('b'));
    });

    // A pull to refresh leaves with the server's post-dismissal list and is slow to answer.
    server = [row('a'), row('c')];
    let release: () => void = () => {};
    gate = new Promise((done) => {
      release = done;
    });
    await act(async () => {
      void result.current.queryClient.refetchQueries({ queryKey: ['sent-to-you', VIEWER] });
    });

    // Undo: the server has the row again once the restore lands.
    mockAnswers.restore_received_recommendation = async () => {
      server = [row('a'), row('b'), row('c')];
      mockDismissed.delete('b');
      return { data: { status: 'ok', restored: true }, error: null };
    };
    await act(async () => {
      await result.current.removal.undo();
    });
    await act(async () => {
      release();
    });

    await waitFor(() =>
      expect(
        ids(
          result.current.queryClient.getQueryData<SentRecommendation[]>([
            'sent-to-you',
            VIEWER,
          ]),
        ),
      ).toEqual(['a', 'b', 'c']),
    );
    // And it stays there: the stale read was cancelled, not merely outrun.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(
      ids(
        result.current.queryClient.getQueryData<SentRecommendation[]>(['sent-to-you', VIEWER]),
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it('after a lost dismissal reply, Undo replays it under its own id before restoring (Codex, #371)', async () => {
    let dismissCalls = 0;
    mockAnswers.dismiss_received_recommendation = async () => {
      dismissCalls += 1;
      // The first reply is lost; the replay is answered by the ledger.
      return dismissCalls === 1
        ? { data: null, error: { code: '', message: 'Network request failed' } }
        : { data: { status: 'already_applied' }, error: null };
    };
    const { result } = await mount();
    await act(async () => {
      await result.current.removal.remove(row('b'));
    });

    await act(async () => {
      await result.current.removal.undo();
    });

    const sent = mockRpc.mock.calls.map(([name, args]) => [
      name,
      (args as { p_operation_id: string }).p_operation_id,
    ]);
    expect(sent).toEqual([
      ['dismiss_received_recommendation', 'op-1'],
      ['dismiss_received_recommendation', 'op-1'],
      ['restore_received_recommendation', 'op-2'],
    ]);
  });

  it('when even the replay cannot be established, Undo says so and sends no restore', async () => {
    mockAnswers.dismiss_received_recommendation = async () => ({
      data: null,
      error: { code: '', message: 'Network request failed' },
    });
    const { result } = await mount();
    await act(async () => {
      await result.current.removal.remove(row('b'));
    });

    await act(async () => {
      await result.current.removal.undo();
    });

    expect(calls('dismiss_received_recommendation')).toHaveLength(2);
    expect(calls('restore_received_recommendation')).toHaveLength(0);
    expect(result.current.removal.notice?.message).toBe(
      'Couldn’t put “Film b” back. Try again.',
    );
  });

  it('an Undo pressed before the dismissal answered waits for it', async () => {
    const pending = deferred();
    mockAnswers.dismiss_received_recommendation = () => pending.promise;
    const { result } = await mount();

    let undone: Promise<void> = Promise.resolve();
    await act(async () => {
      void result.current.removal.remove(row('b'));
      undone = result.current.removal.undo();
    });
    // The restore has not left yet: it would arrive first and find nothing to restore.
    expect(calls('restore_received_recommendation')).toHaveLength(0);

    await act(async () => {
      pending.resolve({ data: { status: 'ok', dismissed: true }, error: null });
      await undone;
    });
    expect(mockRpc.mock.calls.map(([n]) => n)).toEqual([
      'dismiss_received_recommendation',
      'restore_received_recommendation',
    ]);
    // Read from the cache the list draws from: the restore put the row back there.
    expect(
      ids(
        result.current.queryClient.getQueryData<SentRecommendation[]>(['sent-to-you', VIEWER]),
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it('puts the row back and says so when the server refuses', async () => {
    mockAnswers.dismiss_received_recommendation = () =>
      Promise.resolve({ data: null, error: { code: '42501', message: 'suspended' } });
    const { result } = await mount();

    await act(async () => {
      await result.current.removal.remove(row('b'));
    });

    expect(ids(result.current.list.data)).toEqual(['a', 'b', 'c']);
    expect(result.current.removal.notice).toMatchObject({
      message: 'Your account cannot make changes right now.',
      tone: 'error',
    });
  });

  it('a backend without the function puts the row back rather than hiding it', async () => {
    mockAnswers.dismiss_received_recommendation = () =>
      Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    const { result } = await mount();

    await act(async () => {
      await result.current.removal.remove(row('a'));
    });

    expect(ids(result.current.list.data)).toEqual(['a', 'b', 'c']);
    expect(result.current.removal.notice?.message).toBe('Couldn’t remove “Film a”. Try again.');
  });

  it('refetches when nobody knows whether it landed', async () => {
    mockAnswers.dismiss_received_recommendation = () =>
      Promise.resolve({ data: null, error: { code: '', message: 'Network request failed' } });
    const { result } = await mount();
    const before = sentFetches;
    // The server did commit it: the refetch is what tells the list so.
    server = [row('a'), row('c')];

    await act(async () => {
      await result.current.removal.remove(row('b'));
    });

    await waitFor(() => expect(sentFetches).toBeGreaterThan(before));
    await waitFor(() => expect(ids(result.current.list.data)).toEqual(['a', 'c']));
  });

  it('a refused Undo takes the row out again and says so', async () => {
    mockAnswers.restore_received_recommendation = () =>
      Promise.resolve({ data: null, error: { code: 'P0001', message: 'no' } });
    const { result } = await mount();
    await act(async () => {
      await result.current.removal.remove(row('c'));
    });

    await act(async () => {
      await result.current.removal.undo();
    });

    expect(ids(result.current.list.data)).toEqual(['a', 'b']);
    expect(result.current.removal.notice?.message).toBe(
      'Couldn’t put “Film c” back. Try again.',
    );
  });

  it('removes one sender’s row of a title and leaves another sender’s', async () => {
    const ada = row('ada', { mediaItemId: 'film-x' });
    server = [ada, row('ben', { mediaItemId: 'film-x' })];
    const { result } = await mount();

    await act(async () => {
      await result.current.removal.remove(ada);
    });

    expect(ids(result.current.list.data)).toEqual(['ben']);
  });

  it('closing the notice keeps the removal, and an Undo after it does nothing', async () => {
    const { result } = await mount();
    await act(async () => {
      await result.current.removal.remove(row('a'));
    });

    await act(async () => result.current.removal.close());
    await act(async () => {
      await result.current.removal.undo();
    });

    expect(result.current.removal.notice).toBeNull();
    expect(ids(result.current.list.data)).toEqual(['b', 'c']);
    expect(calls('restore_received_recommendation')).toHaveLength(0);
  });
});
