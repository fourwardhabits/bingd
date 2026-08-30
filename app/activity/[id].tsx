import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { useAuth } from '@/features/auth';
import { AwardActivityLead } from '@/features/awards/AwardActivityLead';
import { GoalActivityLead } from '@/features/goals/GoalActivityLead';
import { goalAchievement } from '@/features/goals/goals';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { CommentThread } from '@/features/feed/CommentThread';
import { ReactionDetail } from '@/features/feed/ReactionDetail';
import { ReactionPill } from '@/features/feed/ReactionPill';
import { metadataFor, tailFor, verbFor } from '@/features/feed/activity';
import { useActivityEvent } from '@/features/feed/use-feed';
import {
  DEFAULT_REACTION,
  REACTION_GLYPH,
  useReactions,
  useSetReaction,
  type ReactionKind,
} from '@/features/feed/use-reactions';
import { posterUri } from '@/lib/images';
import { TAB_ROUTES } from '@/lib/routes';
import {
  ActivityRow,
  EmptyState,
  LoadingScreen,
  Screen,
  SkeletonRow,
  useKeyboardHeight,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * One activity, and the conversation on it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS
 *
 * A friend reported the app freezing: *"I tried clicking on the comment you left on a
 * rating and it kinda froze."* A comment notification routed to `/title/{id}` — the
 * title page — which is a real, working screen that **does not render comments at all**.
 * So somebody told "Ada commented on your activity" arrived somewhere the remark is
 * invisible, scrolled looking for it, and concluded the app had stopped.
 *
 * `features/notifications/routing.ts` argued for that destination on the grounds that
 * "there is no per-event route, and the feed is a paginated list of the people this
 * reader follows — a notification is about the reader's own activity, which does not
 * appear there at all". Both facts were true. The first was a gap and this is it filled;
 * the second is why filtering the feed would never have worked and a route by id does.
 *
 * ---------------------------------------------------------------------------
 * THE ID IS THE NOTIFICATION'S OWN
 *
 * `subject_id`, written by `add_comment` when the row was created and returned unchanged
 * by `my_notifications`. Nothing here is reconstructed from what a screen happened to be
 * displaying, which was the founder's explicit instruction: *"Do not invent an ID from
 * client display state."*
 *
 * ---------------------------------------------------------------------------
 * PRIVACY IS THE ROW POLICY AND NOTHING ELSE
 *
 * `useActivityEvent` selects one `feed_events` row, so `feed_events_read` —
 * `can_i_view(actor_id)` — decides. An account that has gone private, blocked this
 * reader, or deleted the ranking since the notification was written all produce the same
 * thing: no row, and the unavailable state below. A deep link therefore cannot outrun
 * the visibility rules, and the three cases are indistinguishable from each other, which
 * is what stops the link confirming that a particular activity exists.
 *
 * The comments are gated a second time by `activity_comments`, which asks
 * `can_view_profile` about the event before returning a single comment. Neither gate
 * relies on the other.
 */
export default function ActivityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  /**
   * `useAuth`, not `useCurrentProfile`, and this is the one screen in `app/` where that
   * distinction earns its keep.
   *
   * Every other protected screen is reached from inside the app, with a session long
   * since resolved, so the throwing accessor is exactly right for them. **This one is
   * reached from outside** — a notification tap that starts the process — which means it
   * can be asked to render while `getSession` is still in flight. The throwing accessor
   * there is a caught error and a boundary reset for something that is not an error at
   * all: the session is simply not known yet.
   *
   * So it waits, and the screen it waits with is the same `LoadingScreen`
   * `AuthStatusOverlay` is drawing over it anyway. Independent review 43's cold-start
   * finding is what this closes on the route it was actually about.
   */
  const auth = useAuth();
  const router = useRouter();
  /**
   * **The keyboard, measured** (founder physical bug: the reply composer is covered).
   *
   * The Feed's comment sheet is lifted by `Sheet`, which owns that for every sheet in
   * the app. This screen is not a sheet: the composer is simply the last thing in a page
   * `ScrollView`, so on Android — where edge-to-edge means the window never resizes and
   * `adjustResize` has nothing to adjust — the keyboard is drawn straight over it.
   *
   * The same hook the sheet uses rather than a `KeyboardAvoidingView`, for exactly that
   * reason: `behavior="padding"` is measuring a window that does not move. Two values
   * come out of the one measurement — room at the foot of the content, and the scroll
   * that brings the composer into what is left of the screen.
   */
  const keyboard = useKeyboardHeight();
  const scroller = useRef<ScrollView>(null);

  const viewerId = auth.status === 'ready' ? auth.profile.id : null;
  const eventId = typeof id === 'string' && id.length > 0 ? id : null;
  const activity = useActivityEvent(viewerId ? eventId : null, viewerId ?? '');
  const watched = useWatched(viewerId ?? '');

  const event = activity.data ?? null;

  /**
   * **The post's reactions, read exactly as the Feed reads them** (founder, 2026-08-29).
   *
   * The founder opened a comment notification, looked at the post above the thread, and
   * could not find the reactions they knew were on it. They were right that something
   * was wrong and wrong about what: this was never a caching or a false-zero problem —
   * the screen fetched no reaction data at all and drew no control, deliberately, on the
   * reasoning that "a row of actions at the top turns a message into a post to be worked
   * on".
   *
   * That reasoning still holds for the other three controls and they are still absent.
   * It does not hold for reactions, because a reaction count is not an action offered —
   * it is part of what the post *is*, the way the score and the note are, and the same
   * post reading "6" in the Feed and blank here is the app disagreeing with itself.
   *
   * **The same hook, the same components, the same grammar.** `useReactions` against one
   * id rather than a page of them; `ReactionPill` for the picker and `ReactionDetail`
   * for the reactor list, both shared with the Feed. Nothing about reactions is
   * implemented twice here, and no count is ever computed on this screen.
   *
   * Privacy needs no argument of its own: `reactions_read` (20260813001900) gates every
   * row on `can_i_view(e.actor_id)` for the event *and* `can_i_view(user_id)` for the
   * reactor, which is the same policy the Feed's identical query meets. The id list is
   * empty until the event itself resolves, so a hidden activity is never probed for
   * reactions the policy would refuse anyway.
   */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const reactions = useReactions(event && viewerId ? [event.id] : [], viewerId ?? '');
  const { setReaction } = useSetReaction(viewerId ?? '');
  const summary = event ? (reactions.data?.get(event.id) ?? null) : null;
  /**
   * **A read that has not landed is not a zero**, which is the whole hazard of putting a
   * count on this screen at all.
   *
   * `useReactions` resolves to a `Map`, and an event with no reactions is simply absent
   * from it — so "no entry" means *either* nobody has reacted *or* nobody has looked, and
   * collapsing the two would draw a confident `0` on a post the Feed shows with six. A
   * timed-out request would keep drawing it, and the detail sheet would open empty
   * against it.
   *
   * So the control is drawn only once the query has actually settled. While it is
   * pending, and after an error, the row is the sentence and the face it always was —
   * absent rather than wrong. The next refetch fills it in; nothing here has to be
   * invalidated by hand.
   */
  const reactionsResolved = reactions.isSuccess && !reactions.isError;

  const choose = async (kind: ReactionKind | null) => {
    if (!event) return;
    setPickerOpen(false);
    const result = await setReaction(event.id, kind);
    if (!result.ok && result.message) {
      Alert.alert('Could not save your reaction', result.message);
    }
  };

  /**
   * A plain tap, with the Feed's rule rather than a second one: nothing becomes a heart,
   * a heart becomes nothing, and any other reaction is replaced by the heart — the
   * gesture means "react", and the way to remove one you can see is to tap the one you
   * chose.
   */
  const toggleDefault = () => choose(summary?.mine === DEFAULT_REACTION ? null : DEFAULT_REACTION);

  /**
   * Back, from a screen that may have nothing behind it.
   *
   * A cold start from a notification tap pushes this onto a stack whose only other entry
   * is `/`, which renders nothing — so `router.back()` alone lands on a blank screen and
   * waits for `useAuthRouting` to notice. Going to the Feed explicitly when there is no
   * history is the founder's "Back should still produce a valid Feed state rather than
   * blank navigation".
   *
   * `TAB_ROUTES.feed` rather than a literal, for the reason that module states: the tab
   * order is a layout decision and this is a navigation one.
   */
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(TAB_ROUTES.feed);
  };

  /**
   * The composer is the last thing on the page, so `scrollToEnd` *is* "show me what I am
   * typing" — for a new comment and for a reply alike, since both use the one composer
   * at the foot. Runs after the padding above has been committed, so there is somewhere
   * to scroll to; on the way back down it does nothing, and the padding simply goes.
   *
   * Before the early return, because hooks cannot be conditional.
   */
  useEffect(() => {
    if (keyboard > 0) scroller.current?.scrollToEnd({ animated: true });
  }, [keyboard]);

  // Nothing to draw and nothing to ask for until it is known who is asking.
  if (!viewerId) return <LoadingScreen />;

  return (
    <Screen includeBottomInset>
      {/* "Comments" and not "(tabs)". The founder photographed an Expo route-group label
          in a back button once already; `ui/navigation.ts` carries the fix for the root
          stack, and a screen declaring its own title has to say it here too. */}
      <Stack.Screen options={{ headerShown: true, title: 'Comments' }} />

      {activity.isPending ? (
        <SkeletonRow count={4} />
      ) : activity.isError ? (
        <View style={styles.pad}>
          <EmptyState
            kind="couldNotLoad"
            title="Could not load this"
            body="Check your connection and try again."
            action={{ label: 'Try again', onPress: () => void activity.refetch() }}
          />
        </View>
      ) : !event ? (
        /**
         * Gone, hidden, or never visible — deliberately one state and one sentence.
         *
         * Telling them apart would be the disclosure: "you may not see this" confirms
         * the activity exists, on an account that has since decided this reader should
         * not know that. It is the same reasoning `20260817000100` uses for every P0002
         * a comment writer raises, applied to a screen.
         */
        <View style={styles.pad}>
          <EmptyState
            kind="nothingYet"
            title="This conversation is no longer available."
            body="It may have been deleted, or the account may no longer be visible to you."
            action={{ label: 'Back to Feed', onPress: goBack }}
          />
        </View>
      ) : (
        <ScrollView
          ref={scroller}
          contentContainerStyle={[styles.page, keyboard > 0 && { paddingBottom: keyboard }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* The canonical feed card, and the same component the Feed draws. Not a
              reduced copy: a reader arriving here from a notification should recognise
              the post as the one they would have scrolled past. */}
          <ActivityRow
            actorName={event.actorName}
            actorAvatarUri={event.actorAvatarUri}
            onPressActor={
              event.actorId === viewerId || !event.actorUsername
                ? undefined
                : () => router.push(`/u/${event.actorUsername}`)
            }
            verb={verbFor(event.type)}
            tail={tailFor(event.type, event.title)}
            companions={event.companions}
            title={event.title}
            year={event.year}
            posterUri={posterUri(event.posterPath)}
            // The badge leads an award row, exactly as the feed draws it.
            lead={
              event.award ? (
                <AwardActivityLead awardKey={event.award.key} tierKey={event.award.tierKey} />
              ) : event.goal ? (
                // The feed's own lead for a goal row. This page draws the same activity,
                // and a goal row here with an empty poster box was the one place the two
                // surfaces disagreed about what a goal looks like.
                <GoalActivityLead />
              ) : undefined
            }
            // The same second line the feed draws, from the same two functions — see
            // `app/(tabs)/feed.tsx`. A conversation page reached from a notification
            // shows the activity it is about, so a metal here would be the same
            // non-explanation in a second place.
            metadata={
              event.award
                ? event.award.achievement
                : event.goal
                  ? goalAchievement(event.goal.category, event.goal.target)
                  : metadataFor(event)
            }
            score={event.score}
            bucket={event.bucket}
            note={event.note?.text ?? null}
            noteHasSpoilers={event.note?.hasSpoilers ?? false}
            noteMasked={shouldMask({
              hasSpoilers: event.note?.hasSpoilers ?? false,
              mediaItemId: event.mediaItemId,
              viewerId: viewerId,
              authorId: event.actorId,
              watched: watched.data,
            })}
            timeLabel={relativeTime(event.createdAt)}
            // An award row opens the earner's Awards rather than a title (§5).
            onPressTitle={() => {
              if (event.mediaItemId) {
                router.push(`/title/${event.mediaItemId}`);
              } else if (event.award) {
                if (event.actorId === viewerId) {
                  router.push({ pathname: '/profile', params: { awards: '1' } });
                } else if (event.actorUsername) {
                  router.push({
                    pathname: '/u/[username]',
                    params: { username: event.actorUsername, awards: '1' },
                  });
                }
              }
            }}
            /**
             * **Reactions, and nothing else.**
             *
             * No comments control: the conversation is directly below, and a button that
             * scrolls you six points down the screen you are already on is noise. No
             * watchlist and no recommend: this screen exists because somebody was told
             * something and came to read it, and a row of *actions* at the top of it
             * turns a message into a post to be worked on. Both are on the Feed, on the
             * same card, one tap away.
             *
             * Reactions were omitted alongside them until 2026-08-29 and should not have
             * been — see the hook above for the founder's report and why this one is a
             * different kind of thing. Every value here comes from the shared summary.
             */
            reaction={
              reactionsResolved
                ? {
                    count: summary?.total ?? 0,
                    mineGlyph: summary?.mine ? REACTION_GLYPH[summary.mine] : null,
                    glyphs: (summary?.kinds ?? []).map((kind) => REACTION_GLYPH[kind]),
                    onPress: () => void toggleDefault(),
                    onLongPress: () => setPickerOpen(true),
                    onPressSummary: () => setDetailOpen(true),
                    picker: pickerOpen ? (
                      <ReactionPill
                        current={summary?.mine ?? null}
                        onChoose={(kind) => void choose(kind)}
                        onDismiss={() => setPickerOpen(false)}
                      />
                    ) : null,
                  }
                : undefined
            }
          />

          {/**
            * **No divider here, and that is the fix** (founder physical report,
            * 2026-08-30: "a small bar of empty space between the post and the comments",
            * on the notification route and on the direct Feed tap alike).
            *
            * It was `<View style={styles.divider} />` -- a second hairline rule with
            * `marginTop: theme.space[2]` above it. `ActivityRow` already ends in a
            * `borderBottomWidth` of its own, because that is the separator the Feed
            * draws between cards, so this screen was stacking **two** rules with a band
            * of empty page trapped between them. That band is the bar: not padding, not
            * a reserved container, not a loading state, and not route-specific -- both
            * routes render this same subtree, which is why it reproduced from either.
            *
            * The legitimate divider is kept and is the row's own. The unintended one is
            * simply gone: no negative margin pulling the thread up over it, no collapsed
            * touch target, and `CommentThread` keeps its own vertical rhythm --
            * `styles.flow` has no top padding and each comment carries
            * `paddingVertical: theme.space[3]`, so the first comment sits the same
            * distance below the rule as every later one sits below its neighbour. One
            * post, one rule, one conversation.
            */}
          <CommentThread
            eventId={event.id}
            // The exact media item the activity is about — a season, never its parent
            // series. Masking is decided against this and nothing else.
            mediaItemId={event.mediaItemId}
            title={event.title}
            viewerId={viewerId}
            watched={watched.data}
            onPressPerson={(username) => router.push(`/u/${username}`)}
            // Already inside a ScrollView. See `CommentThread`.
            scroll="inherited"
          />

          {/* The Feed's own sheet, with the Feed's own behaviour: tapping a name leaves
              for that profile and closes this behind it. */}
          <ReactionDetail
            summary={detailOpen ? summary : null}
            onClose={() => setDetailOpen(false)}
            onPressPerson={(username) => {
              setDetailOpen(false);
              router.push(`/u/${username}`);
            }}
          />
        </ScrollView>
      )}
    </Screen>
  );
}

/** The feed's wording, so two surfaces do not describe the same instant differently. */
function relativeTime(value: string) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const styles = StyleSheet.create({
  page: { paddingBottom: theme.space[6] },
  pad: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[5] },
  // `divider` used to live here. See the note above `CommentThread`: it was the
  // second of two rules and the gap it opened between them was the founder's bar.
});
