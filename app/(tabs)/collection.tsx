import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { bandSizes, scoreFor, type Bucket } from '@/features/collection/score';
import {
  useLoggedCollection,
  useRankedCollection,
  useWatchlist,
  type LoggedEntry,
  type RankedEntry,
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
  ScoreBadge,
  SegmentedTabs,
  SkeletonRow,
  Text,
  TitleMetadata,
  TitleRow,
} from '@/ui/components';

type Segment = 'watched' | 'watchlist' | 'unranked';
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
 * Ranked and Watched used to be separate tabs and were largely the same list:
 * almost everything a user logs, they also rank. Two tabs that mostly agree
 * force a choice with no meaning behind it. They are now one Watched list
 * sorted by score, which reproduces the old Ranked tab exactly — score order
 * *is* position order — while also containing the unranked titles, each showing
 * a dashed Rank badge instead of a number. Unranked survives as a filter of that
 * list rather than as a different list.
 *
 * Lists is the fourth segment in the design and is absent here: there is no list
 * UI yet, and an empty tab that cannot be filled is worse than one that has not
 * arrived.
 *
 * Everything reads from the network. The SQLite mirror that would make a cold
 * start on the Underground show a collection rather than a skeleton does not
 * exist yet — see `client.md` §3.
 */
export default function CollectionScreen() {
  const profile = useCurrentProfile();
  const { data: loggedSummary } = useLoggedCollection(profile.id);
  const [segment, setSegment] = useState<Segment>('watched');
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
      { id: 'watched', label: 'Watched' },
      { id: 'watchlist', label: 'Watchlist' },
      // Conditional: a tab that is empty for most users is a permanent reminder
      // of a chore nobody agreed to.
      ...(unrankedCount > 0 ? [{ id: 'unranked' as const, label: 'Unranked' }] : []),
    ],
    [unrankedCount],
  );

  // Ranking the last unranked title removes the tab the user may be standing
  // on. Derived rather than corrected in an effect: the fallback then applies
  // in the same render the tab disappears, instead of one frame later with a
  // blank list in between.
  const active: Segment = segment === 'unranked' && unrankedCount === 0 ? 'watched' : segment;

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
      <MediumSelector value={medium} onChange={setMedium} />
      <SegmentedTabs options={segments} value={active} onChange={setSegment} />

      {active === 'watched' && showNudge ? (
        <View style={styles.nudge}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSegment('unranked')}
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

      {active === 'watched' ? <Watched userId={profile.id} medium={medium} /> : null}
      {active === 'watchlist' ? <Watchlist userId={profile.id} medium={medium} /> : null}
      {active === 'unranked' ? <Unranked userId={profile.id} medium={medium} /> : null}
    </Screen>
  );
}

/**
 * One list: everything watched, best first.
 *
 * Ranked titles sort by score and unranked ones fall to the bottom, which puts
 * the list in the order the user built and leaves the work still to do in one
 * place at the end. Both come from queries that were already being made — the
 * ranked list for the positions, the logged list for the rest — so the merge
 * costs nothing.
 *
 * No band headers. LOVED IT / IT WAS FINE / NOT FOR ME made the bucket
 * partition legible back when the only number on a row was an ordinal that said
 * nothing about how much the user liked something. The score says it, and the
 * badge is tinted by bucket, so the headers would now caption information
 * already present twice on every row.
 */
function Watched({ userId, medium }: { userId: string; medium: Medium }) {
  const router = useRouter();
  const ranked = useRankedCollection(userId, medium);
  const logged = useLoggedCollection(userId);

  const rows = useMemo(
    () => mergeWatched(ranked.data ?? [], logged.data?.unranked ?? [], medium),
    [ranked.data, logged.data, medium],
  );

  if (ranked.isError || logged.isError) {
    return <EmptyState kind="couldNotLoad" title="Could not load" body="Check your connection." />;
  }
  if (ranked.isPending || logged.isPending) return <Loading />;

  if (logged.data.loggedCount === 0) {
    return (
      <EmptyState
        kind="nothingYet"
        title="Your watched list starts here"
        body="Log something you have seen and it lands here."
        action={{ label: 'Log a title', onPress: () => router.push('/log') }}
      />
    );
  }

  return (
    <View style={styles.body}>
      <Text variant="footnote" tone="secondary" style={styles.count}>
        {logged.data.rankedCount} ranked · {logged.data.loggedCount} watched
      </Text>

      {rows.length === 0 ? (
        <View style={styles.padded}>
          <Text variant="body" tone="tertiary">
            Nothing here in {medium === 'movies' ? 'movies' : 'TV seasons'} yet.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {rows.map((row) => (
            <TitleRow
              key={row.mediaItemId}
              title={row.title}
              year={row.year}
              posterUri={posterUri(row.posterPath)}
              secondary={
                <TitleMetadata
                  runtimeMinutes={row.runtimeMinutes}
                  genres={row.genres}
                  showYear={false}
                />
              }
              trailing={
                <ScoreBadge
                  score={row.score}
                  bucket={row.bucket}
                  onPress={() => router.push(`/title/${row.mediaItemId}`)}
                />
              }
              onPress={() => router.push(`/title/${row.mediaItemId}`)}
            />
          ))}
        </ScrollView>
      )}
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

/** The plain list, for the tabs that carry no score. */
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
              runtimeMinutes={entry.runtimeMinutes}
              genres={entry.genres}
              showYear={false}
            />
          }
          trailing={
            <ScoreBadge onPress={() => router.push(`/title/${entry.mediaItemId}`)} />
          }
          onPress={() => router.push(`/title/${entry.mediaItemId}`)}
        />
      ))}
    </ScrollView>
  );
}

function Loading() {
  return (
    <View style={styles.body}>
      <SkeletonRow count={7} />
    </View>
  );
}

type WatchedRow = {
  mediaItemId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  score: number | null;
  bucket: Bucket | null;
};

/**
 * Ranked titles by score, then the unranked ones.
 *
 * Band sizes are computed from the *whole* category before filtering by medium,
 * which is not an optimisation to skip: `useRankedCollection` is already scoped
 * to one category, and a score is only meaningful against every title in its
 * band. Narrowing the input first would rescale everything.
 */
function mergeWatched(
  ranked: RankedEntry[],
  unranked: LoggedEntry[],
  medium: Medium,
): WatchedRow[] {
  const sizes = bandSizes(ranked);

  const scored: WatchedRow[] = ranked.map((entry) => ({
    mediaItemId: entry.mediaItemId,
    title: entry.title,
    year: entry.year,
    posterPath: entry.posterPath,
    genres: entry.genres,
    runtimeMinutes: entry.runtimeMinutes,
    score: scoreFor(entry.bucket, entry.position, sizes),
    bucket: entry.bucket,
  }));

  const rest: WatchedRow[] = filterByMedium(unranked, medium).map((entry) => ({
    mediaItemId: entry.mediaItemId,
    title: entry.title,
    year: entry.year,
    posterPath: entry.posterPath,
    genres: entry.genres,
    runtimeMinutes: entry.runtimeMinutes,
    score: null,
    bucket: null,
  }));

  // Already in position order from the query, which is score order. Sorting
  // again would only introduce a way for the two to disagree.
  return [...scored, ...rest];
}

const styles = StyleSheet.create({
  nudge: {
    marginHorizontal: theme.layout.gutter,
    marginTop: theme.space[3],
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
  nudgeMain: {
    gap: theme.space[1],
    flex: 1,
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
  },
  body: { flex: 1 },
  count: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[1],
  },
  list: { paddingBottom: theme.space[8] },
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
