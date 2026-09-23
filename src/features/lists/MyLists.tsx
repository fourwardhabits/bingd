import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';

import { useCurrentProfile } from '@/features/auth';
import { track, type MyListsEntry } from '@/lib/analytics';
import { queryKeys } from '@/lib/query';
import { EmptyState, SkeletonRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { ListRow } from './ListRow';
import { NewListSheet } from './NewListSheet';
import { useMyLists } from './use-lists';

/**
 * Every list the caller owns, all visibilities, newest-edited first — the body of both
 * doors: Collection's **Lists** mode (founder QA, 2026-09-21: Movies / TV / Lists in the
 * one selector) and the `/lists` screen Profile's manage link pushes.
 *
 * ---------------------------------------------------------------------------
 * NO SORT CONTROL, NO FOLDERS, NO MANUAL ORDER
 *
 * `Updated <date>` is line three of every row **and** the sort key, so the order
 * explains itself (§I). A sort control would be a preference to store and a second
 * order to reason about, on a screen most people will have four rows on.
 *
 * ---------------------------------------------------------------------------
 * WHY `entry` IS A PROP
 *
 * `my_lists_opened.entry` is the discoverability tripwire (§M, §Q.6). Both doors reach
 * this identical body, so the only place the difference still exists is the caller.
 */
export function MyLists({ entry }: { entry: MyListsEntry }) {
  const router = useRouter();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();

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
    track({ name: 'my_lists_opened', props: { entry, owned_count: rows.length } });
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
      // `couldNotLoad` rather than `ScreenError`: this is a *read* that failed, which is
      // recoverable in place.
      <EmptyState
        kind="couldNotLoad"
        title="Could not load your lists"
        body="Check your connection and try again."
        action={{ label: 'Try again', onPress: () => void lists.refetch() }}
      />
    );
  }

  return (
    <View style={styles.body}>
      {lists.isPending ? (
        <View style={styles.loading}>
          <SkeletonRow count={4} />
        </View>
      ) : rows.length === 0 ? (
        <EmptyState
          kind="nothingYet"
          title="No lists yet"
          body="Pull together picks for friends, your favorite comfort movies, or anything else you want to save. It stays private until you choose to share it."
          action={{ label: 'Create a list', onPress: () => setCreating(true) }}
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
    </View>
  );
}

/**
 * `+ New list`, as the list's header rather than as a floating control. It scrolls with
 * the rows: a person here is looking at their lists, not halfway through filing a title.
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
  body: { flex: 1 },
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
