import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, Button, EmptyState, SearchField, Sheet, SkeletonRow, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import { FollowControl } from './FollowControl';
import { useRelationships } from './use-social';
import { peopleIn, useFollowList, type FollowListKind, type ListedPerson } from './use-follow-lists';

export type FollowListSheetProps = {
  /** Which list, or null to close. */
  kind: FollowListKind | null;
  /** Whose list it is. */
  userId: string;
  /** Their name, for the empty state — never the viewer's. */
  name: string;
  viewerId: string;
  isSelf: boolean;
  onClose: () => void;
};

const TITLE: Record<FollowListKind, string> = {
  followers: 'Followers',
  following: 'Following',
};

/**
 * Followers and Following, as searchable lists.
 *
 * ---------------------------------------------------------------------------
 * A SHEET, NOT A SCREEN
 *
 * The founder's instruction for this pass is "use existing Sheet / Recommendation
 * Requests / Awards / filter patterns — no new screen system", and the reason it is the
 * right shape rather than merely the cheap one is what a follower list is *for*: you
 * open it, look for somebody, and go back to the profile you were on. A pushed screen
 * makes that a journey with a header and a back gesture; a sheet leaves the profile
 * visible above it, which is the same reasoning `design-system.md` §8 gives for the log
 * flow.
 *
 * ---------------------------------------------------------------------------
 * THE ROW IS `PeopleDiscovery`'s AND NOT `UserRow`
 *
 * `UserRow` carries a documented rule that a follow control never appears inside it,
 * because a search result is a thing you tapped by accident on the way to somebody else
 * and a relationship started by mis-tap is one the other person is notified about.
 *
 * That rule was written for search and this is not search. Following from here is the
 * point of the surface — the founder's "Unfollow via existing canonical mutation" says
 * so directly — and making somebody open ten profiles to unfollow ten people is the
 * surface not working. So the row is shaped like `PeopleDiscovery`'s: the identity is
 * the tap target, the control sits outside it, and a thumb reaching for Following cannot
 * navigate instead.
 *
 * ---------------------------------------------------------------------------
 * NO MATCH PERCENTAGE
 *
 * Founder part N: include it only if a batch can produce it. `taste_match` reads two
 * whole ranking catalogues and computes a correlation, so fifty rows would be fifty of
 * those — which is exactly why `people_taste_matches` bounds its candidates to thirty
 * before calling it. There is no batched form, so these rows carry identity and a follow
 * state and nothing else, and the match stays where it can be afforded: the profile, and
 * For You → People.
 */
