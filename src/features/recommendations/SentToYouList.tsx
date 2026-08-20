import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import { Text, TitleRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { relativeTime, type SentRecommendation } from './use-sent-to-you';

export type SentToYouListProps = {
  rows: SentRecommendation[];
  /** Media item ids on the viewer's watchlist. */
  saved: ReadonlySet<string>;
  busyId: string | null;
  onOpen: (row: SentRecommendation) => void;
  onToggleSave: (row: SentRecommendation) => void;
};

/**
 * `Sent to you`, as a list rather than a wall.
 *
 * For You is a poster wall because artwork is the whole proposition there: nothing on
 * it carries a reason worth reading, so the picture is the argument. Here the two
 * primary facts are *who* sent it and *when*, and neither is a picture. A wall would
 * put both of them under the tile in caption type, or leave them off — and a
 * recommendation with the sender left off is just a recommendation.
 *
 * So the poster is the thumbnail and the sentence is the row. The sender's name is
 * text on the line under the title and never drawn over the artwork, which was the
 * founder's explicit constraint.
 */
export function SentToYouList({ rows, saved, busyId, onOpen, onToggleSave }: SentToYouListProps) {
  return (
    <View>
      {rows.map((row) => {
        const name = compactName(row) ?? row.title;
        const isSaved = saved.has(row.mediaItemId);
        const unopened = !row.openedAt;

        return (
          <View
            key={row.id}
            style={[styles.wrap, unopened && styles.unopened]}
            testID={unopened ? `sent-unopened-${row.mediaItemId}` : undefined}
          >
            <TitleRow
              title={name}
              year={row.year}
              posterUri={posterUri(row.posterPath, 'row')}
              // Two facts, one line, sender first — which is the order somebody reads
              // it in: whose recommendation is this, and how recent.
              secondary={`${row.senderName} recommended this · ${relativeTime(row.recommendedAt)}`}
              tertiary={metadataFor(row)}
              trailing={
                <View style={styles.trailing}>
                  {unopened ? (
                    <View
                      style={styles.dot}
                      accessibilityElementsHidden
                      importantForAccessibility="no"
                    />
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      isSaved
                        ? `Remove ${name} from your watchlist`
                        : `Add ${name} to your watchlist`
                    }
                    accessibilityState={{ selected: isSaved, disabled: busyId === row.mediaItemId }}
                    disabled={busyId === row.mediaItemId}
                    hitSlop={theme.space[2]}
                    onPress={() => onToggleSave(row)}
                  >
                    <Ionicons
                      name={isSaved ? 'bookmark' : 'bookmark-outline'}
                      size={theme.layout.icon.md}
                      color={isSaved ? theme.semantic.action : theme.text.tertiary}
                    />
                  </Pressable>
                </View>
              }
              divided
              onPress={() => onOpen(row)}
            />
            {/* The unread state said in words as well as in colour, for anybody who
                cannot see the tint or the dot. The same three-signal rule the inbox
                and the score system follow. */}
            {unopened ? (
              <Text style={styles.srOnly} accessibilityElementsHidden={false}>
                New
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/**
 * The third line: what the thing is, from what the catalogue actually has.
 *
 * Built before it is rendered rather than rendered with empty parts, because a title
 * with no genres and no runtime would otherwise draw an empty line box — the same
 * defect review 17e found under the title heading.
 */
function metadataFor(row: SentRecommendation): string | null {
  const parts = [
    row.kind === 'season' ? 'Season' : null,
    row.genres.slice(0, 2).join(' · ') || null,
    row.runtimeMinutes ? `${row.runtimeMinutes}m` : null,
  ].filter(Boolean);

  return parts.length ? parts.join(' · ') : null;
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  unopened: { backgroundColor: theme.surface.raised },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.semantic.action,
  },
  // Present to a screen reader, absent to the eye: the tint and the dot already say
  // this, and a visible "New" badge on every row would compete with the sender's name
  // for the one line that matters.
  srOnly: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -1, top: -1 },
});
