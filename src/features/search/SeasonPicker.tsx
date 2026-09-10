import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { seasonListIsStale, useSeasonEnrichment } from '@/features/title/use-enrichment';
import { theme } from '@/ui/tokens';
import { EmptyState, Poster, Text } from '@/ui/components';
import { posterUri } from '@/lib/images';

import { useSeasons, yearOf } from './use-title-search';

/** A dismissing sheet answers nothing. */
const noopClose = () => {};

export type SeasonPickerProps = {
  series: { id: string; title: string } | null;
  onClose: () => void;
  onPick: (season: {
    id: string;
    title: string;
    year: number | null;
    posterPath: string | null;
    /** Travels with the season so the log sheet can head itself "The Last of Us, S1". */
    seasonNumber: number;
  }) => void;
  /**
   * Whether the picker is presented, as distinct from whether it is mounted.
   *
   * Defaults to `true`. A caller that hands straight over to another sheet sets it false
   * and waits for `onDismissed`, so UIKit is never asked to present over a dismissal —
   * see `useSheetHandoff`. This one is a bare `<Modal presentationStyle="pageSheet">`
   * rather than a `Sheet`, and a page sheet's dismissal is the *longest* in the app.
   */
  visible?: boolean;
  /** iOS has finished dismissing. The next presentation is safe now. */
  onDismissed?: () => void;
};

/**
 * A series cannot be logged — the season is the rankable unit and `_assert_loggable`
 * refuses the series outright (AD-1, PRD §10). That distinction is invisible in the data
 * and has to be made obvious here (screens.md §6), so tapping a series opens its seasons
 * rather than failing with an error the user did nothing to deserve.
 */
export function SeasonPicker({
  series,
  onClose,
  onPick,
  visible = true,
  onDismissed,
}: SeasonPickerProps) {
  const { data: seasons = [], isPending, isError, isFetched } = useSeasons(series?.id ?? null);

  // A series found through search has no season rows yet, and this is the first
  // moment they are needed. `isFetched` matters: without it the empty array that
  // exists before the first read looks identical to a series with no seasons.
  //
  // The third argument is the 2026-08-30 correction: a list written once and never
  // revisited leaves a series permanently short of any season published since. See
  // `seasonListIsStale`.
  const { enriching } = useSeasonEnrichment(
    series?.id ?? null,
    isFetched && seasons.length === 0,
    isFetched && seasonListIsStale(seasons),
  );

  if (!series) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      /**
       * Inert while dismissing, and the dismissal is reported.
       *
       * This hands straight over to the log sheet, and doing that by unmounting a
       * presented `<Modal>` is the freeze audited on 2026-09-10 — with the longest
       * dismissal in the app behind it, because a page sheet slides the full height.
       * See `useSheetHandoff`.
       */
      onRequestClose={visible ? onClose : noopClose}
      onDismiss={onDismissed}
      accessibilityViewIsModal
    >
      {/* Nothing in a dismissing sheet answers. iOS keeps these children mounted for the
          whole slide-out, so Close and every season row stay live otherwise — and a tap
          on one unmounts this Modal mid-dismissal, which is the operation the handoff
          exists to avoid. Sheet states the same rule for every other sheet in the app;
          this one is a bare Modal and needs its own. */}
      <SafeAreaView
        pointerEvents={visible ? 'auto' : 'none'}
        style={styles.sheet}
        edges={['top', 'bottom', 'left', 'right']}
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text variant="title2" numberOfLines={2}>
              {series.title}
            </Text>
            <Text variant="footnote" tone="tertiary">
              Seasons are ranked separately, so pick the one you watched.
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            hitSlop={theme.space[3]}
          >
            <Text variant="headline" tone="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        {isError ? (
          <EmptyState
            kind="couldNotLoad"
            title="Could not load seasons"
            body="Check your connection and try again."
          />
        ) : isPending || enriching ? (
          <View style={styles.padded}>
            <Text variant="body" tone="tertiary">
              Loading seasons…
            </Text>
          </View>
        ) : seasons.length === 0 ? (
          <EmptyState
            kind="nothingYet"
            title="No seasons listed"
            body="This series has no seasons on record yet. Try again later."
          />
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            {seasons.map((season) => (
              <Pressable
                key={season.id}
                accessibilityRole="button"
                accessibilityLabel={`${season.title}${
                  season.release_date ? `, ${yearOf(season.release_date)}` : ''
                }`}
                onPress={() =>
                  onPick({
                    id: season.id,
                    title: season.title,
                    year: yearOf(season.release_date),
                    posterPath: season.poster_path,
                    seasonNumber: season.season_number,
                  })
                }
                style={styles.row}
              >
                <Poster uri={posterUri(season.poster_path)} title={season.title} size="xs" />
                <View style={styles.rowText}>
                  <Text variant="headline">{season.title}</Text>
                  {season.release_date ? (
                    <Text variant="footnote" tone="tertiary">
                      {yearOf(season.release_date)}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: theme.surface.base },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space[3],
    padding: theme.layout.gutter,
  },
  headerText: { flex: 1, gap: theme.space[1] },
  padded: { padding: theme.layout.gutter },
  list: { paddingBottom: theme.space[8] },
  row: {
    minHeight: theme.layout.rowMinHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingVertical: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
  },
  rowText: { flex: 1, gap: theme.space[1] },
});
