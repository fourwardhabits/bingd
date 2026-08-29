import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

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
  isCollectionViewMode,
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
  Button,
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
 * Which side of the Movies/TV selector this reader was last on, per account.
 *
 * Local only, and deliberately not an account preference: it describes a device
 * habit rather than something about the user, so it does not belong in a table
 * that would then have to sync, migrate and be reasoned about server-side. It
 * rides the same `readPref`/`writePref` pair the nudge already uses.
 *
 * A TV-heavy reader was reopening Collection on Movies every single time and
 * switching back by hand. Movies stays the first-ever default — a new account
 * has no habit to remember — but after that the app follows the reader.
 */
const MEDIUM_PREF_KEY = 'collection.medium';

const isMedium = (value: unknown): value is Medium =>
  value === 'movies' || value === 'tv_seasons';

/**
 * Poster or List, per account, across launches (founder §11).
 *
 * The same device-habit argument the medium preference above records, and the same
 * mechanism — `readPref`/`writePref` over the existing local store, no new native
 * dependency and no column. What differs is the default: Movies is the first-ever side
 * because a new account has no habit, and **Poster** is the first-ever mode because the
 * founder decided artwork is what a collection should open as. So an unset preference is
 * not "no opinion" here; it is an opinion the product holds until the reader overrules
 * it, at which point their choice is kept and reapplied on every launch.
 *
 * **Not to be confused with the Feed's Leaderboard toggle**, which is deliberately *not*
 * persisted (§6): Leaderboard is an alternate surface rather than a way of drawing the
 * same list, and a launch that opened on it would have replaced the homepage. The two
 * controls look alike on purpose and behave differently on purpose, and this is the
 * comment that says so on the side that does persist.
 */
