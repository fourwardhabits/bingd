import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { unreadCount, useNotifications } from '@/features/notifications/use-notifications';
import { CollectionFilterSheet } from '@/features/collection/CollectionFilterSheet';
import {
  activeFilterCount,
  emptyFilters,
  isFiltered,
  type CollectionFilters,
} from '@/features/collection/filters';
import { useLoggedCollection } from '@/features/collection/use-collection';
import { newOperationId, setWatchlist } from '@/features/collection/writes';
import { headlineFor } from '@/features/recommendations/rank';
import { useForYou, type ForYouItem, type Medium } from '@/features/recommendations/use-for-you';
import { posterUri } from '@/lib/images';
import { languageName } from '@/lib/language';
import { queryKeys } from '@/lib/query';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  Button,
  EmptyState,
  PosterGrid,
  Screen,
  SegmentedTabs,
  SkeletonRow,
  Text,
} from '@/ui/components';

/**
 * For You: a wall of artwork, not a list of arguments.
 *
 * Founder decision, 2026-08-16 — this should feel like a poster wall, encourage
 * visual browsing, open a title on tap, and make saving fast. The previous version
 * was a feature card plus explanation shelves, which is a good shape for a slate of
 * six with a strong reason each and the wrong shape for twenty titles to browse: the
 * reason took the top of the screen and the artwork was the thing scrolled past.
 *
 * **The explanation moved rather than left.** One line under the header says what the
 * wall is built on, which is the claim that actually needs making — twenty repetitions
 * of "because you loved Inception" is the same sentence twenty times. The per-title
 * reasoning is intact in `explanation` on every item, is reachable on long press, and
 * is what the quality report reads.
 *
 * Movies by default, TV a tap away. The two are separate walls rather than a mixed
 * one: a film and a series are not interchangeable answers to "what should I watch",
 * and the ranked lists behind them are separate for the same reason (PRD §11).
 */
