import { act, renderHook } from '@testing-library/react-native';

import {
  hydrateTitleLayout,
  isTitleLayoutAvailable,
  resetTitleLayoutForTests,
  setTitleLayout,
  useStoredTitleLayout,
  useTitleLayout,
} from './title-layout';

/**
 * The title-page switch (Immersive Scroll experiment, 2026-11-04). Device-local, `original`
 * by default, and locked to `original` in production whatever a device stored.
 */
const mockPrefs = new Map<string, unknown>();
jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

let mockLane = 'preview';
jest.mock('@/lib/env', () => ({
  get lane() {
    return mockLane;
  },
}));

beforeEach(() => {
  mockPrefs.clear();
  mockLane = 'preview';
  // As an app launch does: nothing read yet.
  resetTitleLayoutForTests();
});

describe('the title-page switch', () => {
  it('is Original until somebody opts in', async () => {
    const { result } = await renderHook(() => useTitleLayout());
    await act(async () => {
      await hydrateTitleLayout();
    });
    expect(result.current).toBe('original');
  });

  it('switches at once, and remembers the choice on this device', async () => {
    const { result } = await renderHook(() => useTitleLayout());
    await act(async () => {
      await setTitleLayout('immersive');
    });

    expect(result.current).toBe('immersive');
    expect(mockPrefs.get('title.layout')).toBe('immersive');
  });

  it('reads a stored Immersive back at the next launch', async () => {
    mockPrefs.set('title.layout', 'immersive');
    const { result } = await renderHook(() => useTitleLayout());
    await act(async () => {
      await hydrateTitleLayout();
    });
    expect(result.current).toBe('immersive');
  });

  it('treats anything it does not recognise as Original', async () => {
    mockPrefs.set('title.layout', 'cinematic');
    const { result } = await renderHook(() => useTitleLayout());
    await act(async () => {
      await hydrateTitleLayout();
    });
    expect(result.current).toBe('original');
  });

  it('is never offered in production, and production always renders Original', async () => {
    mockLane = 'production';
    mockPrefs.set('title.layout', 'immersive');
    const { result } = await renderHook(() => ({
      shown: useTitleLayout(),
      stored: useStoredTitleLayout(),
    }));
    await act(async () => {
      await hydrateTitleLayout();
    });

    expect(isTitleLayoutAvailable()).toBe(false);
    // The stored choice survives (so a later decision can honour it) but is not drawn.
    expect(result.current.stored).toBe('immersive');
    expect(result.current.shown).toBe('original');
  });

  it('is offered on every lane but production', () => {
    for (const lane of ['development', 'preview', 'beta']) {
      mockLane = lane;
      expect(isTitleLayoutAvailable()).toBe(true);
    }
  });
});
