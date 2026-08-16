import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
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
  const [medium, setMedium] = useState<Medium>('movies');
  const [busy, setBusy] = useState<string | null>(null);

  const slate = useForYou(profile.id, medium);
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
      <AppHeader />

      <View style={styles.controls}>
        <SegmentedTabs
          options={[
            { id: 'movies', label: 'Movies' },
            { id: 'tv', label: 'TV' },
          ]}
          value={medium}
          onChange={(next) => setMedium(next as Medium)}
        />
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
          <Text variant="footnote" tone="secondary" style={styles.basis}>
            {basisFor(slate.data?.anchorsUsed ?? 0, items)}
          </Text>

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
    </Screen>
  );
}

/**
 * What the wall is built on, said once.
 *
 * Named films when there are anchors, because that is the claim worth making and the
 * one a reader can check. "Popular right now" when there are none — which is what a
 * cold-start slate honestly is, and calling it personalised would be the exact label
 * PRD §13 forbids.
 */
function basisFor(anchorsUsed: number, items: ForYouItem[]): string {
  if (anchorsUsed === 0) return 'Popular right now — rank a few titles and this becomes yours.';

  const named: string[] = [];
  for (const item of items) {
    for (const hit of item.explanation.anchors) {
      if (!named.includes(hit.title)) named.push(hit.title);
    }
    if (named.length >= 3) break;
  }

  if (named.length === 0) return 'Based on what you have ranked.';
  if (named.length === 1) return `Based on ${named[0]}.`;
  return `Based on ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}.`;
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
  basis: { paddingHorizontal: theme.layout.gutter },
});
