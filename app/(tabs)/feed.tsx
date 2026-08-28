import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { AwardActivityLead } from '@/features/awards/AwardActivityLead';
import { GoalActivityLead } from '@/features/goals/GoalActivityLead';
import { unreadCount, useNotifications } from '@/features/notifications/use-notifications';
import { useWatchlist } from '@/features/collection/use-collection';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { mustReconcile, newOperationId, setWatchlist } from '@/features/collection/writes';
import { metadataFor, relativeTime, tailFor, verbFor } from '@/features/feed/activity';
import { CommentSheet } from '@/features/feed/CommentSheet';
import { ReactionDetail } from '@/features/feed/ReactionDetail';
import { ReactionPill } from '@/features/feed/ReactionPill';
import { useCommentCounts } from '@/features/feed/use-comments';
import { useFeed, type FeedItem } from '@/features/feed/use-feed';
import {
  DEFAULT_REACTION,
  REACTION_GLYPH,
  useReactions,
  useSetReaction,
  type ReactionKind,
} from '@/features/feed/use-reactions';
import { LeaderboardView } from '@/features/leaderboard/LeaderboardView';
import {
  DEFAULT_METRIC,
  DEFAULT_TIMEFRAME,
  isLeaderboardTimeframe,
  LEADERBOARD_TIMEFRAMES,
  useLeaderboard,
  useMyStanding,
  type LeaderboardMetric,
  type LeaderboardTimeframe,
} from '@/features/leaderboard/use-leaderboard';
import { RecommendSheet } from '@/features/recommendations/RecommendSheet';
import { TrendingShelf } from '@/features/trending/TrendingShelf';
import { useTrending } from '@/features/trending/use-trending';
import { track } from '@/lib/analytics';
import { readPref, writePref } from '@/lib/prefs';
import { posterUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { invalidateAfterWatchlistChange } from '@/features/collection/invalidate';
import {
  ActivityRow,
  AppHeader,
  EmptyState,
  HeaderBoundary,
  IconToggle,
  MediumSelector,
  Screen,
  SectionHeader,
  SkeletonRow,
  Text,
  type IconToggleOption,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Feed or Leaderboard — the two states of this tab's content area.
 *
 * Feed first, because it is the default and because the leftmost cell being the
 * default is the rule the Collection toggle follows too.
 */
type FeedMode = 'feed' | 'leaderboard';

/**
 * Which leaderboard timeframe this reader last chose, per account.
 *
 * **Not the Feed's mode**, which is deliberately not persisted (§2). The two are one line
 * apart in this file precisely because conflating them is the easy mistake: remembering
 * the timeframe is remembering how to draw a surface, and remembering the mode would be
 * remembering to replace the homepage.
 *
 * Local only, through the same `readPref`/`writePref` pair Collection's two preferences
 * use — a device habit rather than something about the account, so no column and no sync.
 */
const TIMEFRAME_PREF_KEY = 'leaderboard.timeframe';

const FEED_MODES = [
  // `newspaper` rather than `list`: Collection's list glyph means "the other way of
  // drawing this same thing", and this control's left cell means "the ordinary
  // homepage". Reusing the glyph would say the two toggles answer the same question.
  { value: 'feed', icon: 'newspaper-outline', label: 'Feed' },
  { value: 'leaderboard', icon: 'trophy-outline', label: 'Leaderboard' },
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
  const [metric, setMetric] = useState<LeaderboardMetric>(DEFAULT_METRIC);
  /**
   * Which timeframe the board is showing — **and this one IS remembered** (founder §2).
   *
   * The distinction the founder drew, and the reason the two live side by side here
   * without being conflated:
   *
   *   `mode`      not persisted. Leaderboard is an alternate surface, and a launch that
   *               opened on it would have replaced the homepage with a scoreboard.
   *   `timeframe` persisted. Once the reader is *in* the board, which timeframe they
   *               read it in is a preference about the same surface — the Collection
   *               Poster/List argument exactly — and re-choosing All time on every visit
   *               would be the app forgetting something it watched them decide.
   *
   * So: a fresh launch opens Feed; tapping Trophy opens the board on the timeframe they
   * last chose.
   */
  /**
   * **Tagged with the account it was read for**, which is `mediumPref`'s shape in
   * `CollectionScreen` and is here for the reason independent review found: without it,
   * the previous account's timeframe stays *usable* for the whole of the asynchronous
   * preference read. Sign out of an account that chose All time, sign in as somebody with
   * no preference, tap Trophy quickly, and their first board is drawn — and requested —
   * as All time before the miss resolves.
   *
   * Carrying the id fixes it *during the render that switches*, with no effect to fire and
   * nothing to clean up: a preference belongs to whoever it was read for, so one that does
   * not name the current reader is simply not theirs and the default stands.
   */
  const [timeframePref, setTimeframePref] = useState<{
    profileId: string;
    value: LeaderboardTimeframe;
  }>({ profileId: profile.id, value: DEFAULT_TIMEFRAME });
  const timeframe: LeaderboardTimeframe =
    timeframePref.profileId === profile.id ? timeframePref.value : DEFAULT_TIMEFRAME;
  /** Whether the reader has chosen since their preference was read. Same guard Collection uses. */
  const chosenTimeframe = useRef(false);
  const showingBoard = mode === 'leaderboard';
  // Not fetched until the board is actually opened. The Feed is the default and most
  // readers will never toggle, so an eager read would be a request per app open for a
  // surface nobody asked for.
  const leaderboard = useLeaderboard(profile.id, metric, timeframe, showingBoard);
  const standing = useMyStanding(profile.id, metric, timeframe, showingBoard);
  /**
   * Whether the shelf will draw anything, so the header row knows whether to name it.
   *
   * The same query key `TrendingShelf` reads, so React Query answers both from one fetch
   * — this costs no request. Lifting the whole shelf's data into the screen would have
   * been the alternative and is worse: the shelf owns its own scores, its own failure
   * behaviour and its own staleness, and none of that belongs here.
   */
  const trendingHasItems = (useTrending().data?.items ?? []).length > 0;

  /**
   * The remembered timeframe, applied when it arrives.
   *
   * Deliberately the same shape as Collection's two preference reads, down to the
   * `cancelled` flag, the ref reset and the failure fallback — three preferences with one
   * pattern rather than three patterns, so a fix to one is a fix to all.
   *
   * The miss and the failure both resolve to the default rather than leaving whatever was
   * there, which is the cross-account leak `CollectionScreen` records: this state is not
   * tagged with the account it was read for, so the read has to write in both directions.
   */
  useEffect(() => {
    let cancelled = false;
    chosenTimeframe.current = false;
    const settle = (next: LeaderboardTimeframe) => {
      if (cancelled || chosenTimeframe.current) return;
      setTimeframePref({ profileId: profile.id, value: next });
    };
    readPref<unknown>(`${profile.id}.${TIMEFRAME_PREF_KEY}`)
      .then((stored) => settle(isLeaderboardTimeframe(stored) ? stored : DEFAULT_TIMEFRAME))
      .catch(() => settle(DEFAULT_TIMEFRAME));
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  /**
   * Choosing a timeframe, and remembering it.
   *
   * The write is not awaited and its failure is swallowed, exactly as Collection's is: a
   * store that refuses should cost the reader nothing more than opening on This month
   * next time.
   */
  const changeTimeframe = (next: LeaderboardTimeframe) => {
    if (next === timeframe) return;
    chosenTimeframe.current = true;
    setTimeframePref({ profileId: profile.id, value: next });
    void writePref(`${profile.id}.${TIMEFRAME_PREF_KEY}`, next).catch(() => {});
  };

  /**
   * Entering a mode, with the one analytics event this surface needs.
   *
   * Emitted on the *transition into* Leaderboard rather than on render, so leaving and
   * coming back is a second view — which it is, being a second decision to look — while
   * a re-render caused by anything else on this busy screen is not.
   */
  const changeMode = (next: FeedMode) => {
    if (next === mode) return;
    setMode(next);
    if (next === 'leaderboard') track({ name: 'leaderboard_viewed', props: { metric } });
  };

  /** Only a genuine change. Re-tapping the chip you are on would measure fidgeting. */
  const changeMetric = (next: LeaderboardMetric) => {
    if (next === metric) return;
    setMetric(next);
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
   * The event being recommended, if any.
   *
   * The whole event rather than an id, because the sheet needs the title and the kind
   * and both are already on the row that opened it. Held here rather than per row so
   * one sheet exists for the whole list.
   */
  const [recommending, setRecommending] = useState<FeedItem | null>(null);
  /** Whom the last recommendation went to, so the confirmation names a person. */
  const [recommendedTo, setRecommendedTo] = useState<string | null>(null);

  const eventIds = useMemo(() => (feed.data ?? []).map((event) => event.id), [feed.data]);
  const reactions = useReactions(eventIds, profile.id);
  const commentCounts = useCommentCounts(eventIds, profile.id);
  const { setReaction } = useSetReaction(profile.id);

  const choose = async (eventId: string, kind: ReactionKind | null) => {
    setPickerFor(null);
    const result = await setReaction(eventId, kind);
    if (!result.ok && result.message) {
      Alert.alert('Could not save your reaction', result.message);
    }
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

  const saved = useMemo(
    () => new Set((watchlist.data ?? []).map((entry) => entry.mediaItemId)),
    [watchlist.data],
  );

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
   * A series is not offered, for the same reason it cannot be ranked (PRD §10). That
   * guard used to be theoretical — every feed event was a ranking or a log, and neither
   * can name a series. `watchlist_added` can: `set_watchlist` is the one collection
   * write that accepts a whole show, so "Suraj added Severance to their watchlist" is a
   * real row and the guard is now load-bearing rather than defensive.
   */
  const openRecommend = (event: FeedItem) => {
    if (!event.mediaItemId || event.kind === 'series') return;
    setRecommendedTo(null);
    setRecommending(event);
  };

  const events = feed.data ?? [];
  const openComments = commentsFor ? (events.find((e) => e.id === commentsFor) ?? null) : null;

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
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={showingBoard ? leaderboard.isRefetching : feed.isRefetching}
            onRefresh={() => {
              // The board is the whole screen when it is showing, so the gesture means
              // "re-read this" and nothing else. Refetching the feed underneath it would
              // spend two requests to update something nobody is looking at.
              if (showingBoard) {
                void leaderboard.refetch();
                void standing.refetch();
                return;
              }
              void feed.refetch();
              void reactions.refetch();
              void commentCounts.refetch();
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
          *     TRENDING NOW                    [Feed] [Trophy]
          *     THIS MONTH ▼                    [Feed] [Trophy]
          *
          * One row, drawn in both modes, so the toggle keeps its position while the thing
          * across from it changes. That is what makes it read as a control over *this
          * content* rather than as chrome: it sits at the head of the list it switches.
          *
          * The left side is the heading of whatever is immediately below — the shelf's
          * name in Feed mode, the timeframe selector in Leaderboard mode. In Feed mode it
          * is drawn only when the shelf will actually render: `TrendingShelf` returns null
          * when it has nothing, and a heading over an absent shelf would be a label for
          * nothing. `useTrending` is called here purely to know that, and costs no
          * request — it is the same query key the shelf itself uses, so React Query
          * answers both from one fetch.
          */}
        <View style={styles.contentHeader}>
          <View style={styles.contentHeaderLeft}>
            {showingBoard ? (
              <MediumSelector
                size="section"
                value={timeframe}
                onChange={changeTimeframe}
                options={LEADERBOARD_TIMEFRAMES}
              />
            ) : trendingHasItems ? (
              <SectionHeader title="Trending now" />
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
            entries={leaderboard.data}
            standing={standing.data}
            loading={leaderboard.isPending}
            onPressPerson={(username) => router.push(`/u/${username}`)}
          />
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
          * Where discovery ends and the social feed begins.
          *
          * The founder's note: Trending stays at the top, must **not** be sticky, and a
          * reader should scroll naturally past it into activity — but there was nothing
          * marking the boundary, so the first activity row read as one more thing in
          * the shelf's section.
          *
          * A hairline and a heading, which is the app's existing vocabulary for exactly
          * this. **ACTIVITY** rather than "From your network": the feed also carries the
          * reader's own rankings, so "your network" would be false on the row somebody
          * is most likely to recognise.
          *
          * Drawn even while the feed is loading or empty, because its job is to say
          * what the rest of the screen is — and an empty state under a heading is
          * legible where the same empty state floating below a shelf is not.
          */}
        <View style={styles.boundary}>
          <SectionHeader title="Activity" />
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

        {feed.isError ? (
          <View style={styles.pad}>
            <EmptyState
              kind="couldNotLoad"
              title="Could not load activity"
              body="Check your connection and try again."
            />
          </View>
        ) : feed.isPending ? (
          <SkeletonRow count={5} />
        ) : events.length === 0 ? (
          <View style={styles.pad}>
            <EmptyState
              kind="nothingYet"
              compact
              title="Your feed is quiet right now."
              body="Rank a title, or follow someone, and activity will appear here."
            />
          </View>
        ) : (
          events.map((event) => (
            <ActivityRow
              key={event.id}
              actorName={event.actorName}
              actorAvatarUri={event.actorAvatarUri}
              // Own activity has no profile to visit that is not the tab the user
              // is already one tap from, so the name is not a link on those rows.
              onPressActor={
                event.actorId === profile.id || !event.actorUsername
                  ? undefined
                  : () => router.push(`/u/${event.actorUsername}`)
              }
              verb={verbFor(event.type)}
              tail={tailFor(event.type)}
              companions={event.companions}
              title={event.title}
              year={event.year}
              posterUri={posterUri(event.posterPath)}
              // The badge leads an award row — the real artwork, in the poster's
              // box (20260828000100). Everything else about the row is ordinary.
              lead={
                event.award ? (
                  <AwardActivityLead awardKey={event.award.key} tierKey={event.award.tierKey} />
                ) : event.goal ? (
                  <GoalActivityLead />
                ) : undefined
              }
              /**
               * The optional secondary line the founder allowed — "25 movies" — and only
               * where it is genuinely secondary. `metadataFor` would otherwise reach for
               * a runtime and a certification that no goal row has.
               */
              metadata={
                event.award
                  ? event.award.tierLabel
                  : event.goal
                    ? `${event.goal.target} ${
                        event.goal.category === 'movies'
                          ? event.goal.target === 1
                            ? 'movie'
                            : 'movies'
                          : event.goal.target === 1
                            ? 'season'
                            : 'seasons'
                      }`
                    : metadataFor(event)
              }
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
              timeLabel={relativeTime(event.createdAt)}
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
              // means to do, so the control is not offered on your own activity.
              onPressWatchlist={
                event.mediaItemId && event.actorId !== profile.id
                  ? () => toggleWatchlist(event.mediaItemId!)
                  : undefined
              }
              inWatchlist={event.mediaItemId ? saved.has(event.mediaItemId) : false}
              onPressRecommend={
                event.mediaItemId && event.kind !== 'series'
                  ? () => openRecommend(event)
                  : undefined
              }
              reaction={reactionFor(event.id)}
              onPressComments={() => setCommentsFor(event.id)}
              commentCount={commentCounts.data?.get(event.id) ?? 0}
            />
          ))
        )}
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
    return {
      count: summary?.total ?? 0,
      mineGlyph: summary?.mine ? REACTION_GLYPH[summary.mine] : null,
      glyphs: (summary?.kinds ?? []).map((kind) => REACTION_GLYPH[kind]),
      onPress: () => void toggleDefault(eventId),
      onLongPress: () => setPickerFor(eventId),
      onPressSummary: () => setDetailFor(eventId),
      picker:
        pickerFor === eventId ? (
          <ReactionPill
            current={summary?.mine ?? null}
            onChoose={(kind) => void choose(eventId, kind)}
            onDismiss={() => setPickerFor(null)}
          />
        ) : null,
    };
  }
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  pad: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
  // Collapses to nothing when the shelf renders null, so an absent shelf costs no
  // space rather than an empty band above the first activity row.
  trending: { gap: theme.space[2] },
  /**
   * The content header row: a heading on the left, the mode toggle on the right.
   *
   * The gutter lives here rather than on the children, because the two left-hand
   * occupants are different components — a `SectionHeader`, which pads itself, and a
   * section-sized `MediumSelector`, which deliberately does not. Padding the row is what
   * makes them line up with each other and with the list below.
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
   * The rule between discovery and activity.
   *
   * Full-bleed rather than inset to the text column, unlike a row divider: this
   * separates two *sections*, and a rule that stops short would read as belonging to
   * whichever one it touched.
   */
  boundary: {
    marginTop: theme.space[4],
    paddingTop: theme.space[2],
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
  },
});

// `metadataFor` and `relativeTime` used to be defined here. Both now live in
// `features/feed/activity.ts`, beside the rules they apply — which is where the first
// one's own comment always said they belonged, and which stopped being optional when the
// activity page became the third surface drawing one of these rows.
