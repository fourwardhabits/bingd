import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';

import { usePressScale } from '../press';
import { theme } from '../tokens';
import { Text } from './Text';

export type SaveButtonProps = {
  onPress: () => void;
  /** Shows "Saving…", is inert, and is announced as busy. */
  saving?: boolean;
  /** Nothing has changed, or what has changed is not valid yet. */
  disabled?: boolean;
  /** Announced as the hint while disabled, as `Button`'s is. */
  disabledReason?: string;
  /** Defaults to `Save`. */
  label?: string;
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * How long after an accepted press another one is ignored, even if the caller has not yet
 * re-rendered with `saving`. Two taps inside one frame both reach `onPress` otherwise,
 * because the second arrives before the state set by the first has been drawn.
 */
const REPEAT_GUARD_MS = 600;

/**
 * **The one Save** (founder spec §2A, 2026-11-13).
 *
 * Compact, filled Maroon, Parchment label — the slimmer Rank button's treatment, set at
 * the top right of whatever is being edited: a native header's `headerRight` on a
 * full-screen form, or a local editor's own header row. It replaces the grey tertiary
 * word Edit Profile used, so every editing surface that asks for an explicit save asks
 * with the same control.
 *
 * ---------------------------------------------------------------------------
 * GEOMETRY
 *
 * The filled shape is `compactAction.visibleHeight` (36pt) — Rank's own height — and the
 * pressable box around it is the full 44pt target. The target is the control's own box
 * rather than `hitSlop`, because Android clips touches outside a parent's bounds and a
 * header is exactly the kind of parent that does.
 *
 * ---------------------------------------------------------------------------
 * STATES
 *
 *   - `disabled`: drawn at Button's disabled opacity; the reason is the hint.
 *   - `saving`: the label reads "Saving…", presses are ignored, a11y `busy`.
 *   - presses within {@link REPEAT_GUARD_MS} of an accepted one are ignored, so a double
 *     tap is one save whatever the caller does with `saving`.
 */
export function SaveButton({
  onPress,
  saving = false,
  disabled = false,
  disabledReason,
  label = 'Save',
  accessibilityLabel,
  testID = 'save-button',
}: SaveButtonProps) {
  const inert = saving || disabled;
  const press = usePressScale({ enabled: !inert });
  const lastAccepted = useRef(0);

  const handlePress = () => {
    if (inert) return;
    const now = Date.now();
    if (now - lastAccepted.current < REPEAT_GUARD_MS) return;
    lastAccepted.current = now;
    onPress();
  };

  return (
    <Animated.View style={press.pressStyle}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled: inert, busy: saving }}
        accessibilityHint={saving ? 'Saving your changes' : disabled ? disabledReason : undefined}
        disabled={inert}
        onPress={handlePress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={styles.target}
      >
        {({ pressed }) => (
          <View
            testID={`${testID}-fill`}
            style={[styles.fill, pressed && !inert && styles.pressed, inert && styles.inert]}
          >
            <Text
              variant="subhead"
              tone="inverse"
              numberOfLines={1}
              // A header has no room to grow into: past this the word stops growing
              // rather than wrapping the bar to two lines.
              maxFontSizeMultiplier={1.3}
              style={styles.label}
            >
              {saving ? 'Saving…' : label}
            </Text>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  target: {
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fill: {
    minHeight: theme.layout.control.compactAction.visibleHeight,
    paddingHorizontal: theme.layout.control.compactAction.paddingHorizontal,
    borderRadius: theme.radius.control,
    backgroundColor: theme.semantic.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontFamily: theme.typography.headline.fontFamily },
  // Rank's own pressed state.
  pressed: { opacity: 0.7 },
  // Button's disabled state.
  inert: { opacity: 0.4 },
});
