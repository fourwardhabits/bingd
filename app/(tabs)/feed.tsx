import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { AwardActivityLead } from '@/features/awards/AwardActivityLead';
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
import { RecommendSheet } from '@/features/recommendations/RecommendSheet';
import { TrendingShelf } from '@/features/trending/TrendingShelf';
import { track } from '@/lib/analytics';
import { posterUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { invalidateAfterWatchlistChange } from '@/features/collection/invalidate';
import {
  ActivityRow,
  AppHeader,
  EmptyState,
  HeaderBoundary,
  Screen,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

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
            refreshing={feed.isRefetching}
            onRefresh={() => {
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
        {/* One shelf, above the activity. It renders nothing at all when there is
            nothing to show, so the social feed keeps the top of the screen whenever
            discovery has nothing to add — which is the ordering PRD §14 wants. */}
        <View style={styles.trending}>
          <TrendingShelf
            userId={profile.id}
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
                ) : undefined
              }
              metadata={event.award ? event.award.tierLabel : metadataFor(event)}
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
