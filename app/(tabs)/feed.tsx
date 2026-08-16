import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { useWatchlist } from '@/features/collection/use-collection';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { newOperationId, setWatchlist } from '@/features/collection/writes';
import { ReactionPicker } from '@/features/feed/ReactionPicker';
import { useFeed, type FeedItem } from '@/features/feed/use-feed';
import {
  REACTION_GLYPH,
  useReactions,
  useSetReaction,
  type ReactionKind,
} from '@/features/feed/use-reactions';
import { posterUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { ActivityRow, AppHeader, EmptyState, Screen, SkeletonRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** PRD §14. Fan-out on read: followed users' activity is queried at read time
 *  rather than written into per-user inboxes (docs/architecture/README.md AD-5). */
export default function FeedScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const queryClient = useQueryClient();
  const feed = useFeed(profile.id);
  const watchlist = useWatchlist(profile.id);
  const watched = useWatched(profile.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [reactingTo, setReactingTo] = useState<string | null>(null);

  const eventIds = useMemo(() => (feed.data ?? []).map((event) => event.id), [feed.data]);
  const reactions = useReactions(eventIds, profile.id);
  const { setReaction } = useSetReaction(profile.id);

  const choose = async (kind: ReactionKind | null) => {
    const eventId = reactingTo;
    if (!eventId) return;
    setReactingTo(null);
    const result = await setReaction(eventId, kind);
    if (!result.ok && result.message) {
      Alert.alert('Could not save your reaction', result.message);
    }
  };

  const saved = useMemo(
    () => new Set((watchlist.data ?? []).map((entry) => entry.mediaItemId)),
    [watchlist.data],
  );

  // Adding a friend's title to your own watchlist is the feed's whole point —
  // PRD §28 counts it as the product's core virality metric — so it happens
  // here rather than a page away.
  const toggleWatchlist = async (mediaItemId: string) => {
    if (busy) return;
    setBusy(mediaItemId);
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId,
      present: !saved.has(mediaItemId),
    });
    setBusy(null);

    if (result.outcome === 'failed') {
      Alert.alert('Could not update watchlist', result.message);
      return;
    }

    await queryClient.invalidateQueries({
      queryKey: [...queryKeys.collection(profile.id), 'watchlist'],
    });
  };

  const shareTitle = async (event: FeedItem) => {
    if (!event.mediaItemId) return;
    const url = `https://bingd.app/title/${event.kind ?? 'movie'}/${event.mediaItemId}`;
    try {
      await Share.share({ message: url, url });
    } catch (error) {
      Alert.alert('Could not share', error instanceof Error ? error.message : 'Sharing failed.');
    }
  };

  const events = feed.data ?? [];

  return (
    <Screen>
      <AppHeader />
      <ScrollView contentContainerStyle={styles.content}>
        {feed.isError ? (
          <View style={styles.pad}>
            <EmptyState
              kind="couldNotLoad"
              title="Could not load activity"
              body="Check your connection and try again."
            />
          </View>
        ) : feed.isPending ? (
          <SkeletonRow count={5} />
        ) : events.length === 0 ? (
          <View style={styles.pad}>
            <EmptyState
              kind="nothingYet"
              compact
              title="Your feed is quiet right now."
              body="Rank a title, or follow someone, and activity will appear here."
            />
          </View>
        ) : (
          events.map((event) => (
            <ActivityRow
              key={event.id}
              actorName={event.actorName}
              actorAvatarUri={event.actorAvatarUri}
              // Own activity has no profile to visit that is not the tab the user
              // is already one tap from, so the name is not a link on those rows.
              onPressActor={
                event.actorId === profile.id || !event.actorUsername
                  ? undefined
                  : () => router.push(`/u/${event.actorUsername}`)
              }
              verb={VERB[event.type]}
              companions={event.companions}
              title={event.title}
              year={event.year}
              posterUri={posterUri(event.posterPath)}
              metadata={metadataFor(event)}
              score={event.score}
              bucket={event.bucket}
              note={event.note?.text ?? null}
              noteHasSpoilers={event.note?.hasSpoilers ?? false}
              noteMasked={shouldMask({
                hasSpoilers: event.note?.hasSpoilers ?? false,
                mediaItemId: event.mediaItemId,
                viewerId: profile.id,
                authorId: event.actorId,
                watched: watched.data,
              })}
              timeLabel={relativeTime(event.createdAt)}
              onPressTitle={() => event.mediaItemId && router.push(`/title/${event.mediaItemId}`)}
              // Watchlisting your own already-watched title is not a thing anyone
              // means to do, so the control is not offered on your own activity.
              onPressWatchlist={
                event.mediaItemId && event.actorId !== profile.id
                  ? () => toggleWatchlist(event.mediaItemId!)
                  : undefined
              }
              inWatchlist={event.mediaItemId ? saved.has(event.mediaItemId) : false}
              onPressShare={event.mediaItemId ? () => void shareTitle(event) : undefined}
              reaction={reactionFor(event.id)}
            />
          ))
        )}
      </ScrollView>

      <ReactionPicker
        visible={reactingTo !== null}
        current={reactingTo ? (reactions.data?.get(reactingTo)?.mine ?? null) : null}
        onClose={() => setReactingTo(null)}
        onChoose={(kind) => void choose(kind)}
      />
    </Screen>
  );

  function reactionFor(eventId: string) {
    const summary = reactions.data?.get(eventId);
    return {
      count: summary?.total ?? 0,
      mine: Boolean(summary?.mine),
      glyphs: (summary?.kinds ?? []).map((kind) => REACTION_GLYPH[kind]),
      names: summary?.names ?? [],
      others: summary?.others ?? 0,
      onPress: () => setReactingTo(eventId),
    };
  }
}

const VERB: Record<FeedItem['type'], string> = {
  title_ranked: 'ranked',
  title_logged: 'watched',
  season_completed: 'finished',
};

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  pad: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
});

/** `148m · Sci-fi`, the same line the compact row uses everywhere else. */
function metadataFor(event: FeedItem) {
  const parts = [
    event.runtimeMinutes ? `${event.runtimeMinutes}m` : null,
    event.genres[0] ?? null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
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
