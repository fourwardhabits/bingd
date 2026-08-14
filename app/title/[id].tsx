import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { LogSheet, type LoggableTitle } from '@/features/collection/LogSheet';
import { BAND_LABEL } from '@/features/collection/use-collection';
import { newOperationId, setWatchlist } from '@/features/collection/writes';
import { RankingSheet } from '@/features/ranking/RankingSheet';
import { useSeasons } from '@/features/search/use-title-search';
import { useCredits } from '@/features/title/use-credits';
import { backdropUri, posterUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import {
  Backdrop,
  Button,
  CastStrip,
  EmptyState,
  Poster,
  RankBadge,
  Screen,
  SectionHeader,
  Text,
  TitleMetadata,
  TitleRow,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

export default function TitleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const router = useRouter();
  const hasId = Boolean(id);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loggingTitle, setLoggingTitle] = useState<LoggableTitle | null>(null);
  const [rankingSubject, setRankingSubject] = useState<{
    id: string;
    title: string;
    bucket: 'loved' | 'fine' | 'notForMe';
    posterUri: string | null;
  } | null>(null);

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
            'id, kind, title, release_date, runtime_minutes, overview, poster_path, backdrop_path, genres, provenance, tmdb_id',
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
          .select('position, category')
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

  if (!hasId) {
    return (
      <Screen includeBottomInset>
        <EmptyState kind="nothingMatches" title="Title not found" body="This link is incomplete." />
      </Screen>
    );
  }

  if (isPending) {
    return (
      <Screen includeBottomInset>
        <View style={styles.status}>
          <Text variant="body" tone="tertiary">
            Loading title...
          </Text>
        </View>
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
      })
    : null;
  const rankCategory = data.ranked?.category === 'tv_seasons' ? 'TV seasons' : 'Movies';
  const cast = (credits.data?.cast ?? []).map((person) => ({
    id: person.id,
    name: person.name,
    character: person.character,
  }));
  const rankable = title.kind === 'movie' || title.kind === 'season';

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
    const nextPresent = !isWatchlisted;
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId: title.id,
      present: nextPresent,
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
    <Screen includeBottomInset>
      <Stack.Screen options={{ title: title.title, headerShown: true }} />
      <ScrollView contentContainerStyle={styles.content}>
        {title.backdrop_path ? <Backdrop uri={backdropUri(title.backdrop_path, 'hero')} /> : null}

        <View style={styles.header}>
          <Poster uri={posterUri(title.poster_path, 'card')} title={title.title} size="lg" />
          <View style={styles.headerCopy}>
            <Text variant="title1">{title.title}</Text>
            <TitleMetadata
              year={yearOf(title.release_date)}
              runtimeMinutes={title.runtime_minutes}
              genres={title.genres}
            />
          </View>
        </View>

        <View style={styles.actions}>
          {rankable ? <Button label={data.ranked ? 'Re-rank' : 'Rank'} onPress={openLog} /> : null}
          <View style={styles.secondaryActions}>
            <View style={styles.secondaryAction}>
              <Button
                label={isWatchlisted ? 'In watchlist' : 'Watchlist'}
                kind="secondary"
                onPress={() => void toggleWatchlist()}
                disabled={watchlistBusy}
                disabledReason="Saving..."
              />
            </View>
            <View style={styles.secondaryAction}>
              <Button label="Share" kind="secondary" onPress={() => void shareTitle()} />
            </View>
          </View>
          {actionError ? (
            <Text variant="footnote" tone="action">
              {actionError}
            </Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <SectionHeader title="Your rank" />
          {data.ranked ? (
            <RankBadge position={data.ranked.position} category={rankCategory} emphasis />
          ) : (
            <Text variant="body" tone="secondary">
              Not ranked yet.
            </Text>
          )}
          {data.logged?.bucket ? (
            <Text variant="body">{BAND_LABEL[data.logged.bucket as keyof typeof BAND_LABEL]}</Text>
          ) : null}
          {watchedDate ? (
            <Text variant="footnote" tone="secondary">
              Watched {watchedDate}
            </Text>
          ) : null}
          {data.logged?.note ? (
            <Text variant="body" tone="secondary">
              {data.logged.note}
            </Text>
          ) : null}
        </View>

        {title.overview ? (
          <View style={styles.section}>
            <Text variant="body" numberOfLines={3}>
              {title.overview}
            </Text>
          </View>
        ) : null}

        {credits.data?.director ? (
          <View style={styles.section}>
            <Text variant="subhead" tone="tertiary">
              Director
            </Text>
            <Text variant="body">{credits.data.director}</Text>
          </View>
        ) : null}

        {cast.length ? (
          <View style={styles.section}>
            <SectionHeader title="Cast" />
            <CastStrip cast={cast} />
          </View>
        ) : null}

        {title.kind === 'series' && seasons.data?.length ? (
          <View style={styles.section}>
            <SectionHeader title="Seasons" />
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

        {title.provenance === 'tmdb' ? (
          <Text variant="caption" tone="tertiary">
            Source: TMDB metadata
          </Text>
        ) : null}
      </ScrollView>
      <LogSheet
        title={loggingTitle}
        onClose={() => {
          setLoggingTitle(null);
          setActionError(null);
        }}
        onFindWhereItLands={(bucket) => {
          if (!loggingTitle) return;
          setRankingSubject({
            id: loggingTitle.id,
            title: loggingTitle.title,
            bucket,
            posterUri: loggingTitle.posterUri,
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

function yearOf(date: string | null) {
  if (!date) return null;
  return Number(date.slice(0, 4));
}

const styles = StyleSheet.create({
  content: {
    padding: theme.layout.gutter,
    gap: theme.layout.sectionGap,
    paddingBottom: theme.space[10],
  },
  status: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.layout.gutter,
  },
  header: { flexDirection: 'row', gap: theme.space[4] },
  headerCopy: { flex: 1, gap: theme.space[2], justifyContent: 'center' },
  actions: { gap: theme.space[2] },
  secondaryActions: {
    flexDirection: 'row',
    gap: theme.space[2],
  },
  secondaryAction: { flex: 1 },
  section: { gap: theme.space[2] },
});
