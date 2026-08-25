import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type DividerProps = {
  /**
   * A word set into the rule — "or", between two ways of doing the same thing.
   *
   * Absent for the ordinary case, which is a rule separating two sections that do not
   * need the relationship spelled out. It exists for the sign-in screen, where the rule
   * between the password form and the social buttons is making a claim — *these are
   * alternatives, not steps* — and a bare line leaves a reader to infer it.
   */
  label?: string;
};

export function Divider({ label }: DividerProps) {
  if (!label) return <View style={styles.rule} />;

  return (
    // One element to a screen reader rather than three, and the word is the whole of
    // what it has to say: the two rules either side are decoration and are hidden.
    <View style={styles.row} accessible accessibilityRole="none" accessibilityLabel={label}>
      <View style={styles.half} accessibilityElementsHidden />
      <Text variant="caption" tone="tertiary">
        {label}
      </Text>
      <View style={styles.half} accessibilityElementsHidden />
    </View>
  );
}

const styles = StyleSheet.create({
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border.hairline,
    marginHorizontal: theme.layout.gutter,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    marginHorizontal: theme.layout.gutter,
  },
  half: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border.hairline,
  },
});
