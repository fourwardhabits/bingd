import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { CommentThread } from '@/features/feed/CommentThread';
import { metadataFor, tailFor, verbFor } from '@/features/feed/activity';
import { useActivityEvent } from '@/features/feed/use-feed';
import { posterUri } from '@/lib/images';
import { TAB_ROUTES } from '@/lib/routes';
import { ActivityRow, EmptyState, Screen, SkeletonRow } from '@/ui/components';
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
  const profile = useCurrentProfile();
  const router = useRouter();

  const eventId = typeof id === 'string' && id.length > 0 ? id : null;
  const activity = useActivityEvent(eventId, profile.id);
  const watched = useWatched(profile.id);

  const event = activity.data ?? null;

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
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          {/* The canonical feed card, and the same component the Feed draws. Not a
              reduced copy: a reader arriving here from a notification should recognise
              the post as the one they would have scrolled past. */}
          <ActivityRow
            actorName={event.actorName}
            actorAvatarUri={event.actorAvatarUri}
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
            metadata={metadataFor(event)}
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
            onPressTitle={() => event.mediaItemId && router.push(`/title/${event.mediaItemId}`)}
            /**
             * No comments control, and no reaction, watchlist or recommend control.
             *
             * The conversation is directly below — a button that scrolls you six points
             * down the screen you are already on is noise. The other three are omitted
             * for a different reason: this screen exists because somebody was told
             * something and came to read it, and a row of actions at the top of it turns
             * a message into a post to be worked on. They are all on the Feed, on the
             * same card, one tap away.
             */
          />

          <View style={styles.divider} />

          <CommentThread
            eventId={event.id}
            // The exact media item the activity is about — a season, never its parent
            // series. Masking is decided against this and nothing else.
            mediaItemId={event.mediaItemId}
            title={event.title}
            viewerId={profile.id}
            watched={watched.data}
            onPressPerson={(username) => router.push(`/u/${username}`)}
            // Already inside a ScrollView. See `CommentThread`.
            scroll="inherited"
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
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
    marginTop: theme.space[2],
  },
});
