import { Animated, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { useSkeletonPulse } from './SkeletonRow';

export type SkeletonGridProps = {
  /** How many rows of posters to hold the place of. */
  rows?: number;
};

/**
 * Placeholder posters in the poster wall's own grid (design-system.md §8, §11b).
 *
 * The skeleton for a screen whose content is a wall of posters — For You's first load
 * (founder QA, 2026-09-21: a ~6 s cold load showed the header over an empty area). The
 * row skeleton is the wrong shape there: thin bars over a wall read as nothing loading.
 * This holds the wall's own columns, gap and 2:3 tiles, pulsing with the app's one
 * skeleton rhythm (`useSkeletonPulse`), so the wall arrives into the space it already
 * occupies.
 */
export function SkeletonGrid({ rows = 3 }: SkeletonGridProps) {
  const pulse = useSkeletonPulse();
  const { columns } = theme.layout.posterGrid;

  return (
    <View
      testID="skeleton-grid"
      style={styles.grid}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
    >
      {Array.from({ length: rows }, (_, row) => (
        <View key={row} style={styles.row}>
          {Array.from({ length: columns }, (_, column) => (
            <Animated.View
              key={column}
              testID="skeleton-tile"
              style={[styles.tile, { opacity: pulse }]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    gap: theme.layout.posterGrid.gap,
  },
  row: { flexDirection: 'row', gap: theme.layout.posterGrid.gap },
  tile: {
    flex: 1,
    aspectRatio: theme.layout.aspect.poster,
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.sunken,
  },
});
