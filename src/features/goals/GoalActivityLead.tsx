import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { theme } from '@/ui/tokens';

/**
 * A goal-completion row's leading slot (20260829000200).
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A MARK AT ALL, AND WHY IT IS THIS SMALL
 *
 * A goal activity has no poster, and the founder ruled one out explicitly: a film's
 * artwork on a row about a *year* would attribute the achievement to whichever title
 * happened to be last. The two other wrong answers are the ones `AwardActivityLead`
 * already records — a fake poster misrepresents the row, and `MissingArtwork` initials
 * of "2026 Movies goal" look like a broken catalogue entry.
 *
 * **The box, not the glyph, is what matters.** `ActivityRow`'s single left text edge
 * derives from the poster width and the actor chip positions against the lead's bounds,
 * so a lead of any other size would break the rhythm of every neighbouring row. This is
 * the same 40×60 box the award badge sits in, with a flag centred in it.
 *
 * **A flag rather than a trophy.** The trophy is the Leaderboard's glyph as of the
 * 2026-08-28 tranche, and reusing it here would quietly claim the two surfaces are the
 * same idea — a goal is a finish line somebody set for themselves, not a ranking against
 * other people. Restrained on purpose: the founder asked for a simple celebration
 * treatment and ruled out a second bespoke illustration system, so this is one glyph in
 * the app's own accent, and the 🎉 in the sentence carries the celebration.
 */
export function GoalActivityLead() {
  return (
    <View style={styles.box}>
      <Ionicons name="flag" size={theme.layout.icon.lg} color={theme.semantic.action} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: theme.poster.xs.width,
    height: theme.poster.xs.height,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
