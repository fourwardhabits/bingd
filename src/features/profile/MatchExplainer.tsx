import { Pressable, StyleSheet, View } from 'react-native';

import { Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { TasteMatchLine } from './use-taste-match';

export type MatchExplainerProps = {
  visible: boolean;
  onClose: () => void;
  line: TasteMatchLine;
};

/**
 * What Match and shared mean, in the reader's own words back at them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LINE NEEDED SOMETHING BEHIND IT
 *
 * `89% Match · 42 shared` is two numbers in a row, and the founder's §3 instruction is
 * that a compact treatment has to stay compact — so the profile cannot carry the
 * sentence that says what either number is. Without one, the pair reads as a score out
 * of a hundred beside a quantity of something unnamed, and the most natural wrong guess
 * is that "shared" means titles you both *watched*. It does not: it is titles you have
 * both **ranked**, which is a much smaller and much more deliberate set, and the whole
 * reason the Match is worth anything.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE COPY DELIBERATELY DOES NOT SAY
 *
 * No formula, no Spearman, no shrinkage, no "we blend proximity with rank agreement".
 * The founder ruled all of it out by name and the reason is not squeamishness about
 * mathematics: a person deciding whether to trust a recommendation needs to know **what
 * was measured**, not how. "How similarly you and Ravi rate titles you've both ranked"
 * is the whole of what the number means; the second sentence — more shared titles makes
 * it more reliable — is the only property of the method a reader can act on, and they
 * act on it by ranking more, not by understanding the shrink.
 *
 * ---------------------------------------------------------------------------
 * THE NUDGE, WHICH IS ONLY SOMETIMES TRUE
 *
 * `explanation.nudge` is present in exactly one branch: the other account has ranked
 * plenty and the reader has not. That is the only case where "rank a few more titles"
 * is advice rather than a guess — when the *subject* is the short side, nothing the
 * reader ranks can reach the threshold, and telling them otherwise sends them off to do
 * work that will not change the screen. It is absent in every other case rather than
 * softened, because a nudge that is wrong a third of the time teaches people to ignore
 * all of them.
 */
export function MatchExplainer({ visible, onClose, line }: MatchExplainerProps) {
  return (
    <Sheet visible={visible} onClose={onClose} label="About Match">
      <View style={styles.body}>
        <Section title="Match" body={line.explanation.match} />
        <Section title="Shared" body={line.explanation.shared} />
        {/* Absent rather than replaced by a reassurance. There is nothing true to put
            here in the other branches, and the sheet is short enough to end. */}
        {line.explanation.nudge ? (
          <Text variant="footnote" tone="secondary">
            {line.explanation.nudge}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.section}>
      {/* The heading is the word from the line above it, spelled the same way, so the
          reader can see which half of `89% Match · 42 shared` each paragraph is about
          without the sheet having to repeat the line. */}
      <Text variant="footnote" tone="tertiary" style={styles.heading}>
        {title.toUpperCase()}
      </Text>
      <Text variant="callout">{body}</Text>
    </View>
  );
}

/**
 * The line itself, as a control.
 *
 * A `Pressable` around the text rather than an info icon beside it. The founder offered
 * either; the whole line is the better target because it is already the thing the reader
 * is looking at and it is wide, where a 16pt glyph in a row of two numbers is both a new
 * mark on a screen the founder asked to keep restrained and a hit area that needs its own
 * `hitSlop` to be reachable.
 *
 * `accessibilityHint` rather than a visible affordance, for the same reason: a chevron or
 * an underline would say "tappable" to everyone, permanently, in exchange for nothing a
 * reader who does not care needs to know.
 */
export function MatchLine({ line, onPress }: { line: TasteMatchLine; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={line.label}
      accessibilityHint="Explains Match and shared titles"
      onPress={onPress}
      hitSlop={theme.space[2]}
      style={({ pressed }) => [pressed && styles.pressed]}
    >
      {/* Maroon for a number, tertiary grey for the absence — the same pair the line has
          used since it moved under the handle. A `Match TBD` in the app's loudest colour
          would give an absence of evidence the emphasis a result has earned. */}
      <Text
        variant="footnote"
        tone={line.kind === 'match' ? 'action' : 'tertiary'}
        numberOfLines={1}
      >
        {line.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { gap: theme.space[5], paddingBottom: theme.space[2] },
  section: { gap: theme.space[1] },
  heading: { letterSpacing: 0.6 },
  pressed: { opacity: 0.6 },
});
