import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { RerankNotice } from './rerank';

/**
 * **What a Collection move just did, and the one thing to do about it** (#318).
 *
 * A bar over the bottom of the list: `Moved “Heat” to #4 · 9.6  Undo`, or why a drop was
 * refused and the way to the path that can do it (`Open title` for Rerank, `Sort by rating`).
 * Confirmations fade on their own (`useRerank`'s timer); errors stay until acted on or
 * closed. It is announced when it appears, so a screen reader hears the outcome of a move it
 * made with an accessibility action.
 */
export function RerankNoticeBar({
  notice,
  onAction,
  onDismiss,
}: {
  notice: RerankNotice;
  onAction: () => void;
  onDismiss: () => void;
}) {
  return (
    <View
      style={styles.bar}
      accessibilityLiveRegion="polite"
      testID="rerank-notice"
    >
      <Text variant="footnote" style={styles.message} testID="rerank-notice-message">
        {notice.message}
      </Text>
      {notice.action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={notice.action.label}
          onPress={onAction}
          hitSlop={theme.space[2]}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          testID="rerank-notice-action"
        >
          <Text variant="footnote" tone="action">
            {notice.action.label}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={onDismiss}
        hitSlop={theme.space[2]}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}
        testID="rerank-notice-dismiss"
      >
        <Ionicons name="close" size={theme.layout.icon.sm} color={theme.text.tertiary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: theme.layout.gutter,
    right: theme.layout.gutter,
    bottom: theme.space[3],
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    paddingLeft: theme.space[3],
    paddingRight: theme.space[1],
    paddingVertical: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.raised,
    ...theme.elevation.e2,
  },
  message: { flex: 1 },
  action: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.space[2],
  },
  close: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
});
