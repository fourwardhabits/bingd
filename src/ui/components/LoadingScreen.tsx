import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { BrandMark } from './BrandMark';
import { Text } from './Text';
import { Wordmark } from './Wordmark';

export type LoadingScreenProps = {
  /** Shown under the wordmark. Only worth setting when the wait has a reason
   *  the user would recognise — "Signing you in", not "Loading". */
  message?: string;
};

/**
 * The full-screen wait (design-system.md §8).
 *
 * For the cases where the app genuinely has nothing to show yet and does not
 * know the shape of what is coming: startup, session resolution, sign-in. A
 * list that *is* about to arrive gets `SkeletonRow` instead, because a skeleton
 * keeps the page still and this does not.
 *
 * This is the only place in the app that shows an indeterminate spinner, and it
 * earns it by being the only wait whose length is genuinely unknown. Everywhere
 * else the app knows the shape of what is coming and should draw that instead.
 *
 * It doubles as the visual handover from the native splash: same mark, same
 * background, so hiding one and showing the other is not a cut to a blank page.
 */
export function LoadingScreen({ message }: LoadingScreenProps) {
  return (
    <View
      style={styles.fill}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={message ?? 'Loading'}
    >
      <View style={styles.tile}>
        <BrandMark size="lg" decorative />
      </View>

      <Wordmark size="sm" />

      <ActivityIndicator color={theme.semantic.action} />

      {message ? (
        <Text variant="footnote" tone="tertiary">
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const TILE = 96;

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.surface.base,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[4],
  },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: 20,
    backgroundColor: theme.surface.raised,
    alignItems: 'center',
    justifyContent: 'center',
    ...theme.elevation.e1,
  },
});
