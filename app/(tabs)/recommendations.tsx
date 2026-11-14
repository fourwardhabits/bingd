import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { CollectionFilterSheet } from '@/features/collection/CollectionFilterSheet';
import {
  applyFilters,
  emptyFilters,
  isFiltered,
  activeFilterCount,
  type CollectionFilters,
} from '@/features/collection/filters';
import { useLoggedCollection, useWatchlist } from '@/features/collection/use-collection';
import { useMyScores, type MyScore } from '@/features/collection/use-score';
import { mustReconcile, newOperationId, setWatchlist } from '@/features/collection/writes';
import { SLATE_SIZE } from '@/features/recommendations/rank';
import { RecommendationRequestsSheet } from '@/features/recommendations/RecommendationRequestsSheet';
import { ForYouShortcuts } from '@/features/recommendations/ForYouShortcuts';
import { RequestAlertRow } from '@/features/recommendations/RequestAlertRow';
import {
  useRecommendationRequests,
  useSweepIntent,
} from '@/features/recommendations/use-recommendation-requests';
import { GroupPicksSheet } from '@/features/recommendations/GroupPicksSheet';
import { ForYouList, type ForYouListTile } from '@/features/recommendations/ForYouList';
import { SentToYouList } from '@/features/recommendations/SentToYouList';
import { useMarkSentSeen } from '@/features/recommendations/use-mark-sent-seen';
import {
  refreshRecommendations,
  useRecommendationArrangement,
} from '@/features/recommendations/session-seed';
import { useDismissTitle } from '@/features/recommendations/use-dismissed';
import {
  MAX_PAGES,
  useForYou,
  type Medium,
} from '@/features/recommendations/use-for-you';
import {
  TOP_RATED_FILTER_PAGES,
  TOP_RATED_PAGE,
  useTopRated,
  type TopRatedItem,
} from '@/features/recommendations/use-top-rated';
import {
  asCollectionItem as recommendationAsItem,
  sentShortcutBadge,
  useMarkRecommendationOpened,
  useSentToYou,
  type SentRecommendation,
} from '@/features/recommendations/use-sent-to-you';
import {
  seedFromSentToYou,
  titleRecommendationsKey,
} from '@/features/recommendations/use-title-recommendations';
import { mediaKindFor, track } from '@/lib/analytics';
import { readPref, writePref } from '@/lib/prefs';
import { posterUri } from '@/lib/images';
import { invalidateAfterWatchlistChange } from '@/features/collection/invalidate';
import { useTabReset } from '@/ui/use-tab-reset';
import { theme } from '@/ui/tokens';
import {
  AppHeader,
  BrowseControlsRow,
  EmptyState,
  FilterIconButton,
  HeaderBoundary,
  PosterGrid,
  Screen,
  MediumSelector,
  type MediumSelectorOption,
  type PosterTile,
  SkeletonGrid,
  SkeletonRow,
  Text,
  ViewModeToggle,
  type ViewMode,
} from '@/ui/components';
import { CompactSwitch, type CompactSwitchOption } from '@/ui/components/CompactSwitch';

/**
 * For You, rebuilt to the shape of Collection (founder pass, 2026-08-17).
 *
 * What it looked like before: a Movies/TV segmented row *under* a For you / Sent to you
 * row, then a heading that said "For you" again, then "Based on your taste", then
 * "Inspired by Inception, Heat + more", and only then artwork. Four bands of prose in
 * front of a wall whose entire proposition is the artwork.
 *
 * All four are gone. The founder's rule is the one Collection already follows: category
 * across the top, one filter row, then straight into the wall. A screen called For you,
 * reached from a tab called For you, does not need a heading that says For you, and the
 * claim underneath it was a sentence nobody read twice.
 *
 * **Sent to you is a filter, not a tab.** It sat as a peer of the whole engine, which
 * made the top of the screen a two-level navigation for one wall. As the first chip in
 * the filter row it is what it always was, a narrowing of "things to watch" down to
 * "things people sent me", and the other chips keep working across it, which is what
 * makes "Comedy, from friends" a thing anybody can ask for.
 *
 * **The filters are one state across everything**, deliberately. Choosing Comedy is a
 * statement about what the reader is in the mood for, not about which list they happen
 * to be looking at. Nothing about filtering touches a recommendation record: it narrows
 * what is drawn and that is all.
 *
 * For You is a wall of artwork; Sent to you is a list. See `SentToYouList` for why they
 * differ.
 *
 * ---------------------------------------------------------------------------
 * **PEOPLE IS NO LONGER HERE** (founder §A16, 2026-09-08)
 *
 * It was the third option in the category selector, on the argument that For You answers
 * "what next" and the honest answer is sometimes a person. That argument was about
 * *discovery*; the founder's pre-distribution pass is about *activation*, which is a
 * different problem with a different answer. Somebody who has just joined does not open a
 * recommendations screen looking for their friends, and People behind a dropdown here was
 * never going to be where a social graph gets built.
 *
 * So People is a mode of the Feed tab — the tab that is already about other people — beside
 * Feed and Leaderboard, and this screen is titles and watch discovery only. `peopleDiscovery`
 * is the route that says so; both surfaces that used to send somebody here for People now
 * send them there instead, and neither of them had to know that this screen changed.
 *
 * What did **not** move: Sent to you, Group Picks, the filters and the recommendation
 * requests. Those are all about titles, which is what this screen now exclusively is.
 */
