import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type RankBadgeProps = {
  position: number;
  /** Required. A bare ordinal is meaningless across categories. */
  category: string;
  emphasis?: boolean;
};

/**
 * The ordinal, always accompanied by its category (design-system.md §8).
 *
 * Never rendered as a score, percentage, ring, or bar. This is the constraint
 * most likely to be violated by muscle memory, because every comparable app
 * displays a number out of ten — and PRD §11 forbids it.
 */
export function RankBadge({ position, category, emphasis = false }: RankBadgeProps) {
  return (
    <View style={[styles.container, !emphasis && styles.chip]}>
      <Text
        variant="headline"
        tone={emphasis ? 'action' : 'primary'}
        accessibilityLabel={`Number ${position} in ${category}`}
      >
        #{position} in {category}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'flex-start' },
  chip: {
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    paddingHorizontal: theme.space[2],
    paddingVertical: theme.space[1],
  },
});
