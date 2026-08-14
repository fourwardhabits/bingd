import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { useLoggedCollection } from '@/features/collection/use-collection';
import { LogSheet, type LoggableTitle } from '@/features/collection/LogSheet';
import { RankingSheet } from '@/features/ranking/RankingSheet';
import { SeasonPicker } from '@/features/search/SeasonPicker';
import { useTitleSearch, yearOf, type SearchResult } from '@/features/search/use-title-search';
import { posterUri } from '@/lib/images';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  EmptyState,
  Screen,
  SearchField,
  Text,
  TitleMetadata,
  TitleRow,
  type BucketId,
} from '@/ui/components';

/**
 * The centre + tab. Opens directly into title search, which is why there is no separate
 * Search tab (screens.md §2). One field, results as title rows, each with a log action.
 *
 * A film opens the log sheet. A series opens its seasons first, because a series is not
 * loggable and the season is the rankable unit (AD-1) — the alternative is letting the
 * user tap something and be told no.
 */
export default function LogScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const { data: watched } = useLoggedCollection(profile.id);
  const [input, setInput] = useState('');
  const [series, setSeries] = useState<{ id: string; title: string } | null>(null);
  const [logging, setLogging] = useState<LoggableTitle | null>(null);
  const [ranking, setRanking] = useState<{
    id: string;
    title: string;
    bucket: BucketId;
    posterUri: string | null;
  } | null>(null);

  const { results, idle, isPending, isError, isPlaceholderData, refetch } = useTitleSearch(input);

  const openLog = (result: SearchResult) => {
    if (result.kind === 'series') {
      setSeries({ id: result.id, title: result.title });
      return;
    }

    setLogging({
      id: result.id,
      title: result.title,
      year: yearOf(result.release_date),
      posterUri: posterUri(result.poster_path, 'card'),
      kind: result.kind === 'season' ? 'season' : 'movie',
    });
  };

  return (
    <Screen>
      <AppHeader />
      <View style={styles.field}>
        <SearchField
          accessibilityLabel="Search"
          placeholder="A film or a series"
          value={input}
          onChangeText={setInput}
          onClear={() => setInput('')}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityHint="Results appear as you type"
        />
      </View>

      <Results
        idle={idle}
        loading={isPending && !idle}
        error={isError}
        stale={isPlaceholderData}
        results={results}
        watched={watched?.entries ?? []}
        onRetry={() => void refetch()}
        onOpenTitle={(result) => router.push(`/title/${result.id}`)}
        onOpenLog={openLog}
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
            posterUri: posterUri(season.posterPath, 'card'),
            kind: 'season',
            seriesTitle: series?.title ?? null,
          });
          setSeries(null);
        }}
      />

      <LogSheet
        title={logging}
        onClose={() => setLogging(null)}
        onFindWhereItLands={(bucket) => {
          if (!logging) return;
          // The log sheet closes as the comparison opens. screens.md §4 asks for one
          // continuous motion, and two stacked sheets is the opposite of that.
          setRanking({
            id: logging.id,
            title: logging.title,
            bucket,
            posterUri: logging.posterUri,
          });
          setLogging(null);
        }}
      />

      <RankingSheet
        subject={ranking}
        onClose={() => setRanking(null)}
        onRankAnother={() => setInput('')}
      />
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
  watched,
  onRetry,
  onOpenTitle,
  onOpenLog,
}: {
  idle: boolean;
  loading: boolean;
  error: boolean;
  stale: boolean;
  results: SearchResult[];
  watched: { mediaItemId: string; title: string }[];
  onRetry: () => void;
  onOpenTitle: (result: SearchResult) => void;
  onOpenLog: (result: SearchResult) => void;
}) {
  if (idle) {
    return (
      <View style={styles.idle}>
        <EmptyState
          kind="nothingYet"
          compact
          title="What did you watch?"
          body="Search for a title, open it, then log it with +."
        />
        {watched.length > 0 ? (
          <View style={styles.recent}>
            <Text variant="caption" tone="tertiary">
              RECENTLY WATCHED
            </Text>
            {watched.slice(0, 3).map((entry, index) => (
              <Text key={`${entry.mediaItemId}-${index}`} variant="footnote" tone="secondary" numberOfLines={1}>
                {entry.title}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
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
      keyboardDismissMode="on-drag"
      contentContainerStyle={styles.results}
      renderItem={({ item }) => (
        <TitleRow
          title={item.title}
          year={yearOf(item.release_date)}
          posterUri={posterUri(item.poster_path)}
          size="xs"
          secondary={
            item.kind === 'series' ? (
              `Series · ${item.season_count ?? 0} seasons`
            ) : (
              <TitleMetadata
                runtimeMinutes={item.runtime_minutes}
                genres={item.genres}
                showYear={false}
              />
            )
          }
          trailing={
            <Pressable
              accessibilityLabel={`Log ${item.title}`}
              onPress={() => onOpenLog(item)}
              hitSlop={theme.space[2]}
            >
              <Ionicons name="add-circle" size={theme.layout.icon.lg} color={theme.semantic.action} />
            </Pressable>
          }
          onPress={() => onOpenTitle(item)}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  field: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  status: { padding: theme.layout.gutter },
  stale: { opacity: 0.6 },
  idle: { gap: theme.space[3], paddingTop: theme.space[4] },
  recent: { paddingHorizontal: theme.layout.gutter, gap: theme.space[1] },
  results: { paddingBottom: theme.space[8] },
});
