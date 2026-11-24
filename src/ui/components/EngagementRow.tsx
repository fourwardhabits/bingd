import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

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
  /**
   * Content-sized actions from the leading edge rather than equal columns (default false).
   * For a host that draws one action on its own — the Comments page's Like (2026-11-24) —
   * where a single equal column would centre a lone button across the whole card.
   */
  compact?: boolean;
  /** Margins or padding from the host, so the columns sit on its gutters. */
  style?: StyleProp<ViewStyle>;
  /**
   * The row's side padding when three or more actions are spread (`spread`): the host's
   * content inset, so the first action starts and the last ends on the post's edges.
   * Defaults to `ENGAGEMENT_EDGE`.
   */
  spreadInset?: number;
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
 *   - **Comment** opens the comment sheet.
 *   - **Save** is the watchlist write, and only an individual title's post has one — not
 *     the reader's own, not an award, not a group.
 *   - **Share** is the Recommend sheet for a title. An award or a group has no share
 *     behaviour yet (`docs/design/screens.md` §7), so it has no Share rather than a dead one.
 *
 * **Counts: one convention on every post** (refined card feed, 2026-11-22; format from the
 * founder's Android QA, 2026-11-22). Each action keeps its word, and once there is activity
 * the count follows it in parentheses: `Like (2)`, `Comment (3)`, `Liked (5)`. Only the
 * number and its parentheses take the Maroon accent (`semantic.action`); the word and the
 * icon keep the action's own colour. Zero is never drawn: with nothing yet the action is its
 * word alone, never `Like (0)`. A count of a thousand or more is compact (`(1.2K)`,
 * `(12K)`), and every count is also said in the action's spoken label. The numbers are the
 * ones the Feed already reads: the reaction count, and `activity_comment_counts`, which
 * counts every readable comment on the post, replies included.
 *
 * **Nothing is cut off, on any phone** (founder, 2026-11-23). A label has no line cap, no
 * ellipsis and no shrink-to-fit. Three or more actions are sized to their own content and
 * spread with `space-between` across the host's content inset (`spreadInset`), so
 * `Liked (2) · Comment (3) · Share` takes the width the words need instead of three equal
 * columns, one of which was too narrow for "Comment (3)" at 320pt and cut it to "Commen…".
 * Two actions keep their equal columns, centred in each half (founder, 2026-11-19: a
 * pair at opposite edges read as two unrelated controls).
 *
 * If the words still do not fit (large text, a narrow phone, `(1.2K)`), only the count
 * drops below its word: the word and its count are joined by an ordinary space, and only
 * an action with a count may shrink, so a bare word ("Share") never wraps or breaks. Every
 * action keeps its 44pt target either way.
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
  spreadInset = ENGAGEMENT_EDGE,
  testID = 'engagement',
  compact = false,
}: EngagementRowProps) {
  const canReact = reaction != null && reaction.canReact !== false;
  const mine = canReact ? (reaction.mineGlyph ?? null) : null;
  const { fontScale } = useWindowDimensions();
  const [rowWidth, setRowWidth] = useState<number | null>(null);

  // The words each present action shows, for the last-resort wrap below.
  const words = [
    canReact ? (mine ? (reaction.mineLabel ?? 'Reacted') : 'Like') : null,
    onPressComments ? 'Comment' : null,
    onPressSave ? (saved ? 'Saved' : 'Save') : null,
    onPressShare ? 'Share' : null,
  ].filter((word): word is string => word != null);
  if (!words.length) return null;

  /**
   * **The last resort: the row wraps** (Codex review, 2026-11-23). A word never shrinks or
   * breaks, so at very large text on a narrow phone even the bare words can be wider than
   * the row, and a row that cannot wrap pushes its last action out of the card, where the
   * card clips it. When the words alone (each beside its icon, counts left to drop below)
   * cannot fit the row as measured, the actions are content-sized and the row wraps onto a
   * second line instead. Ordinary text sizes never reach it: at 320pt the three words fit
   * up to about 133% text, at 360pt up to about 164%.
   */
  const wraps =
    rowWidth != null &&
    wordsWidth(words, theme.typography.footnote.fontSize * fontScale) > rowWidth;
  const spread = compact || words.length >= 3 || wraps;
  /** An action's box: an equal column for a pair, its own width when spread. */
  const boxFor = (count: number) =>
    !spread ? styles.action : actionCount(count) ? styles.spreadShrinks : styles.spreadFixed;
  const onLayout = (event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    const inner = width - (spread ? spreadInset * 2 : ENGAGEMENT_EDGE * 2);
    if (inner !== rowWidth) setRowWidth(inner);
  };

  return (
    <View
      style={[
        styles.row,
        style,
        spread && [styles.spread, { paddingHorizontal: spreadInset }],
        wraps && styles.wrap,
      ]}
      onLayout={onLayout}
      testID={`${testID}-actions`}
    >
      {canReact ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: Boolean(mine) }}
          accessibilityLabel={
            mine
              ? `${reaction.mineLabel ? `${reaction.mineLabel}. ` : ''}You reacted to ${subject}.${spokenReactions(reaction.count)} Tap to remove, long press to change.`
              : `React to ${actorName}'s activity about ${subject}.${spokenReactions(reaction.count)} Long press for more reactions.`
          }
          accessibilityHint={
            reaction.onLongPress ? 'Long press to choose a different reaction' : undefined
          }
          onPress={reaction.onPress}
          onLongPress={reaction.onLongPress}
          style={({ pressed }) => [boxFor(reaction.count), pressed && styles.pressed]}
          testID={`${testID}-like`}
        >
          {/* Every selected state is its emoji and its word, a Like included: the ❤️ and
              Liked, the way 😂 Laugh and 😮 Wow are drawn (founder, nav cohesion sprint,
              2026-11-06). Both states sit in the one fixed slot, so a tap moves nothing. */}
          <ReactionSlot glyph={mine} color={theme.text.secondary} />
          <Label active={Boolean(mine)} count={reaction.count}>
            {mine ? (reaction.mineLabel ?? 'Reacted') : 'Like'}
          </Label>
        </Pressable>
      ) : null}

      {onPressComments ? (
        <Action
          icon="chatbubble-outline"
          label="Comment"
          count={commentCount}
          accessibilityLabel={
            commentCount > 0
              ? `${commentCount} ${commentCount === 1 ? 'comment' : 'comments'} on ${actorName}'s activity about ${subject}. Open them.`
              : `Comment on ${actorName}'s activity about ${subject}`
          }
          onPress={onPressComments}
          box={boxFor(commentCount)}
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
          box={boxFor(0)}
          testID={`${testID}-save`}
        />
      ) : null}

      {onPressShare ? (
        <Action
          icon="paper-plane-outline"
          label="Share"
          accessibilityLabel={`Share ${subject} with a friend`}
          onPress={onPressShare}
          box={boxFor(0)}
          testID={`${testID}-share`}
        />
      ) : null}
    </View>
  );
}

