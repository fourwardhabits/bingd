import { Pressable, StyleSheet, View } from 'react-native';

import { Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { REACTIONS, type ReactionKind } from './use-reactions';

export type ReactionPickerProps = {
  visible: boolean;
  /** What the viewer has already chosen, so the row can offer to take it back. */
  current: ReactionKind | null;
  onClose: () => void;
  /** Null clears. */
  onChoose: (kind: ReactionKind | null) => void;
};

/**
 * The six reactions, as a sheet.
 *
 * A row of six glyphs inline under every activity would be six tap targets per item
 * and would make the feed's action row wider than its content. A sheet keeps the row
 * to one control and gives each reaction a real 44pt target and a spoken label —
 * which matters more here than usual, because a glyph is the entire visible content
 * of the button and "😲" reads as nothing at all.
 *
 * Choosing the one already chosen removes it. PRD §14 requires a reaction to be
 * changeable and removable, and a separate Remove row would be a seventh option for
 * something that is really the same control twice.
 */
export function ReactionPicker({ visible, current, onClose, onChoose }: ReactionPickerProps) {
  if (!visible) return null;

  return (
    <Sheet visible onClose={onClose} label="React to this activity">
      <View style={styles.grid}>
        {REACTIONS.map((reaction) => {
          const selected = current === reaction.kind;
          return (
            <Pressable
              key={reaction.kind}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={selected ? `Remove ${reaction.label}` : reaction.label}
              onPress={() => onChoose(selected ? null : reaction.kind)}
              style={({ pressed }) => [
                styles.option,
                selected && styles.selected,
                pressed && styles.pressed,
              ]}
            >
              <Text variant="title2" accessibilityElementsHidden>
                {reaction.glyph}
              </Text>
              <Text variant="caption" tone={selected ? 'primary' : 'secondary'} numberOfLines={1}>
                {reaction.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[4],
  },
  option: {
    flexGrow: 1,
    flexBasis: '30%',
    alignItems: 'center',
    gap: theme.space[1],
    paddingVertical: theme.space[3],
    minHeight: theme.layout.minTapTarget,
    borderRadius: theme.radius.card,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  selected: { backgroundColor: theme.surface.sunken, borderColor: theme.semantic.action },
  pressed: { opacity: 0.7 },
});