export default function RecommendationsScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();

  /**
   * **Where the reader is**: `medium`, the side of the *personalised* wall, and
   * `topMedium`, the side of **Top Rated** or null when they are not on it.
   *
   * Two fields rather than one four-valued `mode`, and the reason is the same one that
   * used to hold People apart from `medium` (§A16, since removed): a glance at Top Rated
   * must not move the personalised slate's query or throw away the page depth somebody
   * scrolled. Holding the two separately means Movies → Top Rated Movies → Movies costs
   * the personalised wall nothing at all, and the selector's value is derived from both
   * so the control cannot disagree with either.
   *
   * **Remembered per account, across launches** (founder, 2026-11-12). This replaces the
   * earlier decision that For You is a question asked fresh each visit: For You reopens
   * where the reader left it, the way Collection reopens on its side. Both fields are
   * kept, so Top Rated TV over a Movies personalised wall comes back as exactly that, and a
   * re-press of the tab afterwards lands on the Movies wall it was opened from. A new
   * account opens on Movies / Recommended. See `FOR_YOU_SELECTION_PREF_KEY`.
   *
   * Tagged with the account it was set for, as Collection's `mediumPref` is, so an
   * account switch is correct during the render that switches: a selection that does not
   * name the current reader is not theirs, and the default stands until their own read
   * lands — never the previous account's Top Rated, not even for a frame.
   */
  const [selection, setSelection] = useState<{ profileId: string } & ForYouSelection>(() => ({
    profileId: profile.id,
    ...DEFAULT_FOR_YOU_SELECTION,
  }));
  const { medium, topMedium } =
    selection.profileId === profile.id ? selection : DEFAULT_FOR_YOU_SELECTION;
  /**
   * Whether this reader has acted on the selection since their stored one was read. The
   * guard Collection uses: a tap is newer intent than a slow read, so the read stands down.
   */
  const chosenSelection = useRef(false);
  /**
   * How many pages a *filtered* Top Rated wall may pull in on its own, and why it is
   * state rather than the constant it started as.
   *
   * The auto-advance below fetches further pages while a filter is hiding everything on
   * the ones already loaded. It has to stop somewhere or a filter matching nothing walks
   * the whole catalogue on its own; it stopped at `TOP_RATED_FILTER_PAGES` and said
   * "Nothing matches those filters", which is a **false statement** whenever the wall
   * still has pages left — the two hundred highest-rated titles containing no Westerns
   * does not mean the catalogue has none, and an empty wall has nothing to scroll, so
   * the reader could not reach them either. That is the one arbitrary cutoff the
   * founder's brief rules out, arriving through the back door.
   *
   * So the bound is now a budget the reader can extend, and the empty state says which
   * of the two things happened. Automatic work stays bounded — nothing fetches more than
   * ten pages without somebody asking — and nothing is unreachable.
   *
   * Reset to the default whenever the question changes (a new mode, a new filter), so an
   * extension granted for one narrow filter is not spent silently on the next broad one.
   */
  const [topRatedBudget, setTopRatedBudget] = useState(TOP_RATED_FILTER_PAGES);
  /** The first chip. Not a tab: see the header. Never on while Top Rated is. */
  const [sentOnly, setSentOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [filters, setFilters] = useState<CollectionFilters>(emptyFilters());
  const [filtering, setFiltering] = useState(false);
  /**
   * The Group Picks sheet. Mounted only while open, which is what makes the group
   * ephemeral: the member selection is the sheet's own state, so closing discards it
   * and reopening starts clean. The sheet owns its own filters for the same reason.
   */
  const [groupPicking, setGroupPicking] = useState(false);
  /** The Requests sheet. Nothing else on this screen knows it exists. */
  const [reviewingRequests, setReviewingRequests] = useState(false);
  /**
   * The Dismiss all intent, held here rather than inside the sheet.
   *
   * The sheet is unmounted every time it closes, so anything it owned would be cleared
   * by the most ordinary recovery a reader has: a sweep fails, they close the sheet,
   * look at the list, open it and try again. A fresh operation id on that retry walks
   * past `_claim_operation` and dismisses whatever arrived in between — recommendations
   * they never saw, which is the one thing this tranche exists to make impossible.
   *
   * This screen is a tab and outlives every open and close of the sheet, so it is the
   * longest scope that is still honest. `useSweepIntent` carries the rest of the
   * reasoning, including why the in-flight guard has to live here too.
   */
  const sweepIntent = useSweepIntent();

  /**
   * The media universe the wall is about — Movies or TV shows.
   *
   * **Switching sides no longer throws the other side's depth away** (founder,
   * 2026-09-06). `pages` used to be one number reset to 1 on every change, so a reader
   * four pages into Movies who glanced at TV and came back was handed page one again.
   * The two sides keep their own depth now, which is what makes Movies → TV → Movies
   * cost nothing: the slate itself was always cached per medium by React Query, and the
   * page count was the only thing being discarded.
   *
   * **The selector holds four things now** (founder, 2026-09-09): the two personalised
   * walls and the two Top Rated ones. It is derived from the two pieces of state above
   * rather than stored, so the control's value is computed from what the screen is
   * actually showing instead of being a third thing free to disagree with either.
   */
  const changeMode = (next: ForYouMode) => {
    chosenSelection.current = true;
    if (next === 'movies' || next === 'tv') {
      commitSelection({ medium: next, topMedium: null });
      return;
    }
    /**
     * Top Rated leaves `medium` alone, which is what keeps the personalised wall, its
     * filters and its per-medium depth exactly where the reader left them.
     *
     * Sent to you goes off, because it is a narrowing of *what people sent this reader*
     * and there is no such thing on a wall about everybody's ratings. Leaving it on
     * would draw the sent list under a heading that says Top Rated.
     */
    setSentOnly(false);
    /**
     * And the Group Picks sheet closes with it. Today this cannot be reached — `Sheet`
     * is a real `Modal` with `accessibilityViewIsModal`, so the selector underneath is
     * not touchable while the sheet is up — but "absent on Top Rated" is meant to be a
     * property of the screen rather than a consequence of one component's presentation,
     * and the day that sheet becomes an inline panel is not the day to remember this.
     */
    setGroupPicking(false);
    setTopRatedBudget(TOP_RATED_FILTER_PAGES);
    commitSelection({ medium, topMedium: next === 'topMovies' ? 'movies' : 'tv' });
  };

  /**
   * The selection the reader is now on, drawn and remembered.
   *
   * Only a choice comes through here — `changeMode` and a re-press of the tab — so the
   * default is never saved on mount and a new account's store stays empty until they pick.
   * Fire-and-forget, as Collection's writes are: a store that refuses costs the reader
   * nothing more than opening on Movies / Recommended next time.
   */
  const commitSelection = (next: ForYouSelection) => {
    setSelection({ profileId: profile.id, ...next });
    void writePref(`${profile.id}.${FOR_YOU_SELECTION_PREF_KEY}`, next).catch(() => {});
  };

  /**
   * The remembered selection, applied when it arrives.
   *
   * Collection's shape: `cancelled`, the ref reset per account, validated rather than
   * trusted, and resolved in both directions, so a miss or a failed read lands on the
   * default for *this* account rather than leaving whatever was in state.
   *
   * **Restoring Top Rated is `changeMode`'s Top Rated, minus the write**: Sent to you off,
   * Group Picks closed, the filtered-page budget back to its default. It never turns
   * anything on and never opens a sheet. Those two are only reachable before the read
   * lands if the reader opened them, and opening either marks the selection chosen (see
   * the shortcuts below), so in practice a restore finds both already off.
   *
   * Not gated on: the store is local and the walls are network reads, so the stored mode
   * lands while the wall is still a skeleton.
   */
  useEffect(() => {
    let cancelled = false;
    chosenSelection.current = false;
    const settle = (stored: unknown) => {
      if (cancelled || chosenSelection.current) return;
      const restored = parseForYouSelection(stored);
      if (restored.topMedium !== null) {
        setSentOnly(false);
        setGroupPicking(false);
        setTopRatedBudget(TOP_RATED_FILTER_PAGES);
      }
      setSelection((current) =>
        current.profileId === profile.id &&
        current.medium === restored.medium &&
        current.topMedium === restored.topMedium
          ? current
          : { profileId: profile.id, ...restored },
      );
    };
    readPref<unknown>(`${profile.id}.${FOR_YOU_SELECTION_PREF_KEY}`)
      .then(settle)
      .catch(() => settle(null));
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  /**
   * **Poster or list** (FU1113-C): how the wall is drawn, never what is on it.
   *
   * Remembered per account at `${profile.id}.for-you.view-mode` with the selection's own
   * pattern above: the state is tagged with the account it was read for, so an account
   * switch draws the default in the very render that switches and never the previous
   * reader's mode; the chosen-ref is reset per account; a stored value is validated, and a
   * miss, a bad value or a failed read all land on Poster; and only a tap writes, so a new
   * account's store stays empty until they pick. The screen is a tab and stays mounted, so
   * navigating away and back keeps the mode in state as well.
   */
  const [viewModePref, setViewModePref] = useState<{ profileId: string; mode: ViewMode }>(() => ({
    profileId: profile.id,
    mode: DEFAULT_FOR_YOU_VIEW_MODE,
  }));
  const viewMode: ViewMode =
    viewModePref.profileId === profile.id ? viewModePref.mode : DEFAULT_FOR_YOU_VIEW_MODE;
  /** A tap since the stored mode was read: newer intent than a slow read, which stands down. */
  const chosenViewMode = useRef(false);

  useEffect(() => {
    let cancelled = false;
    chosenViewMode.current = false;
    const settle = (stored: unknown) => {
      if (cancelled || chosenViewMode.current) return;
      const mode = isForYouViewMode(stored) ? stored : DEFAULT_FOR_YOU_VIEW_MODE;
      setViewModePref((current) =>
        current.profileId === profile.id && current.mode === mode
          ? current
          : { profileId: profile.id, mode },
      );
    };
    readPref<unknown>(`${profile.id}.${FOR_YOU_VIEW_MODE_PREF_KEY}`)
      .then(settle)
      .catch(() => settle(null));
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  /** The reader's tap on Poster or List: drawn, and remembered for this account only. */
  const chooseViewMode = (next: ViewMode) => {
    chosenViewMode.current = true;
    setViewModePref({ profileId: profile.id, mode: next });
    void writePref(`${profile.id}.${FOR_YOU_VIEW_MODE_PREF_KEY}`, next).catch(() => {});
  };

  /**
   * **Re-tapping the For You tab** (founder, physical iOS 1.0.1 build 8).
   *
   * Sent to you, Group Picks, the requests sheet and the two Top Rated walls are all
   * modes of this one route, so pressing the tab you are already on had nothing to pop
   * and left the reader looking at the thing they were trying to leave. `useTabReset` is
   * the same subscription the other four tabs use and states the rules; what is here is
   * only what this screen's root *is*: the personalised wall.
   *
   * **The medium and the filters survive it**, which is deliberate and is the founder's
   * own rule for Collection applied here. Movies-or-TV and a chosen genre are answers
   * this reader gave on purpose; the mode is where they are, and going back to the top of
   * a section is not a reason to throw away what they said. `pages` survives for the same
   * reason — it is depth, and the scroll below is what returns them to the top of it.
   *
   * Already at the root, so the habit's other half applies: back to the top of the wall.
   * No refetch. Pull-to-refresh is the gesture that means "ask again", and spending a
   * round trip to animate a tab press is how a habit becomes expensive.
   *
   * **What it lands on is remembered** (2026-11-12), the same as Collection's re-press:
   * the personalised wall on the reader's medium is what they see afterwards, so it is
   * what a restart shows, rather than a Top Rated they just pressed their way out of. It
   * is a choice, so it also outranks a stored selection still being read.
   */
  const wallScroller = useRef<ScrollView>(null);

  useTabReset(
    useCallback(() => {
      chosenSelection.current = true;
      const root: ForYouSelection = { medium, topMedium: null };
      setSelection({ profileId: profile.id, ...root });
      void writePref(`${profile.id}.${FOR_YOU_SELECTION_PREF_KEY}`, root).catch(() => {});
      if (sentOnly || topMedium !== null || groupPicking || reviewingRequests) {
        setSentOnly(false);
        setGroupPicking(false);
        setReviewingRequests(false);
        return;
      }
      wallScroller.current?.scrollTo({ y: 0, animated: true });
    }, [profile.id, medium, sentOnly, topMedium, groupPicking, reviewingRequests]),
  );

  /** Whether the wall is the community's order rather than this reader's slate. */
  const onTopRated = topMedium !== null;

  /**
   * Filters, and the page count that has to move with them.
   *
   * One setter rather than three call sites each remembering to reset. The pool a page is
   * drawn from changes when the filters do, so a reader four pages into an unfiltered
   * wall who then picks Comedy would otherwise be handed eighty Comedy titles at once —
   * most of them the weak tail — instead of the best twenty.
   */
  const changeFilters = (next: CollectionFilters) => {
    setFilters(next);
    resetPages();
    // A new filter is a new question, and the allowance the last one earned does not
    // carry over to it. See `topRatedBudget`.
    setTopRatedBudget(TOP_RATED_FILTER_PAGES);
  };

  /**
   * How many diversified pages the wall is showing (founder §18).
   *
   * Reset whenever the reader changes what they are looking at — a new medium or new
   * filters is a new question, and arriving at page four of the old one would be the
   * scroll position surviving a change it should not have.
   */
  /**
   * **Per medium, since 2026-09-06.** It was one number reset to 1 whenever the reader
   * changed sides, so glancing at TV and coming back handed a reader four pages into
   * Movies their first page again. The slate itself was always cached per medium by
   * React Query; the page count was the only thing a switch destroyed, and it did not
   * have to.
   *
   * Filters and an explicit refresh still reset **both** sides, and that is correct:
   * those change what the question *is*, and a stale depth into an answer to a
   * different question is not depth worth keeping.
   */
  const [pagesByMedium, setPagesByMedium] = useState<Record<Medium, number>>({
    movies: 1,
    tv: 1,
  });
  const pages = pagesByMedium[medium];
  const setPages = (next: number) =>
    setPagesByMedium((current) => ({ ...current, [medium]: next }));
  const resetPages = () => setPagesByMedium({ movies: 1, tv: 1 });
  const slate = useForYou(profile.id, medium, filters, pages);
  /**
   * A return after a meaningful absence draws a new wall (For You V2); a reader who was four
   * pages deep would otherwise land inside it with no sign it changed — the same reason
   * `refreshSlate` resets the pages (independent review of V2, minor 3).
   */
  const { reason: arrangementReason, startedAt: arrangementStartedAt } = useRecommendationArrangement();
  useEffect(() => {
    if (arrangementReason === 'resume') resetPages();
  }, [arrangementReason, arrangementStartedAt]);
  /**
   * The community's wall, and it is a different query rather than a mode of the slate.
   *
   * `useTopRated`'s own header has the argument. What matters here is that the two
   * never run at once: `onTopRated` gates this one, and the slate is left mounted and
   * cached so returning to it is instantaneous rather than a refetch.
   *
   * `topMedium ?? 'movies'` is never read while disabled — the query does not run — and
   * exists only because the key has to be a `Medium` rather than a nullable one. The
   * alternative, a null in the key, would put an entry in the cache for a wall nobody
   * ever asked for.
   */
  const topRated = useTopRated(profile.id, topMedium ?? 'movies', onTopRated);
  /**
   * The reader's own score for each title they have ranked, for Top Rated's chip — the
   * Collection wall's chip, drawn by the same `PosterGrid` tile. Top Rated is the
   * community's order and does not subtract what the reader has seen, so a ranked title
   * can be on it; an unranked one has no entry here and gets no chip. Read only on Top
   * Rated: the recommended slate subtracts everything watched.
   */
  const myScores = useMyScores(profile.id, onTopRated);
  const logged = useLoggedCollection(profile.id);
  const sent = useSentToYou(profile.id);
  /**
   * The held half. Read here rather than inside the sheet, because the compact row
   * above the filters has to know whether there is anything to say **before** anybody
   * opens anything — and the count it draws must be the same object the sheet lists.
   */
  const requests = useRecommendationRequests(profile.id);
  const watchlist = useWatchlist(profile.id);
  const markOpened = useMarkRecommendationOpened(profile.id);
  const dismissTitle = useDismissTitle(profile.id);

  /**
   * Everything Top Rated has fetched so far, before any filter.
   *
   * Kept unfiltered because two things need the whole corpus: the filter sheet, whose
   * options have to describe what could be chosen rather than what already survived a
   * choice, and the auto-advance below, which counts pages rather than matches.
   *
   * ---------------------------------------------------------------------------
   * DEDUPED ACROSS PAGES, BECAUSE A KEYSET IS NOT A SNAPSHOT
   *
   * The cursor names the row it continues from, which is what stops an *offset* handing
   * page two a row page one already showed. It does not freeze the ordering: the wall is
   * an aggregate over live ratings, so a title that sat above the cursor can fall below
   * it between two requests and be returned again — and pull-to-refresh refetches every
   * loaded page against cursors taken before the refresh, which is the same hazard with
   * the timing removed.
   *
   * One repeated row would otherwise be two tiles of the same poster and two React keys
   * with one value. First occurrence wins, so the server's order is still the order.
   *
   * The reverse — a title climbing *above* the cursor and never being returned — cannot
   * be fixed here, and is not fixed anywhere short of materialising the ranking. It is
   * recorded in `use-top-rated.ts` rather than papered over.
   */
  const topPool = (() => {
    const seen = new Set<string>();
    const out: TopRatedItem[] = [];
    for (const page of topRated.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.mediaItemId)) continue;
        seen.add(item.mediaItemId);
        out.push(item);
      }
    }
    return out;
  })();
  /**
   * The wall, filtered on the client.
   *
   * `applyFilters` rather than a `p_genres` on the RPC, and that is a correctness
   * decision rather than a convenience: a season's genres are its show's, Anime is a
   * predicate over language and genres rather than a stored label, and a person filter
   * needs a credits index. All three already live here, in the one resolver every
   * genre-bearing read in the app goes through. Re-expressing them in SQL would be a
   * second implementation of product semantics, and the first thing to drift.
   *
   * What that costs is handled by `advanceFiltered` below.
   */
  const topItems = applyFilters(topPool, filters);
  const slateItems = slate.data?.items ?? [];
  /**
   * The wall, as the four fields a tile is drawn from.
   *
   * A `ForYouItem` carries a scoring `explanation` and a `TopRatedItem` carries a
   * community mean, and neither of those is a property of a poster. Narrowing the union
   * to what the grid actually reads is what stops the two shapes leaking into each
   * other — the long press below still wants a whole `ForYouItem`, and it goes back to
   * `slateItems` for one rather than casting this.
   */
  const items: readonly {
    mediaItemId: string;
    title: string;
    year: number | null;
    posterPath: string | null;
    /** For a list row's second line (FU1113-C); a poster does not draw it. */
    kind?: 'movie' | 'series' | 'season';
  }[] = onTopRated ? topItems : slateItems;
  /**
   * Whichever query the wall is currently drawn from, for the three states every wall
   * has: loading, failed, and try again.
   *
   * One name rather than a branch at each of the three, because those branches are where
   * a screen with two data sources goes wrong — a `slate.isPending` left behind on a
   * Top Rated wall is a skeleton that never resolves, and it would look like a hung
   * request rather than a missed edit.
   */
  const wall = onTopRated ? topRated : slate;
  const sentRows = sent.data ?? [];

  /**
   * A filtered Top Rated wall asks for more pages until it has something to say.
   *
   * The failure this removes: a reader on Top Rated Movies chooses Horror, the twenty
   * highest-rated films in the catalogue contain none, and the screen shows the empty
   * state for a filter that matches plenty of titles thirty rows further down — with no
   * way to reach them, because there is nothing on screen to scroll.
   *
   * So the wall advances itself while a filter is on and the visible count is short,
   * bounded by `topRatedBudget` — which starts at `TOP_RATED_FILTER_PAGES` and which the
   * empty state below lets the reader extend, so the bound is on *unattended* work
   * rather than on what is reachable. It is deliberately **not** a while-loop: each
   * fetch re-renders, this runs again against the wall that actually came back, and the
   * page count is what stops it. `isFetchingNextPage` keeps two requests from being in
   * flight for the same page.
   */
  const pagesLoaded = topRated.data?.pages.length ?? 0;
  /**
   * Named rather than read off `topRated` inside the effect, so the dependency array
   * holds three values and one stable function instead of a query object React Query
   * rebuilds on every render. The object form runs this after every commit; the guards
   * would make almost all of those a no-op, which is exactly the kind of "almost" that
   * turns into a fetch loop the first time one of them is edited.
   */
  const { hasNextPage: topHasMore, isFetchingNextPage: topFetching } = topRated;
  const fetchMoreTopRated = topRated.fetchNextPage;
  const filtered = isFiltered(filters);
  const shownCount = topItems.length;
  useEffect(() => {
    if (!onTopRated || !filtered) return;
    if (!topHasMore || topFetching) return;
    if (pagesLoaded >= topRatedBudget) return;
    if (shownCount >= TOP_RATED_PAGE) return;
    void fetchMoreTopRated();
  }, [
    onTopRated,
    filtered,
    shownCount,
    pagesLoaded,
    topRatedBudget,
    topHasMore,
    topFetching,
    fetchMoreTopRated,
  ]);
  /**
   * Whether an empty filtered wall means "there are none" or only "there are none yet".
   *
   * `topHasMore` is the server having filled the last page it was asked for, so there is
   * more wall behind this one and the search stopped on the budget rather than on the
   * catalogue. That is the difference the two empty states below turn on, and stating it
   * once here keeps the copy and the button from ever disagreeing about which case they
   * are in.
   */
  const topSearchStoppedEarly = topHasMore === true;

  /**
   * Whether asking for another page could produce anything.
   *
   * `diversifyPaged` returns short when the candidate pool runs out, so a wall holding
   * fewer than `pages × SLATE_SIZE` titles has already been told there is no more —
   * which is a better signal than a count, because it accounts for the diversity
   * ceilings rejecting the tail as well as for the pool being empty.
   */
  const exhausted = pages >= MAX_PAGES || slateItems.length < pages * SLATE_SIZE;

  /**
   * One more page, when the reader reaches the end of this one.
   *
   * Costs nothing over the network: `pages` feeds `select`, which re-derives from
   * candidates already in the cache. So this is a sort rather than a fetch, and there is
   * no request to debounce, fail, or loop on — which is the founder's "no infinite
   * request loop" satisfied by there being no request.
   */
  const loadMore = () => {
    /**
     * Top Rated pages over the network, so its own guards are the query's rather than
     * this screen's arithmetic: `hasNextPage` is the server having returned a full page,
     * and `isFetchingNextPage` is what makes the several `onScroll` events a fast flick
     * produces into one request. There is deliberately **no** `MAX_PAGES` here — the
     * founder's brief rules out a terminal cutoff, and the wall ends where the
     * catalogue's rated titles do.
     */
    if (onTopRated) {
      if (topRated.hasNextPage && !topRated.isFetchingNextPage) void topRated.fetchNextPage();
      return;
    }
    if (exhausted) return;
    /**
     * `pages + 1`, and **not** the functional `current => current + 1`.
     *
     * `onScroll` fires about once a frame, so a fast flick near the bottom delivers
     * several events before React re-renders. Every one of them sees the same `exhausted`
     * from this render and calls this. With the functional form each queued update would
     * increment, so one gesture could take the wall from twenty titles to a hundred in a
     * single commit — five pages of posters mounted at once, which is the kind of thing
     * that shows up as heat on a real device rather than as a failing test.
     *
     * Setting a *value* makes the repeated calls idempotent: they all write the same
     * number, so the wall grows by exactly one page per render however many events
     * arrive. The next page needs the next render, by which time `exhausted` has been
     * recomputed against the wall that actually came back.
     */
    setPages(Math.min(MAX_PAGES, pages + 1));
  };

  /**
   * A new arrangement and a fresh first page.
   *
   * **This is what replaced the Refresh chip** (§18). The founder's end state is that a
   * reader should never have to think "I need to press Refresh to make recommendations
   * work", and after this tranche they do not: the wall rotates across launches on its
   * own, from `recommendation_exposure`. What is still needed is an *explicit* way to ask
   * for a different slate now — the founder was clear that Refresh should not be removed
   * merely for looks if one is still required — and pull-to-refresh is that way. It is
   * already the gesture on this screen for the Sent to you list and on the Feed, so it is
   * a control the reader has met rather than a new one.
   *
   * `refreshRecommendations` advances the seed and marks everything currently on screen
   * as shown; `resetPages()` puts the reader back at a first page, because a refreshed
   * wall they are four pages down inside is a wall whose change they cannot see.
   */
  const refreshSlate = () => {
    /**
     * On Top Rated the gesture means what it says on every other list in the app: go and
     * ask again. There is no seed to advance and no arrangement to shuffle — the order
     * is the community's and rearranging it would be the screen inventing one — so this
     * refetches the wall from its first page.
     */
    if (onTopRated) {
      void topRated.refetch();
      return;
    }
    refreshRecommendations();
    resetPages();
  };

  // Filtered here rather than in the query, so turning the chip on cannot refetch and
  // cannot reorder: the server's ordering survives, narrowed.
  const sentShown = applyFilters(sentRows.map(recommendationAsItem), filters);
  const sentVisible = sentRows.filter((row) =>
    sentShown.some((item) => item.mediaItemId === row.mediaItemId),
  );
  // FU1113-E: what Sent to You is drawing, once it has loaded, is marked seen.
  useMarkSentSeen(profile.id, sentVisible, sentOnly && sent.isSuccess);

  const savedIds = new Set((watchlist.data ?? []).map((row) => row.mediaItemId));

  const toggleSaveById = async (mediaItemId: string, present: boolean) => {
    if (busy) return;
    setBusy(mediaItemId);
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId,
      present,
    });
    setBusy(null);

    // Additions only, and only on `ok` — the same rule as the other three bookmarks.
    if (present && result.outcome === 'ok') {
      track({ name: 'watchlist_added', props: { surface: 'for_you' } });
    }

    /**
     * Reconciled on an unknown outcome as well as on success — the same rule the other
     * three bookmark surfaces follow (`lib/write-outcome.ts`). Independent review 21e,
     * and unchanged: the canonical watchlist is refetched, so the bookmark ends up
     * showing what the server actually holds rather than what the tap intended.
     *
     * **What is gone is the second line, and it was the founder's Preview bug.** This
     * also did `invalidateQueries(['for-you', profile.id])`, because the slate used to
     * carry `saved` on every item and had to be refetched to redraw one icon. Between
     * that and the watchlist being part of the slate's query key, a bookmark discarded
     * the whole wall: skeleton, white flash, a new `ScrollView`, and the reader back at
     * the top of a list they were halfway down.
     *
     * The wall is not a function of the watchlist. `buildSlate` says so — a saved title
     * stays on the wall and is marked, rather than being removed — so the only thing
     * that changed is which bookmark is filled, and that is read live from
     * `useWatchlist` below. Watchlist state changing is not the recommendation wall
     * becoming wrong.
     */
    if (mustReconcile(result)) {
      // The watchlist and Queue Dragon, which counts it (`collection/invalidate.ts`).
      invalidateAfterWatchlistChange(queryClient, profile.id);
    }

    if (result.outcome === 'failed') {
      Alert.alert('Could not update watchlist', result.message);
      return;
    }
  };

  /**
   * **The wall's tiles and its three actions, defined once for both view modes** (FU1113-C).
   *
   * Poster and List are handed this same array and these same handlers, so the list can
   * only hold the ids, order and eligibility the wall holds, and a bookmark, a dismissal
   * or an open does exactly the same thing in either mode.
   */
  const wallTiles: ForYouListTile[] = items.map((item) => ({
    id: item.mediaItemId,
    title: item.title,
    year: item.year,
    kind: item.kind,
    posterUri: posterUri(item.posterPath, 'card'),
    // Read live from the watchlist query, not carried on the slate. That is
    // what lets a bookmark redraw one icon instead of replacing the wall —
    // see `toggleSaveById`.
    saved: savedIds.has(item.mediaItemId),
    // Only the reader's own score, and only on Top Rated: the recommended
    // slate holds nothing they have watched, and nobody else's score is ever
    // chipped onto a poster.
    ...(onTopRated ? ownScore(myScores.data?.get(item.mediaItemId)) : null),
  }));
  const openTile = (tile: PosterTile) => router.push(`/title/${tile.id}`);
  const toggleSaveTile = (tile: PosterTile) => {
    const item = items.find((candidate) => candidate.mediaItemId === tile.id);
    if (item) void toggleSaveById(item.mediaItemId, !savedIds.has(item.mediaItemId));
  };
  /**
   * The founder's X (§12): the card goes on the tap — the optimistic
   * set feeds `useForYou`'s select, so no refetch and no flash — and
   * the write persists it. Only a proven refusal is worth an alert.
   *
   * **Absent on Top Rated**, and not merely because it would do nothing.
   * A dismissal is a durable statement that this reader does not want a
   * title *recommended*, and it is read by the slate query alone — so an X
   * here would silently edit a different wall while appearing to edit this
   * one, and the tile it removed would come back on the next page. The
   * community's order is not a list anybody gets to edit.
   */
  const dismissTile = onTopRated
    ? undefined
    : (tile: PosterTile) => {
        void dismissTitle(tile.id).then((result) => {
          if (!result.ok) Alert.alert('Could not hide this', result.message);
        });
      };

  const openRecommendation = (row: SentRecommendation) => {
    // Opened is recorded on the way through, which is the only moment anybody can
    // honestly call it opened. It is fire-and-forget: a failure here must not stand
    // between somebody and the title they were told to watch.
    // `recommendation_opened` is emitted by the mutation, once the server has answered
    // and once per row — not here on the tap, which reads a cached `openedAt` and would
    // fire twice for two quick presses. See `useMarkRecommendationOpened`.
    if (!row.openedAt) {
      markOpened.mutate({
        recommendationId: row.id,
        mediaKind: mediaKindFor(row.kind),
        hasNote: Boolean(row.message),
      });
    }
    /**
     * Who sent it, and what they said, no longer travels in the link (20260929000100).
     *
     * It used to — `recBy` and `recAt` — on the reasoning that the fact belonged to this
     * route. The note reversed that: the title page now asks `title_recommendations_for_me`
     * whichever way the reader arrived, because an inbox tap or a push is exactly where a
     * note most needs to be seen. What this tap still knows is handed over as the page's
     * first frame — every delivered row for the title, so "Ada and 2 others" is right at
     * once — and marked stale so the page asks the server anyway.
     */
    queryClient.setQueryData(
      titleRecommendationsKey(profile.id, row.mediaItemId),
      seedFromSentToYou(sentRows, row.mediaItemId),
      { updatedAt: 0 },
    );
    router.push(`/title/${row.mediaItemId}`);
  };

  /**
   * **No long press on the wall** (founder, final direction, 2026-11-03). It answered with a
   * native alert holding the `headlineFor` sentence ("Because you loved Heat"), and in
   * local development the engine's working under it. The founder ruled the alert out of
   * the design. PRD §13 constrains what a reason may say, not that one is shown, so
   * nothing else depends on it; `headlineFor` and its tests stay in `rank.ts` for the day
   * a reason is drawn on the page. Developers lose the working on long press; the
   * Diagnostics sheet is unchanged.
   */

  // Unread: neither opened nor seen in the list (FU1113-E; founder D5: the count and its
  // spoken label say unread/new, not unopened). The server caps this list at 200 and
  // orders unopened first, so a full page of unopened rows means there may be more unread
  // ones (`use-sent-to-you.ts`). The chip says so rather than presenting a cap as a total
  // (independent review 21c), including when none in hand is unread (Codex review, #290).
  const sentBadge = sentShortcutBadge(sentRows);
  const activeCount = activeFilterCount(filters);
  // Items, not senders, and the server's own count rather than the length of a capped
  // list — see `useRecommendationRequests`.
  const requestCount = requests.data?.total ?? 0;

  /**
   * **The page's toolbar: Recommended ▾ or Top Rated ▾, Filters opposite** (founder,
   * marquee cohesion sprint, 2026-11-07) — Collection's toolbar, at the same height, padding
   * and marquee size, so the two pages read as siblings. Under it, the request alert when
   * something is waiting and the two features, Sent to You and Find for a Group (absent on
   * Top Rated, as they always were).
   *
   * It scrolls away with the wall rather than standing over it: it is the first thing in the
   * wall's scroller, and in Sent to You's. The medium stays the header's switch.
   *
   * **One scroller in every state, so the toolbar is never remounted** (2026-11-11). It used
   * to be drawn above the state while the wall loaded, was empty or failed, and inside the
   * wall's scroller once it landed: two places in the tree, so switching Movies/TV or
   * Recommended/Top Rated and opening the Recommended ▾ menu before the new wall arrived
   * remounted `MediumSelector` and the open menu closed by itself. The loading, empty and
   * error states are now drawn under the toolbar inside the same scroller (its content
   * grows to fill the page, so they sit where they did). Its `refreshControl` stays in every
   * state for the same reason: React Native's `ScrollView` wraps itself in the control when
   * there is one, so adding it on load would remount everything inside.
   */
  const toolbar = (
    <View testID="for-you-toolbar">
      <View style={styles.toolbarRow}>
        <BrowseControlsRow
          testID="for-you-controls-row"
          leading={
            <MediumSelector
              size="marquee"
              value={onTopRated ? 'top' : 'recommended'}
              options={FOR_YOU_WALLS}
              accessibilityHint="Choose Recommended or Top Rated"
              testID="for-you-mode"
              onChange={(next) => {
                const showing = topMedium ?? medium;
                changeMode(next === 'top' ? (showing === 'movies' ? 'topMovies' : 'topTv') : showing);
              }}
            />
          }
          trailing={
            // The collection's own sheet: Genre, Language, Decade and Anime. Rating filters
            // stay off, because nothing on either wall has been ranked by this reader. No sort
            // here: the wall's order is the recommendation order (FU1113-C).
            // **Filters, then Clear all when on, then the view toggle rightmost** (founder QA
            // 11-14, §5; was the toggle first), as on Collection.
            <View style={styles.tools} testID="for-you-controls">
              <FilterIconButton
                activeCount={activeCount}
                accessibilityLabel="Filters"
                accessibilityHint="Opens filters"
                onPress={() => setFiltering(true)}
                testID="for-you-filters"
              />
              {isFiltered(filters) ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear all"
                  accessibilityHint="Turns every filter off"
                  onPress={() => changeFilters(emptyFilters())}
                  style={({ pressed }) => [styles.clear, pressed && styles.toolPressed]}
                  testID="for-you-clear-filters"
                >
                  <Ionicons name="close" size={theme.layout.icon.sm} color={theme.text.secondary} />
                </Pressable>
              ) : null}
              {/* How the wall is drawn. Not over Sent to You, which is always a list: a
                  toggle there would be a control that changes nothing. */}
              {sentOnly ? null : (
                <ViewModeToggle
                  value={viewMode}
                  onChange={chooseViewMode}
                  testID="for-you-view-mode"
                />
              )}
            </View>
          }
        />
      </View>

      {/* Above the features, and only when something is waiting. Not a filter: it says
          that something not on screen yet needs a decision. Absent at zero. */}
      {requestCount > 0 ? (
        <RequestAlertRow count={requestCount} onPress={() => setReviewingRequests(true)} />
      ) : null}

      {/* Not on Top Rated: both are statements about particular people, and that wall's
          whole claim is that its order belongs to everybody (founder, 2026-09-09). */}
      {onTopRated ? (
        <View style={styles.topRatedGap} />
      ) : (
        <ForYouShortcuts
          shortcuts={[
            {
              key: 'sent',
              icon: sentOnly ? 'mail-open' : 'mail-outline',
              label: 'Sent to You',
              badge: sentBadge.badge,
              accessibilityLabel: sentBadge.spoken,
              selected: sentOnly,
              onPress: () => {
                // A late stored Top Rated would switch this straight back off.
                chosenSelection.current = true;
                setSentOnly((on) => !on);
              },
            },
            {
              key: 'group',
              icon: 'people-outline',
              label: 'Find for a Group',
              // The analytics name stays the feature's original one.
              onPress: () => {
                track({ name: 'group_picks_opened' });
                // As Sent to you: a late stored Top Rated would close the sheet under them.
                chosenSelection.current = true;
                setGroupPicking(true);
              },
            },
          ]}
        />
      )}
    </View>
  );
  /** Whether the wall's own scroller is drawn, and so carries the toolbar. */
  const wallScrolls = !wall.isError && !wall.isPending && items.length > 0;

  return (
    <Screen>
      {/**
       * **No bell on this screen** (founder, physical QA, 2026-09-08).
       *
       * It was here, and Collection and Search had nothing in the same corner — so three
       * of the five root tabs disagreed about whether their header carried a control at
       * all, and this one's bell did not optically centre against the wordmark beside it.
       * The founder's resolution is the simplifying one: take it off For You rather than
       * add it to the two screens that never had it.
       *
       * Nothing about notifications changed. The inbox is still reached from Feed, which
       * is the social surface it belongs to. This is a header losing a control, not a
       * navigation redesign.
       *
       * **Its corner holds Movies | TV now** (founder, UI cohesion pass, 2026-11-06), as
       * Collection's does: the same switch, value and handler that sat at the right of the
       * row below, moved up into the header rather than repeated.
       */}
      <AppHeader
        right={
          <CompactSwitch
            accessibilityLabel="Medium"
            options={FOR_YOU_MEDIA}
            value={topMedium ?? medium}
            onChange={(next) =>
              changeMode(onTopRated ? (next === 'movies' ? 'topMovies' : 'topTv') : next)
            }
          />
        }
      />
      <HeaderBoundary />

          {sentOnly ? (
            <SentList
              header={toolbar}
              query={sent}
              rows={sentVisible}
              total={sentRows.length}
              saved={savedIds}
              busyId={busy}
              onOpen={openRecommendation}
              onToggleSave={(row) =>
                void toggleSaveById(row.mediaItemId, !savedIds.has(row.mediaItemId))
              }
            />
          ) : (
            <ScrollView
              ref={wallScroller}
              contentContainerStyle={[styles.content, !wallScrolls && styles.stateContent]}
              /* The only way a test can reach the scroll that pages the wall — the same
                 reason `for-you-refresh` exists on the control below. A `ScrollView` has
                 no accessible name and no role to query it by. */
              testID={wallScrolls ? 'for-you-wall' : 'for-you-page'}
              /**
               * The wall grows as the reader nears its end (§18).
               *
               * `onScroll` with a threshold rather than a `FlatList`'s `onEndReached`,
               * because the wall is a `PosterGrid` inside a `ScrollView` and converting it
               * to a virtualised list is a change to how every tile is measured and drawn —
               * a bigger risk than this tranche is buying. The grid is at most a hundred
               * posters under `MAX_PAGES`, which is well inside what a `ScrollView` renders
               * comfortably.
               *
               * `scrollEventThrottle` at 16 is one event a frame; `loadMore` is a no-op
               * once the pool is exhausted, so the common case at the bottom of the wall is
               * a comparison and a return.
               */
              scrollEventThrottle={16}
              onScroll={({ nativeEvent }) => {
                // Only a drawn wall pages; the same scroller holds a loading or empty
                // state under the toolbar.
                if (!wallScrolls) return;
                const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
                const remaining =
                  contentSize.height - (contentOffset.y + layoutMeasurement.height);
                // Two screenfuls of slack, so the next page is already there by the time
                // the reader arrives rather than appearing under their thumb.
                if (remaining < layoutMeasurement.height * 2) loadMore();
              }}
              refreshControl={
                <RefreshControl
                  // The only way a test can reach a pull. There is no accessible name on
                  // a refresh control and no role to query it by, and asserting on the
                  // gesture matters more than usual here: it is the *replacement* for a
                  // control that was removed, so a wiring mistake would look exactly like
                  // the feature having been dropped.
                  testID="for-you-refresh"
                  // Not `slate.isRefetching`: this gesture rearranges rather than
                  // refetching, and it completes in one render. Tying the spinner to a
                  // query that never runs would leave it spinning for ever.
                  refreshing={false}
                  onRefresh={() => {
                    // The wall's gesture on a wall; on a failed read, the same retry as
                    // its Try again. Loading and empty have nothing to pull.
                    if (wallScrolls) refreshSlate();
                    else if (wall.isError) void wall.refetch();
                  }}
                  tintColor={theme.semantic.action}
                  colors={[theme.semantic.action]}
                />
              }
            >
              {toolbar}
              {wall.isError ? (
            <EmptyState
              kind="couldNotLoad"
              title={onTopRated ? 'Could not load Top Rated' : 'Could not load recommendations'}
              body="Check your connection and try again."
              action={{ label: 'Try again', onPress: () => void wall.refetch() }}
            />
          ) : wall.isPending ? (
            // The wall's own shape while the first slate is on its way (founder QA,
            // 2026-09-21: a cold load showed the header over an empty area).
            <SkeletonGrid rows={4} />
          ) : items.length === 0 ? (
            onTopRated ? (
              /**
               * Three sentences, and the one it does not say is "there is nothing".
               *
               * A Top Rated wall is empty for exactly two reasons and they are not the
               * reader's fault in the same way: a filter has hidden everything that was
               * there, or not enough people have rated anything yet.
               *
               * **Neither sentence quotes the threshold**, deliberately. The number is
               * `discovery.top_rated_min_ratings` and the server is the only thing that
               * knows it — an empty page carries no row to read it off, so any figure
               * here would be a client-side copy of a config value, right until the day
               * it is moved. The second sentence says the true thing instead, which is
               * that the wall fills up as people rank.
               *
               * `Nothing` is deliberately not reused: every branch of it is about this
               * reader's own taste being thin, which is the wrong diagnosis here.
               */
              isFiltered(filters) ? (
                /**
                 * Two filtered-empty states, because there are two different facts.
                 *
                 * The wall searched as far as its budget allowed and there is more wall
                 * behind it: then nothing has been proved about the catalogue, and the
                 * honest sentence says how far it looked and offers to look further.
                 * Saying "nothing matches" here was a claim the screen had not earned —
                 * the two hundred highest-rated titles holding no Westerns is not the
                 * catalogue holding none, and with an empty wall there was nothing to
                 * scroll to reach them. That is a terminal cutoff by another name.
                 *
                 * Or the wall genuinely ended, in which case nothing does match and
                 * clearing the filters is the only thing left to offer.
                 */
                topSearchStoppedEarly ? (
                  <EmptyState
                    kind="nothingYet"
                    title="Nothing yet in the highest rated"
                    body="No match so far in the top rated titles we have looked through. There are more below."
                    action={{
                      label: 'Keep looking',
                      /**
                       * Measured from where the wall actually is, not from where the
                       * budget happens to sit.
                       *
                       * The budget is an absolute page count and it resets to ten when
                       * the question changes, but the *pages* do not reset with it —
                       * React Query keeps them, and the reader may have scrolled far
                       * past ten before filtering, since manual paging has no budget at
                       * all. A plain `current + TOP_RATED_FILTER_PAGES` then buys a
                       * ceiling still below `pagesLoaded`, and the press does nothing
                       * visible: on a wall thirty pages deep the first two presses are
                       * silent no-ops. Independent review, 2026-09-09.
                       *
                       * Taking the larger of the two first guarantees the new ceiling is
                       * a full allowance *beyond the current depth*, so every press
                       * authorises real work for as long as the wall has more.
                       */
                      onPress: () =>
                        setTopRatedBudget(
                          (current) => Math.max(current, pagesLoaded) + TOP_RATED_FILTER_PAGES,
                        ),
                    }}
                  />
                ) : (
                  <EmptyState
                    kind="nothingYet"
                    title="Nothing matches those filters"
                    body="No top rated title matches everything you have chosen."
                    action={{
                      label: 'Clear filters',
                      onPress: () => changeFilters(emptyFilters()),
                    }}
                  />
                )
              ) : (
                <EmptyState
                  kind="nothingYet"
                  title="Not enough ratings yet"
                  body="Titles appear here once enough people have rated them. Rank what you watch and this fills up."
                  action={{ label: 'Rank something', onPress: () => router.push('/log') }}
                />
              )
            ) : (
              <Nothing
                medium={medium}
                ranked={logged.data?.rankedCount ?? 0}
                filtered={isFiltered(filters)}
                onRank={() => router.push('/log')}
                onClearFilters={() => changeFilters(emptyFilters())}
              />
            )
          ) : (
              <View style={styles.wallBody}>
              {/* No line above the wall about how well bingd. knows the reader's taste
                  (founder, 2026-11-03). Until then a thin taste printed "Popular right now
                  while bingd learns your taste" or "bingd is still learning your taste". */}
              {viewMode === 'list' ? (
                <ForYouList
                  tiles={wallTiles}
                  onPressTile={openTile}
                  onToggleSave={toggleSaveTile}
                  onDismissTile={dismissTile}
                />
              ) : (
                <PosterGrid
                  tiles={wallTiles}
                  onPressTile={openTile}
                  onToggleSave={toggleSaveTile}
                  onDismissTile={dismissTile}
                />
              )}

              {/**
               * The end of the wall, said once, quietly (§18).
               *
               * The founder's rule is not to keep recycling the same five cards at the
               * bottom — so when the pool is out the wall simply stops, and this line
               * says why in the one way that is both true and actionable. It is not a
               * button: the reader is on a wall of recommendations and the thing to do
               * about a thin one is to rank more, which the Log tab already offers.
               *
               * Only under a wall with something on it. Under an empty one `Nothing`
               * has already said something better, and two explanations of the same
               * absence is worse than either.
               */}
              {/* Not on Top Rated. The line asks the reader to rank more so their
                  *recommendations* sharpen, which is a true and useful thing to say
                  about a slate and a non-sequitur under a wall of everybody's ratings —
                  that one ends where the rated catalogue ends, and needs no apology. */}
              {!onTopRated && exhausted && items.length > 0 ? (
                <Text variant="footnote" tone="tertiary" style={styles.exhausted}>
                  Rank a few more titles to sharpen your recommendations.
                </Text>
              ) : null}
              </View>
              )}
            </ScrollView>
          )}

          {filtering ? (
            <CollectionFilterSheet
              // The options describe whatever is in front of the reader, so a Sent to you
              // list of four films does not offer twenty genres none of them are.
              items={
                sentOnly
                  ? sentRows.map(recommendationAsItem)
                  : onTopRated
                    ? // The *unfiltered* pool, so the sheet's options describe what could
                      // be chosen rather than what already survived a choice — otherwise
                      // picking Horror would leave Horror as the only genre on offer and
                      // a second one could never be added. It grows as the wall pages, and
                      // `advanceFiltered` is what makes sure it has grown enough to be
                      // worth describing.
                      topPool
                    : (slate.data?.candidatePool ?? [])
              }
              value={filters}
              showBuckets={false}
              onApply={(next) => {
                changeFilters(next);
                setFiltering(false);
              }}
              onClose={() => setFiltering(false)}
            />
          ) : null}

          {groupPicking ? (
            <GroupPicksSheet
              viewerId={profile.id}
              medium={medium}
              onClose={() => setGroupPicking(false)}
            />
          ) : null}

          {/* The held recommendations, and the three decisions each one carries.

          Mounted only while open, so the sheet's queries are not kept warm behind a
          screen most visits never open — the compact row above already knows the count
          from a query this screen owns. */}
          {reviewingRequests ? (
            <RecommendationRequestsSheet
              viewerId={profile.id}
              onClose={() => setReviewingRequests(false)}
              onPressProfile={(username) => router.push(`/u/${username}`)}
              sweepIntent={sweepIntent}
            />
          ) : null}
    </Screen>
  );
}

