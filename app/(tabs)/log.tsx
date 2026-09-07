import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { useCelebrationHandoff } from '@/features/awards/celebration-queue';
import { LogSheet, type LoggableTitle, type PostRank } from '@/features/collection/LogSheet';
import { useLoggedCollection, useWatchlist } from '@/features/collection/use-collection';
import { useMyScores, type MyScore } from '@/features/collection/use-score';
import { invalidateAfterWatchlistChange } from '@/features/collection/invalidate';
import { mustReconcile, newOperationId, setWatchlist } from '@/features/collection/writes';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { SeasonPicker } from '@/features/search/SeasonPicker';
import { useRecentSearches } from '@/features/search/use-recent-searches';
import { useTitleSearch, yearOf, type SearchResult } from '@/features/search/use-title-search';
import {
  meaningfulMatch,
  useUserSearch,
  type UserResult,
} from '@/features/search/use-user-search';
import { followLabel, noRelationship, useRelationships } from '@/features/profile/use-social';
import { track } from '@/lib/analytics';
import { posterUri } from '@/lib/images';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  HeaderBoundary,
  Chip,
  EmptyState,
  Screen,
  ScoreBadge,
  SearchField,
  SectionHeader,
  SkeletonRow,
  Text,
  TitleMetadata,
  TitleRow,
  UserRow,
} from '@/ui/components';

/**
 * All first, because the filter is a narrowing of a search the user has already made
 * and the unnarrowed state is the one they arrive in.
 *
 * **One list, four chips.** The founder's contract for this page is: query → one
 * continuous list → chips narrow it. There is no "People" heading and no "Movies"
 * heading — sectioning People while leaving titles unsectioned was the inconsistency
 * this replaced. Each chip is the same surface narrowed: Movies and TV filter the
 * title results, People shows every member match with the relevance gate lifted —
 * choosing People *is* the statement of intent the gate exists to infer. All keeps
 * the existing order of each source: people above titles, each in its own relevance
 * order. A row says what kind of thing it is (round avatar and @handle for a person,
 * poster and metadata for a title) rather than a heading saying it for a block.
 */
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'movies', label: 'Movies' },
  { id: 'tv', label: 'TV' },
  { id: 'people', label: 'People' },
] as const;

/**
 * How many members show before See all.
 *
 * Three, because Bingd is a film and television app first and a page of strangers above
 * a page of films is the wrong answer to "spiderman" (founder addendum, 2026-08-16).
 * See all lifts it to the server's own ceiling rather than routing anywhere.
 */
