import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { useCurrentProfile } from '@/features/auth/session';
import { invalidateAfterCollectionChange } from '@/features/collection/invalidate';
import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';
import { theme } from '@/ui/tokens';
import { Button, LoadingScreen, Screen, Text } from '@/ui/components';

import { WatchRow } from '@/features/watch-history/WatchRow';
import {
  groupByYear,
  labelFor,
  movementSentence,
  type WatchEvent,
} from '@/features/watch-history/watch-history';
import { useWatchHistory, type Placement } from '@/features/watch-history/use-watch-history';
import {
  deleteWatchEvent,
  editWatchEvent,
  newOperationId,
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
 * entries, each with a date, sometimes a movement line, and a ⋯ that edits or removes
 * it — a list with row-level actions and a header summary, which is a screen's job. A
 * sheet caps at a fraction of the viewport, competes with the keyboard during an inline
 * date edit, and on iOS puts row actions inside a presented view that other sheets
 * cannot then stack on.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN OWNS
 *
 * The watch events, their known dates, the undated historical viewing where there is
 * one, the rewatch count, **the private movement line**, and editing or removing an
 * individual watch. Notes stay title-level — there is no per-watch note here or anywhere
 * (§D.4).
 */
/** Stable empties, so a pending query does not look like new data every render. */
const EMPTY_EVENTS: WatchEvent[] = [];
const EMPTY_PLACEMENTS: Placement[] = [];

export default function WatchHistoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const mediaItemId = String(id ?? '');
  const profile = useCurrentProfile();
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();

  const userId = profile.id;
  const history = useWatchHistory(userId, mediaItemId);

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
   * The movement to show beside a viewing, keyed by the event that prompted it.
   *
   * A placement links to the viewing it was a re-check *of* (`watch_event_id`), so the
   * line lands on the row it is about rather than at the top of the screen. Placements
   * with no viewing behind them — a first ranking, a correction, a refine — are listed
   * separately below, which is what §J.2's wireframe shows as *Placed #18 of 34*.
   */
  const movementByEvent = useMemo(() => {
    const map = new Map<string, Placement>();
    for (const placement of placements) {
      if (!placement.watchEventId) continue;
      // The newest wins, and the list arrives newest-first, so the first one seen is it.
      if (!map.has(placement.watchEventId)) map.set(placement.watchEventId, placement);
    }
    return map;
  }, [placements]);

  const unattached = useMemo(
    () => placements.filter((placement) => !placement.watchEventId),
    [placements],
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

  const changeDate = async (eventId: string, iso: string | null) => {
    setBusy(true);
    setError(null);
    const result = await editWatchEvent({
      operationId: newOperationId(),
      watchEventId: eventId,
      watchedOn: iso,
      // The reader is looking at this row and typed into it. Nothing here is defaulted,
      // so nothing here is `today_default` (§D.6 path 13).
      basis: iso === null ? 'none' : 'reader',
    });
    setBusy(false);
    reconcile();
    if (result.outcome === 'failed') setError(result.message);
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
    reconcile();
    if (result.outcome === 'failed') {
      setError(result.lastWatch ? 'A title in your collection has at least one watch.' : result.message);
    }
  };

  const addPastWatch = async () => {
    // *Add a past watch* opens the same inline date field the rows use (§J.2). It creates
    // the viewing undated and immediately opens its editor, so the reader answers the
    // date on the row they are about to keep — rather than in a dialogue that decides it
    // before the row exists.
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('log_rewatch', {
      p_operation_id: newOperationId(),
      p_media_item_id: mediaItemId,
      p_watched_on: null,
      p_basis: 'none',
    });
    setBusy(false);
    reconcile();
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    const created = (data as { watch_event_id?: string } | null)?.watch_event_id;
    if (created) {
      // `past`, which is the third kind the event declares: not a first log and not a
      // rewatch the reader has just had, but a viewing they are adding to a history
      // after the fact. It starts undated by construction, and the row's inline editor
      // opens on it immediately so the reader dates it where they can see it.
      track({ name: 'watch_logged', props: { kind: 'past', basis: 'none', surface: 'title' } });
      setEditingId(created);
    }
  };

  if (history.isPending) return <LoadingScreen message="Loading your watch history" />;

  const count = events.length;
  // The screen's own header says where the title sits now. `use-log-state` reports only
  // WHETHER it is ranked, so the live ordinal comes from the newest placement — the row
  // that says where it landed, and the ledger is append-only so the newest is current by
  // construction.
  const position = placements[0]?.position ?? null;

  return (
    <Screen includeBottomInset>
      <FlatList
        testID="watch-history-list"
        data={ordered}
        keyExtractor={(event) => event.id}
        // A sixty-watch history is an ordinary scroll, which is the point of a screen
        // rather than a sheet (§J.2).
        removeClippedSubviews
        ListHeaderComponent={
          <View style={styles.header}>
            <Text variant="title2" testID="watch-history-summary">
              {count === 1 ? 'Watched once' : `Watched ${count} times`}
            </Text>
            {position !== null ? (
              <Text variant="caption" tone="tertiary">
                {`#${position} in your ranking`}
              </Text>
            ) : null}
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
          const placement = movementByEvent.get(item.id);

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
                movement={
                  placement
                    ? {
                        outcome: placement.outcome as 'placed' | 'moved' | 'unchanged' | 'kept',
                        fromPosition: placement.fromPosition,
                      }
                    : undefined
                }
                position={placement?.position}
                onlyWatch={count <= 1}
                editing={editingId === item.id}
                onEdit={() => setEditingId(item.id)}
                onDismissEdit={() => setEditingId(null)}
                onChangeDate={(iso) => void changeDate(item.id, iso)}
                onRemove={() => void remove(item.id, count <= 1)}
                busy={busy}
              />
              {index === ordered.length - 1 ? null : <View style={styles.rule} />}
            </View>
          );
        }}
        ListFooterComponent={
          <View style={styles.footer}>
            {/**
             * Placements not tied to a viewing: a first ranking, a correction, a refine.
             * §J.2's *Placed #18 of 34 · Mar 2025* — true about **then**, which is why
             * the ordinal here is the one that placement recorded rather than the live
             * one the movement lines above use (§E.2's two forms, both stored).
             */}
            {unattached.length ? (
              <View style={styles.placements}>
                {unattached.map((placement) => (
                  <Text key={placement.id} variant="caption" tone="tertiary">
                    {/* T5: a refine that MOVED the title said "Still #N" here, which is a
                        false sentence about the reader's own list. The ledger's outcome
                        decides the words, through the same helper the reveal uses. */}
                    {placement.kind === 'refine'
                      ? `Refined · ${
                          movementSentence(
                            {
                              outcome: placement.outcome as 'moved' | 'unchanged' | 'kept',
                              fromPosition: placement.fromPosition,
                            },
                            placement.position,
                          ) ?? `#${placement.position}`
                        }`
                      : `Placed #${placement.position} of ${placement.categorySize}`}
                    {' · '}
                    {new Date(placement.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      year: 'numeric',
                    })}
                  </Text>
                ))}
              </View>
            ) : null}

            <Button
              label="Add a past watch"
              kind="secondary"
              disabled={busy}
              onPress={() => void addPastWatch()}
            />
            <Button
              label="Log another watch"
              disabled={busy}
              onPress={() => {
                // Back to the title page, where the rewatch sheet lives with the ranking
                // machinery it hands off to. Opening a second sheet from here is the
                // iOS two-modal dead end this screen exists to avoid.
                navigation.goBack();
                router.setParams({ rewatch: '1' });
              }}
            />
          </View>
        }
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
  footer: {
    padding: theme.layout.gutter,
    gap: theme.space[3],
  },
  placements: { gap: theme.space[1], paddingBottom: theme.space[3] },
});
