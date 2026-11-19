import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type AccessibilityActionEvent,
} from 'react-native';

import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  BrowseControlsRow,
  EmptyState,
  FilterIconButton,
  PosterGridList,
  PosterTileCopy,
  Text,
  TitleMetadata,
  TitleRow,
  ViewModeToggle,
  type PosterTile,
} from '@/ui/components';
import type { TitleRowProps } from '@/ui/components/TitleRow';
import { coerceSortState, filterSortSpoken } from '@/ui/sort';
import { theme } from '@/ui/tokens';
import { useMakeRoom } from '@/ui/use-make-room';

import { CollectionFilterSheet } from './CollectionFilterSheet';
import { RerankNoticeBar } from './RerankNoticeBar';
import { TitleRowActions } from './TitleRowActions';
import {
  activeFilterCount,
  COLLECTION_SORT_AXES,
  emptyFilters,
  nextShuffleSeed,
  offersRuntime,
  sortAxesFor,
  sortItems,
  visibleItems,
  type CollectionFilters,
  type CollectionItem,
  type CollectionSegment,
  type CollectionSortState,
} from './filters';
import { landingBucket, ladderOf, moveActions, notices, screenBlock, type Ladder } from './rerank';
import { BUCKET_LABEL, type Bucket } from './score';
import type { RankingCategory } from './use-collection';
import { useLiftDrag } from './use-lift-drag';
import type { RerankController } from './use-rerank';

/**
 * Poster or list.
 *
 * **Named `poster` and not `wall`**, which it was until the 2026-08-28 tranche. The
 * value had never left the process, so the internal name and the label on the control
 * were free to disagree; that tranche persists the choice, and a stored string reading
 * `wall` under a control labelled Poster is a disagreement that outlives every rename
 * anybody would think to make. The word the founder uses is Poster, so this is Poster.
 */
export type CollectionViewMode = 'list' | 'poster';

export type CollectionViewState = {
  filters: CollectionFilters;
  /**
   * The axis and the direction, as one value.
   *
   * It was a flat `SortKey` — `'score-desc'`, `'recent'` — which could name a direction
   * for one axis and none for another, and which the chip then had to translate back
   * into a label. See `filters.ts` for what that cost.
   */
  sort: CollectionSortState;
  mode: CollectionViewMode;
  /**
   * Moved by every press of Shuffle ({@link nextShuffleSeed}), and by nothing else — not a
   * scroll, a re-render, a refetch, a filter or a switch between Poster and List.
   */
  seed: number;
};

/**
 * A fresh collection, before any stored preference has arrived.
 *
 * **Poster, which is the founder's aesthetic default** (§11). It was List, and the
 * reasoning for the change is that a collection is a wall of artwork before it is a
 * table of scores — the first thing a person should see of what they have watched is
 * what it looked like.
 *
 * This is the *unset* default rather than the startup mode. `CollectionScreen` reads a
 * stored choice over the top of it, so a reader who has chosen List gets List on every
 * launch; this value is what a device with nothing stored opens on, and what a stored
 * value that fails to parse falls back to.
 */
export const initialViewState = (): CollectionViewState => ({
  filters: emptyFilters(),
  // Rating, highest first — the same order the collection has always opened on, said
  // in the vocabulary the control now uses.
  sort: { axis: COLLECTION_SORT_AXES.rating.axis, direction: 'desc' },
  mode: 'poster',
  seed: 1,
});

/** Whether an unknown value from the preference store is a mode this component can draw. */
export const isCollectionViewMode = (value: unknown): value is CollectionViewMode =>
  value === 'list' || value === 'poster';

