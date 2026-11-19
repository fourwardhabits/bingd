import { useQuery } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react-native';

import { queryKeys } from '@/lib/query';
import { renderHookWithProviders } from '@/test-utils/render';

import { applyMove, ladderOf, type Ladder } from './rerank';
import type { CollectionItem } from './filters';
import type { RankedEntry } from './use-collection';
import { NOTICE_MS, useRerank } from './use-rerank';
import type { ReorderResult } from './writes';

/**
 * #318: one move path for a drag, an accessibility action, Undo and Retry. The server is
 * mocked at `reorderRanking`; everything above it — the prediction, the rollback, the
 * reconciliation, the operation ids — is the real hook against a real QueryClient.
 */

const mockReorder = jest.fn<Promise<ReorderResult>, [Record<string, unknown>]>();
let issued = 0;

jest.mock('./writes', () => ({
  reorderRanking: (input: Record<string, unknown>) => mockReorder(input),
  newOperationId: () => `op-${(issued += 1)}`,
}));

const USER = 'user-1';
const KEY = queryKeys.rankings(USER, 'movies');

const pool = (): RankedEntry[] =>
  (['a', 'b', 'c', 'd'] as const).map(
    (id, i) =>
      ({
        mediaItemId: id,
        title: `Title ${id}`,
        position: i + 1,
        bucket: i < 3 ? 'loved' : 'fine',
        category: 'movies',
      }) as unknown as RankedEntry,
  );

const ladderFrom = (entries: RankedEntry[]): Ladder =>
  ladderOf(
    [...entries]
      .sort((x, y) => x.position - y.position)
      .map(
        (e) =>
          ({
            mediaItemId: e.mediaItemId,
            title: e.title,
            score: 5,
            position: e.position,
            bucket: e.bucket,
            category: 'movies',
          }) as unknown as CollectionItem,
      ),
    'movies',
  ) as Ladder;

const order = (entries: RankedEntry[] | undefined) =>
  [...(entries ?? [])].sort((x, y) => x.position - y.position).map((e) => e.mediaItemId);

/** The pool as the server holds it: what a refetch returns. */
let server: RankedEntry[] = [];

/** The server applies the move it was sent, and says so. */
const lands = (score = 10) => async (input: Record<string, unknown>): Promise<ReorderResult> => {
  const from = server.find((e) => e.mediaItemId === input.mediaItemId)?.position ?? 0;
  server =
    applyMove(
      server,
      String(input.mediaItemId),
      Number(input.toPosition),
      input.toBucket ? (String(input.toBucket) as RankedEntry['bucket']) : undefined,
    ) ?? server;
  return {
    outcome: 'moved',
    reply: {
      moved: true,
      position: Number(input.toPosition),
      fromPosition: from,
      bucket: input.toBucket ? String(input.toBucket) : null,
      fromBucket: null,
      score,
      fromScore: 7,
    },
  };
};

/** A server answer the test releases when it chooses. */
const deferred = () => {
  let resolve!: (value: ReorderResult) => void;
  const promise = new Promise<ReorderResult>((r) => (resolve = r));
  return { promise, resolve };
};

/** The hook, beside a mounted read of the pool, as Collection mounts them. */
const setup = async () => {
  server = pool();
  const hook = await renderHookWithProviders(() => {
    useQuery({ queryKey: KEY, queryFn: async () => server });
    return useRerank(USER);
  });
  await waitFor(() => expect(hook.client.getQueryData(KEY)).toBeDefined());
  return hook;
};

beforeEach(() => {
  mockReorder.mockReset();
  issued = 0;
  jest.useRealTimers();
});

