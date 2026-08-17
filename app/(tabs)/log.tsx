import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { LogSheet, type LoggableTitle } from '@/features/collection/LogSheet';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { SeasonPicker } from '@/features/search/SeasonPicker';
import { useRecentSearches } from '@/features/search/use-recent-searches';
import { useTitleSearch, yearOf, type SearchResult } from '@/features/search/use-title-search';
import { posterUri } from '@/lib/images';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  HeaderBoundary,
  Chip,
  EmptyState,
  Screen,
  SearchField,
  SectionHeader,
  SkeletonRow,
  Text,
  TitleMetadata,
  TitleRow,
} from '@/ui/components';

/** All first, because the filter is a narrowing of a search the user has
 *  already made and the unnarrowed state is the one they arrive in. */
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'movies', label: 'Movies' },
  { id: 'tv', label: 'TV' },
] as const;

type Filter = (typeof FILTERS)[number]['id'];

/**
 * The centre + tab. Opens directly into title search, which is why there is no separate
 * Search tab (screens.md §2). One field, results as compact rows, each with a log action.
 *
 * A film opens the log sheet. A series opens its seasons first, because a series is not
 * loggable and the season is the rankable unit (AD-1) — the alternative is letting the
 * user tap something and be told no.
 */
export default function LogScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [series, setSeries] = useState<{ id: string; title: string } | null>(null);
  const [logging, setLogging] = useState<LoggableTitle | null>(null);
  const [ranking, setRanking] = useState<RankingSubject | null>(null);

  const { recent, remember, clear } = useRecentSearches(profile.id);

  const {
    results,
    idle,
    isPending,
    isError,
    isPlaceholderData,
    refetch,
    providerSearching,
    providerExhausted,
    providerRateLimited,
    providerFailed,
  } = useTitleSearch(input);

  const filtered = useMemo(() => {
    if (filter === 'all') return results;
    return results.filter((result) =>
      filter === 'movies' ? result.kind === 'movie' : result.kind !== 'movie',
    );
  }, [results, filter]);

  /**
   * History is written on commitment, never on typing.
   *
   * The two commitments are submitting the field and choosing a result; nothing else
   * writes. This used to record whatever the debounced field held whenever that query
   * returned rows, and since every prefix of a real title returns rows, the history
   * filled with the keystrokes on the way to one search — `100%`, `100% l`, `100% lo`.
   * A prefix is not a search someone made, it is a search they were interrupted in the
   * middle of, and offering it back is offering back the interruption.
   *
   * Choosing a result records the *title*, not the query that found it. The stored
   * strings are re-run as searches rather than restored from a cache, so a title is a
   * query that finds itself, and it is the thing the person was actually looking for —
   * "spiderman" is what they could remember, "Spider-Man: Brand New Day" is what they
   * meant.
   */
  const commitSelection = (title: string) => remember(title);

  const openTitle = (result: SearchResult) => {
    commitSelection(result.title);
    router.push(`/title/${result.id}`);
  };

  const openLog = (result: SearchResult) => {
    commitSelection(result.title);

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
      {/* The brand header ends here. Everything below is body — the search field
          included, which is where the founder placed it: it is the first thing you
          act on, not part of the persistent chrome. */}
      <HeaderBoundary />
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
          onSubmitEditing={() => remember(input)}
          accessibilityHint="Results appear as you type"
        />
      </View>

      {/* Hidden while idle. A filter over nothing is three buttons that do
          nothing, and the recent searches below are not filterable by kind. */}
      {idle ? null : (
        <View style={styles.filters}>
          {FILTERS.map((option) => (
            <Chip
              key={option.id}
              label={option.label}
              selected={filter === option.id}
              onPress={() => setFilter(option.id)}
            />
          ))}
        </View>
      )}

      <Results
        idle={idle}
        loading={isPending && !idle}
        error={isError}
        stale={isPlaceholderData}
        results={filtered}
        filtered={filter !== 'all' && results.length > 0 && filtered.length === 0}
        recent={recent}
        onClearRecent={clear}
        onPickRecent={setInput}
        searchingWider={providerSearching}
        exhausted={providerExhausted}
        rateLimited={providerRateLimited}
        providerFailed={providerFailed}
        onRetry={() => void refetch()}
        onOpenTitle={openTitle}
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
        onRank={(bucket, mode) => {
          if (!logging) return;
          // The log sheet closes as the comparison opens. screens.md §4 asks for one
          // continuous motion, and two stacked sheets is the opposite of that.
          setRanking({
            id: logging.id,
            title: logging.title,
            bucket,
            posterUri: logging.posterUri,
            mode,
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
 * The empty states are deliberately distinct (design-system.md §8): nothing typed
 * yet, nothing matched, the filter hid everything, and the request failed each read
 * differently and offer different actions. Collapsing them is the usual mistake.
 */
function Results({
  idle,
  loading,
  error,
  stale,
  results,
  filtered,
  recent,
  onClearRecent,
  onPickRecent,
  searchingWider,
  exhausted,
  rateLimited,
  providerFailed,
  onRetry,
  onOpenTitle,
  onOpenLog,
}: {
  idle: boolean;
  loading: boolean;
  error: boolean;
  stale: boolean;
  results: SearchResult[];
  filtered: boolean;
  recent: string[];
  onClearRecent: () => void;
  onPickRecent: (query: string) => void;
  searchingWider: boolean;
  exhausted: boolean;
  rateLimited: boolean;
  providerFailed: boolean;
  onRetry: () => void;
  onOpenTitle: (result: SearchResult) => void;
  onOpenLog: (result: SearchResult) => void;
}) {
  if (idle) {
    return (
      <ScrollView
        contentContainerStyle={styles.idle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {recent.length > 0 ? (
          <>
            <SectionHeader title="Recent searches" actionLabel="Clear" onPressAction={onClearRecent} />
            {recent.map((query) => (
              <Pressable
                key={query}
                accessibilityRole="button"
                accessibilityLabel={`Search again for ${query}`}
                onPress={() => onPickRecent(query)}
                style={({ pressed }) => [styles.recentRow, pressed && styles.pressed]}
              >
                <Ionicons
                  name="time-outline"
                  size={theme.layout.icon.md}
                  color={theme.text.tertiary}
                />
                <Text variant="body" numberOfLines={1} style={styles.recentText}>
                  {query}
                </Text>
                <Ionicons
                  name="arrow-up-outline"
                  size={theme.layout.icon.sm}
                  color={theme.text.tertiary}
                  style={styles.recentArrow}
                />
              </Pressable>
            ))}
          </>
        ) : (
          <EmptyState
            kind="nothingYet"
            compact
            title="What did you watch?"
            body="Search for a title, open it, then log it with +."
          />
        )}
      </ScrollView>
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

  if (loading) return <SkeletonRow count={6} />;

  if (results.length === 0) {
    // Several different silences, and saying the wrong one is worse than saying
    // nothing. Still looking is not the same as having looked and found nothing;
    // being rate limited is not a statement about the catalogue at all; and a
    // filter hiding every row is not a failed search.
    if (filtered) {
      return (
        <EmptyState
          kind="nothingMatches"
          title="Nothing in this filter"
          body="There are results — just not of this kind. Try All."
        />
      );
    }

    if (searchingWider) {
      return (
        <View style={styles.status}>
          <Text variant="body" tone="tertiary">
            Looking further afield…
          </Text>
        </View>
      );
    }

    return (
      <EmptyState
        kind={providerFailed && !rateLimited ? 'couldNotLoad' : 'nothingMatches'}
        title={
          rateLimited
            ? 'Too many searches'
            : providerFailed
              ? 'Could not search wider'
              : 'Nothing matches that'
        }
        body={
          rateLimited
            ? 'Give it a minute and try again.'
            : providerFailed
              ? // Not "nothing matches". The catalogue was searched and the
                // wider lookup broke, so the app does not actually know whether
                // this title exists.
                'Your catalogue has nothing, and the wider search did not answer.'
              : exhausted
                ? 'Check the spelling, or try the original title.'
                : 'Try a shorter search.'
        }
        action={providerFailed && !rateLimited ? { label: 'Try again', onPress: onRetry } : undefined}
      />
    );
  }

  return (
    <FlashList
      data={results}
      // The wider search runs after the local one and adds to it, so its progress is
      // a footer rather than a state: the rows already found stay put and usable.
      ListFooterComponent={
        searchingWider ? (
          <View style={styles.status}>
            <Text variant="footnote" tone="tertiary">
              Looking further afield…
            </Text>
          </View>
        ) : null
      }
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
          secondary={
            item.kind === 'series' ? (
              // No count for a series the catalogue has only just met: its seasons
              // are fetched when the picker opens, and "0 seasons" would be the app
              // stating as fact something it has not looked up yet.
              item.season_count ? (
                `Series · ${item.season_count} seasons`
              ) : (
                'Series'
              )
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
  filters: {
    flexDirection: 'row',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[2],
  },
  status: { padding: theme.layout.gutter },
  stale: { opacity: 0.6 },
  idle: { paddingTop: theme.space[2], paddingBottom: theme.space[8] },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.layout.gutter,
  },
  recentText: { flex: 1 },
  recentArrow: { transform: [{ rotate: '-45deg' }] },
  pressed: { opacity: 0.6 },
  results: { paddingBottom: theme.space[8] },
});