export type CollectionViewProps = {
  items: readonly CollectionItem[];
  segment: CollectionSegment;
  state: CollectionViewState;
  onChange: (next: CollectionViewState) => void;
  onPressItem: (mediaItemId: string) => void;
  /** Shown when the collection itself is empty, before any filtering. */
  empty: React.ReactNode;
  /**
   * Drawn at the right of the count row: Collection's `My lists ›` (UI cohesion pass,
   * 2026-11-06). Also drawn above an empty collection, where there is no count row, so the
   * way to the lists never depends on there being titles.
   */
  countAccessory?: ReactNode;
  /**
   * The page's marquee title, `Watched ▾` (marquee cohesion sprint, 2026-11-07): the left
   * of the toolbar, which scrolls away with the titles. Drawn in every state, so the way
   * to Watchlist never depends on there being titles here.
   */
  title?: ReactNode;
  /** Cards between the toolbar and the count (the unranked and refine prompts). */
  lead?: ReactNode;
  /**
   * Drawn in place of the titles while the section has none to give yet: its skeleton
   * while the read is on its way, its error when it failed. `items` is ignored meanwhile.
   *
   * **Here rather than in a screen of its own, so the toolbar is never remounted**
   * (2026-11-11). Collection drew loading and failed sections with a toolbar of their own
   * and swapped in this component's when the titles landed: two places in the tree, so a
   * Watched ▾ menu opened before the list arrived closed by itself when it did. Every
   * state is now drawn in the same list, under the same header.
   */
  placeholder?: ReactNode;
  /**
   * **Drag-to-rerank** (#318, `docs/architecture/collection-rerank.md`). Given on Watched
   * only. Absent, a long-press does nothing and nothing about the view changes.
   */
  rerank?: CollectionRerank;
};

export type CollectionRerank = {
  controller: RerankController;
  /**
   * The ranking these titles are, or null for a wall that mixes pools: the TV wall, one
   * poster per series with an explicit show score or a season average. Null is never
   * dragged; a long-press there points at the pool editors.
   */
  pool: RankingCategory | null;
  /**
   * Set while a TV pool editor is open. The titles are then that pool's ranked units,
   * always in ranking order with no filters, each labelled with its rank.
   */
  editor?: { title: string; onDone: () => void; footnote?: string };
  /** The TV wall's way into the editors (`Reorder` in the count row). */
  onReorderTv?: () => void;
};

/** The ranking order: the only order a display index can be a position in. */
const RANKING_ORDER: CollectionSortState = { axis: COLLECTION_SORT_AXES.rating.axis, direction: 'desc' };

/**
 * One collection, two views.
 *
 * List and Poster are not separate screens and not separate tabs — the brief is
 * explicit that Poster is a *view mode* over the same Movies/TV and Watched/Watchlist
 * selection, so both read the same filtered, sorted array and differ only in what
 * they draw. Everything above them is shared: one filter sheet, one sort menu, one
 * shuffle seed.
 *
 * The state lives with the caller so it survives switching between Watched and
 * Watchlist, which is what "persists while navigating within the Collection" means in
 * practice — a filter that resets every time you look at your watchlist is a filter
 * nobody uses twice.
 */
