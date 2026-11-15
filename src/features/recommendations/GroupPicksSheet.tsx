import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { CollectionFilterSheet } from '@/features/collection/CollectionFilterSheet';
import {
  activeFilterCount,
  applyFilters,
  emptyFilters,
  isFiltered,
  type CollectionFilters,
} from '@/features/collection/filters';
import { invalidateAfterWatchlistChange } from '@/features/collection/invalidate';
import { useWatchlist } from '@/features/collection/use-collection';
import { mustReconcile, newOperationId, setWatchlist } from '@/features/collection/writes';
import { PeoplePicker } from '@/features/people/PeoplePicker';
import { track } from '@/lib/analytics';
import { posterUri } from '@/lib/images';
import {
  Button,
  DismissFooter,
  EmptyScoreBadge,
  EmptyState,
  FilterChip,
  ScoreBadge,
  Sheet,
  SheetHeader,
  SkeletonRow,
  Text,
  TitleRow,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

import {
  GROUP_PICKS_MIN,
  GROUP_PICKS_MIN_MEMBERS,
  hasSharedSaves,
  reasonFor,
  selectGroupPicks,
  sourceMix,
  type GroupPick,
} from './group-picks';
import { useRecommendRecipients } from './use-recommend';
import type { Medium } from './use-for-you';
import { useGroupPicks } from './use-group-picks';

export type GroupPicksSheetProps = {
  viewerId: string;
  /** The wall the sheet was opened from. Movies answers movies; TV answers series. */
  medium: Medium;
  onClose: () => void;
};

/**
 * Group Picks: who's watching, then what to watch.
 *
 * One ephemeral group per open. The selection lives in this component's state, the
 * scored answer lives in a five-minute query cache, and closing the sheet discards
 * the group — there is nothing to name, save, or invite anybody to. The people
 * offered are the same population RecommendSheet offers, through the same hook and
 * the same extracted picker, with the reader pinned into seat one.
 *
 * The results are a list rather than a wall because the reason is the row's second
 * fact, and a reason under a poster tile is a caption nobody reads. Each row gives
 * exactly one reason, worded from the aggregates the server returns; the trailing
 * number is the community bingd. score or the empty circle, never the group's
 * internal ranking, which stays internal.
 */
export function GroupPicksSheet({ viewerId, medium, onClose }: GroupPicksSheetProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const recipients = useRecommendRecipients(viewerId);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Null while choosing; the frozen member list once picks were asked for. */
  const [confirmed, setConfirmed] = useState<string[] | null>(null);
  /**
   * This sheet's own filters, deliberately not shared with the For You wall: a group
   * deciding on comedy tonight is not the reader's standing mood. Reset with the sheet.
   */
  const [filters, setFilters] = useState<CollectionFilters>(emptyFilters());
  const [filtering, setFiltering] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const people = recipients.data ?? [];
  const slate = useGroupPicks(viewerId, confirmed ?? [], medium, confirmed !== null);
  const watchlist = useWatchlist(viewerId);
  const savedIds = new Set((watchlist.data ?? []).map((row) => row.mediaItemId));

  /**
   * `group_picks_generated`, once per answer the reader was actually shown.
   *
   * Keyed to the query data itself: a new member set or medium is a new fetch and a
   * new emission; a filter change narrows in place and emits nothing, because the
   * filters are not in the query key by design.
   */
  const generated = slate.data;
  useEffect(() => {
    if (!generated) return;
    const shown = selectGroupPicks(generated.picks);
    track({
      name: 'group_picks_generated',
      props: {
        group_size: generated.effectiveMemberCount,
        result_count: shown.length,
        source_mix: sourceMix(shown),
        filter_count: 0,
      },
    });
  }, [generated]);

  const openPick = (pick: GroupPick, position: number) => {
    track({ name: 'group_picks_result_opened', props: { position } });
    // The sheet closes first: a push underneath an open modal navigates a screen
    // nobody can see, and the group is spent the moment a title is chosen anyway.
    onClose();
    router.push(`/title/${pick.item.mediaItemId}`);
  };

  const toggleSave = async (pick: GroupPick) => {
    if (busy) return;
    const mediaItemId = pick.item.mediaItemId;
    const present = !savedIds.has(mediaItemId);
    setBusy(mediaItemId);
    const result = await setWatchlist({ operationId: newOperationId(), mediaItemId, present });
    setBusy(null);

    // Additions only, and only on `ok` — the same rule as every other bookmark.
    if (present && result.outcome === 'ok') {
      track({ name: 'watchlist_added', props: { surface: 'group_picks' } });
    }
    if (mustReconcile(result)) {
      invalidateAfterWatchlistChange(queryClient, viewerId);
    }
    if (result.outcome === 'failed') {
      Alert.alert('Could not update watchlist', result.message);
    }
  };

  // ------------------------------------------------------------------ choosing
  if (confirmed === null) {
    const groupSize = selected.size + 1;
    return (
      <Sheet
        visible
        onClose={onClose}
        label="Group Recommendations"
        // The standard browsing sheet (FU1113-B): the picker and the picks share one height.
        size="standard"
        /**
         * **The CTA stays pinned, and Close sits quietly under it** (founder spec §4,
         * 2026-11-13). The picker scrolls above both; the CTA's behaviour is unchanged,
         * and Close is the sheet's standard, labelled way out — the scrim is hidden from
         * a screen reader, so a sheet without one leaves VoiceOver nowhere to go.
         */
        footer={
          <>
            {people.length > 0 ? (
              <View style={styles.actions}>
                {/**
                 * **The disabled button asks for what is missing** (founder, physical QA,
                 * 2026-09-08).
                 *
                 * The sheet opens with the reader already in seat one, so the button used to
                 * read `Get picks for 1` and be dead — a control offering to do the thing,
                 * for the number of people currently chosen, that refuses to do it. On a
                 * device that reads as broken rather than as unmet, and the reader is left to
                 * infer the rule from a greyed-out number.
                 *
                 * So below the minimum it states the requirement as an instruction, and at or
                 * above it counts. `GROUP_PICKS_MIN_MEMBERS` is the same rule the disabled
                 * state has always enforced — named, not changed. Nothing about who is asked
                 * for or what the server is sent moves.
                 */}
                <Button
                  label={
                    groupSize < GROUP_PICKS_MIN_MEMBERS
                      ? 'Add someone to get picks'
                      : `Get picks for ${groupSize}`
                  }
                  fit
                  onPress={() => setConfirmed([...selected])}
                  disabled={groupSize < GROUP_PICKS_MIN_MEMBERS}
                  disabledReason="Choose at least one person to watch with."
                />
              </View>
            ) : null}
            <DismissFooter onPress={onClose} />
          </>
        }
      >
        {/**
         * **One scroller for everything above the action** (independent review 2,
         * title-page sprint, 2026-11-06). At a large text size on a short phone the heading
         * and the sentence take several lines each; with the rows in a bounded list of their
         * own, the list was squeezed to nothing and the action pushed out of the sheet. Now
         * the heading, the question, the search, You and the rows scroll together and give
         * way first, and the action below them always stays in the sheet. Where everything
         * fits, nothing scrolls and nothing moves.
         */}
        <ScrollView
          style={styles.choosing}
          keyboardShouldPersistTaps="handled"
          testID="group-choosing"
        >
        <SheetHeader title="Group Recommendations" maxFontSizeMultiplier={HEADING_MAX_SCALE}>
          {/**
           * **One sentence saying what this is** (founder, physical QA, 2026-09-08).
           *
           * The sheet opened on a title, a question and a list of faces, which assumes
           * the reader already knows what this feature does. It is one of the few things
           * in bingd. that has no equivalent elsewhere, so it is precisely the screen
           * that cannot assume it — and the cost of explaining it is one line.
           *
           * Deliberately not a carousel, a tutorial or a dismissible tip. It sits above
           * the question rather than replacing it: this line says what will happen, and
           * `Who's watching?` is still the instruction for the control underneath.
           *
           * **Find for a Group, and Group Recommendations in here** (founder, title-page
           * sprint, 2026-11-06), after Group Picks and then Watch Together, which read as
           * watching in sync rather than recommendations for several people. Only the words
           * changed; the endpoint, analytics names and selected-person rules are still
           * `group_picks`. The sentence is the founder's and names no medium; the wall the
           * sheet was opened from still decides which medium the picks answer for.
           */}
          <Text variant="footnote" tone="secondary">
            Choose who’s watching, and get recommendations based on everyone’s tastes.
          </Text>
          <Text variant="footnote" tone="tertiary">
            Who&apos;s watching?
          </Text>
        </SheetHeader>

        {recipients.isPending ? (
          <Text variant="footnote" tone="tertiary" style={styles.status}>
            Finding your people…
          </Text>
        ) : recipients.isError ? (
          <View style={styles.status}>
            <EmptyState
              kind="couldNotLoad"
              compact
              title="Could not load your friends"
              body="Check your connection and try again."
              action={{ label: 'Try again', onPress: () => void recipients.refetch() }}
            />
          </View>
        ) : people.length === 0 ? (
          <View style={styles.status}>
            <EmptyState
              kind="nothingYet"
              compact
              title="Nobody to watch with yet"
              body="Follow people to get picks for a group."
            />
          </View>
        ) : (
          <PeoplePicker
            people={people}
            selected={selected}
            onToggle={(personId) =>
              setSelected((previous) => {
                const next = new Set(previous);
                if (next.has(personId)) next.delete(personId);
                else next.add(personId);
                return next;
              })
            }
            pinned={{ name: 'You' }}
            max={6}
            searchPlaceholder="Search your friends"
            inline
          />
        )}
        </ScrollView>

      </Sheet>
    );
  }

  // ------------------------------------------------------------------- results
  const pool = slate.data?.picks ?? [];
  const visibleItems = applyFilters(
    pool.map((pick) => pick.item),
    filters,
  );
  const filteredPool = pool.filter((pick) =>
    visibleItems.some((item) => item.mediaItemId === pick.item.mediaItemId),
  );
  const picks = selectGroupPicks(filteredPool);
  const activeCount = activeFilterCount(filters);
  const memberNames = [
    'You',
    ...confirmed
      .map((id) => people.find((person) => person.id === id)?.name)
      .filter((name): name is string => Boolean(name)),
  ];

  return (
    <Sheet
      visible
      onClose={onClose}
      label="Group Recommendations"
      size="standard"
      // Dismiss-only from here: the picks are the content, and each row leads somewhere.
      footer={<DismissFooter onPress={onClose} />}
    >
      <SheetHeader title="Group Recommendations" maxFontSizeMultiplier={HEADING_MAX_SCALE}>
        {/* The group, restated as names, so the list underneath has a visible subject.
            Labels rather than controls: the group is spent when the sheet closes. */}
        <View style={styles.members} accessibilityRole="text">
          {memberNames.map((name) => (
            <View key={name} style={styles.memberChip}>
              <Text variant="caption" tone="secondary">
                {name}
              </Text>
            </View>
          ))}
        </View>
      </SheetHeader>

      {slate.isPending ? (
        <SkeletonRow count={5} />
      ) : slate.isError ? (
        <View style={styles.status}>
          <EmptyState
            kind="couldNotLoad"
            compact
            title="Could not get picks"
            body="Check your connection and try again."
            action={{ label: 'Try again', onPress: () => void slate.refetch() }}
          />
        </View>
      ) : (
        <>
          <View style={styles.countRow}>
            <Text variant="footnote" tone="tertiary">
              {picks.length === 1 ? '1 pick' : `${picks.length} picks`}
            </Text>
            <View style={styles.countChips}>
              <FilterChip
                icon="options-outline"
                label={activeCount ? `Filters · ${activeCount}` : 'Filters'}
                selected={activeCount > 0}
                onPress={() => setFiltering(true)}
              />
              {isFiltered(filters) ? (
                <FilterChip icon="close" label="Clear all" onPress={() => setFilters(emptyFilters())} />
              ) : null}
            </View>
          </View>

          {pool.length === 0 ? (
            <View style={styles.status}>
              <EmptyState
                kind="nothingYet"
                compact
                title="Nothing to pick yet"
                body="A few more rankings will make these picks sharper."
              />
            </View>
          ) : picks.length === 0 ? (
            <View style={styles.status}>
              <EmptyState
                kind="nothingMatches"
                compact
                title="Nothing matches your filters"
                body="Try removing one, or clear them and start again."
                action={{ label: 'Clear all', onPress: () => setFilters(emptyFilters()) }}
              />
            </View>
          ) : (
            <ScrollView style={styles.list} testID="group-picks-list">
              {!hasSharedSaves(picks) ? (
                <Text variant="footnote" tone="tertiary" style={styles.quiet}>
                  Nobody has saved the same titles yet, so these come from everyone&apos;s
                  taste.
                </Text>
              ) : null}
              {picks.map((pick, index) => {
                const isSaved = savedIds.has(pick.item.mediaItemId);
                return (
                  <TitleRow
                    key={pick.item.mediaItemId}
                    title={pick.item.title}
                    year={pick.item.year}
                    posterUri={posterUri(pick.item.posterPath, 'row')}
                    secondary={reasonFor(pick)}
                    trailing={
                      <View style={styles.trailing}>
                        {/* The bingd. community score, or the same empty circle the
                            title page shows below its sample floor. Never the group's
                            internal ranking. */}
                        {pick.communityScore == null ? (
                          <EmptyScoreBadge size="sm" />
                        ) : (
                          <ScoreBadge score={pick.communityScore} size="sm" />
                        )}
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={
                            isSaved
                              ? `Remove ${pick.item.title} from your watchlist`
                              : `Add ${pick.item.title} to your watchlist`
                          }
                          accessibilityState={{
                            selected: isSaved,
                            disabled: busy === pick.item.mediaItemId,
                          }}
                          disabled={busy === pick.item.mediaItemId}
                          hitSlop={theme.space[2]}
                          onPress={() => void toggleSave(pick)}
                        >
                          <Ionicons
                            name={isSaved ? 'bookmark' : 'bookmark-outline'}
                            size={theme.layout.icon.md}
                            color={isSaved ? theme.semantic.action : theme.text.tertiary}
                          />
                        </Pressable>
                      </View>
                    }
                    divided
                    onPress={() => openPick(pick, index + 1)}
                  />
                );
              })}
              {picks.length > 0 && picks.length < GROUP_PICKS_MIN && !isFiltered(filters) ? (
                <Text variant="footnote" tone="tertiary" style={styles.quiet}>
                  A few more rankings will make these picks sharper.
                </Text>
              ) : null}
            </ScrollView>
          )}
        </>
      )}

      {filtering ? (
        <CollectionFilterSheet
          // The whole returned pool, pre-filter, so the options describe everything the
          // group could see rather than what the current narrowing left.
          items={pool.map((pick) => pick.item)}
          value={filters}
          showBuckets={false}
          onApply={(next) => {
            setFilters(next);
            setFiltering(false);
          }}
          onClose={() => setFiltering(false)}
        />
      ) : null}
    </Sheet>
  );
}

/**
 * The sheet's heading grows with the system text size only so far: at 2× on a 320pt
 * phone "Recommendations" no longer fits a line and broke mid-word (title-page sprint,
 * 2026-11-06). The cap was 1.5× of the 17pt `headline` — a 25.5pt ceiling. The heading is
 * the shared 22pt serif `title2` since 2026-11-13, so the cap is restated to hold the same
 * ceiling rather than the same ratio (1.15 × 22 ≈ 25.3pt; independent review). Still well
 * above the body text it heads.
 */
const HEADING_MAX_SCALE = 1.15;

const styles = StyleSheet.create({
  // Gives way first when the sheet's 90% runs out, so the action below always shows.
  choosing: { flexGrow: 0, flexShrink: 1 },
  members: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
  memberChip: {
    paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[1],
    borderRadius: theme.radius.full,
    backgroundColor: theme.surface.sunken,
  },
  countRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[2],
  },
  countChips: { flexDirection: 'row', gap: theme.space[2] },
  // Shrinks to the room left above the Close footer; no fixed cap (it was 520).
  list: { flexShrink: 1 },
  quiet: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[2] },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  status: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[2] },
  actions: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
});
