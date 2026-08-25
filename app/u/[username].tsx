import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { AwardsSheet } from '@/features/awards/AwardsSheet';
import { useLoggedCollection } from '@/features/collection/use-collection';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { activityMetadata, tailFor, verbFor } from '@/features/feed/activity';
import { CommentSheet } from '@/features/feed/CommentSheet';
import { useCommentCounts } from '@/features/feed/use-comments';
import { useActorActivity } from '@/features/feed/use-feed';
import { ReportSheet } from '@/features/moderation/ReportSheet';
import { FollowControl } from '@/features/profile/FollowControl';
import { ProfileIdentity } from '@/features/profile/ProfileIdentity';
import { ProfileActions } from '@/features/profile/ProfileActions';
import { ProfileMenu } from '@/features/profile/ProfileMenu';
import { ProfileWatchlist } from '@/features/profile/ProfileWatchlist';
import { TopRanked } from '@/features/profile/TopRanked';
import {
  useProfileIdentity,
  useProfileNotes,
  usePublicProfile,
} from '@/features/profile/use-public-profile';
import {
  noRelationship,
  useMyBlocks,
  useRelationships,
  useSocialWrites,
} from '@/features/profile/use-social';
import { tasteMatchState, useTasteMatch } from '@/features/profile/use-taste-match';
import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  ActivityRow,
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
  // Which review's reason sheet is open, by `user_media.id`.
  const [reportingReview, setReportingReview] = useState<string | null>(null);

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

  /**
   * Who the header's menu is about, which is **not** always `subjectId`.
   *
   * Blocking closes the door behind itself: `can_view_profile` goes false in both
   * directions, so a blocked account is absent from `public_profiles` *and* from
   * `profile_identity` — and `subjectId` is built from those two, so it is empty on
   * exactly the profile where the moderation menu matters most. The one read that can
   * still name them is the viewer's own block list, which is why the blocked branch
   * below already reaches for `blockedMatch`.
   *
   * Review 41's third Major: without this fallback, Report was unreachable the moment
   * you blocked somebody. That is the inversion the database deliberately refuses to
   * have — `report()` checks that a subject exists and deliberately not that the caller
   * can still see it, so that blocking cannot become a way to suppress the complaint
   * (20260813002000 §4) — reintroduced in the client.
   *
   * Kept out of `subjectId` itself rather than folded into it: that value feeds Top
   * Ranked, the Awards sheet and the taste match, none of which should start a read
   * about an account the viewer has made invisible.
   */
  const menuUserId = subjectId || blockedMatch?.id || '';
  const menuName = profile.data?.name ?? identity.data?.name ?? `@${username}`;
  /**
   * `follow_state_with` answers for a blocked pair too, but only if it was asked — and
   * it is asked about `subjectId`, which is empty here. `blockedMatch` is the viewer's
   * own list, so its presence *is* the block; saying so directly is what makes the menu
   * offer Unblock rather than Block on the one profile where getting that backwards
   * would be worst.
   */
  const menuRelationship =
    relationships.data?.get(menuUserId) ??
    (blockedMatch ? { ...noRelationship(), blocked: true } : undefined);
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

  /**
   * The one line under the handle, and the two counts it needs to be honest.
   *
   * The founder reported Match missing on other people's profiles. It was wired and it
   * was silent: below `taste.min_common` shared rankings `taste_match` has no score, and
   * the badge under the avatar drew nothing rather than saying why. On a friend beta
   * that is nearly every profile.
   *
   * Saying *why* means knowing which side is short, and the intersection count cannot
   * tell — so both catalogue sizes go in. The subject's is on screen already; the
   * viewer's comes from their own logged collection, which Collection has usually
   * warmed and which is a cheap read either way. `tasteMatchState` owns the decision;
   * this line owns the inputs.
   */
  const viewerCollection = useLoggedCollection(viewer.id);
  const matchState = tasteMatchState({
    match: taste.data,
    isSelf: profile.data?.id === viewer.id,
    viewerRanked: viewerCollection.data?.rankedCount,
    subjectRanked: profile.data
      ? profile.data.rankedMovies + profile.data.rankedSeasons
      : undefined,
  });

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
      {/**
        * **The corner the owner's profile uses for its gear and bell.**
        *
        * Report and Block live behind this rather than as permanent buttons in the
        * action area — the founder's note, and the reasoning is in `ProfileMenu`. What
        * matters here is only that it is the *same corner*: a reader who has learned
        * that the controls for a profile are top right is right on both screens.
        *
        * `menuUserId` rather than `profile.data.id`, so it is present on the
        * discoverable-but-unreadable branch and on the *blocked* one — a private account
        * somebody wants to report, and an account they have already blocked, are the two
        * cases where the control matters most and the two where the readable row is
        * absent. Absent on the viewer's own profile, which this screen can be, and
        * absent when the handle resolved to nothing at all: there is nobody to report.
        */}
      <Stack.Screen
        options={{
          headerShown: true,
          title: profile.data?.name ?? '',
          headerBackTitle: 'Back',
          headerRight: () =>
            menuUserId && !isSelf ? (
              <ProfileMenu
                userId={menuUserId}
                name={menuName}
                viewerId={viewer.id}
                relationship={menuRelationship}
                surface="profile"
              />
            ) : null,
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
          body="You will not see each other on bingd. Any follow between you is removed, and unblocking does not bring it back."
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
            match={
              /* Directly under the handle — the founder's final placement.

                 It was under the avatar, in a sixty-point column, which is why it could
                 only ever be a figure and a word and why every state without a figure
                 rendered as nothing at all. That is the "Match is missing" report: not a
                 wiring bug, a layout that had no room to explain itself.

                 Maroon for a number, because that is the fact the row is for. Tertiary
                 grey for the two absences, which are context rather than a result — and
                 which say what is true without inventing a count of titles to go and
                 rank. Never a placeholder percentage. Absent entirely on the reader's own
                 profile and while the answer is still in flight. */
              matchState ? (
                <Text
                  variant="footnote"
                  tone={matchState.kind === 'match' ? 'action' : 'tertiary'}
                  numberOfLines={1}
                >
                  {matchState.label}
                </Text>
              ) : null
            }
            controls={
              /**
               * **The same stack as the owner's profile, position for position.**
               *
               *     [ Share Profile ]  [ bingd. Awards ]
               *     [        Follow / Following        ]
               *
               * The founder's rule for this pass: looking at somebody else should feel
               * like looking at your own profile, so the pair sits where the pair sits
               * and the full-width slot underneath — Invite friends on your own — holds
               * the one control that depends on who is looking. It was the other way
               * round here, which put a different thing in the top row on each screen
               * and made the two read as two designs again.
               *
               * **The pair is `ProfileActions`, which the owner's profile draws too.**
               * It was two `Button`s written out here, and they had drifted: Awards was
               * `secondary` on this screen and filled Maroon on the owner's, so the same
               * object wore two treatments one tap apart. The founder's device pass also
               * found the label wrapping to two lines at iPhone width. Both are fixed in
               * the component rather than here, because a rule two call sites keep by
               * agreement is a rule that will be broken again.
               *
               * Follow does not lose by Awards taking the fill — it is full-width Maroon
               * on its own row underneath, which is the louder of the two positions.
               */
              <View style={styles.controls}>
                <ProfileActions
                  onShare={() => void shareProfile()}
                  onOpenAwards={() => setAwardsOpen(true)}
                />
                <FollowControl
                  userId={subjectId}
                  name={profile.data.name}
                  viewerId={viewer.id}
                  relationship={relationships.data?.get(subjectId)}
                  isSelf={isSelf}
                  surface="profile"
                />
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
              {/* **Reviews, because that is what these are.** This section is fed by
                  `public_notes`, so every row under it is writing its author chose to
                  publish — the same rows the title page lists under a tab called
                  Reviews, through the same predicate. Calling them Notes here was the
                  sharpest of the three names one object had. */}
              <SectionHeader title="Reviews" />
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

                    {/* The same reporting path the title page's Reviews tab offers, on
                        the same object. A review is one row of `user_media` wherever it
                        is read, so a reader who finds it here rather than on the title
                        has the same recourse.

                        Absent on the viewer's own profile — which this screen can be:
                        Settings › Privacy links here as "see your public profile". The
                        server refuses a self-report with a 22023, so the control would
                        only ever produce an error.

                        The slop is what carries the 44pt floor (`layout.minTapTarget`):
                        the control is one caption line, and a taller box would make
                        one word read as a button under every review. */}
                    {!isSelf ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Report this review of ${entry.title}`}
                        accessibilityHint="Tells whoever runs bingd. about this review"
                        onPress={() => setReportingReview(entry.id)}
                        hitSlop={
                          (theme.layout.minTapTarget - theme.typography.caption.lineHeight) / 2
                        }
                      >
                        <Text variant="caption" tone="tertiary">
                          Report
                        </Text>
                      </Pressable>
                    ) : null}
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

      <ReportSheet
        visible={reportingReview !== null}
        onClose={() => setReportingReview(null)}
        subject="review"
        subjectId={reportingReview ?? ''}
        noun="review"
      />

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
  // Taste Match had a style here — centred under the photo, two tight lines — and needs
  // none now that it is one line inside the identity column, which `ProfileIdentity`
  // already spaces.
  // The pair, then the relationship action under it — the owner's profile keeps the
  // same rhythm between its pair and Invite friends. `ProfileIdentity` owns the space
  // above and the gutter beside.
  controls: { gap: theme.space[2] },
  section: { paddingTop: theme.space[5], gap: theme.space[2] },
  note: { paddingBottom: theme.space[2] },
  noteBody: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[1] },
});