/**
 * The four things this screen can be showing.
 *
 * Two personalised walls and two community ones. `Medium` here is `'movies' | 'tv'` and
 * Collection's is `'movies' | 'tv_seasons'`, because the units genuinely differ: TMDB
 * answers "similar" about a *show* and never about one of its seasons, so the
 * personalised wall holds series. (Its label read "TV shows" for that reason until 2026-09-14,
 * when all four entries were renamed to say which list they are; see `FOR_YOU_MODES`.)
 *
 * **The two television entries hold different units, and only one of them says so.**
 * Nothing in this product has ever rated a whole series — `rankable_category` maps
 * `season -> tv_seasons` and refuses a series outright (PRD §10) — so the highest-rated
 * television is a *season*, while the personalised wall beside it is *shows*. The labels
 * are the founder's, given as a list of exactly four, and `Top Rated TV` is one of them:
 * a reader meets the distinction in the rows themselves, which read `The Last of Us, S1`,
 * rather than in a label long enough to wrap. Recorded here because the two words are one
 * apart and mean different things.
 *
 * **It was three, then two, and is four** (§A16, then founder 2026-09-09). People was the
 * third and is a mode of the Feed tab now; Top Rated is not a fifth thing in that
 * lineage — it is titles, which is what this screen exclusively is.
 */
