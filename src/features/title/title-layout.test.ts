import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

import { act, renderHook } from '@testing-library/react-native';

import {
  DEFAULT_LAYOUT,
  hydrateTitleLayout,
  resetTitleLayoutForTests,
  setTitleLayout,
  useTitleLayout,
  useTitleLayoutResolved,
} from './title-layout';

/**
 * **The Cinematic title page, unconditionally** (founder spec §7, 2026-11-13): the Labs
 * switch is gone, and a device that stored Original under it opens on Cinematic.
 */
const mockPrefs = new Map<string, unknown>([['title.layout', 'original']]);
const mockRead = jest.fn((name: string) => Promise.resolve(mockPrefs.get(name) ?? null));
jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => mockRead(name),
  writePref: () => Promise.resolve(),
}));

beforeEach(() => {
  mockRead.mockClear();
  resetTitleLayoutForTests();
});

describe('the title page layout', () => {
  it('is Cinematic', async () => {
    expect(DEFAULT_LAYOUT).toBe('immersive');
    const { result } = await renderHook(() => useTitleLayout());
    expect(result.current).toBe('immersive');
  });

  it('stays Cinematic on a device that stored Original under the old Labs switch', async () => {
    // The stored value is in the mocked store from the start of this file.
    const { result } = await renderHook(() => useTitleLayout());
    await act(async () => {
      await hydrateTitleLayout();
    });

    expect(result.current).toBe('immersive');
    // It is not even read: nothing on the device can choose the layout any more.
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('is resolved from the first render, so nothing waits on a store', async () => {
    const { result } = await renderHook(() => useTitleLayoutResolved());
    expect(result.current).toBe(true);
  });

  it('can be pinned by a test for the original branch, and resets to Cinematic', async () => {
    const { result } = await renderHook(() => useTitleLayout());
    await act(async () => {
      await setTitleLayout('original');
    });
    expect(result.current).toBe('original');

    await act(async () => {
      resetTitleLayoutForTests();
      await setTitleLayout('immersive');
    });
    expect(result.current).toBe('immersive');
  });
});

/**
 * `setTitleLayout` is a test seam now. If app code called it, the Labs switch would be
 * back in all but name — so this asserts that only test files do.
 */
describe('who may pin the layout', () => {
  const ROOT = join(__dirname, '..', '..', '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
    });

  it('is never called from app code', () => {
    const callers = [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'src'))]
      .filter((path) => !path.endsWith(join('features', 'title', 'title-layout.ts')))
      .filter((path) => !path.includes(`${join('src', 'test-utils')}`))
      .filter((path) => /\bsetTitleLayout\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));

    expect(callers).toEqual([]);
  });
});
