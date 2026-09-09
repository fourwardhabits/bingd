import { useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextLayoutEventData,
  type ViewStyle,
} from 'react-native';

import type { TypographyToken } from '../tokens';
import { Text, type TextProps } from './Text';

/** The word, and the marker it sets in. The spaces are part of it. */
const MORE = 'more';
export const MARKER = ` … ${MORE}`;

export type ClampedTextProps = {
  text: string;
  /**
   * Lines the collapsed block takes.
   *
   * A hard ceiling as well as a target: the visible `Text` carries it as
   * `numberOfLines`, so whatever the measurement concludes the block cannot grow past
   * it. The measurement decides how much prose to keep; the clamp decides that it
   * cannot be wrong in the direction that matters.
   */
  clamp: number;
  variant?: TypographyToken;
  tone?: TextProps['tone'];
  /**
   * How the prose is drawn, for callers whose text carries inline spans.
   *
   * Used for **both** passes, so the measurement is of the thing that will actually be
   * laid out: a mention renders semibold, and measuring the plain string instead would
   * be measuring a narrower paragraph than the reader gets. Defaults to the string.
   */
  render?: (prose: string) => ReactNode;
  /** Names the four testIDs: `<prefix>-column`, `-measure`, `-marker-measure`, `-more`. */
  testIDPrefix: string;
  /** Spoken while the block is collapsed. */
  expandLabel: string;
  /**
   * Spoken once open, which is also what makes the control a toggle.
   *
   * Omit it and expanding is one-way: the press target stays and the affordance is gone.
   * That is `SpoilerNote`'s existing behaviour and it is kept, because a note in a feed
   * row that could re-collapse under a thumb is a row that changes height while somebody
   * is reading the one below it.
   */
  collapseLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * A block of prose clamped to N lines, with `… more` **on the last visible one**.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A COMPONENT AND NOT A PATTERN COPIED TWICE
 *
 * It was the title page's `Synopsis` and nothing else, and the founder's physical pass
 * on iOS 1.0.1 build 8 named what that cost: the Feed's note text truncates and expands
 * on a tap, and there was nothing on screen to say so. A reader had to already know.
 *
 * The obvious fix is a second `more` under the paragraph, and that is the exact defect
 * `Synopsis` was written to remove: a note that fills its clamp then spends a whole line
 * of the feed saying one word, orphaned under the paragraph rather than offered at the
 * end of it. So the measurement moved here and both surfaces use it — one
 * implementation, one contract, and no second place for the two to drift apart.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS MEASURED AND NOT COUNTED
 *
 * The obvious implementation is to cut the string at N characters. It is wrong at every
 * width and at every text size: the font is not monospaced, the phone is not one width,
 * and the reader's type scale is theirs to set — so a constant that is right on the
 * founder's device is a wrapped `more` on a 320pt screen and a half-empty line at 130%.
 *
 * So this measures, in two invisible passes laid out at the same width as the visible
 * text:
 *
 *   1. the **whole** text, unclamped, which reports one entry per line with that line's
 *      own text and width (`onTextLayout`);
 *   2. the **marker** — ` … more` — which reports the width the last visible line has to
 *      reserve for it.
 *
 * With those, the last visible line is trimmed to a word boundary that leaves room for
 * the marker, and the marker is drawn as a span *inside the same `Text`* rather than
 * under it. Being inside the clamp is what makes the guarantee structural: React Native
 * cannot put it on a line past the clamp, because there is no such line.
 *
 * The per-character width used for the trim is derived from that line's *own* measured
 * width and its own character count, so it is that string, in that font, at that text
 * size — not an average of the alphabet.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE TRIM IS AND IS NOT, STATED RATHER THAN IMPLIED
 *
 * It is an estimate. A per-character figure is an average over one line, so a kept prefix
 * of wide glyphs followed by a dropped tail of narrow ones can come out wider than the
 * arithmetic predicts — independent review's case, a prefix of `W`s and a tail of `i`s.
 * The word-boundary cut below usually gives back several characters' worth of slack,
 * which is what makes it hold in practice, but it is slack rather than a proof.
 *
 * **What the clamp guarantees is the part that matters, and it is exact**: the marker can
 * never orphan onto a line of its own, because `numberOfLines` has not given the block
 * one. The residual failure is the marker being ellipsized with the prose on an unusually
 * uneven line — the reader sees the paragraph truncate the way it did before this
 * component existed, on one line of one paragraph, which is a lost invitation and not a
 * broken layout.
 *
 * Closing it exactly means measuring the candidate string itself: a third pass, a
 * shrink-and-remeasure loop, and its own termination argument. That is more machinery
 * than the failure is worth, so it is deliberately not here and is written down instead.
 * A margin was tried and removed: subtracting a character's width discarded short trailing
 * words that genuinely fitted, which is a common cost paid for a rare, invisible gain.
 *
 * ---------------------------------------------------------------------------
 * WHAT HAPPENS BEFORE THE MEASUREMENT LANDS, AND IF IT NEVER DOES
 *
 * The visible text is the whole thing under `numberOfLines={clamp}`, which is what both
 * surfaces drew before this existed: React Native's own ellipsis, no marker. That is the
 * honest unmeasured state — never wrong, only less inviting — and the whole block is the
 * press target either way, so a reader can still open it. The marker appears when the
 * measurement answers, one frame later.
 *
 * Text that already fits shows no marker at all and never will, which is the other half
 * of the contract.
 */
export function ClampedText({
  text,
  clamp,
  variant = 'body',
  tone = 'primary',
  render,
  testIDPrefix,
  expandLabel,
  collapseLabel,
  style,
}: ClampedTextProps) {
  const [expanded, setExpanded] = useState(false);
  /** One entry per line of the *whole* text, from the measuring pass. */
  const [lines, setLines] = useState<{ text: string; width: number }[] | null>(null);
  /** How wide ` … more` sets, from its own pass. */
  const [markerWidth, setMarkerWidth] = useState<number | null>(null);
  /** The block's own width, which is what the last visible line has to fit inside. */
  const [available, setAvailable] = useState<number | null>(null);

  const collapsed = collapse({ lines, markerWidth, available, clamp });
  const draw = render ?? ((prose: string) => prose);
  /** Whether both passes and the column width have answered. */
  const measured = lines != null && markerWidth != null && available != null;
  /**
   * Whether this is still a control.
   *
   * Three cases, and the middle one is what independent review found: **text that fits
   * its clamp is not a button.** A one-line review under `numberOfLines={2}` draws no
   * marker, because there is nothing to promise — and it was still announcing itself as
   * "Show the whole review, button, collapsed" over a review that was entirely visible,
   * and doing nothing when pressed.
   *
   * Before the measurement lands it stays pressable, which is the honest unmeasured
   * state: the block has always been the press target and a reader can still open it a
   * frame early. And one-way text that is already open is not a control either — it has
   * nothing left to do, so it announces as nothing rather than as a dimmed button with no
   * label. A toggle stays a control in both directions, which is what `collapseLabel`
   * means.
   */
  const acts = expanded ? Boolean(collapseLabel) : collapsed != null || !measured;

  return (
    <Pressable
      accessibilityRole={acts ? 'button' : undefined}
      accessibilityState={acts ? { expanded } : undefined}
      accessibilityLabel={acts ? (expanded ? collapseLabel : expandLabel) : undefined}
      onPress={() => setExpanded((open) => (collapseLabel ? !open : true))}
      disabled={!acts}
      style={style}
    >
      {/**
       * The gutter belongs to the caller's `style` on the `Pressable`; the measurement
       * belongs to this, which is not a spare view.
       *
       * `available` has to be the width the *text* sets in, and a layout read off a
       * padded box would be a gutter's worth too wide — so the last line would be given
       * room it does not have and `more` would be pushed off the end of it, which is the
       * exact defect this component exists to prevent. Measuring an unpadded child gives
       * the text's own width, and it is what the absolute measuring layer below spans, so
       * both passes measure the same column.
       */}
      <View
        testID={`${testIDPrefix}-column`}
        onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}
      >
        {/* The two measuring passes. Off the flow, invisible, and hidden from assistive
            technology so the text is not announced three times. They unmount as soon as
            they have answered — a pass that stayed would re-measure on every layout. */}
        {lines == null || markerWidth == null ? (
          <View
            style={styles.measure}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {lines == null ? (
              <Text
                testID={`${testIDPrefix}-measure`}
                variant={variant}
                tone={tone}
                onTextLayout={(event: NativeSyntheticEvent<TextLayoutEventData>) =>
                  setLines(
                    event.nativeEvent.lines.map((line) => ({
                      text: line.text,
                      width: line.width,
                    })),
                  )
                }
              >
                {draw(text)}
              </Text>
            ) : null}
            {markerWidth == null ? (
              <Text
                testID={`${testIDPrefix}-marker-measure`}
                variant={variant}
                tone={tone}
                onTextLayout={(event: NativeSyntheticEvent<TextLayoutEventData>) =>
                  setMarkerWidth(event.nativeEvent.lines[0]?.width ?? 0)
                }
              >
                {MARKER}
              </Text>
            ) : null}
          </View>
        ) : null}

        <Text variant={variant} tone={tone} numberOfLines={expanded ? undefined : clamp}>
          {expanded || !collapsed ? draw(text) : draw(collapsed.prose)}
          {/* No "less" once it is open: the whole thing is visible and the control has
              nothing left to promise.

              **Inside the clamped `Text`, not under it.** That is the guarantee: React
              Native cannot put this span past the clamp, because `numberOfLines` has not
              given the block a line to put it on. The trim above is what stops it being
              clipped instead. */}
          {!expanded && collapsed ? (
            <Text testID={`${testIDPrefix}-more`} variant={variant} tone="action">
              {MARKER}
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
 * are genuinely one: the measurement has not landed, or the text already fits in the
 * clamp, or the last visible line is missing from what was measured. In each of them
 * there is no honest line to trim.
 */
export function collapse({
  lines,
  markerWidth,
  available,
  clamp,
}: {
  lines: { text: string; width: number }[] | null;
  markerWidth: number | null;
  available: number | null;
  clamp: number;
}): { prose: string } | null {
  if (!lines || markerWidth == null || available == null) return null;
  if (lines.length <= clamp) return null;

  const last = lines[clamp - 1];
  if (!last) return null;

  const head = lines
    .slice(0, clamp - 1)
    .map((line) => line.text)
    .join('');

  const budget = available - markerWidth;
  // Room for the marker already: the line stands as measured, and the marker sets after
  // it on the same line. The ordinary case for text whose last visible line is short.
  if (last.width <= budget) return { prose: trimEnd(head + last.text) };

  /**
   * Otherwise the line has to give the marker its room back.
   *
   * The per-character width is this line's own — its measured width over its own
   * character count — rather than an average of the font, so the estimate is about the
   * string being trimmed. It is then cut back to a word boundary, because a marker
   * following half a word reads as a rendering fault rather than as an invitation.
   */
  const perCharacter = last.text.length > 0 ? last.width / last.text.length : 0;
  const keep = perCharacter > 0 ? Math.max(0, Math.floor(budget / perCharacter)) : 0;
  const cut = last.text.slice(0, keep);
  const boundary = cut.lastIndexOf(' ');
  /**
   * **A cut with no space in it is a fragment of one word, and the fragment goes.**
   *
   * This branch used to keep it, which produced exactly the thing the trim exists to
   * prevent: a line reported by `onTextLayout` begins at a word boundary, so a cut short
   * enough to hold no space at all is a prefix of that first word — `alpha bet … more`.
   * Rare on a four-line synopsis, ordinary on a two-line note in the feed, which is
   * where the founder's physical pass would have met it.
   *
   * The exception is a clamp with nothing above the trimmed line: dropping the fragment
   * there leaves a block that is only a marker. A fragment beats nothing, so on an empty
   * head it is kept.
   */
  const kept = boundary > 0 ? cut.slice(0, boundary) : head ? '' : cut;
  const prose = trimEnd(head + kept);

  /**
   * **Nothing survived the trim, so there is nothing for a marker to follow.**
   *
   * Reachable when the budget buys no characters at all: a clamp of one whose first word
   * is wider than the column minus the marker, or a marker wider than the column itself.
   * Drawing it anyway would leave a block whose entire content is ` … more`, which says
   * less than the text it replaced.
   *
   * `null` is the same answer the unmeasured first frame gets: the whole string under
   * `numberOfLines`, with React Native's own ellipsis. Never wrong, only less inviting,
   * and the block is still the press target.
   */
  if (!prose) return null;

  return { prose };
}

/** Trailing space before ` … more` would double the gap the marker already carries. */
const trimEnd = (value: string) => value.replace(/\s+$/, '');

const styles = StyleSheet.create({
  /** Off the flow and invisible: it exists to be measured, never to be seen. Stretched
   *  to the block's own width, because a line count measured at a different width is a
   *  line count for a different paragraph. */
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
});
