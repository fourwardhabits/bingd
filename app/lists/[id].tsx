import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Alert,
  Animated,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
  type ViewProps,
} from 'react-native';

import { useCelebrationHandoff } from '@/features/awards/celebration-queue';
import { useCurrentProfile } from '@/features/auth';
import { invalidateAfterCollectionChange } from '@/features/collection/invalidate';
import { LogSheet, type LoggableTitle, type PostRank } from '@/features/collection/LogSheet';
import { rankingStateOf, resumeSubject } from '@/features/collection/ranking-state';
import { useLoggedCollection } from '@/features/collection/use-collection';
import { useMyScores } from '@/features/collection/use-score';
import { newOperationId, setWatchlist } from '@/features/collection/writes';
import { AddTitlesSheet } from '@/features/lists/AddTitlesSheet';
import { EditListSheet } from '@/features/lists/EditListSheet';
import { ChipDot, VisibilityChip } from '@/features/lists/ListChips';
import { ListItemRow } from '@/features/lists/ListItemRow';
import { reorder, shiftFor, targetIndex } from '@/features/lists/reorder';
import { SwipeToRemove } from '@/features/lists/SwipeToRemove';
import { listShareMessage, listUrl } from '@/features/lists/share';
import {
  titleCountLabel,
  updatedLabel,
  VISIBILITY_CHIP,
  type ListItem,
} from '@/features/lists/types';
import {
  useListHero,
  useListItems,
  useListProgress,
  useListView,
} from '@/features/lists/use-lists';
import { visibilityChangeDialog } from '@/features/lists/VisibilityPicker';
import {
  deleteList,
  moveListItem,
  removeListItem,
  updateList,
} from '@/features/lists/writes';
import { ReportSheet } from '@/features/moderation/ReportSheet';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { TitleTopBar } from '@/features/title/TitleTopBar';
import { useHeroReveal } from '@/features/title/use-hero-reveal';
import { heroArtwork } from '@/lib/hero';
import { track, type ListOpenSurface } from '@/lib/analytics';
import { queryKeys } from '@/lib/query';
import { hapticDecision } from '@/ui/haptics';
import {
  Avatar,
  Button,
  Divider,
  EmptyState,
  Screen,
  Sheet,
  SheetRow,
  SkeletonRow,
  Text,
  TitleHero,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

const SURFACES: readonly ListOpenSurface[] = [
  'my_lists',
  'profile_shelf',
  'deep_link',
  'title_menu',
];

/** A row not measured yet counts as this tall while it is dragged past. */
const ROW_FALLBACK = 72;

/** What the list's ⋯ was closed on its way to, run once iOS has finished dismissing it. */
type MenuIntent = 'settings' | 'share' | 'delete' | 'report';

/** The row being lifted, for the cell wrapper that raises it above its neighbours. */
const LiftedRow = createContext<number | null>(null);

/**
 * `https://bingd.app/lists/<id>` — one list, for whoever may read it.
 *
 * ---------------------------------------------------------------------------
 * ONE SCREEN, TWO READERS (founder QA, 2026-09-21)
 *
 * The header reads **what → where you are → what you can do**: the name, attribution for
 * a viewer, the description, then one metadata line — `3/3 watched · Only you · Updated
 * today` — and then the actions: **Share list** as the primary control and **Add titles**
 * as the secondary one for the owner. The separate "You've seen…" line is gone; the
 * watched count lives in the metadata.
 *
 * The owner's ⋯ holds *Edit list settings*, *Share* and *Delete list*. The visibility in
 * the metadata line opens the settings too, because tapping the thing you want to change
 * is the shortest path to changing it.
 *
 * A viewer sees `Public` or `Anyone with the link` in the same slot. That discloses
 * nothing the screen did not already: `shareable_by_viewer` is true for a viewer exactly
 * when the list is public, and the Share control has always followed it.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS CHANGED WHERE IT IS READ
 *
 * The owner long-presses a row to lift it, drags, and drops; the rows between make room
 * as it passes their middle, and the drop commits one `move_list_item` naming one title
 * and its new index — last-move-wins across devices, as every move always was (§E). The
 * numbers on a numbered list follow the drawn order, so they update the moment the row
 * lands. The same moves are accessibility actions on each row. It is core React Native —
 * the gesture responder system and `Animated` — and needs no new native code.
 *
 * ---------------------------------------------------------------------------
 * EVERY REFUSAL IS THE SAME SCREEN
 *
 * `useListView` resolves `null` for private, deleted, hidden, suspended, blocked and
 * "no such uuid" alike, and this draws one unavailable state for all of them. It never
 * says which — §F is explicit that ❌ is one answer.
 */
export default function ListScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const { id, surface } = useLocalSearchParams<{ id?: string; surface?: string }>();
  const listId = typeof id === 'string' ? id : null;

  const list = useListView(listId);
  const items = useListItems(listId, Boolean(list.data));
  const progress = useListProgress(listId, Boolean(list.data));

  const [menuOpen, setMenuOpen] = useState(false);
  /** The one row slid open to show Remove, if any. */
  const [swiped, setSwiped] = useState<string | null>(null);
  // The ordinary log → rank flow, opened from a row's Rank/log action — the same pair of
  // sheets Search mounts, so a list is not a second ranking path.
  const [logging, setLogging] = useState<LoggableTitle | null>(null);
  const [ranking, setRanking] = useState<RankingSubject | null>(null);
  const [ranked, setRanked] = useState<LoggableTitle | null>(null);
  const [placement, setPlacement] = useState<PostRank | null>(null);
  const celebrate = useCelebrationHandoff();
  const myScores = useMyScores(profile.id);
  // The reader's own buckets, so a `+` on an unfinished placement resumes it (the same
  // read Search uses). Never drawn: the row is ranked or not.
  const logged = useLoggedCollection(profile.id);
  const bucketOf = useMemo(
    () => new Map((logged.data?.entries ?? []).map((entry) => [entry.mediaItemId, entry.bucket])),
    [logged.data],
  );
  const [editing, setEditing] = useState(false);
  const [addingTitles, setAddingTitles] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [watchlistBusy, setWatchlistBusy] = useState<string | null>(null);

  /**
   * Where the ⋯ was going when it closed.
   *
   * iOS will not present a sheet — or an alert, or the share sheet — while it is
   * dismissing another from the same presenter, and the result is a transparent window
   * that swallows every touch (`Sheet.onDismissed`, the 2026-09-10 freeze). So the menu
   * closes, this remembers the intent, and `onDismissed` runs it once UIKit has finished.
   * Android has no presentation to serialise against and goes straight across.
   */
  const menuIntent = useRef<MenuIntent | null>(null);

  const rows = useMemo(() => items.data?.pages.flat() ?? [], [items.data]);
  const presentIds = useMemo(() => new Set(rows.map((row) => row.mediaItemId)), [rows]);

  /**
   * The order a drop produced, until the refetch that confirms it arrives. Tagged with the
   * data it was computed from, so the next read replaces it without an effect.
   */
  const [localOrder, setLocalOrder] = useState<{ basis: unknown; ids: string[] } | null>(null);
  const ordered = useMemo(() => {
    if (!localOrder || localOrder.basis !== items.data) return rows;
    const byId = new Map(rows.map((row) => [row.mediaItemId, row]));
    return localOrder.ids.map((rowId) => byId.get(rowId)).filter((row): row is ListItem => Boolean(row));
  }, [localOrder, rows, items.data]);
  const [moving, setMoving] = useState(false);

  // The first title's artwork, the title page's own fallback chain (`heroArtwork`).
  const heroSource = useListHero(ordered[0]?.mediaItemId ?? null);
  const hero = heroArtwork(
    heroSource.data ?? {
      backdropPath: null,
      posterPath: null,
      parentBackdropPath: null,
      parentPosterPath: null,
    },
  );
  const reveal = useHeroReveal(Boolean(hero.uri));

  const view = list.data ?? null;

  /** Once per resolved list. The unavailable state emits nothing — it is not an open. */
  const reportedOpen = useRef<string | null>(null);
  useEffect(() => {
    if (!view || reportedOpen.current === view.id) return;
    reportedOpen.current = view.id;
    track({
      name: 'list_opened',
      props: {
        surface: SURFACES.includes(surface as ListOpenSurface)
          ? (surface as ListOpenSurface)
          : 'deep_link',
        is_owner: view.isOwner,
        relation: view.isOwner ? 'self' : 'other',
        // Only the owner is told which of the two modes a non-private list is in, so
        // only the owner can report it. `undefined` is dropped by `sanitize`.
        visibility_class:
          view.isOwner && view.visibility && view.visibility !== 'private'
            ? view.visibility
            : undefined,
      },
    });
  }, [surface, view]);

  const refetchAll = () => {
    if (!listId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.list(listId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.listItems(listId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.listProgress(listId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.myLists(profile.id) });
    void queryClient.invalidateQueries({ queryKey: ['profile-lists'] });
  };

  // -------------------------------------------------------------------------
  // Sharing
  // -------------------------------------------------------------------------

  const share = async (
    visibility: 'link' | 'public',
    isOwner: boolean,
    itemCount: number,
    title: string,
    targetId: string,
  ) => {
    track({ name: 'list_shared', props: { visibility, item_count: itemCount, is_owner: isOwner } });
    try {
      await Share.share({
        message: listShareMessage(title, targetId),
        url: listUrl(targetId),
      });
    } catch (error) {
      Alert.alert('Could not share', error instanceof Error ? error.message : 'Sharing failed.');
    }
  };

  /**
   * Share on a **private** list is a consent gate, not a share (§F.5): converting it to
   * link-only is a consequence the person did not name, so it is asked first — with a
   * question for a title and the consequence as the body (`visibilityChangeDialog`).
   */
  const shareOrAsk = () => {
    if (!view) return;
    const current = view;

    if (current.isOwner && current.visibility === 'private') {
      const dialog = visibilityChangeDialog('link', profile.visibility === 'private');
      Alert.alert(dialog.title, dialog.body, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: dialog.confirm,
          onPress: () => {
            void (async () => {
              const result = await updateList({
                operationId: newOperationId(),
                listId: current.id,
                visibility: 'link',
              });
              if (result.outcome === 'failed') {
                Alert.alert('Could not change this', result.message);
                if (result.changed) refetchAll();
                return;
              }
              if (result.outcome === 'hidden') {
                Alert.alert('This list is hidden while it is reviewed.');
                return;
              }
              track({
                name: 'list_visibility_changed',
                props: {
                  from: 'private',
                  to: 'link',
                  surface: 'share_prompt',
                  profile_private: profile.visibility === 'private',
                },
              });
              refetchAll();
              await share('link', true, current.itemCount, current.title, current.id);
            })();
          },
        },
      ]);
      return;
    }

    void share(
      current.isOwner && current.visibility === 'link' ? 'link' : 'public',
      current.isOwner,
      current.itemCount,
      current.title,
      current.id,
    );
  };

  const confirmDelete = () => {
    if (!view) return;
    const current = view;
    Alert.alert(
      `Delete "${current.title}"?`,
      'This cannot be undone, and the link stops working for everybody who has it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const result = await deleteList({ operationId: newOperationId(), listId: current.id });
              if (result.outcome === 'failed') {
                Alert.alert('Could not delete this list', result.message);
                if (result.changed) refetchAll();
                return;
              }
              refetchAll();
              router.back();
            })();
          },
        },
      ],
    );
  };

  const runIntent = (intent: MenuIntent) => {
    if (intent === 'settings') setEditing(true);
    else if (intent === 'share') shareOrAsk();
    else if (intent === 'delete') confirmDelete();
    else setReporting(true);
  };

  const fromMenu = (intent: MenuIntent) => {
    if (Platform.OS === 'ios') {
      menuIntent.current = intent;
      setMenuOpen(false);
    } else {
      setMenuOpen(false);
      runIntent(intent);
    }
  };

  // -------------------------------------------------------------------------
  // The Watchlist, one title at a time (each row carries its own bookmark)
  // -------------------------------------------------------------------------

  const toggleWatchlist = async (mediaItemId: string, present: boolean) => {
    setWatchlistBusy(mediaItemId);
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId,
      present: !present,
    });
    setWatchlistBusy(null);
    if (result.outcome === 'failed' && !result.changed) {
      Alert.alert('Could not update watchlist', result.message);
      return;
    }
    // Only an add is an event, and only after the server said yes.
    if (!present) track({ name: 'watchlist_added', props: { surface: 'list' } });
    if (listId) void queryClient.invalidateQueries({ queryKey: queryKeys.listItems(listId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.collection(profile.id) });
  };

  // -------------------------------------------------------------------------
  // The owner's order: move and remove
  // -------------------------------------------------------------------------

  const commitMove = async (from: number, to: number) => {
    if (!view || moving || from === to) return;
    const item = ordered[from];
    if (!item) return;
    setLocalOrder({
      basis: items.data,
      ids: reorder(
        ordered.map((row) => row.mediaItemId),
        from,
        to,
      ),
    });
    setMoving(true);
    const result = await moveListItem({
      operationId: newOperationId(),
      listId: view.id,
      mediaItemId: item.mediaItemId,
      // Zero-based over the whole list, which is what the server clamps against. The rows
      // are read from the top in pages, so a row's index here is its index there.
      toIndex: to,
    });
    setMoving(false);
    if (result.outcome === 'failed') {
      setLocalOrder(null);
      Alert.alert('Could not move this', result.message);
    }
    refetchAll();
  };

  const removeItem = async (item: ListItem) => {
    if (!view) return;
    const result = await removeListItem({
      operationId: newOperationId(),
      listId: view.id,
      mediaItemId: item.mediaItemId,
    });
    if (result.outcome === 'failed') Alert.alert('Could not remove this', result.message);
    refetchAll();
  };

  const openLog = (item: ListItem) => {
    // A series is not loggable — its seasons are (AD-1); the title page offers them.
    if (item.kind === 'series') {
      router.push(`/title/${item.mediaItemId}`);
      return;
    }
    const title: LoggableTitle = {
      id: item.mediaItemId,
      title: item.name,
      year: item.year,
      posterUri: item.posterUri,
      kind: item.kind,
    };
    // An unfinished native placement goes back into its own session — `rank_start`
    // restores the comparison and the answers — not to "How was it?" again.
    const bucket = bucketOf.get(item.mediaItemId);
    const state = rankingStateOf({
      ranked: Boolean(myScores.data?.has(item.mediaItemId)),
      bucket,
    });
    const resume = state === 'unfinished' && bucket ? resumeSubject(title, bucket) : null;
    if (resume) {
      setRanking(resume);
      setRanked(title);
      setPlacement(null);
      return;
    }
    setLogging(title);
  };

  const endLog = () => {
    setLogging(null);
    setPlacement(null);
    celebrate();
    // The rows draw the reader's seen / saved state, so they refetch with the rest.
    refetchAll();
  };

  // Drag state. The gesture is the core responder system on the list's container: once a
  // row has been lifted, the container claims the next move (capture phase, so it wins over
  // the row's own press and the scroller), follows the finger, and commits on release.
  const [drag, setDrag] = useState<{ from: number; to: number; height: number } | null>(null);
  const [dy] = useState(() => new Animated.Value(0));
  const dragRef = useRef<{
    from: number;
    to: number;
    height: number;
    startY: number | null;
  } | null>(null);
  const heights = useRef<number[]>([]);

  const endDrag = () => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    dy.setValue(0);
    if (current && current.startY !== null && current.to !== current.from) {
      void commitMove(current.from, current.to);
    }
  };

  const startDrag = (index: number) => {
    if (moving) return;
    const height = heights.current[index] ?? ROW_FALLBACK;
    dragRef.current = { from: index, to: index, height, startY: null };
    setDrag({ from: index, to: index, height });
    hapticDecision();
  };

  const dragHandlers: ViewProps = {
    onMoveShouldSetResponderCapture: () => dragRef.current !== null,
    onMoveShouldSetResponder: () => dragRef.current !== null,
    onResponderGrant: (event) => {
      if (dragRef.current) dragRef.current.startY = event.nativeEvent.pageY;
    },
    onResponderMove: (event) => {
      const current = dragRef.current;
      if (!current || current.startY === null) return;
      const moved = event.nativeEvent.pageY - current.startY;
      dy.setValue(moved);
      const next = targetIndex(heights.current, ordered.length, current.from, moved, ROW_FALLBACK);
      if (next !== current.to) {
        current.to = next;
        setDrag({ from: current.from, to: next, height: current.height });
      }
    },
    onResponderTerminationRequest: () => false,
    onResponderRelease: () => endDrag(),
    onResponderTerminate: () => endDrag(),
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (list.isPending) {
    return (
      <Screen includeBottomInset>
        <View style={styles.loading}>
          <SkeletonRow count={5} />
        </View>
      </Screen>
    );
  }

  if (!view) {
    return (
      <Screen includeBottomInset>
        <EmptyState
          kind="nothingYet"
          title="List unavailable"
          body="This list is private, deleted, or not available yet."
        />
      </Screen>
    );
  }

  const owner = view.owner;
  const canShare = view.shareableByViewer || (view.isOwner && view.visibility === 'private');
  const watched =
    progress.data && progress.data.total > 0
      ? `${progress.data.seen}/${progress.data.total} watched`
      : titleCountLabel(view.itemCount);
  const numbered = view.orderStyle === 'ranked';

  return (
    <Screen includeBottomInset edges={[]}>
      {/* The route keeps its title for the back label of whatever is pushed on top; the
          bar itself is drawn by the page over the hero, exactly as on a title page. */}
      <Stack.Screen options={{ title: view.title, headerShown: false }} />
      <TitleTopBar
        progress={reveal.progress}
        revealed={reveal.revealed}
        onBack={() => router.back()}
        onMore={() => setMenuOpen(true)}
        title={view.title}
      />

      <LiftedRow.Provider value={drag?.from ?? null}>
        <View style={styles.fill} {...(view.isOwner ? dragHandlers : {})}>
          <Animated.FlatList
            data={ordered}
            onScroll={reveal.onScroll}
            scrollEventThrottle={16}
            keyExtractor={(row) => row.mediaItemId}
            contentContainerStyle={styles.list}
            scrollEnabled={drag === null}
            CellRendererComponent={LiftableCell}
            ListHeaderComponent={
              <View>
              <TitleHero
                uri={hero.uri}
                blurred={hero.treatment === 'poster'}
                collapsedHeight={reveal.collapsedHero}
                topInset={reveal.topInset}
              />
              <View style={styles.header}>
                <Text variant="title1" testID="list-large-title">
                  {view.title}
                </Text>

                {!view.isOwner && owner ? (
                  <Attribution
                    owner={owner}
                    // A private owner's attribution still leads to their profile route,
                    // which renders the existing locked shell (§F.2).
                    onPress={() => router.push(`/u/${owner.username}`)}
                  />
                ) : null}

                {view.description ? (
                  <Text variant="bodySecondary" tone="secondary" testID="list-description">
                    {view.description}
                  </Text>
                ) : null}

                <View style={styles.facts} testID="list-metadata">
                  <Text variant="footnote" tone="secondary">
                    {watched}
                  </Text>
                  <ChipDot />
                  {view.isOwner && view.visibility ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Who can see it: ${
                        view.hidden ? 'Hidden' : VISIBILITY_CHIP[view.visibility]
                      }. Opens list settings`}
                      hitSlop={theme.space[2]}
                      onPress={() => setEditing(true)}
                    >
                      <VisibilityChip visibility={view.visibility} hidden={view.hidden} />
                    </Pressable>
                  ) : (
                    <Text variant="footnote" tone="secondary">
                      {view.shareableByViewer ? VISIBILITY_CHIP.public : VISIBILITY_CHIP.link}
                    </Text>
                  )}
                  <ChipDot />
                  <Text variant="footnote" tone="tertiary">
                    {updatedLabel(view.updatedAt)}
                  </Text>
                </View>

                {view.hidden ? (
                  <View style={styles.banner} accessibilityRole="alert">
                    <Text variant="footnote" tone="secondary">
                      This list is hidden while it is reviewed. Only you can see it.
                    </Text>
                  </View>
                ) : null}

                {/* One action row, the Profile pattern (`ProfileActions`): two equal
                    halves, the secondary act leading and the Maroon fill on the
                    trailing one. `fit` keeps a two-word label on one line on a
                    320pt phone. */}
                {view.isOwner || canShare ? (
                  <View style={styles.actionRow} testID="list-actions">
                    {view.isOwner ? (
                      <View style={styles.half}>
                        <Button
                          label="Add titles"
                          kind="secondary"
                          fit
                          onPress={() => setAddingTitles(true)}
                        />
                      </View>
                    ) : null}
                    {canShare ? (
                      <View style={styles.half}>
                        <Button label="Share list" fit onPress={shareOrAsk} />
                      </View>
                    ) : null}
                  </View>
                ) : null}

                <Divider />
              </View>
              </View>
            }
            ListEmptyComponent={
              items.isPending ? (
                <SkeletonRow count={4} />
              ) : (
                <EmptyState
                  kind="nothingYet"
                  compact
                  title={view.isOwner ? 'Nothing on this list yet' : 'This list is empty'}
                  body={
                    view.isOwner
                      ? 'Add the first title and it will show up here.'
                      : 'There is nothing here to see yet.'
                  }
                />
              )
            }
            renderItem={({ item, index }) => {
              const lifted = drag !== null && drag.from === index;
              const shift = drag && !lifted ? shiftFor(index, drag.from, drag.to, drag.height) : 0;
              const last = ordered.length - 1;
              return (
                <Animated.View
                  onLayout={(event) => {
                    heights.current[index] = event.nativeEvent.layout.height;
                  }}
                  style={
                    lifted
                      ? [styles.lifted, { transform: [{ translateY: dy }] }]
                      : shift
                        ? { transform: [{ translateY: shift }] }
                        : undefined
                  }
                  testID={`list-row-${item.mediaItemId}`}
                >
                  <SwipeToRemove
                    name={item.name}
                    locked={!view.isOwner || drag !== null}
                    open={swiped === item.mediaItemId}
                    onOpenChange={(open) => setSwiped(open ? item.mediaItemId : null)}
                    onRemove={() => void removeItem(item)}
                  >
                  <ListItemRow
                    item={item}
                    showNumber={numbered}
                    // The drawn order's number, so a drop renumbers at once (§15).
                    number={index + 1}
                    busy={watchlistBusy === item.mediaItemId}
                    onPress={() => {
                      if (drag === null) router.push(`/title/${item.mediaItemId}`);
                    }}
                    score={myScores.data?.get(item.mediaItemId) ?? null}
                    onRank={() => openLog(item)}
                    onToggleWatchlist={() =>
                      void toggleWatchlist(item.mediaItemId, item.watchlisted === true)
                    }
                    onLongPress={view.isOwner ? () => startDrag(index) : undefined}
                    onPressOut={
                      view.isOwner
                        ? () => {
                            // A lift released without moving is not a drop.
                            if (dragRef.current && dragRef.current.startY === null) endDrag();
                          }
                        : undefined
                    }
                    accessibilityActions={
                      view.isOwner
                        ? [
                            ...(index > 0 ? [{ name: 'moveUp', label: 'Move up' }] : []),
                            ...(index < last ? [{ name: 'moveDown', label: 'Move down' }] : []),
                            ...(index > 0 ? [{ name: 'moveToTop', label: 'Move to top' }] : []),
                            ...(index < last
                              ? [{ name: 'moveToBottom', label: 'Move to bottom' }]
                              : []),
                            { name: 'remove', label: 'Remove from list' },
                          ]
                        : undefined
                    }
                    onAccessibilityAction={
                      view.isOwner
                        ? (event) => {
                            switch (event.nativeEvent.actionName) {
                              case 'moveUp':
                                return void commitMove(index, index - 1);
                              case 'moveDown':
                                return void commitMove(index, index + 1);
                              case 'moveToTop':
                                return void commitMove(index, 0);
                              case 'moveToBottom':
                                return void commitMove(index, last);
                              case 'remove':
                                return void removeItem(item);
                              default:
                                return undefined;
                            }
                          }
                        : undefined
                    }
                  />
                  </SwipeToRemove>
                </Animated.View>
              );
            }}
            onEndReachedThreshold={0.5}
            onEndReached={() => {
              if (items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
            }}
          />
        </View>
      </LiftedRow.Provider>

      {menuOpen ? (
        <Sheet
          visible
          onClose={() => setMenuOpen(false)}
          label={`Options for ${view.title}`}
          onDismissed={() => {
            const intent = menuIntent.current;
            menuIntent.current = null;
            if (intent) runIntent(intent);
          }}
        >
          <View style={styles.menu}>
            {view.isOwner ? (
              <>
                <SheetRow
                  icon="settings-outline"
                  label="Edit list settings"
                  onPress={() => fromMenu('settings')}
                />
                {canShare ? (
                  <SheetRow icon="share-outline" label="Share" onPress={() => fromMenu('share')} />
                ) : null}
                <SheetRow
                  icon="trash-outline"
                  label="Delete list"
                  onPress={() => fromMenu('delete')}
                />
              </>
            ) : (
              <SheetRow icon="flag-outline" label="Report list" onPress={() => fromMenu('report')} />
            )}
          </View>
        </Sheet>
      ) : null}

      <LogSheet
        title={logging}
        onClose={endLog}
        onDone={endLog}
        surface="list"
        postRank={placement}
        onRank={(bucket, mode) => {
          if (!logging) return;
          setRanking({
            id: logging.id,
            title: logging.title,
            bucket,
            posterUri: logging.posterUri,
            kind: logging.kind,
            mode,
          });
          setRanked(logging);
          setLogging(null);
        }}
      />

      <RankingSheet
        subject={ranking}
        onClose={() => {
          setRanking(null);
          invalidateAfterCollectionChange(queryClient, profile.id, ranked?.id ?? '', {});
          refetchAll();
        }}
        onFinishLog={(result) => {
          setRanking(null);
          if (!ranked) return;
          setPlacement(result);
          setLogging(ranked);
        }}
        surface="list"
      />

      {editing ? (
        <EditListSheet
          list={view}
          profilePrivate={profile.visibility === 'private'}
          onClose={() => setEditing(false)}
          onChanged={refetchAll}
        />
      ) : null}

      {addingTitles ? (
        <AddTitlesSheet
          listId={view.id}
          listTitle={view.title}
          viewerId={profile.id}
          presentIds={presentIds}
          onClose={() => {
            setAddingTitles(false);
            refetchAll();
          }}
        />
      ) : null}

      {reporting ? (
        <ReportSheet
          visible
          onClose={() => setReporting(false)}
          subject="list"
          subjectId={view.id}
          noun="list"
        />
      ) : null}
    </Screen>
  );
}

/**
 * A FlatList cell that rises above its neighbours while its row is lifted. Each cell is
 * its own view, so the row's own `zIndex` cannot reach past the cell it sits in.
 */
function LiftableCell({
  index,
  style,
  children,
  ...rest
}: ViewProps & { index: number; children?: ReactNode }) {
  const lifted = useContext(LiftedRow);
  return (
    <View {...rest} style={[style, lifted === index ? styles.liftedCell : null]}>
      {children}
    </View>
  );
}

/**
 * Who a list belongs to.
 *
 * A **lock glyph** when the viewer cannot see the owner's profile, which is the limited
 * identity of §F.2: avatar, display name and handle, and nothing else. There is
 * deliberately no "more lists by…" anywhere on this screen. Holding a link grants one
 * list.
 */
function Attribution({
  owner,
  onPress,
}: {
  owner: {
    username: string;
    displayName: string;
    avatarUri: string | null;
    profileVisible: boolean;
  };
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${owner.displayName}, @${owner.username}${
        owner.profileVisible ? '' : '. Private account'
      }`}
      onPress={onPress}
      style={({ pressed }) => [styles.attribution, pressed && styles.pressed]}
    >
      <Avatar uri={owner.avatarUri} name={owner.displayName} size="sm" />
      <Text variant="footnote" numberOfLines={1} style={styles.attributionName}>
        {owner.displayName} · @{owner.username}
      </Text>
      {owner.profileVisible ? null : (
        <Ionicons
          name="lock-closed-outline"
          size={theme.layout.icon.sm - 4}
          color={theme.text.tertiary}
        />
      )}
      <Ionicons name="chevron-forward" size={theme.layout.icon.sm} color={theme.text.tertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  loading: { paddingTop: theme.space[4] },
  list: { paddingBottom: theme.space[8] },
  header: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    gap: theme.space[3],
  },
  facts: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space[1] },
  banner: {
    padding: theme.space[3],
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.sunken,
  },
  attribution: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
  },
  attributionName: { flex: 1 },
  menu: { paddingBottom: theme.space[4], paddingTop: theme.space[2] },
  actionRow: { flexDirection: 'row', gap: theme.space[2] },
  half: { flex: 1 },
  pressed: { opacity: 0.7 },
  lifted: {
    backgroundColor: theme.surface.raised,
    ...theme.elevation.e2,
  },
  liftedCell: { zIndex: 10, elevation: 10 },
});
