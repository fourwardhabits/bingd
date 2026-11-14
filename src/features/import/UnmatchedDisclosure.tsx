import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Disclosure, MediumSelector, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { imdbKind, type ImdbTitleType } from './imdb';
import type { OutcomeTitle } from './outcomes';
import { QUIET_SLOP } from './PreviewSummary';

/** Rows drawn when the list opens, and added by each *Show more*. */
export const UNMATCHED_PAGE = 50;

export const UNMATCHED_REASON =
  'We couldn’t find a confident match for these, so they weren’t added.';
export const UNMATCHED_UNAVAILABLE = 'Details aren’t available for this import.';
export const UNMATCHED_LOADING = 'Getting the list…';

/** IMDb's own type, in its own words, for a row whose type the parse knows. */
const TYPE_WORDS: Record<ImdbTitleType, string> = {
  movie: 'Movie',
  tvmovie: 'TV Movie',
  video: 'Video',
  short: 'Short',
  tvshort: 'TV Short',
  tvspecial: 'TV Special',
  tvseries: 'TV Series',
  tvminiseries: 'TV Mini Series',
  tvepisode: 'TV Episode',
  videogame: 'Video Game',
  musicvideo: 'Music Video',
  podcastseries: 'Podcast Series',
  podcastepisode: 'Podcast Episode',
  other: 'Other type',
};

type Medium = 'movies' | 'tv';
const MEDIUMS = [
  { id: 'movies', label: 'Movies' },
  { id: 'tv', label: 'TV shows' },
] as const satisfies readonly { id: Medium; label: string }[];

const mediumOf = (title: OutcomeTitle): Medium | null => {
  if (title.titleType === null) return null;
  const kind = imdbKind(title.titleType);
  return kind === 'movie' ? 'movies' : kind === 'series' ? 'tv' : null;
};

/**
 * Whether the list may be split by medium: only when **every** row's type is known from
 * this session's parse of the file (`outcomes.ts`), and both media are present. One row of
 * unknown type would have to be put in one list or the other on a guess, so then there is
 * one list. Exported for tests.
 */
export function splitByMedium(titles: readonly OutcomeTitle[]): boolean {
  const media = titles.map(mediumOf);
  return (
    media.length > 0 &&
    media.every((medium) => medium !== null) &&
    media.includes('movies') &&
    media.includes('tv')
  );
}

/**
 * The results card's *Unmatched* row, which opens to the titles behind it (IMP1113-UI §D).
 *
 * The count is the server's (`resultModel`), drawn whether or not a list can be. The list is
 * the job's own kept rows (`useUnresolvedRows`), joined to this session's parse for an IMDb
 * id and type where exactly one parsed title has that name and year, and shown only when it
 * has exactly as many titles as the count (`buildImdbOutcomes`). Otherwise the row opens
 * to a sentence saying the details are not available, and the count stands on its own.
 *
 * **Paged, never virtualised.** The results are one scroll view, and a list nested in a
 * scroll view cannot virtualise, so the list draws `UNMATCHED_PAGE` rows and *Show more*
 * draws the next page. A file with thousands of unmatched titles draws fifty.
 */
export function UnmatchedDisclosure({
  count,
  titles,
  loading,
}: {
  count: number;
  /** Exactly `count` titles, or null when none can be shown that add up. */
  titles: readonly OutcomeTitle[] | null;
  /** The rows are still being read. */
  loading: boolean;
}) {
  return (
    <Disclosure
      label="Unmatched"
      trailing={String(count)}
      trailingLabel={count === 1 ? '1 title' : `${count} titles`}
      testID="result-unmatched"
    >
      <View style={styles.content}>
        <Text variant="footnote" tone="tertiary">
          {UNMATCHED_REASON}
        </Text>
        {loading ? (
          <Text variant="footnote" tone="secondary">
            {UNMATCHED_LOADING}
          </Text>
        ) : titles === null ? (
          <Text variant="footnote" tone="secondary" testID="unmatched-unavailable">
            {UNMATCHED_UNAVAILABLE}
          </Text>
        ) : (
          <UnmatchedList titles={titles} />
        )}
      </View>
    </Disclosure>
  );
}

function UnmatchedList({ titles }: { titles: readonly OutcomeTitle[] }) {
  const split = splitByMedium(titles);
  const [medium, setMedium] = useState<Medium>('movies');
  const [shown, setShown] = useState(UNMATCHED_PAGE);

  const list = split ? titles.filter((title) => mediumOf(title) === medium) : titles;
  const visible = list.slice(0, shown);
  const rest = list.length - visible.length;

  return (
    <View style={styles.listBlock}>
      {split ? (
        <MediumSelector<Medium>
          value={medium}
          onChange={(next) => {
            setMedium(next);
            setShown(UNMATCHED_PAGE);
          }}
          options={MEDIUMS}
          size="filter"
          accessibilityHint="Choose which unmatched titles to show"
          testID="unmatched-medium"
        />
      ) : null}
      <View style={styles.rows} testID="unmatched-list">
        {visible.map((title) => (
          <UnmatchedRow key={title.key} title={title} />
        ))}
      </View>
      {rest > 0 ? (
        <View style={styles.more}>
          <Button
            kind="tertiary"
            size="sm"
            hitSlop={QUIET_SLOP}
            label={`Show more (${rest} left)`}
            onPress={() => setShown((n) => n + UNMATCHED_PAGE)}
            testID="unmatched-more"
          />
        </View>
      ) : null}
    </View>
  );
}

function UnmatchedRow({ title }: { title: OutcomeTitle }) {
  const type = title.titleType ? TYPE_WORDS[title.titleType] : undefined;
  const detail = [type, title.imdbId].filter(Boolean).join(' · ');
  const spoken = [
    title.name,
    title.year === null ? 'no year' : String(title.year),
    type,
    title.imdbId ? `IMDb ${title.imdbId}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');

  // Nothing truncates: a title is somebody's way of finding the thing again, so on a
  // narrow screen at a large text size it wraps.
  return (
    <View style={styles.row} accessible accessibilityLabel={spoken} testID="unmatched-row">
      <Text variant="body">
        {title.year === null ? title.name : `${title.name} (${title.year})`}
      </Text>
      {detail ? (
        <Text variant="footnote" tone="tertiary">
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: theme.space[3], paddingBottom: theme.space[2] },
  listBlock: { gap: theme.layout.section.controlsToContent },
  rows: { gap: theme.space[3] },
  row: { gap: theme.space[1] },
  more: { alignItems: 'flex-start' },
});
