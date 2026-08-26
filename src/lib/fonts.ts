import { Ionicons } from '@expo/vector-icons';

import { reportHandled } from './monitoring';

/**
 * The icon font, started once at the root instead of by whichever icon happens to mount
 * first.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: THE FOUNDER'S MISSING GLYPHS
 *
 * On the 2026-08-26 beta the bottom-tab icons were gone while their labels stayed, the
 * Settings gear had vanished, and the action overlays on posters drew as plain maroon
 * rounded blocks. Every one of those is the same thing: `@expo/vector-icons` renders an
 * **empty `<Text />`** until its font has loaded, so the pressable keeps its background
 * and loses its glyph.
 *
 * The load underneath it is `Font.loadAsync` → `Asset.downloadAsync()`, and the call sits
 * in a `componentDidMount` with no `catch`. That is the same failure class this build
 * spent a tranche on one layer down: a promise the platform is not obliged to settle,
 * with nowhere for its rejection to go. If it hangs or throws, every icon in the app is
 * blank for the life of the process and nothing anywhere says so.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES AND WHAT IT DELIBERATELY DOES NOT
 *
 * It starts the load once, early, and **reports the failure**. That is the part that was
 * missing: the difference between a founder's screenshot and an answer.
 *
 * It does not pretend to repair a download that cannot happen. If the report shows this
 * failing on a device, the durable fix is embedding the font natively through the
 * `expo-font` config plugin — which changes the fingerprint and needs a new binary, and
 * so is not something an over-the-air update can carry.
 *
 * **It must never be awaited by anything that gates the tree.** `app/_layout.tsx` already
 * withholds render until the brand fonts resolve; putting a font that may never settle
 * behind that gate would trade blank icons for a blank app, which is the regression this
 * codebase has now spent two tranches removing. Hence: no return value worth awaiting,
 * and a rejection that cannot escape.
 */
export function startIconFont(): void {
  try {
    const loading = Ionicons.loadFont();
    // Older versions of the icon set return void rather than a promise. Checking rather
    // than assuming, because `.catch` on undefined is a startup crash.
    if (loading && typeof (loading as Promise<void>).catch === 'function') {
      void (loading as Promise<void>).catch(reportIconFontFailure);
    }
  } catch (error) {
    // A synchronous throw is not the documented behaviour, and is exactly the kind of
    // thing that would otherwise take the first render with it.
    reportIconFontFailure(error);
  }
}

function reportIconFontFailure(error: unknown) {
  report(error, 'fonts.icons');
}

/**
 * Reporting a font failure must not itself be able to fail.
 *
 * Review 50's residual: `startIconFont` runs in the root layout's first effect pass and its
 * rejection handler runs on a microtask, so a throw from the reporter would escape into the
 * startup path or become a second unhandled rejection — which is a worse outcome than the
 * missing glyph it was trying to describe. Nothing suggests `reportHandled` throws; this
 * costs three lines and removes the question.
 */
function report(error: unknown, scope: 'fonts.icons' | 'fonts.brand') {
  try {
    reportHandled(error, { scope });
  } catch {
    // Nothing left to tell, and nowhere to tell it.
  }
}

/**
 * The other half: the brand fonts, whose failure was also a silence.
 *
 * `useFonts` hands back an error and `app/_layout.tsx` deliberately renders anyway —
 * system type is a far better outcome than no app. What was missing is anybody being
 * told, so the app draws in the wrong typeface and no event exists to explain it. This is
 * also the discriminator for the icons above: brand fonts and icon font travel the same
 * `expo-asset` path, so which of them failed says whether the problem is one font or the
 * whole asset pipeline.
 */
export function reportBrandFontFailure(error: unknown): void {
  report(error, 'fonts.brand');
}