export function CollectionView({
  items,
  segment,
  state,
  onChange,
  onPressItem,
  empty,
  countAccessory,
  title,
  lead,
  placeholder,
  rerank,
}: CollectionViewProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const editor = rerank?.editor;

  // Runtime only where a row could carry one: not on a TV list made only of seasons.
  const axes = sortAxesFor(segment, { runtime: offersRuntime(items) });
  // A sort the current segment does not offer — Rating on a watchlist — falls back
  // rather than silently ordering by a field that is null on every row. The fallback
  // lands in the replacement axis's own default direction, so the chip, the arrow and
  // the rows agree the moment the tab changes.
  const sort = coerceSortState(state.sort, axes);

  // No manual `useMemo`. The React Compiler is on for this project
  // (app.config.ts `experiments.reactCompiler`), and it memoizes this itself —
  // a hand-written one here only gave it a dependency list it could not prove
  // stable, which it reports rather than silently ignoring.
  // A pool editor is always the ranking itself: no filter, no other order.
  const visible = editor
    ? sortItems(items, RANKING_ORDER)
    : visibleItems(items, state.filters, sort, state.seed);

  /**
   * **Whether this screen is one ranking, and which** (#318). `block` says why not; the
   * ladder is the ranked rows as positions `1..n` of one pool. A drag, an accessibility
   * move and a refused long-press all read these two, so they cannot disagree.
   */
  const block = rerank
    ? screenBlock({
        segment,
        sort: editor ? RANKING_ORDER : sort,
        filters: editor ? emptyFilters() : state.filters,
        pool: rerank.pool,
      })
    : 'segment';
  const ladder: Ladder | null =
    rerank && block === null && rerank.pool ? ladderOf(visible, rerank.pool) : null;
  const rungCount = ladder?.rungs.length ?? 0;

  const listRef = useRef<FlashListRef<unknown>>(null);
  const { width: windowWidth } = useWindowDimensions();
  const containerRef = useRef<View>(null);
  /** The title that was lifted, so a drop can confirm its index still names it. */
  const liftedId = useRef<string | null>(null);
  const drag = useLiftDrag({
    listRef,
    containerRef,
    count: rungCount,
    // "Outside" is now "lands in another category" (founder, 2026-11-19): a drop there is
    // applied, and recategorises the title. The tick and the label say it is happening.
    // The view and the width decide where a cell's left edge sits (Codex, PR 319).
    layoutKey: `${state.mode}:${windowWidth}`,
    isOutside: (from, to) =>
      ladder ? landingBucket(ladder, from, to) !== ladder.rungs[from]?.bucket : false,
    onDrop: (from, to) => {
      if (!ladder || !rerank) return;
      // A refetch can land mid-drag and renumber the screen. If the index no longer names
      // the title in the reader's hand, nothing is moved.
      if (ladder.rungs[from]?.mediaItemId !== liftedId.current) {
        rerank.controller.explain(notices.blocked('ambiguous', { mediaItemId: '', title: '' }));
        return;
      }
      rerank.controller.move(ladder, from, to);
    },
  });
  const lifted = drag.state;
  /** The category the lifted title would land in, when that is not its own. */
  const crossingInto: Bucket | null =
    lifted && ladder && lifted.outside ? landingBucket(ladder, lifted.from, lifted.to) : null;
  const crossLabel = crossingInto ? (
    <View style={styles.crossLabel} testID="collection-lifted-category">
      <Text variant="caption" style={styles.crossLabelText} numberOfLines={1}>
        {`Move to ${BUCKET_LABEL[crossingInto]}`}
      </Text>
    </View>
  ) : null;

  /**
   * What stands in for the titles, when something does: the section's own placeholder
   * (loading, failed), the empty collection, or a filter that hides everything. It is
   * drawn under the header inside the same list the titles use, so the toolbar keeps its
   * place in the tree whatever the read is doing (see `placeholder`).
   */
  const hasTitles = placeholder == null && items.length > 0;
  const standIn =
    placeholder != null ? (
      placeholder
    ) : items.length === 0 ? (
      <StateFill>{empty}</StateFill>
    ) : visible.length === 0 ? (
      <View style={styles.padded}>
        <EmptyState
          kind="nothingMatches"
          compact
          title="Nothing matches"
          body="Try removing a filter."
          action={{
            label: 'Clear all',
            onPress: () => onChange({ ...state, filters: emptyFilters() }),
          }}
        />
      </View>
    ) : null;

  const activeCount = activeFilterCount(state.filters);

  /**
   * **Every press of Shuffle, from any axis or from Shuffle itself** (approved spec,
   * 2026-11-10): a new seed whose order differs from the one on screen, applied at once,
   * and the sheet closed so the new order is what the reader sees next.
   *
   * It does not wait for Apply and does not apply the filter drafts: those are the
   * filters' own, and closing the sheet abandons them exactly as closing it any other way
   * does. There is no reshuffle glyph in the toolbar any more — Shuffle lives in the sheet.
   */
  const shuffleNow = () => {
    setFilterOpen(false);
    // The sheet closes on the press, so nothing on screen says the order changed; a screen
    // reader is told in words.
    AccessibilityInfo.announceForAccessibility('Shuffled');
    onChange({
      ...state,
      sort: { axis: COLLECTION_SORT_AXES.shuffle.axis, direction: 'desc' },
      seed: nextShuffleSeed(
        items,
        state.filters,
        state.seed,
        visible.map((item) => item.mediaItemId),
      ),
    });
  };

  /**
   * **A long-press on a title** (#318): lift it, or say why not and offer the way there.
   * Never a mutation from a display index: only a rung of an unambiguous ladder lifts.
   */
  const onLongPressItem = (item: CollectionItem, index: number, node: View | null) => {
    if (!rerank || block === 'segment') return;
    const explain = (kind: Parameters<typeof notices.blocked>[0]) =>
      rerank.controller.explain(notices.blocked(kind, nameAndId(item)));
    if (block === 'tv-wall') return explain('tv-wall');
    if (item.score == null || item.position == null) return explain('unranked');
    if (block) return explain(block);
    if (!ladder || index >= rungCount) return explain('ambiguous');
    if (rerank.controller.busy) return;
    liftedId.current = item.mediaItemId;
    drag.lift(index, node);
  };

  /** The same moves as a drag, as VoiceOver and TalkBack actions on each rung. */
  const a11yFor = (index: number) => {
    if (!ladder || !rerank || index >= rungCount) return null;
    const actions = moveActions(ladder, index);
    if (actions.length === 0) return null;
    return {
      accessibilityActions: actions.map(({ name, label }) => ({ name, label })),
      onAccessibilityAction: (event: AccessibilityActionEvent) => {
        const action = actions.find((a) => a.name === event.nativeEvent.actionName);
        if (action) rerank.controller.move(ladder, index, action.to, action.toBucket);
      },
      accessibilityHint: 'Touch and hold to move it',
    };
  };

  /** What a notice's button does. */
  const onNoticeAction = () => {
    const notice = rerank?.controller.notice;
    if (!rerank || !notice?.action) return;
    switch (notice.action.kind) {
      case 'undo':
        return rerank.controller.undo();
      case 'retry':
        return rerank.controller.retry();
      case 'sortByRating':
        rerank.controller.dismiss();
        return onChange({ ...state, sort: RANKING_ORDER, filters: emptyFilters() });
      case 'openTitle':
        rerank.controller.dismiss();
        return notice.mediaItemId ? onPressItem(notice.mediaItemId) : undefined;
      case 'reorderTv':
        rerank.controller.dismiss();
        return rerank.onReorderTv?.();
      default:
        return undefined;
    }
  };

  /** A pool editor's rank label: the position, which is what a drop changes. */
  const rankLabel = (index: number) =>
    editor && ladder && index < rungCount ? `#${ladder.rungs[index]?.position}` : null;

  /**
   * **The page's toolbar, then its cards, then the count — all at the head of the list**
   * (founder, marquee cohesion sprint, 2026-11-07).
   *
   *     Watched ▾                               ⚙   ▦ ☰
   *     37 titles                                My lists ›
   *
   * The marquee is the page's navigation (Watched / Watchlist / Unranked), and the tools
   * opposite it act on what it shows: the Filters & Sort icon, one sheet holding the sort and
   * the filters, then the Poster / List toggle, rightmost (QA 11-14, §5) —
   * `BrowseControlsRow` since FU1113-C, so the tools never wrap and the marquee is what gives way on a narrow phone. The full-width segmented control that sat above this is
   * gone; the order in force is not written beside Filters any more, because the sheet
   * names it. The whole header scrolls away with the titles, so the posters get the screen
   * back; the app header and the tab bar stay where they always were.
   */
  const header = (
    <View>
      {/* First, in every state: the one position the marquee has (see `placeholder`). The
          tools act on titles, so they are drawn only when there are some. */}
      <View style={styles.toolbar}>
        <BrowseControlsRow
          testID="collection-toolbar"
          leading={
            editor ? (
              <Text variant="headline" numberOfLines={1} testID="collection-editor-title">
                {editor.title}
              </Text>
            ) : (
              title
            )
          }
          trailing={
            editor ? (
              <>
                <ViewModeToggle
                  value={state.mode}
                  onChange={(mode) => onChange({ ...state, mode })}
                  testID="collection-view-mode"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Done reordering ${editor.title.replace(/^Reorder /, '')}`}
                  onPress={editor.onDone}
                  hitSlop={theme.space[2]}
                  style={({ pressed }) => [styles.textAction, pressed && styles.pressed]}
                  testID="collection-editor-done"
                >
                  <Text variant="callout" tone="action">
                    Done
                  </Text>
                </Pressable>
              </>
            ) : hasTitles ? (
              <>
                {/* **Filters & Sort first, the view toggle rightmost** (founder QA 11-14,
                    §5; was toggle then filter), as on For You. */}
                <FilterIconButton
                  activeCount={activeCount}
                  // The sentence says the order and the count itself, so the button adds no
                  // ", N on" of its own.
                  accessibilityLabel={filterSortSpoken(axes, sort, activeCount)}
                  announceCount={false}
                  accessibilityHint="Opens filters and the sort order"
                  onPress={() => setFilterOpen(true)}
                  testID="collection-filter-sort"
                />
                {/* The view control, not a third collection state. **Poster first, list
                    second** (founder §11): the leftmost cell is the one a device with no
                    stored preference opens on, so the row and the state agree. */}
                <ViewModeToggle
                  value={state.mode}
                  onChange={(mode) => onChange({ ...state, mode })}
                  testID="collection-view-mode"
                />
              </>
            ) : undefined
          }
        />
      </View>

      {lead}

      {hasTitles ? (
        <View style={styles.countRow}>
          <Text variant="footnote" tone="secondary" style={styles.countText} testID="collection-count">
            {editor
              ? `${rungCount} ranked · touch and hold to move`
              : visible.length === items.length
                ? `${items.length} ${items.length === 1 ? 'title' : 'titles'}`
                : `${visible.length} of ${items.length}`}
          </Text>
          {!editor && rerank?.onReorderTv ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reorder TV shows or seasons"
              onPress={rerank.onReorderTv}
              hitSlop={theme.space[2]}
              style={({ pressed }) => [styles.textAction, pressed && styles.pressed]}
              testID="collection-reorder-tv"
            >
              <Text variant="footnote" tone="action">
                Reorder
              </Text>
            </Pressable>
          ) : null}
          {editor ? null : countAccessory}
        </View>
      ) : countAccessory ? (
        // The way to the lists never depends on there being titles.
        <View style={styles.accessoryOnly}>{countAccessory}</View>
      ) : null}

      {editor?.footnote ? (
        <Text variant="footnote" tone="tertiary" style={styles.editorNote} testID="collection-editor-note">
          {editor.footnote}
        </Text>
      ) : null}

      {standIn}
    </View>
  );
  /** The titles the list draws: none while something stands in for them. */
  const shown = standIn == null ? visible : [];

  return (
    <View style={styles.body}>
      {state.mode === 'poster' ? (
        /**
         * **Both modes are virtualised, and that is the 2026-09-16 fix.**
         *
         * Each drew every row it was given into a plain `ScrollView`, so a library of 688
         * imported titles mounted 688 tiles before the first frame and kept every one of
         * them alive while scrolling. It was never about the importer: Watched (ranked
         * Movies and TV), Watchlist, Unranked and every filtered or sorted view of them
         * are this component, and all of them grew the same way. Poster was the one a
         * reader noticed because its tile is the heavier cell.
         *
         * Order, filters and counts are untouched: `visible` is computed exactly as it
         * was, and only the drawing of it changed.
         */
        <View style={styles.body} ref={containerRef} {...drag.containerProps}>
        <PosterGridList
          listRef={listRef as RefObject<FlashListRef<PosterTile>>}
          extraData={`${lifted?.from ?? -1}:${lifted?.to ?? -1}:${rungCount}:${rerank?.controller.busy}`}
          scrollEnabled={lifted === null}
          onScroll={drag.onScroll}
          tileExtras={
            rerank
              ? (_tile, index) => {
                  const item = shown[index];
                  const shift = drag.shiftOf(index);
                  return {
                    onLongPress: item
                      ? (node) => onLongPressItem(item, index, node)
                      : undefined,
                    onPressOut: drag.releaseWithoutMoving,
                    ...a11yFor(index),
                    badge: rankLabel(index),
                    hidden: shift?.hidden,
                    shift: shift && !shift.hidden ? { x: shift.x, y: shift.y } : null,
                  };
                }
              : undefined
          }
          tiles={shown.map(tileOf)}
          onPressTile={(tile) => {
            if (lifted === null) onPressItem(tile.id);
          }}
          // The wall's top space follows the header now, rather than preceding it.
          header={
            <>
              {header}
              <View style={styles.wallTop} />
            </>
          }
          paddingBottom={styles.wall.paddingBottom}
        />
        {lifted?.frame && shown[lifted.from] ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.lifted,
              { left: lifted.frame.x, top: lifted.frame.y, width: lifted.frame.width },
              { transform: [...drag.travel.getTranslateTransform(), { scale: LIFT_SCALE }] },
            ]}
            testID="collection-lifted"
          >
            <PosterTileCopy
              tile={tileOf(shown[lifted.from] as CollectionItem)}
              width={lifted.frame.width}
              badge={rankLabel(lifted.from)}
            />
            {crossLabel}
          </Animated.View>
        ) : null}
        </View>
      ) : (
        <View style={styles.body} ref={containerRef} {...drag.containerProps}>
        <FlashList
          ref={listRef as RefObject<FlashListRef<CollectionItem>>}
          data={shown}
          extraData={`${lifted?.from ?? -1}:${lifted?.to ?? -1}:${rungCount}:${rerank?.controller.busy}`}
          scrollEnabled={lifted === null}
          onScroll={drag.onScroll}
          scrollEventThrottle={16}
          keyExtractor={(item) => item.mediaItemId}
          // See the note on the grid in `PosterGridList`: a re-sort keeps the offset
          // rather than chasing the row that happened to be on top.
          maintainVisibleContentPosition={LIST_POSITION}
          ListHeaderComponent={header}
          contentContainerStyle={styles.list}
          renderItem={({ item, index }) => {
            const shift = rerank ? drag.shiftOf(index) : null;
            const label = rankLabel(index);
            const row: TitleRowProps = {
              title: label ? `${label}  ${nameOf(item)}` : nameOf(item),
              year: item.year,
              posterUri: posterUri(item.posterPath),
              secondary: (
                <TitleMetadata
                  runtimeMinutes={item.runtimeMinutes}
                  genres={item.genres}
                  showYear={false}
                />
              ),
              trailing:
                segment !== 'watchlist' ? (
                  // The compact-row contract (design-system.md §11b): the score when
                  // ranked, otherwise the ordinary `+` — never a dashed ring, and the same
                  // for an import never ranked and a ranking left unfinished. It opens the
                  // title, whose Rank resumes an unfinished session.
                  <TitleRowActions
                    name={nameOf(item)}
                    kind={item.kind}
                    score={
                      item.score != null
                        ? {
                            score: item.score,
                            bucket: item.bucket,
                            // WS-TVC: a season average draws outlined, as on the wall —
                            // the same `SN AVG` badge since FU1113-B.
                            variant: item.showScore?.source === 'average' ? 'outlined' : 'filled',
                            average: item.showScore?.source === 'average',
                          }
                        : null
                    }
                    saved={null}
                    onRank={() => onPressItem(item.mediaItemId)}
                    onToggleWatchlist={() => {}}
                  />
                ) : undefined,
              divided: true,
              onPress: () => {
                if (lifted === null) onPressItem(item.mediaItemId);
              },
              ...(rerank ? { onPressOut: drag.releaseWithoutMoving, ...a11yFor(index) } : {}),
            };
            return rerank ? (
              <LiftableRow
                identity={item.mediaItemId}
                shift={shift}
                onLongPress={(node) => onLongPressItem(item, index, node)}
                row={row}
              />
            ) : (
              <TitleRow {...row} />
            );
          }}
        />
        {lifted?.frame && shown[lifted.from] ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.lifted,
              styles.liftedRow,
              { left: lifted.frame.x, top: lifted.frame.y, width: lifted.frame.width },
              { transform: [...drag.travel.getTranslateTransform(), { scale: LIFT_SCALE }] },
            ]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID="collection-lifted"
          >
            <TitleRow
              title={nameOf(shown[lifted.from] as CollectionItem)}
              year={(shown[lifted.from] as CollectionItem).year}
              posterUri={posterUri((shown[lifted.from] as CollectionItem).posterPath)}
              onPress={() => {}}
            />
            {crossLabel}
          </Animated.View>
        ) : null}
        </View>
      )}

      {rerank?.controller.notice && !lifted ? (
        <RerankNoticeBar
          notice={rerank.controller.notice}
          onAction={onNoticeAction}
          onDismiss={rerank.controller.dismiss}
        />
      ) : null}

      {/* Mounted only while open, so the draft is seeded from the filters actually
          in force each time. See the comment on `CollectionFilterSheetProps.value`. */}
      {filterOpen ? (
        <CollectionFilterSheet
          items={items}
          value={state.filters}
          showBuckets={segment !== 'watchlist'}
          onApply={(filters) => {
            setFilterOpen(false);
            onChange({ ...state, filters });
          }}
          onClose={() => setFilterOpen(false)}
          // The sort choices this segment offers, applied on the press as they always were;
          // the sheet stays open so a second press reverses. Shuffle is the exception: any
          // press of it deals a new order and closes the sheet (`shuffleNow`).
          sort={{
            axes,
            value: sort,
            onChange: (next) =>
              next.axis === COLLECTION_SORT_AXES.shuffle.axis
                ? shuffleNow()
                : onChange({ ...state, sort: next }),
            onRepeatUndirected: shuffleNow,
          }}
        />
      ) : null}
    </View>
  );
}

const LIST_POSITION = { disabled: true } as const;

/** How much a lifted title grows, so it reads as picked up. */
const LIFT_SCALE = 1.04;

/** One Collection title as a wall tile. The lifted copy draws the same tile. */
const tileOf = (item: CollectionItem): PosterTile => ({
            id: item.mediaItemId,
            title: nameOf(item),
            year: item.year,
            // `row` (342px wide) rather than `card` (500px). A wall tile is a third of
            // the screen, about 115pt, which is 345px at 3x and ~300px on a typical
            // Android panel — so 342 is the tile's own resolution, and 500 was decoding
            // twice the pixels for every poster scrolled past.
            posterUri: posterUri(item.posterPath, 'row'),
            // Only for titles that have one. A watchlist wall carries no
            // numbers, which is what keeps it from looking like a scoreboard.
            score: item.score,
            bucket: item.bucket,
            // A ranked season's pill names its season: `S4 - 9.1`. The TV Collection draws
            // series, not seasons, since WS-TVC, so this only fires where a season tile
            // still appears.
            season: item.kind === 'season' && item.score != null ? (item.seasonNumber ?? null) : null,
            // WS-TVC: a series poster's score is its explicit show ranking (filled) or the
            // mean of its ranked seasons (outlined `SN AVG`).
            scoreSource: item.showScore?.source,
            rankedSeasonCount: item.showScore?.rankedSeasonCount,
});

const nameAndId = (item: CollectionItem) => ({ mediaItemId: item.mediaItemId, title: nameOf(item) });

/**
 * A list row that can be lifted (#318): the long-press is handed the row's own view, so the
 * floating copy starts exactly over it, and the row moves out of the way or hides while
 * another is held.
 */
function LiftableRow({
  shift,
  onLongPress,
  row,
  identity,
}: {
  shift: { hidden: boolean; x: number; y: number } | null;
  onLongPress: (node: View | null) => void;
  row: TitleRowProps;
  /** The title the (recycled) cell draws now, so a new title is placed, not eased in. */
  identity: string;
}) {
  const node = useRef<View>(null);
  // Eased to its place while another title is held over it, rather than jumped there.
  const offset = useMakeRoom(shift && !shift.hidden ? { x: 0, y: shift.y } : null, identity);
  return (
    <Animated.View
      ref={node}
      collapsable={false}
      style={[{ transform: [{ translateY: offset.y }] }, shift?.hidden ? styles.hiddenRow : null]}
    >
      <TitleRow {...row} onLongPress={() => onLongPress(node.current)} />
    </Animated.View>
  );
}

/**
 * A state that stands in for the whole list (an empty collection, a failed read), centred
 * in roughly the room the list would have had.
 *
 * It is drawn inside the list's header now (see `placeholder`), and a header has no height
 * to fill, so `EmptyState`'s own `flex: 1` collapses and the state would sit pinned under
 * the toolbar with the screen blank below it (independent review, 2026-11-11). A minimum
 * height from the window gives it the room it had when it filled the screen. The skeleton
 * does not use this: a loading list starts at the top, as the titles will.
 */
export function StateFill({ children }: { children: ReactNode }) {
  const { height } = useWindowDimensions();
  return (
    <View
      style={[styles.fill, { minHeight: Math.round(height * STATE_FILL) }]}
      testID="collection-state-fill"
    >
      {children}
    </View>
  );
}

/** The share of the window a whole-list state is centred in: below the app header,
 * toolbar and tab bar on a phone. */
const STATE_FILL = 0.55;

/** A ranked TV list is otherwise a column of rows called "Season 2". */
const nameOf = (item: CollectionItem) =>
  compactName({
    kind: item.kind,
    title: item.title,
    seriesTitle: item.seriesTitle,
    seasonNumber: item.seasonNumber,
  }) ?? item.title;

const styles = StyleSheet.create({
  body: { flex: 1 },
  // The toolbar's top inset, as `ContentToolbar` drew it: `BrowseControlsRow` draws none.
  toolbar: { paddingTop: theme.space[2] },

  /** `37 titles` on the left and the lists link on the right, one line under the toolbar. */
  countRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[1],
    minHeight: theme.layout.minTapTarget - theme.space[2],
  },
  countText: { flexShrink: 1 },
  accessoryOnly: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
  list: { paddingBottom: theme.space[10] },
  wall: { paddingBottom: theme.space[10] },
  wallTop: { height: theme.space[2] },
  padded: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
  textAction: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.space[2],
  },
  pressed: { opacity: 0.7 },
  editorNote: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  /** The floating copy of a lifted title, over the list it was lifted from (#318). */
  lifted: { position: 'absolute', zIndex: 10, elevation: 10 },
  liftedRow: {
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.control,
    ...theme.elevation.e2,
  },
  /**
   * Over another category: the drop recategorises the title (founder, 2026-11-19), so the
   * lifted copy names where it is going, on the copy itself, so the label travels with the
   * finger and never covers the place being dropped on.
   */
  crossLabel: {
    position: 'absolute',
    top: theme.space[2],
    alignSelf: 'center',
    paddingHorizontal: theme.space[2],
    paddingVertical: theme.space[1],
    borderRadius: theme.radius.control,
    backgroundColor: theme.semantic.action,
  },
  crossLabelText: { color: theme.semantic.actionText },
  hiddenRow: { opacity: 0 },
  fill: { justifyContent: 'center' },
});
