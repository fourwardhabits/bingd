import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type ReactionSummaryProps = {
  /** Up to three glyphs, the viewer's own first (`clusterKinds`). */
  glyphs: string[];
  /**
   * Every way of saying who reacted, longest first, ending in the bare aggregate
   * (`summaryForms`). The first is also what a screen reader hears, whatever fits.
   */
  forms: string[];
  /** Opens the reactor list. Absent, the line is read but not pressed. */
  onPress?: () => void;
  /** Margins, not padding: the line measures its own frame, so padding would count as room for text. */
  style?: StyleProp<ViewStyle>;
  /** On the pressable line; the outer, measured view gets `${testID}-line`. */
  testID?: string;
};

/**
 * "❤️😂 Priya and 3 others like this" — the line under a post (founder, 2026-11-10).
 *
 * One component for the Feed card, the conversation page and the profile, so the three
 * cannot phrase the same reactions three ways.
 *
 * **The sentence is chosen by width, not by a character limit.** The outer view takes
 * the width its parent gives it and measures that on layout; each form is estimated at
 * `footnote`'s size times the system font scale (`fitSummaryForm`), and the longest that
 * fits is drawn. So
 * a narrow phone, a long name or a large accessibility size steps down to a shorter
 * form — the name without "like this", then a first name, then "72 likes" — rather than
 * wrapping onto a second line or running under the score and timestamp beside it. The
 * text is still clamped to one line, so an estimate that errs can only truncate.
 */
export function ReactionSummary({ glyphs, forms, onPress, style, testID }: ReactionSummaryProps) {
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState<number | null>(null);

  if (!forms.length) return null;

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  const textBudget = width == null ? null : width - clusterWidth(glyphs.length) - GAP;
  const text = fitSummaryForm(forms, textBudget, theme.typography.footnote.fontSize * fontScale);
  const label = `${forms[0]}. See who reacted.`;

  const content = (
    <>
      {glyphs.length ? (
        <View
          style={styles.glyphs}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {glyphs.map((glyph, index) => (
            <View key={glyph} style={[styles.glyphBox, index > 0 && styles.glyphOverlap]}>
              <Text variant="footnote" allowFontScaling={false} style={styles.glyph}>
                {glyph}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text
        variant="footnote"
        tone="secondary"
        numberOfLines={1}
        ellipsizeMode="tail"
        style={styles.text}
        testID={testID ? `${testID}-text` : undefined}
      >
        {text}
      </Text>
    </>
  );

  return (
    <View
      style={[styles.measure, style]}
      onLayout={onLayout}
      testID={testID ? `${testID}-line` : undefined}
    >
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onPress}
          hitSlop={{ top: SLOP, bottom: SLOP }}
          style={({ pressed }) => [styles.summary, pressed && styles.pressed]}
          testID={testID}
        >
          {content}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={forms[0]} style={styles.summary} testID={testID}>
          {content}
        </View>
      )}
    </View>
  );
}

/**
 * Inter's mean advance for mixed-case English, as a fraction of the font size. From
 * Inter's metrics: lowercase runs average about 0.52em and a capitalised name about
 * 0.6em, so 0.56 errs a little long — erring costs one step shorter a sentence than
 * strictly needed, never an overlap.
 */
export const AVERAGE_ADVANCE = 0.56;

/** `text`'s estimated width at `fontSize`, which the caller has already multiplied by the font scale. */
export const estimateTextWidth = (text: string, fontSize: number) =>
  // Spread rather than `.length`, so a surrogate pair in a name counts once.
  [...text].length * fontSize * AVERAGE_ADVANCE;

/**
 * The longest form that fits `width`, or the shortest when none does — which is still
 * drawn on one line with tail truncation, so a very large font scale shortens rather
 * than wraps.
 *
 * Before the first layout there is no width and the longest form is drawn; the line
 * measures on its first frame and steps down from there.
 */
export function fitSummaryForm(forms: readonly string[], width: number | null, fontSize: number) {
  if (!forms.length) return '';
  if (width == null) return forms[0];
  return (
    forms.find((form) => estimateTextWidth(form, fontSize) <= width) ?? forms[forms.length - 1]
  );
}

/** The cluster's glyph size: one step under the 17pt action slot, so it reads as a summary. */
const GLYPH_SIZE = 15;
/** Taller than a 15pt colour emoji's ~1.17em, so nothing is clipped — `ReactionControl`'s rule. */
const GLYPH_BOX = 20;
const OVERLAP = 3;
const GAP = theme.space[2];
/** 32pt of line plus 6pt either side: the 44pt floor, without growing the line. */
const MIN_HEIGHT = 32;
const SLOP = (theme.layout.minTapTarget - MIN_HEIGHT) / 2;

/** A colour emoji's advance is about 1.2em; glyphs are not font-scaled, so this is fixed. */
const clusterWidth = (count: number) =>
  count ? count * Math.ceil(GLYPH_SIZE * 1.2) - (count - 1) * OVERLAP : -GAP;

const styles = StyleSheet.create({
  measure: { alignSelf: 'stretch' },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    gap: GAP,
    minHeight: MIN_HEIGHT,
  },
  glyphs: { flexDirection: 'row', alignItems: 'center' },
  glyphBox: { height: GLYPH_BOX, alignItems: 'center', justifyContent: 'center' },
  glyphOverlap: { marginLeft: -OVERLAP },
  glyph: {
    fontSize: GLYPH_SIZE,
    lineHeight: undefined,
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  text: { flexShrink: 1, includeFontPadding: false },
  pressed: { opacity: 0.7 },
});
