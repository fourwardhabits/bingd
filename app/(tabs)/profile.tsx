
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, Share, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { unreadCount, useNotifications } from '@/features/notifications/use-notifications';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { CommentSheet } from '@/features/feed/CommentSheet';
import { useCommentCounts } from '@/features/feed/use-comments';
import { useReactions, useSetReaction, REACTION_GLYPH } from '@/features/feed/use-reactions';
import { useFeed } from '@/features/feed/use-feed';
import { AwardsSheet } from '@/features/awards/AwardsSheet';
import { GoalsSection } from '@/features/goals/GoalsSection';
import { ProfileIdentity } from '@/features/profile/ProfileIdentity';
import { TopRanked } from '@/features/profile/TopRanked';
import { useProfileStats } from '@/features/profile/use-public-profile';
import { posterUri } from '@/lib/images';
import { theme } from '@/ui/tokens';
import {
  ActivityRow,
  AppHeader,
  Button,
  EmptyState,
  Screen,
  SectionHeader,
  SkeletonRow,
} from '@/ui/components';

/**
 * The viewer's own profile — the same product a visitor sees, with the controls that
 * depend on being them.
 *
 * The founder's correction: this and `/u/[username]` had drifted into two designs. One
 * led with a large avatar beside the name and the other centred a stack; one had five
 * stats and the other four; one carried a Share button in the identity block. A reader
 * could not tell that what they see on somebody else is what other people see on them,
 * which is most of what a profile is for.
 *
 * `ProfileIdentity` and `TopRanked` are now shared, and the difference between the two
 * screens is exactly the set of things that genuinely depend on who is looking: this
 * one gets Share Profile and Bingd Awards, the other gets Follow and a Taste Match.
 * Editing is not one of them — it lives behind the gear in the header, because it is
 * housekeeping rather than the thing a profile is for.
 *
 * Recent activity uses the Feed's own row rather than a weakened copy of it, so a
 * ranking on a profile can be reacted to, commented on and shared like the same event
 * in the feed — which it is.
 */
