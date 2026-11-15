import { useSyncExternalStore } from 'react';

/**
 * **Which title page renders: Cinematic, unconditionally** (founder spec §7, 2026-11-13).
 *
 * `immersive` is the Cinematic page in `ImmersiveHero` and the immersive branch of
 * `app/title/[id].tsx`; `original` is the page it replaced. Both render from the same
 * reads, the same handlers and the same sheets: this chooses a layout, never data,
 * ranking or scoring.
 *
 * ---------------------------------------------------------------------------
 * HISTORY, AND WHAT CHANGED
 *
 * It began as a device preference behind Settings › Labs (Immersive Scroll experiment,
 * 2026-11-04), became the default everywhere with Original one switch away (release
 * pass, 2026-11-07), and is now the standard page with no switch: the founder removed the
 * Labs section, so nothing in the app offers Original any more.
 *
 * **A device that stored `original` under the old switch opens on Cinematic.** The stored
 * preference is not read at all, so there is nothing a stale value on a device can do.
 * It is not deleted either: leaving a key nobody reads is cheaper and safer than a
 * write at launch.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS LEFT, AND WHY
 *
 * `app/title/[id].tsx` still carries the original branch — removing it is a separate
 * change in a file this workstream does not own — and its tests still exercise it through
 * {@link setTitleLayout}. That seam is the only writer, it is test-only, and
 * `title-layout.test.ts` asserts that no app source calls it. Rollback, should it ever be
 * wanted, is an OTA restoring the Labs row and the stored read from version control.
 */
export type TitleLayout = 'original' | 'immersive';

/** What every device opens on. */
export const DEFAULT_LAYOUT: TitleLayout = 'immersive';

let current: TitleLayout = DEFAULT_LAYOUT;
const listeners = new Set<() => void>();

/**
 * Kept so the root layout's launch call needs no change. There is nothing to read: the
 * layout no longer depends on anything stored on the device.
 */
export function hydrateTitleLayout(): Promise<void> {
  return Promise.resolve();
}

/**
 * **Test seam only.** Pins a layout for this process so the original branch that
 * `app/title/[id].tsx` still carries can be exercised. Nothing in the app calls it (the
 * Settings › Labs row that did is gone), it writes nothing to the device, and a test
 * that pins `original` must put `immersive` back — `resetTitleLayoutForTests` does.
 */
export async function setTitleLayout(next: TitleLayout): Promise<void> {
  current = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The layout to render: `immersive`, unless a test has pinned another. */
export function useTitleLayout(): TitleLayout {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/**
 * Always true: there is no stored choice left to wait for. The title page used to hold its
 * trailer stills until a device's saved Original had been read; it no longer has to.
 */
export function useTitleLayoutResolved(): boolean {
  return true;
}

/** Test seam: back to the app's own state, as a launch is. */
export function resetTitleLayoutForTests(): void {
  current = DEFAULT_LAYOUT;
  // Mounted readers follow, so a component pinned to `original` does not keep it.
  for (const listener of listeners) listener();
}