function Action({
  icon,
  label,
  count,
  accessibilityLabel,
  onPress,
  active = false,
  selected,
  box,
  testID,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  count?: number;
  accessibilityLabel: string;
  onPress: () => void;
  active?: boolean;
  selected?: boolean;
  box: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [box, pressed && styles.pressed]}
      testID={testID}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={active ? theme.semantic.action : theme.text.secondary}
      />
      <Label active={active} count={count}>
        {label}
      </Label>
    </Pressable>
  );
}

/**
 * The word, then `(N)` in tabular figures and the Maroon accent, so `Like (9)` and
 * `Like (10)` keep the word where it was. Never capped, ellipsized or shrunk: the space
 * before the count is an ordinary one, so when the action is squeezed the count is what
 * moves, onto a second line under the word.
 */
function Label({
  active,
  count = 0,
  children,
}: {
  active: boolean;
  count?: number;
  children: string;
}) {
  const shown = actionCount(count);
  return (
    <Text variant="footnote" tone={active ? 'action' : 'secondary'} style={styles.label}>
      {children}
      {shown ? ' ' : null}
      {shown ? (
        <Text variant="footnote" tone="action" style={styles.count}>
          {`(${shown})`}
        </Text>
      ) : null}
    </Text>
  );
}

/**
 * **An action's count as drawn**: null for none (never `0`), the number up to 999, then
 * `1.2K` to `9.9K` and `12K` upward. Whole numbers only; a fractional or negative input is
 * treated as none.
 */
export function actionCount(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  const n = Math.floor(count);
  if (n < 1000) return String(n);
  if (n < 10_000) {
    const tenths = Math.floor(n / 100) / 10;
    return `${Number.isInteger(tenths) ? tenths.toFixed(0) : tenths.toFixed(1)}K`;
  }
  return `${Math.floor(n / 1000)}K`;
}

/**
 * The actions' words in Inter Regular (the `footnote` face), as a fraction of the font
 * size, from the bundled TTF's `hmtx` advance widths. Any other word is estimated at
 * 0.66em a character, which is above Inter's widest common letters, so it errs wide.
 */
const WORD_EM: Record<string, number> = {
  Like: 1.939,
  Liked: 2.552,
  Reacted: 3.882,
  Comment: 4.583,
  Save: 2.348,
  Saved: 2.96,
  Share: 2.754,
  Laugh: 2.923,
  Wow: 2.403,
  Sad: 1.815,
  Agree: 2.846,
  Disagree: 4.209,
};

/**
 * The width the actions' bare words need in one row: each word beside its 20pt icon and
 * 4pt gap, `space[2]` between actions, plus 1% for pixel rounding (the advances are exact,
 * and kerning only tightens these words). Counts are left out on
 * purpose: they can drop below their words, a word cannot.
 */
export function wordsWidth(words: string[], fontSize: number): number {
  const text = words.reduce(
    (sum, word) => sum + (WORD_EM[word] ?? [...word].length * 0.66) * fontSize,
    0,
  );
  const chrome = words.length * (theme.layout.icon.sm + theme.space[1]);
  return (text + chrome + theme.space[2] * (words.length - 1)) * 1.01;
}

/** " 4 reactions." for the spoken label, or nothing with none. */
const spokenReactions = (count: number) =>
  count >= 1
    ? ` ${Math.floor(count)} ${Math.floor(count) === 1 ? 'reaction' : 'reactions'}.`
    : '';

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
  /**
   * Spread (three or more): each action is as wide as its icon and words, at least 44pt,
   * and the row's free space goes between them (`space-between`).
   */
  spread: { justifyContent: 'space-between', gap: theme.space[2] },
  /** The last resort (`wraps`): onto a second line rather than out of the card. */
  wrap: { flexWrap: 'wrap', rowGap: 0 },
  spreadFixed: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
  },
  /** An action with a count: it may give up width, and its count then wraps below the word. */
  spreadShrinks: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
  },
  label: { flexShrink: 1 },
  count: { fontVariant: ['tabular-nums'] },
  pressed: { opacity: 0.7 },
});
