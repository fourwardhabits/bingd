import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { FollowControl } from '@/features/profile/FollowControl';
import { useRelationships } from '@/features/profile/use-social';
import { Avatar, Sheet, SkeletonRow, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import type { FeedItem } from './use-feed';

export type FollowStorySheetProps = {
  event: FeedItem;
  viewerId: string;
  onPressPerson: (username: string) => void;
  onClose: () => void;
};

/**
 * Everybody an aggregated follow story is about (founder §A12).
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SHEET AND WHY IT HOLDS CONTROLS
 *
 * "Abi followed Ravi and 4 others" is only useful if the four others are reachable, and the
 * useful thing to do with a stranger a friend just followed is to follow them too. So this
 * is the one place in the Feed that carries follow controls — the same inversion of
 * `UserRow`'s no-control rule that `PeopleView` makes, for the same reason: following from
 * here *is* the point, and making somebody open five profiles to follow five people is the
 * surface not working.
 *
 * A sheet rather than a route, like every other list this app opens from a row: it is a
 * detail of the row it came from, and putting it in the back stack would make Back from it
 * mean something different depending on how the reader got to the Feed.
 *
 * ---------------------------------------------------------------------------
 * THE LIST IS ALREADY FILTERED, AND NOT BY THIS FILE
 *
 * `event.followed` is what `follow_activity_people` returned for *this* viewer, which is
 * every member of the story they are allowed to identify and no others
 * (`20260912000100`). §A12's "never expose a blocked or private-ineligible member merely
 * because they were part of the raw aggregate" is therefore enforced server-side, before
 * anything reaches this component — a client-side filter would be the same rule written
 * twice, in a place where the second copy can be wrong and nobody would see it.
 *
 * There is no read here at all, which is the other consequence: the people were hydrated
 * with the page, so opening this costs one `follow_state_with` and nothing else.
 */
export function FollowStorySheet({
  event,
  viewerId,
  onPressPerson,
  onClose,
}: FollowStorySheetProps) {
  /**
   * Where the reader stands with each of them, for the whole list in one round trip.
   *
   * The same hook `PeopleView` uses, so a Follow made from this sheet has exactly the cache
   * effects one made from People has — `useSocialWrites` invalidates `['relationships', …]`,
   * which is what makes the button redraw as Following rather than staying on Follow.
   */
  const relationships = useRelationships(
    event.followed.map((person) => person.id),
    viewerId,
  );

  return (
    <Sheet visible onClose={onClose} label={`People ${event.actorName} followed`}>
      <Text variant="title2" style={styles.title}>
        {event.actorName} followed
      </Text>

      {relationships.isPending ? (
        <SkeletonRow count={2} />
      ) : (
        <ScrollView style={styles.list}>
          {event.followed.map((person) => (
            <View key={person.id} style={styles.row}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={[
                  person.name,
                  `@${person.username}`,
                  person.isPrivate ? 'Private' : null,
                ]
                  .filter(Boolean)
                  .join(', ')}
                accessibilityHint={
                  person.isPrivate
                    ? 'Opens their private profile, where you can ask to follow'
                    : 'Opens their profile'
                }
                onPress={() => {
                  onClose();
                  onPressPerson(person.username);
                }}
                style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
              >
                <Avatar size="sm" uri={person.avatarUri} name={person.name} />
                <View style={styles.copy}>
                  <View style={styles.line}>
                    <Text variant="callout" numberOfLines={1} style={styles.name}>
                      {person.name}
                    </Text>
                    <Text
                      variant="caption"
                      tone="tertiary"
                      numberOfLines={1}
                      style={styles.handle}
                    >
                      @{person.username}
                    </Text>
                    {/* The same lock the Leaderboard, the follower lists and People draw.
                        A private account can legitimately be in this list — it was followed
                        by somebody, and this reader is allowed to know who it is — and the
                        marker is what stops the tap being a surprise. */}
                    {person.isPrivate ? (
                      <Ionicons
                        name="lock-closed"
                        size={theme.layout.icon.sm - 8}
                        color={theme.text.tertiary}
                        accessibilityElementsHidden
                      />
                    ) : null}
                  </View>
                </View>
              </Pressable>

              {/**
               * `isSelf` is false unconditionally, and that is safe rather than sloppy:
               * `follow_activity_people` excludes the caller from every story it answers,
               * because a Follow control pointed at yourself is one that cannot exist. The
               * server is where that is decided, so this component has no viewer comparison
               * to get wrong.
               */}
              <FollowControl
                userId={person.id}
                name={person.name}
                viewerId={viewerId}
                relationship={relationships.data?.get(person.id)}
                isSelf={false}
                surface="feed"
                size="compact"
              />
            </View>
          ))}
        </ScrollView>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  list: { maxHeight: 360 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
    minHeight: theme.layout.rowMinHeight,
  },
  identity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  copy: { flex: 1, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space[2] },
  name: { flexShrink: 0, fontFamily: fontFamily.sansSemibold },
  handle: { flexShrink: 1 },
  pressed: { opacity: 0.7 },
});
