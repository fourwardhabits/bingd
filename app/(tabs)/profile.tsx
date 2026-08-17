
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { CommentSheet } from '@/features/feed/CommentSheet';
import { useCommentCounts } from '@/features/feed/use-comments';
import { useReactions, useSetReaction, REACTION_GLYPH } from '@/features/feed/use-reactions';
import { useFeed } from '@/features/feed/use-feed';
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
 * one gets Edit Profile and Settings, the other gets Follow and a Taste Match.
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
  const [commentsFor, setCommentsFor] = useState<string | null>(null);

  // Own activity only. The feed query spans everyone this user follows, and a
  // friend's ranking under a heading on *your* profile is a different claim.
  const recent = (feed.data ?? []).filter((event) => event.actorId === profile.id).slice(0, 5);
  const eventIds = recent.map((event) => event.id);
  const reactions = useReactions(eventIds, profile.id);
  const commentCounts = useCommentCounts(eventIds, profile.id);
  const { setReaction } = useSetReaction(profile.id);
  const openComments = commentsFor ? (recent.find((e) => e.id === commentsFor) ?? null) : null;

  return (
    <Screen>
      <AppHeader
        right={
          <Button label="Settings" kind="tertiary" onPress={() => router.push('/settings')} />
        }
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
            // The two things only the owner can do. Share moved out of the identity
            // block: it is an action on the page rather than part of who this is, and
            // it was the loudest control in a group whose job is to say a name.
            <Button
              label="Edit Profile"
              kind="secondary"
              onPress={() => router.push('/settings/profile')}
            />
          }
        />

        {/* Above Top ranked, below the stats. A goal is about the year in progress
            and the stats are about all time, so this is where the page stops being a
            summary and starts being about now. */}
        <GoalsSection userId={profile.id} />

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
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  section: { paddingTop: theme.space[5], gap: theme.space[2] },
});
