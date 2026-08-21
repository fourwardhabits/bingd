import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { AwardsSheet } from '@/features/awards/AwardsSheet';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { activityMetadata, tailFor, verbFor } from '@/features/feed/activity';
import { CommentSheet } from '@/features/feed/CommentSheet';
import { useCommentCounts } from '@/features/feed/use-comments';
import { useActorActivity } from '@/features/feed/use-feed';
import { FollowControl } from '@/features/profile/FollowControl';
import { ProfileIdentity } from '@/features/profile/ProfileIdentity';
import { ProfileWatchlist } from '@/features/profile/ProfileWatchlist';
import { TopRanked } from '@/features/profile/TopRanked';
import {
  useProfileIdentity,
  useProfileNotes,
  usePublicProfile,
} from '@/features/profile/use-public-profile';
import { useMyBlocks, useRelationships, useSocialWrites } from '@/features/profile/use-social';
import { tasteMatchBadge, useTasteMatch } from '@/features/profile/use-taste-match';
import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  ActivityRow,
  Button,
  EmptyState,
  LoadingScreen,
  Screen,
  SectionHeader,
  SpoilerNote,
  Text,
  TitleRow,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Somebody else's profile — `https://bingd.app/u/<username>`.
 *
 * The founder's device test found the profile was not yet a social one, and set the
 * question it has to answer: *what does this person like, and what have they thought
 * about films and TV.* So the page leads with the artwork of their best titles, then
 * their ranked lists, their notes, and what they have been doing — in that order,
 * because the first is the only one that reads at a glance.
 *
 * Nothing here decides who may see what. Every read is one the schema already
 * authorises: `public_profiles` is a `security_invoker` view, `rankings_read` is
 * `can_i_view`, and notes come through `public_notes`, which returns a row only if
 * its author made it public and the viewer may see them. A private account the viewer
 * does not follow resolves to nothing, and that is deliberately indistinguishable
 * from a username that was never taken (PRD §16).
 *
 * Notes carry the spoiler rules with them, resolved against *this* viewer's watched
 * set — so somebody who has seen Season 1 still gets Season 2 masked.
 */
