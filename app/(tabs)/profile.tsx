import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Alert, ScrollView, Share, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { useLoggedCollection, useRankedCollection } from '@/features/collection/use-collection';
import { useFeed } from '@/features/feed/use-feed';
import { posterUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { theme } from '@/ui/tokens';
import { ActivityCard, AppHeader, Avatar, Button, EmptyState, Screen, StatRow, Text, TitleRow } from '@/ui/components';

/** The public identity page: stats, match, leaderboard, and the Top 10 that
 *  feeds the share card (PRD §16). */
export default function ProfileScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const ranked = useRankedCollection(profile.id, 'movies');
  const logged = useLoggedCollection(profile.id);
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

  const top = ranked.data?.slice(0, 3) ?? [];
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
        <View style={styles.identity}>
          <Avatar size="md" uri={profile.avatar_url ?? null} name={profile.display_name || profile.username} />
          <Text variant="title2">{profile.display_name || profile.username}</Text>
          <Text variant="footnote" tone="secondary">
            @{profile.username}
          </Text>
          <Text variant="footnote" tone="tertiary">Movie and TV collector</Text>
        </View>

        <StatRow
          stats={[
            { label: 'Followers', value: follows.isPending ? '—' : follows.data?.followers ?? 0 },
            { label: 'Following', value: follows.isPending ? '—' : follows.data?.following ?? 0 },
            { label: 'Ranked', value: logged.isPending ? '—' : logged.data?.rankedCount ?? 0 },
            { label: 'Watched', value: logged.isPending ? '—' : logged.data?.loggedCount ?? 0 },
            { label: 'Watchlist', value: ranked.isPending ? '—' : top.length },
          ]}
        />
        <View style={styles.share}>
          <Button label="Share profile" kind="secondary" onPress={() => void shareProfile()} />
        </View>

        <View style={styles.section}>
          <Text variant="subhead" tone="tertiary">
            TOP RANKED
          </Text>
          {ranked.isPending ? (
            <Text variant="body" tone="tertiary">
              Loading your rankings…
            </Text>
          ) : top.length === 0 ? (
            <EmptyState
              kind="nothingYet"
              title="No rankings yet"
              body="Log and rank a few titles to build your profile."
            />
          ) : (
            top.map((entry) => (
              <TitleRow
                key={entry.mediaItemId}
                title={entry.title}
                year={entry.year}
                posterUri={posterUri(entry.posterPath)}
                leading={
                  <Text variant="ordinal" tone="tertiary">
                    #{entry.position}
                  </Text>
                }
                onPress={() => router.push(`/title/${entry.mediaItemId}`)}
              />
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text variant="subhead" tone="tertiary" style={styles.sectionHeader}>
            RECENT ACTIVITY
          </Text>
          {(feed.data ?? []).slice(0, 3).map((event) => (
            <ActivityCard
              key={event.id}
              actorName={event.actorName}
              actorAvatarUri={event.actorAvatarUri}
              sentence={`${event.actorName} ${event.type === 'title_logged' ? 'watched' : 'ranked'} ${event.title ?? 'a title'}.`}
              posterUri={posterUri(event.posterPath)}
              timeLabel={new Date(event.createdAt).toLocaleDateString()}
              onPress={() => event.mediaItemId && router.push(`/title/${event.mediaItemId}`)}
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
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[4],
    gap: theme.space[2],
  },
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
