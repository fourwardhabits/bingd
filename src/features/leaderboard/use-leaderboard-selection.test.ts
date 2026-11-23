import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useLeaderboardSelection } from './use-leaderboard-selection';

/**
 * The board's remembered category and timeframe (founder brief 2026-11-23 §2), at the hook:
 * the races `FeedMode.test.tsx` cannot stage through a screen — a read that lands after a
 * choice, and an account switch while a read is still in flight.
 */

type Deferred = { name: string; resolve: (value: unknown) => void; reject: (e: Error) => void };

const mockStore: Record<string, unknown> = {};
const mockWrites: { name: string; value: unknown }[] = [];
/** When set, reads park here instead of answering, so a test decides when each lands. */
let mockParked: Deferred[] | null = null;

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) =>
    mockParked
      ? new Promise((resolve, reject) => mockParked!.push({ name, resolve, reject }))
      : Promise.resolve(mockStore[name] ?? null),
  writePref: (name: string, value: unknown) => {
    mockWrites.push({ name, value });
    mockStore[name] = value;
    return Promise.resolve();
  },
}));

beforeEach(() => {
  for (const key of Object.keys(mockStore)) delete mockStore[key];
  mockWrites.length = 0;
  mockParked = null;
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('useLeaderboardSelection', () => {
  it('defaults to All Titles and All time', async () => {
    const { result } = await renderHook(() => useLeaderboardSelection('a'));
    await settle();
    expect(result.current.metric).toBe('titles');
    expect(result.current.timeframe).toBe('all_time');
  });

  it('restores both after a relaunch, per account', async () => {
    mockStore['a.leaderboard.metric'] = 'tv';
    mockStore['a.leaderboard.timeframe'] = 'month';
    const { result } = await renderHook(() => useLeaderboardSelection('a'));
    await waitFor(() => expect(result.current.metric).toBe('tv'));
    expect(result.current.timeframe).toBe('month');
  });

  it('keeps an existing This month preference stored under the old key', async () => {
    mockStore['a.leaderboard.timeframe'] = 'month';
    const { result } = await renderHook(() => useLeaderboardSelection('a'));
    await waitFor(() => expect(result.current.timeframe).toBe('month'));
    expect(result.current.metric).toBe('titles');
  });

  it('writes each choice under the account it was made on', async () => {
    const { result } = await renderHook(() => useLeaderboardSelection('a'));
    await settle();
    await act(async () => result.current.changeMetric('reviews'));
    await act(async () => result.current.changeTimeframe('month'));
    expect(mockWrites).toEqual([
      { name: 'a.leaderboard.metric', value: 'reviews' },
      { name: 'a.leaderboard.timeframe', value: 'month' },
    ]);
    expect(result.current.metric).toBe('reviews');
    expect(result.current.timeframe).toBe('month');
  });

  it('never lets an older read overwrite a newer choice', async () => {
    mockStore['a.leaderboard.metric'] = 'movies';
    mockStore['a.leaderboard.timeframe'] = 'month';
    mockParked = [];
    const { result } = await renderHook(() => useLeaderboardSelection('a'));
    await waitFor(() => expect(mockParked).toHaveLength(2));

    // The reader chooses before the store answers.
    await act(async () => result.current.changeMetric('tv'));
    expect(result.current.metric).toBe('tv');

    // The stale read lands with what was stored before the choice: the choice stands, and
    // the field not chosen is restored.
    const before: Record<string, unknown> = {
      'a.leaderboard.metric': 'movies',
      'a.leaderboard.timeframe': 'month',
    };
    await act(async () => {
      for (const read of mockParked!) read.resolve(before[read.name]);
    });
    await settle();
    expect(result.current.metric).toBe('tv');
    expect(result.current.timeframe).toBe('month');
  });

  it('leaks nothing to the next account while its read is in flight, or after', async () => {
    mockStore['a.leaderboard.metric'] = 'reviews';
    mockStore['a.leaderboard.timeframe'] = 'month';
    const { result, rerender } = await renderHook(
      ({ id }: { id: string }) => useLeaderboardSelection(id),
      { initialProps: { id: 'a' } },
    );
    await waitFor(() => expect(result.current.metric).toBe('reviews'));

    mockParked = [];
    await rerender({ id: 'b' });
    // The render that switches already draws b's defaults, before any read answers.
    expect(result.current.metric).toBe('titles');
    expect(result.current.timeframe).toBe('all_time');

    await act(async () => {
      for (const read of mockParked!) read.resolve(mockStore[read.name] ?? null);
    });
    await settle();
    expect(result.current.metric).toBe('titles');
    expect(result.current.timeframe).toBe('all_time');
  });

  it('drops a read for an account that has already been switched away from', async () => {
    mockStore['a.leaderboard.metric'] = 'movies';
    mockParked = [];
    const { result, rerender } = await renderHook(
      ({ id }: { id: string }) => useLeaderboardSelection(id),
      { initialProps: { id: 'a' } },
    );
    await waitFor(() => expect(mockParked).toHaveLength(2));
    const aReads = mockParked!.splice(0);

    await rerender({ id: 'b' });
    await waitFor(() => expect(mockParked).toHaveLength(2));
    // a's read lands late, while b is signed in.
    await act(async () => {
      for (const read of aReads) read.resolve(mockStore[read.name] ?? null);
    });
    await settle();
    expect(result.current.metric).toBe('titles');
  });

  it('restores an account’s own choice on returning to it, before its read lands', async () => {
    const { result, rerender } = await renderHook(
      ({ id }: { id: string }) => useLeaderboardSelection(id),
      { initialProps: { id: 'a' } },
    );
    await settle();
    await act(async () => result.current.changeTimeframe('month'));
    await rerender({ id: 'b' });
    await settle();
    expect(result.current.timeframe).toBe('all_time');

    // Back to a, with its stored value deliberately stale: the in-memory choice wins.
    mockStore['a.leaderboard.timeframe'] = 'all_time';
    await rerender({ id: 'a' });
    await settle();
    expect(result.current.timeframe).toBe('month');
  });

  it('ignores stored values the controls have no option for, and a failed read', async () => {
    mockStore['a.leaderboard.metric'] = 'watched';
    mockStore['a.leaderboard.timeframe'] = 'this_week';
    const { result } = await renderHook(() => useLeaderboardSelection('a'));
    await settle();
    expect(result.current.metric).toBe('titles');
    expect(result.current.timeframe).toBe('all_time');

    mockParked = [];
    const failing = await renderHook(() => useLeaderboardSelection('c'));
    await waitFor(() => expect(mockParked).toHaveLength(2));
    await act(async () => {
      for (const read of mockParked!) read.reject(new Error('store unavailable'));
    });
    await settle();
    expect(failing.result.current.metric).toBe('titles');
    expect(failing.result.current.timeframe).toBe('all_time');
  });
});
