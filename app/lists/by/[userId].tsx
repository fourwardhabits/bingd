import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ListCover } from '@/features/lists/ListCover';
import { titleCountLabel, updatedLabel } from '@/features/lists/types';
import { useProfileLists } from '@/features/lists/use-lists';
import { EmptyState, Screen, SkeletonRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

const COVER = 64;

/** `profile_lists` caps at 50 a page, and a profile with more than that is not v1's problem. */
const SEE_ALL_LIMIT = 50;

/**
 * `See all` from a profile's Lists shelf — **a pushed screen, not a sheet** (§Q.4).
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A PUSH
 *
 * The earlier draft of this feature used the `RankedTitlesSheet` pattern, and that
 * meant every card inside it had to close the sheet before pushing the list — the
 * sheet-then-push sequence this codebase has a reproduced freeze from
 * (`Sheet.onDismissed`). A push has no such ordering: a card here opens a list
 * directly, and there is no sheet anywhere in §I.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY, AND PUBLIC ONLY
 *
 * It reads the same `profile_lists` the shelf does, so it shows what a visitor sees and
 * cannot show more. There is no create, no edit and no delete on this screen, for
 * `ProfileWatchlist`'s reason: a profile is somebody's public identity, and management
 * lives in one place, reached from Collection.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTE LIVES UNDER `/lists/`
 *
 * `/lists/by/<uuid>` is inside the already-claimed `/lists/*`, which costs nothing: the
 * web's `listIdFromPath` accepts a uuid **directly** under `/lists/` and nothing else,
 * so this path falls through to the generic install page rather than to a list page
 * that does not exist. Nobody shares this URL; it is a destination, not an object.
 */
export default function ProfileListsScreen() {
  const router = useRouter();
  const { userId, name } = useLocalSearchParams<{ userId?: string; name?: string }>();
  const ownerId = typeof userId === 'string' ? userId : null;

  const lists = useProfileLists(ownerId, SEE_ALL_LIMIT);
  const rows = lists.data ?? [];

  return (
    <Screen includeBottomInset>
      <Stack.Screen options={{ title: typeof name === 'string' && name ? `${name}'s lists` : 'Lists' }} />

      {lists.isPending ? (
        <View style={styles.loading}>
          <SkeletonRow count={4} />
        </View>
      ) : rows.length === 0 ? (
        // Reachable only by typing the route or by the shelf emptying underneath a
        // push. Deliberately says nothing about the account: an unviewable profile and
        // one with no public lists answer the same zero rows, and this screen must not
        // become the place that tells them apart.
        <EmptyState
          kind="nothingYet"
          title="No public lists"
          body="There is nothing here to see."
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.title}. ${titleCountLabel(item.itemCount)}`}
              onPress={() => router.push(`/lists/${item.id}?surface=profile_shelf`)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <ListCover posterUris={item.posterUris} size={COVER} />
              <View style={styles.lines}>
                <Text variant="callout" numberOfLines={2}>
                  {item.title}
                </Text>
                <Text variant="footnote" tone="secondary">
                  {titleCountLabel(item.itemCount)}
                  {item.orderStyle === 'ranked' ? ' · Numbered' : ''}
                </Text>
                <Text variant="footnote" tone="tertiary">
                  {updatedLabel(item.updatedAt)}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { paddingTop: theme.space[3] },
  list: { paddingBottom: theme.space[8] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    minHeight: theme.layout.minTapTarget,
  },
  lines: { flex: 1, gap: theme.space[1] },
  pressed: { opacity: 0.7 },
});
