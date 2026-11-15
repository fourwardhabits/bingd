import { createContext, useContext } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';
import { useStableBottomInset } from './use-stable-bottom-inset';

export type DismissFooterProps = {
  onPress: () => void;
  /** Defaults to `Close`. A Done that *completes* something is not this control. */
  label?: string;
  testID?: string;
};

/**
 * Whether the bottom safe-area inset is already paid by something around this footer.
 *
 * `Sheet` provides `true` for its children and its `footer` slot, because it pays the
 * inset itself there; anywhere else — the foot of a screen — the footer pays it. One
 * owner, so the inset can never be counted twice: that doubling is what once made
 * bingd Awards hold a 108pt band open under a single word.
 */
export const BottomInsetPaidContext = createContext(false);

/**
 * **The quiet way out** (founder spec §2B, 2026-11-13).
 *
 * Text-only Maroon `Close`, centred, in its own white bar at the bottom of a sheet or
 * screen. It takes *Skip title*'s type and spacing from the ranking flow (`footnote`,
 * `space[3]` vertically) and Maroon ink, so it reads as available rather than urged —
 * significantly quieter than Save or any primary action.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT SITS
 *
 * Outside the scroll region, always. In a `Sheet`, pass it as `footer`: the sheet pins it
 * below its content, which can then flex to the space left and scroll to its last row
 * without that row ever finishing under this bar. A hairline on top separates the bar
 * from whatever is scrolling past above it.
 *
 * ---------------------------------------------------------------------------
 * TARGET
 *
 * Quiet in ink, never in size: the pressable is the full 44pt target and the full width
 * of the bar, so a thumb that misses the word still lands on Close.
 */
export function DismissFooter({ onPress, label = 'Close', testID = 'dismiss-footer' }: DismissFooterProps) {
  const insetPaid = useContext(BottomInsetPaidContext);
  const inset = useStableBottomInset();

  return (
    <View
      testID={testID}
      style={[styles.bar, !insetPaid && inset > 0 ? { paddingBottom: inset } : null]}
    >
      <Pressable
        testID={`${testID}-press`}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => [styles.press, pressed && styles.pressed]}
      >
        <Text variant="footnote" tone="action" style={styles.label}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: theme.surface.raised,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
  },
  press: {
    minHeight: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  label: { textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
