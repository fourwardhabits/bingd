import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Alert, ScrollView, Share, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { bandSizes, scoreFor } from '@/features/collection/score';
import {
  useLoggedCollection,
  useRankedCollection,
  useWatchlist,
} from '@/features/collection/use-collection';
import { useFeed } from '@/features/feed/use-feed';
import { posterUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { theme } from '@/ui/tokens';
import {
  ActivityRow,
  AppHeader,
  Avatar,
  Button,
  EmptyState,
  PosterGrid,
  Screen,
  SectionHeader,
  SkeletonRow,
  StatRow,
  Text,
} from '@/ui/components';

/** The public identity page: stats, match, leaderboard, and the Top 10 that
 *  feeds the share card (PRD §16). */
export default function ProfileScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const ranked = useRankedCollection(profile.id, 'movies');
  const logged = useLoggedCollection(profile.id);
  const watchlist = useWatchlist(profile.id);
  const feed = useFeed(profile.id);
  const follows = useQuery({
    queryKey: ['profile-follows', profile.id],
    queryFn: async () => {
      const [{ count: followers, error: followersError }, { count: following, error: followingError }] =
        await Promise.all([
          supabase
            .from('follows')
            .select('*', { count: 'exact', head: true })
            .eq('followee_id', profile.id)
            .eq('state', 'approved'),
          supabase
            .from('follows')
            .select('*', { count: 'exact', head: true })
            .eq('follower_id', profile.id)
            .eq('state', 'approved'),
        ]);
      if (followersError) throw followersError;
      if (followingError) throw followingError;
      return { followers: followers ?? 0, following: following ?? 0 };
    },
  });

  // Six, so the wall is two full rows of three. Three was a leftover from when
  // this was a list, and a single row of a three-column grid reads as a stub.
  const top = ranked.data?.slice(0, 6) ?? [];
  // Band sizes come from the whole ranking, not the slice: a score is only
  // meaningful against every title in its band, so scoring the top six against
  // themselves would give all six a 10.
  const sizes = bandSizes(ranked.data ?? []);
  // Own activity only. The feed query spans everyone this user follows, and a
  // friend's ranking under a heading on *your* profile is a different claim.
  const recent = (feed.data ?? []).filter((event) => event.actorId === profile.id).slice(0, 3);
  const shareProfile = async () => {
    const url = `https://bingd.app/u/${profile.username}`;
    try {
      await Share.share({ message: url, url });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sharing failed.';
      Alert.alert('Could not share profile', message);
    }
  };

  return (
    <Screen>
      <AppHeader right={<Button label="Settings" kind="tertiary" onPress={() => router.push('/settings')} />} />
      <ScrollView contentContainerStyle={styles.content}>
        {/* A social profile leads with a face, at a size that reads as one. The
            stacked, centred version put a 44pt avatar above three centred lines and
            spent the whole first viewport saying very little.
            "Movie and TV collector" used to sit here. Nobody wrote it — there is no
            `profiles.bio` column — and a hardcoded phrase in the place a bio goes
            reads as something the user chose. Blank until there is a real one. */}
        <View style={styles.identity}>
          <Avatar size="lg" uri={profile.avatarUri} name={profile.display_name || profile.username} />
          <View style={styles.identityCopy}>
            <Text variant="title2" numberOfLines={1}>
              {profile.display_name || profile.username}
            </Text>
            <Text variant="footnote" tone="secondary" numberOfLines={1}>
              @{profile.username}
            </Text>
          </View>
        </View>

        <StatRow
          stats={[
            { label: 'Followers', value: follows.isPending ? '—' : follows.data?.followers ?? 0 },
            { label: 'Following', value: follows.isPending ? '—' : follows.data?.following ?? 0 },
            { label: 'Ranked', value: logged.isPending ? '—' : logged.data?.rankedCount ?? 0 },
            { label: 'Watched', value: logged.isPending ? '—' : logged.data?.loggedCount ?? 0 },
            // Was `top.length` — the length of the top-six slice — so it read 6
            // for anyone with six rankings and nothing on their watchlist.
            {
              label: 'Watchlist',
              value: watchlist.isPending ? '—' : watchlist.data?.length ?? 0,
            },
          ]}
        />
        <View style={styles.share}>
          <Button label="Share profile" kind="secondary" onPress={() => void shareProfile()} />
        </View>

        <View style={styles.section}>
          {ranked.isPending ? (
            <>
              <SectionHeader title="Top ranked" />
              <SkeletonRow count={3} />
            </>
          ) : top.length === 0 ? (
            <>
              <SectionHeader title="Top ranked" />
              <EmptyState
                kind="nothingYet"
                title="No rankings yet"
                body="Log and rank a few titles to build your profile."
              />
            </>
          ) : (
            // A wall rather than rows. This is the one block on the profile
            // that exists to be looked at rather than worked through, and rows
            // carrying runtime and genre give a visitor metadata they did not
            // ask for while making the films themselves small.
            <PosterGrid
              title="Top ranked"
              tiles={top.map((entry) => ({
                id: entry.mediaItemId,
                title: entry.title,
                year: entry.year,
                posterUri: posterUri(entry.posterPath, 'card'),
                score: scoreFor(entry.bucket, entry.position, sizes),
                bucket: entry.bucket,
              }))}
              onPressTile={(tile) => router.push(`/title/${tile.id}`)}
            />
          )}
        </View>

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
          {recent.map((event) => (
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
              timeLabel={new Date(event.createdAt).toLocaleDateString()}
              onPressTitle={() => event.mediaItemId && router.push(`/title/${event.mediaItemId}`)}
            />
          ))}
        </View>

        {logged.isError ? (
          <EmptyState
            kind="couldNotLoad"
            title="Could not load profile stats"
            body="Check your connection and try again."
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: theme.space[10],
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    paddingBottom: theme.space[4],
  },
  // Name over handle, both hard against the avatar's right edge, so the block has
  // one left margin rather than a centred axis of its own.
  identityCopy: { flex: 1, gap: 2 },
  share: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  section: {
    paddingTop: theme.space[5],
    gap: theme.space[2],
  },
  sectionHeader: { paddingHorizontal: theme.layout.gutter },
});
