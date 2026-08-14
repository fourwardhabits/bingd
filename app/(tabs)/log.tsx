import { FlashList } from '@shopify/flash-list';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { LogSheet, type LoggableTitle } from '@/features/collection/LogSheet';
import { SeasonPicker } from '@/features/search/SeasonPicker';
import { useTitleSearch, yearOf, type SearchResult } from '@/features/search/use-title-search';
import { theme } from '@/ui/tokens';
import { EmptyState, Field, Screen, Text, TitleRow } from '@/ui/components';

/**
 * The centre + tab. Opens directly into title search, which is why there is no separate
 * Search tab (screens.md §2). One field, results as title rows, each with a log action.
 *
 * A film opens the log sheet. A series opens its seasons first, because a series is not
 * loggable and the season is the rankable unit (AD-1) — the alternative is letting the
 * user tap something and be told no.
 */
export default function LogScreen() {
  const [input, setInput] = useState('');
  const [series, setSeries] = useState<{ id: string; title: string } | null>(null);
  const [logging, setLogging] = useState<LoggableTitle | null>(null);

  const { results, idle, isPending, isError, isPlaceholderData, refetch } = useTitleSearch(input);

  const open = (result: SearchResult) => {
    if (result.kind === 'series') {
      setSeries({ id: result.id, title: result.title });
      return;
    }

    setLogging({
      id: result.id,
      title: result.title,
      year: yearOf(result.release_date),
      posterUri: null,
      kind: result.kind === 'season' ? 'season' : 'movie',
    });
  };

  return (
    <Screen>
      <View style={styles.field}>
        <Field
          label="Search"
          placeholder="A film or a series"
          value={input}
          onChangeText={setInput}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityHint="Results appear as you type"
        />
      </View>

      <Results
        idle={idle}
        loading={isPending && !idle}
        error={isError}
        stale={isPlaceholderData}
        results={results}
        onRetry={() => void refetch()}
        onOpen={open}
      />

      <SeasonPicker
        series={series}
        onClose={() => setSeries(null)}
        onPick={(season) => {
          // The series title travels with the season, or the sheet header says "Season 3"
          // and nothing else.
          setLogging({
            id: season.id,
            title: season.title,
            year: season.year,
            posterUri: null,
            kind: 'season',
            seriesTitle: series?.title ?? null,
          });
          setSeries(null);
        }}
      />

      <LogSheet title={logging} onClose={() => setLogging(null)} />
    </Screen>
  );
}

/**
 * The three empty states are deliberately distinct (design-system.md §8): nothing typed
 * yet, nothing matched, and the request failed each read differently and offer different
 * actions. Collapsing them is the usual mistake.
 */
function Results({
  idle,
  loading,
  error,
  stale,
  results,
  onRetry,
  onOpen,
}: {
  idle: boolean;
  loading: boolean;
  error: boolean;
  stale: boolean;
  results: SearchResult[];
  onRetry: () => void;
  onOpen: (result: SearchResult) => void;
}) {
  if (idle) {
    return (
      <EmptyState
        kind="nothingYet"
        title="What did you watch?"
        body="Start typing a film or a series to log it."
      />
    );
  }

  if (error) {
    return (
      <EmptyState
        kind="couldNotLoad"
        title="Could not search"
        body="Search needs a connection. Your own collection works offline."
        action={{ label: 'Try again', onPress: onRetry }}
      />
    );
  }

  if (loading) {
    return (
      <View style={styles.status}>
        <Text variant="body" tone="tertiary">
          Searching…
        </Text>
      </View>
    );
  }

  if (results.length === 0) {
    return (
      <EmptyState
        kind="nothingMatches"
        title="Nothing matches that"
        body="The catalogue is small while it is being tested. Try a shorter search."
      />
    );
  }

  return (
    <FlashList
      data={results}
      // Stale results stay legible rather than disappearing: a list that blinks on every
      // keystroke reads as slower than one that lags a beat behind.
      style={stale ? styles.stale : undefined}
      keyExtractor={(item) => item.id}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => (
        <TitleRow
          title={item.title}
          year={yearOf(item.release_date)}
          bucketLabel={item.kind === 'series' ? 'Series · pick a season' : undefined}
          onPress={() => onOpen(item)}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  field: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[3] },
  status: { padding: theme.layout.gutter },
  stale: { opacity: 0.6 },
});
