import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../tokens';
import { ReactionSlot } from './ReactionControl';
import { Text } from './Text';

export type ActivityReaction = {
  /** How many people have reacted at all. */
  count: number;
  /** The reader's own glyph, or null. Its presence is what fills the control. */
  mineGlyph?: string | null;
  /** The word for the reader's own reaction (Liked, Laugh…), or null. Spoken with it. */
  mineLabel?: string | null;
  /** The distinct glyphs present, most common first (PRD §14). */
  glyphs?: string[];
  /** A plain tap: toggles the default reaction on or off. */
  onPress: () => void;
  /** A long press: opens the full picker. */
  onLongPress?: () => void;
  /** Tapping the summary opens the list of who reacted. */
  onPressSummary?: () => void;
  /** Rendered inside the row, above the actions — see `ReactionPill`. */
  picker?: React.ReactNode;
  /**
   * False on the viewer's own activity: no heart and no picker, only everyone else's
   * reactions on the summary line (founder, 2026-11-10). Defaults to true.
   */
  canReact?: boolean;
  /** "Priya and 3 others like this", longest first (`summaryForms`). */
  summaryForms?: string[];
  /** The summary's glyphs, the viewer's own first (`clusterKinds`). Falls back to `glyphs`. */
  summaryGlyphs?: string[];
};

export type EngagementRowProps = {
  /** Whose post this is, for the spoken labels: "React to Ada's activity about …". */
  actorName: string;
  /** What the post is about, as the sentence names it: a title, "8 titles", an award. */
  subject: string;
  /** The Like. Absent, or `canReact: false`, draws no Like at all. */
  reaction?: ActivityReaction | null;
  /** Opens the comment sheet. Absent draws no Comment. */
  onPressComments?: () => void;
  commentCount?: number;
  /** Save to the reader's watchlist. Only an individual title's post is given one. */
  onPressSave?: () => void;
  saved?: boolean;
  /** The Recommend sheet, which ends in "Share off bingd". Only where a title can be sent. */
  onPressShare?: () => void;
  /** Margins or padding from the host, so the columns sit on its gutters. */
  style?: StyleProp<ViewStyle>;
  /** `${testID}-like`, `-comment`, `-save` and `-share` on the controls; the row itself is `${testID}-actions`. */
  testID?: string;
};

/**
 * **One engagement row for every Feed post** (founder, 2026-11-19).
 *
 *     ♡ Like        💬 Comment        🔖 Save        ➤ Share
 *
 * The cinematic card's labelled row, lifted out of `FeedCard` so an award, a goal and a
 * grouped post draw exactly the controls a movie post does — the same icons at
 * `icon.sm`, the same footnote labels, the same 44pt targets — instead of the compact
 * row's bare glyphs. Before this, an award read as two tiny icons beside a timestamp and
 * a grouped post as a Like on the far left and a Comment on the far right.
 *
 * **Equal columns.** Each action present takes the same share of the row and centres its
 * icon and word in it, so two actions read as a pair and four as a row of four, never as
 * two controls pushed to opposite edges. The column is the touch target: at least 44pt
 * tall and wide, and on a 320pt phone with four actions still about 78pt wide.
 *
 * **What is drawn is what works.** Every control is present only when its caller wired
 * it, so nothing on the row is decorative or disabled:
 *
 *   - **Like** reuses the reaction grammar unchanged: a tap toggles the default reaction,
 *     a long press opens the picker, and the summary line above the row (the host's
 *     `ReactionSummary`) opens who reacted. The slot is `ReactionSlot`, so the heart and
 *     every emoji occupy one box and a tap moves nothing.
 *   - **Comment** opens the comment sheet; its word becomes the count once there is one.
 *   - **Save** is the watchlist write, and only an individual title's post has one — not
 *     the reader's own, not an award, not a group.
 *   - **Share** is the Recommend sheet for a title. An award or a group has no share
 *     behaviour yet (`docs/design/screens.md` §7), so it has no Share rather than a dead one.
 *
 * **Narrow screens.** The labels are one line each. On the narrowest phones with four
 * actions, "Comment" is the one word that can be wider than its column; it shrinks a
 * little to fit (to 85%) before it would ever truncate, and nothing leaves the row.
 */
