import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { MentionCandidate } from './use-mentions';

/**
 * The list that appears over the composer while somebody is typing a name.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY NOT A PICKER
 *
 * The founder's instruction was explicit — use the existing comment field, do not build
 * a separate People picker — and this is what that means in practice: no modal, no
 * search box, no Done. It is a strip of rows that sits above the field the reader is
 * already typing in, and choosing one puts text in that field. Everything else about
 * the composer is untouched.
 *
 * **Above, never below.** The composer is the last thing on both surfaces, with the
 * keyboard under it; a list drawn beneath it would be off-screen exactly when it is
 * needed. Capped at four rows' height and scrollable past that, so a long list does not
 * push the conversation off the top of a sheet that is already sharing the screen with
 * a keyboard.
 *
 * `keyboardShouldPersistTaps` on its own scroller as well as on the thread's: a tap on
 * a row while the field has focus must land on the row, not be spent dismissing the
 * keyboard — which would close the list and drop the tap.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT SHOWN
 *
 * Avatar, display name, handle — the founder's three, in the order every other person
 * row in this app uses. Not shown: whether they are a participant or a follow. It
 * decides the *order* (`mention_candidates` sorts participants first, because in a
 * conversation the person you are answering is usually already in it) and saying it out
 * loud would be a taxonomy lesson in the middle of typing a sentence.
 *
 * The empty state is nothing at all rather than "No matches". A strip that appears to
 * say it has nothing is worse than one that stays away — the reader is mid-word, and
 * the useful signal is the list appearing when there *is* somebody.
 */

export type MentionSuggestionsProps = {
  candidates: MentionCandidate[];
  loading: boolean;
  onChoose: (candidate: MentionCandidate) => void;
};

export function MentionSuggestions({ candidates, loading, onChoose }: MentionSuggestionsProps) {
  // Nothing while the first fragment is in flight either: a spinner over a keyboard for
  // one round trip is motion nobody asked for, and the rows arrive on their own.
  if (candidates.length === 0) {
    if (!loading) return null;
    return null;
  }

  return (
    <View style={styles.wrap} testID="mention-suggestions">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={styles.scroll}
        contentContainerStyle={styles.content}
      >
        {candidates.map((candidate) => (
          <Pressable
            key={candidate.id}
            accessibilityRole="button"
            accessibilityLabel={`Mention ${candidate.name}, at ${candidate.username}`}
            onPress={() => onChoose(candidate)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Avatar size="xs" uri={candidate.avatarUri} name={candidate.name} />
            <View style={styles.copy}>
              <Text variant="callout" numberOfLines={1}>
                {candidate.name}
              </Text>
              <Text variant="caption" tone="tertiary" numberOfLines={1}>
                @{candidate.username}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/** Four rows, which is as much of the screen as a transient strip may take. */
const ROW_HEIGHT = theme.layout.minTapTarget;

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  scroll: { maxHeight: ROW_HEIGHT * 4 },
  content: { paddingVertical: theme.space[1] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: ROW_HEIGHT,
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[1],
  },
  // The name and the handle share a column so a long display name truncates rather than
  // pushing the handle out of the row.
  copy: { flex: 1 },
  // The same value the comment rows above it press to, so the strip is visibly the
  // same surface rather than a different control that happens to be nearby.
  pressed: { opacity: 0.7 },
});
