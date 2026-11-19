import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type IconActionProps = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  active?: boolean;
  selected?: boolean;
  badge?: string;
  /**
   * A 44pt-wide box as well as 44pt tall. `ActivityRow`'s actions sit in a strip with room
   * for their slop; a compact row's do not, and on Android a touch outside a parent's
   * bounds is dropped, so there the target has to be real layout.
   */
  square?: boolean;
  testID?: string;
};

/**
 * One icon action in a row's action strip: a glyph and an optional count beside it.
 *
 * The label is what a screen reader gets, and it names the thing being acted on rather
 * than the glyph — "Add Sinners to your watchlist", not "Bookmark". An icon row is only
 * denser than a text row if the meaning moves into the label rather than being dropped.
 *
 * Shared by `ActivityRow` and `FollowStoryRow` (Workstream C, 2026-11-19), so two rows that
 * carry a comment control draw one control. Moved out of `ActivityRow` unchanged.
 */
export function IconAction({
  icon,
  label,
  onPress,
  active = false,
  selected,
  badge,
  square = false,
  testID,
}: IconActionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      hitSlop={square ? undefined : theme.space[2]}
      style={({ pressed }) => [styles.action, square && styles.square, pressed && styles.pressed]}
      testID={testID}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={active ? theme.semantic.action : theme.text.secondary}
      />
      {badge ? (
        <Text variant="caption" tone={active ? 'action' : 'secondary'}>
          {badge}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget,
  },
  square: { minWidth: theme.layout.minTapTarget, justifyContent: 'center' },
  pressed: { opacity: 0.7 },
});