const MEMBER_PREVIEW = 3;

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
  // Reset by every new query below: See all is about the results on screen, and keeping
  // it open across searches would silently widen the next one.
  const [allMembers, setAllMembers] = useState(false);
  const [series, setSeries] = useState<{ id: string; title: string } | null>(null);
  const [logging, setLogging] = useState<LoggableTitle | null>(null);
  const [ranking, setRanking] = useState<RankingSubject | null>(null);
  /**
   * What a finished ranking scored, held only while the log sheet is showing it.
   *
   * Kept beside `logging` rather than inside it: it is a fact about a session that has
   * ended, not about the title, and folding it into `LoggableTitle` would put it on
   * every other caller of that type for nothing.
   */
  const [placement, setPlacement] = useState<PostRank | null>(null);
  // The title the open ranking is about, kept because `logging` is cleared at the
  // handoff and the post-rank sheet needs the same `LoggableTitle` back.
  const [ranked, setRanked] = useState<LoggableTitle | null>(null);
  /** Which title's watchlist write is in flight, or null. Draws the disabled control. */
  const [watchlistBusy, setWatchlistBusy] = useState<string | null>(null);
  /** The same fact, written synchronously, which is what makes it a guard. See below. */
  const watchlistInFlight = useRef<string | null>(null);

  const queryClient = useQueryClient();
  /** Drains the post-ranking celebration queue when the log flow ends. */
  const celebrate = useCelebrationHandoff();

  /**
   * The reader's own watchlist, read through the same hook the Feed and For You read it
   * through — so the bookmark on a Search row and the bookmark on a Feed row are drawing
   * the same set, and saving on one screen fills in the other.
   */
  const watchlist = useWatchlist(profile.id);
  const saved = useMemo(
    () => new Set((watchlist.data ?? []).map((entry) => entry.mediaItemId)),
    [watchlist.data],
  );

  /**
   * The reader's own ranking state, which is what a search row now leads with.
   *
   * Two reads, both already cached app-wide by the time anybody reaches Search from an
   * ordinary session: `useMyScores` keys on `['my-scores', id]` and `useLoggedCollection`
   * on the collection key the Collection tab and For You both populate. Neither carries
   * artwork — a search row needs a number and a yes/no, not a second copy of the
   * collection.
   *
   * `watched` is *logged*, ranked or not. The difference between the two sets is exactly
   * the watched-but-unranked state, which is the one the dashed `Rank` badge is for.
   */
  const myScores = useMyScores(profile.id);
  const logged = useLoggedCollection(profile.id);
  const scores = useMemo(() => myScores.data ?? new Map<string, MyScore>(), [myScores.data]);
  const watchedIds = useMemo(
    () => new Set((logged.data?.entries ?? []).map((entry) => entry.mediaItemId)),
    [logged.data],
  );

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
    // People is not a narrowing of titles — the list holds member rows alone, so the
    // title results are simply absent rather than "filtered to nothing".
    if (filter === 'people') return [];
    return results.filter((result) =>
      filter === 'movies' ? result.kind === 'movie' : result.kind !== 'movie',
    );
  }, [results, filter]);

  // Always the server's ceiling. The cap that matters is a display one, applied below,
  // and asking for ten and then for thirty when See all is pressed would make the
  // expansion a second round trip that can fail.
  const users = useUserSearch(input, profile.id, 30);
  const userResults = useMemo(() => users.data ?? [], [users.data]);
  const relationships = useRelationships(
    useMemo(() => userResults.map((user) => user.id), [userResults]),
    profile.id,
  );

  /**
   * Which members appear, and how many.
   *
   * Titles stay dominant, which the founder asked for and which the gate enforces:
   * `meaningfulMatch` keeps the person rows to people whose handle or name the query
   * actually *starts*, because `search_users` matches substrings and without it typing
   * "the" would put three strangers above a page of films.
   *
   * **See all lifts the display cap, not the gate**, and it is deliberately not a route.
   * Everything it reveals is already in hand — the query asked for the server's ceiling
   * — so the expansion cannot fail, cannot spend a round trip, and cannot land somebody
   * on a screen with its own empty state.
   *
   * A query opening with `@` passes the gate outright (`memberQuery`): somebody typing
   * a handle sigil is naming a person, and the gate exists for queries that were plainly
   * about a title.
   */
  const matchedMembers = useMemo(
    () => userResults.filter((user) => meaningfulMatch(user, input)),
    [userResults, input],
  );

  // Members are not titles, so a Movies or TV narrowing has nothing to say about them.
  // The People chip shows them alone: every match the server returned, no relevance
  // gate and no preview cap — the chip press is the intent the gate would be guessing.
  const peopleMode = filter === 'people';
  const membersApply = filter === 'all';
  const shownUsers = peopleMode
    ? userResults
    : membersApply
      ? allMembers
        ? matchedMembers
        : matchedMembers.slice(0, MEMBER_PREVIEW)
      : [];
  // How many people the See-all row promises — the *total* matched, because the row
  // names what pressing it reveals, not what is currently hidden. Zero means no row.
  const morePeopleCount =
    membersApply && !allMembers && matchedMembers.length > MEMBER_PREVIEW
      ? matchedMembers.length
      : 0;

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
    /**
     * `member_search_result_opened`.
     *
     * The position in the list and nothing else. **Not the query, not the handle, not
     * the display name** — what somebody typed into a search box is exactly the kind of
     * free text this app's analytics refuses to carry (`lib/analytics.ts`), and the
     * question the beta actually has is whether member search gets used at all and
     * whether people take the first result or scroll.
     *
     * One-based, so a chart's "1" means the top row rather than an index.
     */
    track({
      name: 'member_search_result_opened',
      props: { surface: 'search', position: shownUsers.indexOf(user) + 1 },
    });
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
    // Your own row. `search_users` stopped returning it at `20260819000100`, so this is
    // a floor rather than a branch anybody reaches — kept because "Follow" against
    // yourself is a control that cannot exist, and a server that changed its mind
    // should not be able to draw one.
    if (user.id === profile.id) return 'You';

    const label = followLabel(relationships.data?.get(user.id) ?? noRelationship());
    // "Follow" is the *absence* of a relationship. Printing it would describe an action
    // nothing on this row performs — the action lives on the profile the row opens.
    if (label !== 'Follow') return label;

    /**
     * **Private, where there is nothing else to say.**
     *
     * `20260819000100` made private accounts findable, and a row that looks identical
     * to a public one sets up a surprise: the tap leads to a locked profile and the
     * Follow becomes a request somebody has to answer. Saying so on the row is the
     * difference between a considered ask and an accidental one.
     *
     * Only when there is no relationship to name. "Following" is the more useful word
     * for an account already approved, and it already implies the rest.
     */
    return user.visibility === 'private' ? 'Private' : null;
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

  /**
   * **Search is a capture surface, not only a lookup one** (founder, 2026-09-06).
   *
   * The job is somebody seeing a film named on Instagram, opening bingd., searching it,
   * saving it and leaving. That was Search → title detail → find the bookmark → back
   * out; it is now one tap on the row.
   *
   * **The canonical path, and deliberately not a Search-shaped copy of it.** This is the
   * same `setWatchlist` RPC, the same `newOperationId`, the same `mustReconcile`
   * reconciliation and the same `invalidateAfterWatchlistChange` the Feed, For You,
   * Group Picks and the person page all use — so a title saved from here is a title
   * saved, with the same server-side consequences. `set_watchlist` writes the
   * `watchlist_added` feed event, so a save from Search is as visible to the reader's
   * followers as a save from anywhere else. Suppressing that because the tap happened on
   * a different screen would be a second product rule nobody asked for.
   *
   * `surface: 'search'` is the one thing that differs, and it is a label on an analytics
   * event rather than a difference in behaviour. It was already in the `Surface` union.
   */
  const toggleWatchlist = async (result: SearchResult) => {
    /**
     * One write in flight at a time, and the guard is a **ref** rather than the state
     * below it.
     *
     * The state is what draws the disabled control, and it cannot be the guard: two taps
     * inside one tick both read the same render's `watchlistBusy`, both see null, and
     * both spend an operation id on one intent. React has not re-rendered in between and
     * `disabled` has not taken effect either. A ref is written synchronously, so the
     * second tap sees the first.
     *
     * The Feed's toggle has the state-only version and is fine in practice, because
     * nothing there is as tappable as a row you are already looking at while deciding.
     * This is the surface built for speed, so it gets the guard that actually holds.
     */
    if (watchlistInFlight.current) return;
    watchlistInFlight.current = result.id;
    setWatchlistBusy(result.id);

    const present = !saved.has(result.id);
    const outcome = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId: result.id,
      present,
    });
    watchlistInFlight.current = null;
    setWatchlistBusy(null);

    // Additions only, and only on `ok` — the Feed's rule, verbatim. `already_applied` is
    // one intent replayed rather than a second save.
    if (present && outcome.outcome === 'ok') {
      track({ name: 'watchlist_added', props: { surface: 'search' } });
    }

    // Reconciled before the error is shown, not instead of it: `set_watchlist` can commit
    // and lose its reply, and the client cannot tell that from a refusal. See the same
    // comment on the Feed's toggle for the review that established this.
    if (mustReconcile(outcome)) {
      invalidateAfterWatchlistChange(queryClient, profile.id);
    }

    if (outcome.outcome === 'failed') {
      Alert.alert('Could not update watchlist', outcome.message);
    }
  };

  return (
    <Screen>
      {/* Brand row, then the field on a row of its own — the same second-row
          position the category selector holds on For You and Collection. The
          previous compaction put the field beside the lockup, which crowded the
          brand row; the founder's correction is the cross-tab header rhythm:
          row one is who you are looking at, row two is what you do here. */}
      <AppHeader />
      <View style={styles.searchRow}>
        <SearchField
          accessibilityLabel="Search"
          // Names both halves, because the second was invisible while it sat behind
          // a chip. "@handle" rather than "a member" so the sigil is discoverable.
          placeholder="A film, a series, or @someone"
          value={input}
          onChangeText={(next) => {
            setInput(next);
            setAllMembers(false);
          }}
          onClear={() => {
            setInput('');
            setAllMembers(false);
          }}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={() => remember(input)}
          accessibilityHint="Results appear as you type"
        />
      </View>
      <HeaderBoundary />

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
        peopleOnly={peopleMode}
        users={shownUsers}
        usersLoading={users.isPending && !idle}
        usersError={users.isError}
        morePeopleCount={morePeopleCount}
        onSeeAllMembers={() => setAllMembers(true)}
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
        saved={saved}
        scores={scores}
        watched={watchedIds}
        watchlistBusy={watchlistBusy}
        onToggleWatchlist={toggleWatchlist}
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
            seasonNumber: season.seasonNumber,
          });
          setSeries(null);
        }}
      />

      <LogSheet
        title={logging}
        /* Both exits end the post-ranking flow, so both drain the celebration queue —
           see the same pair on the title screen. Empty queue, nothing happens. */
        onClose={() => {
          setLogging(null);
          setPlacement(null);
          celebrate();
        }}
        surface="search"
        postRank={placement}
        onDone={() => {
          setLogging(null);
          setPlacement(null);
          celebrate();
        }}
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
          setRanked(logging);
          setLogging(null);
        }}
      />

      <RankingSheet
        subject={ranking}
        onClose={() => setRanking(null)}
        // Back into the sheet the ranking came out of, on the title it was about.
        // `ranked` is that title held across the handoff — `logging` was cleared when the
        // comparison opened, because two stacked sheets is what screens.md §4 forbids.
        onFinishLog={(result) => {
          setRanking(null);
          if (!ranked) return;
          setPlacement(result);
          setLogging(ranked);
        }}
        surface="search"
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
  peopleOnly,
  users,
  usersLoading,
  usersError,
  morePeopleCount,
  onSeeAllMembers,
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
  saved,
  scores,
  watched,
  watchlistBusy,
  onToggleWatchlist,
}: {
  idle: boolean;
  peopleOnly: boolean;
  users: UserResult[];
  usersLoading: boolean;
  usersError: boolean;
  morePeopleCount: number;
  onSeeAllMembers: () => void;
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
  /** Media ids on the reader's watchlist, from the canonical `useWatchlist`. */
  saved: Set<string>;
  /** Every score this reader has given, by media id (`useMyScores`). */
  scores: Map<string, MyScore>;
  /** Media ids this reader has logged, ranked or not — the watched-but-unranked case. */
  watched: Set<string>;
  /** The id of the title whose watchlist write is in flight, or null. */
  watchlistBusy: string | null;
  onToggleWatchlist: (result: SearchResult) => void;
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
            <SectionHeader
              title="Recent searches"
              actionLabel="Clear"
              onPressAction={onClearRecent}
            />
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
   * The People chip: the list is member rows alone. Title-search states — its error,
   * its loading, its footers — have nothing to say here, so the empty branches come
   * before them and speak only about the member read. When somebody *did* match, the
   * chip falls through to the same list every other chip renders.
   */
  if (peopleOnly && users.length === 0) {
    if (usersLoading) return <SkeletonRow count={6} />;
    if (usersError) {
      return (
        <EmptyState
          kind="couldNotLoad"
          title="Could not search"
          body="Search needs a connection. Your own collection works offline."
        />
      );
    }
    return (
      <EmptyState
        kind="nothingMatches"
        title="Nobody by that name"
        body="Search a display name or an @handle."
      />
    );
  }

  // A title error owns the page only when there is nothing else on it. With people
  // in hand the list stays — dropping rows the reader can act on because a *different*
  // query failed is the review-61 finding — and the failure becomes a footer below
  // them, in the same place the wider-search failure already reports.
  if (!peopleOnly && error && users.length === 0) {
    return (
      <EmptyState
        kind="couldNotLoad"
        title="Could not search"
        body="Search needs a connection. Your own collection works offline."
        action={{ label: 'Try again', onPress: onRetry }}
      />
    );
  }

  if (!peopleOnly && loading && users.length === 0) return <SkeletonRow count={6} />;

  if (!peopleOnly && results.length === 0 && users.length === 0) {
    // Nobody matched either, and the member read is still in flight. Saying "nothing
    // matches that" now would be a claim about a question still being asked.
    if (usersLoading) return <SkeletonRow count={6} />;

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
        action={
          providerFailed && !rateLimited ? { label: 'Try again', onPress: onRetry } : undefined
        }
      />
    );
  }

  /**
   * One continuous list — the founder's contract, stated structurally: query → one
   * list → chips narrow it. People first, in the server's own order, then titles in
   * theirs — the smallest deterministic merge, and the order the old sectioned layout
   * already produced. No heading introduces either kind; the rows themselves say what
   * they are (round avatar and @handle against poster and metadata), which is what
   * keeps a profile from ever being misread as an entry in the title ranking. The gate
   * in `meaningfulMatch` is what keeps person rows out entirely when the query was
   * plainly about a title; an `@` query lifts that gate rather than reordering.
   */
  const rows: ResultRow[] = [
    ...users.map((user) => ({ type: 'person' as const, user })),
    // Not a route. Everything the See-all row reveals is already in hand, so the
    // expansion cannot fail and cannot land anybody on a second empty state.
    ...(morePeopleCount > 0 ? [{ type: 'more-people' as const, count: morePeopleCount }] : []),
    ...results.map((result) => ({ type: 'title' as const, result })),
  ];

  // Somebody matched and the titles failed or came back empty. The list plainly has
  // people in it, so what happened to the titles is a footer under them rather than a
  // page-level state — and an error is named as one, never as "no titles match".
  const titlesError = !peopleOnly && error;
  const titlesEmpty = !peopleOnly && !error && results.length === 0;

  return (
    <View style={styles.list}>
      <FlashList
        data={rows}
        getItemType={(item) => item.type}
        // The wider search runs after the local one and adds to it, so its progress is
        // a footer rather than a state: the rows already found stay put and usable.
        ListFooterComponent={
          titlesError ? (
            <EmptyState
              kind="couldNotLoad"
              compact
              title="Could not search titles"
              body="Search needs a connection. Your own collection works offline."
              action={{ label: 'Try again', onPress: onRetry }}
            />
          ) : titlesEmpty ? (
            <>
              {loading ? <SkeletonRow count={4} /> : null}
              <EmptyState
                kind="nothingMatches"
                compact
                title="No titles match that"
                body="Nothing in the catalogue by that name."
              />
            </>
          ) : !peopleOnly && searchingWider ? (
            <View style={styles.status}>
              <Text variant="footnote" tone="tertiary">
                Looking further afield…
              </Text>
            </View>
          ) : !peopleOnly && providerFailed ? (
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
        keyExtractor={(item) =>
          item.type === 'person'
            ? `person:${item.user.id}`
            : item.type === 'title'
              ? `title:${item.result.id}`
              : 'more-people'
        }
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.results}
        renderItem={({ item }) => {
          if (item.type === 'person') {
            return (
              <UserRow
                name={item.user.name}
                username={item.user.username}
                avatarUri={item.user.avatarUri}
                relationship={relationshipLabel(item.user)}
                onPress={() => onOpenUser(item.user)}
              />
            );
          }
          if (item.type === 'more-people') {
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`See all ${item.count} people`}
                onPress={onSeeAllMembers}
                style={({ pressed }) => [styles.seeAllRow, pressed && styles.pressed]}
              >
                <Text variant="callout" tone="action">
                  See all {item.count} people
                </Text>
              </Pressable>
            );
          }
          const title = item.result;
          // The reader's own state for this title, which is what the leading control is.
          const myScore = scores.get(title.id) ?? null;
          const isWatched = watched.has(title.id);
          return (
            // Stale dims only what is stale — the title results lagging a beat behind
            // the keystroke, kept legible rather than blinking away. The person rows
            // come from their own query and stay at full strength.
            <View style={stale ? styles.stale : undefined}>
              <TitleRow
                title={title.title}
                year={yearOf(title.release_date)}
                posterUri={posterUri(title.poster_path)}
                secondary={
                  title.kind === 'series' ? (
                    // No count for a series the catalogue has only just met: its seasons
                    // are fetched when the picker opens, and "0 seasons" would be the app
                    // stating as fact something it has not looked up yet.
                    title.season_count ? (
                      `Series · ${title.season_count} seasons`
                    ) : (
                      'Series'
                    )
                  ) : (
                    <TitleMetadata
                      runtimeMinutes={title.runtime_minutes}
                      genres={title.genres}
                      showYear={false}
                    />
                  )
                }
                /**
                 * **Ranking state first, Watchlist second** (founder, 2026-09-06).
                 *
                 * The order was bookmark then `+`, and the founder's own use case is what
                 * reversed it: see a title recommended somewhere else, search bingd., act,
                 * leave. Ranking is what this app is for, so the ranking control leads and
                 * saving-for-later follows it.
                 *
                 * **The leading control is the reader's own state, not a generic `+`.**
                 * Three states, and each is the honest one:
                 *
                 *   ranked            their score, in the app's one score treatment. A
                 *                     search row that showed a bare `+` over a title they
                 *                     have already rated 9.0 was throwing away the single
                 *                     most useful thing bingd. knows about them.
                 *   watched, unranked the dashed `Rank` ring — the same badge the
                 *                     collection draws for exactly this state.
                 *   neither           `+`, the canonical log entry, unchanged.
                 *
                 * All three lead to the **same** `LogSheet` this screen already opened.
                 * There is no Search-specific ranking path: the sheet knows how to open a
                 * ranked title for a rebucket or a rerank, and inventing a second route
                 * into ranking is how two flows come to disagree about what a re-rank is.
                 *
                 * **A series gets no score and no Rank ring** — it cannot be ranked
                 * (PRD §10), so either badge there would be a control lying about what it
                 * does. It keeps the `+`, which is not a ranking claim: it opens the
                 * season picker, and the season is the rankable unit. Removing it would
                 * take away the only fast path from "search Breaking Bad" to "rank the
                 * season", which is the capture this whole row exists for.
                 *
                 * Both controls carry `hitSlop`, so each clears 44pt without the row
                 * growing. The row itself still opens the title: these are `Pressable`
                 * children of `trailing`, outside `TitleRow`'s own press target.
                 */
                trailing={
                  <View style={styles.rowActions}>
                    {title.kind !== 'series' && myScore ? (
                      <ScoreBadge
                        score={myScore.score}
                        bucket={myScore.bucket}
                        size="sm"
                        onPress={() => onOpenLog(title)}
                      />
                    ) : title.kind !== 'series' && isWatched ? (
                      <ScoreBadge size="sm" onPress={() => onOpenLog(title)} />
                    ) : (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Log ${title.title}`}
                        onPress={() => onOpenLog(title)}
                        hitSlop={theme.space[2]}
                        style={styles.rowAction}
                      >
                        <Ionicons
                          name="add-circle"
                          size={theme.layout.icon.lg}
                          color={theme.semantic.action}
                        />
                      </Pressable>
                    )}

                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{
                        selected: saved.has(title.id),
                        disabled: watchlistBusy === title.id,
                      }}
                      accessibilityLabel={
                        saved.has(title.id)
                          ? `Remove ${title.title} from Watchlist`
                          : `Add ${title.title} to Watchlist`
                      }
                      // `void`, not a returned promise: a `Pressable` handler that
                      // returns one makes the press itself await the whole write, which
                      // is a hang in a test and a swallowed rejection in the app.
                      onPress={() => void onToggleWatchlist(title)}
                      // The write is guarded in `toggleWatchlist` as well; this stops the
                      // second tap ever reaching it, which is the difference between a
                      // refused duplicate and one that was never made.
                      disabled={watchlistBusy === title.id}
                      hitSlop={theme.space[3]}
                      style={({ pressed }) => [
                        styles.rowAction,
                        pressed && styles.rowActionPressed,
                      ]}
                    >
                      {/* Filled maroon when saved, outlined otherwise — the app's one
                          watchlist treatment, the same pair `ActivityRow` draws. The icon
                          swaps in place, so nothing on the row moves while it writes. */}
                      <Ionicons
                        name={saved.has(title.id) ? 'bookmark' : 'bookmark-outline'}
                        size={theme.layout.icon.md}
                        color={
                          saved.has(title.id) ? theme.semantic.action : theme.text.secondary
                        }
                      />
                    </Pressable>
                  </View>
                }
                onPress={() => onOpenTitle(title)}
              />
            </View>
          );
        }}
      />
    </View>
  );
}

/**
 * A row in the one list. Three kinds, one surface: the discriminant is what
 * `getItemType` hands FlashList for recycling and what `renderItem` switches on.
 */
type ResultRow =
  | { type: 'person'; user: UserResult }
  | { type: 'more-people'; count: number }
  | { type: 'title'; result: SearchResult };

const styles = StyleSheet.create({
  /**
   * The two quick actions on a title row.
   *
   * A gap rather than padding, so the row's height is still set by its type and the
   * poster still fits inside it — `TitleRow`'s rule, and what keeps a second control
   * from making Search rows taller than Collection's. The controls carry their 44pt
   * targets in `hitSlop`, which costs no layout at all.
   */
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  rowAction: { alignItems: 'center', justifyContent: 'center' },
  rowActionPressed: { opacity: 0.6 },
  // The field's own row under the brand row — the cross-tab second-row position the
  // category selector holds elsewhere. Gutter-aligned with the content below it.
  searchRow: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[2],
  },
  filters: {
    flexDirection: 'row',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    // Top as well as bottom because the row sits directly under the header seam.
    paddingTop: theme.space[2],
    paddingBottom: theme.space[2],
  },
  list: { flex: 1 },
  // Row-shaped like its neighbours, so the expansion reads as part of the list
  // rather than as a control floating between two kinds of row.
  seeAllRow: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.layout.gutter,
  },
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
