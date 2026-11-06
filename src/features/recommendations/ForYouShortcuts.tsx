import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Text } from '@/ui/components';
import { hapticSelection } from '@/ui/haptics';
import { theme } from '@/ui/tokens';

/**
 * For You's two feature entry points, **Sent to You and Watch Together** (founder, nav
 * cohesion sprint, 2026-11-06).
 *
 * They are features, not filters, and they used to be drawn as two more chips in the
 * Filters row. Now they are a pair of their own under the page's heading row: equal
 * halves, a Maroon icon and word, a feature hairline (`actionSubtle`) and no card fill.
 * Filters moved up beside the heading as a quiet text action, so the three no longer read
 * as equivalent pills, and the page is still two rows of controls above the wall.
 *
 * Sent to You keeps its toggle (Parchment and a Maroon outline while the wall shows the
 * sent list) and its unread count, now a badge drawn like the bell's. Watch Together opens
 * its sheet. Each is a 44pt target. At a large text size the pair stacks rather than
 * squeezing two labels into two halves.
 */
export type ForYouShortcut = {
  key: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  accessibilityLabel?: string;
  /** Unread items, drawn as a badge; a string so `12+` can say "at least". */
  badge?: string | null;
  /** A toggle's state. Absent for a shortcut that opens something. */
  selected?: boolean;
  onPress: () => void;
};

/** Above this text size the two halves stack, one full-width row each. */
const STACK_AT_FONT_SCALE = 1.2;

export function ForYouShortcuts({ shortcuts }: { shortcuts: readonly ForYouShortcut[] }) {
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale >= STACK_AT_FONT_SCALE;
  if (shortcuts.length === 0) return null;

  return (
    <View
      style={[styles.row, stacked && styles.stacked]}
      testID="for-you-shortcuts"
      accessibilityLabel="For You features"
    >
      {shortcuts.map((shortcut) => {
        const toggle = shortcut.selected !== undefined;
        return (
          <Pressable
            key={shortcut.key}
            accessibilityRole="button"
            accessibilityLabel={shortcut.accessibilityLabel ?? shortcut.label}
            accessibilityState={toggle ? { selected: shortcut.selected } : undefined}
            onPress={() => {
              hapticSelection();
              shortcut.onPress();
            }}
            hitSlop={{ top: HIT_SLOP, bottom: HIT_SLOP }}
            testID={`for-you-shortcut-${shortcut.key}`}
            style={({ pressed }) => [
              styles.shortcut,
              !stacked && styles.half,
              shortcut.selected && styles.selected,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name={shortcut.icon}
              size={theme.layout.icon.sm}
              color={theme.semantic.action}
            />
            <Text
              variant="subhead"
              tone="action"
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              style={styles.label}
            >
              {shortcut.label}
            </Text>
            {shortcut.badge ? (
              <View style={styles.badge} accessibilityElementsHidden>
                <Text variant="caption" tone="action" allowFontScaling={false}>
                  {shortcut.badge}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** 40pt drawn, 44pt pressed. */
const HEIGHT = 40;
const HIT_SLOP = (theme.layout.minTapTarget - HEIGHT) / 2;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[1],
    paddingBottom: theme.space[4],
  },
  stacked: { flexDirection: 'column' },
  shortcut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[1],
    minHeight: HEIGHT,
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.semantic.actionSubtle,
  },
  half: { flex: 1, flexBasis: 0, paddingHorizontal: theme.space[1] },
  selected: { borderColor: theme.semantic.action, backgroundColor: theme.surface.sunken },
  label: { flexShrink: 1 },
  // The bell's badge, in line rather than on a corner: Parchment, a Maroon ring and numeral.
  badge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: theme.radius.full,
    backgroundColor: theme.surface.sunken,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.semantic.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
});