export function EngagementRow({
  actorName,
  subject,
  reaction,
  onPressComments,
  commentCount = 0,
  onPressSave,
  saved = false,
  onPressShare,
  style,
  testID = 'engagement',
}: EngagementRowProps) {
  const canReact = reaction != null && reaction.canReact !== false;
  const mine = canReact ? (reaction.mineGlyph ?? null) : null;

  if (!canReact && !onPressComments && !onPressSave && !onPressShare) return null;

  return (
    <View style={[styles.row, style]} testID={`${testID}-actions`}>
      {canReact ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: Boolean(mine) }}
          accessibilityLabel={
            mine
              ? `${reaction.mineLabel ? `${reaction.mineLabel}. ` : ''}You reacted to ${subject}. Tap to remove, long press to change.`
              : `React to ${actorName}'s activity about ${subject}. Long press for more reactions.`
          }
          accessibilityHint={
            reaction.onLongPress ? 'Long press to choose a different reaction' : undefined
          }
          onPress={reaction.onPress}
          onLongPress={reaction.onLongPress}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          testID={`${testID}-like`}
        >
          {/* Every selected state is its emoji and its word, a Like included: the ❤️ and
              Liked, the way 😂 Laugh and 😮 Wow are drawn (founder, nav cohesion sprint,
              2026-11-06). Both states sit in the one fixed slot, so a tap moves nothing. */}
          <ReactionSlot glyph={mine} color={theme.text.secondary} />
          <Label active={Boolean(mine)}>
            {mine ? (reaction.mineLabel ?? 'Reacted') : 'Like'}
          </Label>
        </Pressable>
      ) : null}

      {onPressComments ? (
        <Action
          icon="chatbubble-outline"
          label={commentCount > 0 ? String(commentCount) : 'Comment'}
          accessibilityLabel={
            commentCount > 0
              ? `${commentCount} ${commentCount === 1 ? 'comment' : 'comments'} on ${actorName}'s activity about ${subject}. Open them.`
              : `Comment on ${actorName}'s activity about ${subject}`
          }
          onPress={onPressComments}
          testID={`${testID}-comment`}
        />
      ) : null}

      {onPressSave ? (
        <Action
          icon={saved ? 'bookmark' : 'bookmark-outline'}
          active={saved}
          selected={saved}
          label={saved ? 'Saved' : 'Save'}
          accessibilityLabel={
            saved ? `${subject} is in your watchlist` : `Add ${subject} to your watchlist`
          }
          onPress={onPressSave}
          testID={`${testID}-save`}
        />
      ) : null}

      {onPressShare ? (
        <Action
          icon="paper-plane-outline"
          label="Share"
          accessibilityLabel={`Share ${subject} with a friend`}
          onPress={onPressShare}
          testID={`${testID}-share`}
        />
      ) : null}
    </View>
  );
}

function Action({
  icon,
  label,
  accessibilityLabel,
  onPress,
  active = false,
  selected,
  testID,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  active?: boolean;
  selected?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      testID={testID}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={active ? theme.semantic.action : theme.text.secondary}
      />
      <Label active={active}>{label}</Label>
    </Pressable>
  );
}

/** One line, shrinking a little before it truncates; never wider than its column. */
function Label({ active, children }: { active: boolean; children: string }) {
  return (
    <Text
      variant="footnote"
      tone={active ? 'action' : 'secondary'}
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={LABEL_MIN_SCALE}
      style={styles.label}
    >
      {children}
    </Text>
  );
}

/** How far a label may shrink to fit its column before it truncates instead. */
export const LABEL_MIN_SCALE = 0.85;

/**
 * How far in from the screen's edge a host sets the row: 4pt. The columns centre their
 * contents, so the edges are air rather than alignment, and every point given back is
 * width for the labels on a 320pt phone (312pt, four columns of 78).
 */
export const ENGAGEMENT_EDGE = theme.space[1];

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch' },
  /**
   * An equal column: `flex: 1` from a zero basis, so every action present is the same
   * width whatever its word, and `minWidth` keeps the 44pt floor. The icon and the word
   * are centred in it, 4pt apart.
   */
  action: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
  },
  label: { flexShrink: 1 },
  pressed: { opacity: 0.7 },
});
