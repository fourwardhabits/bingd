import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '@/ui/tokens';
import { EmptyState, Poster, Text } from '@/ui/components';
import { posterUri } from '@/lib/images';

import { useSeasons, yearOf } from './use-title-search';

export type SeasonPickerProps = {
  series: { id: string; title: string } | null;
  onClose: () => void;
  onPick: (season: {
    id: string;
    title: string;
    year: number | null;
    posterPath: string | null;
  }) => void;
};

/**
 * A series cannot be logged — the season is the rankable unit and `_assert_loggable`
 * refuses the series outright (AD-1, PRD §10). That distinction is invisible in the data
 * and has to be made obvious here (screens.md §6), so tapping a series opens its seasons
 * rather than failing with an error the user did nothing to deserve.
 */
export function SeasonPicker({ series, onClose, onPick }: SeasonPickerProps) {
  const { data: seasons = [], isPending, isError } = useSeasons(series?.id ?? null);

  if (!series) return null;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <SafeAreaView style={styles.sheet} edges={['top', 'bottom', 'left', 'right']}>
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
        ) : isPending ? (
          <View style={styles.padded}>
            <Text variant="body" tone="tertiary">
              Loading seasons…
            </Text>
          </View>
        ) : seasons.length === 0 ? (
          <EmptyState
            kind="nothingYet"
            title="No seasons yet"
            body="The catalogue has this series but none of its seasons."
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