export type ForYouMode = Medium | 'topMovies' | 'topTv';

/** Where the reader is on this screen, as remembered: see `selection` in the screen. */
type ForYouSelection = { medium: Medium; topMedium: Medium | null };

/** A new account, or one whose stored selection could not be read: Movies / Recommended. */
const DEFAULT_FOR_YOU_SELECTION: ForYouSelection = { medium: 'movies', topMedium: null };

/**
 * `${profile.id}.for-you.selection`, holding `{ medium, topMedium }` (founder, 2026-11-12).
 *
 * Device-local, beside Collection's keys and separate from them: Collection on TV does not
 * move For You to TV. Sent to you, Group Picks, the requests sheet, the filters and the
 * page depth are not part of it and are not remembered.
 */
const FOR_YOU_SELECTION_PREF_KEY = 'for-you.selection';

const isForYouMedium = (value: unknown): value is Medium => value === 'movies' || value === 'tv';

/**
 * `${profile.id}.for-you.view-mode`, holding `'poster'` or `'list'` (FU1113-C). Device-local
 * and per account, beside the selection and separate from Collection's own view mode: List
 * on Collection does not draw For You as a list.
 */
const FOR_YOU_VIEW_MODE_PREF_KEY = 'for-you.view-mode';

/** A new account, or one whose stored mode is missing, unreadable or not a mode: Poster. */
const DEFAULT_FOR_YOU_VIEW_MODE: ViewMode = 'poster';

