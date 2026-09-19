import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { headlineOf, type TitleRecommendation } from './use-title-recommendations';
import { relativeTime } from './use-sent-to-you';

export type RecommendationCardProps = {
  rows: readonly TitleRecommendation[];
  /** Opens the list of everybody who recommended it. Offered only when there is more than one. */
  onOpenAll: () => void;
  /** Reports one note. Offered only on a recommendation that carries one. */
  onReport: (recommendationId: string) => void;
};

/** "Ada", "Ada and 1 other", "Ada and 2 others". */
export function attributionOf(rows: readonly TitleRecommendation[]): string | null {
  const lead = headlineOf(rows);
  if (!lead) return null;
  const others = rows.length - 1;
  const who = others > 0 ? `${lead.senderName} and ${others} ${others === 1 ? 'other' : 'others'}` : lead.senderName;
  return `${who} · ${relativeTime(lead.recommendedAt)}`;
}

/** A note as it is quoted on screen. */
export const quoted = (message: string) => `“${message}”`;

/**
 * Who recommended this title, and what they said, **below the title** (founder F1,
 * 2026-09-19).
 *
 * It used to be a one-line pill laid over the hero's lower edge, with an in-flow twin for
 * titles with no artwork. A note is up to 140 characters of somebody else's words, and the
 * founder's rule for this page — primary text never depends on being readable over a
 * backdrop nobody chose — applies to it with more force than to a name. So there is one
 * card, in the flow, after the identity block and its actions, for every title.
 *
 * Compact on purpose: one attribution line and at most three lines of note. With several
 * recommenders it leads with the newest note and says how many others there are; tapping
 * opens the list. It is not a conversation, and nothing here replies.
 */
export function RecommendationCard({ rows, onOpenAll, onReport }: RecommendationCardProps) {
  const lead = headlineOf(rows);
  if (!lead) return null;

  const several = rows.length > 1;
  const attribution = attributionOf(rows) ?? '';
  const note = lead.message;
  const label = note ? attribution : `Recommended by ${attribution}`;

  const report = note ? () => onReport(lead.id) : undefined;

  return (
    <Pressable
      testID="recommendation-card"
      accessibilityRole={several ? 'button' : 'text'}
      accessibilityLabel={[`Recommended by ${attribution}`, note ? quoted(note) : null]
        .filter(Boolean)
        .join('. ')}
      accessibilityHint={several ? 'Shows everyone who recommended this' : undefined}
      accessibilityActions={report ? [{ name: 'report', label: 'Report this note' }] : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'report') report?.();
      }}
      onPress={several ? onOpenAll : undefined}
      onLongPress={report}
      style={styles.card}
    >
      <View style={styles.head}>
        {note ? (
          <View style={styles.faces}>
            {rows.slice(0, several ? 2 : 1).map((row, index) => (
              <View key={row.id} style={index > 0 ? styles.stacked : undefined}>
                <Avatar uri={row.senderAvatarUri} name={row.senderName} size="xs" />
              </View>
            ))}
          </View>
        ) : (
          <Ionicons name="paper-plane" size={theme.layout.icon.sm} color={theme.semantic.action} />
        )}
        <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.label}>
          {label}
        </Text>
        {several ? (
          <Ionicons name="chevron-forward" size={theme.layout.icon.sm} color={theme.text.tertiary} />
        ) : null}
      </View>
      {note ? (
        <Text testID="recommendation-note" variant="callout" numberOfLines={3}>
          {quoted(note)}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: theme.space[2],
    paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[3],
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.raised,
    ...theme.elevation.e1,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  faces: { flexDirection: 'row' },
  // The second face tucks under the first, the way a stack of two reads at a glance.
  stacked: { marginLeft: -theme.space[2] },
  // Takes the width the faces and the chevron leave, so a long name truncates.
  label: { flex: 1 },
});