describe('a move', () => {
  it('reorders the cache at once, before the server answers, and sends both guards', async () => {
    const { result, client } = await setup();
    const answer = deferred();
    mockReorder.mockReturnValueOnce(answer.promise);

    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 0);
    });

    await waitFor(() => expect(order(client.getQueryData(KEY))).toEqual(['c', 'a', 'b', 'd']));
    expect(result.current.busy).toBe(true);
    expect(mockReorder).toHaveBeenCalledWith({
      operationId: 'op-1',
      mediaItemId: 'c',
      toPosition: 1,
      expectedPosition: 3,
      anchorId: 'a',
      toBucket: undefined,
      expectedBucket: 'loved',
    });

    await act(async () => answer.resolve(await lands()({ mediaItemId: 'c', toPosition: 1 })));
    expect(result.current.busy).toBe(false);
    expect(result.current.notice).toMatchObject({
      message: 'Moved “Title c” to #1 · 10.0',
      action: { kind: 'undo' },
    });
  });

  it('reconciles every cache a ranking touches once the server agrees', async () => {
    const { result, client } = await setup();
    const spy = jest.spyOn(client, 'invalidateQueries');
    mockReorder.mockImplementationOnce(lands());
    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 0);
    });
    const keys = spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toContain(JSON.stringify(KEY));
    expect(keys).toContain(JSON.stringify(queryKeys.myScores(USER)));
    expect(keys).toContain(JSON.stringify(['feed', USER]));
  });

  it('a no-op sends nothing', async () => {
    const { result, client } = await setup();
    await act(async () => {
      expect(result.current.move(ladderFrom(pool()), 1, 1)).toEqual({ kind: 'noop' });
    });
    expect(mockReorder).not.toHaveBeenCalled();
    expect(order(client.getQueryData(KEY))).toEqual(['a', 'b', 'c', 'd']);
  });

  /**
   * **Across a category** (founder, 2026-11-19): c (I liked it) dropped onto d (It was
   * fine) is It was fine at 4. The cache takes the new category at once, so both
   * categories' scores reflow before the server answers, and Undo names the old category.
   */
  it('a drop across a category is sent with its category, predicted, and undone back', async () => {
    const { result, client } = await setup();
    const answer = deferred();
    mockReorder.mockReturnValueOnce(answer.promise);
    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 3);
    });
    const predicted = client.getQueryData<RankedEntry[]>(KEY);
    expect(order(predicted)).toEqual(['a', 'b', 'd', 'c']);
    expect(predicted?.find((e) => e.mediaItemId === 'c')?.bucket).toBe('fine');
    expect(mockReorder).toHaveBeenCalledWith({
      operationId: 'op-1',
      mediaItemId: 'c',
      toPosition: 4,
      expectedPosition: 3,
      anchorId: 'd',
      toBucket: 'fine',
      expectedBucket: 'loved',
    });
    await act(async () =>
      answer.resolve(await lands(4.6)({ mediaItemId: 'c', toPosition: 4, toBucket: 'fine' })),
    );
    expect(result.current.notice?.message).toBe('Moved “Title c” to It was fine · #4 · 4.6');

    mockReorder.mockImplementationOnce(lands(7));
    await act(async () => {
      result.current.undo();
    });
    expect(mockReorder).toHaveBeenLastCalledWith({
      operationId: 'op-2',
      mediaItemId: 'c',
      toPosition: 3,
      expectedPosition: 4,
      anchorId: 'd',
      toBucket: 'loved',
      expectedBucket: 'fine',
    });
    const restored = client.getQueryData<RankedEntry[]>(KEY);
    expect(order(restored)).toEqual(['a', 'b', 'c', 'd']);
    expect(restored?.find((e) => e.mediaItemId === 'c')?.bucket).toBe('loved');
    expect(result.current.notice?.message).toBe('Moved “Title c” back to I liked it · #3');
  });

  it('one move at a time: a second drop while the first is in flight is not sent', async () => {
    const { result } = await setup();
    const answer = deferred();
    mockReorder.mockReturnValueOnce(answer.promise);
    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 0);
    });
    await act(async () => {
      expect(result.current.move(ladderFrom(pool()), 1, 0)).toBeNull();
    });
    expect(mockReorder).toHaveBeenCalledTimes(1);
    await act(async () => answer.resolve(await lands()({ mediaItemId: 'c', toPosition: 1 })));
  });
});