const isForYouViewMode = (value: unknown): value is ViewMode =>
  value === 'poster' || value === 'list';

/**
 * A stored selection, validated rather than trusted, one field at a time.
 *
 * Anything this screen cannot draw — a string from some other build, a number, a
 * Collection side such as `tv_seasons`, an array, an object of the wrong shape, a key that
 * failed to parse (which `readPref` already reads as null) — falls back to the default
 * field by field, so a good `medium` is kept beside a bad `topMedium` and the reverse.
 */
function parseForYouSelection(stored: unknown): ForYouSelection {
  const record =
    stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  return {
    medium: isForYouMedium(record.medium) ? record.medium : DEFAULT_FOR_YOU_SELECTION.medium,
    topMedium: isForYouMedium(record.topMedium) ? record.topMedium : null,
  };
}

/** The medium, in the compact switch. "TV", not "TV Shows", at this size (2026-11-04). */
const FOR_YOU_MEDIA: readonly CompactSwitchOption<Medium>[] = [
  { id: 'movies', label: 'Movies' },
  { id: 'tv', label: 'TV' },
];

/** Which wall, in the page's dropdown. */
const FOR_YOU_WALLS: readonly MediumSelectorOption<'recommended' | 'top'>[] = [
  { id: 'recommended', label: 'Recommended' },
  { id: 'top', label: 'Top Rated' },
];

