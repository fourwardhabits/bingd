import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';

import { useCurrentProfile } from '@/features/auth';
import { ListRow } from '@/features/lists/ListRow';
import { NewListSheet } from '@/features/lists/NewListSheet';
import { useMyLists } from '@/features/lists/use-lists';
import { track, type MyListsEntry } from '@/lib/analytics';
import { queryKeys } from '@/lib/query';
import { EmptyState, Screen, SkeletonRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** The two doors, and the only two. Anything else is a typo in a `router.push`. */
const ENTRIES: readonly MyListsEntry[] = ['collection', 'profile_manage'];

/**
 * `My lists` — every list the caller owns, all visibilities, newest-edited first.
 *
 * ---------------------------------------------------------------------------
 * IT IS APP-ONLY, AND THAT IS A URL DECISION
 *
 * The deep-link claim is `/lists/*`, and `listIdFromPath` on the web accepts a uuid
 * shape and nothing else — so `bingd.app/lists` keeps its generic install page and this
 * screen needs no claim and no web route. A management screen is not a thing anybody
 * shares.
 *
 * ---------------------------------------------------------------------------
 * NO SORT CONTROL, NO FOLDERS, NO MANUAL ORDER
 *
 * `Updated <date>` is line three of every row **and** the sort key, so the order
 * explains itself (§I). A sort control would be a preference to store and a second
 * order to reason about, on a screen most people will have four rows on.
 *
 * ---------------------------------------------------------------------------
 * WHY `entry` IS A ROUTE PARAM
 *
 * `my_lists_opened.entry` is the discoverability tripwire (§M, §Q.6) — the measurement
 * that decides whether a text action on Collection's title row is findable enough to
 * stay one. Both doors reach this identical screen, so the *only* place the difference
 * still exists is the navigation that got here, and the param is how it survives. An
 * unrecognised value falls back to `collection` rather than being sent through: the
 * event's vocabulary is closed, and a typo must not open it.
 */
export default function MyListsScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const { entry } = useLocalSearchParams<{ entry?: string }>();

  const lists = useMyLists(profile.id);
  const [creating, setCreating] = useState(false);

  const rows = lists.data?.pages.flat() ?? [];

  /**
   * Once per mount, and only once the count is known.
   *
   * `owned_count` is a property of the event, and firing before the read has answered
   * would send zero for every account — a number that looks like a finding and is an
   * artefact. The ref is what keeps a refetch from emitting a second open.
   */
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current || !lists.isSuccess) return;
    reported.current = true;
    track({
      name: 'my_lists_opened',
      props: {
        entry: ENTRIES.includes(entry as MyListsEntry) ? (entry as MyListsEntry) : 'collection',
        owned_count: rows.length,
      },
    });
  }, [entry, lists.isSuccess, rows.length]);

  const afterCreate = (list: { id: string }) => {
    setCreating(false);
    void queryClient.invalidateQueries({ queryKey: queryKeys.myLists(profile.id) });
    void queryClient.invalidateQueries({ queryKey: ['profile-lists'] });
    // **A push, not a sheet over a sheet** (§G): Create lands on the empty list, whose
    // one primary control is Add titles. The sheet is already unmounted by the time
    // this runs, so there is no presentation to serialise against.
    router.push(`/lists/${list.id}?surface=my_lists`);
  };

  if (lists.isError) {
    return (
      <Screen includeBottomInset>
        {/* `couldNotLoad` rather than `ScreenError`, which is the router's view for a
            render that threw. This is a *read* that failed, which is recoverable in
            place and does not need the screen replaced. */}
        <EmptyState
          kind="couldNotLoad"
          title="Could not load your lists"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void lists.refetch() }}
        />
      </Screen>
    );
  }

  return (
    <Screen includeBottomInset>
      {lists.isPending ? (
        <View style={styles.loading}>
          <SkeletonRow count={4} />
        </View>
      ) : rows.length === 0 ? (
        <EmptyState
          kind="nothingYet"
          title="No lists yet"
          body="A list is a set of titles you choose — a movie night, a theme, a gift for a friend. Only you can see it until you share it."
          action={{ label: 'New list', onPress: () => setCreating(true) }}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.id}
          ListHeaderComponent={<NewListButton onPress={() => setCreating(true)} />}
          renderItem={({ item }) => (
            <ListRow
              list={item}
              onPress={() => router.push(`/lists/${item.id}?surface=my_lists`)}
            />
          )}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (lists.hasNextPage && !lists.isFetchingNextPage) void lists.fetchNextPage();
          }}
          contentContainerStyle={styles.list}
        />
      )}

      {creating ? (
        <NewListSheet
          surface="my_lists"
          profilePrivate={profile.visibility === 'private'}
          onClose={() => setCreating(false)}
          onCreated={afterCreate}
        />
      ) : null}
    </Screen>
  );
}

/**
 * `+ New list`, as the list's header rather than as a floating control.
 *
 * It scrolls with the rows deliberately, which is the opposite of the Add-to-list
 * sheet's pinned one — and the difference is the number of rows each has to get past.
 * A person on this screen is looking at their lists; a person in that sheet is
 * halfway through putting a title somewhere.
 */
function NewListButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New list"
      onPress={onPress}
      style={({ pressed }) => [styles.newList, pressed && styles.pressed]}
    >
      <Ionicons name="add" size={theme.layout.icon.md} color={theme.semantic.action} />
      <Text variant="callout" tone="action">
        New list
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: { paddingTop: theme.space[3] },
  list: { paddingBottom: theme.space[8] },
  newList: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
  pressed: { opacity: 0.7 },
});
