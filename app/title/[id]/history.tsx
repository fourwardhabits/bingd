import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { useCurrentProfile } from '@/features/auth/session';
import { invalidateAfterCollectionChange } from '@/features/collection/invalidate';
import { useTaggablePeople, type Person } from '@/features/collection/use-companions';
import { track } from '@/lib/analytics';
import { theme } from '@/ui/tokens';
import { LoadingScreen, Screen, Text } from '@/ui/components';

import { WatchRow, type WatchEdit } from '@/features/watch-history/WatchRow';
import {
  groupByYear,
  labelFor,
  placementsByWatch,
  type WatchEvent,
} from '@/features/watch-history/watch-history';
import { useWatchHistory, type Placement } from '@/features/watch-history/use-watch-history';
import {
  deleteWatchEvent,
  editWatchEvent,
  newOperationId,
  setWatchDetails,
} from '@/features/watch-history/writes';

/**
 * The Watch History screen — **founder-locked, 2026-09-19** (§J).
 *
 * ---------------------------------------------------------------------------
 * WHY A PUSHED SCREEN AND NOT A TAB, AND NOT A SHEET
 *
 * **Not a tab** (§J.2b, and it is not an open question). A History tab would have sat
 * 6th on a film and 7th on a season, permanently, for every title including the majority
 * with a single watch. It would have been the only owner-only tab in a row whose every
 * other entry — Similar, Cast, Reviews, Videos, Details, Episodes — describes the title
 * itself and reads identically for every viewer. And it would have been the hardest of
 * the options to walk back: removing a tab people have learned is a visible regression,
 * where a pushed route can be changed, extended or folded into a cross-title Diary
 * without anybody losing a landmark. The only thing that reopens it is a Diary shipping
 * first.
 *
 * **Not a sheet** (§J.2). Revision 2 proposed one. A history reaches ten, twenty or more
 * entries, each with a date, a placement, and a pencil that edits it — a list with
 * row-level actions and a header summary, which is a screen's job. A sheet caps at a
 * fraction of the viewport, competes with the keyboard during an inline edit, and on iOS
 * puts row actions inside a presented view that other sheets cannot then stack on.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN OWNS
 *
 * The watch events, their known dates, the undated historical viewing where there is
 * one, the rewatch count, the placement after each viewing, each viewing's own private
 * details (who with, a note — 20261014000100; the title-level review is untouched), and
 * editing or removing an individual watch.
 *
 * **It is not a second logging flow** (founder QA, 2026-09-21). *Add a past watch* and
 * *Log another watch* are gone from here: a new viewing is logged from the title page,
 * where the ranking it hands off to lives, and a past viewing is simply one with a date.
 */
/** Stable empties, so a pending query does not look like new data every render. */
const EMPTY_EVENTS: WatchEvent[] = [];
const EMPTY_PLACEMENTS: Placement[] = [];
const EMPTY_PEOPLE: Person[] = [];

