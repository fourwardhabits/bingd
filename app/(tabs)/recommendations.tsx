import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { unreadCount, useNotifications } from '@/features/notifications/use-notifications';
import { CollectionFilterSheet } from '@/features/collection/CollectionFilterSheet';
import {
  applyFilters,
  emptyFilters,
  isFiltered,
  activeFilterCount,
  type CollectionFilters,
} from '@/features/collection/filters';
import { useLoggedCollection, useWatchlist } from '@/features/collection/use-collection';
import { newOperationId, setWatchlist } from '@/features/collection/writes';
import { headlineFor } from '@/features/recommendations/rank';
import { SentToYouList } from '@/features/recommendations/SentToYouList';
import { useForYou, type ForYouItem, type Medium } from '@/features/recommendations/use-for-you';
import {
  asCollectionItem as recommendationAsItem,
  unopenedCount,
  useMarkRecommendationOpened,
  useSentToYou,
  type SentRecommendation,
} from '@/features/recommendations/use-sent-to-you';
import { posterUri } from '@/lib/images';
import { languageName } from '@/lib/language';
import { queryKeys } from '@/lib/query';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  EmptyState,
  FilterChip,
  HeaderBoundary,
  MediumSelector,
  PosterGrid,
  Screen,
  SkeletonRow,
  type Medium as CollectionMedium,
} from '@/ui/components';

/**
 * For You, rebuilt to the shape of Collection (founder pass, 2026-08-17).
 *
 * What it looked like before: a Movies/TV segmented row *under* a For you / Sent to you
 * row, then a heading that said "For you" again, then "Based on your taste", then
 * "Inspired by Inception, Heat + more", and only then artwork. Four bands of prose in
 * front of a wall whose entire proposition is the artwork.
 *
 * All four are gone. The founder's rule is the one Collection already follows: category
 * across the top, one filter row, then straight into the wall. A screen called For you,
 * reached from a tab called For you, does not need a heading that says For you, and the
 * claim underneath it was a sentence nobody read twice.
 *
 * **Sent to you is a filter, not a tab.** It sat as a peer of the whole engine, which
 * made the top of the screen a two-level navigation for one wall. As the first chip in
 * the filter row it is what it always was, a narrowing of "things to watch" down to
 * "things people sent me", and the other chips keep working across it, which is what
 * makes "Comedy, from friends" a thing anybody can ask for.
 *
 * **The filters are one state across everything**, deliberately. Choosing Comedy is a
 * statement about what the reader is in the mood for, not about which list they happen
 * to be looking at. Nothing about filtering touches a recommendation record: it narrows
 * what is drawn and that is all.
 *
 * For You is a wall of artwork; Sent to you is a list. See `SentToYouList` for why they
 * differ.
 */
