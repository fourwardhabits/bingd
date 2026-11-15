import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type FilterIconButtonProps = {
  /** Filters in force. Above zero, the glyph turns Maroon and carries the count. */
  activeCount: number;
  onPress: () => void;
  /**
   * The control's spoken name, e.g. "Filters and sort". With filters on, `, 2 on` is
   * appended unless `announceCount` is false (a caller whose label already says it).
   */
  accessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
  // ---- Optional extensions ----
  accessibilityHint?: string;
  /** Append ", N on" to the spoken name when filters are on. Default true. */
  announceCount?: boolean;
};

/**
 * **Filters, as one icon** (FU1113-B): the `options-outline` glyph in a 44pt cell, no word.
 *
 * Off: secondary ink. On: Maroon ink and a small Maroon count in the glyph's corner, and
 * the same state spoken — "Filters and sort, 2 on" — and exposed as `selected`. Disabled:
 * tertiary ink, inert, and announced as disabled.
 *
 * The cell is `minTapTarget` square, drawn and pressable alike, so it needs no slop and
 * cannot be shrunk below the target by a crowded row (`BrowseControlsRow` never shrinks
 * its trailing side, and this sets `flexShrink: 0` itself as well).
 */
export function FilterIconButton({
  activeCount,
  onPress,
  accessibilityLabel,
  disabled = false,
  testID,
  accessibilityHint,
  announceCount = true,
}: FilterIconButtonProps) {
  const on = activeCount > 0 && !disabled;
  const spoken = on && announceCount ? `${accessibilityLabel}, ${activeCount} on` : accessibilityLabel;
  const ink = disabled
    ? theme.text.tertiary
    : on
      ? theme.semantic.action
      : theme.text.secondary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: on, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
      testID={testID}
    >
      <View>
        <Ionicons name="options-outline" size={theme.layout.icon.sm} color={ink} />
        {on ? (
          <View
            style={styles.count}
            testID={testID ? `${testID}-count` : 'filter-icon-count'}
            // The count is in the spoken name already.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text variant="caption" tone="inverse" allowFontScaling={false} style={styles.countText}>
              {activeCount > 9 ? '9+' : String(activeCount)}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** The count bubble's diameter: a caption numeral and 2pt either side. */
const COUNT = theme.space[4];

const styles = StyleSheet.create({
  cell: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: {
    position: 'absolute',
    // Half the bubble past the glyph's top-right corner, so it reads as the glyph's badge.
    top: -COUNT / 2 + 2,
    right: -COUNT / 2,
    minWidth: COUNT,
    height: COUNT,
    paddingHorizontal: 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.semantic.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A caption numeral set solid in the bubble; the bubble, not the line, sets its height.
  countText: { lineHeight: COUNT },
  pressed: { opacity: 0.6 },
});
