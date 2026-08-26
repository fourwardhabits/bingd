import { Ionicons } from '@expo/vector-icons';

import { reportBrandFontFailure, startIconFont } from './fonts';
import { reportHandled } from './monitoring';

/**
 * The icon font, and the two ways it used to fail without saying anything.
 *
 * **The founder's 2026-08-26 beta**: bottom-tab icons gone with their labels still there,
 * the Settings gear vanished, action overlays on posters drawn as plain maroon rounded
 * blocks. All one thing — `@expo/vector-icons` renders an empty `<Text />` until its font
 * loads, so the pressable keeps its background and loses its glyph — and underneath it a
 * `Font.loadAsync` → `Asset.downloadAsync()` in a `componentDidMount` with no `catch`.
 *
 * These pin the two properties that were missing: the failure is reported, and it cannot
 * reach the startup path. The second is the one that matters most, because the obvious fix
 * — putting the icon font in the `useFonts` map that gates the tree — would have traded
 * blank icons for a blank app.
 */

jest.mock('@expo/vector-icons', () => ({ Ionicons: { loadFont: jest.fn() } }));
jest.mock('./monitoring', () => ({ reportHandled: jest.fn() }));

const loadFont = Ionicons.loadFont as unknown as jest.Mock;
const reported = reportHandled as unknown as jest.Mock;

beforeEach(() => {
  loadFont.mockReset();
  reported.mockReset();
});

describe('startIconFont', () => {
  it('starts the load once', () => {
    loadFont.mockResolvedValue(undefined);

    startIconFont();

    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(reported).not.toHaveBeenCalled();
  });

  /**
   * The blank-glyph case, as an event rather than a silence. Without this the app draws
   * icon-shaped holes and nothing anywhere explains why.
   */
  it('reports a font that will not load', async () => {
    loadFont.mockRejectedValue(new Error('Failed to download asset for font "ionicons"'));

    startIconFont();
    await Promise.resolve();
    await Promise.resolve();

    expect(reported).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ scope: 'fonts.icons' }),
    );
  });

  /**
   * **It must not throw into the startup path**, which is the whole reason this is a
   * fire-and-forget call rather than another entry in the `useFonts` map. A throw here is
   * an exception during the root layout's first effect pass.
   */
  it('does not throw when the loader throws synchronously', () => {
    loadFont.mockImplementation(() => {
      throw new Error('native module unavailable');
    });

    expect(() => startIconFont()).not.toThrow();
    expect(reported).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ scope: 'fonts.icons' }),
    );
  });

  /**
   * **And it must not hold anything.** A font whose download never settles is exactly the
   * shape of the stall this build fixed one layer down; the guarantee here is that it
   * costs blank glyphs and nothing else. `startIconFont` returns `void` precisely so no
   * caller can accidentally await it, and this asserts the promise underneath is not
   * awaited either.
   */
  it('returns without waiting for a load that never settles', () => {
    loadFont.mockReturnValue(new Promise<void>(() => {}));

    expect(startIconFont()).toBeUndefined();
    expect(reported).not.toHaveBeenCalled();
  });

  /** Older icon sets return void rather than a promise; `.catch` on that is a crash. */
  it('tolerates a loader that returns nothing at all', () => {
    loadFont.mockReturnValue(undefined);

    expect(() => startIconFont()).not.toThrow();
    expect(reported).not.toHaveBeenCalled();
  });
});

describe('reportBrandFontFailure', () => {
  /**
   * The discriminator. Brand fonts and the icon font travel the same `expo-asset` path,
   * so which of them failed is what says whether the problem is one font or the whole
   * pipeline — and the brand half was being swallowed entirely.
   */
  it('names the brand fonts, separately from the icons', () => {
    reportBrandFontFailure(new Error('font not found'));

    expect(reported).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ scope: 'fonts.brand' }),
    );
  });
});