describe('when the server says no', () => {
  it('stale: rolls back, refetches the pool and says the ranking changed', async () => {
    const { result, client } = await setup();
    const spy = jest.spyOn(client, 'invalidateQueries');
    mockReorder.mockResolvedValueOnce({ outcome: 'stale' });
    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 0);
    });
    expect(order(client.getQueryData(KEY))).toEqual(['a', 'b', 'c', 'd']);
    expect(spy.mock.calls.map(([f]) => JSON.stringify(f?.queryKey))).toContain(JSON.stringify(KEY));
    expect(result.current.notice).toMatchObject({ tone: 'error' });
    expect(result.current.notice?.message).toContain('changed on another device');
  });

  it('outside (the server backstop): rolls back, refetches and says so', async () => {
    const { result, client } = await setup();
    const spy = jest.spyOn(client, 'invalidateQueries');
    mockReorder.mockResolvedValueOnce({ outcome: 'outside' });
    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 3);
    });
    const after = client.getQueryData<RankedEntry[]>(KEY);
    expect(order(after)).toEqual(['a', 'b', 'c', 'd']);
    expect(after?.find((e) => e.mediaItemId === 'c')?.bucket).toBe('loved');
    expect(spy).toHaveBeenCalled();
    expect(result.current.notice).toMatchObject({ tone: 'error' });
    expect(result.current.notice?.message).toContain('refreshed');
  });

  it('a lost reply: rolls back, reconciles, and Retry resends the SAME operation id', async () => {
    const { result, client } = await setup();
    const spy = jest.spyOn(client, 'invalidateQueries');
    mockReorder.mockResolvedValueOnce({ outcome: 'failed', message: 'Network request failed', changed: true });
    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 0);
    });
    expect(order(client.getQueryData(KEY))).toEqual(['a', 'b', 'c', 'd']);
    expect(spy).toHaveBeenCalled();
    expect(result.current.notice).toMatchObject({ action: { kind: 'retry' }, tone: 'error' });

    mockReorder.mockImplementationOnce(lands());
    await act(async () => {
      result.current.retry();
    });
    expect(mockReorder).toHaveBeenCalledTimes(2);
    expect(mockReorder.mock.calls[1]?.[0]).toMatchObject({ operationId: 'op-1', mediaItemId: 'c', toPosition: 1 });
    expect(order(client.getQueryData(KEY))).toEqual(['c', 'a', 'b', 'd']);
    expect(result.current.notice?.action?.kind).toBe('undo');
  });

  it('a definite refusal does not reconcile what never changed', async () => {
    const { result, client } = await setup();
    const spy = jest.spyOn(client, 'invalidateQueries');
    mockReorder.mockResolvedValueOnce({ outcome: 'failed', message: 'suspended', changed: false });
    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 0);
    });
    expect(spy).not.toHaveBeenCalled();
    expect(order(client.getQueryData(KEY))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('Undo', () => {
  it('is a second guarded move back, under a new operation id', async () => {
    const { result, client } = await setup();
    mockReorder.mockImplementationOnce(lands());
    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 0);
    });
    mockReorder.mockImplementationOnce(lands(7));
    await act(async () => {
      result.current.undo();
    });
    expect(mockReorder.mock.calls[1]?.[0]).toEqual({
      operationId: 'op-2',
      mediaItemId: 'c',
      toPosition: 3,
      expectedPosition: 1,
      // After the move, b holds #3: c is put back directly below it.
      anchorId: 'b',
      toBucket: undefined,
      expectedBucket: 'loved',
    });
    expect(order(client.getQueryData(KEY))).toEqual(['a', 'b', 'c', 'd']);
    expect(result.current.notice?.message).toBe('Moved “Title c” back to #3');
    expect(result.current.notice?.action).toBeUndefined();
  });

  it('is gone once the confirmation fades', async () => {
    jest.useFakeTimers();
    const { result } = await setup();
    mockReorder.mockImplementationOnce(lands());
    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 0);
    });
    await act(async () => {
      jest.advanceTimersByTime(NOTICE_MS + 1);
    });
    expect(result.current.notice).toBeNull();
    await act(async () => {
      result.current.undo();
    });
    expect(mockReorder).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('errors stay until dismissed', async () => {
    jest.useFakeTimers();
    const { result } = await setup();
    mockReorder.mockResolvedValueOnce({ outcome: 'stale' });
    await act(async () => {
      result.current.move(ladderFrom(pool()), 2, 0);
    });
    await act(async () => {
      jest.advanceTimersByTime(NOTICE_MS * 3);
    });
    expect(result.current.notice?.tone).toBe('error');
    await act(async () => {
      result.current.dismiss();
    });
    expect(result.current.notice).toBeNull();
    jest.useRealTimers();
  });
});