export default function RecommendationsScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const notifications = useNotifications(profile.id);

  const [medium, setMedium] = useState<Medium>('movies');
  /** The first chip. Not a tab: see the header. */
  const [sentOnly, setSentOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [filters, setFilters] = useState<CollectionFilters>(emptyFilters());
  const [filtering, setFiltering] = useState(false);

  const slate = useForYou(profile.id, medium, filters);
  const logged = useLoggedCollection(profile.id);
  const sent = useSentToYou(profile.id);
  const watchlist = useWatchlist(profile.id);
  const markOpened = useMarkRecommendationOpened(profile.id);

  const items = slate.data?.items ?? [];
  const sentRows = sent.data ?? [];

  // Filtered here rather than in the query, so turning the chip on cannot refetch and
  // cannot reorder: the server's ordering survives, narrowed.
  const sentShown = applyFilters(sentRows.map(recommendationAsItem), filters);
  const sentVisible = sentRows.filter((row) =>
    sentShown.some((item) => item.mediaItemId === row.mediaItemId),
  );

  const savedIds = new Set((watchlist.data ?? []).map((row) => row.mediaItemId));

  const toggleSaveById = async (mediaItemId: string, present: boolean) => {
    if (busy) return;
    setBusy(mediaItemId);
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId,
      present,
    });
    setBusy(null);

    if (result.outcome === 'failed') {
      Alert.alert('Could not update watchlist', result.message);
      return;
    }

    await queryClient.invalidateQueries({
      queryKey: [...queryKeys.collection(profile.id), 'watchlist'],
    });
    // The slate carries `saved` on each item, so it has to be refetched to redraw the
    // bookmark. Keyed by prefix: both media, and whatever anchors are current.
    await queryClient.invalidateQueries({ queryKey: ['for-you', profile.id] });
  };

  const openRecommendation = (row: SentRecommendation) => {
    // Opened is recorded on the way through, which is the only moment anybody can
    // honestly call it opened. It is fire-and-forget: a failure here must not stand
    // between somebody and the title they were told to watch.
    if (!row.openedAt) markOpened.mutate(row.id);
    // Who sent it and when travel with the link, so the title page can say so over its
    // hero. The fact belongs to this route and not to the title: the same film reached
    // from search is not "recommended by Ada", and a lookup on every title page would
    // be a round trip to answer a question only this one asks.
    // The object form rather than a query string, because typed routes only accept a
    // path that matches a known pattern and `/title/x?y=z` matches none of them.
    router.push({
      pathname: '/title/[id]',
      params: { id: row.mediaItemId, recBy: row.senderName, recAt: row.recommendedAt },
    });
  };

  const explain = (item: ForYouItem) => {
    const { explanation } = item;
    const taste = slate.data?.taste;
    if (!taste) return;

    const lines = [
      // The real taste, not a stand-in. A stand-in with a large `sampleSize` was
      // defeating the suppression that stops a taste built from one ranking being
      // asserted in words, so this panel showed a sentence the wall would not.
      headlineFor(explanation, taste, (code) => languageName(code) ?? code),
      `score ${explanation.total.toFixed(3)}`,
      explanation.anchors.length
        ? `anchors: ${explanation.anchors
            .map((hit) => `${hit.title} (#${hit.position}, +${hit.contribution.toFixed(2)})`)
            .join(', ')}`
        : 'anchors: none',
      explanation.genre
        ? `genre: ${explanation.genre.genre} ${explanation.genre.affinity.toFixed(2)}`
        : 'genre: none',
      explanation.language
        ? `language: ${explanation.language.code} ${explanation.language.affinity.toFixed(2)}`
        : 'language: none',
      `popularity prior: ${explanation.popularity.toFixed(2)}`,
    ].filter(Boolean);

    Alert.alert(item.title, lines.join('\n'));
  };

  const unopened = unopenedCount(sentRows);
  const activeCount = activeFilterCount(filters);

  return (
    <Screen>
      <AppHeader
        notifications={{
          count: unreadCount(notifications.data),
          onPress: () => router.push('/settings/notifications'),
        }}
      />

      {/* The same control Collection leads with, in the same place, doing the same job.
          "TV shows" rather than "TV seasons" because this wall holds series: TMDB
          answers "similar" about a show and never about one of its seasons. */}
      <MediumSelector
        value={MEDIUM_TO_SELECTOR[medium]}
        onChange={(next) => setMedium(SELECTOR_TO_MEDIUM[next])}
        labels={{ tv_seasons: 'TV shows' }}
      />
      <HeaderBoundary />

      {/* One row, wrapping. Sent to you leads because it is the only chip that changes
          what kind of thing is on screen; the rest narrow whatever is. Clear all appears
          only when there is something to clear, and clears the *filters*: turning off
          Sent to you as well would make one control mean two things. */}
      <View style={styles.filterRow}>
        <FilterChip
          icon={sentOnly ? 'mail-open' : 'mail-outline'}
          label={unopened > 0 ? `Sent to you · ${unopened}` : 'Sent to you'}
          accessibilityLabel={unopened > 0 ? `Sent to you, ${unopened} unopened` : 'Sent to you'}
          selected={sentOnly}
          onPress={() => setSentOnly((on) => !on)}
        />
        {/* The collection's own sheet, which its header always intended this screen to
            reuse rather than growing a second one. Genre, Language, Decade and Anime
            come with it. Rating filters are off: nothing on either list has been ranked
            by this reader. */}
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

      {sentOnly ? (
        <SentList
          query={sent}
          rows={sentVisible}
          total={sentRows.length}
          saved={savedIds}
          busyId={busy}
          onOpen={openRecommendation}
          onToggleSave={(row) =>
            void toggleSaveById(row.mediaItemId, !savedIds.has(row.mediaItemId))
          }
        />
      ) : slate.isError ? (
        <EmptyState
          kind="couldNotLoad"
          title="Could not load recommendations"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void slate.refetch() }}
        />
      ) : slate.isPending ? (
        <SkeletonRow count={6} />
      ) : items.length === 0 ? (
        <Nothing
          medium={medium}
          ranked={logged.data?.rankedCount ?? 0}
          filtered={isFiltered(filters)}
          onRank={() => router.push('/log')}
          onClearFilters={() => setFilters(emptyFilters())}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <PosterGrid
            tiles={items.map((item) => ({
              id: item.mediaItemId,
              title: item.title,
              year: item.year,
              posterUri: posterUri(item.posterPath, 'card'),
              saved: item.saved,
              // Deliberately no score. Nothing here has been watched, so a score would
              // have to be somebody else's, and a rating filter over unseen titles is
              // the thing the collection filter sheet already refuses.
            }))}
            onPressTile={(tile) => router.push(`/title/${tile.id}`)}
            onToggleSave={(tile) => {
              const item = items.find((candidate) => candidate.mediaItemId === tile.id);
              if (item) void toggleSaveById(item.mediaItemId, !item.saved);
            }}
            onLongPressTile={(tile) => {
              const item = items.find((candidate) => candidate.mediaItemId === tile.id);
              if (item) explain(item);
            }}
          />
        </ScrollView>
      )}

      {filtering ? (
        <CollectionFilterSheet
          // The options describe whatever is in front of the reader, so a Sent to you
          // list of four films does not offer twenty genres none of them are.
          items={sentOnly ? sentRows.map(recommendationAsItem) : (slate.data?.candidatePool ?? [])}
          value={filters}
          showBuckets={false}
          onApply={(next) => {
            setFilters(next);
            setFiltering(false);
          }}
          onClose={() => setFiltering(false)}
        />
      ) : null}
    </Screen>
  );
}

/** The screen's own medium and the shared selector's, which name different units. */
const MEDIUM_TO_SELECTOR: Record<Medium, CollectionMedium> = {
  movies: 'movies',
  tv: 'tv_seasons',
};
const SELECTOR_TO_MEDIUM: Record<CollectionMedium, Medium> = {
  movies: 'movies',
  tv_seasons: 'tv',
};

/**
 * The human half.
 *
 * Three empty states rather than one, because they mean three different things and only
 * one of them is the reader's to fix: nobody has sent you anything, the filters have
 * hidden everything that was sent, or the list could not load.
 */
function SentList({
  query,
  rows,
  total,
  saved,
  busyId,
  onOpen,
  onToggleSave,
}: {
  query: ReturnType<typeof useSentToYou>;
  rows: SentRecommendation[];
  total: number;
  saved: ReadonlySet<string>;
  busyId: string | null;
  onOpen: (row: SentRecommendation) => void;
  onToggleSave: (row: SentRecommendation) => void;
}) {
  if (query.isPending) return <SkeletonRow count={5} />;

  if (query.isError) {
    return (
      <EmptyState
        kind="couldNotLoad"
        title="Could not load these"
        body="Check your connection and try again."
        action={{ label: 'Try again', onPress: () => void query.refetch() }}
      />
    );
  }

  if (total === 0) {
    return (
      <EmptyState
        kind="nothingYet"
        title="Nothing sent your way yet"
        body="When someone you follow back recommends a film or a season, it lands here."
      />
    );
  }

  if (rows.length === 0) {
    return (
      // No button. Clear all is already on screen, in the chip row a few points above
      // this, and a second one with the same label is the duplicated state the founder
      // rejected on the Feed: the reader would have to work out whether the two do the
      // same thing.
      <EmptyState
        kind="nothingYet"
        title="Nothing matches your filters"
        body="Clear your filters to see everything people have sent you."
      />
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={query.isRefetching}
          onRefresh={() => void query.refetch()}
          tintColor={theme.semantic.action}
          colors={[theme.semantic.action]}
        />
      }
    >
      <SentToYouList
        rows={rows}
        saved={saved}
        busyId={busyId}
        onOpen={onOpen}
        onToggleSave={onToggleSave}
      />
    </ScrollView>
  );
}

/**
 * Nothing to show, which has three quite different causes and needs three answers.
 *
 * A reader who has ranked nothing needs to rank something. A reader who has filtered the
 * wall down to nothing needs the filter gone, and telling them to rank more would be
 * answering a question they did not ask. A reader who has ranked plenty and still sees
 * an empty wall has hit a data problem, no cached candidates yet, and blaming them for
 * it would be worse than saying nothing.
 */
function Nothing({
  medium,
  ranked,
  filtered,
  onRank,
  onClearFilters,
}: {
  medium: Medium;
  ranked: number;
  filtered: boolean;
  onRank: () => void;
  onClearFilters: () => void;
}) {
  if (filtered) {
    return (
      <EmptyState
        kind="nothingMatches"
        title="Nothing matches your filters"
        body="Try removing one, or clear them and start again."
        action={{ label: 'Clear all', onPress: onClearFilters }}
      />
    );
  }

  if (ranked === 0) {
    return (
      <EmptyState
        kind="nothingYet"
        title="Rank a few things first"
        body="Recommendations need a little of your taste to work from."
        action={{ label: 'Rank something', onPress: onRank }}
      />
    );
  }

  return (
    <EmptyState
      kind="nothingYet"
      title={medium === 'tv' ? 'Nothing to suggest yet' : 'Still gathering suggestions'}
      body={
        medium === 'tv'
          ? 'Rank a season or two and this fills up with shows.'
          : 'This fills in as the catalogue learns what your favourites are near.'
      }
      action={{ label: 'Rank something', onPress: onRank }}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10], gap: theme.space[3] },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space[2],
    rowGap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
  },
});
