import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { VISIBILITY_CHIP, VISIBILITY_ICON, type ListVisibility } from './types';

export type VisibilityChipProps = {
  visibility: ListVisibility;
  /** Drawn in the moderation-hidden state: the chip says so and loses its colour. */
  hidden?: boolean;
};

/**
 * Which of the three modes a list is in — **glyph and word, never a glyph alone**.
 *
 * `TitleActions`' rule, applied to a smaller control: a padlock beside a list name
 * could mean private, could mean locked, could mean spoiler-hidden. The three words are
 * the New-list picker's own options, shortened, so the chip is recognisable as *the
 * choice that was made* rather than as a status somebody has to learn.
 *
 * "Only you" rather than "Private" for the same reason the picker says it: it describes
 * the audience, which is the thing a person is actually deciding about.
 */
export function VisibilityChip({ visibility, hidden = false }: VisibilityChipProps) {
  const label = hidden ? 'Hidden' : VISIBILITY_CHIP[visibility];
  const icon = hidden ? 'eye-off-outline' : VISIBILITY_ICON[visibility];
  const tone = hidden ? theme.text.tertiary : theme.text.secondary;

  return (
    <View style={styles.chip} accessibilityLabel={label}>
      <Ionicons name={icon} size={theme.layout.icon.sm - 6} color={tone} />
      <Text variant="footnote" tone={hidden ? 'tertiary' : 'secondary'}>
        {label}
      </Text>
    </View>
  );
}

/** The dot between two facts on one line. Its own component so the spacing is one decision. */
export function ChipDot() {
  return (
    <Text variant="footnote" tone="tertiary" accessibilityElementsHidden>
      ·
    </Text>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
});
