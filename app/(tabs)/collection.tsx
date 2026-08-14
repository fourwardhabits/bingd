import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
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
import { readPref, writePref } from '@/lib/prefs';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  EmptyState,
  MediumSelector,
  Screen,
  SegmentedTabs,
  Text,
  TitleMetadata,
  TitleRow,
} from '@/ui/components';

type Segment = 'ranked' | 'watched' | 'watchlist' | 'unranked';
type Medium = RankingCategory;

type UnrankedNudgePref = {
  dismissedAt: string;
  rankedCountAtDismissal: number;
  dismissCount: number;
};

const NUDGE_PREF_KEY = 'collection.unranked-nudge';
const NUDGE_COOLDOWN_DAYS = 14;

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
  const { data: loggedSummary } = useLoggedCollection(profile.id);
  const [segment, setSegment] = useState<Segment>('ranked');
  const [medium, setMedium] = useState<Medium>('movies');
  const [nudgePref, setNudgePref] = useState<UnrankedNudgePref | null>(null);
  const [nudgePrefLoaded, setNudgePrefLoaded] = useState(false);

  useEffect(() => {
    readPref<UnrankedNudgePref>(`${profile.id}.${NUDGE_PREF_KEY}`)
      .then(setNudgePref)
      .catch(() => setNudgePref(null))
      .finally(() => setNudgePrefLoaded(true));
  }, [profile.id]);

  const unrankedCount = loggedSummary?.unranked.length ?? 0;
  const rankedCount = loggedSummary?.rankedCount ?? 0;

  const segments: { id: Segment; label: string }[] = useMemo(
    () => [
      { id: 'ranked', label: 'Ranked' },
      { id: 'watched', label: 'Watched' },
      { id: 'watchlist', label: 'Watchlist' },
      ...(unrankedCount > 0 ? [{ id: 'unranked' as const, label: 'Unranked' }] : []),
    ],
    [unrankedCount],
  );

  const showNudge = shouldShowUnrankedNudge({
    unrankedCount,
    rankedCount,
    pref: nudgePref,
    loaded: nudgePrefLoaded,
  });

  const dismissNudge = async () => {
    const next: UnrankedNudgePref = {
      dismissedAt: new Date().toISOString(),
      rankedCountAtDismissal: rankedCount,
      dismissCount: (nudgePref?.dismissCount ?? 0) + 1,
    };
    setNudgePref(next);
    await writePref(`${profile.id}.${NUDGE_PREF_KEY}`, next);
  };

  return (
    <Screen>
      <AppHeader />
      <MediumSelector
        value={medium}
        onPress={() => setMedium((value) => (value === 'movies' ? 'tv_seasons' : 'movies'))}
      />
      <SegmentedTabs options={segments} value={segment} onChange={setSegment} />

      {segment === 'ranked' && showNudge ? (
        <View style={styles.nudge}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setSegment('unranked');
            }}
            style={styles.nudgeMain}
          >
            <Text variant="footnote" tone="secondary">
              Rank a few more and your recommendations get sharper.
            </Text>
            <Text variant="callout" tone="action">
              Rank some
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void dismissNudge().catch(() => {});
            }}
            hitSlop={theme.space[2]}
          >
            <Text variant="callout" tone="tertiary">
              Not now
            </Text>
          </Pressable>
        </View>
      ) : null}

      {segment === 'ranked' ? <Ranked userId={profile.id} medium={medium} /> : null}
      {segment === 'watched' ? <Watched userId={profile.id} medium={medium} /> : null}
      {segment === 'watchlist' ? <Watchlist userId={profile.id} medium={medium} /> : null}
      {segment === 'unranked' ? <Unranked userId={profile.id} medium={medium} /> : null}
    </Screen>
  );
}

/**
 * The artifact. Titles in position order under band headers, which is how the bucket
 * partition becomes legible rather than mysterious.
 */
