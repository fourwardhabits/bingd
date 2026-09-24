import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import { relativeTime } from './activity';
import type { FeedItem } from './use-feed';

export type RankingBatchRowProps = {
  event: FeedItem;
  /** Opens the actor's profile. Absent where there is no handle to open. */
  onPressActor?: () => void;
  /** Opens the named title's page. */
  onPressTitle: () => void;
  /** Opens every title this sitting ranked. Only called when there is more than one. */
  onOpenList: () => void;
};

/**
 * `Michael ranked Oasis: Don't Look Back in Anger` · `… + 17 more`
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `ActivityRow`, AND NOT `title_ranked`
 *
 * Working through an imported library is library maintenance. Forty `title_ranked` rows
 * in four minutes is a feed nobody can read, so the server groups a whole Unranked
 * sitting into one mutable post (`20261020000100`) and this draws it.
 *
 * It is the follow story's shape rather than the activity row's, for the follow story's
 * reason: `ActivityRow` is about **one title** — a poster, a score badge, a note with
 * spoiler masking, a watchlist bookmark, a Recommend control, a reaction pill. A post
 * about eighteen titles has one of those at most, and the version of this that passes
 * `title={firstTitle}` and leaves six props off is the version where the next person to
 * add a prop has to remember that one caller means something else by every field.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SAYS, AND WHAT IT MUST NOT
 *
 * **Ranked.** Never watched, never rewatched, never added — those are watch chronology and
 * this is ranking chronology, and the whole feature depends on the two staying apart. A
 * title ranked today may have been watched in 2011, and the row says nothing about when.
 *
 * The time shown is the post's own, which is when the sitting happened.
 */
export function RankingBatchRow({
  event,
  onPressActor,
  onPressTitle,
  onOpenList,
}: RankingBatchRowProps) {
  const title = event.title;
  if (!title) return null;

  // `count` is the sitting's total, so the tail counts everything except the one named.
  const others = Math.max(0, (event.rankedCount ?? 1) - 1);

  return (
    <View style={styles.row} testID="ranking-batch-row">
      <Pressable
        accessibilityRole={onPressActor ? 'button' : 'none'}
        accessibilityLabel={onPressActor ? `${event.actorName}'s profile` : undefined}
        disabled={!onPressActor}
        onPress={onPressActor}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <Avatar size="sm" uri={event.actorAvatarUri} name={event.actorName} />
      </Pressable>

      <View style={styles.copy}>
        {/**
         * One sentence with two touch targets inside it — the nested-press arrangement
         * `FollowStoryRow` uses, and it works the same way: React Native hands the touch
         * to the innermost responder. The title goes to its page; the tail opens the list.
         */}
        <Text variant="subhead" tone="secondary" numberOfLines={3}>
          <Text variant="subhead" style={styles.entity} onPress={onPressActor}>
            {event.actorName}
          </Text>
          {' ranked '}
          <Text variant="subhead" style={styles.entity} onPress={onPressTitle}>
            {title}
          </Text>
          {others > 0 ? (
            <Text variant="subhead" style={styles.entity} onPress={onOpenList}>
              {` + ${others} more`}
            </Text>
          ) : null}
        </Text>

        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          {relativeTime(event.createdAt)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /** The follow story's metrics, including the hairline that says where a row ends. */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  copy: { flex: 1, gap: 1 },
  entity: { color: theme.text.primary, fontFamily: fontFamily.sansSemibold },
  pressed: { opacity: 0.7 },
});
