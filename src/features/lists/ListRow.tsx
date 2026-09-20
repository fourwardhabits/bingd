import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { ChipDot, VisibilityChip } from './ListChips';
import { ListCover } from './ListCover';
import { titleCountLabel, updatedLabel, VISIBILITY_CHIP, type MyListSummary } from './types';

const COVER = 64;

export type ListRowProps = {
  list: MyListSummary;
  onPress: () => void;
};

/**
 * One row of the My lists screen: **one row, three facts, no controls** (§I).
 *
 * - **Line 1** is the name.
 * - **Line 2** is `N titles · Numbered · <chip>`. `Numbered` appears only when the list
 *   actually is, so its presence carries information rather than its value.
 * - **Line 3** is `Updated <date>`, which is *also* the sort key — so the order of the
 *   screen explains itself and needs no sort control.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NOTHING TO TAP EXCEPT THE ROW
 *
 * No swipe-to-delete, no overflow, no long press. Delete lives in the list's own edit
 * mode, in one place (§G), and §Q.6 rules out long-press everywhere in v1 — the gesture
 * already means three different things elsewhere in this app, and a fourth meaning
 * discoverable only by accident is not a feature.
 *
 * A swipe here would also be the one destructive gesture in the product reachable
 * without opening the thing it destroys.
 */
export function ListRow({ list, onPress }: ListRowProps) {
  const numbered = list.orderStyle === 'ranked';

  // The whole row as one sentence, because four separate text nodes read as four
  // separate results to anybody using a screen reader.
  const spoken = [
    list.title,
    titleCountLabel(list.itemCount),
    numbered ? 'Numbered' : null,
    list.hidden ? 'Hidden by moderation' : VISIBILITY_CHIP[list.visibility],
    updatedLabel(list.updatedAt),
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <ListCover posterUris={list.posterUris} size={COVER} />

      <View style={styles.lines}>
        <Text variant="callout" numberOfLines={2}>
          {list.title}
        </Text>

        <View style={styles.facts}>
          <Text variant="footnote" tone="secondary">
            {titleCountLabel(list.itemCount)}
          </Text>
          {numbered ? (
            <>
              <ChipDot />
              <Text variant="footnote" tone="secondary">
                Numbered
              </Text>
            </>
          ) : null}
          <ChipDot />
          <VisibilityChip visibility={list.visibility} hidden={list.hidden} />
        </View>

        <Text variant="footnote" tone="tertiary">
          {updatedLabel(list.updatedAt)}
        </Text>
      </View>

      <Ionicons
        name="chevron-forward"
        size={theme.layout.icon.sm}
        color={theme.text.tertiary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    minHeight: theme.layout.minTapTarget,
  },
  // `flex: 1` so a long list name wraps inside the row rather than pushing the
  // chevron off the screen — `MediumSelector`'s lesson at a smaller size.
  lines: { flex: 1, gap: theme.space[1] },
  // Wraps, because "14 titles · Numbered · Only you" does not fit beside a 64pt cover
  // at the largest text size, and a clipped chip is worse than a second line.
  facts: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space[1] },
  pressed: { opacity: 0.7 },
});