export default function RecommendationsScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const notifications = useNotifications(profile.id);
  const [medium, setMedium] = useState<Medium>('movies');
  const [busy, setBusy] = useState<string | null>(null);
  const [filters, setFilters] = useState<CollectionFilters>(emptyFilters());
  const [filtering, setFiltering] = useState(false);

  const slate = useForYou(profile.id, medium, filters);
  const logged = useLoggedCollection(profile.id);

  const items = slate.data?.items ?? [];

  const toggleSave = async (item: ForYouItem) => {
    if (busy) return;
    setBusy(item.mediaItemId);
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId: item.mediaItemId,
      present: !item.saved,
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

  return (
    <Screen>
      <AppHeader
        notifications={{
          count: unreadCount(notifications.data),
          onPress: () => router.push('/settings/notifications'),
        }}
      />

      <View style={styles.controls}>
        <SegmentedTabs
          options={[
            { id: 'movies', label: 'Movies' },
            { id: 'tv', label: 'TV' },
          ]}
          value={medium}
          onChange={(next) => setMedium(next as Medium)}
        />
        {/* The collection's own sheet, which its header always intended this screen to
            reuse rather than growing a second one. Genre, Language, Decade and Anime
            come with it — and Anime is peer-level with the other three there rather
            than pretending to be a TMDB genre, which is the founder's ask satisfied by
            a control that already existed. Rating filters are off: nothing on a For
            You wall has been ranked. */}
        <View style={styles.filterRow}>
          <Button
            label={isFiltered(filters) ? `Filters · ${activeFilterCount(filters)}` : 'Filters'}
            kind="tertiary"
            onPress={() => setFiltering(true)}
          />
          {isFiltered(filters) ? (
            <Button label="Clear" kind="tertiary" onPress={() => setFilters(emptyFilters())} />
          ) : null}
        </View>
      </View>

      {slate.isError ? (
        <EmptyState
          kind="couldNotLoad"
          title="Could not load recommendations"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void slate.refetch() }}
        />
      ) : slate.isPending ? (
        <SkeletonRow count={6} />
      ) : items.length === 0 ? (
        <Nothing medium={medium} ranked={logged.data?.rankedCount ?? 0} onRank={() => router.push('/log')} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {/* One line for the whole wall. Twenty tiles each captioned "because you
              loved Inception" is the same sentence twenty times, and a wall with a
              caption under every poster is not a wall. */}
          <View style={styles.basis}>
            {/* The heading names the filter when there is one — "Comedy for you",
                "Telugu picks for you" — because a wall that has been narrowed and does
                not say so reads as the recommender having changed its mind. */}
            <Text variant="headline">{headingFor(filters)}</Text>
            {/* And underneath, the claim about how it was built, which is unchanged by
                filtering: the same taste chose these, from a smaller pool. */}
            <Text variant="footnote" tone="secondary">
              {basisFor(slate.data?.anchorsUsed ?? 0)}
            </Text>
            {/* And the films that contributed, as an aside that admits there are more.
                Absent on a genre- or language-led slate, where naming a film would be
                inventing a reason. */}
            {inspiredBy(items) ? (
              <Text variant="caption" tone="tertiary">
                {inspiredBy(items)}
              </Text>
            ) : null}
          </View>

          <PosterGrid
            tiles={items.map((item) => ({
              id: item.mediaItemId,
              title: item.title,
              year: item.year,
              posterUri: posterUri(item.posterPath, 'card'),
              saved: item.saved,
              // Deliberately no score. Nothing here has been watched, so a score
              // would have to be somebody else's — and a rating filter over unseen
              // titles is the thing the collection filter sheet already refuses.
            }))}
            onPressTile={(tile) => router.push(`/title/${tile.id}`)}
            onToggleSave={(tile) => {
              const item = items.find((candidate) => candidate.mediaItemId === tile.id);
              if (item) void toggleSave(item);
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
          items={slate.data?.candidatePool ?? []}
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

/**
 * "For you", or what the reader has narrowed it to.
 *
 * The founder's shapes: `Comedy for you`, `Telugu picks for you`, `Anime for you`.
 * One filter is named; two or more become the neutral heading, because "Comedy Telugu
 * 1990s picks for you" is a sentence nobody wrote and the chip row above already says
 * what is on.
 *
 * A language reads "picks for you" rather than "for you" — "Telugu for you" describes
 * a language lesson.
 */
function headingFor(filters: CollectionFilters): string {
  if (activeFilterCount(filters) !== 1) return 'For you';

  if (filters.anime) return 'Anime for you';
  if (filters.genres.length === 1) return `${filters.genres[0]} for you`;
  if (filters.decades.length === 1) return `${filters.decades[0]} for you`;
  if (filters.languages.length === 1) {
    const name = languageName(filters.languages[0]!);
    // Never the raw code. "te for you" is a database value on a heading, which is the
    // one outcome the founder ruled out for every language surface.
    if (name) return `${name} picks for you`;
  }

  return 'For you';
}

/**
 * What the wall is built on, said once — and said accurately.
 *
 * **The old copy named three films and implied they were the whole basis.** They were
 * not: the engine takes up to six anchors (`ANCHOR_LIMIT`) *and* a taste vector over
 * every genre and language the reader has ranked, *and* a popularity prior. "Based on
 * Inception, The Dark Knight and Heat" is a claim a reader can check and find wrong —
 * they will see a Telugu comedy on the wall and none of those three explains it.
 *
 * So the headline says what is true of the whole wall, and the naming becomes a
 * secondary line that says *inspired by* and admits there is more. The founder's
 * wording, and the honest one.
 *
 * "Popular right now" when there are no anchors at all, which is what a cold-start
 * slate is. Calling that personalised would be the exact label PRD §13 forbids.
 */
function basisFor(anchorsUsed: number): string {
  if (anchorsUsed === 0) return 'Popular right now — rank a few titles and this becomes yours.';
  return 'Based on your taste';
}

/**
 * The films that actually contributed, named as an aside rather than as the basis.
 *
 * Three at most and always followed by "+ more" when there were others, because the
 * engine used up to six and the vector besides. Null when nothing was named, which
 * happens on a genre- or language-led slate — and a line reading "Inspired by" with
 * nothing after it would be worse than no line.
 */
function inspiredBy(items: ForYouItem[]): string | null {
  const named: string[] = [];
  for (const item of items) {
    for (const hit of item.explanation.anchors) {
      if (!named.includes(hit.title)) named.push(hit.title);
    }
  }
  if (named.length === 0) return null;

  const shown = named.slice(0, 3).join(', ');
  return named.length > 3 ? `Inspired by ${shown} + more` : `Inspired by ${shown}`;
}

/**
 * Nothing to show, which has two quite different causes and needs two answers.
 *
 * A user who has ranked nothing needs to rank something. A user who has ranked
 * plenty and still sees an empty wall has hit a data problem — no cached candidates
 * yet — and telling them to rank more would be blaming them for it.
 */
function Nothing({
  medium,
  ranked,
  onRank,
}: {
  medium: Medium;
  ranked: number;
  onRank: () => void;
}) {
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
  controls: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[3] },
  content: { paddingBottom: theme.space[10], gap: theme.space[3] },
  basis: { paddingHorizontal: theme.layout.gutter, gap: 2 },
  filterRow: { flexDirection: 'row', alignItems: 'center', paddingTop: theme.space[2] },
});
