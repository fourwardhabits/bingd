import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, IconAction, ReactionControl, Text } from '@/ui/components';
import type { ActivityReaction } from '@/ui/components/ActivityRow';
import { fontFamily, theme } from '@/ui/tokens';

import { followTail, relativeTime, verbFor } from './activity';
import type { FeedItem } from './use-feed';

export type FollowStoryRowProps = {
  event: FeedItem;
  /** Opens the actor's profile. Absent where there is no handle to open. */
  onPressActor?: () => void;
  /** Opens one named person's profile — the emphasised name in the sentence. */
  onPressPerson: (username: string) => void;
  /** Opens the list of everybody this story is about. Only called when there is more than one. */
  onOpenList: () => void;
  /**
   * **Reactions and comments** (Workstream C, founder 2026-11-19). Both optional: absent,
   * the row is exactly the compact row it always was (the activity page's header, an older
   * caller). The server decides who may engage (`_follow_story_open_to`); the row only draws.
   */
  reaction?: ActivityReaction;
  onPressComments?: () => void;
  commentCount?: number;
};

/**
 * `Abi followed Ravi` · `Abi followed Ravi and 4 others`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `ActivityRow`
 *
 * `ActivityRow` is a row about a *title*: it leads with a poster, and it carries a score
 * badge, a note with spoiler masking, watch companions, a watchlist bookmark, a Recommend
 * control, a reaction pill and a comment count. A follow story has none of those and can
 * never acquire any of them, so expressing it through that component would mean one caller
 * where `title` is a person's name, `posterUri` is undefined, and eight props are omitted —
 * and the next person to add a prop there would have to remember that one caller means
 * something different by every field.
 *
 * So: a second row, at the same density, in the same grammar. Avatar, one sentence, one
 * time label. It is deliberately *lighter* than an activity row, and that is the frequency
 * rule §A13 asks for expressed as composition rather than as a cap — a follow story cannot
 * dominate a screenful of rankings because it is a third of the height of one.
 *
 * ---------------------------------------------------------------------------
 * THE SENTENCE, AND WHOSE COUNT IT IS
 *
 * Actor, verb, the first person, and a tail. The same four slots `ActivityRow` uses and
 * the same nested-`Text` construction, so this wraps as a sentence rather than stacking as
 * fields, and both entities keep their own `onPress` inside it.
 *
 * **The count in the tail is how many people the reader may see**, not how many the actor
 * followed — `event.followed` arrives already filtered by `follow_activity_people`, which
 * applies `can_identify_profile` per caller (`20260912000100`). That is §A12's rule where it
 * has to be, at the only place that draws the number: a row promising "and 4 others" over a
 * sheet that lists one would be the feature contradicting itself, and one of the missing
 * three would be an account that had blocked this reader.
 *
 * ---------------------------------------------------------------------------
 * WHAT A TAP DOES
 *
 * The emphasised name opens that person. Everything else about the row — including the
 * tail, and including a single-person story's whitespace — opens the list, which is where
 * the Follow controls are. A single-person story has no list worth opening, so its row is
 * inert outside the two names; that is deliberate rather than an omission, because a sheet
 * containing one row the reader can already see is a modal that says nothing.
 *
 * ---------------------------------------------------------------------------
 * REACTIONS AND COMMENTS (founder decision, 2026-11-19; replaces §A9's exclusion)
 *
 * A heart and a comment control at the trailing end, each a real 44pt box, outside the
 * text column that opens the list, so neither can open it and screen readers keep three
 * separate elements. No "who reacted" sentence line: that is what keeps the row compact.
 * One shared conversation per story, grouped or not. Who may engage, and when a story stops
 * being open to somebody, is the server's single predicate (20261130000100).
 */