export function FollowListSheet({
  kind,
  userId,
  name,
  viewerId,
  isSelf,
  onClose,
}: FollowListSheetProps) {
  const [query, setQuery] = useState('');
  const router = useRouter();

  const list = useFollowList({
    kind: kind ?? 'followers',
    userId,
    viewerId,
    query,
    enabled: kind !== null,
  });

  const people = peopleIn(list.data?.pages);

  /**
   * One round trip for every row on screen, rather than one per row.
   *
   * The control has to know where the reader already stands with each person — Follow,
   * Requested, Following — and `follow_state_with` answers for a set. Nothing here
   * infers it from which list this is: appearing in somebody's Followers says nothing
   * about whether *this* reader follows them, and appearing in their Following says
   * nothing either.
   */
  const relationships = useRelationships(
    people.map((person) => person.id),
    viewerId,
  );

  const close = () => {
    // The search belongs to an opening of this sheet, not to the account. Reopening it
    // and finding somebody else's half-typed name in the box is the drift `CommentThread`
    // documents for its own composer.
    setQuery('');
    onClose();
  };

  if (!kind) return null;

  return (
    <Sheet visible onClose={close} label={TITLE[kind]}>
      <View style={styles.head}>
        <Text variant="headline">{TITLE[kind]}</Text>
        {/* Full size rather than `sm`, which is 36pt — under the 44pt floor `layout.ts`
            sets. Every other sheet in the app closes with a default-sized button, and a
            close control is the one thing on a sheet somebody presses without looking. */}
        <Button label="Close" kind="tertiary" onPress={close} />
      </View>

      <View style={styles.field}>
        <SearchField
          accessibilityLabel={
            kind === 'followers' ? 'Search followers' : 'Search people they follow'
          }
          placeholder="Name or @handle"
          value={query}
          onChangeText={setQuery}
          onClear={() => setQuery('')}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
      </View>

      {list.isPending ? (
        <SkeletonRow count={5} />
      ) : list.isError ? (
        <View style={styles.pad}>
          <EmptyState
            kind="couldNotLoad"
            compact
            title="Could not load this list"
            body="Check your connection and try again."
            action={{ label: 'Try again', onPress: () => void list.refetch() }}
          />
        </View>
      ) : people.length === 0 ? (
        <View style={styles.pad}>
          {/* Two different silences, said differently. "No matches" is a search that
              found nothing; the other is a list that is genuinely empty, and on somebody
              else's profile it may also be a list this reader is not permitted to see —
              which reads the same on purpose, because saying "you may not see this"
              would confirm there is something there. */}
          <EmptyState
            kind="nothingYet"
            compact
            title={query.trim() ? 'No matches' : `Nothing to show`}
            body={
              query.trim()
                ? 'Nobody in this list matches that.'
                : kind === 'followers'
                  ? `${isSelf ? 'You have' : `${name} has`} no followers you can see yet.`
                  : `${isSelf ? 'You are' : `${name} is`} not following anybody you can see yet.`
            }
          />
        </View>
      ) : (
        <ScrollView
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.listContent}
          /**
           * The next page, fetched as the reader approaches the end of this one.
           *
           * `onEndReached` belongs to `FlatList`; this is a `ScrollView` because the
           * sheet's height is content-driven and a virtualised list inside a
           * `maxHeight: 90%` container measures to zero. Fifty rows of avatar and two
           * lines is well inside what a `ScrollView` renders comfortably, and the
           * accounts with enough followers for that to stop being true are not in this
           * beta.
           */
          onScroll={({ nativeEvent }) => {
            const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
            const nearEnd =
              layoutMeasurement.height + contentOffset.y >= contentSize.height - 240;
            if (nearEnd && list.hasNextPage && !list.isFetchingNextPage) {
              void list.fetchNextPage();
            }
          }}
          scrollEventThrottle={160}
        >
          {people.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              viewerId={viewerId}
              isSelf={person.id === viewerId}
              relationship={relationships.data?.get(person.id)}
              onPressIdentity={() => {
                close();
                router.push(`/u/${person.username}`);
              }}
            />
          ))}

          {list.isFetchingNextPage ? <SkeletonRow count={2} /> : null}
        </ScrollView>
      )}
    </Sheet>
  );
}

function PersonRow({
  person,
  viewerId,
  isSelf,
  relationship,
  onPressIdentity,
}: {
  person: ListedPerson;
  viewerId: string;
  isSelf: boolean;
  relationship: Parameters<typeof FollowControl>[0]['relationship'];
  onPressIdentity: () => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[person.name, `@${person.username}`].join(', ')}
        accessibilityHint="Opens their profile"
        onPress={onPressIdentity}
        style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
      >
        <Avatar size="sm" uri={person.avatarUri} name={person.name} />
        <View style={styles.copy}>
          <Text variant="callout" numberOfLines={1} style={styles.name}>
            {person.name}
          </Text>
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            @{person.username}
          </Text>
        </View>
      </Pressable>

      {/* `FollowControl` renders nothing for the reader themselves, which is what keeps
          the reader's own row in their own Followers list from offering to follow
          themselves — a real case, since anybody looking at their own followers may well
          be in somebody else's list too. */}
      <FollowControl
        userId={person.id}
        name={person.name}
        viewerId={viewerId}
        relationship={relationship}
        isSelf={isSelf}
        surface="profile"
        size="compact"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[2],
  },
  field: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  pad: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[4] },
  list: { maxHeight: 420 },
  listContent: { paddingBottom: theme.space[4] },
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
  name: { fontFamily: fontFamily.sansSemibold },
  pressed: { opacity: 0.7 },
});
