import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

/**
 * `outline` is the fourth, and it is the *filled* button's own state after the act.
 *
 * Follow is Maroon and filled; once you follow somebody it becomes Following, which is
 * a statement of where you stand rather than the thing to do on the page. `secondary`
 * was the obvious answer and it is wrong here for one reason: it is grey, so the
 * control the reader just used appears to have been replaced by a different, unrelated
 * one. `outline` keeps the identity — the same Maroon, as a border and as ink, on the
 * raised surface — while giving up the fill, so the change reads as the same button
 * having changed state.
 *
 * It is not `primary` with a modifier, because the two differ in more than fill: the
 * label is Maroon here and inverse there, and a "primary but hollow" prop would make
 * every caller responsible for remembering that.
 */
type Kind = 'primary' | 'secondary' | 'tertiary' | 'outline';

/**
 * `md` is the screen's own action. `sm` is one that belongs to a row.
 *
 * A notification offering Follow back was using `md`, which is the same physical
 * control a screen uses for its primary act — 48pt tall with 20pt of padding either
 * side, sitting under a 56pt row and very nearly doubling its height. `sm` is 36pt
 * and still clears the 44pt target with the `hitSlop` its caller passes, because slop
 * is the right tool for a control inside a list and a taller box is not.
 */
type Size = 'md' | 'sm';

/**
 * How loudly the label reads, where the default is wrong.
 *
 * Every kind has a tone that follows from it — a primary button is inverse on Maroon,
 * everything else is full ink — and that is right for a control which is the point of
 * its screen. It is wrong for one that deliberately is not: the ranking sheet's Undo
 * and Skip sit under two posters, and full-ink at `headline` weight made them read as
 * the question rather than as the way out of it.
 *
 * Optional, and the default is exactly what every existing caller already gets. A
 * button asks for a quieter tone; it cannot be given a louder one than its kind
 * implies, because that is what `kind` is for.
 */
type Tone = 'default' | 'secondary';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  kind?: Kind;
  size?: Size;
  tone?: Tone;
  /**
   * Required when disabled. An unexplained dead button is the most common
   * accessibility failure in this pattern (design-system.md §8), so the reason
   * is announced to screen readers rather than left to be inferred.
   */
  disabledReason?: string;
  /**
   * "This one is in a narrow column, and its label may not wrap."
   *
   * **The founder's iPhone screenshot is what this is for.** `bingd. Awards` sits in
   * one half of a two-up row inside the page gutter. At 375pt that half is 167pt and
   * the label plus `md`'s 40pt of side padding is about 162 — it fits by five points.
   * At 320pt, which is a width this app supports, the half is 140pt and the same label
   * needs 162, so it wrapped to two lines and the button grew to 68pt tall next to a
   * 48pt Share Profile. Dynamic Type at any size above default does the same thing to
   * the 375pt case.
   *
   * Three things together, because each alone fails:
   *
   *   - `numberOfLines={1}` stops the wrap, and on its own it *clips*;
   *   - `adjustsFontSizeToFit` shrinks instead of clipping, and needs the line cap to
   *     do anything at all;
   *   - the side padding drops from `space[5]` to `space[3]`, which is what keeps the
   *     shrink imperceptible — 24pt of padding rather than 40 leaves the label its
   *     natural size at every width down to about 330, so the scale only engages on
   *     the narrowest devices and the largest type settings.
   *
   * `minimumFontScale` is 0.85 rather than lower on purpose: below that the label is
   * visibly smaller than the button beside it, and a pair that no longer matches is the
   * defect this is fixing rather than a smaller version of it. A label that cannot fit
   * at 85% is a label that is too long for this slot, which is a copy decision and not
   * one a component should make silently.
   *
   * Not the default. Every other button in the app is either full-width or hugging a
   * short label, and shrinking type is a thing to do deliberately.
   */
  fit?: boolean;
};

export function Button({
  label,
  kind = 'primary',
  size = 'md',
  tone = 'default',
  disabled,
  disabledReason,
  fit = false,
  ...rest
}: ButtonProps) {
  if (disabled && !disabledReason && __DEV__) {
    console.warn(`Button "${label}" is disabled without a disabledReason.`);
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      accessibilityHint={disabled ? disabledReason : undefined}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        styles[size],
        styles[kind],
        fit && styles.fit,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}
      {...rest}
    >
      <View pointerEvents="none">
        <Text
          numberOfLines={fit ? 1 : undefined}
          adjustsFontSizeToFit={fit}
          minimumFontScale={fit ? 0.85 : undefined}
          variant={size === 'sm' ? 'callout' : 'headline'}
          tone={
            kind === 'primary'
              ? 'inverse'
              : kind === 'outline'
                ? 'action'
                : tone === 'secondary'
                  ? 'secondary'
                  : 'primary'
          }
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  md: { minHeight: theme.layout.buttonMinHeight, paddingHorizontal: theme.space[5] },
  sm: { minHeight: 36, paddingHorizontal: theme.space[4] },
  primary: { backgroundColor: theme.semantic.action },
  secondary: {
    backgroundColor: theme.surface.raised,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.strong,
  },
  tertiary: { backgroundColor: 'transparent', paddingHorizontal: theme.space[2] },
  // Two points of Maroon rather than a hairline: this has to read as the same weight
  // of control as the filled Maroon it replaces, and a hairline outline reads lighter
  // than a fill at any width.
  outline: {
    backgroundColor: theme.surface.raised,
    borderWidth: 2,
    borderColor: theme.semantic.action,
  },
  // Applied after the size, so it overrides whichever one is in play.
  fit: { paddingHorizontal: theme.space[3] },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.4 },
});