export default function ProfileScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const feed = useFeed(profile.id);
  const watched = useWatched(profile.id);
  const stats = useProfileStats(profile.id);
  const notifications = useNotifications(profile.id);
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  // Mounted only while open, like every other sheet in the app: it reads nine things
  // when it mounts, and one that stayed mounted would read them on every profile visit
  // for a screen nobody had asked for.
  const [awardsOpen, setAwardsOpen] = useState(false);

  // Own activity only. The feed query spans everyone this user follows, and a
  // friend's ranking under a heading on *your* profile is a different claim.
  const recent = (feed.data ?? []).filter((event) => event.actorId === profile.id).slice(0, 5);
  const eventIds = recent.map((event) => event.id);
  const reactions = useReactions(eventIds, profile.id);
  const commentCounts = useCommentCounts(eventIds, profile.id);
  const { setReaction } = useSetReaction(profile.id);
  const openComments = commentsFor ? (recent.find((e) => e.id === commentsFor) ?? null) : null;

  /**
   * The profile as a link somebody else can open.
   *
   * The handle rather than the id, because it is the half a person can read back to
   * you, and `/u/[username]` is the route that already resolves one.
   */
  const shareProfile = async () => {
    const url = `https://bingd.app/u/${profile.username}`;
    try {
      await Share.share({ message: url, url });
    } catch (error) {
      Alert.alert('Could not share', error instanceof Error ? error.message : 'Sharing failed.');
    }
  };

  return (
    <Screen>
      <AppHeader
        // A gear rather than the word, and to the left of the bell rather than in
        // place of it. The bell is meant to sit in the same corner on every root tab;
        // a text button beside it was pushing it out of that corner on this one.
        settings={{ onPress: () => router.push('/settings') }}
        notifications={{
          count: unreadCount(notifications.data),
          onPress: () => router.push('/settings/notifications'),
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={feed.isRefetching}
            onRefresh={() => {
              void feed.refetch();
              void stats.refetch();
            }}
            tintColor={theme.semantic.action}
            colors={[theme.semantic.action]}
          />
        }
      >
        <ProfileIdentity
          name={profile.display_name || profile.username}
          username={profile.username}
          bio={profile.bio}
          avatarUri={profile.avatarUri}
          stats={{
            followers: stats.isPending ? '—' : (stats.data?.followers ?? 0),
            following: stats.isPending ? '—' : (stats.data?.following ?? 0),
            movies: stats.isPending ? '—' : (stats.data?.rankedMovies ?? 0),
            seasons: stats.isPending ? '—' : (stats.data?.rankedSeasons ?? 0),
          }}
          controls={
            /**
             * Share Profile and Bingd Awards, in that order and nothing else.
             *
             * Share Profile is what a profile is *for*: it is the thing you hand to
             * somebody so they can follow you, and the one action that does that
             * belongs at the top of it. Edit Profile is housekeeping and already has a
             * home behind the gear, so promoting it here made the most common act the
             * second-most prominent one.
             *
             * Awards takes the filled Maroon and Share takes the outline, which is the
             * reverse of what "primary action" would suggest and is deliberate: Share
             * is the useful one and Awards is the fun one, and a row of two identical
             * outlined buttons says neither. The fill is the only thing on this screen
             * competing with the poster wall below it, so it is spent on the control
             * that is meant to be tempting rather than on the one people already know
             * how to find.
             */
            <View style={styles.controls}>
              <View style={styles.control}>
                <Button label="Share Profile" kind="secondary" onPress={() => void shareProfile()} />
              </View>
              <View style={styles.control}>
                <Button label="Bingd Awards" onPress={() => setAwardsOpen(true)} />
              </View>
            </View>
          }
        />

        {/* Above Top ranked, below the stats. A goal is about the year in progress
            and the stats are about all time, so this is where the page stops being a
            summary and starts being about now. */}
        <GoalsSection
          userId={profile.id}
          onPressTitle={(id) => router.push(`/title/${id}`)}
        />

        <TopRanked userId={profile.id} onPressTitle={(id) => router.push(`/title/${id}`)} />

        <View style={styles.section}>
          <SectionHeader title="Recent activity" />
          {feed.isPending ? (
            <SkeletonRow count={2} />
          ) : recent.length === 0 ? (
            <EmptyState
              kind="nothingYet"
              compact
              title="Nothing here yet"
              body="Rank or log a title and it will show up here."
            />
          ) : null}
          {recent.map((event) => {
            const summary = reactions.data?.get(event.id);
            return (
              <ActivityRow
                key={event.id}
                actorName={event.actorName}
                actorAvatarUri={event.actorAvatarUri}
                verb={event.type === 'title_logged' ? 'watched' : 'ranked'}
                title={event.title}
                year={event.year}
                posterUri={posterUri(event.posterPath)}
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
                timeLabel={new Date(event.createdAt).toLocaleDateString()}
                onPressTitle={() => event.mediaItemId && router.push(`/title/${event.mediaItemId}`)}
                // The same interactions the Feed offers, because it is the same event.
                // Reading what people said about your own ranking is the point of
                // having the row here at all.
                reaction={{
                  count: summary?.total ?? 0,
                  mineGlyph: summary?.mine ? REACTION_GLYPH[summary.mine] : null,
                  glyphs: (summary?.kinds ?? []).map((kind) => REACTION_GLYPH[kind]),
                  onPress: () => void setReaction(event.id, summary?.mine ? null : 'love'),
                }}
                onPressComments={() => setCommentsFor(event.id)}
                commentCount={commentCounts.data?.get(event.id) ?? 0}
              />
            );
          })}
        </View>
      </ScrollView>

      <CommentSheet
        eventId={commentsFor}
        mediaItemId={openComments?.mediaItemId ?? null}
        title={openComments?.title ?? null}
        viewerId={profile.id}
        watched={watched.data}
        onClose={() => setCommentsFor(null)}
        onPressPerson={(handle) => {
          setCommentsFor(null);
          router.push(`/u/${handle}`);
        }}
      />

      {awardsOpen ? (
        <AwardsSheet userId={profile.id} onClose={() => setAwardsOpen(false)} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  section: { paddingTop: theme.space[5], gap: theme.space[2] },
  // Two equal halves rather than one button and a chip: they are different kinds of
  // thing and equal weight is what stops the fill reading as the only real control.
  controls: { flexDirection: 'row', gap: theme.space[2] },
  control: { flex: 1 },
});
