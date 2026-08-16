import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';

import { fontFamily, theme } from '../tokens';
import { Avatar } from './Avatar';
import { Poster } from './Poster';
import { ScoreBadge } from './ScoreBadge';
import { Text } from './Text';

export type ActivityRowProps = {
  actorName: string;
  actorAvatarUri?: string | null;
  /** The verb between the actor and the title: "ranked", "watched", "finished". */
  verb: string;
  title: string | null;
  year?: number | null;
  posterUri?: string | null;
  /** `148m · Sci-fi`, beneath the title inside the card. */
  metadata?: string | null;
  score?: number | null;
  bucket?: Bucket | null;
  note?: string | null;
  timeLabel: string;
  onPressTitle: () => void;
  onPressWatchlist?: () => void;
  inWatchlist?: boolean;
};

/**
 * One activity, as a divider-separated row (screens.md §7).
 *
 * Not a card. Three cards stacked with gaps put more chrome on screen than
 * content and read as a list of notifications rather than a stream of things
 * people did. Removing the border also removes the double-surface problem, where
 * a raised card holds a poster that then needs its own hairline to separate
 * from it.
 *
 * Beli's feed items are carried by food photography and Bingd has no equivalent:
 * every activity would show the same official poster. So the poster is small and
 * the score badge does the work of giving each row something distinct to look at.
 */
export function ActivityRow({
  actorName,
  actorAvatarUri,
  verb,
  title,
  year,
  posterUri,
  metadata,
  score,
  bucket,
  note,
  timeLabel,
  onPressTitle,
  onPressWatchlist,
  inWatchlist = false,
}: ActivityRowProps) {
  const [expanded, setExpanded] = useState(false);
  const filmName = title ?? 'a title';

  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Avatar size="sm" uri={actorAvatarUri} name={actorName} />
        {/* Bolded entities inside one sentence, which is Beli's treatment and
            what makes the row scannable without a separate header line. */}
        <Text variant="body" style={styles.sentence}>
          <Text variant="body" style={styles.entity}>
            {actorName}
          </Text>
          {` ${verb} `}
          <Text variant="body" style={styles.entity}>
            {filmName}
          </Text>
        </Text>
      </View>

      <View style={styles.body}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[filmName, year, metadata].filter(Boolean).join(', ')}
          onPress={onPressTitle}
          style={({ pressed }) => [styles.card, pressed && styles.pressed]}
        >
          {/* The title, never the sentence. Poster derives its placeholder
              initials from whatever it is given, so passing the sentence in
              rendered "Someone ranked a title." as a confident-looking SR. */}
          <Poster uri={posterUri} title={filmName} size="xs" />
          <View style={styles.cardCopy}>
            <Text variant="callout" numberOfLines={1}>
              {filmName}
              {year ? (
                <Text variant="callout" tone="secondary">
                  {'  '}
                  {year}
                </Text>
              ) : null}
            </Text>
            {metadata ? (
              <Text variant="footnote" tone="secondary" numberOfLines={1}>
                {metadata}
              </Text>
            ) : null}
          </View>
        </Pressable>

        {score != null && bucket ? <ScoreBadge score={score} bucket={bucket} size="sm" /> : null}
      </View>

      {note ? (
        <Pressable
          accessibilityRole={expanded ? undefined : 'button'}
          accessibilityLabel={expanded ? undefined : 'Show the whole note'}
          onPress={() => setExpanded(true)}
          disabled={expanded}
        >
          <Text variant="body" tone="secondary" numberOfLines={expanded ? undefined : 2}>
            {note}
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.actions}>
        {onPressWatchlist ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: inWatchlist }}
            accessibilityLabel={
              inWatchlist ? `${filmName} is in your watchlist` : `Add ${filmName} to your watchlist`
            }
            onPress={onPressWatchlist}
            hitSlop={theme.space[2]}
            style={styles.action}
          >
            <Ionicons
              name={inWatchlist ? 'bookmark' : 'bookmark-outline'}
              size={theme.layout.icon.sm}
              color={theme.semantic.action}
            />
            <Text variant="footnote" tone="action">
              {inWatchlist ? 'Saved' : 'Watchlist'}
            </Text>
          </Pressable>
        ) : null}

        {/* No comment affordance. Comments are deferred (PRD §14), and a
            disabled comment icon is worse than none. */}
        <Text variant="footnote" tone="tertiary" style={styles.time}>
          {timeLabel}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    gap: theme.space[2],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  sentence: { flex: 1 },
  entity: { fontFamily: fontFamily.sansSemibold },
  body: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  card: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.compactRow,
  },
  cardCopy: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space[4] },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget,
  },
  time: { flex: 1, textAlign: 'right' },
  pressed: { opacity: 0.7 },
});