const VIEW_MODE_PREF_KEY = 'collection.view-mode';

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
  /** The side a navigation asked for, if any. See the effect that applies it. */
  const { medium: mediumParam } = useLocalSearchParams<{ medium?: string }>();
  const { data: loggedSummary } = useLoggedCollection(profile.id);
  const [segment, setSegment] = useState<Segment>('watched');
  /**
   * The remembered side, tagged with the account it was read for.
   *
   * Carrying the id rather than resetting the value on sign-in is what makes a switch of
   * account correct *during the render that switches*, with no effect to fire and nothing
   * to clean up: a preference belongs to whoever it was read for, so one that does not
   * name the current reader is simply not theirs and the default stands.
   */
  const [mediumPref, setMediumPref] = useState<{ profileId: string; medium: Medium }>({
    profileId: profile.id,
    medium: 'movies',
  });
  const medium: Medium = mediumPref.profileId === profile.id ? mediumPref.medium : 'movies';
  const [nudgePref, setNudgePref] = useState<UnrankedNudgePref | null>(null);
  /**
   * Filters, sort, view mode and shuffle seed, owned here rather than by either
   * section, so they survive switching between Watched and Watchlist. A filter that
   * resets every time you glance at your watchlist is one nobody sets twice.
   */
  const [viewState, setViewState] = useState<CollectionViewState>(initialViewState);
  const [nudgePrefLoaded, setNudgePrefLoaded] = useState(false);
  /** Whether this reader has touched the selector since their preference was read. */
  const chosenMedium = useRef(false);
  /** The same guard for the view control, for the same race. */
  const chosenMode = useRef(false);

  useEffect(() => {
    readPref<UnrankedNudgePref>(`${profile.id}.${NUDGE_PREF_KEY}`)
      .then(setNudgePref)
      .catch(() => setNudgePref(null))
      .finally(() => setNudgePrefLoaded(true));
  }, [profile.id]);

  /**
   * The remembered side, applied when it arrives.
   *
   * Not gated on: the store is local and the collection is a network read, so the
   * stored side lands while the list is still a skeleton and there is nothing to
   * see flicker. `chosenMedium` is what stops a slow read from overruling a reader
   * who tapped TV in the meantime — the tap is the newer intent of the two, and a
   * preference that fights the control it came from is worse than none.
   *
   * The value is validated rather than trusted: a key left by an older build, or
   * one that failed to parse, must not put the selector in a state it cannot draw.
   */
  useEffect(() => {
    let cancelled = false;
    // The reader who touched the selector was the *previous* account. Left true, it would
    // make the incoming account's own stored side be discarded as though they had just
    // tapped the control themselves. A ref rather than state, so this costs no render.
    chosenMedium.current = false;
    readPref<unknown>(`${profile.id}.${MEDIUM_PREF_KEY}`)
      .then((stored) => {
        if (cancelled || chosenMedium.current) return;
        if (isMedium(stored)) setMediumPref({ profileId: profile.id, medium: stored });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  /**
   * **A medium asked for by whoever navigated here**, which today is See all on the
   * profile's Top ranked (2026-08-29).
   *
   * Treated as the reader's own tap rather than as a hint: it sets `chosenMedium`, so the
   * stored preference read above cannot land a moment later and overrule the side they
   * were looking at when they pressed the control. That is the precedence the selector
   * itself has, and it is the reason that ref exists.
   *
   * Validated rather than trusted, like the stored value, so a stale or hand-typed link
   * cannot put the selector in a state it has no tab for. It deliberately does **not**
   * write the preference: arriving from one control is a choice about this visit, and
   * rewriting a device habit as a side effect of navigation is not what that habit is.
   */
  useEffect(() => {
    if (!isMedium(mediumParam)) return;
    chosenMedium.current = true;
    setMediumPref({ profileId: profile.id, medium: mediumParam });
  }, [mediumParam, profile.id]);

  /**
   * The remembered view mode, applied when it arrives.
   *
   * Deliberately the same shape as the medium read above, down to the `cancelled` flag
   * and the ref reset — two preferences with one pattern rather than two patterns, so a
   * fix to one is a fix to both.
   *
   * **Poster is not written on first use**, which is what makes "no saved preference"
   * a state that survives: the default lives in `initialViewState`, and the store gains
   * a key only when the reader actually chooses. A screen that saved its own default on
   * mount could never change that default for anybody who had opened Collection once.
   *
   * A value that fails `isCollectionViewMode` — a key left by the build that spelled
   * this `wall`, or one that failed to parse — is ignored rather than applied, so an
   * older string cannot put the control in a state it has no cell for.
   */
  useEffect(() => {
    let cancelled = false;
    chosenMode.current = false;
    readPref<unknown>(`${profile.id}.${VIEW_MODE_PREF_KEY}`)
      .then((stored) => {
        if (cancelled || chosenMode.current) return;
        /**
         * **Resolved in both directions, never only on a hit.**
         *
         * `viewState` is not tagged with the account it was read for, the way
         * `mediumPref` is — it holds filters and a sort as well, and tagging the whole
         * object would mean re-deriving four things to answer a question about one. So
         * the miss has to write too: without the `else`, an account that chose List
         * would hand its mode to the next account to sign in on the same device, which
         * has no stored preference and is owed the Poster default.
         */
        const mode = isCollectionViewMode(stored) ? stored : initialViewState().mode;
        setViewState((current) => (current.mode === mode ? current : { ...current, mode }));
      })
      .catch(() => {
        /**
         * A failed read resolves to the default too, rather than to whatever was there.
         *
         * Independent review's finding: `.catch(() => {})` left the *previous account's*
         * mode standing indefinitely on a store error, which is the same cross-account
         * leak the `else` branch above exists to close — reached by the one path that
         * skipped it. A store that refuses should cost the reader their preference, not
         * hand them somebody else's.
         */
        if (cancelled || chosenMode.current) return;
        const fallback = initialViewState().mode;
        setViewState((current) =>
          current.mode === fallback ? current : { ...current, mode: fallback },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  /**
   * Every change to the view state, with the mode written through when it is the part
   * that moved.
   *
   * One handler rather than a second callback on `CollectionView`, because the component
   * owns four things in one object and splitting the mode out would mean it reporting the
   * same change twice. The comparison against the current mode is what keeps a filter tap
   * from writing the preference store — the founder's rule is that choosing List persists
   * List, not that touching the sort menu re-saves whatever mode you happen to be in.
   *
   * The write is not awaited and its failure is swallowed, exactly as the medium's is: a
   * store that refuses should cost the reader nothing more than opening on Poster next
   * time.
   */
  const changeView = (next: CollectionViewState) => {
    if (next.mode !== viewState.mode) {
      chosenMode.current = true;
      void writePref(`${profile.id}.${VIEW_MODE_PREF_KEY}`, next.mode).catch(() => {});
    }
    setViewState(next);
  };

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
   * Switching Movies and TV, forgetting Unranked when the new side has none, and
   * remembering the choice for next time.
   *
   * The derivation above already draws the right tab, so the middle line is about the
   * state rather than the pixels: without it a reader who moved to Movies (no unranked,
   * so Watched) and back to TV would silently land on Unranked again, having chosen
   * Watched in between. Falling back deterministically means falling back for good.
   *
   * The write is not awaited and its failure is swallowed. Remembering the side is a
   * convenience, and a store that refuses should cost the reader nothing more than
   * opening on Movies next time.
   */
  const changeMedium = (next: Medium) => {
    chosenMedium.current = true;
    setMediumPref({ profileId: profile.id, medium: next });
    if (segment === 'unranked' && unrankedFor(next) === 0) setSegment('watched');
    void writePref(`${profile.id}.${MEDIUM_PREF_KEY}`, next).catch(() => {});
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

      {/* **Two answers to one question, side by side.**

          The card said its piece down the left and put an X at the far right edge,
          so the two things a reader could do about it sat as far apart as the card
          allowed and only one of them looked like a control. Rank and Not now are
          now a pair, in the order the question asks them, using the same
          primary/secondary pairing the notifications screen uses for Approve and
          Decline — at the compact size that screen introduced.

          One dismissal, not two: an X *and* a Not now would be the same act offered
          twice. Dismissing hides this card only; the Unranked tab stands as long as
          anything is unranked. */}
      {active === 'watched' && showNudge ? (
        <View style={styles.nudge}>
          <Text variant="callout">You have unranked titles</Text>
          <Text variant="footnote" tone="secondary">
            Rank what you have watched to complete your Collection and improve your
            recommendations.
          </Text>
          <View style={styles.nudgeActions}>
            <Button label="Rank" size="sm" onPress={() => setSegment('unranked')} />
            <Button
              label="Not now"
              kind="secondary"
              size="sm"
              onPress={() => {
                void dismissNudge().catch(() => {});
              }}
            />
          </View>
        </View>
      ) : null}

      {active === 'watched' ? (
        <Watched userId={profile.id} medium={medium} state={viewState} onChange={changeView} />
      ) : null}
      {active === 'watchlist' ? (
        <Watchlist userId={profile.id} medium={medium} state={viewState} onChange={changeView} />
      ) : null}
      {active === 'unranked' ? (
        <Unranked userId={profile.id} medium={medium} state={viewState} onChange={changeView} />
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

  // The error said what had happened and offered nothing to do about it, on a screen with
  // no pull-to-refresh either — so a collection that failed to load stayed failed until the
  // app was killed. Both reads are retried, because either one can be the one that broke
  // and the view needs both.
  if (ranked.isError || logged.isError) {
    return (
      <EmptyState
        kind="couldNotLoad"
        title="Could not load"
        body="Check your connection and try again."
        action={{
          label: 'Try again',
          onPress: () => {
            void ranked.refetch();
            void logged.refetch();
          },
        }}
      />
    );
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
              Nothing here in {medium === 'movies' ? 'movies' : 'TV'} yet.
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
  const { data, isPending, isError, refetch } = useWatchlist(userId);
  const items = useMemo(() => watchlistItems(data ?? [], medium), [data, medium]);

  if (isError) {
    return (
      <EmptyState
        kind="couldNotLoad"
        title="Could not load"
        body="Check your connection and try again."
        action={{ label: 'Try again', onPress: () => void refetch() }}
      />
    );
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
  const { data, isPending, isError, refetch } = useLoggedCollection(userId);
  const items = useMemo(() => watchlistItems(data?.unranked ?? [], medium), [data, medium]);

  if (isError) {
    return (
      <EmptyState
        kind="couldNotLoad"
        title="Could not load"
        body="Check your connection and try again."
        action={{ label: 'Try again', onPress: () => void refetch() }}
      />
    );
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
  // A column now. As a row it put the copy and the dismissal at opposite edges,
  // which is what made them read as unrelated to each other.
  nudge: {
    marginHorizontal: theme.layout.gutter,
    marginTop: theme.space[3],
    marginBottom: theme.space[2],
    paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[3],
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.raised,
    borderColor: theme.border.hairline,
    borderWidth: StyleSheet.hairlineWidth * 2,
    gap: theme.space[2],
  },
  nudgeActions: { flexDirection: 'row', gap: theme.space[2], paddingTop: theme.space[1] },

  body: { flex: 1 },
  count: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[1],
  },
  list: { paddingBottom: theme.space[8] },
  padded: { padding: theme.layout.gutter },
});

/**
 * Whether to draw the unranked card.
 *
 * **The one re-eligibility rule: once dismissed, the card comes back only when
 * fourteen days have passed *and* the reader has ranked something since.** Both
 * halves are needed and neither is enough. Time alone would make the card a
 * fortnightly tax on somebody who has decided they are not interested; progress
 * alone would put it back the moment they ranked a single title, which is the
 * one moment they have just demonstrated they do not need telling.
 *
 * Ahead of that sit three conditions that are about the collection rather than
 * about the dismissal: there is nothing to nudge about unless this side of the
 * Movies/TV selector actually holds an unranked title, a reader with fifty
 * ranked titles has the habit and does not need the prompt, and nothing is drawn
 * before the stored preference has been read — a card that appears and then
 * vanishes is worse than one that arrives a frame late.
 *
 * `dismissCount` is recorded but is deliberately not part of the rule. It used
 * to gate a third branch that could never change the answer, because "twice
 * dismissed and no progress since" is already false under the progress test
 * below. It stays in the stored shape as a signal for whoever tunes this next.
 *
 * Dismissal hides *this card only*. The Unranked tab is drawn from
 * `unrankedCount` and is unaffected, so the state stays reachable and clearing
 * the last unranked title removes the underlying condition on its own.
 */
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

  const lastDismissedAt = new Date(pref.dismissedAt).getTime();
  const elapsedDays = (Date.now() - lastDismissedAt) / (1000 * 60 * 60 * 24);
  if (elapsedDays < NUDGE_COOLDOWN_DAYS) return false;

  return rankedCount > pref.rankedCountAtDismissal;
}