/**
 * The human half.
 *
 * Three empty states rather than one, because they mean three different things and only
 * one of them is the reader's to fix: nobody has sent you anything, the filters have
 * hidden everything that was sent, or the list could not load.
 */
function SentList({
  query,
  rows,
  total,
  saved,
  busyId,
  onOpen,
  onToggleSave,
  header,
}: {
  /** The page's toolbar: first in the list's scroller, in every state. */
  header: React.ReactNode;
  query: ReturnType<typeof useSentToYou>;
  rows: SentRecommendation[];
  total: number;
  saved: ReadonlySet<string>;
  busyId: string | null;
  onOpen: (row: SentRecommendation) => void;
  onToggleSave: (row: SentRecommendation) => void;
}) {
  /**
   * **One scroller in every state, so the toolbar is never remounted** (2026-11-11), the
   * rule the wall follows: a list that landed, failed or emptied under an open
   * Recommended ▾ menu used to move the toolbar from a fragment into a `ScrollView` and
   * close the menu. Every state is drawn under the header inside the same scroller, which
   * grows to fill the page so a state sits where it did.
   */
  const loaded = !query.isPending && !query.isError && total > 0 && rows.length > 0;
  return (
    <ScrollView
      contentContainerStyle={[styles.content, !loaded && styles.stateContent]}
      refreshControl={
        <RefreshControl
          refreshing={query.isRefetching}
          onRefresh={() => void query.refetch()}
          tintColor={theme.semantic.action}
          colors={[theme.semantic.action]}
        />
      }
    >
      {header}
      {query.isPending ? (
        <SkeletonRow count={5} />
      ) : query.isError ? (
        <EmptyState
          kind="couldNotLoad"
          title="Could not load these"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void query.refetch() }}
        />
      ) : total === 0 ? (
        <EmptyState
          kind="nothingYet"
          title="Nothing sent your way yet"
          body="When someone you follow back recommends a film or a season, it lands here."
        />
      ) : rows.length === 0 ? (
        // No button. Clear all is already on screen, in the chip row a few points above
        // this, and a second one with the same label is the duplicated state the founder
        // rejected on the Feed: the reader would have to work out whether the two do the
        // same thing.
        <EmptyState
          kind="nothingYet"
          title="Nothing matches your filters"
          body="Clear your filters to see everything people have sent you."
        />
      ) : (
        <View style={styles.wallBody}>
          <SentToYouList
            rows={rows}
            saved={saved}
            busyId={busyId}
            onOpen={onOpen}
            onToggleSave={onToggleSave}
          />
        </View>
      )}
    </ScrollView>
  );
}

