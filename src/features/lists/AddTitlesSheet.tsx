import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { track, type ListMediaKind } from '@/lib/analytics';
import { useLoggedCollection, useWatchlist } from '@/features/collection/use-collection';
import { newOperationId } from '@/features/collection/writes';
import { SeasonPicker } from '@/features/search/SeasonPicker';
import { useTitleSearch, yearOf } from '@/features/search/use-title-search';
import { posterUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { compactName, type MediaKind } from '@/lib/titles';
import { Poster, SearchField, SectionHeader, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { addListItem } from './writes';

const ANALYTICS_KIND: Record<MediaKind, ListMediaKind> = {
  movie: 'movie',
  season: 'tv_season',
  series: 'tv_series',
};

type Candidate = {
  mediaItemId: string;
  kind: MediaKind;
  name: string;
  year: number | null;
  posterUri: string | null;
  /** Only a series opens the season picker; everything else is added on the tap. */
  seriesId?: string | null;
};

export type AddTitlesSheetProps = {
  listId: string;
  listTitle: string;
  viewerId: string;
  /** Everything already on the list, so a row can show a tick rather than a plus. */
  presentIds: ReadonlySet<string>;
  onClose: () => void;
};

/**
 * `+ Add titles`, from inside a list the caller owns (§G).
 *
 * ---------------------------------------------------------------------------
 * WHY IT OPENS ONTO SOMETHING RATHER THAN A BLANK SEARCH
 *
 * With an empty query this offers the caller's **Watchlist** and their **recently
 * watched**, which is where the titles for a list almost always come from: an Oscar
 * catch-up is made of things you have not seen, and a "best of" is made of things you
 * have. A blank field asks somebody to remember titles one at a time, which is the
 * slowest possible way to build a list of fourteen.
 *
 * ---------------------------------------------------------------------------
 * A SERIES OFFERS ITS SEASONS
 *
 * A list holds movies, seasons **and whole series** — unlike the log, where a series is
 * not a rankable unit (AD-1). So the season picker here is an *offer* rather than a
 * correction: tapping a series adds the series, and a second control opens its seasons
 * for somebody who meant one. That is the opposite of the Log screen's behaviour, and
 * deliberately so: there, picking a season is the only legal answer.
 *
 * The sheet stays open after every tap. Each one is one `add_list_item`.
 */
export function AddTitlesSheet({
  listId,
  listTitle,
  viewerId,
  presentIds,
  onClose,
}: AddTitlesSheetProps) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [seasonsFor, setSeasonsFor] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useTitleSearch(query);
  const watchlist = useWatchlist(viewerId);
  const logged = useLoggedCollection(viewerId);

  const searching = query.trim().length > 0;

  const searchRows = useMemo<Candidate[]>(
    () =>
      (search.results ?? []).map((row) => ({
        mediaItemId: row.id,
        kind: row.kind,
        name: compactName({ kind: row.kind, title: row.title }) ?? row.title,
        year: yearOf(row.release_date),
        posterUri: posterUri(row.poster_path, 'row'),
        seriesId: row.kind === 'series' ? row.id : null,
      })),
    [search.results],
  );

  const fromWatchlist = useMemo<Candidate[]>(
    () => (watchlist.data ?? []).slice(0, 20).map(toCandidate),
    [watchlist.data],
  );

  const recentlyWatched = useMemo<Candidate[]>(
    () =>
      (logged.data?.entries ?? [])
        .slice()
        // Newest first. The list somebody is building is usually about what they have
        // just been watching. `addedAt` rather than `watchedOn`, because an imported
        // history has dates from years ago and is not what "recently" means here.
        .sort((a, b) => String(b.addedAt ?? '').localeCompare(String(a.addedAt ?? '')))
        .slice(0, 20)
        .map(toCandidate),
    [logged.data],
  );

  const add = async (candidate: Candidate) => {
    setError(null);
    const result = await addListItem({
      operationId: newOperationId(),
      listId,
      mediaItemId: candidate.mediaItemId,
    });

    if (result.outcome !== 'failed' || result.changed) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.list(listId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.listItems(listId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.listProgress(listId) });
      void queryClient.invalidateQueries({ queryKey: ['my-lists'] });
      void queryClient.invalidateQueries({ queryKey: ['profile-lists'] });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.listsForTitle(candidate.mediaItemId),
      });
    }

    if (result.outcome === 'failed') {
      setError(result.message);
      return;
    }
    if (result.outcome === 'item_limit') {
      setError('This list is full.');
      return;
    }

    // Marked locally as well as invalidated, so the row's tick lands on the tap rather
    // than a round trip later — the sheet stays open and the next tap is immediate.
    setAdded((current) => new Set(current).add(candidate.mediaItemId));

    if (result.outcome === 'added') {
      track({
        name: 'list_item_added',
        props: {
          surface: 'list_add_sheet',
          media_kind: ANALYTICS_KIND[candidate.kind],
          count_after: result.countAfter,
        },
      });
    }
  };

  const isPresent = (id: string) => presentIds.has(id) || added.has(id);

  if (seasonsFor) {
    return (
      <SeasonPicker
        series={seasonsFor}
        onClose={() => setSeasonsFor(null)}
        onPick={(season) => {
          setSeasonsFor(null);
          void add({
            mediaItemId: season.id,
            kind: 'season',
            name:
              compactName({
                kind: 'season',
                title: season.title,
                seriesTitle: seasonsFor.title,
                seasonNumber: season.seasonNumber,
              }) ?? season.title,
            year: season.year,
            posterUri: posterUri(season.posterPath, 'row'),
          });
        }}
      />
    );
  }

  return (
    <Sheet visible onClose={onClose} label={`Add titles to ${listTitle}`}>
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text variant="callout" numberOfLines={1} style={styles.headerTitle}>
            Add to &ldquo;{listTitle}&rdquo;
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            hitSlop={theme.space[2]}
            onPress={onClose}
          >
            <Text variant="callout" tone="action">
              Done
            </Text>
          </Pressable>
        </View>

        <View style={styles.field}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="Search films and shows"
          />
        </View>

        {error ? (
          <Text variant="footnote" tone="secondary" accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.rows}>
          {searching ? (
            <Section
              title="Results"
              rows={searchRows}
              isPresent={isPresent}
              onAdd={add}
              onSeasons={setSeasonsFor}
              emptyLabel={search.isPending ? 'Searching…' : 'Nothing matches that yet.'}
            />
          ) : (
            <>
              <Section
                title="From your Watchlist"
                rows={fromWatchlist}
                isPresent={isPresent}
                onAdd={add}
                onSeasons={setSeasonsFor}
              />
              <Section
                title="Recently watched"
                rows={recentlyWatched}
                isPresent={isPresent}
                onAdd={add}
                onSeasons={setSeasonsFor}
              />
            </>
          )}
        </ScrollView>
      </View>
    </Sheet>
  );
}

