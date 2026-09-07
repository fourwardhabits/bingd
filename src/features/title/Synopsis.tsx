import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * How many lines the collapsed synopsis takes. Four is the founder's number.
 *
 * It is also a hard ceiling and not only a target: the visible `Text` carries
 * `numberOfLines={COLLAPSED_LINES}`, so whatever the measurement concludes, the block
 * cannot become five lines tall. The measurement decides how much prose to keep; the
 * clamp decides that it cannot be wrong in the direction that matters.
 */
export const COLLAPSED_LINES = 4;

/** The word, and the space that separates it from the prose it follows. */
const MORE = 'more';

/**
 * The title page's overview, clamped to four lines with `more` **on the fourth**.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS REPLACES
 *
 * `more` was a second `Text` under the prose. So a synopsis that filled its clamp put
 * the word on a line of its own — three full lines, four words, then a lone `more` — and
 * the block spent a whole line of the page saying one word. It also pushed the genres
 * away from the paragraph they belong beside, which is what made the founder read the
 * page as a stack of bands rather than as a column of prose.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS MEASURED AND NOT COUNTED
 *
 * The obvious implementation is to cut the string at N characters. It is wrong at every
 * width and at every text size: the font is not monospaced, the phone is not one width,
 * and the reader's type scale is theirs to set — so a constant that is right on the
 * founder's device is a wrapped `more` on a 320pt screen and a half-empty line at 130%.
 *
 * So the component measures, in two invisible passes laid out at the same width as the
 * visible text:
 *
 *   1. the **whole** synopsis, unclamped, which reports one entry per line with that
 *      line's own text and width (`onTextLayout`);
 *   2. the **marker** — ` … more` — which reports the width the fourth line has to
 *      reserve for it.
 *
 * With those, the fourth line is trimmed to a word boundary that leaves room for the
 * marker, and the marker is drawn as a span *inside the same `Text`* rather than under
 * it. Being inside the clamp is what makes the guarantee structural: React Native cannot
 * put it on a fifth line, because there is no fifth line.
 *
 * The per-character width used for the trim is derived from the fourth line's *own*
 * measured width and its own character count, so it is that string, in that font, at
 * that text size — not an average of the alphabet.
 *
 * ---------------------------------------------------------------------------
 * WHAT HAPPENS BEFORE THE MEASUREMENT LANDS, AND IF IT NEVER DOES
 *
 * The visible text is the full synopsis under `numberOfLines={4}`, which is what the
 * screen drew before this component existed: React Native's own ellipsis, no marker.
 * That is the honest unmeasured state — it is never wrong, it is only less inviting —
 * and the whole block has always been the press target, so a reader can still open it.
 * The marker appears when the measurement answers, one frame later.
 *
 * A synopsis that already fits in four lines shows no marker at all and never will,
 * which is the other half of the contract.
 */