/**
 * Nothing to show, which has three quite different causes and needs three answers.
 *
 * A reader who has ranked nothing needs to rank something. A reader who has filtered the
 * wall down to nothing needs the filter gone, and telling them to rank more would be
 * answering a question they did not ask. A reader who has ranked plenty and still sees
 * an empty wall has hit a data problem, no cached candidates yet, and blaming them for
 * it would be worse than saying nothing.
 */
function Nothing({
  medium,
  ranked,
  filtered,
  onRank,
  onClearFilters,
}: {
  medium: Medium;
  ranked: number;
  filtered: boolean;
  onRank: () => void;
  onClearFilters: () => void;
}) {
  if (filtered) {
    return (
      <EmptyState
        kind="nothingMatches"
        title="Nothing matches your filters"
        body="Try removing one, or clear them and start again."
        action={{ label: 'Clear all', onPress: onClearFilters }}
      />
    );
  }

  if (ranked === 0) {
    return (
      <EmptyState
        kind="nothingYet"
        title="Rank a few things first"
        body="Recommendations need a little of your taste to work from."
        action={{ label: 'Rank something', onPress: onRank }}
      />
    );
  }

  return (
    <EmptyState
      kind="nothingYet"
      title={medium === 'tv' ? 'Nothing to suggest yet' : 'Still gathering suggestions'}
      body={
        medium === 'tv'
          ? 'Rank a show or a season or two and this fills up with shows.'
          : 'This fills in as the catalogue learns what your favourites are near.'
      }
      action={{ label: 'Rank something', onPress: onRank }}
    />
  );
}

const styles = StyleSheet.create({
  // The toolbar's top inset, as `ContentToolbar` drew it: `BrowseControlsRow` draws none.
  toolbarRow: { paddingTop: theme.space[2] },
  // Poster / List, Filters and, while filters are on, Clear beside it — the row's own
  // trailing gap between them.
  tools: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  clear: {
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolPressed: { opacity: 0.6 },
  // Top Rated has no features row; this is the seam the row's foot would have given.
  topRatedGap: { height: theme.space[3] },
  content: { paddingBottom: theme.space[10] },
  // A loading, empty or failed wall under the toolbar fills the page, as it did when it
  // was drawn outside the scroller.
  stateContent: { flexGrow: 1 },
  // The wall and its end line, under the toolbar, 12pt apart as they always were.
  wallBody: { gap: theme.space[3] },
  exhausted: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    textAlign: 'center',
  },
});

/** A tile's chip fields from the reader's own ranking, or nothing for an unranked title. */
const ownScore = (mine: MyScore | undefined) =>
  mine ? { score: mine.score, bucket: mine.bucket } : null;
