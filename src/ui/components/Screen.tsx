import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { showEnvironmentBadge, env } from '@/lib/env';

import { theme } from '../tokens';
import { Text } from './Text';

export type ScreenProps = {
  children: ReactNode;
  /** Airy surfaces (onboarding, comparison, reveal, share) centre their content. */
  airy?: boolean;
};

export function Screen({ children, airy = false }: ScreenProps) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={[styles.content, airy && styles.airy]}>{children}</View>
      {showEnvironmentBadge ? (
        <View style={styles.badge} pointerEvents="none">
          <Text variant="caption" tone="onFill">
            {env.variant.toUpperCase()}
          </Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.surface.base },
  content: { flex: 1 },
  airy: {
    justifyContent: 'center',
    gap: theme.space[8],
    paddingHorizontal: theme.layout.gutter,
  },
  badge: {
    position: 'absolute',
    bottom: theme.space[2],
    alignSelf: 'center',
    backgroundColor: theme.semantic.emphasis,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.space[2],
    paddingVertical: theme.space[1],
  },
});