export default function PublicProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const viewer = useCurrentProfile();
  const router = useRouter();
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  // Mounted only while open, as on the own profile: it reads nine things when it
  // mounts, and one that stayed mounted would read them on every visit to anybody.
  const [awardsOpen, setAwardsOpen] = useState(false);

  const profile = usePublicProfile(username ?? null);
  /**
   * Identity, asked for **every** profile rather than only the ones that come back
   * empty.
   *
   * Two reasons, and the second is the load-bearing one. It removes a wait: the
   * fallback surface is ready the moment the readable one is known to be absent,
   * instead of starting a second round trip at that point. And it removes a
   * disclosure: a request issued only for private accounts would report somebody's
   * visibility setting to anybody watching the network, which is precisely what the
   * server-side design of `profile_identity` avoids by answering for public accounts
   * too. Cheap — one indexed row on a handle.
   */
  const identity = useProfileIdentity(username ?? null);
  // The readable profile when there is one, the identity when there is not. Both name
  // the same account; only one of them can be read.
  const subjectId = profile.data?.id ?? identity.data?.id ?? '';
  const notes = useProfileNotes(profile.data?.id ?? null);
  const watched = useWatched(viewer.id);
  const activity = useActorActivity(profile.data?.id ?? null);
  const relationships = useRelationships(subjectId ? [subjectId] : [], viewer.id);

  /**
   * The one case where an unavailable profile is not the end of the page.
   *
   * Blocking closes the door behind itself: `can_view_profile` goes false in both
   * directions, so the account leaves `public_profiles` and search *for the person who
   * blocked them too* — and the Unblock control lived on the profile that just
   * vanished. Independent review 12 found it; blocking was a one-way trip.
   *
   * `my_blocks` is the caller's own list and is the only read here that can name an
   * account the caller has deliberately made invisible. Matched on the handle, because
   * the handle is all this route has.
   */
  // Not on your own profile. The hook refuses it and so does the function, because a
  // 100% match with your own catalogue is a tautology the founder asked to be absent.
  const taste = useTasteMatch(subjectId || null, viewer.id);
  const blocks = useMyBlocks(viewer.id);
  const blockedMatch = (blocks.data ?? []).find((account) => account.username === username);
  const { unblock, busy: unblocking } = useSocialWrites(viewer.id, 'profile');

  const isSelf = profile.data?.id === viewer.id;
  // Asked about this actor directly. Filtering the viewer's own feed would have
  // shown nothing for any public account they had not followed, because that query
  // spans the follow set — the authorisation comes from feed_events_read either way.
  const recent = activity.data ?? [];
  // Comments reach this page as well as the Feed, because this is where somebody
  // arrives after finding a person in Search — the Feed only carries activity by
  // accounts they already follow. Reactions deliberately stay Feed-only for now:
  // they were built there and moving them is a product decision, not a wiring one.
  const commentCounts = useCommentCounts(
    recent.map((event) => event.id),
    viewer.id,
  );
  const openComments = commentsFor ? (recent.find((e) => e.id === commentsFor) ?? null) : null;
  const tasteBadge = tasteMatchBadge(taste.data);

  /**
   * This profile as a link, and **this** profile means the one being looked at.
   *
   * The handle comes from `profile.data.username` — the row this screen resolved —
   * rather than from `viewer`, which is the signed-in reader and is the wrong person
   * in every case this screen exists for. It falls back to the route parameter, which
   * is the same handle by a less certain route: the control is only rendered once the
   * row is in hand, so the fallback exists to satisfy the type rather than to run.
   */
  const viewedHandle = profile.data?.username ?? username;

  const shareProfile = async () => {
    const url = `https://bingd.app/u/${viewedHandle}`;
    try {
      await Share.share({ message: url, url });
    } catch (error) {
      Alert.alert('Could not share', error instanceof Error ? error.message : 'Sharing failed.');
    }
  };

  return (
    <Screen includeBottomInset edges={[]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: profile.data?.name ?? '',
          headerBackTitle: 'Back',
        }}
      />

      {profile.isPending || (!profile.data && identity.isPending) ? (
        <LoadingScreen />
      ) : profile.isError ? (
        <EmptyState
          kind="couldNotLoad"
          title="Could not load this profile"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void profile.refetch() }}
        />
      ) : !profile.data && blockedMatch ? (
        // Named, deliberately. This is not a disclosure — the viewer is the one who
        // blocked them, so they already know the account exists.
        <EmptyState
          kind="nothingYet"
          title={`You blocked @${blockedMatch.username}`}
          body="You will not see each other on Bingd. Any follow between you is removed, and unblocking does not bring it back."
          action={{
            label: unblocking ? 'Unblocking…' : 'Unblock',
            onPress: () =>
              void (async () => {
                const result = await unblock({ userId: blockedMatch.id });
                if (!result.ok) Alert.alert('Could not unblock', result.message);
              })(),
          }}
        />
      ) : !profile.data && identity.data ? (
        /**
         * **Found, and not readable.** `20260819000100` separated the two: a private
         * account is discoverable by name so somebody who knows them can ask, while
         * everything they wrote stays behind `can_view_profile`.
         *
         * So this is the whole surface — the avatar, the name, the handle, the fact
         * that it is private, and the one control that changes anything. Not a grey
         * circle: replacing a real face with a placeholder would make the person
         * unrecognisable to exactly the friend the discovery exists for, and the avatar
         * is identity rather than activity.
         *
         * No stats, no Top Ranked, no activity, no Awards, no goals, no taste match.
         * Not hidden by this screen — the reads that would fill them return nothing,
         * which is where the rule belongs.
         */
        <ScrollView contentContainerStyle={styles.content}>
          <ProfileIdentity
            name={identity.data.name}
            username={identity.data.username}
            bio={null}
            avatarUri={identity.data.avatarUri}
            controls={
              <FollowControl
                userId={identity.data.id}
                name={identity.data.name}
                viewerId={viewer.id}
                relationship={relationships.data?.get(identity.data.id)}
                isSelf={false}
                surface="profile"
              />
            }
          />
          <EmptyState
            kind="nothingYet"
            compact
            title="This account is private"
            body="Follow them to see what they have watched, ranked and written."
          />
        </ScrollView>
      ) : !profile.data ? (
        // Nobody by that handle, an account that blocked the viewer, or a suspended
        // one. Deliberately one answer for all three: telling them apart would report
        // a block to the person it was applied to and a suspension to anybody who asks.
        <EmptyState
          kind="nothingYet"
          title={`@${username}`}
          body="This profile is not available."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {/* The same component the viewer's own profile draws. The founder's
              correction: the two had become two designs, and a reader could not tell
              that what they see here is what other people see on them. What differs is
              `controls` and `badge`, which is exactly the set of things that depend on
              who is looking. */}
          <ProfileIdentity
            name={profile.data.name}
            username={profile.data.username}
            bio={profile.data.bio}
            avatarUri={profile.data.avatarUri}
            stats={{
              followers: profile.data.followers,
              following: profile.data.following,
              movies: profile.data.rankedMovies,
              seasons: profile.data.rankedSeasons,
            }}
            badge={
              /* Under the avatar, in the avatar's own column — the founder's final
                 layout. It was in the name column, where it was a third thing stacked
                 against the identity and pushed the bio down the page.

                 Absent on the viewer's own profile, absent while the answer is still
                 loading rather than showing a placeholder number that then changes,
                 and absent when there is not enough overlap to have a number at all. */
              !isSelf && tasteBadge ? (
                <View style={styles.taste}>
                  <Text variant="callout" tone="action">
                    {tasteBadge.value}
                  </Text>
                  <Text variant="caption" tone="tertiary">
                    {tasteBadge.label}
                  </Text>
                </View>
              ) : null
            }
            controls={
              /**
               * Follow, then Share Profile and Bingd Awards — the same pair, in the
               * same order and the same row shape as the own profile.
               *
               * The founder found them missing here. They are not own-profile controls:
               * a profile is a thing you hand to somebody, and the person most likely to
               * hand somebody else’s profile on is the one reading it. Awards is the
               * same reading of the same public collection, taken about whoever is being
               * looked at.
               *
               * **Both outlined here, where the own profile fills Awards.** The fill is
               * spent on the one control that depends on who is looking, and on this
               * screen that is Follow. Three filled buttons in a stack is three primary
               * actions, which is none.
               */
              <View style={styles.controls}>
                <FollowControl
                  userId={subjectId}
                  name={profile.data.name}
                  viewerId={viewer.id}
                  relationship={relationships.data?.get(subjectId)}
                  isSelf={isSelf}
                  surface="profile"
                />
                <View style={styles.actions}>
                  <View style={styles.action}>
                    <Button
                      label="Share Profile"
                      kind="secondary"
                      onPress={() => void shareProfile()}
                    />
                  </View>
                  <View style={styles.action}>
                    <Button
                      label="Bingd Awards"
                      kind="secondary"
                      onPress={() => setAwardsOpen(true)}
                    />
                  </View>
                </View>
              </View>
            }
          />

          <TopRanked
            userId={subjectId}
            otherName={isSelf ? null : profile.data.name}
            onPressTitle={(id: string) => router.push(`/title/${id}`)}
          />

          {/* Same position as the own profile, deliberately: the founder pass that made
              these two screens share ProfileIdentity and TopRanked exists so a reader can
              tell that what they see on somebody else is what others see on them. */}
          <ProfileWatchlist
            userId={subjectId}
            onPressTitle={(id: string) => router.push(`/title/${id}`)}
          />

          {notes.data?.length ? (
            <View style={styles.section}>
              <SectionHeader title="Notes" />
              {notes.data.map((entry) => (
                <View key={`${entry.mediaItemId}-${entry.updatedAt}`} style={styles.note}>
                  <TitleRow
                    title={
                      compactName({
                        kind: entry.kind,
                        title: entry.title,
                        seriesTitle: entry.seriesTitle,
                      }) ?? entry.title
                    }
                    posterUri={posterUri(entry.posterPath)}
                    onPress={() => router.push(`/title/${entry.mediaItemId}`)}
                  />
                  <View style={styles.noteBody}>
                    <SpoilerNote
                      text={entry.note}
                      hasSpoilers={entry.hasSpoilers}
                      // Against this viewer's watched set and this exact media
                      // item: having seen Season 1 does not unmask Season 2.
                      masked={shouldMask({
                        hasSpoilers: entry.hasSpoilers,
                        mediaItemId: entry.mediaItemId,
                        viewerId: viewer.id,
                        authorId: subjectId,
                        watched: watched.data,
                      })}
                      numberOfLines={4}
                      titleForLabel={entry.title}
                    />
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {recent.length ? (
            <View style={styles.section}>
              <SectionHeader title="Recent activity" />
              {recent.map((event) => (
                <ActivityRow
                  key={event.id}
                  actorName={event.actorName}
                  actorAvatarUri={event.actorAvatarUri}
                  verb={verbFor(event.type)}
                  tail={tailFor(event.type)}
                  companions={event.companions}
                  title={event.title}
                  year={event.year}
                  posterUri={posterUri(event.posterPath)}
                  metadata={activityMetadata({
                    kind: event.kind,
                    genres: event.genres,
                    certification: event.certification,
                    runtimeMinutes: event.runtimeMinutes,
                    episodeCount: event.episodeCount,
                  })}
                  score={event.score}
                  bucket={event.bucket}
                  note={event.note?.text ?? null}
                  noteHasSpoilers={event.note?.hasSpoilers ?? false}
                  noteMasked={shouldMask({
                    hasSpoilers: event.note?.hasSpoilers ?? false,
                    mediaItemId: event.mediaItemId,
                    viewerId: viewer.id,
                    authorId: event.actorId,
                    watched: watched.data,
                  })}
                  timeLabel={new Date(event.createdAt).toLocaleDateString()}
                  onPressTitle={() => event.mediaItemId && router.push(`/title/${event.mediaItemId}`)}
                  onPressComments={() => setCommentsFor(event.id)}
                  commentCount={commentCounts.data?.get(event.id) ?? 0}
                />
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}

      {/* The viewed user’s awards, not the reader’s. `subjectId` is the row this
          screen resolved; `viewer.id` is the person holding the phone, and using it
          here would open the reader’s own awards under somebody else’s name.

          Only reachable from this branch, which renders only once `profile.data` came
          back — so an account the viewer may not read never offers the control. The
          sheet’s own reads are RLS-governed on top of that. */}
      {awardsOpen ? (
        <AwardsSheet
          userId={subjectId}
          onPressTitle={(id) => {
            setAwardsOpen(false);
            router.push(`/title/${id}`);
          }}
          onPressProfile={(handle) => {
            setAwardsOpen(false);
            router.push(`/u/${handle}`);
          }}
          onClose={() => setAwardsOpen(false)}
        />
      ) : null}

      <CommentSheet
        eventId={commentsFor}
        mediaItemId={openComments?.mediaItemId ?? null}
        title={openComments?.title ?? null}
        viewerId={viewer.id}
        watched={watched.data}
        onClose={() => setCommentsFor(null)}
        onPressPerson={(handle) => {
          setCommentsFor(null);
          router.push(`/u/${handle}`);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  // Centred under the photo, tight: two short lines about the person in it.
  taste: { alignItems: 'center', gap: 0 },
  // Follow on its own line, the two actions under it. The gap is the one between two
  // rows of controls; `ProfileIdentity` owns the space above and the gutter beside.
  controls: { gap: theme.space[3] },
  // Two equal halves, as on the own profile — equal weight is what stops either
  // reading as the only real control.
  actions: { flexDirection: 'row', gap: theme.space[2] },
  action: { flex: 1 },
  section: { paddingTop: theme.space[5], gap: theme.space[2] },
  note: { paddingBottom: theme.space[2] },
  noteBody: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[1] },
});
