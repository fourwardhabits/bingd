import { useState } from 'react';
import {
  Animated,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '@/ui/tokens';

import { NAV_BAR_HEIGHT } from './TitleTopBar';

/**
 * The hero's height when there is no artwork: the bar, plus this band under it.
 *
 * 56 is what shipped as the poster's lift on the title page: enough Parchment to read as a
 * deliberate surface, short enough that a page with no artwork does not spend a third of
 * the screen saying so.
 */
export const HERO_COLLAPSED_BAND = 56;

/**
 * Over how many points the navigation finishes becoming a header — the last stretch of
 * the hero's own height, so the ground has arrived by the time the artwork has.
 */
export const REVEAL_WINDOW = 96;

/**
 * **The detail-page header rule, as one hook** (design-system.md §11b).
 *
 * A detail page — a title, and since 2026-09-21 a list — opens on a full-bleed hero with
 * its large title on Paper beneath it. The navigation is drawn over the artwork by
 * `TitleTopBar` and gains its Paper ground as the hero leaves, and the compact title
 * appears in the bar **only once the large title has scrolled away**: never both at once.
 *
 * This is the title page's arithmetic lifted out unchanged, so the list page cannot
 * invent a second scroll rule:
 *
 *   revealEnd   the hero's height (16:9 of the width with artwork, else the collapsed
 *               band) minus the bar, floored at 2 so the interpolation stays increasing;
 *   revealStart REVEAL_WINDOW before it;
 *   revealed    hysteresis across the window, so a resting finger cannot flicker it.
 */
export function useHeroReveal(hasArtwork: boolean) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [scrollY] = useState(() => new Animated.Value(0));
  const [revealed, setRevealed] = useState(false);

  const barHeight = insets.top + NAV_BAR_HEIGHT;
  const collapsedHero = barHeight + HERO_COLLAPSED_BAND;
  const revealEnd = Math.max(
    (hasArtwork ? width / theme.layout.aspect.backdrop : collapsedHero) - barHeight,
    2,
  );
  const revealStart = Math.max(revealEnd - REVEAL_WINDOW, 0);

  const progress = scrollY.interpolate({
    inputRange: [revealStart, revealEnd],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const onScroll = Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
    useNativeDriver: true,
    listener: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = event.nativeEvent.contentOffset.y;
      setRevealed((was) => (was ? y > revealStart : y >= revealEnd));
    },
  });

  return { progress, revealed, onScroll, collapsedHero, barHeight, topInset: insets.top };
}
