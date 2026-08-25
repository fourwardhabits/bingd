import { Pressable, StyleSheet, View } from 'react-native';

import { fontFamily, theme } from '@/ui/tokens';
import { Text } from '@/ui/components';

export type RequestAlertRowProps = {
  /** Pending recommendation **items**, not senders. Never rendered at zero. */
  count: number;
  onPress: () => void;
};

/**
 * `Recommendation requests · 3                      View`
 *
 * The one signal that anything is waiting, and it lives here rather than on the Bell.
 * A recommendation request is a decision — add it, throw it away, or follow the person
 * — and the Notifications timeline is a chronological log of things that happened, with
 * no way to represent a decision and no way to resolve one. Putting requests there
 * would also move a badge the inbox cannot clear.
 *
 * **Compact, and deliberately not a call to action.** It is one line above the filter
 * row: a statement with a way in, sized like the chips beside it rather than like a
 * banner. No dismiss control and no `X` — the only way to make it go away is to decide
 * about the recommendations, which is the point.
 *
 * The whole row is the target *and* View is labelled, which is the pattern the app's
 * other compact rows follow: the small word is what the eye finds, and the large
 * rectangle is what a thumb hits.
 */
export function RequestAlertRow({ count, onPress }: RequestAlertRowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        count === 1 ? '1 recommendation request' : `${count} recommendation requests`
      }
      accessibilityHint="Opens the recommendations waiting for you"
      onPress={onPress}
      testID="recommendation-requests-alert"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.copy}>
        <Text variant="footnote" numberOfLines={1}>
          Recommendation requests
        </Text>
        {/* The count in the app's one chromatic element, which is what makes a quiet
            row findable without making it loud. */}
        <Text variant="footnote" style={styles.count}>
          {` · ${count}`}
        </Text>
      </View>

      {/* Present to the eye and hidden from the accessibility tree: the row itself is
          already one labelled button, and a nested one would announce the same action
          twice. The same rule `Sheet` applies to its backdrop. */}
      <Text
        variant="footnote"
        style={styles.action}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        View
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.minTapTarget,
    marginHorizontal: theme.layout.gutter,
    marginTop: theme.space[3],
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  copy: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  count: { color: theme.semantic.action, fontFamily: fontFamily.sansSemibold },
  action: { color: theme.semantic.action, fontFamily: fontFamily.sansSemibold },
  pressed: { opacity: 0.7 },
});
