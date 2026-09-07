import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type TitleAction = {
  /** React key, and what the test reaches for. */
  id: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  /** The word under the glyph. One word wherever one will do. */
  label: string;
  /** The whole sentence, for a reader who cannot see the glyph. */
  accessibilityLabel: string;
  onPress: () => void;
  /** Held state — the bookmark, and nothing else today. */
  selected?: boolean;
  disabled?: boolean;
};

/**
 * The three things you can do to a title, as one group.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES
 *
 * Three controls of three different kinds, in two different places. A full-height
 * `Ranked` chip with a tick and a label; two bare glyphs under it with no labels at all;
 * and, before that, a row of Maroon-filled chips further down the page. They did not
 * read as alternatives to one another, which is what they are — so the page had one
 * loud control and two quiet ones rather than a set.
 *
 * They are now one row of three, on one baseline, at one weight. The rank state is no
 * longer among them: a `✓ Ranked` button that exists to *report* is a button standing in
 * for a fact, and the fact is already on the poster in the reader's own score. What is
 * left here is only what a reader can *do* — adjust where it sits, keep it, send it —
 * and the first of those is what the button used to be a door to.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GLYPHS KEEP A WORD
 *
 * Because two of them are ambiguous without one. A paper plane is Recommend on this
 * screen and Send on most others; two arrows are Adjust here and Sort elsewhere. The
 * founder's icon-only pass was right about the *weight* — these are secondary to the
 * score — and a `caption` under a glyph costs nine points of height and settles what the
 * glyph means. Bookmark would survive alone and is labelled anyway, because a set of
 * three where one is labelled differently is no longer a set.
 *
 * Each control takes an equal share of the row and never wraps: the labels are short,
 * they truncate rather than reflow, and a group that becomes two rows at 130% type is a
 * group that has stopped being one thing.
 */
export function TitleActions({ actions }: { actions: readonly TitleAction[] }) {
  if (!actions.length) return null;

  return (
    <View testID="title-actions" style={styles.row}>
      {actions.map((action) => (
        <Pressable
          key={action.id}
          testID={`title-action-${action.id}`}
          accessibilityRole="button"
          accessibilityState={{
            selected: Boolean(action.selected),
            disabled: Boolean(action.disabled),
          }}
          accessibilityLabel={action.accessibilityLabel}
          onPress={action.onPress}
          disabled={action.disabled}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Ionicons
            name={action.icon}
            size={theme.layout.icon.md}
            // Maroon when held, neutral otherwise — the app's one selected-control
            // treatment, the same pair the feed row and the search row draw.
            color={action.selected ? theme.semantic.action : theme.text.secondary}
          />
          <Text
            variant="caption"
            tone={action.selected ? 'action' : 'secondary'}
            numberOfLines={1}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * No wrap, and equal shares.
   *
   * `nowrap` is the guarantee the founder asked for; equal shares are what make the row
   * read as one control with three positions rather than as three controls that happen
   * to be adjacent. The gap is small because the shares already separate them.
   */
  row: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    paddingHorizontal: theme.layout.gutter,
    gap: theme.space[2],
    // Clearance for the score, which hangs below the poster's lower edge on its `YOU`
    // pill. The identity row cannot carry it: the badge is absolutely positioned there
    // precisely so it does not push the row taller.
    paddingTop: theme.space[5],
  },
  // 44pt without a visible box: the target is the whole share of the row, and there is
  // no border, fill or radius to make three quiet acts look like three buttons.
  action: {
    flex: 1,
    minHeight: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: theme.space[1],
  },
  pressed: { opacity: 0.7 },
});
