import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { quoted } from './RecommendationCard';
import { relativeTime } from './use-sent-to-you';
import type { TitleRecommendation } from './use-title-recommendations';

export type RecommendersSheetProps = {
  visible: boolean;
  rows: readonly TitleRecommendation[];
  onClose: () => void;
  /** iOS: the dismissal has finished, so a following sheet may present (`Sheet`). */
  onDismissed?: () => void;
  onOpenProfile: (username: string) => void;
  onReport: (recommendationId: string) => void;
};

/**
 * Everybody who recommended this title, newest first, with what each of them said.
 *
 * A list of context and nothing more — no reply, no reaction, no count of who has seen
 * it. A name opens that person's profile; a note can be reported with a long press (or
 * the row's accessibility action), which is the PRD §22 path for somebody's writing.
 */
export function RecommendersSheet({
  visible,
  rows,
  onClose,
  onDismissed,
  onOpenProfile,
  onReport,
}: RecommendersSheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose} onDismissed={onDismissed} label="Recommended by">
      <View style={styles.head}>
        <Text variant="headline">Recommended by</Text>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {rows.map((row) => {
          const report = row.message ? () => onReport(row.id) : undefined;
          return (
            <Pressable
              key={row.id}
              testID={`recommender-${row.id}`}
              accessibilityRole="button"
              accessibilityLabel={[
                `${row.senderName}, ${relativeTime(row.recommendedAt)}`,
                row.message ? quoted(row.message) : 'No note',
              ].join('. ')}
              accessibilityHint="Opens their profile"
              accessibilityActions={report ? [{ name: 'report', label: 'Report this note' }] : undefined}
              onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === 'report') report?.();
              }}
              onPress={() => onOpenProfile(row.senderUsername)}
              onLongPress={report}
              style={styles.row}
            >
              <Avatar uri={row.senderAvatarUri} name={row.senderName} size="sm" />
              <View style={styles.text}>
                <Text variant="callout" numberOfLines={1}>
                  {row.senderName}
                  <Text variant="footnote" tone="tertiary">
                    {` · ${relativeTime(row.recommendedAt)}`}
                  </Text>
                </Text>
                <Text variant="footnote" tone={row.message ? 'primary' : 'tertiary'}>
                  {row.message ? quoted(row.message) : 'No note'}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  list: { paddingBottom: theme.space[4] },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
  },
  text: { flex: 1, gap: 2 },
});
