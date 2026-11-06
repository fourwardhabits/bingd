import { Pressable, StyleSheet, View } from 'react-native';

import { fontFamily, theme } from '../tokens';
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
 * `Movies | TV` on For You and Collection, right of the page's dropdown (founder final
 * polish, 2026-11-04). Deliberately lighter than `SegmentedTabs` and the filled controls:
 * a hairline outline with 8pt corners (no pills), the chosen half on Parchment with
 * Maroon text, the other in secondary text, in Inter Medium at 14pt.
 *
 * **Maroon for the chosen word** (founder, nav cohesion sprint, 2026-11-06): the selected
 * state Collection's Watched | Watchlist control and the Leaderboard's categories use, so
 * one choice looks chosen the same way everywhere. Not the Feed mode toggle's solid
 * Maroon fill, which would make the switch louder than the logo beside it.
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
                <Text
                  variant="footnote"
                  tone={selected ? 'action' : 'secondary'}
                  numberOfLines={1}
                  style={styles.label}
                >
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
  // 44pt wide as well as tall: "TV" alone measures about 19pt, and its half was a 35pt
  // target until the floor applied both ways (final polish review, 2026-11-04).
  option: {
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
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
  // Centred in its fill on Android too: Inter's font padding otherwise sets the word
  // about a point low in a 28pt fill (nav cohesion sprint, 2026-11-06). No effect on iOS.
  label: {
    fontFamily: fontFamily.sansMedium,
    fontSize: 14,
    lineHeight: 18,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  selected: { backgroundColor: theme.surface.sunken },
  pressed: { opacity: 0.6 },
});
