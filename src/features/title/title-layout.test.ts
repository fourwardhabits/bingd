import { act, renderHook } from '@testing-library/react-native';

import {
  hydrateTitleLayout,
  isTitleLayoutAvailable,
  resetTitleLayoutForTests,
  setTitleLayout,
  useStoredTitleLayout,
  useTitleLayout,
  useTitleLayoutResolved,
} from './title-layout';

/**
 * The title-page switch: device-local, Cinematic (`immersive`) by default in every lane
 * since the release pass (2026-11-07), a stored Original honoured.
 */
const mockPrefs = new Map<string, unknown>();
/** When set, the next read waits until the test releases it: a slow store at launch. */
let mockHeldRead: ((value: unknown) => void) | null = null;
let mockHoldReads = false;
let mockReadFails = false;
jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => {
    if (mockReadFails) return Promise.reject(new Error('store unavailable'));
    if (!mockHoldReads) return Promise.resolve(mockPrefs.get(name) ?? null);
    return new Promise((resolve) => {
      mockHeldRead = () => resolve(mockPrefs.get(name) ?? null);
    });
  },
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
  /** Cinematic by default everywhere since the release pass (founder, 2026-11-07). */
  it('is Cinematic until somebody chooses Original', async () => {
    const { result } = await renderHook(() => useTitleLayout());
    await act(async () => {
      await hydrateTitleLayout();
    });
    expect(result.current).toBe('immersive');
  });

  it('honours a stored Original at the next launch', async () => {
    mockPrefs.set('title.layout', 'original');
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

  it('treats anything it does not recognise as the Cinematic default', async () => {
    mockPrefs.set('title.layout', 'cinematic');
    const { result } = await renderHook(() => useTitleLayout());
    await act(async () => {
      await hydrateTitleLayout();
    });
    expect(result.current).toBe('immersive');
  });

  it('is offered in production too, and renders the stored choice there', async () => {
    mockLane = 'production';
    mockPrefs.set('title.layout', 'original');
    const { result } = await renderHook(() => ({
      shown: useTitleLayout(),
      stored: useStoredTitleLayout(),
    }));
    await act(async () => {
      await hydrateTitleLayout();
    });

    expect(isTitleLayoutAvailable()).toBe(true);
    expect(result.current.stored).toBe('original');
    expect(result.current.shown).toBe('original');
  });

  it('is offered on every lane', () => {
    for (const lane of ['development', 'preview', 'beta', 'production']) {
      mockLane = lane;
      expect(isTitleLayoutAvailable()).toBe(true);
    }
  });
});

/**
 * **Known before anything third-party loads** (independent review, release pass): until the
 * stored choice is read, a reader who chose Original may be drawn the default, so the title
 * page waits on `useTitleLayoutResolved` before its trailer stills.
 */
describe('resolving the stored choice', () => {
  afterEach(() => {
    mockHoldReads = false;
    mockReadFails = false;
    mockHeldRead = null;
  });

  it('is unresolved while the store is slow, then applies a saved Original', async () => {
    mockPrefs.set('title.layout', 'original');
    mockHoldReads = true;
    const { result } = await renderHook(() => ({
      shown: useTitleLayout(),
      resolved: useTitleLayoutResolved(),
    }));
    expect(result.current.resolved).toBe(false);

    await act(async () => {
      mockHeldRead?.(undefined);
    });
    expect(result.current.resolved).toBe(true);
    expect(result.current.shown).toBe('original');
  });

  it('resolves to the default when the store cannot be read', async () => {
    mockReadFails = true;
    const { result } = await renderHook(() => ({
      shown: useTitleLayout(),
      resolved: useTitleLayoutResolved(),
    }));
    await act(async () => {
      await hydrateTitleLayout().catch(() => {});
    });
    expect(result.current.resolved).toBe(true);
    expect(result.current.shown).toBe('immersive');
  });

  it('lets a choice made while the read is in flight stand', async () => {
    mockPrefs.set('title.layout', 'immersive');
    mockHoldReads = true;
    const { result } = await renderHook(() => useTitleLayout());
    await act(async () => {
      await setTitleLayout('original');
    });
    await act(async () => {
      mockHeldRead?.(undefined);
    });
    expect(result.current).toBe('original');
  });
});
