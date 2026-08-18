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
import { meaningfulMatch, useUserSearch, type UserResult } from '@/features/search/use-user-search';
import { followLabel, noRelationship, useRelationships } from '@/features/profile/use-social';
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
  UserRow,
} from '@/ui/components';

/** All first, because the filter is a narrowing of a search the user has
 *  already made and the unnarrowed state is the one they arrive in. */
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'movies', label: 'Movies' },
  { id: 'tv', label: 'TV' },
  // Last, and after the two media filters, because Bingd is a film and television app
  // first: somebody looking for a title should never have to pass a people tab to
  // reach one (founder addendum, 2026-08-16).
  { id: 'users', label: 'Users' },
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
    retry,
    providerSearching,
    providerExhausted,
    providerRateLimited,
    providerFailed,
  } = useTitleSearch(input);

  const filtered = useMemo(() => {
    if (filter === 'all') return results;
    // The Users tab is people and nothing else. Leaving the titles in and hiding them
    // in the renderer would make every empty-state branch below wrong.
    if (filter === 'users') return [];
    return results.filter((result) =>
      filter === 'movies' ? result.kind === 'movie' : result.kind !== 'movie',
    );
  }, [results, filter]);

  const users = useUserSearch(input, profile.id, filter === 'users' ? 30 : 10);
  const userResults = useMemo(() => users.data ?? [], [users.data]);
  const relationships = useRelationships(
    useMemo(() => userResults.map((user) => user.id), [userResults]),
    profile.id,
  );

  /**
   * Who appears under **All**.
   *
   * Titles stay dominant, which the founder asked for and which this enforces twice:
   * the section is capped at three, and it holds only people whose handle or name the
   * query actually *starts*. `search_users` matches substrings, so without that gate
   * typing "the" would put three strangers above a page of films.
   *
   * Under Users there is no gate and no cap beyond the server's — everything the viewer
   * is allowed to see, which is what a dedicated tab is for. So the gate never hides
   * anybody; it only decides which tab they lead with.
   */
  const usersUnderAll = useMemo(
    () => userResults.filter((user) => meaningfulMatch(user, input)).slice(0, 3),
    [userResults, input],
  );

  const shownUsers = filter === 'users' ? userResults : filter === 'all' ? usersUnderAll : [];

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

  const openUser = (user: UserResult) => {
    commitSelection(user.name);
    router.push(`/u/${user.username}`);
  };

  /**
   * The word beside a person's name, or nothing.
   *
   * A label, never a control — the founder's row is "[avatar] Display Name / @handle /
   * follow state where appropriate", and a Follow button inside a search result is one
   * mis-tap from a relationship the user did not mean to start, which the other person
   * is notified about either way. The action lives on the profile the row opens.
   */
  const relationshipLabel = (user: UserResult) => {
    // Your own row: "Follow" against yourself is a control that cannot exist, and the
    // profile it opens is your own.
    if (user.id === profile.id) return 'You';
    const label = followLabel(relationships.data?.get(user.id) ?? noRelationship());
    // "Follow" is the *absence* of a relationship. Printing it would describe an
    // action nothing on this row performs.
    return label === 'Follow' ? null : label;
  };

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
        users={shownUsers}
        usersLoading={users.isPending && !idle}
        usersOnly={filter === 'users'}
        relationshipLabel={relationshipLabel}
        onOpenUser={openUser}
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
        onRetry={retry}
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
  users,
  usersLoading,
  usersOnly,
  relationshipLabel,
  onOpenUser,
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
  users: UserResult[];
  usersLoading: boolean;
  usersOnly: boolean;
  relationshipLabel: (user: UserResult) => string | null;
  onOpenUser: (user: UserResult) => void;
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

  /**
   * The Users tab, answered before any of the title states below.
   *
   * Every branch after this one is written about the catalogue — "Looking further
   * afield", "the wider search did not answer", "try the original title" — and all of
   * them are wrong about people. There is no provider pass for accounts and nothing to
   * be exhausted; either somebody matched or nobody did.
   */
  if (usersOnly) {
    if (usersLoading) return <SkeletonRow count={4} />;
    if (users.length === 0) {
      return (
        <EmptyState
          kind="nothingMatches"
          title="Nobody by that name"
          body="Try their exact handle. Private accounts do not appear in search."
        />
      );
    }
    return (
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {users.map((user) => (
          <UserRow
            key={user.id}
            name={user.name}
            username={user.username}
            avatarUri={user.avatarUri}
            relationship={relationshipLabel(user)}
            onPress={() => onOpenUser(user)}
          />
        ))}
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

  /**
   * People, above the titles and visibly not among them.
   *
   * A labelled section with its own divider, so a profile row is never mistaken for a
   * result in the title ranking — which is the founder's rule, and which the round
   * avatar against a rectangular poster already signals before the label is read.
   *
   * Above rather than below, because a section under a page of films is a section
   * nobody reaches, and the gate on `usersUnderAll` is what keeps it from appearing
   * when the query was plainly about a title. It renders nothing at all when empty,
   * so All looks exactly as it did before whenever nobody matched.
   */
  const people =
    users.length > 0 ? (
      <View style={styles.people}>
        <SectionHeader title="People" />
        {users.map((user) => (
          <UserRow
            key={user.id}
            name={user.name}
            username={user.username}
            avatarUri={user.avatarUri}
            relationship={relationshipLabel(user)}
            onPress={() => onOpenUser(user)}
          />
        ))}
      </View>
    ) : null;

  if (results.length === 0) {
    // Somebody matched and no title did. The title empty states below would all be
    // saying "nothing matches that" over a list that plainly has somebody in it.
    if (people) {
      return (
        <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          {people}
          <EmptyState
            kind="nothingMatches"
            compact
            title="No titles match that"
            body="Nothing in the catalogue by that name."
          />
        </ScrollView>
      );
    }

    // Several different silences, and saying the wrong one is worse than saying
    // nothing. Still looking is not the same as having looked and found nothing;
    // being rate limited is not a statement about the catalogue at all; and a
    // filter hiding every row is not a failed search.
    if (filtered) {
      return (
        <EmptyState
          kind="nothingMatches"
          title="Nothing in this filter"
          body="There are results, just not of this kind. Try All."
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
    // The People section is a *sibling* of the list, not its header. That is the
    // founder's "never intermix profile rows into the title ranking" expressed
    // structurally: a header row inside a FlashList is still an item in the list that
    // ranks titles, and the next person to add sticky headers or a section index would
    // find people in it.
    <View style={styles.list}>
      {people}
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
        ) : providerFailed ? (
          /**
           * A partial list has to say it is partial.
           *
           * This message used to appear only when the list was *empty*, which meant
           * the one case it most needed to cover was the one it missed: rows found
           * locally, wider search refused, and a user reading a short list as the
           * whole answer. That is the founder's `spiderman` failure wearing a
           * different hat — the catalogue looking complete when it is not — so
           * fixing the gate without fixing this would have left the same silence
           * one step further along.
           */
          <View style={styles.status}>
            <Text variant="footnote" tone="secondary">
              {rateLimited
                ? 'Too many searches to look wider just now. These are from your catalogue only.'
                : 'The wider search did not answer, so this may not be everything.'}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Search wider again"
              onPress={onRetry}
              hitSlop={theme.space[2]}
            >
              <Text variant="callout" tone="action">
                Try again
              </Text>
            </Pressable>
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
    </View>
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
  // A rule under the section, so the boundary between people and titles is drawn
  // rather than implied by spacing alone.
  people: {
    paddingBottom: theme.space[2],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  list: { flex: 1 },
  status: { padding: theme.layout.gutter, gap: theme.space[2], alignItems: 'flex-start' },
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
