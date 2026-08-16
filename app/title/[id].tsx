import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { LogSheet, type LoggableTitle } from '@/features/collection/LogSheet';
import { useCompanions } from '@/features/collection/use-companions';
import { useTitleScore } from '@/features/collection/use-score';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { newOperationId, setWatchlist } from '@/features/collection/writes';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { useSeasons } from '@/features/search/use-title-search';
import { useCommunityScore } from '@/features/title/use-community-score';
import { useCredits } from '@/features/title/use-credits';
import { useTitleEnrichment } from '@/features/title/use-enrichment';
import { useTitleNotes, useTitleVideos } from '@/features/title/use-title-extras';
import { backdropUri, posterUri, profileUri, videoUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { fullTitle } from '@/lib/titles';
import {
  Avatar,
  CastStrip,
  Chip,
  EmptyState,
  LoadingScreen,
  Poster,
  Screen,
  ScorePanel,
  SectionHeader,
  SegmentedTabs,
  SpoilerNote,
  Text,
  TitleHero,
  TitleRow,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

type Tab = 'cast' | 'videos' | 'details' | 'seasons';

/**
 * The title page (screens.md §6), rebuilt after the founder's device test.
 *
 * What that test rejected, and what replaced it:
 *
 *   - genre pills floating over the poster. They are metadata, not artwork, and
 *     putting them on the hero made them compete with the one image on the screen.
 *     They now sit under the description, in neutral chips, where genre is a fact
 *     among facts.
 *   - initials-only cast as the intended state. `CastStrip` renders TMDB portraits
 *     and falls back to initials, rather than treating the fallback as the design.
 *   - a Reviews tab that was one person's private note relabelled. Notes are social
 *     content now, and they have a section of their own that says what they are.
 *   - a duplicated Rank affordance — a button beside a badge, both doing the same
 *     thing. The badge is the control.
 *
 * The hero is the app's one full-bleed surface and the score badge one of two
 * chromatic elements permitted on a content surface (design-system.md §1). Both
 * exceptions are spent here on purpose.
 */
export default function TitleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const router = useRouter();
  const hasId = Boolean(id);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>('cast');
  const [loggingTitle, setLoggingTitle] = useState<LoggableTitle | null>(null);
  const [rankingSubject, setRankingSubject] = useState<RankingSubject | null>(null);

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: queryKeys.title(id ?? ''),
    enabled: hasId,
    queryFn: async () => {
      const [
        { data: title, error: titleError },
        { data: logged, error: loggedError },
        { data: ranked, error: rankedError },
        { data: watchlist, error: watchlistError },
      ] = await Promise.all([
        supabase
          .from('media_items')
          .select(
            'id, kind, title, release_date, runtime_minutes, overview, poster_path, backdrop_path, genres, provenance, tmdb_id, original_language, parent:parent_id(id, title)',
          )
          .eq('id', id ?? '')
          .single(),
        supabase
          .from('user_media')
          .select('bucket, watched_on, note, note_has_spoilers')
          .eq('user_id', profile.id)
          .eq('media_item_id', id ?? '')
          .maybeSingle(),
        supabase
          .from('rankings')
          .select('position, category, bucket')
          .eq('user_id', profile.id)
          .eq('media_item_id', id ?? '')
          .maybeSingle(),
        supabase
          .from('watchlist')
          .select('media_item_id')
          .eq('user_id', profile.id)
          .eq('media_item_id', id ?? '')
          .maybeSingle(),
      ]);

      if (titleError) throw titleError;
      if (loggedError) throw loggedError;
      if (rankedError) throw rankedError;
      if (watchlistError) throw watchlistError;
      return { title, logged, ranked, watchlist };
    },
  });

  const titleId = data?.title?.id ?? null;
  const credits = useCredits(titleId);
  const seasons = useSeasons(data?.title?.kind === 'series' ? data.title.id : null);
  const videos = useTitleVideos(titleId);
  const notes = useTitleNotes(titleId);
  const community = useCommunityScore(titleId);
  const watched = useWatched(profile.id);
  const companions = useCompanions(profile.id, titleId);
  // Seeded rows arrive with no artwork, overview or credits. Opening the screen is
  // what fetches them, unless the bulk pass got there first.
  const { enriching } = useTitleEnrichment(data?.title ?? null);
  // The score is derived from the band, so this needs the whole category's
  // bucket counts — not just this title's row (ranking.md §11).
  const titleScore = useTitleScore(
    profile.id,
    data?.ranked?.category === 'tv_seasons' ? 'tv_seasons' : 'movies',
    data?.ranked ?? null,
  );

  const cast = useMemo(
    () =>
      (credits.data?.cast ?? []).map((person) => ({
        id: person.id,
        name: person.name,
        character: person.character,
        avatarUri: profileUri(person.profilePath),
      })),
    [credits.data],
  );

  if (!hasId) {
    return (
      <Screen includeBottomInset>
        <EmptyState kind="nothingMatches" title="Title not found" body="This link is incomplete." />
      </Screen>
    );
  }

  // Not a skeleton. A list has a knowable shape before its data arrives; this
  // page's height depends on whether there is a backdrop, an overview, a cast,
  // seasons — so a skeleton here would guess wrong and relayout anyway.
  if (isPending) {
    return (
      <Screen includeBottomInset>
        <LoadingScreen />
      </Screen>
    );
  }

  if (isError || !data?.title) {
    return (
      <Screen includeBottomInset>
        <EmptyState
          kind="couldNotLoad"
          title="Could not load this title"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void refetch() }}
        />
      </Screen>
    );
  }

  const title = data.title;
  const parent = Array.isArray(title.parent) ? title.parent[0] : title.parent;
  // The page shows the series' own name in the hierarchy above the season, so the
  // heading itself stays short: "Season 2", under "Parks and Recreation".
  const displayTitle = fullTitle(
    { kind: title.kind, title: title.title, seriesTitle: parent?.title ?? null },
    { parentIsVisible: true },
  );
  const isWatchlisted = Boolean(data.watchlist);
  const watchedDate = data.logged?.watched_on
    ? new Date(`${data.logged.watched_on}T00:00:00Z`).toLocaleDateString(undefined, {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null;
  const rankCategory = data.ranked?.category === 'tv_seasons' ? 'TV seasons' : 'Movies';
  const { score, total } = titleScore;
  const rankable = title.kind === 'movie' || title.kind === 'season';
  const isSeries = title.kind === 'series';
  const year = yearOf(title.release_date);

  // A tab whose content does not exist is not rendered. An always-empty tab is
  // worse than a missing one: it invites a tap that leads nowhere. Videos is here
  // for the same reason it is in the schema — the day the adapter is redeployed the
  // tab appears by itself, and until then it does not pretend to.
  const tabs = [
    ...(cast.length ? [{ id: 'cast' as const, label: 'Cast' }] : []),
    ...(videos.data?.length ? [{ id: 'videos' as const, label: 'Videos' }] : []),
    { id: 'details' as const, label: 'Details' },
    ...(isSeries && seasons.data?.length ? [{ id: 'seasons' as const, label: 'Seasons' }] : []),
  ];
  // The chosen tab may not exist for this title — a film has no Seasons —
  // so it falls back rather than rendering nothing under a live tab row.
  const activeTab = tabs.some((option) => option.id === tab) ? tab : tabs[0]?.id;

  const openLog = () => {
    if (!rankable) return;
    setActionError(null);
    setLoggingTitle({
      id: title.id,
      title: title.title,
      year,
      posterUri: posterUri(title.poster_path, 'card'),
      kind: title.kind,
      seriesTitle: parent?.title ?? null,
    });
  };

  const toggleWatchlist = async () => {
    if (watchlistBusy) return;
    setWatchlistBusy(true);
    setActionError(null);
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId: title.id,
      present: !isWatchlisted,
    });
    setWatchlistBusy(false);

    if (result.outcome === 'failed') {
      setActionError(result.message);
      Alert.alert('Could not update watchlist', result.message);
      return;
    }

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...queryKeys.collection(profile.id), 'watchlist'] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.title(id ?? '') }),
      queryClient.invalidateQueries({ queryKey: queryKeys.collection(profile.id) }),
    ]);
  };

  const shareTitle = async () => {
    const url = `https://bingd.app/title/${title.kind}/${title.id}`;
    try {
      await Share.share({ message: url, url });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sharing failed.';
      setActionError(message);
      Alert.alert('Could not share', message);
    }
  };

  return (
    <Screen includeBottomInset edges={[]}>
      <Stack.Screen
        options={{
          title: title.title,
          headerShown: true,
          // Transparent, so the hero runs under it. Without this the app's one
          // full-bleed image starts below a solid bar and is not full-bleed.
          headerTransparent: true,
          headerTitle: '',
        }}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <TitleHero uri={backdropUri(title.backdrop_path, 'hero')} collapsedHeight={HERO_COLLAPSED} />

        {/* The poster rises into the hero and the score sits opposite it, so the
            two anchor the same band rather than stacking. Negative margin rather
            than absolute positioning, so everything below still flows from it. */}
        <View style={styles.identity}>
          <View style={styles.posterFrame}>
            <Poster uri={posterUri(title.poster_path, 'card')} title={title.title} size="lg" />
          </View>
          <View style={styles.scoreColumn}>
            <ScorePanel
              yourScore={score}
              yourBucket={data.ranked?.bucket ?? null}
              onRank={rankable ? openLog : undefined}
              ordinal={
                data.ranked && total ? `#${data.ranked.position} in ${rankCategory}` : null
              }
              community={
                community.data && !isSeries
                  ? {
                      score: community.data.score,
                      ratingCount: community.data.ratingCount,
                      minRatings: community.data.minRatings,
                    }
                  : null
              }
            />
          </View>
        </View>

        <View style={styles.heading}>
          {/* A season says which show it belongs to, above its own name. The feed
              writes that as one string because it has no room; here there is a
              hierarchy to put it in. */}
          {parent?.title ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${parent.title}, the series this belongs to`}
              onPress={() => router.push(`/title/${parent.id}`)}
            >
              <Text variant="callout" tone="action" numberOfLines={1}>
                {parent.title}
              </Text>
            </Pressable>
          ) : null}
          <Text variant="title1">{displayTitle ?? title.title}</Text>
          <Text variant="footnote" tone="secondary">
            {[
              year,
              title.runtime_minutes ? `${title.runtime_minutes}m` : null,
              credits.data?.director,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>

        <View style={styles.actions}>
          <IconAction
            icon={isWatchlisted ? 'bookmark' : 'bookmark-outline'}
            label={isWatchlisted ? 'Remove from watchlist' : 'Add to watchlist'}
            selected={isWatchlisted}
            onPress={() => void toggleWatchlist()}
            disabled={watchlistBusy}
          />
          <IconAction
            icon="share-outline"
            label={`Share ${title.title}`}
            onPress={() => void shareTitle()}
          />
          {watchedDate ? (
            <Text variant="footnote" tone="secondary" style={styles.watched}>
              Watched {watchedDate}
            </Text>
          ) : null}
        </View>

        {companions.data?.length ? (
          <View style={styles.block}>
            <Text variant="footnote" tone="secondary">
              Watched with {companions.data.map((person) => person.name).join(', ')}
            </Text>
          </View>
        ) : null}

        {title.overview ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Collapse description' : 'Expand description'}
            onPress={() => setExpanded((open) => !open)}
            style={styles.block}
          >
            <Text variant="body" numberOfLines={expanded ? undefined : 3}>
              {title.overview}
            </Text>
            {/* No "less". Once it is open the whole thing is visible and the
                control has nothing left to promise. */}
            {expanded ? null : (
              <Text variant="callout" tone="action">
                more
              </Text>
            )}
          </Pressable>
        ) : null}

        {/* Below the description, never over the artwork. Neutral chips, because
            genre is a fact among facts here rather than a badge. */}
        {title.genres?.length ? (
          <View style={styles.pills}>
            {title.genres.slice(0, 5).map((genre: string) => (
              <Chip key={genre} label={genre} />
            ))}
          </View>
        ) : null}

        {actionError ? (
          <View style={styles.block}>
            <Text variant="footnote" tone="action">
              {actionError}
            </Text>
          </View>
        ) : null}

        <View style={styles.tabs}>
          <SegmentedTabs
            options={tabs}
            value={activeTab ?? 'details'}
            onChange={(next) => setTab(next)}
          />
        </View>

        {activeTab === 'cast' ? (
          <CastStrip cast={cast} onPressMember={(member) => router.push(`/person/${member.id}`)} />
        ) : null}

        {activeTab === 'videos' && videos.data?.length ? (
          <View style={styles.details}>
            {videos.data.map((video) => (
              <Pressable
                key={video.id}
                accessibilityRole="link"
                accessibilityLabel={`Play ${video.name} on YouTube`}
                onPress={() => {
                  const uri = videoUri(video.key);
                  if (uri) void Linking.openURL(uri);
                }}
                style={({ pressed }) => [styles.video, pressed && styles.pressed]}
              >
                <Ionicons
                  name="play-circle-outline"
                  size={theme.layout.icon.lg}
                  color={theme.semantic.action}
                />
                <View style={styles.videoCopy}>
                  <Text variant="callout" numberOfLines={1}>
                    {video.name}
                  </Text>
                  <Text variant="caption" tone="tertiary">
                    {video.type}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}

        {activeTab === 'details' ? (
          <View style={styles.details}>
            <Detail label="Released" value={formatDate(title.release_date)} />
            <Detail
              label="Runtime"
              value={title.runtime_minutes ? `${title.runtime_minutes} minutes` : null}
            />
            <Detail label="Genres" value={title.genres?.join(', ') || null} />
            <Detail label="Language" value={languageName(title.original_language)} />
            <Detail label="Director" value={credits.data?.director ?? null} />
            {/* The ordinal with its denominator. The panel above shows the short
                form, which is the one people read; this is the one that says what
                it is two of (PRD §10). */}
            <Detail
              label="Your rank"
              value={
                data.ranked && total ? `#${data.ranked.position} of ${total} in ${rankCategory}` : null
              }
            />
          </View>
        ) : null}

        {activeTab === 'seasons' && seasons.data?.length ? (
          <View>
            {seasons.data.map((season) => (
              <TitleRow
                key={season.id}
                title={season.title}
                year={yearOf(season.release_date)}
                posterUri={posterUri(season.poster_path)}
                secondary="Season"
                onPress={() => router.push(`/title/${season.id}`)}
              />
            ))}
          </View>
        ) : null}

        {/* Notes, called notes. They are not reviews — nobody wrote them as one —
            and the tab that used to say so was one person's private sentence with a
            magazine's word on top of it. */}
        {notes.data?.length ? (
          <View style={styles.section}>
            <SectionHeader title="Notes" />
            {notes.data.map((entry) => (
              <View key={`${entry.userId}-${entry.updatedAt}`} style={styles.note}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${entry.name}'s profile`}
                  onPress={() => router.push(`/u/${entry.username}`)}
                  style={styles.noteHead}
                >
                  <Avatar size="sm" uri={entry.avatarUri} name={entry.name} />
                  <Text variant="callout">{entry.name}</Text>
                </Pressable>
                <SpoilerNote
                  text={entry.note}
                  hasSpoilers={entry.hasSpoilers}
                  masked={shouldMask({
                    hasSpoilers: entry.hasSpoilers,
                    mediaItemId: title.id,
                    viewerId: profile.id,
                    authorId: entry.userId,
                    watched: watched.data,
                  })}
                  titleForLabel={displayTitle}
                />
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.footer}>
          {enriching ? (
            <Text variant="caption" tone="tertiary">
              Fetching details…
            </Text>
          ) : null}
          {/* One of the two attribution slots TMDB's terms ask for. The full notice
              lives in Settings › About, which is the "About or Credits section" their
              FAQ names; this is the per-title source line from screens.md §6. */}
          {title.provenance === 'tmdb' ? (
            <Text variant="caption" tone="tertiary">
              Metadata from TMDB
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <LogSheet
        title={loggingTitle}
        onClose={() => {
          setLoggingTitle(null);
          setActionError(null);
        }}
        onRank={(bucket, mode) => {
          if (!loggingTitle) return;
          setRankingSubject({
            id: loggingTitle.id,
            title: loggingTitle.title,
            bucket,
            posterUri: loggingTitle.posterUri,
            mode,
          });
          setLoggingTitle(null);
        }}
      />
      <RankingSheet
        subject={rankingSubject}
        onClose={() => setRankingSubject(null)}
        onRankAnother={() => setRankingSubject(null)}
      />
    </Screen>
  );
}

/** Label above value, stacked, no rules — Apple TV's information layout. */
function Detail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;

  return (
    <View style={styles.detail}>
      <Text variant="caption" tone="tertiary">
        {label.toUpperCase()}
      </Text>
      <Text variant="body">{value}</Text>
    </View>
  );
}

function IconAction({
  icon,
  label,
  onPress,
  disabled = false,
  selected,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={theme.space[2]}
      style={({ pressed }) => [styles.iconAction, (pressed || disabled) && styles.pressed]}
    >
      <Ionicons name={icon} size={theme.layout.icon.md} color={theme.semantic.action} />
    </Pressable>
  );
}

function yearOf(date: string | null) {
  if (!date) return null;
  return Number(date.slice(0, 4));
}

function formatDate(date: string | null) {
  if (!date) return null;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Renders a language name from its code using the platform's own tables, so
 * "ja" reads as "Japanese" in English and as "japonais" in French. Falls back
 * to the raw code rather than to nothing — a code is at least true.
 */
function languageName(code: string | null | undefined) {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Tall enough that the poster still overlaps something when there is no
 *  backdrop, so the page does not become a different design. */
const HERO_COLLAPSED = 96;
const POSTER_LIFT = 64;

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  identity: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    marginTop: -POSTER_LIFT,
  },
  /**
   * A Paper mat around the artwork, the way a print is framed.
   *
   * The poster straddles the hero's lower edge, and without this it reads as cut out
   * and dropped on — its own hairline is a millimetre of separation from whatever
   * happens to be behind it. Four points of the page's own colour, plus the shadow,
   * makes it an object sitting on the page rather than a hole in it.
   */
  posterFrame: {
    padding: theme.space[1],
    borderRadius: theme.radius.card + theme.space[1],
    backgroundColor: theme.surface.base,
    ...theme.elevation.e2,
  },
  // Aligned to the poster's lower half, where the hero has already faded to
  // Paper — nothing here may sit on artwork.
  scoreColumn: { flex: 1, paddingBottom: theme.space[2] },
  heading: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    gap: theme.space[1],
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  watched: { flex: 1, textAlign: 'right' },
  block: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    gap: theme.space[1],
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  iconAction: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: {
    marginTop: theme.space[5],
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
    paddingTop: theme.space[1],
    marginBottom: theme.space[2],
  },
  details: { paddingHorizontal: theme.layout.gutter, gap: theme.space[4] },
  detail: { gap: 2 },
  video: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
  },
  videoCopy: { flex: 1, gap: 2 },
  section: { paddingTop: theme.space[6], gap: theme.space[2] },
  note: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    gap: theme.space[2],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[6],
    gap: theme.space[1],
  },
  pressed: { opacity: 0.7 },
});
