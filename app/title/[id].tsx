import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { LogSheet, type LoggableTitle } from '@/features/collection/LogSheet';
import { useTitleScore } from '@/features/collection/use-score';
import { newOperationId, setWatchlist } from '@/features/collection/writes';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { useSeasons } from '@/features/search/use-title-search';
import { useCredits } from '@/features/title/use-credits';
import { useTitleEnrichment } from '@/features/title/use-enrichment';
import { backdropUri, posterUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import {
  CastStrip,
  Chip,
  EmptyState,
  LoadingScreen,
  Poster,
  Screen,
  ScoreBadge,
  SegmentedTabs,
  Text,
  TitleHero,
  TitleRow,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

type Tab = 'cast' | 'details' | 'reviews' | 'seasons';

/**
 * The title page (screens.md §6).
 *
 * Ordered by what the person opening it is actually asking. Most visits are
 * someone deciding whether they have already seen this, so their own state
 * comes before the catalogue's: hero, identity, their rank and watch date, then
 * metadata, then the long content behind tabs.
 *
 * The hero is the app's one full-bleed surface, and the score badge is one of
 * only two chromatic elements permitted on a content surface (design-system.md
 * §1). Both exceptions are spent here on purpose.
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
            'id, kind, title, release_date, runtime_minutes, overview, poster_path, backdrop_path, genres, provenance, tmdb_id, original_language',
          )
          .eq('id', id ?? '')
          .single(),
        supabase
          .from('user_media')
          .select('bucket, watched_on, note')
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

  const credits = useCredits(data?.title?.id ?? null);
  const seasons = useSeasons(data?.title?.kind === 'series' ? data.title.id : null);
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
  const note = data.logged?.note ?? null;

  // A tab whose content does not exist is not rendered. An always-empty tab is
  // worse than a missing one: it invites a tap that leads nowhere.
  const tabs = [
    ...(cast.length ? [{ id: 'cast' as const, label: 'Cast' }] : []),
    { id: 'details' as const, label: 'Details' },
    ...(note ? [{ id: 'reviews' as const, label: 'Reviews' }] : []),
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
      year: yearOf(title.release_date),
      posterUri: posterUri(title.poster_path, 'card'),
      kind: title.kind,
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
        <TitleHero
          uri={backdropUri(title.backdrop_path, 'hero')}
          collapsedHeight={HERO_COLLAPSED}
        />

        {/* Straddling the hero's bottom edge, which is what makes the image and
            the page one object rather than a banner over a page. Genre is also
            the single most useful fact about a film the user has not seen. */}
        {title.genres?.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pills}
            style={styles.pillRow}
          >
            {title.genres.slice(0, 4).map((genre: string) => (
              <Chip key={genre} label={genre} />
            ))}
          </ScrollView>
        ) : null}

        <View style={styles.identity}>
          <Poster uri={posterUri(title.poster_path, 'card')} title={title.title} size="lg" />
          <View style={styles.identityCopy}>
            <Text variant="title1">{title.title}</Text>
            {yearOf(title.release_date) ? (
              <Text variant="body" tone="secondary">
                {yearOf(title.release_date)}
              </Text>
            ) : null}
          </View>
        </View>

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

        {/* One line, in the order a person would say it. Where Luma puts the
            venue. */}
        <View style={styles.block}>
          <Text variant="footnote" tone="secondary">
            {[
              title.runtime_minutes ? `${title.runtime_minutes}m` : null,
              credits.data?.director,
              cast.slice(0, 2).map((person) => person.name).join(', ') || null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>

        <View style={styles.state}>
          <View style={styles.stateMain}>
            {rankable ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={data.ranked ? 'Ranked. Rank again.' : 'Rank this title'}
                onPress={openLog}
                style={({ pressed }) => [styles.rankButton, pressed && styles.pressed]}
              >
                <Text variant="callout" tone="inverse">
                  {data.ranked ? 'Ranked' : 'Rank'}
                </Text>
              </Pressable>
            ) : null}
            {watchedDate ? (
              <Text variant="footnote" tone="secondary">
                Watched {watchedDate}
              </Text>
            ) : null}
          </View>

          {/* Dashed when logged but not compared, so the two controls read as
              one sentence: Rank, then no score yet. Not a failure state. */}
          {rankable ? (
            <ScoreBadge score={score} bucket={data.ranked?.bucket ?? null} onPress={openLog} />
          ) : null}

          <IconAction
            icon={isWatchlisted ? 'bookmark' : 'bookmark-outline'}
            label={isWatchlisted ? 'Remove from watchlist' : 'Add to watchlist'}
            onPress={() => void toggleWatchlist()}
            disabled={watchlistBusy}
          />
          <IconAction
            icon="share-outline"
            label={`Share ${title.title}`}
            onPress={() => void shareTitle()}
          />
        </View>

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

        {activeTab === 'cast' ? <CastStrip cast={cast} /> : null}

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
            {/* The ordinal, with its denominator. A bare "#2" is unreadable
                without knowing what it is two of (PRD §10) — and it belongs
                here rather than beside the score, which is the number that
                answers the question people actually ask. */}
            <Detail
              label="Your rank"
              value={
                data.ranked && total ? `#${data.ranked.position} of ${total} in ${rankCategory}` : null
              }
            />
          </View>
        ) : null}

        {activeTab === 'reviews' && note ? (
          <View style={styles.block}>
            <Text variant="body">{note}</Text>
            {watchedDate ? (
              <Text variant="footnote" tone="tertiary">
                {watchedDate}
              </Text>
            ) : null}
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
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
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
const HERO_COLLAPSED = 72;
const POSTER_LIFT = 56;

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[10] },
  pillRow: {
    // Pulled up onto the hero's bottom edge.
    marginTop: -theme.layout.control.chipHeight / 2,
    marginBottom: theme.space[2],
  },
  pills: { paddingHorizontal: theme.layout.gutter, gap: theme.space[2] },
  identity: {
    flexDirection: 'row',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    // The poster rises into the hero. Negative margin rather than absolute
    // positioning, so everything below still flows from it.
    marginTop: -POSTER_LIFT,
  },
  identityCopy: {
    flex: 1,
    gap: theme.space[1],
    // Aligned to the poster's lower half, where the hero has already faded to
    // Paper — the title must never sit on artwork.
    justifyContent: 'flex-end',
    paddingBottom: theme.space[2],
  },
  block: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    gap: theme.space[1],
  },
  state: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
  },
  stateMain: { flex: 1, gap: theme.space[1] },
  rankButton: {
    alignSelf: 'flex-start',
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.space[5],
    borderRadius: theme.radius.control,
    backgroundColor: theme.semantic.action,
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
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[6],
    gap: theme.space[1],
  },
  pressed: { opacity: 0.7 },
});
