import { useSyncExternalStore } from 'react';

import { lane } from '@/lib/env';
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
 * `isTitleLayoutAvailable` is the lane gate. Every lane but production offers the switch
 * (Preview, Beta, development). Production never shows it, so a production OTA carrying
 * this code still renders the original page for everyone until a separate decision
 * changes this function. The remote option the docs describe — a `public.` key in the existing
 * `app_config` table, which clients can already read — is deliberately not built.
 */
export type TitleLayout = 'original' | 'immersive';

/** Whether this build offers the switch at all. Read per call, so a test can vary the lane. */
export const isTitleLayoutAvailable = (): boolean => lane !== 'production';

const PREF = 'title.layout';

let current: TitleLayout = 'original';
let hydrated = false;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/** Reads the stored choice once per launch. A missing or unknown value is `original`. */
export function hydrateTitleLayout(): Promise<void> {
  if (hydrated) return Promise.resolve();
  hydrated = true;
  return readPref<TitleLayout>(PREF).then((stored) => {
    const next: TitleLayout = stored === 'immersive' ? 'immersive' : 'original';
    if (next !== current) {
      current = next;
      emit();
    }
  });
}

export async function setTitleLayout(next: TitleLayout): Promise<void> {
  current = next;
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

/** The layout to render. Always `original` where the experiment is not offered. */
export function useTitleLayout(): TitleLayout {
  const stored = useStoredTitleLayout();
  return isTitleLayoutAvailable() ? stored : 'original';
}

/** Test seam: forget what this module read, as an app launch does. */
export function resetTitleLayoutForTests(): void {
  current = 'original';
  hydrated = false;
  listeners.clear();
}