export default function WatchHistoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const mediaItemId = String(id ?? '');
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();

  const userId = profile.id;
  const history = useWatchHistory(userId, mediaItemId);
  const people = useTaggablePeople(userId);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Memoised rather than defaulted inline: `?? []` builds a NEW array every render, so
   * every `useMemo` below it would recompute on every render and the list would rebuild
   * its rows for nothing. On a sixty-watch history that is the difference between a
   * screen that scrolls and one that stutters, and it is the lint rule's whole point.
   */
  const events = useMemo(() => history.data?.events ?? EMPTY_EVENTS, [history.data]);
  const placements = useMemo(() => history.data?.placements ?? EMPTY_PLACEMENTS, [history.data]);

  /**
   * One placement per viewing, collapsed from the append-only ledger (founder QA,
   * 2026-09-21). A correction updates the latest viewing's number rather than adding a
   * line under it, and nothing is listed that is not a viewing. `placementsByWatch` holds
   * the rule and its tests.
   */
  const shownPlacement = useMemo(
    () => placementsByWatch(events, placements),
    [events, placements],
  );

  /**
   * `watch_history_opened`, once per visit, and **bucketed** (epic §P).
   *
   * The count is `1`, `2-5`, `6-20` or `20+` and never the number: an exact watch
   * count plus a timestamp is a fingerprint, and this stream is id-free by design.
   *
   * Fired when the history first lands rather than on mount, because a screen that is
   * still loading has no count to report — and guarded by a ref so a refetch after an
   * edit is not a second opening.
   */
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current || history.data === undefined) return;
    reported.current = true;
    const n = history.data.count;
    track({
      name: 'watch_history_opened',
      props: { watch_count: n <= 1 ? '1' : n <= 5 ? '2-5' : n <= 20 ? '6-20' : '20+' },
    });
  }, [history.data]);

  const groups = useMemo(() => groupByYear(events), [events]);
  const ordered = useMemo(() => groups.flatMap((group) => group.events), [groups]);

  // The label depends on a viewing's place in the *chronological* order, not in the
  // newest-first order this screen reads in. Computed against the chronological list so
  // "First watch" is the earliest dated viewing wherever it is drawn.
  const labelOf = (event: WatchEvent) =>
    labelFor(
      events,
      events.findIndex((candidate) => candidate.id === event.id),
    );

  const reconcile = () =>
    invalidateAfterCollectionChange(queryClient, userId, mediaItemId, {});

  const saveEdit = async (eventId: string, edit: WatchEdit) => {
    if (edit.watchedOn === undefined && !edit.details) return;
    setBusy(true);
    setError(null);
    const results = [];
    if (edit.watchedOn !== undefined) {
      results.push(
        await editWatchEvent({
          operationId: newOperationId(),
          watchEventId: eventId,
          watchedOn: edit.watchedOn,
          // The reader is looking at this row and typed into it. Nothing here is defaulted,
          // so nothing here is `today_default` (§D.6 path 13).
          basis: edit.watchedOn === null ? 'none' : 'reader',
        }),
      );
    }
    if (edit.details) {
      results.push(
        await setWatchDetails({
          operationId: newOperationId(),
          watchEventId: eventId,
          note: edit.details.note,
          companionIds: edit.details.companionIds,
        }),
      );
    }
    setBusy(false);
    reconcile();
    for (const result of results) {
      if (result.outcome === 'failed') {
        setError(result.message);
        break;
      }
    }
  };

  const remove = async (eventId: string, onlyWatch: boolean) => {
    if (onlyWatch) {
      // The server would refuse this with `P0001 last_watch`, and what the reader means
      // is that the title should not be in the collection. That is a different act, on a
      // different screen, and it is not one to perform on their behalf from here.
      setError('This is the only watch. Remove the title from your collection instead.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await deleteWatchEvent({ operationId: newOperationId(), watchEventId: eventId });
    setBusy(false);
    setEditingId(null);
    reconcile();
    if (result.outcome === 'failed') {
      setError(result.lastWatch ? 'A title in your collection has at least one watch.' : result.message);
    }
  };

  if (history.isPending) return <LoadingScreen message="Loading your watch history" />;

  const count = events.length;

  return (
    <Screen includeBottomInset>
      <FlatList
        testID="watch-history-list"
        data={ordered}
        keyExtractor={(event) => event.id}
        // A sixty-watch history is an ordinary scroll, which is the point of a screen
        // rather than a sheet (§J.2).
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.header}>
            <Text variant="title2" testID="watch-history-summary">
              {count === 1 ? 'Watched once' : `Watched ${count} times`}
            </Text>
            {error ? (
              <Text variant="caption" tone="action" testID="watch-history-error">
                {error}
              </Text>
            ) : null}
          </View>
        }
        renderItem={({ item, index }) => {
          // The year header belongs to the first row of its group, so the list stays one
          // flat array — a SectionList would give the same result and give up the
          // virtualisation tuning this screen is sized for.
          const group = groups.find((candidate) => candidate.events.includes(item));
          const first = group?.events[0]?.id === item.id;
          const showYear = first && group?.year !== null && groups.filter((g) => g.year !== null).length > 1;
          const placement = shownPlacement.get(item.id);
          const details = history.data?.details.get(item.id);

          return (
            <View>
              {showYear ? (
                <Text variant="caption" tone="tertiary" style={styles.year}>
                  {String(group?.year)}
                </Text>
              ) : null}
              <WatchRow
                event={item}
                label={labelOf(item)}
                placement={placement}
                note={details?.note}
                companions={details?.companions}
                people={people.data ?? EMPTY_PEOPLE}
                peopleLoading={people.isPending}
                onlyWatch={count <= 1}
                editing={editingId === item.id}
                onEdit={() => setEditingId(item.id)}
                onDismissEdit={() => setEditingId(null)}
                onSave={(edit) => void saveEdit(item.id, edit)}
                onRemove={() => void remove(item.id, count <= 1)}
                busy={busy}
              />
              {index === ordered.length - 1 ? null : <View style={styles.rule} />}
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[4],
    gap: theme.space[1],
  },
  year: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    paddingBottom: theme.space[1],
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border.hairline,
    marginHorizontal: theme.layout.gutter,
  },
});
