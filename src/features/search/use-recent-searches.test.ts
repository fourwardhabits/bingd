import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useRecentSearches } from './use-recent-searches';

// Prefixed so jest's hoisting allows the factory below to reach it.
const mockStore = new Map<string, unknown>();

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockStore.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    mockStore.set(name, value);
    return Promise.resolve();
  },
}));

beforeEach(() => mockStore.clear());

const mount = async (userId = 'user-1') => {
  const view = await renderHook(() => useRecentSearches(userId));
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  return view;
};

describe('useRecentSearches', () => {
  it('keeps the newest search first', async () => {
    const { result } = await mount();

    await act(async () => result.current.remember('inception'));
    await act(async () => result.current.remember('dune'));

    expect(result.current.recent).toEqual(['dune', 'inception']);
  });

  it('moves a repeated search rather than listing it twice', async () => {
    const { result } = await mount();

    await act(async () => result.current.remember('inception'));
    await act(async () => result.current.remember('dune'));
    await act(async () => result.current.remember('Inception'));

    // One entry, in the spelling last used. Case-sensitive dedupe would keep
    // both and the list would fill with the same search in different shift
    // states.
    expect(result.current.recent).toEqual(['Inception', 'dune']);
  });

  it('ignores a query too short to have been a search', async () => {
    const { result } = await mount();

    await act(async () => result.current.remember('i'));
    await act(async () => result.current.remember('  '));

    expect(result.current.recent).toEqual([]);
  });

  it('trims, so a trailing space is not a second entry', async () => {
    const { result } = await mount();

    await act(async () => result.current.remember('dune '));
    await act(async () => result.current.remember('dune'));

    expect(result.current.recent).toEqual(['dune']);
  });

  it('holds five and drops the oldest', async () => {
    const { result } = await mount();

    for (const query of ['one', 'two', 'three', 'four', 'five', 'six']) {
      await act(async () => result.current.remember(query));
    }

    expect(result.current.recent).toEqual(['six', 'five', 'four', 'three', 'two']);
  });

  it('survives a remount', async () => {
    const first = await mount();
    await act(async () => first.result.current.remember('inception'));

    const second = await mount();
    expect(second.result.current.recent).toEqual(['inception']);
  });

  it('keeps one person\u2019s searches out of another\u2019s', async () => {
    // Two accounts on one device. Search history is personal enough that leaking
    // it across a sign-out is a privacy bug, not a cache bug.
    const alice = await mount('alice');
    await act(async () => alice.result.current.remember('inception'));

    const bob = await mount('bob');
    expect(bob.result.current.recent).toEqual([]);
  });

  it('clears', async () => {
    const { result } = await mount();
    await act(async () => result.current.remember('inception'));

    await act(async () => result.current.clear());
    expect(result.current.recent).toEqual([]);

    const remounted = await mount();
    expect(remounted.result.current.recent).toEqual([]);
  });

  it('starts empty when the stored value is not a list of strings', async () => {
    // Storage is JSON a previous version wrote, so its shape is an assumption
    // rather than a guarantee. A crash on the search screen is a bad way to
    // discover the format changed.
    mockStore.set('user-1.search.recent', { nonsense: true });

    const { result } = await mount();
    expect(result.current.recent).toEqual([]);
  });
});
