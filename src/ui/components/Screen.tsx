import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';

import { theme } from '../tokens';

const DEFAULT_EDGES: readonly Edge[] = ['top', 'left', 'right'];

export type ScreenProps = {
  children: ReactNode;
  /** Airy surfaces (onboarding, comparison, reveal, share) centre their content. */
  airy?: boolean;
  /**
   * Keep the content clear of the bottom of the display.
   *
   * For screens with nothing under them. A screen inside the tab navigator
   * leaves this off, because the tab bar is already sized to `insets.bottom`
   * and paints its surface behind the system navigation bar — adding padding
   * here on top of that leaves a strip of Paper above the tab bar that content
   * is clipped at instead of scrolling under, which is the band the Android
   * navigation bar appeared to be sitting on.
   */
  includeBottomInset?: boolean;
  /**
   * Which edges get safe-area padding. Pass `[]` on a screen whose first
   * element is full-bleed artwork — the title page's hero has to reach the top
   * of the display, and a top inset would leave a Paper band above it.
   */
  edges?: readonly Edge[];
};

export function Screen({
  children,
  airy = false,
  includeBottomInset = false,
  edges = DEFAULT_EDGES,
}: ScreenProps) {
  const insets = useSafeAreaInsets();

  // Zero, not a token, when there is something below: whatever is below owns
  // that space. Scroll views set their own generous `contentContainerStyle`
  // bottom padding, which is the right place for it, because it scrolls.
  const bottomPadding = includeBottomInset ? Math.max(insets.bottom, theme.space[4]) : 0;

  return (
    <SafeAreaView style={styles.safe} edges={edges}>
      <View style={[styles.content, airy && styles.airy, { paddingBottom: bottomPadding }]}>
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
