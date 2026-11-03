import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type CompactSwitchOption<T extends string> = { id: T; label: string };

export type CompactSwitchProps<T extends string> = {
  /** What a screen reader calls the group, e.g. "Medium". */
  accessibilityLabel: string;
  options: readonly CompactSwitchOption<T>[];
  value: T;
  onChange: (next: T) => void;
};

/**
 * Two or three short choices in one quiet outline (founder revision brief, 2026-11-03).
 *
 * For You's `Movies | TV Shows`, beside the Recommended / Top Rated selector (Visual 2.1).
 * Deliberately lighter than `SegmentedTabs` and the filled controls: a hairline outline
 * with 8pt corners (no pills), the chosen half on Parchment with Ink text, the other in
 * secondary text, at footnote size so it shares the selector's row on a 360pt phone.
 *
 * **Each half is a 44pt press, and the 32pt outline is drawn behind them.** It used to be
 * the outline's own box, with `hitSlop` making up the height; but a press never answers
 * outside its parent's bounds, so the slop stopped at the outline and the real target was
 * 32pt (independent review, 2026-11-03). Now the halves are the full height and the
 * outline is a decoration inset inside them, so nothing depends on slop. Each half is
 * wider than 44pt by its word alone.
 */
export function CompactSwitch<T extends string>({
  accessibilityLabel,
  options,
  value,
  onChange,
}: CompactSwitchProps<T>) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={styles.group}>
      <View pointerEvents="none" style={styles.outline} />
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => {
              if (!selected) onChange(option.id);
            }}
            style={styles.option}
          >
            {({ pressed }) => (
              <View style={[styles.fill, selected && styles.selected, pressed && !selected && styles.pressed]}>
                <Text variant="footnote" tone={selected ? 'primary' : 'secondary'} numberOfLines={1}>
                  {option.label}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The outline's stroke, and the 2pt it keeps between itself and each half's fill. */
const STROKE = StyleSheet.hairlineWidth * 2;
const INNER = 2;
/** The fill's floor, and the press around it: 8 + 28 + 8 = 44. */
const FILL = 28;
const PAD = (theme.layout.minTapTarget - FILL) / 2;

const styles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    paddingHorizontal: STROKE + INNER,
    gap: INNER,
  },
  // Inset so it sits 2pt outside the fills, top and bottom, as the old box did; it
  // stretches with them at a large text size.
  outline: {
    position: 'absolute',
    top: PAD - INNER - STROKE,
    bottom: PAD - INNER - STROKE,
    left: 0,
    right: 0,
    borderRadius: theme.radius.control,
    borderWidth: STROKE,
    borderColor: theme.border.hairline,
  },
  // A floor, not a fixed height: at a large system text size the fill grows past 28pt
  // and the press grows with it rather than clipping the word.
  option: {
    minHeight: theme.layout.minTapTarget,
    paddingVertical: PAD,
    justifyContent: 'center',
  },
  fill: {
    minHeight: FILL,
    paddingHorizontal: theme.space[2],
    borderRadius: theme.radius.control - INNER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selected: { backgroundColor: theme.surface.sunken },
  pressed: { opacity: 0.6 },
});
