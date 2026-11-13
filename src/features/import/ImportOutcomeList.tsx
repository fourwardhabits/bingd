import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { ImdbTitleType } from './imdb';
import type { OutcomeSection, OutcomeSectionId, OutcomeTitle } from './outcomes';

/**
 * One heading of the IMDb summary, by title (`outcomes.ts` says where each list comes from).
 *
 * **Collapsed when long, and capped while open.** The summary is one scroll view, and a list
 * nested inside a scroll view cannot virtualise, so the list is never drawn whole: the first
 * `COLLAPSED` titles, then *Show all N* (or, past `PAGE`, *Show 100 more of N*), drawing
 * `PAGE` at a time. A file with two thousand unmatched titles draws five rows until
 * somebody asks for more, and a hundred at a time after that.
 *
 * Nothing wraps into an ellipsis. A title is somebody's way of finding the thing again, and
 * a count is the number the summary is about; on a 320pt screen both wrap rather than
 * truncate.
 */

/** Rows drawn before *Show all*. A short list is drawn whole. */
export const COLLAPSED = 5;
/** Lists no longer than this are never collapsed: hiding one row behind a button is noise. */
export const COLLAPSE_ABOVE = 8;
/** Rows added per *Show more* once open. */
export const PAGE = 100;

/** The heading and the one-line reason, per section. */
export const SECTION_COPY: Record<OutcomeSectionId, { title: string; reason: string }> = {
  unmatched: {
    title: 'Couldn’t match',
    reason: 'We couldn’t find a confident match for these, so they weren’t added.',
  },
  tv: {
    title: 'TV shows (not added yet)',
    reason: 'We found these shows in bingd. TV shows from IMDb imports aren’t added yet.',
  },
  episodes: {
    title: 'Episodes',
    reason: 'bingd doesn’t track single episodes, so these weren’t added.',
  },
  other: {
    title: 'Other',
    reason: 'bingd doesn’t track these kinds of titles, like games or podcasts.',
  },
};

/** IMDb's type, in words, where it says more than the heading already does. */
const TYPE_WORDS: Partial<Record<ImdbTitleType, string>> = {
  tvminiseries: 'Mini-series',
  videogame: 'Video game',
  musicvideo: 'Music video',
  podcastseries: 'Podcast',
  podcastepisode: 'Podcast episode',
  other: 'Other type',
};

const label = (title: OutcomeTitle) =>
  title.year === null ? title.name : `${title.name} (${title.year})`;

function OutcomeRow({ title, section }: { title: OutcomeTitle; section: OutcomeSectionId }) {
  const type = title.titleType ? TYPE_WORDS[title.titleType] : undefined;
  const detail = [type, title.imdbId].filter(Boolean).join(' · ');
  const spoken = [
    title.name,
    title.year === null ? 'no year' : String(title.year),
    type,
    title.imdbId ? `IMDb ${title.imdbId}` : undefined,
    SECTION_COPY[section].title,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={spoken}
      testID={`outcome-row-${section}`}
    >
      <Text variant="body">{label(title)}</Text>
      {detail ? (
        <Text variant="footnote" tone="tertiary">
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

export function ImportOutcomeList({ section }: { section: OutcomeSection }) {
  const titles = section.titles;
  const long = titles !== null && titles.length > COLLAPSE_ABOVE;
  const [shown, setShown] = useState(long ? COLLAPSED : Number.POSITIVE_INFINITY);
  const copy = SECTION_COPY[section.id];

  if (titles === null) return null;
  const visible = titles.slice(0, shown);
  const rest = titles.length - visible.length;

  return (
    <View style={styles.section} testID={`outcome-${section.id}`}>
      <View style={styles.heading}>
        <Text variant="headline" accessibilityRole="header" style={styles.headingText}>
          {copy.title}
        </Text>
        <Text variant="headline" accessibilityLabel={`${section.count} titles`}>
          {section.count}
        </Text>
      </View>
      <Text variant="footnote" tone="tertiary">
        {copy.reason}
      </Text>
      <View style={styles.rows}>
        {visible.map((title) => (
          <OutcomeRow key={title.key} title={title} section={section.id} />
        ))}
      </View>
      {rest > 0 ? (
        <Button
          kind="tertiary"
          size="sm"
          label={
            // "Show all" only when one press really draws all of them.
            shown === COLLAPSED && titles.length <= PAGE
              ? `Show all ${titles.length}`
              : `Show ${Math.min(rest, PAGE)} more of ${titles.length}`
          }
          onPress={() => setShown((n) => (n === COLLAPSED ? PAGE : n + PAGE))}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.card,
    padding: theme.space[4],
    gap: theme.space[2],
  },
  heading: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space[3] },
  headingText: { flex: 1 },
  rows: { gap: theme.space[3], marginTop: theme.space[1] },
  row: { gap: theme.space[1] },
});
