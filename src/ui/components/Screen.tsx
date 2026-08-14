import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../tokens';

export type ScreenProps = {
  children: ReactNode;
  /** Airy surfaces (onboarding, comparison, reveal, share) centre their content. */
  airy?: boolean;
  /** Apply safe-area bottom inset exactly once. */
  includeBottomInset?: boolean;
};

export function Screen({ children, airy = false, includeBottomInset = false }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const bottomPadding = includeBottomInset ? Math.max(insets.bottom, theme.space[4]) : theme.space[4];

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View
        style={[
          styles.content,
          airy && styles.airy,
          { paddingBottom: bottomPadding },
        ]}
      >
        {children}
      </View>
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
});
