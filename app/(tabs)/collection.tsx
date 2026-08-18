import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import {
  useLoggedCollection,
  useRankedCollection,
  useWatchlist,
  type RankingCategory,
} from '@/features/collection/use-collection';
import {
  CollectionView,
  initialViewState,
  type CollectionViewState,
} from '@/features/collection/CollectionView';
import {
  filterByMedium,
  watchedItems,
  watchlistItems,
} from '@/features/collection/watched-rows';
import { readPref, writePref } from '@/lib/prefs';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  HeaderBoundary,
  EmptyState,
  MediumSelector,
  Screen,
  SegmentedTabs,
  SkeletonRow,
  Text,
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
  /**
   * Filters, sort, view mode and shuffle seed, owned here rather than by either
   * section, so they survive switching between Watched and Watchlist. A filter that
   * resets every time you glance at your watchlist is one nobody sets twice.
   */
  const [viewState, setViewState] = useState<CollectionViewState>(initialViewState);
  const [nudgePrefLoaded, setNudgePrefLoaded] = useState(false);

  useEffect(() => {
    readPref<UnrankedNudgePref>(`${profile.id}.${NUDGE_PREF_KEY}`)
      .then(setNudgePref)
      .catch(() => setNudgePref(null))
      .finally(() => setNudgePrefLoaded(true));
  }, [profile.id]);

  /**
   * Unranked titles **in the category being looked at**, which is the fix.
   *
   * The founder found it on the device: Movies showed an Unranked tab because a *TV
   * season* was unranked. `loggedSummary.unranked` spans the whole collection, and the
   * tab was drawn from its length — so one unranked season put an Unranked tab on the
   * Movies list, and tapping it produced an empty one, because the list underneath has
   * always filtered by medium (`watchlistItems(…, medium)`).
   *
   * The tab and the list it opens now ask the same question, through the same helper.
   * `filterByMedium` is the single definition of what belongs to which side — including
   * that a series counts as TV — so the two cannot drift apart again.
   */
  const unrankedFor = (which: Medium) =>
    filterByMedium(loggedSummary?.unranked ?? [], which).length;
  const unrankedCount = unrankedFor(medium);
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

  // Ranking the last unranked title — or switching to a category with none — removes
  // the tab the user may be standing on. Derived rather than corrected in an effect:
  // the fallback applies in the same render the tab disappears, instead of one frame
  // later with a blank list in between. Watched, always, because it is the one segment
  // that is never absent.
  const active: Segment = segment === 'unranked' && unrankedCount === 0 ? 'watched' : segment;

  /**
   * Switching Movies and TV, and forgetting Unranked when the new side has none.
   *
   * The derivation above already draws the right tab, so this is about the state rather
   * than the pixels: without it a reader who moved to Movies (no unranked, so Watched)
   * and back to TV would silently land on Unranked again, having chosen Watched in
   * between. Falling back deterministically means falling back for good.
   */
  const changeMedium = (next: Medium) => {
    setMedium(next);
    if (segment === 'unranked' && unrankedFor(next) === 0) setSegment('watched');
  };

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
      <MediumSelector value={medium} onChange={changeMedium} />
      <SegmentedTabs options={segments} value={active} onChange={setSegment} />
      {/* Beneath the Movies/TV and Watched/Watchlist controls, which are both
          navigation: the same seam Feed and Log use, in the analogous place. The
          information architecture is untouched. */}
      <HeaderBoundary />

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

      {active === 'watched' ? (
        <Watched userId={profile.id} medium={medium} state={viewState} onChange={setViewState} />
      ) : null}
      {active === 'watchlist' ? (
        <Watchlist userId={profile.id} medium={medium} state={viewState} onChange={setViewState} />
      ) : null}
      {active === 'unranked' ? (
        <Unranked userId={profile.id} medium={medium} state={viewState} onChange={setViewState} />
      ) : null}
    </Screen>
  );
}

/**
 * Everything watched, through the shared view.
 *
 * The list order, the filters and the List/Wall choice all live one level up in
 * `viewState`, so they survive a switch to Watchlist and back — which is what makes
 * a filter worth setting at all.
 */
function Watched({
  userId,
  medium,
  state,
  onChange,
}: {
  userId: string;
  medium: Medium;
  state: CollectionViewState;
  onChange: (next: CollectionViewState) => void;
}) {
  const router = useRouter();
  const ranked = useRankedCollection(userId, medium);
  const logged = useLoggedCollection(userId);

  const items = useMemo(
    () => watchedItems(ranked.data ?? [], logged.data?.unranked ?? [], medium),
    [ranked.data, logged.data, medium],
  );

  if (ranked.isError || logged.isError) {
    return <EmptyState kind="couldNotLoad" title="Could not load" body="Check your connection." />;
  }
  if (ranked.isPending || logged.isPending) return <Loading />;

  return (
    <CollectionView
      items={items}
      segment="watched"
      state={state}
      onChange={onChange}
      onPressItem={(id) => router.push(`/title/${id}`)}
      empty={
        logged.data.loggedCount === 0 ? (
          <EmptyState
            kind="nothingYet"
            title="Your watched list starts here"
            body="Log something you have seen and it lands here."
            action={{ label: 'Log a title', onPress: () => router.push('/log') }}
          />
        ) : (
          <View style={styles.padded}>
            <Text variant="body" tone="tertiary">
              Nothing here in {medium === 'movies' ? 'movies' : 'TV seasons'} yet.
            </Text>
          </View>
        )
      }
    />
  );
}

function Watchlist({
  userId,
  medium,
  state,
  onChange,
}: {
  userId: string;
  medium: Medium;
  state: CollectionViewState;
  onChange: (next: CollectionViewState) => void;
}) {
  const router = useRouter();
  const { data, isPending, isError } = useWatchlist(userId);
  const items = useMemo(() => watchlistItems(data ?? [], medium), [data, medium]);

  if (isError) {
    return <EmptyState kind="couldNotLoad" title="Could not load" body="Check your connection." />;
  }
  if (isPending) return <Loading />;

  return (
    <CollectionView
      items={items}
      segment="watchlist"
      state={state}
      onChange={onChange}
      onPressItem={(id) => router.push(`/title/${id}`)}
      empty={
        <EmptyState
          kind="nothingYet"
          compact
          title="Nothing saved for later yet."
          body="Watchlist a title and it lands here."
        />
      }
    />
  );
}

/** Watched, but without a position yet. Same view, no score to sort by. */
function Unranked({
  userId,
  medium,
  state,
  onChange,
}: {
  userId: string;
  medium: Medium;
  state: CollectionViewState;
  onChange: (next: CollectionViewState) => void;
}) {
  const router = useRouter();
  const { data, isPending, isError } = useLoggedCollection(userId);
  const items = useMemo(() => watchlistItems(data?.unranked ?? [], medium), [data, medium]);

  if (isError) {
    return <EmptyState kind="couldNotLoad" title="Could not load" body="Check your connection." />;
  }
  if (isPending) return <Loading />;

  return (
    <CollectionView
      items={items}
      segment="unranked"
      state={state}
      onChange={onChange}
      onPressItem={(id) => router.push(`/title/${id}`)}
      empty={
        <EmptyState
          kind="nothingYet"
          compact
          title="Everything you watched is already ranked."
          body="Nothing waiting here."
        />
      }
    />
  );
}

function Loading() {
  return (
    <View style={styles.body}>
      <SkeletonRow count={7} />
    </View>
  );
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