function Ranked({ userId, medium }: { userId: string; medium: Medium }) {
  const router = useRouter();
  const { data = [], isPending, isError } = useRankedCollection(userId, medium);

  return (
    <View style={styles.body}>
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
                    leading={
                      <Text variant="ordinal" tone="tertiary">
                        #{entry.position}
                      </Text>
                    }
                    secondary={
                      <TitleMetadata
                        runtimeMinutes={entry.runtimeMinutes}
                        genres={entry.genres}
                        showYear={false}
                      />
                    }
                    onPress={() => router.push(`/title/${entry.mediaItemId}`)}
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
function Watched({ userId, medium }: { userId: string; medium: Medium }) {
  const router = useRouter();
  const { data, isPending, isError } = useLoggedCollection(userId);

  if (isError) {
    return <EmptyState kind="couldNotLoad" title="Could not load" body="Check your connection." />;
  }
  if (isPending) return <Loading />;
  if (data.loggedCount === 0) {
    return (
      <EmptyState
        kind="nothingYet"
        title="Your watched list starts here"
        body="Log something you have seen and it lands here."
        action={{ label: 'Log a title', onPress: () => router.push('/log') }}
      />
    );
  }

  const entries = filterByMedium(data.entries, medium);

  return (
    <View style={styles.body}>
      <Text variant="footnote" tone="secondary" style={styles.count}>
        {data.rankedCount} ranked · {data.loggedCount} watched
      </Text>
      <Rows entries={entries} empty="Nothing watched yet." />
    </View>
  );
}

function Watchlist({ userId, medium }: { userId: string; medium: Medium }) {
  const { data = [], isPending, isError } = useWatchlist(userId);
  const entries = filterByMedium(data, medium);

  if (isError) {
    return <EmptyState kind="couldNotLoad" title="Could not load" body="Check your connection." />;
  }
  if (isPending) return <Loading />;

  return (
    <View style={styles.body}>
      <Rows entries={entries} empty="Nothing saved for later yet." />
    </View>
  );
}

function Unranked({ userId, medium }: { userId: string; medium: Medium }) {
  const { data, isPending, isError } = useLoggedCollection(userId);
  const entries = filterByMedium(data?.unranked ?? [], medium);
  if (isError) {
    return <EmptyState kind="couldNotLoad" title="Could not load" body="Check your connection." />;
  }
  if (isPending) return <Loading />;
  return <Rows entries={entries} empty="Everything you watched is already ranked." />;
}

function Rows({ entries, empty }: { entries: LoggedEntry[]; empty: string }) {
  const router = useRouter();
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
          secondary={
            <TitleMetadata
              bucketLabel={entry.bucket ? BAND_LABEL[entry.bucket] : null}
              runtimeMinutes={entry.runtimeMinutes}
              genres={entry.genres}
              showYear={false}
            />
          }
          trailing={
            entry.watchedOn ? (
              <Text variant="footnote" tone="tertiary">
                {new Date(`${entry.watchedOn}T00:00:00Z`).toLocaleDateString(undefined, {
                  timeZone: 'UTC',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </Text>
            ) : null
          }
          onPress={() => router.push(`/title/${entry.mediaItemId}`)}
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
  nudge: {
    marginHorizontal: theme.layout.gutter,
    marginBottom: theme.space[2],
    paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[2],
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.raised,
    borderColor: theme.border.hairline,
    borderWidth: StyleSheet.hairlineWidth * 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space[3],
  },
  nudgeMain: { gap: theme.space[1], flex: 1, minHeight: theme.layout.minTapTarget, justifyContent: 'center' },
  body: { flex: 1 },
  count: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  list: { paddingBottom: theme.space[8] },
  band: { paddingTop: theme.space[4] },
  bandHeader: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[1] },
  padded: { padding: theme.layout.gutter },
});

function shouldShowUnrankedNudge({
  unrankedCount,
  rankedCount,
  pref,
  loaded,
}: {
  unrankedCount: number;
  rankedCount: number;
  pref: UnrankedNudgePref | null;
  loaded: boolean;
}) {
  if (!loaded) return false;
  if (unrankedCount <= 0) return false;
  if (rankedCount >= 50) return false;
  if (!pref) return true;

  if (pref.dismissCount >= 2 && rankedCount <= pref.rankedCountAtDismissal) return false;

  const lastDismissedAt = new Date(pref.dismissedAt).getTime();
  const elapsedDays = (Date.now() - lastDismissedAt) / (1000 * 60 * 60 * 24);
  if (elapsedDays < NUDGE_COOLDOWN_DAYS) return false;

  return rankedCount > pref.rankedCountAtDismissal;
}

function filterByMedium(entries: LoggedEntry[], medium: Medium) {
  return entries.filter((entry) =>
    medium === 'movies' ? entry.kind === 'movie' : entry.kind === 'season' || entry.kind === 'series',
  );
}
