import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { goalAchievement } from '@/features/goals/goals';
import { unreadCount, useNotifications } from '@/features/notifications/use-notifications';
import { useWatchlist } from '@/features/collection/use-collection';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { mustReconcile, newOperationId, setWatchlist } from '@/features/collection/writes';
import {
  activitySentence,
  metadataFor,
  relativeTime,
  watchLabel,
} from '@/features/feed/activity';
import { CommentSheet } from '@/features/feed/CommentSheet';
import { CompanionsSheet } from '@/features/feed/CompanionsSheet';
import { FeedCard } from '@/features/feed/FeedCard';
import { FeedHeading } from '@/features/feed/FeedHeading';
import { FEED_CARD, FeedPostSurface } from '@/features/feed/FeedPostSurface';
import {
  groupCount,
  previewKey,
  useGroupPreviews,
} from '@/features/feed/use-group-previews';
import { feedArtwork, takesFeedCard } from '@/features/feed/feed-artwork';
import { ReactionDetail } from '@/features/feed/ReactionDetail';
import { ReactionPill } from '@/features/feed/ReactionPill';
import { useCommentCounts } from '@/features/feed/use-comments';
import {
  feedItems,
  trimFeedToFirstPage,
  useFeed,
  type FeedItem,
} from '@/features/feed/use-feed';
import { activityLead } from '@/features/feed/ActivityLead';
import { FollowStoryRow } from '@/features/feed/FollowStoryRow';
import { RankingBatchSheet } from '@/features/feed/RankingBatchSheet';
import { WatchlistGroupSheet } from '@/features/feed/WatchlistGroupSheet';
import { batchMedium } from '@/features/ranking/RankedSummary';
import { FollowStorySheet } from '@/features/feed/FollowStorySheet';
import { activityReaction } from '@/features/feed/reaction-summary';
import {
  DEFAULT_REACTION,
  reactionFailureAlert,
  useReactions,
  useSetReaction,
  type ReactionKind,
} from '@/features/feed/use-reactions';
import { LeaderboardView } from '@/features/leaderboard/LeaderboardView';
import { DEFAULT_PEOPLE_MODE, PeopleView } from '@/features/people/PeopleView';
import {
  useLeaderboard,
  useMyStanding,
  type LeaderboardMetric,
  type LeaderboardTimeframe,
} from '@/features/leaderboard/use-leaderboard';
import { useLeaderboardSelection } from '@/features/leaderboard/use-leaderboard-selection';
import { RecommendSheet } from '@/features/recommendations/RecommendSheet';
import { TrendingShelf } from '@/features/trending/TrendingShelf';
import { useTrending } from '@/features/trending/use-trending';
import { track } from '@/lib/analytics';
import { posterUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { peopleDiscovery } from '@/lib/routes';
import { invalidateAfterWatchlistChange } from '@/features/collection/invalidate';
import {
  ActivityRow,
  AppHeader,
  Button,
  EmptyState,
  HeaderBoundary,
  IconToggle,
  Screen,
  SkeletonRow,
  Text,
  usePullRefresh,
  type IconToggleOption,
} from '@/ui/components';
import { useTabReset } from '@/ui/use-tab-reset';
import { theme } from '@/ui/tokens';

/**
 * Feed, Leaderboard or People — the three states of this tab's content area.
 *
 * Feed first, because it is the default and because the leftmost cell being the
 * default is the rule the Collection toggle follows too.
 *
 * **People arrived on 2026-09-08** (founder §§A2, A16). It was a category of For You,
 * behind the Movies / TV shows dropdown, and it moved here because this is the tab that is
 * already about other people — and because the activation problem it exists to solve is
 * not the "what should I watch" problem For You answers. For You is titles only now.
 *
 * Still three modes of one route rather than a sixth tab: five is the width of the bar.
 * That is what the hardware-Back and tab-press handlers below are for, and both were
 * written for two modes and now read "not the Feed" rather than "the board".
 */
type FeedMode = 'feed' | 'leaderboard' | 'people';

/**
 * How close to the end of the list the next page is asked for, in points.
 *
 * Eight hundred is about one phone screen. The fetch has to start while the reader
 * still has content to read or the spinner is the thing they arrive at, and a page of
 * twenty rows is several screens deep — so a threshold of one screen buys the round
 * trip roughly a screenful of reading time without prefetching the whole feed.
 */
const NEXT_PAGE_THRESHOLD = 800;

const FEED_MODES = [
  // `newspaper` rather than `list`: Collection's list glyph means "the other way of
  // drawing this same thing", and this control's left cell means "the ordinary
  // homepage". Reusing the glyph would say the two toggles answer the same question.
  { value: 'feed', icon: 'newspaper-outline', label: 'Feed' },
  { value: 'leaderboard', icon: 'trophy-outline', label: 'Leaderboard' },
  /**
   * `people-outline`, which is the glyph this app already spends on a set of people —
   * Group Picks' chip and the old For You mutuals chip both use it. `person-add-outline`
   * was the other candidate and is wrong: it names the *act* of following, and this cell
   * names a place, in a control whose other two cells are also places.
   */
  { value: 'people', icon: 'people-outline', label: 'People' },
] as const satisfies readonly IconToggleOption<FeedMode>[];

/** PRD §14. Fan-out on read: followed users' activity is queried at read time
 *  rather than written into per-user inboxes (docs/architecture/README.md AD-5). */
export default function FeedScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const queryClient = useQueryClient();
  const feed = useFeed(profile.id);
  const notifications = useNotifications(profile.id);
  const watchlist = useWatchlist(profile.id);
  const watched = useWatched(profile.id);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * Which surface this tab is showing, and **deliberately not persisted** (§6).
   *
   * `useState`, so a fresh launch is Feed. That is the whole of the rule and it is worth
   * stating why the obvious improvement is wrong: Collection remembers Poster or List
   * because both are ways of drawing the same collection, so either is a reasonable thing
   * to open on. Leaderboard is a *different surface*, and a launch that opened on it would
   * have quietly replaced the homepage with a scoreboard — which is the product decision
   * the founder made in the other direction.
   *
   * Within a mounted session the choice does survive, because the tab stays mounted while
   * the reader visits other tabs. That is the founder's "acceptable if it falls naturally
   * out of the navigation tree", and it does: nothing here works to preserve it.
   */
  const [mode, setMode] = useState<FeedMode>('feed');
  /**
   * What the board counts and over when — **and these ARE remembered**, per account
   * (founder §2, widened to the category by the brief of 2026-11-23).
   *
   *   `mode`                not persisted. Leaderboard is an alternate surface, and a launch
   *                         that opened on it would have replaced the homepage with a
   *                         scoreboard.
   *   `metric`, `timeframe` persisted. Once the reader is *in* the board, which category
   *                         and timeframe they read it in is a preference about the same
   *                         surface — the Collection Poster/List argument exactly.
   *
   * So: a fresh launch opens Feed; tapping Trophy opens the board on what they last chose.
   * `useLeaderboardSelection` owns the store, the account tag that keeps one reader's
   * choice from reaching the next, and the rule that a late read never undoes a choice.
   */
  const board = useLeaderboardSelection(profile.id);
  const { metric, timeframe } = board;
  const showingBoard = mode === 'leaderboard';
  const showingPeople = mode === 'people';
  /**
   * Whether the activity list is what the content area holds.
   *
   * Named rather than written as `!showingBoard` at each site, which is what those sites
   * used to say: with two modes the two readings were the same sentence, and with three
   * they are not. Every "the feed is not showing" test below — pull to refresh, the
   * infinite-scroll handler, the empty state — means *this*, and getting one of them wrong
   * would have shown a feed spinner over a list of people.
   */
  const showingFeed = mode === 'feed';
  // Not fetched until the board is actually opened. The Feed is the default and most
  // readers will never toggle, so an eager read would be a request per app open for a
  // surface nobody asked for.
  const leaderboard = useLeaderboard(profile.id, metric, timeframe, showingBoard);
  const standing = useMyStanding(profile.id, metric, timeframe, showingBoard);
  /**
   * The board's pull-to-refresh, tracked as a **pull** and never as a fetch (independent
   * review 82).
   *
   * `refreshing` on iOS is a programmatic pull: `true` grows the scroll view's top inset and
   * slides the page down. It was bound to `leaderboard.isRefetching`, which is also true while
   * a kept board fetches the next metric and whenever a stale metric refetches in the
   * background — so switching chips could slide the whole screen, the exact jump the board
   * exists not to have. `usePullRefresh` is the title page's answer to the same defect.
   */
  const boardPull = usePullRefresh(
    useCallback(
      () => [leaderboard.refetch(), standing.refetch()],
      [leaderboard.refetch, standing.refetch],
    ),
  );
  /**
   * Whether the shelf will draw anything, so the header row knows whether to name it.
   *
   * The same query key `TrendingShelf` reads, so React Query answers both from one fetch
   * — this costs no request. Lifting the whole shelf's data into the screen would have
   * been the alternative and is worse: the shelf owns its own scores, its own failure
   * behaviour and its own staleness, and none of that belongs here.
   */
  const trendingHasItems = (useTrending().data?.items ?? []).length > 0;

  /** Only a genuine change: re-choosing the timeframe on screen is not one. */
  const changeTimeframe = (next: LeaderboardTimeframe) => {
    if (next === timeframe) return;
    board.changeTimeframe(next);
  };

  /**
   * Entering a mode, with the analytics events these surfaces need.
   *
   * Emitted on the *transition into* a mode rather than on render, so leaving and coming
   * back is a second view — which it is, being a second decision to look — while a
   * re-render caused by anything else on this busy screen is not.
   *
   * `source` on the People event is what separates the two mechanisms §A15 is about: this
   * path is somebody finding the control, and `arriveAtPeople` below is somebody being
   * sent. Whether the permanent mode is enough on its own is the question, and one event
   * that could not tell them apart would not answer it.
   */
  const changeMode = (next: FeedMode) => {
    if (next === mode) return;
    setMode(next);
    if (next === 'leaderboard') track({ name: 'leaderboard_viewed', props: { metric } });
    if (next === 'people') {
      track({
        name: 'people_suggestions_viewed',
        props: { source: 'people', mode: DEFAULT_PEOPLE_MODE },
      });
    }
  };

  /**
   * **Arriving on People from somewhere else** (§A15).
   *
   * The end of onboarding and an empty Feed both send people here *to find people*, and
   * `show=people` is how they say so. Read on change and consumed in the same breath, the
   * way For You used to read the same parameter and the profile tab reads its `awards` one:
   * a tab stays mounted, so an initial-state read alone would open nothing for somebody who
   * had already visited the Feed, and the parameter is cleared immediately so that choosing
   * Feed afterwards is not undone by a value still sitting in the URL.
   *
   * `from` rides with it purely so the event can name the mechanism. An unrecognised value
   * falls back to the permanent mode's own source rather than being sent through — the
   * property is a closed set of four words and a URL is a place a stranger can type.
   */
  const { show, from } = useLocalSearchParams<{ show?: string; from?: string }>();
  useEffect(() => {
    if (show !== 'people') return;
    // Synchronising FROM an external system — the URL — which is the case the rule's own
    // doc carves out; the param is consumed in the same breath, so this fires once per
    // arrival rather than per render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode('people');
    track({
      name: 'people_suggestions_viewed',
      props: {
        source: from === 'onboarding' || from === 'sparse_feed' ? from : 'people',
        mode: DEFAULT_PEOPLE_MODE,
      },
    });
    router.setParams({ show: undefined, from: undefined });
  }, [show, from, router]);

  /**
   * **Android's hardware Back, while a non-Feed mode is showing** (founder physical bug).
   *
   * Leaderboard is a *mode* of this route, not a route of its own, so the navigator had
   * nothing to pop and Back exited the app from what the reader experienced as a
   * second screen. The founder's instruction was explicit: do not invent a route to
   * solve this. So the mode consumes the event itself and hands the reader back to the
   * Feed, which is where they came from.
   *
   * **`showingFeed` rather than `showingBoard` since People arrived.** People is the same
   * shape of thing — a mode that a reader experiences as a second screen — and a handler
   * that named the board would have let Back close the app from it. The test is now "is
   * the Feed showing", which is the sentence this handler always meant.
   *
   * `useFocusEffect`, not `useEffect`: this tab stays mounted while the reader is on
   * another one, and a listener that outlived focus would swallow Back on Collection.
   *
   * Registered unconditionally rather than behind a `Platform.OS` check, and returning
   * `false` when the Feed is showing — which is the two halves of "iOS behaviour is
   * preserved". `BackHandler` on iOS is a stub whose `addEventListener` returns a
   * remover and never fires, so the check would only hide the code from the tests.
   * Returning `false` leaves normal route back behaviour exactly where it was.
   *
   * `setMode` rather than `changeMode`: leaving the board is not a `leaderboard_viewed`
   * event, and the remembered category and timeframe are separate state that this does not
   * touch — coming back to the board returns to what they chose.
   */
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (showingFeed) return false;
        setMode('feed');
        return true;
      });
      return () => subscription.remove();
    }, [showingFeed]),
  );

  /**
   * **Re-tapping the Feed tab** (founder, 2026-08-30, widened 2026-09-09).
   *
   * The other half of the complaint the hardware-Back handler above answers, and it is
   * the half iOS has: Leaderboard is a mode of this route, so pressing the tab you are
   * already on had nothing to pop and left the reader looking at the board they were
   * trying to leave.
   *
   * This screen grew that listener first and now shares it — `useTabReset` is the same
   * subscription on all five tabs, and the rules it enforces (already-focused only,
   * nothing prevented) are stated there. What is left here is the only part that is
   * this screen's own: what its root is.
   *
   * `showingFeed`, not `showingBoard`: People is a mode a reader experiences as a second
   * screen too, and re-tapping the tab must leave it the same way. `setMode` rather than
   * `changeMode`, because leaving the board is not a `leaderboard_viewed` event and the
   * remembered category and timeframe are somebody else's state.
   *
   * **Already on the Feed, so the habit's other half applies**: back to the top of it.
   * No refetch — the reader has pull-to-refresh for that, and spending a round trip to
   * animate something nobody asked for is how a gesture becomes expensive.
   */
  const scroller = useRef<ScrollView>(null);

  useTabReset(
    useCallback(() => {
      if (!showingFeed) {
        setMode('feed');
        return;
      }
      scroller.current?.scrollTo({ y: 0, animated: true });
    }, [showingFeed]),
  );

  /** Only a genuine change. Re-choosing the category on screen would measure fidgeting. */
  const changeMetric = (next: LeaderboardMetric) => {
    if (next === metric) return;
    board.changeMetric(next);
    track({ name: 'leaderboard_metric_selected', props: { metric: next } });
  };
  // Which row has the picker open, and which has its detail sheet open. Two
  // separate ideas: the picker changes your own reaction, the detail shows everyone
  // else's, and a row can be in neither.
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  // The event whose comments are open. A third independent idea, for the same reason
  // the first two are separate: a row can be in any, all or none of these states.
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  /**
   * The aggregated follow story whose list of people is open, or none (§A12).
   *
   * An event id rather than the event, so the sheet redraws against whatever the feed
   * currently holds: the story is mutable server-side — a follow made in the same hour
   * appends to it — and a snapshot taken at press time would list a set the row behind it
   * had already outgrown.
   */
  const [followStoryFor, setFollowStoryFor] = useState<string | null>(null);
  /** The grouped ranking post whose titles are open, if any (20261020000100). */
  const [watchlistGroupFor, setWatchlistGroupFor] = useState<string | null>(null);
  const [rankingBatchFor, setRankingBatchFor] = useState<{
    id: string;
    medium: string;
    /** Whose group it is, so the sheet can show their reviews of its titles. */
    actorId?: string;
  } | null>(
    null,
  );
  /**
   * The post whose "with Anna and 2 others" is open, or none (founder, 2026-11-19). An id,
   * resolved against the current list like `followStoryFor`, so a refresh that drops the
   * post closes the sheet.
   */
  const [companionsFor, setCompanionsFor] = useState<string | null>(null);
  /**
   * The event being recommended, if any.
   *
   * The whole event rather than an id, because the sheet needs the title and the kind
   * and both are already on the row that opened it. Held here rather than per row so
   * one sheet exists for the whole list.
   */
  const [recommending, setRecommending] = useState<FeedItem | null>(null);
  /** Whom the last recommendation went to, so the confirmation names a person. */
  const [recommendedTo, setRecommendedTo] = useState<string | null>(null);

  /**
   * The loaded pages, flattened and deduped once.
   *
   * `feedItems` rather than a `flatMap` here, because the dedupe is part of what makes
   * the pagination correct rather than a tidy-up: a refresh trims the list back to one
   * page, and the page read after that is measured from a first page that has moved.
   */
  const events = useMemo(() => feedItems(feed.data?.pages), [feed.data]);
  const eventIds = useMemo(() => events.map((event) => event.id), [events]);
  const reactions = useReactions(eventIds, profile.id);
  const commentCounts = useCommentCounts(eventIds, profile.id);
  const groupPreviews = useGroupPreviews(events, profile.id);
  // The reader's own watchlist: every bookmark on this screen reads it, and only it.
  const saved = useMemo(
    () => new Set((watchlist.data ?? []).map((entry) => entry.mediaItemId)),
    [watchlist.data],
  );

  /**
   * **A grouped post's rail, or null for the cinematic card** (Feed poster rails).
   *
   * A group with two or more previewed members is drawn as its posters. While the preview
   * loads it is drawn as placeholders, already sized. If the read failed, or it found fewer
   * than two members it may show, the post falls back to the representative card it always
   * had — with its "and N others" and the complete list — so the post and its
   * conversation are never hidden and a short preview never passes for the whole group.
   */
  const railFor = (event: FeedItem) => {
    const total = groupCount(event);
    if (!total) return null;
    const rows = groupPreviews.data?.get(previewKey(event, total));
    const openAll = () =>
      event.type === 'ranking_batch'
        ? setRankingBatchFor({
            id: event.id,
            medium: batchMedium(event.kind),
            actorId: event.actorId,
          })
        : setWatchlistGroupFor(event.id);
    if (rows === undefined) {
      if (groupPreviews.isError) return null;
      return { total, tiles: [], loading: true, onPressTile: () => {}, onPressAll: openAll };
    }
    if (rows.length < 2) return null;
    return {
      total,
      tiles: rows.map((row) => ({
        id: row.mediaItemId,
        title: row.title,
        year: row.year,
        /**
         * **TMDB's `w342`, not `w500`** (perf P8, 2026-11-25). A rail tile is 65–95 pt across
         * supported phones (three whole posters and a 0.7 peek inside the card; no tablets),
         * so 130–285 px at 2–3x. `w342` covers that with at least 20% to spare; `w500` was
         * 2.1× the pixels to fetch and decode for detail the tile cannot show, on up to 12
         * tiles per grouped post. It is also the size Collection and For You use, so a poster
         * seen there is already in the disk cache here.
         */
        posterUri: posterUri(row.posterPath, 'row'),
        // The author's score on a ranked title; a save carries none.
        score: row.action === 'saved' ? null : row.score,
        season: row.seasonNumber,
        // The READER's watchlist, never the author's (founder, 2026-11-22).
        saved: saved.has(row.mediaItemId),
      })),
      onPressTile: (tile: { id: string }) => router.push(`/title/${tile.id}`),
      onPressAll: openAll,
      // The reader's bookmark on every poster: the same write, guard and reconciliation as
      // the single-title card's (`toggleWatchlist`).
      onToggleSave: (tile: { id: string }) => void toggleWatchlist(tile.id),
    };
  };
  const { setReaction } = useSetReaction(profile.id);

  /** One post's sentence, shared with every surface that draws a post (`activitySentence`). */
  const sentenceFor = (event: FeedItem) =>
    activitySentence(event, {
      ranking: () =>
        setRankingBatchFor({
          id: event.id,
          medium: batchMedium(event.kind),
          actorId: event.actorId,
        }),
      watchlist: setWatchlistGroupFor,
    });

  const choose = async (eventId: string, kind: ReactionKind | null) => {
    setPickerFor(null);
    const result = await setReaction(eventId, kind);
    // One rule for every surface: a self-reaction is answered calmly on its own, anything
    // else under the alert it always had (`reactionFailureAlert`).
    const alert = reactionFailureAlert(result, 'Could not save your reaction');
    if (alert) Alert.alert(...alert);
  };

  /**
   * A plain tap on the control.
   *
   * Toggles the default reaction: nothing becomes a heart, and a heart becomes
   * nothing. If some *other* reaction is already set, a tap replaces it with the
   * heart rather than clearing it — the gesture means "react", and the way to remove
   * a reaction you can see is to tap the one you chose.
   */
  const toggleDefault = (eventId: string) => {
    const mine = reactions.data?.get(eventId)?.mine ?? null;
    return choose(eventId, mine === DEFAULT_REACTION ? null : DEFAULT_REACTION);
  };

  // Adding a friend's title to your own watchlist is the feed's whole point —
  // PRD §28 counts it as the product's core virality metric — so it happens
  // here rather than a page away.
  const toggleWatchlist = async (mediaItemId: string) => {
    if (busy) return;
    setBusy(mediaItemId);
    const present = !saved.has(mediaItemId);
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId,
      present,
    });
    setBusy(null);

    // Additions only, and only on `ok`. Removing is not a question the beta asks, and
    // `already_applied` is one intent replayed rather than a second save.
    if (present && result.outcome === 'ok') {
      track({ name: 'watchlist_added', props: { surface: 'feed' } });
    }

    /**
     * **Reconciled before the error is shown, not instead of it.**
     *
     * `set_watchlist` can commit and lose its reply — a dropped socket, a timeout, an
     * `08007` out of the pooler — and the client cannot tell that from a refusal. This
     * screen used to alert and return, so the row stayed saved on the server, the
     * bookmark stayed empty here, and Queue Dragon went on counting the old number for
     * the full `staleTime`. `mustReconcile` is true for a commit and for an unknown, and
     * false only for a refusal this app raises on purpose (`lib/write-outcome.ts`).
     * Independent review 21e, Major 3.
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
   * Recommend, which is where sharing lives now.
   *
   * The row used to open the native share sheet straight from a Share icon. Four
   * controls and a timestamp is what made this row overflow a narrow Android screen,
   * and of the four this was the one that had somewhere better to be: the Recommend
   * sheet sends to a named friend *and* ends in "Share off Bingd", so the off-platform
   * path survives one tap further in.
   *
   * A whole show is offered too since 2026-11-14: it is rankable in its own pool, and
   * `recommend_title` resolves it the same way it resolves a film or a season.
   */
  const openRecommend = (event: FeedItem) => {
    if (!event.mediaItemId) return;
    setRecommendedTo(null);
    setRecommending(event);
  };

  /**
   * Ask for the next page when the reader is within a screenful of the end.
   *
   * The three guards are the whole of the concurrency story, and `isFetchingNextPage` is
   * the one that matters: `onScroll` fires on every frame of a flick, so without it a
   * single gesture through the threshold would post the same request a dozen times.
   * React Query would coalesce them onto one entry, but each is still a round trip.
   * `hasNextPage` is what makes the true end quiet — once `getNextPageParam` has
   * returned null, the bottom of the list stops asking for anything at all.
   *
   * `isError` is deliberate too. A failed page 2 must not be retried by the scroll
   * position the reader is already sitting at, or a dead connection becomes a request
   * loop; the footer offers the retry instead, and that is the only way back.
   *
   * Neither the board nor People has pages, so the handler does nothing in either mode.
   * `showingFeed` rather than `!showingBoard` since People arrived: a list of ten
   * suggestions is shorter than the threshold, so the old test would have asked for the
   * next page of *activity* on every scroll of a surface that has none.
   */
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!showingFeed) return;
    if (!feed.hasNextPage || feed.isFetchingNextPage || feed.isError) return;
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const fromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    if (fromBottom <= NEXT_PAGE_THRESHOLD) void feed.fetchNextPage();
  };

  const openComments = commentsFor ? (events.find((e) => e.id === commentsFor) ?? null) : null;
  /**
   * Resolved from the current list rather than held, for the reason `followStoryFor` records:
   * the story grows, and the sheet must list what the row now says. Null once the row has
   * left the page — a refresh that drops it closes the sheet, which is the honest outcome.
   */
  const openFollowStory = followStoryFor
    ? (events.find((e) => e.id === followStoryFor) ?? null)
    : null;
  const openCompanions = companionsFor
    ? (events.find((e) => e.id === companionsFor) ?? null)
    : null;

  return (
    <Screen>
      {/**
       * **The app bar is the app bar again** — wordmark left, bell right, and nothing
       * else (founder follow-up §1).
       *
       * The Feed/Trophy toggle lived here for a day. It fitted, and it was the wrong
       * place: the top bar is the one row that is identical on every tab, so a control
       * that appears on exactly one of them makes the app's most stable landmark move.
       * It also put a *content* decision — which list am I reading — in the chrome,
       * beside a control about a different thing entirely.
       *
       * It is now in the content header row below, opposite whatever that content is
       * called. The bell keeps its corner and its hit area untouched.
       */}
      <AppHeader
        notifications={{
          count: unreadCount(notifications.data),
          onPress: () => router.push('/settings/notifications'),
        }}
      />
      <HeaderBoundary />
      {/* Pull to refresh, which the app did not have anywhere and which a feed of
          other people's activity is the one screen that genuinely needs: nothing
          invalidates this query when somebody else ranks something, so a reader
          looking at a quiet feed had no way to ask whether it was still quiet.
          Reactions and comment counts come with it — they are read alongside the
          events and are the part most likely to have moved. */}
      <ScrollView
        ref={scroller}
        // Named so the pagination suite can drive a scroll at it. The screen holds a
        // second, horizontal ScrollView inside the trending shelf, so "the ScrollView"
        // is ambiguous by type and a label is the only unambiguous handle.
        testID="feed-scroll"
        contentContainerStyle={styles.content}
        onScroll={onScroll}
        // 16ms: the threshold is measured against a scroll that can be a fast flick, and
        // the default (0, meaning once) would let a reader shoot past the end of the
        // list without the handler ever seeing that they were near it.
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={
              showingBoard
                ? boardPull.refreshing
                : showingPeople
                  ? // Its two queries live inside `PeopleView`, so this gesture reaches
                    // them by key below and there is no `isRefetching` up here to read.
                    // False rather than a spinner tied to nothing: a control that spins
                    // for ever is worse than one that does not spin at all.
                    false
                  : feed.isRefetching
            }
            onRefresh={() => {
              // Whichever mode is showing IS the whole screen, so the gesture means
              // "re-read this" and nothing else. Refetching the feed underneath it would
              // spend two requests to update something nobody is looking at.
              if (showingBoard) {
                boardPull.onRefresh();
                return;
              }
              if (showingPeople) {
                /**
                 * By key, because the two suggestion queries belong to `PeopleView` and
                 * this control belongs to the screen — the same arrangement the trending
                 * shelf already has below, and for the same reason: handing a `refetch`
                 * back up through props would make the child's cache the parent's
                 * business.
                 *
                 * Both lists, not just the visible one. The chips switch instantly from
                 * cache, so a refresh that only re-read Mutuals would leave Match one tap
                 * away and stale, which is the thing a deliberate refresh is for.
                 */
                void queryClient.refetchQueries({
                  queryKey: ['people-mutuals', profile.id],
                });
                void queryClient.refetchQueries({
                  queryKey: ['people-taste-matches', profile.id],
                });
                return;
              }
              // Back to one page before the refetch, so the gesture costs one request
              // rather than one per page the reader had scrolled through — and so the
              // list it returns is the newest page rather than the same five pages
              // re-read in place. `refetch` keeps the old rows drawn underneath, so
              // nothing flashes and nothing jumps.
              trimFeedToFirstPage(queryClient, profile.id);
              void feed.refetch();
              void reactions.refetch();
              void commentCounts.refetch();
              // The rails too (Codex, PR 312): a rerank or an unrank keeps a group's id
              // and count, so its preview key does not move, and only a refetch here
              // brings a poster's score up to what the member sheet already shows.
              void groupPreviews.refetch();
              // The bell is on this screen, so a reader pulling to see what is new is
              // asking about it too. Leaving it out meant the one deliberate "refresh
              // this page" gesture in the app refreshed everything on it except the
              // control most likely to be wrong.
              void notifications.refetch();
              // And the shelf above the activity, which is the part of this screen a
              // reader is most likely to be pulling *at*: it renders nothing when its
              // read fails, so "Trending is gone, let me pull to refresh" was the
              // obvious recovery and the one gesture that could not perform it. The
              // shelf owns its own query, so this reaches it by key rather than by
              // handing a `refetch` back up through props.
              void queryClient.refetchQueries({ queryKey: queryKeys.trending() });
            }}
            tintColor={theme.semantic.action}
            colors={[theme.semantic.action]}
          />
        }
      >
        {/**
         * The board replaces the whole content area, Trending included.
         *
         * Not a section appended below the feed. The founder's word for it is a mode:
         * "toggling Trophy switches the main Feed content area into Leaderboard", and a
         * board sharing the screen with a shelf and an activity list would be a fourth
         * thing on the busiest screen in the app rather than an alternative to it.
         *
         * Everything the feed owns — the sheets below, the reaction pickers, the
         * recommend flow — stays mounted and untouched, so returning to Feed returns to
         * exactly the feed that was there. That is founder acceptance D.
         */}
        {/**
         * **The content header row** (founder follow-up §1).
         *
         *     TRENDING NOW                    [Feed] [Trophy] [People]
         *     LEADERBOARD                     [Feed] [Trophy] [People]
         *     DISCOVER PEOPLE                 [Feed] [Trophy] [People]
         *
         * One row, drawn in every mode, so the toggle keeps its position while the thing
         * across from it changes. That is what makes it read as a control over *this
         * content* rather than as chrome: it sits at the head of the list it switches.
         *
         * The left side is the heading of whatever is immediately below — the shelf's
         * name in Feed mode, LEADERBOARD in Leaderboard mode, and since 2026-09-08 (§A3)
         * the People heading in People mode, in the same slot with the same treatment. In
         * Leaderboard mode the board's own quiet control row (category ▾ and All time |
         * This month, `LeaderboardView`) follows directly under this one: a compact
         * two-row header (founder layout correction, 2026-11-23). In Feed mode it is drawn
         * only when the shelf will actually
         * render: `TrendingShelf` returns null when it has nothing, and a heading over an
         * absent shelf would be a label for nothing. `useTrending` is called here purely
         * to know that, and costs no request — it is the same query key the shelf itself
         * uses, so React Query answers both from one fetch.
         *
         * **Every heading on this tab is `FeedHeading`** (header consistency, founder spec
         * 2026-11-22): one component, one token and one text-size ceiling for TRENDING NOW,
         * LEADERBOARD, DISCOVER PEOPLE and RECENT ACTIVITY below, so the row does not change
         * size when the mode does. None is a dropdown: the board's category and timeframe are
         * its own control row, in `LeaderboardView`, and People's Mutuals / Match switch is in
         * `PeopleView`.
         */}
        <View style={styles.contentHeader} testID="feed-content-header">
          {/* Every occupant is a `FeedHeading`, which pads itself to the gutter. */}
          <View style={styles.contentHeaderLeft}>
            {showingBoard ? (
              <FeedHeading title="Leaderboard" />
            ) : showingPeople ? (
              // DISCOVER PEOPLE, not PEOPLE YOU MAY KNOW (founder, UI consistency sprint,
              // 2026-11-10): the list is discovery, and most suggestions are not people the
              // reader knows.
              <FeedHeading title="Discover people" />
            ) : trendingHasItems ? (
              <FeedHeading title="Trending now" />
            ) : null}
          </View>

          {/**
           * The same `IconToggle` Collection's Poster/List control uses — one component,
           * so the two cannot drift into two dialects of the same idea. They behave
           * differently on purpose: Collection persists its choice across launches and
           * this one deliberately does not (§6), which is exactly why they must look the
           * same by construction rather than by agreement.
           */}
          <IconToggle
            label="Feed mode"
            value={mode}
            onChange={changeMode}
            options={FEED_MODES}
          />
        </View>

        {showingBoard ? (
          <LeaderboardView
            metric={metric}
            onChangeMetric={changeMetric}
            timeframe={timeframe}
            onChangeTimeframe={changeTimeframe}
            entries={leaderboard.data}
            // Only beside a board that is current. While the rows on screen are the previous
            // metric's, a standing for either metric would be drawn under the wrong list.
            standing={leaderboard.isPlaceholderData ? undefined : standing.data}
            updating={leaderboard.isPlaceholderData}
            loading={leaderboard.isPending}
            onPressPerson={(username) => router.push(`/u/${username}`)}
          />
        ) : showingPeople ? (
          /**
           * People replaces the whole content area, Trending included — the same rule the
           * board follows and for the same reason (founder's word for it is a mode). It
           * owns its own two queries and its own sub-chips; everything the feed owns below
           * stays mounted and untouched, so coming back returns to exactly the feed that
           * was there.
           */
          <PeopleView viewerId={profile.id} />
        ) : (
          <>
            {/* One shelf, above the activity. It renders nothing at all when there is
            nothing to show, so the social feed keeps the top of the screen whenever
            discovery has nothing to add — which is the ordering PRD §14 wants.

            `showTitle={false}`: its heading moved up into the content header row above,
            opposite the toggle. Drawing it in both places would be the same words twice. */}
            <View style={styles.trending}>
              <TrendingShelf
                userId={profile.id}
                showTitle={false}
                onPressTitle={(mediaItemId) => router.push(`/title/${mediaItemId}`)}
              />
            </View>

            {/**
             * **Where discovery ends and the social feed begins: one rule, then RECENT
             * ACTIVITY** (founder, marquee cohesion sprint, 2026-11-07).
             *
             * The nav cohesion sprint took the boundary down to whitespace alone, and on the
             * phone the first post then read as part of the rail. Now: the Feed's own
             * separator (the hairline between posts) under Trending, 16pt either side of it,
             * and the heading in the Feed's section-heading token, as TRENDING NOW is. The
             * first post's outline sits 16pt under its line, the distance TRENDING NOW keeps to
             * its shelf (`activityStart`), so the heading belongs to what follows. The rule is
             * drawn only under a shelf; with no shelf there is nothing to divide.
             */}
            <View style={styles.activityStart} testID="feed-activity-start">
              {trendingHasItems ? <View style={styles.activityRule} /> : null}
              <FeedHeading title="Recent activity" tight />
            </View>

            {/* The confirmation, on the screen the reader is still looking at rather than in
            an alert they have to dismiss. It names the person, because "Sent" on its own
            leaves them checking. Same shape as the title page’s. */}
            {recommendedTo ? (
              <View style={styles.pad}>
                <Text variant="footnote" tone="secondary">
                  {`Recommended to ${recommendedTo}`}
                </Text>
              </View>
            ) : null}

            {/**
             * The whole-screen failure is now **the first page's failure and no other**.
             *
             * An infinite query reports a failed page on the query itself, so the old
             * `feed.isError` test would have thrown away thirty rows the reader was
             * already looking at because page four timed out. A failure with rows on
             * screen belongs in the footer, next to the retry, and keeps the list.
             */}
            {feed.isError && events.length === 0 ? (
              <View style={styles.pad}>
                <EmptyState
                  kind="couldNotLoad"
                  title="Could not load activity"
                  body="Check your connection and try again."
                  action={{ label: 'Try again', onPress: () => void feed.refetch() }}
                />
              </View>
            ) : feed.isPending ? (
              <SkeletonRow count={5} />
            ) : events.length === 0 ? (
              /**
               * **One action, into People** (pre-GTM audit, 2026-09-07).
               *
               * The copy already said "follow someone", and nothing on the screen led to
               * anybody: People lives behind For You's category selector, which a
               * stranger on an empty Feed has no reason to open. This is the same
               * destination onboarding's summary now offers, on the same parameter — not
               * an Everyone feed, not a contacts import, and not a banner that survives
               * the first activity, because this branch is gone the moment there is one.
               */
              <View style={styles.pad}>
                <EmptyState
                  kind="nothingYet"
                  compact
                  title="Your feed is quiet right now."
                  body="Rank a title, or follow someone, and activity will appear here."
                  action={{
                    label: 'Find your people',
                    // Same tab, People mode — which since 2026-09-08 means this pushes the
                    // route it is already on with a parameter, rather than sending somebody
                    // to For You. `sparse_feed` is how `people_suggestions_viewed` tells
                    // this mechanism apart from the toggle two lines above it.
                    onPress: () => router.push(peopleDiscovery('sparse_feed')),
                  }}
                />
              </View>
            ) : (
              events.map((event, index) =>
                /**
                 * **A follow story is a different row** (§§A9, A12), and it is a different
                 * row rather than an `ActivityRow` with six props left off.
                 *
                 * What `ActivityRow` is for is an activity *about a title*: it leads with a
                 * poster, carries a score badge, a note with spoiler masking, watch
                 * companions, a watchlist bookmark, a Recommend control, a reaction pill and
                 * a comment count. A follow story has none of those and can never have any
                 * of them — so the version of this that passes `title={firstPersonName}` and
                 * `posterUri={undefined}` is one where the next person to add a prop to
                 * `ActivityRow` has to remember that one caller means something else by
                 * every field.
                 *
                 * **No reactions and no comments, deliberately.** §A9's instruction is that
                 * follow activity is *social discovery content* and not an audit log, and a
                 * follow you can react to and comment under is neither: it is a post about
                 * somebody's relationship, on which the two people best placed to feel
                 * strange about a thread are the ones named in it.
                 */
                /**
                 * **A whole sitting is one row** (20261020000100). Working through an
                 * imported library posts one grouped story rather than forty, and it is
                 * its own row for the follow story's reason: `ActivityRow` is about one
                 * title and carries eight controls that a post about eighteen titles has
                 * no use for.
                 */
                event.type === 'follow_added' ? (
                  /* Every post on the Feed's card surface (refined card feed, 2026-11-22);
                     the row inside it is unchanged. */
                  <FeedPostSurface key={event.id} leading={index === 0} row>
                  <FollowStoryRow
                    event={event}
                    onPressActor={
                      event.actorUsername
                        ? () => router.push(`/u/${event.actorUsername}`)
                        : undefined
                    }
                    onPressPerson={(username) => router.push(`/u/${username}`)}
                    onOpenList={() => {
                      track({ name: 'follow_activity_opened' });
                      setFollowStoryFor(event.id);
                    }}
                  />
                  </FeedPostSurface>
                ) : takesFeedCard(event) ? (
                  /**
                   * **A title activity is a cinematic card** (founder-approved direction,
                   * 2026-11-04). The same values and callbacks the row below is handed —
                   * the sentence, the live score, the spoiler decision, the watchlist write,
                   * the Recommend sheet, the reaction gestures — laid out around the title's
                   * artwork instead of beside a 40pt poster. Awards and goals keep the row.
                   */
                  <FeedCard
                    key={event.id}
                    leading={index === 0}
                    actorName={event.actorName}
                    actorAvatarUri={event.actorAvatarUri}
                    onPressActor={
                      event.actorId === profile.id || !event.actorUsername
                        ? undefined
                        : () => router.push(`/u/${event.actorUsername}`)
                    }
                    verb={sentenceFor(event).verb}
                    tail={sentenceFor(event).tail}
                    tailAction={sentenceFor(event).tailAction}
                    companions={event.companions}
                    onPressCompanions={() => setCompanionsFor(event.id)}
                    title={event.title}
                    year={event.year}
                    metadata={metadataFor(event)}
                    watchLabel={watchLabel(event.watchNumber)}
                    timeLabel={relativeTime(event.activityAt)}
                    artwork={feedArtwork(event)}
                    score={event.score}
                    bucket={event.bucket}
                    review={
                      event.note
                        ? {
                            text: event.note.text,
                            hasSpoilers: event.note.hasSpoilers,
                            masked: shouldMask({
                              hasSpoilers: event.note.hasSpoilers,
                              mediaItemId: event.mediaItemId,
                              viewerId: profile.id,
                              authorId: event.actorId,
                              watched: watched.data,
                            }),
                          }
                        : null
                    }
                    onPressTitle={() => router.push(`/title/${event.mediaItemId}`)}
                    reaction={reactionFor(event.id)}
                    onPressComments={() => setCommentsFor(event.id)}
                    commentCount={commentCounts.data?.get(event.id) ?? 0}
                    /**
                     * The reader's bookmark on the artwork (founder, 2026-11-22), on their
                     * own posts too: any title can be watchlisted. A group has none here,
                     * because each of its posters carries its own, and a group drawn as its
                     * representative card would save one member only. Share stays an
                     * individual title's (founder, 2026-11-19; `docs/design/screens.md` §7).
                     */
                    onPressSave={
                      event.mediaItemId && !groupCount(event)
                        ? () => toggleWatchlist(event.mediaItemId!)
                        : undefined
                    }
                    saved={saved.has(event.mediaItemId!)}
                    onPressShare={groupCount(event) ? undefined : () => openRecommend(event)}
                    rail={railFor(event)}
                  />
                ) : (
                <FeedPostSurface key={event.id} leading={index === 0} row>
                <ActivityRow
                  actorName={event.actorName}
                  actorAvatarUri={event.actorAvatarUri}
                  // Own activity has no profile to visit that is not the tab the user
                  // is already one tap from, so the name is not a link on those rows.
                  onPressActor={
                    event.actorId === profile.id || !event.actorUsername
                      ? undefined
                      : () => router.push(`/u/${event.actorUsername}`)
                  }
                  verb={sentenceFor(event).verb}
                  tail={sentenceFor(event).tail}
                  /* A grouped sitting reads "ranked Sheroes and 2 more": the connector
                     is ordinary ink so the eye finds the break after the title, and the
                     count is the thing you press to see the rest (20261023000100). A
                     session reads "ranked Kaiju No. 8 + 15 more" (20261130000900). */
                  tailAction={sentenceFor(event).tailAction}
                  companions={event.companions}
                  onPressCompanions={() => setCompanionsFor(event.id)}
                  title={event.title}
                  year={event.year}
                  posterUri={posterUri(event.posterPath)}
                  // The badge leads an award row — the real artwork, in the poster's
                  // box (20260828000100). Everything else about the row is ordinary.
                  //
                  // Resolved by `activityLead` rather than decided here, since 2026-09-06:
                  // the profile drew a beige "S" where this drew Spark, because what leads a
                  // row is a property of the activity and three call sites were each having
                  // an opinion about it.
                  lead={activityLead(event)}
                  /**
                   * The second line, and on these two types it is the only thing that says
                   * what actually happened (founder, 2026-08-29).
                   *
                   * It was `Bronze` on an award row and `25 movies` on a goal row. Neither
                   * is product copy: a metal names a tier and not an achievement, and a bare
                   * count is a fragment. Both now come from a shared function —
                   * `awardAnnouncement` off the canonical thresholds, `goalAchievement` off
                   * the completion's own frozen target — so this row and the earner's inbox
                   * row cannot quote different numbers for one event.
                   *
                   * `metadataFor` is still the answer everywhere else, and would otherwise
                   * reach for a runtime and a certification that neither of these rows has.
                   */
                  metadata={
                    event.award
                      ? event.award.achievement
                      : event.goal
                        ? goalAchievement(event.goal.category, event.goal.target)
                        : metadataFor(event)
                  }
                  watchLabel={watchLabel(event.watchNumber)}
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
                  timeLabel={relativeTime(event.activityAt)}
                  // An award row opens the earner's Awards, not a title (§5): their
                  // own tab for the viewer's own award, the public profile's sheet
                  // for anybody else's. An event with neither subject is a no-op.
                  onPressTitle={() => {
                    if (event.mediaItemId) {
                      router.push(`/title/${event.mediaItemId}`);
                    } else if (event.award) {
                      if (event.actorId === profile.id) {
                        router.push({ pathname: '/profile', params: { awards: '1' } });
                      } else if (event.actorUsername) {
                        router.push({
                          pathname: '/u/[username]',
                          params: { username: event.actorUsername, awards: '1' },
                        });
                      }
                    } else if (event.goal) {
                      /**
                       * The earner's profile, where their goals live (founder §12).
                       *
                       * Not a dead end and not a title: the useful thing to do with "Abisola
                       * hit their 2026 Movies goal" is look at Abisola. No `?awards=1` here —
                       * goals are on the profile itself, a scroll under the identity block,
                       * rather than behind a sheet.
                       */
                      if (event.actorId === profile.id) {
                        router.push('/profile');
                      } else if (event.actorUsername) {
                        router.push(`/u/${event.actorUsername}`);
                      }
                    }
                  }}
                  // Watchlisting your own already-watched title is not a thing anyone
                  // means to do, so the control is not offered on your own activity. Nor
                  // on a group, whose Save and Share would act on one member (2026-11-19).
                  onPressWatchlist={
                    event.mediaItemId && event.actorId !== profile.id && !groupCount(event)
                      ? () => toggleWatchlist(event.mediaItemId!)
                      : undefined
                  }
                  inWatchlist={event.mediaItemId ? saved.has(event.mediaItemId) : false}
                  onPressRecommend={
                    event.mediaItemId && !groupCount(event)
                      ? () => openRecommend(event)
                      : undefined
                  }
                  reaction={reactionFor(event.id)}
                  onPressComments={() => setCommentsFor(event.id)}
                  commentCount={commentCounts.data?.get(event.id) ?? 0}
                  /**
                   * The Feed card's labelled Like · Comment row on every post this row
                   * draws here — an award, a goal (founder, 2026-11-19). Neither has a
                   * Save, and neither has a Share: there is no link to send for an award
                   * yet, so the row offers none rather than a dead one (screens.md §7).
                   */
                  labelledActions
                />
                </FeedPostSurface>
                ),
              )
            )}

            {/**
             * The foot of the list, which says one of three things and never two.
             *
             * A spinner while the next page is in flight; a retry when one failed; and,
             * once the server has genuinely run out, a single quiet line. The order is the
             * order of precedence — a fetch in flight outranks the error that preceded it,
             * because the retry is what put it in flight.
             *
             * The end line is drawn only under a list that has something in it. An empty
             * feed already has its own empty state saying considerably more, and "That's
             * everything" under it would be the screen agreeing with itself.
             */}
            {feed.isFetchingNextPage ? (
              <View style={styles.footer}>
                <ActivityIndicator color={theme.semantic.action} />
              </View>
            ) : feed.isError && events.length > 0 ? (
              <View style={styles.footer}>
                <Text variant="footnote" tone="secondary">
                  Could not load more activity.
                </Text>
                {/* Retries the failed page and nothing else: `fetchNextPage` resumes from
                the cursor of the last page that succeeded, so the rows already on
                screen are neither re-read nor disturbed. */}
                <Button
                  kind="tertiary"
                  size="sm"
                  label="Try again"
                  onPress={() => void feed.fetchNextPage()}
                />
              </View>
            ) : !feed.hasNextPage && events.length > 0 ? (
              <View style={styles.footer}>
                <Text variant="footnote" tone="secondary">
                  You&rsquo;re all caught up.
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* Mounted only while open, like every other sheet: it seeds its own draft state
          on mount, and one that stayed mounted would keep a search somebody abandoned.

          `seriesTitle` is null on purpose. A feed event’s `title` is already the long
          form — the show and the season together — so handing the sheet a parent as well
          would have it join a name to itself. */}
      {recommending?.mediaItemId ? (
        <RecommendSheet
          viewerId={profile.id}
          mediaItemId={recommending.mediaItemId}
          kind={recommending.kind ?? 'movie'}
          title={recommending.title ?? 'this title'}
          seriesTitle={null}
          onClose={() => setRecommending(null)}
          onSent={setRecommendedTo}
          surface="feed"
        />
      ) : null}

      <ReactionDetail
        summary={detailFor ? (reactions.data?.get(detailFor) ?? null) : null}
        onClose={() => setDetailFor(null)}
        onPressPerson={(username) => {
          setDetailFor(null);
          router.push(`/u/${username}`);
        }}
      />

      {/* The titles one Unranked sitting ranked (20261020000100). Mounted only while
          open, like every other sheet here: its read is a whole sitting's worth of rows
          and most visits never ask for it. */}
      {rankingBatchFor ? (
        <RankingBatchSheet
          eventId={rankingBatchFor.id}
          medium={rankingBatchFor.medium as 'movies' | 'tv_seasons'}
          actorId={rankingBatchFor.actorId}
          viewerId={profile.id}
          onClose={() => setRankingBatchFor(null)}
        />
      ) : null}

      {/* The titles one grouped watchlist post holds (20261125000100). Mounted only while
          open, like the sitting's sheet above it. A title closes the sheet and opens. */}
      {watchlistGroupFor ? (
        <WatchlistGroupSheet
          eventId={watchlistGroupFor}
          onPressTitle={(mediaItemId) => {
            setWatchlistGroupFor(null);
            router.push(`/title/${mediaItemId}`);
          }}
          onClose={() => setWatchlistGroupFor(null)}
        />
      ) : null}

      {/* Everyone behind "with Anna and 2 others" (2026-11-19). No read: the names are the
          post's own, so the list is exactly what the count was taken from. */}
      {openCompanions ? (
        <CompanionsSheet
          actorName={openCompanions.actorName}
          title={openCompanions.title}
          names={openCompanions.companions}
          onClose={() => setCompanionsFor(null)}
        />
      ) : null}

      {/* Mounted only while open, like every other sheet on this screen. Its one query is
          `follow_state_with` over people the page has already hydrated, so there is nothing
          to keep warm behind a sheet most visits never open. */}
      {openFollowStory ? (
        <FollowStorySheet
          event={openFollowStory}
          viewerId={profile.id}
          onPressPerson={(username) => router.push(`/u/${username}`)}
          onClose={() => setFollowStoryFor(null)}
        />
      ) : null}

      {/* The media item and the title come from the event, so spoiler masking is
          against the exact thing the activity is about — a season, never its parent
          series. `openComments` resolves the event once rather than letting the sheet
          look it up, so there is one place that decides what "this activity is about"
          means. */}
      <CommentSheet
        eventId={commentsFor}
        mediaItemId={openComments?.mediaItemId ?? null}
        title={openComments?.title ?? null}
        viewerId={profile.id}
        watched={watched.data}
        onClose={() => setCommentsFor(null)}
        onPressPerson={(username) => {
          setCommentsFor(null);
          router.push(`/u/${username}`);
        }}
      />
    </Screen>
  );

  function reactionFor(eventId: string) {
    const summary = reactions.data?.get(eventId);
    return activityReaction({
      summary,
      viewerId: profile.id,
      onToggle: () => void toggleDefault(eventId),
      onOpenPicker: () => setPickerFor(eventId),
      onOpenDetail: () => setDetailFor(eventId),
      picker:
        pickerFor === eventId ? (
          <ReactionPill
            current={summary?.mine ?? null}
            onChoose={(kind) => void choose(eventId, kind)}
            onDismiss={() => setPickerFor(null)}
          />
        ) : null,
    });
  }
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  pad: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
  /**
   * The foot of the activity list: the spinner, the retry and the end line.
   *
   * Centred and generously padded, because all three are things a reader arrives at
   * rather than reads on the way past — and because a spinner flush against the last row
   * reads as part of that row.
   */
  footer: {
    alignItems: 'center',
    gap: theme.space[2],
    paddingVertical: theme.space[6],
    paddingHorizontal: theme.layout.gutter,
  },
  // Collapses to nothing when the shelf renders null, so an absent shelf costs no
  // space rather than an empty band above the first activity row.
  trending: { gap: theme.space[2] },
  /**
   * The content header row: a heading on the left, the mode toggle on the right.
   *
   * The right gutter lives here; the left one is the `FeedHeading`'s own, which every
   * mode's heading is.
   */
  contentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: theme.layout.gutter,
    paddingTop: theme.space[3],
    minHeight: theme.layout.minTapTarget,
  },
  // Takes the space the toggle leaves, so a long heading truncates rather than pushing
  // the control off the row.
  contentHeaderLeft: { flex: 1, justifyContent: 'center' },
  /**
   * Trending's end, the rule and RECENT ACTIVITY: 16pt above and below the rule — and 16pt
   * from the heading's line to the first post's outline (heading system, 2026-11-22).
   *
   * That is the distance TRENDING NOW keeps to its shelf: 13pt of the 44pt row it shares
   * with the mode toggle, plus the rail's 4pt of room for a pressed poster. RECENT ACTIVITY
   * had 8 (the first card's own `FEED_CARD.leading`), which on the phone put the heading on
   * the card rather than over it. The card's margin is the card's; this is the heading's
   * share, so the two add up to the same 16 whatever the card does.
   */
  activityStart: {
    paddingTop: theme.space[4],
    paddingBottom: theme.space[4] - FEED_CARD.leading,
  },
  // The hairline between two posts (`FeedCard`), full width, as the Feed's other rules are.
  activityRule: {
    height: StyleSheet.hairlineWidth * 2,
    backgroundColor: theme.border.hairline,
    marginBottom: theme.space[4],
  },
});

// `metadataFor` and `relativeTime` used to be defined here. Both now live in
// `features/feed/activity.ts`, beside the rules they apply — which is where the first
// one's own comment always said they belonged, and which stopped being optional when the
// activity page became the third surface drawing one of these rows.
