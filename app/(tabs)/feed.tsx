import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useCurrentProfile } from '@/features/auth';
import { useFeed, type FeedItem } from '@/features/feed/use-feed';
import { posterUri } from '@/lib/images';
import { theme } from '@/ui/tokens';
import { ActivityCard, AppHeader, EmptyState, Screen, Text } from '@/ui/components';

/** PRD §14. Fan-out on read: followed users' activity is queried at read time
 *  rather than written into per-user inboxes (docs/architecture/README.md AD-5). */
export default function FeedScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const feed = useFeed(profile.id);

  return (
    <Screen>
      <AppHeader />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          {feed.isError ? (
            <EmptyState
              kind="couldNotLoad"
              title="Could not load activity"
              body="Check your connection and try again."
            />
          ) : feed.isPending ? (
            <View style={styles.sectionPad}>
              <Text variant="body" tone="tertiary">
                Loading activity...
              </Text>
            </View>
          ) : (feed.data ?? []).length === 0 ? (
            <EmptyState
              kind="nothingYet"
              compact
              title="Your feed is quiet right now."
              body="Rank a title and activity will appear here."
            />
          ) : (
            (feed.data ?? []).map((event) => (
              <ActivityCard
                key={event.id}
                actorName={event.actorName}
                actorAvatarUri={event.actorAvatarUri}
                sentence={sentenceFor(event)}
                metadata={event.position ? `#${event.position} in ${event.category === 'tv_seasons' ? 'TV seasons' : 'Movies'}` : undefined}
                posterUri={posterUri(event.posterPath)}
                timeLabel={relativeTime(event.createdAt)}
                onPress={() => event.mediaItemId && router.push(`/title/${event.mediaItemId}`)}
              />
            ))
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: theme.space[3],
    paddingBottom: theme.space[10],
  },
  section: { gap: theme.space[2] },
  sectionPad: { paddingHorizontal: theme.layout.gutter },
});

function sentenceFor(event: FeedItem) {
  const actor = event.actorName;
  const title = event.title ?? 'a title';
  if (event.type === 'title_ranked') return `${actor} ranked ${title}.`;
  if (event.type === 'season_completed') return `${actor} finished ${title}.`;
  return `${actor} watched ${title}.`;
}

function relativeTime(value: string) {
  const now = Date.now();
  const then = new Date(value).getTime();
  const mins = Math.max(1, Math.round((now - then) / (1000 * 60)));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
