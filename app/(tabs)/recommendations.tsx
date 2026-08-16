import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { useLoggedCollection } from '@/features/collection/use-collection';
import {
  shelvesFrom,
  useRecommendations,
  type Recommendation,
} from '@/features/recommendations/use-recommendations';
import { posterUri } from '@/lib/images';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  EmptyState,
  Poster,
  PosterShelf,
  Screen,
  SkeletonRow,
  Text,
  type PosterTile,
} from '@/ui/components';

/**
 * PRD §13. Every shelf renders only structured evidence supplied by the server —
 * the client never composes an explanation of its own (AD-8), because a
 * fabricated reason is worse than no reason.
 *
 * Shelves rather than one list, because the shelf title is where the reason
 * goes: "Because you loved Inception" covers six titles in one line instead of
 * six (screens.md §8). A shelf that cannot state its reason is not rendered.
 */
export default function RecommendationsScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const slate = useRecommendations(profile.id);
  const logged = useLoggedCollection(profile.id);

  const shelves = useMemo(() => shelvesFrom(slate.data), [slate.data]);
  const openTitle = (id: string) => router.push(`/title/${id}`);

  if (slate.isError) {
    return (
      <Screen>
        <AppHeader />
        <EmptyState
          kind="couldNotLoad"
          title="Could not load recommendations"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void slate.refetch() }}
        />
      </Screen>
    );
  }

  if (slate.isPending) {
    return (
      <Screen>
        <AppHeader />
        <SkeletonRow count={6} />
      </Screen>
    );
  }

  const lead = shelves[0];
  const feature = lead?.items[0];

  // No slate is the ordinary state of a new account, not a failure: the builder
  // runs on a schedule and has not reached this user yet. What it needs is
  // rankings, so the screen says so and points at the one action that helps.
  if (!lead || !feature) {
    const ranked = logged.data?.rankedCount ?? 0;

    return (
      <Screen>
        <AppHeader />
        <EmptyState
          kind="nothingYet"
          title={ranked === 0 ? 'Rank a few things first' : 'Still learning your taste'}
          body={
            ranked === 0
              ? 'Recommendations need a little of your taste to work from.'
              : `${ranked} ranked so far. A few more and this fills up.`
          }
          action={{ label: 'Rank something', onPress: () => router.push('/log') }}
        />
      </Screen>
    );
  }

  // The first recommendation shows its work. The shelves beneath it are for
  // browsing, and a wall of posters with no argument anywhere is a slate the
  // user has no reason to trust.
  const leadRest = lead.items.slice(1);
  const rest = shelves.slice(1);

  return (
    <Screen>
      <AppHeader />
      <ScrollView contentContainerStyle={styles.content}>
        <Feature
          item={feature}
          reason={lead.title}
          onPress={() => openTitle(feature.mediaItemId)}
        />

        {leadRest.length > 0 ? (
          <PosterShelf
            title={lead.title}
            tiles={leadRest.map(tileFor)}
            onPressTile={(tile) => openTitle(tile.id)}
          />
        ) : null}

        {rest.map((shelf) => (
          <PosterShelf
            key={shelf.id}
            title={shelf.title}
            tiles={shelf.items.map(tileFor)}
            onPressTile={(tile) => openTitle(tile.id)}
          />
        ))}
      </ScrollView>
    </Screen>
  );
}

/** The one recommendation rendered at full size, with its reason spelled out. */
function Feature({
  item,
  reason,
  onPress,
}: {
  item: Recommendation;
  reason: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[item.title, item.year, reason].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => [styles.feature, pressed && styles.pressed]}
    >
      <Poster uri={posterUri(item.posterPath, 'card')} title={item.title} size="lg" />
      <View style={styles.featureCopy}>
        <Text variant="title2" numberOfLines={2}>
          {item.title}
        </Text>
        {item.year ? (
          <Text variant="footnote" tone="secondary">
            {item.year}
          </Text>
        ) : null}
        <Text variant="body" tone="secondary" style={styles.reason}>
          {reason}
        </Text>
      </View>
    </Pressable>
  );
}

const tileFor = (item: Recommendation): PosterTile => ({
  id: item.mediaItemId,
  title: item.title,
  year: item.year,
  posterUri: posterUri(item.posterPath),
});

const styles = StyleSheet.create({
  content: { gap: theme.layout.sectionGap, paddingBottom: theme.space[10] },
  feature: {
    flexDirection: 'row',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  featureCopy: { flex: 1, gap: theme.space[1] },
  reason: { marginTop: theme.space[1] },
  pressed: { opacity: 0.7 },
});