export function FollowStoryRow({
  event,
  onPressActor,
  onPressPerson,
  onOpenList,
  reaction,
  onPressComments,
  commentCount = 0,
}: FollowStoryRowProps) {
  const [first, ...rest] = event.followed;
  // `hydrate` drops a follow story with nobody in it, so this is a guard against a caller
  // that has not, rather than a state the feed produces.
  if (!first) return null;

  const tail = followTail(event.followed.length);
  const aggregated = rest.length > 0;

  const sentence = [event.actorName, verbFor(event.type), first.name, tail]
    .filter(Boolean)
    .join(' ');

  const whose = `${event.actorName}'s follow activity`;
  const reacts = Boolean(reaction && reaction.canReact !== false);
  // A reader who may not react still sees everybody else's count, as on a title row.
  const showsReaction = Boolean(reaction && (reacts || reaction.count > 0));
  const engages = showsReaction || Boolean(onPressComments);

  return (
    <View style={styles.frame} testID="follow-story-row">
      <View style={styles.row}>
        {/**
         * The actor's face, and at `sm` rather than as the 22pt chip `ActivityRow` stamps on a
         * poster. There is no artwork here for a chip to sit on, so the avatar *is* the
         * leading object — which is the shape `LeaderboardView` and `PeopleView` already use
         * for a row about a person, and this row is one.
         */}
        <Pressable
          accessibilityRole={onPressActor ? 'button' : 'none'}
          accessibilityLabel={onPressActor ? `${event.actorName}'s profile` : undefined}
          disabled={!onPressActor}
          onPress={onPressActor}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Avatar size="sm" uri={event.actorAvatarUri} name={event.actorName} />
        </Pressable>

        {/**
         * The whole text column opens the list, with the two names winning their own touches
         * inside it — the nested-press arrangement `PeopleView`'s mutual line uses, and it
         * works the same way: React Native hands the touch to the innermost responder.
         *
         * `accessibilityRole="none"` and no label when there is nothing to open, so a
         * single-person story does not announce a button that does nothing.
         */}
        <Pressable
          accessibilityRole={aggregated ? 'button' : 'none'}
          accessibilityLabel={aggregated ? sentence : undefined}
          accessibilityHint={aggregated ? 'Opens everyone in this' : undefined}
          disabled={!aggregated}
          onPress={onOpenList}
          style={styles.copy}
        >
          <Text variant="subhead" tone="secondary" numberOfLines={3}>
            <Text variant="subhead" style={styles.entity} onPress={onPressActor}>
              {event.actorName}
            </Text>
            {` ${verbFor(event.type)} `}
            <Text
              variant="subhead"
              style={styles.entity}
              onPress={() => onPressPerson(first.username)}
            >
              {first.name}
            </Text>
            {tail ? ` ${tail}` : null}
          </Text>

          {/* The row's second line, in the slot an activity row spends on `PG-13 · 148m`.
            One thing, and it is the only thing a follow story has to say beyond its
            sentence. */}
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {relativeTime(event.createdAt)}
          </Text>
        </Pressable>

        {engages ? (
          <View style={styles.actions} testID="follow-story-actions">
            {reaction && showsReaction ? (
              <View style={styles.box} testID="follow-story-reaction">
                <ReactionControl
                  label={
                    reaction.mineGlyph
                      ? `${reaction.mineLabel ? `${reaction.mineLabel}. ` : ''}You reacted to ${whose}. Tap to remove, long press to change.`
                      : `React to ${whose}. Long press for more reactions.`
                  }
                  active={Boolean(reaction.mineGlyph)}
                  mineGlyph={reaction.mineGlyph}
                  // The count only, never the glyph cluster: the compact row's whole budget.
                  glyphs={[]}
                  count={reaction.count}
                  canReact={reacts}
                  onToggle={reaction.onPress}
                  onOpenPicker={reaction.onLongPress}
                  onOpenDetail={reaction.onPressSummary}
                />
              </View>
            ) : null}
            {onPressComments ? (
              <IconAction
                square
                icon={commentCount > 0 ? 'chatbubble' : 'chatbubble-outline'}
                active={commentCount > 0}
                label={
                  commentCount > 0
                    ? `${commentCount} ${commentCount === 1 ? 'comment' : 'comments'} on ${whose}. Open them.`
                    : `Comment on ${whose}`
                }
                onPress={onPressComments}
                badge={commentCount > 0 ? String(commentCount) : undefined}
                testID="follow-story-comments"
              />
            ) : null}
          </View>
        ) : null}
      </View>

      {/* The picker under the row, inside its hairline — `ActivityRow`'s placement. */}
      {reaction?.picker && reacts ? <View style={styles.picker}>{reaction.picker}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * The Leaderboard row's metrics, which is also `PeopleView`'s: a row about people looks
   * the same wherever it is drawn, and this one sits in a list of rows about titles that
   * are deliberately taller.
   */
  frame: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    /**
     * The same closing hairline `ActivityRow` draws, at the same weight and colour
     * (founder, device, 2026-09-23).
     *
     * It was missing, and what that produced was not a lighter row but an unbounded one:
     * *Meli followed Abisola* fell into the whitespace of the ranking under it, and the
     * feed lost its rhythm exactly where the list changes subject. The gutters and the
     * vertical padding already matched `ActivityRow` — this is the third member of that
     * set, and the one that says where the row ends. Declared here rather than as a
     * one-off border component, because it IS the adjacent rows' declaration.
     *
     * Density stays the difference between the two: this row is a third of an activity
     * row's height whether or not it is closed.
     */
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  copy: { flex: 1, gap: 1 },
  /**
   * The trailing cluster: each control a real 44pt box, because on Android a touch outside
   * a parent's bounds is dropped, so slop cannot make up a target here.
   */
  actions: { flexDirection: 'row', alignItems: 'center', minHeight: theme.layout.minTapTarget },
  box: {
    minWidth: theme.layout.minTapTarget,
    minHeight: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  picker: { paddingTop: theme.space[2] },
  // `ActivityRow`'s own emphasis for a named entity inside the sentence, so an actor's
  // name reads the same weight here as it does two rows up.
  entity: { color: theme.text.primary, fontFamily: fontFamily.sansSemibold },
  pressed: { opacity: 0.7 },
});
