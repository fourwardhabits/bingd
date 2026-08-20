import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { useReducedMotion } from '../motion';
import { theme } from '../tokens';

export type SkeletonRowProps = {
  count?: number;
};

/**
 * Placeholder rows matching the compact row's geometry (design-system.md §8).
 *
 * A list is the one loading state where the app already knows the shape of what
 * is coming, and a spinner throws that away — the content arrives and the whole
 * screen relayouts under the user's eyes. Skeletons keep the page still.
 *
 * Not the word "Loading…" either. Text where content is about to be reads as a
 * message about the content rather than as an absence of it.
 *
 * React Native's own Animated rather than Reanimated. This is one interpolated
 * opacity on a loop, which the native driver runs off the JS thread just as
 * well, and Reanimated would make the worklets runtime a dependency of every
 * screen that can show a loading state.
 */
export function SkeletonRow({ count = 6 }: SkeletonRowProps) {
  // Lazy useState rather than useRef: the value is read during render to build
  // the style, and React Compiler rightly refuses a ref read there.
  const [pulse] = useState(() => new Animated.Value(0.6));
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    // Held still at a legible opacity rather than slowed down. A pulse that is
    // merely slower is still a pulse.
    if (reducedMotion) {
      pulse.setValue(0.75);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.6,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();

    return () => loop.stop();
  }, [pulse, reducedMotion]);

  const shimmer = { opacity: pulse };

  return (
    <View
      testID="skeleton"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: count }, (_, index) => (
        <View key={index} testID="skeleton-row" style={styles.row}>
          <Animated.View style={[styles.poster, shimmer]} />
          <View style={styles.text}>
            {/* Two bars of unequal width, because a column of identical bars
                reads as a table rather than as titles. */}
            <Animated.View style={[styles.bar, styles.title, shimmer]} />
            <Animated.View style={[styles.bar, styles.subtitle, shimmer]} />
          </View>
          <Animated.View style={[styles.badge, shimmer]} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.compactRow,
    paddingVertical: theme.space[1],
    paddingHorizontal: theme.layout.gutter,
  },
  poster: {
    width: theme.poster.row.width,
    height: theme.poster.row.height,
    borderRadius: 6,
    backgroundColor: theme.surface.sunken,
  },
  text: { flex: 1, gap: theme.space[1] },
  bar: { height: 12, borderRadius: theme.radius.full, backgroundColor: theme.surface.sunken },
  title: { width: '62%' },
  subtitle: { width: '38%', height: 10 },
  badge: {
    width: theme.layout.scoreBadge.md,
    height: theme.layout.scoreBadge.md,
    borderRadius: theme.radius.full,
    backgroundColor: theme.surface.sunken,
  },
});