function Section({
  title,
  rows,
  isPresent,
  onAdd,
  onSeasons,
  emptyLabel,
}: {
  title: string;
  rows: Candidate[];
  isPresent: (id: string) => boolean;
  onAdd: (candidate: Candidate) => Promise<void>;
  onSeasons: (series: { id: string; title: string }) => void;
  emptyLabel?: string;
}) {
  // A section with nothing in it and nothing to say about why is simply absent: an
  // account with an empty watchlist should not be shown a heading over a gap.
  if (rows.length === 0 && !emptyLabel) return null;

  return (
    <View>
      <SectionHeader title={title} />
      {rows.length === 0 ? (
        <Text variant="footnote" tone="secondary" style={styles.error}>
          {emptyLabel}
        </Text>
      ) : (
        rows.map((row) => (
          <CandidateRow
            key={row.mediaItemId}
            candidate={row}
            present={isPresent(row.mediaItemId)}
            onAdd={() => void onAdd(row)}
            onSeasons={
              row.kind === 'series' && row.seriesId
                ? () => onSeasons({ id: row.seriesId as string, title: row.name })
                : undefined
            }
          />
        ))
      )}
    </View>
  );
}

function CandidateRow({
  candidate,
  present,
  onAdd,
  onSeasons,
}: {
  candidate: Candidate;
  present: boolean;
  onAdd: () => void;
  onSeasons?: () => void;
}) {
  const detail = [candidate.year, KIND_LABEL[candidate.kind]].filter(Boolean).join(' · ');

  return (
    <View style={styles.row}>
      <Poster uri={candidate.posterUri} title={candidate.name} size="row" />

      <View style={styles.rowLines}>
        <Text variant="callout" numberOfLines={1}>
          {candidate.name}
        </Text>
        <Text variant="footnote" tone="tertiary">
          {detail}
        </Text>
      </View>

      {onSeasons ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Choose a season of ${candidate.name}`}
          hitSlop={theme.space[2]}
          onPress={onSeasons}
          style={styles.seasons}
        >
          <Text variant="footnote" tone="action">
            Seasons
          </Text>
        </Pressable>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: present }}
        accessibilityLabel={present ? `${candidate.name} is on this list` : `Add ${candidate.name}`}
        disabled={present}
        hitSlop={theme.space[2]}
        onPress={onAdd}
      >
        <Ionicons
          name={present ? 'checkmark' : 'add'}
          size={theme.layout.icon.md}
          color={present ? theme.text.tertiary : theme.semantic.action}
        />
      </Pressable>
    </View>
  );
}

const KIND_LABEL: Record<MediaKind, string> = {
  movie: 'Movie',
  season: 'Season',
  series: 'Series',
};

const toCandidate = (entry: {
  mediaItemId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  kind: MediaKind;
  seriesTitle: string | null;
  seasonNumber?: number | null;
}): Candidate => ({
  mediaItemId: entry.mediaItemId,
  kind: entry.kind,
  name:
    compactName({
      kind: entry.kind,
      title: entry.title,
      seriesTitle: entry.seriesTitle,
      seasonNumber: entry.seasonNumber,
    }) ?? entry.title,
  year: entry.year,
  posterUri: posterUri(entry.posterPath, 'row'),
  seriesId: null,
});

const styles = StyleSheet.create({
  sheet: { paddingBottom: theme.space[3], maxHeight: '100%' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    minHeight: theme.layout.minTapTarget,
  },
  headerTitle: { flex: 1 },
  field: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[2] },
  rows: { paddingBottom: theme.space[4] },
  error: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
    minHeight: theme.layout.minTapTarget,
  },
  rowLines: { flex: 1, gap: 2 },
  seasons: { paddingHorizontal: theme.space[2] },
});
