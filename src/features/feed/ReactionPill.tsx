import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { REACTIONS, type ReactionKind } from './use-reactions';

export type ReactionPillProps = {
  /** What the viewer has already chosen, so the pill can offer to take it back. */
  current: ReactionKind | null;
  onChoose: (kind: ReactionKind | null) => void;
  onDismiss: () => void;
};

/**
 * The six reactions as one compact row, anchored above the action it belongs to.
 *
 * This is the messaging-app treatment the founder asked for, built without the part
 * that usually makes it fragile. There is no `measureInWindow`, no portal and no
 * absolute screen coordinate: the pill is positioned relative to its own parent,
 * inside the activity row, so it travels with the row when the feed scrolls and
 * cannot drift away from the button it belongs to. Nothing about it depends on where
 * the row happens to be.
 *
 * It is laid out *within* the row's bounds rather than floating above them, which is
 * the other half of not being fragile: a child drawn outside its parent is clipped on
 * Android and not on iOS, and a control that exists on one platform is worse than a
 * slightly lower one on both.
 *
 * Emoji only. The founder's amendment is explicit that no visible text labels appear
 * here, so each glyph carries its meaning in `accessibilityLabel` instead — "😮"
 * announces as "Wow", and as nothing at all without it.
 */
export function ReactionPill({ current, onChoose, onDismiss }: ReactionPillProps) {
  return (
    <>
      {/* Anything outside the pill dismisses it. Inside the row, so it cannot
          swallow taps meant for the rest of the feed. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close reactions"
        onPress={onDismiss}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.pill} accessibilityRole="menu">
        {REACTIONS.map((reaction) => {
          const selected = current === reaction.kind;
          return (
            <Pressable
              key={reaction.kind}
              accessibilityRole="menuitem"
              accessibilityState={{ selected }}
              accessibilityLabel={selected ? `Remove ${reaction.label}` : reaction.label}
              onPress={() => onChoose(selected ? null : reaction.kind)}
              hitSlop={theme.space[1]}
              style={({ pressed }) => [
                styles.option,
                selected && styles.selected,
                pressed && styles.pressed,
              ]}
            >
              <Text variant="title2" allowFontScaling={false} accessibilityElementsHidden>
                {reaction.glyph}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: theme.space[1],
    paddingHorizontal: theme.space[2],
    paddingVertical: theme.space[1],
    borderRadius: theme.radius.full,
    backgroundColor: theme.surface.raised,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    ...theme.elevation.e2,
  },
  option: {
    width: theme.layout.minTapTarget - theme.space[2],
    height: theme.layout.minTapTarget - theme.space[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.full,
  },
  // Parchment behind the chosen one. The palette has no second accent to spend
  // here, and a ring would compete with the pill's own border.
  selected: { backgroundColor: theme.surface.sunken },
  pressed: { opacity: 0.6 },
});
