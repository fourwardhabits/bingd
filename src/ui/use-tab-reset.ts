import { useNavigation } from 'expo-router';
import { useEffect } from 'react';

/**
 * Pressing the tab you are already on takes you back to the top of that section.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE HOOK AND NOT FIVE HANDLERS
 *
 * Every tab in this app is a single route. Leaderboard, People, Sent to you, Group
 * Picks, Top Rated, a search that has results, a collection that has been filtered —
 * none of them is a screen the navigator can pop, so the habit every phone user has
 * ("tap it again to get back") did nothing on any of them. The Feed grew a listener of
 * its own for exactly this in 2026-08-30; the founder's physical pass on iOS 1.0.1
 * build 8 asked for the same behaviour across all five.
 *
 * Five copies of that listener is five places for `isFocused` to be forgotten, and the
 * failure of forgetting it is silent and unpleasant: arriving from another tab would
 * throw away the state the reader left. So the subscription is written once and each
 * screen supplies only the thing that is genuinely its own — what its root *is*.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES IT ENFORCES
 *
 * **Only when this tab is already focused.** `tabPress` fires for a tab whether the
 * reader was on it or somewhere else, and resetting in the second case is a different
 * change nobody asked for — arriving from another tab would stop returning you to what
 * you were doing. `isFocused()` is the whole of "already selected".
 *
 * **Nothing is prevented.** The navigator's own default for a re-tap is
 * pop-to-top/scroll-to-top, and none of these routes has a nested stack for that to
 * reach, so consuming the event would take a behaviour away in exchange for nothing.
 * A screen that wants to scroll to the top does it in its own handler, beside the
 * reset, where it can be true of that list.
 */
export function useTabReset(reset: () => void) {
  const navigation = useNavigation();

  useEffect(() => {
    // Under the unit runner `useNavigation` is mocked to whatever the test supplies; a
    // navigator that cannot report focus is one a screen has no business listening to,
    // and the optional calls are what keep that from being a crash.
    const unsubscribe = navigation.addListener?.(
      'tabPress' as never,
      (() => {
        if (navigation.isFocused && !navigation.isFocused()) return;
        reset();
      }) as never,
    );
    return () => unsubscribe?.();
  }, [navigation, reset]);
}
