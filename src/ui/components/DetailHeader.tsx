import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../tokens';
import { Text } from './Text';

/**
 * One header behaviour for every pushed detail page — Movie, Series, Season, Person.
 *
 * Before this, the two detail routes disagreed. `title/[id]` blanked its header title
 * permanently, so a film scrolled past its hero left the reader on a bare back bar with
 * nothing saying what they were looking at. `person/[id]` did the opposite and printed
 * the name in the bar at all times, directly above the same name set in `title1` two
 * lines below it. Neither was a decision; they were two screens written on different
 * days.
 *
 * The rule now, in both places: **the header names the page only when the page has
 * stopped naming itself.** While the large identity — hero and title, or portrait and
 * name — is on screen, the bar carries the back control and nothing else, because
 * repeating a title six points below itself is noise. Once that identity has scrolled
 * under the bar, the compact title takes its place.
 *
 * The threshold is measured rather than guessed. `onIdentityLayout` records the bottom
 * edge of whatever block a screen nominates as its identity, so a Season with a series
 * line above its own name, a film without one, and a person with a portrait each get
 * the right moment without a per-screen constant — which is the "screen-specific hack"
 * this replaces, not a smaller version of it.
 */

/**
 * A dead band around the crossing point.
 *
 * Without it, a finger resting exactly on the threshold flips the title in and out on
 * every pixel of movement. Twelve points is roughly the amount of drift in a hand held
 * still, and is small enough that neither edge of the band is noticeable.
 */
const HYSTERESIS = 12;

/**
 * How tall the navigation bar itself is, above the status bar.
 *
 * Per platform, because it genuinely differs: iOS draws a 44pt bar and Android's
 * toolbar convention is 56dp. `theme.layout.control.headerHeight` is 44 and describes
 * Bingd's *own* header, which is not this one — using it on both platforms put the
 * crossing point 12 points early on Android, revealing the compact title while the
 * bottom of the identity was still visible under the real bar. Independent review found
 * that; the hysteresis was absorbing it rather than the threshold being right.
 *
 * Still a constant rather than a measurement. The navigation library's own header
 * metrics are not exported from `expo-router`'s public surface, and reaching into its
 * build output for them would tie this to an internal path that moves between versions.
 * A wrong constant costs a few points of timing on a fade; a broken import costs the
 * screen.
 */
const NAV_BAR_HEIGHT = Platform.select({ android: 56, default: 44 }) as number;

export type DetailHeaderState = {
  /** True once the identity block has passed under the header bar. */
  revealed: boolean;
  /** Attach to the block the screen considers its identity. */
  onIdentityLayout: (event: LayoutChangeEvent) => void;
  /** Attach to the screen's scroll view, with `scrollEventThrottle`. */
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle: number;
};

export function useDetailHeader(): DetailHeaderState {
  const insets = useSafeAreaInsets();
  // What the bar physically covers: the status bar plus the bar itself. The title
  // page's header is transparent, so its content is still visible underneath — the
  // reveal has to wait for the identity to pass the *bottom* of the bar, not the top
  // of the screen, or the two titles overlap for the height of the header.
  const headerHeight = insets.top + NAV_BAR_HEIGHT;

  // Refs rather than state: both values change while a finger is down, and only their
  // comparison is worth a render. Storing the offset in state would re-render the
  // screen on every scroll frame to recompute one boolean.
  const identityBottom = useRef<number | null>(null);
  const offset = useRef(0);
  const [revealed, setRevealed] = useState(false);

  const decide = useCallback(() => {
    const bottom = identityBottom.current;
    // Nothing has reported a layout yet, so there is no identity to be past. Staying
    // hidden is the safe answer: a header that names the page while the page is
    // already naming itself is the defect being fixed.
    if (bottom == null) return;

    const past = offset.current + headerHeight;
    setRevealed((was) => (was ? past > bottom - HYSTERESIS : past > bottom));
  }, [headerHeight]);

  const onIdentityLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      identityBottom.current = y + height;
      // Re-decide immediately. A screen whose content grows after first paint — cast
      // strip arriving, description expanding — can move the identity block while the
      // user is already scrolled past where it used to be.
      decide();
    },
    [decide],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      offset.current = event.nativeEvent.contentOffset.y;
      decide();
    },
    [decide],
  );

  return { revealed, onIdentityLayout, onScroll, scrollEventThrottle: 16 };
}

/**
 * The compact title that takes the identity's place.
 *
 * One line, `callout` rather than `title1`: it is a label saying where you are, not a
 * second statement of the title. A season carries its series above it in `caption`,
 * which is the only place in the app where the header is two lines — "Season 2" alone
 * in a bar is not an answer to "where am I".
 *
 * It fades rather than appearing, and the fade lives here rather than in the hook so
 * that it runs on mount. The hook flips a boolean; this component is what that boolean
 * mounts, so there is no animated value threaded through navigation options.
 */
export function DetailHeaderTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string | null;
}) {
  // Lazy initialiser rather than a ref, matching `SkeletonRow`: a ref read during
  // render is what `react-hooks/refs` forbids, and the value has to be constructed
  // once rather than on every render either way.
  const [opacity] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: theme.duration.state,
      useNativeDriver: true,
    }).start();
  }, [opacity]);

  return (
    <Animated.View style={[styles.title, { opacity }]}>
      {subtitle ? (
        <Text variant="caption" tone="secondary" numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
      <Text variant="callout" numberOfLines={1}>
        {title}
      </Text>
    </Animated.View>
  );
}

/**
 * Paper behind a transparent header, for the one screen that has a full-bleed hero.
 *
 * `title/[id]` keeps `headerTransparent` at all times — toggling it would change the
 * content inset and jog the whole page at the moment of the reveal. So the background
 * arrives as a view instead, and the compact title has something opaque to sit on
 * rather than floating over artwork.
 *
 * The person page does not use this. It has no hero to run under, so its bar is
 * already opaque and stays that way; only the title behaviour is shared, which is the
 * part the founder asked to be consistent.
 */
export function DetailHeaderBackground() {
  return <View style={styles.background} />;
}

const styles = StyleSheet.create({
  title: { alignItems: 'center', justifyContent: 'center' },
  background: {
    flex: 1,
    backgroundColor: theme.surface.base,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border.hairline,
  },
});