export function Synopsis({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  /** One entry per line of the *whole* synopsis, from the measuring pass. */
  const [lines, setLines] = useState<{ text: string; width: number }[] | null>(null);
  /** How wide ` … more` sets, from its own pass. */
  const [markerWidth, setMarkerWidth] = useState<number | null>(null);
  /** The block's own width, which is what the fourth line has to fit inside. */
  const [available, setAvailable] = useState<number | null>(null);

  const collapsed = collapse({ lines, markerWidth, available });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={expanded ? 'Collapse description' : 'Expand description'}
      onPress={() => setExpanded((open) => !open)}
      style={styles.block}
    >
      {/**
       * The gutter is on the `Pressable` and the measurement is on this, which is not a
       * spare view.
       *
       * `available` has to be the width the *text* sets in, and a layout read off the
       * padded box would be a gutter's worth too wide — so the fourth line would be given
       * 32 points of room it does not have and `more` would be pushed off the end of it,
       * which is the exact defect this component exists to prevent. Measuring an unpadded
       * child gives the text's own width, and it is also what the absolute measuring
       * layer below spans, so both passes measure the same column.
       */}
      <View
        testID="synopsis-column"
        onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}
      >
        {/* The two measuring passes. Off the flow, invisible, and hidden from assistive
            technology so the synopsis is not announced three times. They unmount as soon
            as they have answered — a pass that stayed would re-measure on every layout. */}
        {lines == null || markerWidth == null ? (
          <View
            style={styles.measure}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {lines == null ? (
              <Text
                testID="synopsis-measure"
                variant="body"
                onTextLayout={(event: NativeSyntheticEvent<TextLayoutEventData>) =>
                  setLines(
                    event.nativeEvent.lines.map((line) => ({
                      text: line.text,
                      width: line.width,
                    })),
                  )
                }
              >
                {text}
              </Text>
            ) : null}
            {markerWidth == null ? (
              <Text
                testID="synopsis-marker-measure"
                variant="body"
                onTextLayout={(event: NativeSyntheticEvent<TextLayoutEventData>) =>
                  setMarkerWidth(event.nativeEvent.lines[0]?.width ?? 0)
                }
              >
                {` … ${MORE}`}
              </Text>
            ) : null}
          </View>
        ) : null}

        <Text variant="body" numberOfLines={expanded ? undefined : COLLAPSED_LINES}>
          {expanded || !collapsed ? text : collapsed.prose}
          {/* No "less" once it is open: the whole thing is visible and the control has
              nothing left to promise. The app already sets that convention on the episode
              synopsis, which borrowed it from here.

              **Inside the clamped `Text`, not under it.** That is the guarantee: React
              Native cannot put this span on a fifth line, because `numberOfLines` has not
              given the block one. The trim above is what stops it being clipped instead. */}
          {!expanded && collapsed ? (
            <Text testID="synopsis-more" variant="body" tone="action">
              {` … ${MORE}`}
            </Text>
          ) : null}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * What the collapsed state should draw, or `null` for "nothing to collapse".
 *
 * Exported for its own tests: this is the arithmetic the whole component is about, and
 * it is easier to be sure of over a table of line widths than through a render.
 *
 * Returns `null` — meaning *draw the plain text with no marker* — in three cases that
 * are genuinely one: the measurement has not landed, or the synopsis already fits in
 * the clamp, or the fourth line is missing from what was measured. In each of them
 * there is no honest fourth line to trim.
 */
export function collapse({
  lines,
  markerWidth,
  available,
}: {
  lines: { text: string; width: number }[] | null;
  markerWidth: number | null;
  available: number | null;
}): { prose: string } | null {
  if (!lines || markerWidth == null || available == null) return null;
  if (lines.length <= COLLAPSED_LINES) return null;

  const fourth = lines[COLLAPSED_LINES - 1];
  if (!fourth) return null;

  const head = lines
    .slice(0, COLLAPSED_LINES - 1)
    .map((line) => line.text)
    .join('');

  const budget = available - markerWidth;
  // Room for the marker already: the fourth line stands as measured, and the marker
  // sets after it on the same line. The ordinary case for a synopsis whose last visible
  // line is short.
  if (fourth.width <= budget) return { prose: trimEnd(head + fourth.text) };

  /**
   * Otherwise the line has to give the marker its room back.
   *
   * The per-character width is this line's own — its measured width over its own
   * character count — rather than an average of the font, so the estimate is about the
   * string being trimmed. It is then cut back to a word boundary, because a marker
   * following half a word reads as a rendering fault rather than as an invitation.
   */
  const perCharacter = fourth.text.length > 0 ? fourth.width / fourth.text.length : 0;
  const keep = perCharacter > 0 ? Math.max(0, Math.floor(budget / perCharacter)) : 0;
  const cut = fourth.text.slice(0, keep);
  const boundary = cut.lastIndexOf(' ');
  const kept = boundary > 0 ? cut.slice(0, boundary) : cut;

  return { prose: trimEnd(head + kept) };
}

/** Trailing space before ` … more` would double the gap the marker already carries. */
const trimEnd = (value: string) => value.replace(/\s+$/, '');

const styles = StyleSheet.create({
  block: { paddingHorizontal: theme.layout.gutter },
  /** Off the flow and invisible: it exists to be measured, never to be seen. Stretched
   *  to the block's own width, because a line count measured at a different width is a
   *  line count for a different paragraph. */
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
});
