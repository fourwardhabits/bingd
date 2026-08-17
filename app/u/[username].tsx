import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { bandSizes, scoreFor } from '@/features/collection/score';
import { useRankedCollection, type RankingCategory } from '@/features/collection/use-collection';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { CommentSheet } from '@/features/feed/CommentSheet';
import { useCommentCounts } from '@/features/feed/use-comments';
import { useActorActivity } from '@/features/feed/use-feed';
import { FollowControl } from '@/features/profile/FollowControl';
import { useProfileNotes, usePublicProfile } from '@/features/profile/use-public-profile';
import { useMyBlocks, useRelationships, useSocialWrites } from '@/features/profile/use-social';
import { tasteMatchCopy, useTasteMatch } from '@/features/profile/use-taste-match';
import { posterUri } from '@/lib/images';
import { fullTitle } from '@/lib/titles';
import {
  ActivityRow,
  Avatar,
  EmptyState,
  LoadingScreen,
  PosterGrid,
  Screen,
  ScoreBadge,
  SectionHeader,
  SegmentedTabs,
  SkeletonRow,
  SpoilerNote,
  StatRow,
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
  const [category, setCategory] = useState<RankingCategory>('movies');
  const [commentsFor, setCommentsFor] = useState<string | null>(null);

  const profile = usePublicProfile(username ?? null);
  const subjectId = profile.data?.id ?? '';
  const ranked = useRankedCollection(subjectId, category);
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
  const { unblock, busy: unblocking } = useSocialWrites(viewer.id);

  const isSelf = profile.data?.id === viewer.id;
  const rows = ranked.data ?? [];
  // Band sizes come from the whole category, never from a slice: a score is only
  // meaningful against every title in its band, so scoring the top six against
  // themselves would give all six a 10.
  const sizes = bandSizes(rows);
  const top = rows.slice(0, 6);
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
  const tasteCopy = tasteMatchCopy(taste.data);

  return (
    <Screen includeBottomInset edges={[]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: profile.data?.name ?? '',
          headerBackTitle: 'Back',
        }}
      />

      {profile.isPending ? (
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
          body="You will not see each other on Bingd. Unblocking does not restore any follow between you."
          action={{
            label: unblocking ? 'Unblocking…' : 'Unblock',
            onPress: () =>
              void (async () => {
                const result = await unblock({ userId: blockedMatch.id });
                if (!result.ok) Alert.alert('Could not unblock', result.message);
              })(),
          }}
        />
      ) : !profile.data ? (
        // The same answer for a private account and for a name nobody has taken.
        // Distinguishing them would disclose that the account exists.
        <EmptyState
          kind="nothingYet"
          title={`@${username}`}
          body="This profile is not available."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.identity}>
            <Avatar size="lg" uri={profile.data.avatarUri} name={profile.data.name} />
            <Text variant="title2">{profile.data.name}</Text>
            <Text variant="footnote" tone="secondary">
              @{profile.data.username}
            </Text>

            {/* Directly under the handle, which is where the founder placed it:
                "Display Name / @handle / 84% Taste Match / 12 titles in common".
                Absent entirely on the viewer's own profile, and absent while the
                answer is still loading rather than showing a placeholder number that
                then changes. */}
            {!isSelf && tasteCopy ? (
              <View style={styles.taste}>
                <Text variant="callout" tone="action">
                  {tasteCopy.headline}
                </Text>
                <Text variant="caption" tone="tertiary">
                  {tasteCopy.detail}
                </Text>
              </View>
            ) : null}

            {/* Under the identity rather than beside it: the founder's approved
                profile design is a large avatar with the name and handle, and a
                control tucked into that group competes with the name. */}
            <FollowControl
              userId={subjectId}
              name={profile.data.name}
              viewerId={viewer.id}
              relationship={relationships.data?.get(subjectId)}
              isSelf={isSelf}
            />
          </View>

          <StatRow
            stats={[
              { label: 'Followers', value: profile.data.followers },
              { label: 'Following', value: profile.data.following },
              { label: 'Movies', value: profile.data.rankedMovies },
              { label: 'Seasons', value: profile.data.rankedSeasons },
            ]}
          />

          <View style={styles.section}>
            {ranked.isPending ? (
              <>
                <SectionHeader title="Top ranked" />
                <SkeletonRow count={3} />
              </>
            ) : top.length === 0 ? (
              <>
                <SectionHeader title="Top ranked" />
                <EmptyState
                  kind="nothingYet"
                  compact
                  title="Nothing ranked yet"
                  body={
                    isSelf
                      ? 'Rank a few titles and they will show up here.'
                      : `${profile.data.name} has not ranked anything here yet.`
                  }
                />
              </>
            ) : (
              <PosterGrid
                title="Top ranked"
                tiles={top.map((entry) => ({
                  id: entry.mediaItemId,
                  title:
                    fullTitle({
                      kind: entry.kind,
                      title: entry.title,
                      seriesTitle: entry.seriesTitle,
                    }) ?? entry.title,
                  year: entry.year,
                  posterUri: posterUri(entry.posterPath, 'card'),
                  score: scoreFor(entry.bucket, entry.position, sizes),
                  bucket: entry.bucket,
                }))}
                onPressTile={(tile) => router.push(`/title/${tile.id}`)}
              />
            )}
          </View>

          {/* Movies and seasons are separate rankings and are never merged — a
              position only means anything inside its category (PRD §11) — so this
              is a switch between two lists rather than a filter over one. */}
          <View style={styles.section}>
            <SegmentedTabs
              options={[
                { id: 'movies' as const, label: 'Movies' },
                { id: 'tv_seasons' as const, label: 'TV seasons' },
              ]}
              value={category}
              onChange={setCategory}
            />
            {rows.map((entry) => (
              <TitleRow
                key={entry.mediaItemId}
                title={
                  fullTitle({
                    kind: entry.kind,
                    title: entry.title,
                    seriesTitle: entry.seriesTitle,
                  }) ?? entry.title
                }
                year={entry.year}
                posterUri={posterUri(entry.posterPath)}
                onPress={() => router.push(`/title/${entry.mediaItemId}`)}
                trailing={
                  <ScoreBadge
                    score={scoreFor(entry.bucket, entry.position, sizes)}
                    bucket={entry.bucket}
                    size="sm"
                  />
                }
              />
            ))}
            {!ranked.isPending && rows.length === 0 ? (
              <EmptyState
                kind="nothingYet"
                compact
                title={category === 'movies' ? 'No ranked movies' : 'No ranked seasons'}
                body="Nothing here yet."
              />
            ) : null}
          </View>

          {notes.data?.length ? (
            <View style={styles.section}>
              <SectionHeader title="Notes" />
              {notes.data.map((entry) => (
                <View key={`${entry.mediaItemId}-${entry.updatedAt}`} style={styles.note}>
                  <TitleRow
                    title={
                      fullTitle({
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
                  verb={VERB[event.type]}
                  companions={event.companions}
                  title={event.title}
                  year={event.year}
                  posterUri={posterUri(event.posterPath)}
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

const VERB = {
  title_ranked: 'ranked',
  title_logged: 'watched',
  season_completed: 'finished',
} as const;

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  taste: { alignItems: 'center', gap: 2, paddingTop: theme.space[1] },
  identity: {
    alignItems: 'center',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    paddingBottom: theme.space[4],
  },
  section: { paddingTop: theme.space[5], gap: theme.space[2] },
  note: { paddingBottom: theme.space[2] },
  noteBody: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[1] },
});
