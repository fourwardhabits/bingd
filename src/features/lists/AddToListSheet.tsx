import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { track, type ListMediaKind } from '@/lib/analytics';
import { newOperationId } from '@/features/collection/writes';
import { queryKeys } from '@/lib/query';
import type { MediaKind } from '@/lib/titles';
import { Sheet, SkeletonRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { ChipDot, VisibilityChip } from './ListChips';
import { NewListSheet } from './NewListSheet';
import { useMyListsForTitle } from './use-lists';
import { addListItem, removeListItem } from './writes';
import { titleCountLabel, type ListMembership } from './types';

/** The analytics vocabulary is wider than `MediaKind`, because a list holds a series. */
const ANALYTICS_KIND: Record<MediaKind, ListMediaKind> = {
  movie: 'movie',
  season: 'tv_season',
  series: 'tv_series',
};

export type AddToListSheetProps = {
  mediaItemId: string;
  kind: MediaKind;
  /** The title as a person would say it. Used in the heading and in the confirmation. */
  name: string;
  profilePrivate: boolean;
  onClose: () => void;
  /** Pushes a list the reader just created from here. */
  onOpenList?: (listId: string) => void;
};

/**
 * `Title ⋯ → Add to list…` — the second of the two entry points (§G).
 *
 * ---------------------------------------------------------------------------
 * ONE CONTROL, THREE ACTS
 *
 * A row toggles membership **in both directions**: tapping an unticked row adds, and
 * tapping a ticked one removes. That is what lets this one sheet cover add, add-to-
 * several and remove without a second mode, and it is why the sheet stays open after
 * each tap — the person is very often putting one title on two lists.
 *
 * ---------------------------------------------------------------------------
 * WHY `+ New list` IS PINNED
 *
 * It does not scroll with the rows. With twenty lists it would otherwise sit below the
 * fold, and creating-a-list-while-adding-a-title is the highest-value path in this flow:
 * it is the moment somebody has a reason for a list and the thing to put in it at the
 * same time.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONFIRMATION NAMES THE LIST, AND OFFERS UNDO
 *
 * Because the sheet stays open and the rows keep scrolling, this toast is the **only**
 * feedback that the list the person hit was the one they meant. A bare "Added" under a
 * scrolling list of twenty names says nothing. Undo calls `remove_list_item` under its
 * own operation id — a new intent, not a retry of the add.
 *
 * It is drawn inside the sheet rather than as a system toast for the reason
 * `Sheet.onDismissed` documents at length: anything presented over a sheet on iOS is a
 * second presentation from the same view controller, and this app has a reproduced
 * freeze from exactly that.
 */
export function AddToListSheet({
  mediaItemId,
  kind,
  name,
  profilePrivate,
  onClose,
  onOpenList,
}: AddToListSheetProps) {
  const queryClient = useQueryClient();
  const lists = useMyListsForTitle(mediaItemId);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ listId: string; listTitle: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const rows = lists.data ?? [];
  const loaded = lists.isSuccess;

  /**
   * With **no lists at all**, this sheet has nothing to show, so it is skipped: ⋯ → Add
   * to list… opens New list directly with the title preselected (§G).
   *
   * Deciding it from `isSuccess` rather than from `rows.length` alone matters — an
   * in-flight read has zero rows too, and opening the create sheet over a loading state
   * would put somebody in a form they did not ask for.
   *
   * **Derived, not set from an effect.** `setCreating(true)` in a `useEffect` keyed on
   * this would render the empty membership list once and then replace it, which is the
   * cascading render the lint rule names — and on a slow read it is visible.
   */
  const emptyAccount = loaded && rows.length === 0;
  const showCreate = creating || emptyAccount;

  const invalidate = useCallback(
    (listId: string) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.listsForTitle(mediaItemId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.list(listId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.listItems(listId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.listProgress(listId) });
      void queryClient.invalidateQueries({ queryKey: ['my-lists'] });
      void queryClient.invalidateQueries({ queryKey: ['profile-lists'] });
    },
    [mediaItemId, queryClient],
  );

  const showToast = (listId: string, listTitle: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ listId, listTitle });
    timer.current = setTimeout(() => setToast(null), 6000);
  };

  const toggle = async (list: ListMembership) => {
    if (busyId) return;
    setBusyId(list.id);
    setError(null);

    const result = list.contains
      ? await removeListItem({ operationId: newOperationId(), listId: list.id, mediaItemId })
      : await addListItem({ operationId: newOperationId(), listId: list.id, mediaItemId });

    setBusyId(null);

    // Reconciled on success **and** on an unknown outcome, which is `mustReconcile`'s
    // whole point: the write that landed and could not say so is the one that most
    // needs the refetch.
    if (result.outcome !== 'failed' || result.changed) invalidate(list.id);

    if (result.outcome === 'failed') {
      setError(result.message);
      return;
    }

    if (result.outcome === 'item_limit') {
      setError(`"${list.title}" is full.`);
      return;
    }

    if (result.outcome === 'added') {
      track({
        name: 'list_item_added',
        props: {
          surface: 'title_menu',
          media_kind: ANALYTICS_KIND[kind],
          count_after: result.countAfter,
        },
      });
      showToast(list.id, list.title);
      return;
    }

    // A removal, or an `already` from a double tap. Neither is an add, and neither
    // emits `list_item_added` — a second tap on a title that is already there adds
    // nothing and must not read as growth.
    setToast(null);
  };

  const undo = async () => {
    if (!toast) return;
    const { listId } = toast;
    setToast(null);
    // Its own operation id: Undo is a new intent, not a retry of the add.
    const result = await removeListItem({
      operationId: newOperationId(),
      listId,
      mediaItemId,
    });
    if (result.outcome !== 'failed' || result.changed) invalidate(listId);
  };

  if (showCreate) {
    return (
      <NewListSheet
        surface="title_menu"
        profilePrivate={profilePrivate}
        firstTitle={{ mediaItemId, name }}
        onClose={() => {
          setCreating(false);
          // An account with no lists that cancels the create has nothing behind this
          // sheet to return to, so the whole flow closes rather than revealing an
          // empty membership list.
          if (emptyAccount) onClose();
        }}
        onCreated={(list) => {
          setCreating(false);
          track({
            name: 'list_item_added',
            props: { surface: 'title_menu', media_kind: ANALYTICS_KIND[kind], count_after: 1 },
          });
          invalidate(list.id);
          showToast(list.id, list.title);
          if (emptyAccount) {
            onClose();
            onOpenList?.(list.id);
          }
        }}
      />
    );
  }

  return (
    <Sheet visible onClose={onClose} label={`Add ${name} to a list`}>
      <View style={styles.sheet}>
        <Text variant="callout" numberOfLines={2} style={styles.heading}>
          Add &ldquo;{name}&rdquo; to…
        </Text>

        {/* Pinned, outside the scroller. See the header. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New list"
          onPress={() => setCreating(true)}
          style={({ pressed }) => [styles.newList, pressed && styles.pressed]}
        >
          <Ionicons name="add" size={theme.layout.icon.md} color={theme.semantic.action} />
          <Text variant="callout" tone="action">
            New list
          </Text>
        </Pressable>

        <View style={styles.divider} />

        {lists.isPending ? (
          <View style={styles.loading}>
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(row) => row.id}
            style={styles.rows}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <MembershipRow
                list={item}
                busy={busyId === item.id}
                onPress={() => void toggle(item)}
              />
            )}
          />
        )}

        {error ? (
          <Text variant="footnote" tone="secondary" accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}

        {toast ? (
          <View
            testID="add-to-list-toast"
            style={styles.toast}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            <Text variant="footnote" tone="inverse" numberOfLines={2} style={styles.toastText}>
              Added to &ldquo;{toast.listTitle}&rdquo;
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Undo"
              hitSlop={theme.space[2]}
              onPress={() => void undo()}
            >
              <Text variant="callout" tone="inverse">
                Undo
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}

function MembershipRow({
  list,
  busy,
  onPress,
}: {
  list: ListMembership;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: list.contains, disabled: busy }}
      accessibilityLabel={`${list.title}. ${titleCountLabel(list.itemCount)}`}
      accessibilityHint={list.contains ? 'Removes this title from the list' : undefined}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowLines}>
        <Text variant="callout" numberOfLines={1}>
          {list.title}
        </Text>
        <View style={styles.rowFacts}>
          <Text variant="footnote" tone="tertiary">
            {list.itemCount}
          </Text>
          <ChipDot />
          <VisibilityChip visibility={list.visibility} />
        </View>
      </View>

      <Ionicons
        name={list.contains ? 'checkbox' : 'square-outline'}
        size={theme.layout.icon.md}
        color={list.contains ? theme.semantic.action : theme.text.secondary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingBottom: theme.space[3], maxHeight: '100%' },
  heading: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[3] },
  newList: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.layout.gutter,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border.hairline,
    marginHorizontal: theme.layout.gutter,
  },
  rows: { flexGrow: 0 },
  loading: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
  },
  rowLines: { flex: 1, gap: theme.space[1] },
  rowFacts: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  error: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    marginHorizontal: theme.layout.gutter,
    marginTop: theme.space[3],
    paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[2],
    borderRadius: theme.radius.control,
    backgroundColor: theme.text.primary,
  },
  toastText: { flex: 1 },
  pressed: { opacity: 0.7 },
});
