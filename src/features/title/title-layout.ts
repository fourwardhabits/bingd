import { useSyncExternalStore } from 'react';

import { readPref, writePref } from '@/lib/prefs';

/**
 * **Which title page this device shows** (Immersive Scroll experiment, 2026-11-04).
 *
 * `original` is the production page and the default everywhere. `immersive` is the
 * experimental layout in `ImmersiveHero` and the immersive branch of `app/title/[id].tsx`.
 * Both render from the same reads, the same handlers and the same sheets: this switch
 * chooses a layout, never data, ranking or scoring. Rollback procedure:
 * `docs/release/immersive-title-experiment.md`.
 *
 * ---------------------------------------------------------------------------
 * WHY A DEVICE PREFERENCE, AND NOTHING REMOTE
 *
 * The repository has no feature-flag service, and the founder ruled out adding one, a
 * migration or remote config for this. A device preference is the smallest switch that
 * lets the founder and named testers opt in and compare, and lets the original page come
 * back without a redesign or a data change: turn the row off, or ship an OTA where
 * `isTitleLayoutAvailable` returns false, which forces `original` whatever any device
 * stored.
 *
 * `isTitleLayoutAvailable` was the lane gate that kept production on Original; since the
 * release pass (below) every lane offers the switch and opens on Cinematic. The remote option the docs describe — a `public.` key in the existing
 * `app_config` table, which clients can already read — is deliberately not built.
 */
export type TitleLayout = 'original' | 'immersive';

/**
 * **The Cinematic page is the default everywhere, production included** (founder, release
 * pass, 2026-11-07). It had been Labs-only and locked off in production; the founder
 * approved it as the production title page, with Original kept one switch away in
 * Settings › Labs as a fallback for anybody who prefers it.
 *
 * So the switch is offered in every lane, an unset or unreadable choice is Cinematic, and
 * a stored `original` is honoured. Rollback is an OTA that makes `DEFAULT_LAYOUT`
 * `original` again (the Labs row keeps working either way).
 *
 * Kept as a function, so the Settings row and the tests ask one place.
 */
export const isTitleLayoutAvailable = (): boolean => true;

/** What a device with no stored choice opens on. */
export const DEFAULT_LAYOUT: TitleLayout = 'immersive';

const PREF = 'title.layout';

let current: TitleLayout = DEFAULT_LAYOUT;
let hydrated = false;
/**
 * Whether the stored choice is known yet (independent review, release pass): until it is,
 * a reader who chose Original may still be drawn the default. The title page holds back
 * anything that reaches a third party — the trailer stills — until this is true.
 */
let resolved = false;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/**
 * Reads the stored choice once per launch. A missing or unknown value is the default, and
 * so is a read that fails — after which the choice counts as known, so nothing waits on a
 * store that will not answer. Started at launch by the root layout, so it has normally
 * finished long before the first title page opens.
 */
export function hydrateTitleLayout(): Promise<void> {
  if (hydrated) return Promise.resolve();
  hydrated = true;
  return readPref<TitleLayout>(PREF)
    .then(
      (stored) => (stored === 'original' || stored === 'immersive' ? stored : DEFAULT_LAYOUT),
      () => DEFAULT_LAYOUT,
    )
    .then((next) => {
      // A tap on the Settings row while the read was in flight is the newer intent, and
      // has already resolved the choice; otherwise the stored one applies now.
      if (resolved) return;
      current = next;
      resolved = true;
      emit();
    });
}

export async function setTitleLayout(next: TitleLayout): Promise<void> {
  current = next;
  resolved = true;
  emit();
  await writePref(PREF, next);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  void hydrateTitleLayout();
  return () => {
    listeners.delete(listener);
  };
};

/** The stored choice, ignoring the lane gate: what the Settings row shows. */
export function useStoredTitleLayout(): TitleLayout {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** The layout to render: the stored choice, or the default. */
export function useTitleLayout(): TitleLayout {
  const stored = useStoredTitleLayout();
  return isTitleLayoutAvailable() ? stored : 'original';
}

/** Whether the stored choice has been read (or chosen) on this launch. */
export function useTitleLayoutResolved(): boolean {
  return useSyncExternalStore(subscribe, () => resolved, () => resolved);
}

/** Test seam: forget what this module read, as an app launch does. */
export function resetTitleLayoutForTests(): void {
  current = DEFAULT_LAYOUT;
  hydrated = false;
  resolved = false;
  listeners.clear();
}
