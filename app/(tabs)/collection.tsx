import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import {
  BAND_LABEL,
  BAND_ORDER,
  useLoggedCollection,
  useRankedCollection,
  useWatchlist,
  type LoggedEntry,
  type RankingCategory,
} from '@/features/collection/use-collection';
import { posterUri } from '@/lib/images';
import { theme } from '@/ui/tokens';
import { EmptyState, Screen, Text, TitleRow } from '@/ui/components';

type Segment = 'ranked' | 'logged' | 'watchlist';

const SEGMENTS: { id: Segment; label: string }[] = [
  { id: 'ranked', label: 'Ranked' },
  { id: 'logged', label: 'Logged' },
  { id: 'watchlist', label: 'Watchlist' },
];

/**
 * The user's own working surface (screens.md §5).
 *
 * Lists is the fourth segment in the design and is absent here: there is no list UI yet,
 * and an empty tab that cannot be filled is worse than one that has not arrived.
 *
 * Everything reads from the network. The SQLite mirror that would make a cold start on the
 * Underground show a collection rather than a spinner does not exist yet — see
 * `client.md` §3.
 */
export default function CollectionScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const [segment, setSegment] = useState<Segment>('ranked');

  return (
    <Screen>
      <View style={styles.segments} accessibilityRole="tablist">
        {SEGMENTS.map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: segment === option.id }}
            onPress={() => setSegment(option.id)}
            style={[styles.segment, segment === option.id && styles.segmentSelected]}
          >
            <Text variant="callout" tone={segment === option.id ? 'primary' : 'secondary'}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {segment === 'ranked' ? (
        <Ranked userId={profile.id} />
      ) : segment === 'logged' ? (
        <Logged userId={profile.id} onLog={() => router.push('/log')} />
      ) : (
        <Watchlist userId={profile.id} />
      )}
    </Screen>
  );
}

/**
 * The artifact. Titles in position order under band headers, which is how the bucket
 * partition becomes legible rather than mysterious.
 */
function Ranked({ userId }: { userId: string }) {
  const [category, setCategory] = useState<RankingCategory>('movies');
  const { data = [], isPending, isError } = useRankedCollection(userId, category);

  return (
    <View style={styles.body}>
      <View style={styles.categories}>
        {(
          [
            { id: 'movies', label: 'Movies' },
            { id: 'tv_seasons', label: 'TV seasons' },
          ] as const
        ).map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected: category === option.id }}
            onPress={() => setCategory(option.id)}
            hitSlop={theme.space[2]}
          >
            <Text variant="callout" tone={category === option.id ? 'action' : 'tertiary'}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {isError ? (
        <EmptyState kind="couldNotLoad" title="Could not load" body="Check your connection." />
      ) : isPending ? (
        <Loading />
      ) : data.length === 0 ? (
        <EmptyState
          kind="nothingYet"
          title="Nothing ranked yet"
          body="Log something and choose “Find where it lands” to give it a position."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {BAND_ORDER.map((band) => {
            const inBand = data.filter((entry) => entry.bucket === band);
            if (inBand.length === 0) return null;

            return (
              <View key={band} style={styles.band}>
                <Text variant="caption" tone="tertiary" style={styles.bandHeader}>
                  {BAND_LABEL[band].toUpperCase()}
                </Text>
                {inBand.map((entry) => (
                  <TitleRow
                    key={entry.mediaItemId}
                    title={entry.title}
                    year={entry.year}
                    posterUri={posterUri(entry.posterPath)}
                    position={entry.position}
                    category={category === 'movies' ? 'Movies' : 'TV seasons'}
                  />
                ))}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * Watched, without a position.
 *
 * The header states the split plainly and offers a way to rank a few. There is no progress
 * bar and no "380 remaining": PRD §5 is explicit that someone importing 800 films must not
 * open this tab and feel behind.
 */
function Logged({ userId, onLog }: { userId: string; onLog: () => void }) {
  const { data, isPending, isError } = useLoggedCollection(userId);

  if (isError) {
    return <EmptyState kind="couldNotLoad" title="Could not load" body="Check your connection." />;
  }
  if (isPending) return <Loading />;
  if (data.loggedCount === 0) {
    return (
      <EmptyState
        kind="nothingYet"
        title="Your collection starts here"
        body="Log something you have seen and it lands here, whether or not you rank it."
        action={{ label: 'Log a title', onPress: onLog }}
      />
    );
  }

  return (
    <View style={styles.body}>
      <Text variant="footnote" tone="secondary" style={styles.count}>
        {data.rankedCount} ranked · {data.loggedCount} logged
      </Text>
      <Rows entries={data.unranked} empty="Everything you have logged has a position." />
    </View>
  );
}

function Watchlist({ userId }: { userId: string }) {
  const { data = [], isPending, isError } = useWatchlist(userId);

  if (isError) {
    return <EmptyState kind="couldNotLoad" title="Could not load" body="Check your connection." />;
  }
  if (isPending) return <Loading />;

  return (
    <View style={styles.body}>
      <Rows entries={data} empty="Nothing saved for later yet." />
    </View>
  );
}

function Rows({ entries, empty }: { entries: LoggedEntry[]; empty: string }) {
  if (entries.length === 0) {
    return (
      <View style={styles.padded}>
        <Text variant="body" tone="tertiary">
          {empty}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {entries.map((entry) => (
        <TitleRow
          key={entry.mediaItemId}
          title={entry.title}
          year={entry.year}
          posterUri={posterUri(entry.posterPath)}
          bucketLabel={entry.bucket ? BAND_LABEL[entry.bucket] : undefined}
        />
      ))}
    </ScrollView>
  );
}

function Loading() {
  return (
    <View style={styles.padded}>
      <Text variant="body" tone="tertiary">
        Loading…
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  segments: {
    flexDirection: 'row',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[3],
  },
  segment: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
  },
  segmentSelected: { backgroundColor: theme.surface.sunken },
  categories: {
    flexDirection: 'row',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[2],
  },
  body: { flex: 1 },
  count: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  list: { paddingBottom: theme.space[8] },
  band: { paddingTop: theme.space[4] },
  bandHeader: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[1] },
  padded: { padding: theme.layout.gutter },
});
