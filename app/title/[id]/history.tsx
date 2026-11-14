import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { useCurrentProfile } from '@/features/auth/session';
import { useCelebrationHandoff } from '@/features/awards/celebration-queue';
import { invalidateAfterCollectionChange } from '@/features/collection/invalidate';
import { LogSheet, type LoggableTitle, type PostRank } from '@/features/collection/LogSheet';
import { useTaggablePeople, type Person } from '@/features/collection/use-companions';
import { useLogState } from '@/features/collection/use-log-state';
import { removeFromCollection, type WriteResult } from '@/features/collection/writes';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { track } from '@/lib/analytics';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  EmptyState,
  HeaderBoundary,
  Screen,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/ui/components';
import { formatWatchDate } from '@/features/collection/dates';

import {
  WatchRow,
  type WatchEdit,
  type WatchSaveResult,
} from '@/features/watch-history/WatchRow';
import {
  groupByYear,
  historySpan,
  labelFor,
  scoresByWatch,
  type WatchEvent,
} from '@/features/watch-history/watch-history';
import { useHistoryTitle } from '@/features/watch-history/use-history-title';
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
  const router = useRouter();
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
   * **Edit ranking: the title's existing correction flow, opened from here** (founder, UI
   * consistency sprint, 2026-11-10).
   *
   * The same pair of sheets the title page's *Edit ranking* opens, wired the way the
   * list page wires them: `LogSheet`'s band chooser, then `RankingSheet`'s comparisons,
   * then back to the sheet with the new score. Nothing about ranking is built here. On a
   * ranked title the chooser's two paths are `rank_rebucket` (a band change) and
   * `rank_again` with `p_new_watch: false` (the same band) — corrections of the current
   * ranking, neither of which records a viewing (`LogSheet.commitBucket`). Closing either
   * sheet before a placement completes leaves the ranking as it was, because the server
   * runs the session over the position the title already holds (`20260826000500`).
   *
   * **The rows here do not move with it**, except where the founder's rule already says
   * they do: each watch shows the score frozen at that watch (`scoresByWatch`), and only
   * the latest watch, while it is the latest, follows a correction. That rule is untouched.
   */
  const loggable = useHistoryTitle(mediaItemId);
  const logState = useLogState(userId, mediaItemId);
  const celebrate = useCelebrationHandoff();
  const [rating, setRating] = useState<LoggableTitle | null>(null);
  const [ranking, setRanking] = useState<RankingSubject | null>(null);
  const [rankedTitle, setRankedTitle] = useState<LoggableTitle | null>(null);
  const [placement, setPlacement] = useState<PostRank | null>(null);
  const canEditRanking = Boolean(logState.data?.ranked && loggable.data);

  /**
   * Memoised rather than defaulted inline: `?? []` builds a NEW array every render, so
   * every `useMemo` below it would recompute on every render and the list would rebuild
   * its rows for nothing. On a sixty-watch history that is the difference between a
   * screen that scrolls and one that stutters, and it is the lint rule's whole point.
   */
  const events = useMemo(() => history.data?.events ?? EMPTY_EVENTS, [history.data]);
  const placements = useMemo(() => history.data?.placements ?? EMPTY_PLACEMENTS, [history.data]);

  /**
   * The opinion held at each watch (founder delta QA, 2026-09-21): the same frozen number
   * the Feed shows for that watch, never the current score. A pure Edit ranking
   * changes the title page and no row here. `scoresByWatch` holds the rule and its tests.
   */
  const posts = history.data?.posts;
  const shownScore = useMemo(
    () => scoresByWatch(events, placements, posts ?? []),
    [events, placements, posts],
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

  /** Back to the title page behind this one, or to it when this page was opened cold. */
  const leave = () =>
    router.canGoBack() ? router.back() : router.replace(`/title/${mediaItemId}` as never);

  const editRanking = () => {
    if (!loggable.data) return;
    // The inline editor closes first, so one sheet edits the title at a time. The row has
    // already settled any unsaved date, companions or note — saved, or discarded by the
    // reader's choice (`WatchRow`'s `editRanking`).
    setEditingId(null);
    setError(null);
    setPlacement(null);
    setRating(loggable.data);
  };

  const endRating = () => {
    setRating(null);
    setPlacement(null);
    reconcile();
    celebrate();
  };

  /**
   * Writes a watch's edit and says whether all of it landed: `ok` when every write
   * succeeded, or the first failure's reason. Both of the editor's Saves wait on it, and
   * the editor — not this screen's header — says why a save failed, beside the draft it
   * kept (FU1113-A).
   *
   * Every write names this one `watch_event_id`. The note goes to `set_watch_details`
   * (`watch_events.note`) and nowhere else: the title's review, its sharing and its
   * spoiler flag are not this editor's to touch, and nothing about the ranking moves.
   *
   * The caches are refreshed only when something may have landed, so a refused save
   * leaves the card exactly as it was.
   */
  const saveEdit = async (eventId: string, edit: WatchEdit): Promise<WatchSaveResult> => {
    if (edit.watchedOn === undefined && !edit.details) return { ok: true };
    setBusy(true);
    setError(null);
    const results: WriteResult[] = [];
    try {
      if (edit.watchedOn !== undefined) {
        results.push(
          await editWatchEvent({
            operationId: newOperationId(),
            watchEventId: eventId,
            watchedOn: edit.watchedOn,
            // The reader is looking at this row and typed into it. Nothing here is
            // defaulted, so nothing here is `today_default` (§D.6 path 13).
            basis: edit.watchedOn === null ? 'none' : 'reader',
          }),
        );
      }
      // A refused date stops here: the note and companions are not written behind it.
      if (edit.details && !results.some((result) => result.outcome === 'failed')) {
        results.push(
          await setWatchDetails({
            operationId: newOperationId(),
            watchEventId: eventId,
            note: edit.details.note,
            companionIds: edit.details.companionIds,
          }),
        );
      }
    } catch {
      results.push({ outcome: 'failed', message: 'Could not save this watch.' });
    } finally {
      setBusy(false);
    }
    // `mustReconcile`'s rule, inline: a write that landed, or may have, refreshes the caches.
    if (results.some((result) => result.outcome !== 'failed' || result.changed === true)) {
      reconcile();
    }
    const failed = results.find((result) => result.outcome === 'failed');
    return failed?.outcome === 'failed' ? { ok: false, message: failed.message } : { ok: true };
  };

  /**
   * **The last watch is the title leaving** (founder, 2026-09-25).
   *
   * `delete_watch_event` refuses the only watch with `P0001 last_watch`, because a title
   * in the collection has at least one (§D.0). This screen used to turn that refusal into
   * a sentence asking the reader to remove the title from their collection — which is the
   * control they had just pressed. So it performs that act instead.
   *
   * `removeFromCollection` is the canonical one, the same writer the title page spends:
   * it unranks first where the title is ranked (`unlog` refuses a ranked title) and then
   * deletes the row, and the server takes the watch events and the feed activity with it.
   * Nothing bespoke is added here — in particular no second confirmation, because this
   * screen's control is already the confirmed act and the project has no dialog standard
   * for it to reuse.
   *
   * Then it leaves: the screen it is on is a list of watches for a title that is no
   * longer in the collection, so staying would be showing the reader a page about
   * something they just removed. The title page behind it reflects the unlogged state
   * from the invalidation `reconcile` already performs.
   */
  const remove = async (eventId: string, onlyWatch: boolean) => {
    if (onlyWatch) {
      setBusy(true);
      setError(null);
      const result = await removeFromCollection({
        operationId: newOperationId(),
        mediaItemId: id as string,
        // Every placement on this screen belongs to a ranked title; an unranked one has
        // no position to show, so the ranked path is the one to take when there is one.
        wasRanked: placements.length > 0,
      });
      setBusy(false);
      reconcile();
      if (result.outcome === 'failed') {
        setError(result.message);
        return;
      }
      // The same way out as the header's Back, so a page opened cold does not stay on a
      // history for a title that has just left the collection (independent review).
      leave();
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

  /**
   * **The bingd. header with Back, as My lists has** (founder, UI consistency sprint,
   * 2026-11-10). It was the stack's own header titled *Watch history* (marquee cohesion
   * sprint, 2026-11-07), inside a `Screen` that also padded its top by the status-bar
   * inset — which a native-stack header had already consumed. That second inset was the
   * empty band between the header and the summary (`settings/notifications.tsx` met and
   * documented the same duplication). Now the stack header is off and the page draws
   * `AppHeader` and its boundary, so the top inset is applied exactly once, by `Screen`.
   *
   * The route keeps its title: on iOS it is the back label of anything pushed on top.
   * Back returns to the title page behind it, or — opened cold with nothing behind —
   * replaces this page with that title page.
   */
  const header = (
    <>
      <Stack.Screen options={{ headerShown: false, title: 'Watch history' }} />
      <AppHeader
        back={{ onPress: leave }}
      />
      <HeaderBoundary />
    </>
  );

  if (history.isPending)
    return (
      <Screen includeBottomInset>
        {header}
        {/* The page's own loading, under its header, as My lists draws it: the brand
            splash this used to show would put a second bingd. under the header's. */}
        <View
          style={styles.loading}
          accessibilityRole="progressbar"
          accessibilityLabel="Loading your watch history"
          testID="watch-history-loading"
        >
          <SkeletonRow count={3} />
        </View>
      </Screen>
    );

  const count = events.length;
  /**
   * `First Mar 4, 2024 · Latest Oct 12, 2026`, only when it says something: two or more
   * dated watches on two different days. One dated watch, or two on the same day, would
   * print the same date twice (founder QA, 2026-11-12). `historySpan` owns the rule.
   */
  const spanDates = historySpan(ordered.map((event) => event.watchedOn));
  const span = spanDates
    ? `First ${formatWatchDate(spanDates.first)} · Latest ${formatWatchDate(spanDates.latest)}`
    : null;

  if (count === 0) {
    return (
      <Screen includeBottomInset>
        {header}
        <SectionHeader title="Watch history" size="large" />
        <EmptyState
          kind="nothingYet"
          compact
          title="No watches recorded"
          body="Log a watch from the title page and it appears here."
        />
      </Screen>
    );
  }

  return (
    <Screen includeBottomInset>
      {header}
      <FlatList
        testID="watch-history-list"
        data={ordered}
        keyExtractor={(event) => event.id}
        // A sixty-watch history is an ordinary scroll, which is the point of a screen
        // rather than a sheet (§J.2).
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View>
            {/* The page's name, now that the stack's title is gone: the section label My
                lists opens with, in the same 15pt Maroon token. Said once — nothing else
                on the page repeats it. */}
            <SectionHeader title="Watch history" size="large" />
            <View style={styles.header} testID="watch-history-summary-block">
              <Text variant="title2" testID="watch-history-summary">
                {count === 1 ? 'Watched once' : `Watched ${count} times`}
              </Text>
              {span ? (
                <Text variant="footnote" tone="secondary" testID="watch-history-span">
                  {span}
                </Text>
              ) : null}
              {error ? (
                <Text variant="caption" tone="action" testID="watch-history-error">
                  {error}
                </Text>
              ) : null}
            </View>
          </View>
        }
        renderItem={({ item }) => {
          // The year header belongs to the first row of its group, so the list stays one
          // flat array — a SectionList would give the same result and give up the
          // virtualisation tuning this screen is sized for.
          const group = groups.find((candidate) => candidate.events.includes(item));
          const first = group?.events[0]?.id === item.id;
          const showYear = first && group?.year !== null && groups.filter((g) => g.year !== null).length > 1;
          const score = shownScore.get(item.id) ?? null;
          const details = history.data?.details.get(item.id);

          // Cards, spaced rather than ruled: the gap below each card is the only separator
          // (UI wave, 2026-11-12), and the last card's is the list's bottom air.
          return (
            <View style={styles.item}>
              {showYear ? (
                <Text variant="sectionHeader" tone="action" style={styles.year}>
                  {String(group?.year)}
                </Text>
              ) : null}
              <WatchRow
                event={item}
                label={labelOf(item)}
                score={score}
                note={details?.note}
                companions={details?.companions}
                people={people.data ?? EMPTY_PEOPLE}
                peopleLoading={people.isPending}
                onlyWatch={count <= 1}
                editing={editingId === item.id}
                onEdit={() => setEditingId(item.id)}
                onDismissEdit={() => setEditingId(null)}
                onSave={(edit) => saveEdit(item.id, edit)}
                onRemove={() => void remove(item.id, count <= 1)}
                // Rerank sits on every collapsed card now (founder spec §5), so while one
                // card's editor is open the others offer none: reranking from another card
                // would close that editor and drop its unsaved date or companions without
                // asking. The open card's own Rerank asks first.
                onEditRanking={
                  canEditRanking && (editingId === null || editingId === item.id)
                    ? editRanking
                    : undefined
                }
                busy={busy}
              />
            </View>
          );
        }}
      />

      <LogSheet
        title={rating}
        surface="title"
        postRank={placement}
        inWatchHistory
        onClose={endRating}
        onDone={endRating}
        onRank={(bucket, mode) => {
          if (!rating) return;
          setRanking({
            id: rating.id,
            title: rating.title,
            bucket,
            posterUri: rating.posterUri,
            kind: rating.kind,
            mode,
          });
          setRankedTitle(rating);
          setPlacement(null);
          setRating(null);
        }}
      />
      <RankingSheet
        subject={ranking}
        onClose={() => {
          setRanking(null);
          reconcile();
        }}
        // Back to the rating sheet with the new score, as on the title page: one
        // implementation of "the rest of your log".
        onFinishLog={(result) => {
          setRanking(null);
          if (!rankedTitle) return;
          setPlacement(result);
          setRating(rankedTitle);
        }}
        surface="title"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  /**
   * The summary straight under WATCH HISTORY: the label's own 44pt row already leaves the
   * air above and below its words, so this adds none on top (UI consistency sprint).
   */
  header: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[2],
    gap: theme.space[1],
  },
  loading: { paddingTop: theme.space[3] },
  // Above its first card; `space[2]` under it so the label does not sit on the card's edge.
  year: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    paddingBottom: theme.space[2],
  },
  /**
   * The seam between two cards. `space[2]`, the compact interval, rather than a section
   * seam: the card's own padding already gives each watch the air the ruled row had, so a
   * card costs about ten points more than the row it replaced and a thirty-watch history
   * stays a scroll of dates rather than of gaps.
   */
  item: { paddingBottom: theme.space[2] },
});
