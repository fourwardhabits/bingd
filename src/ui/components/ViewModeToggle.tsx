import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { MEDIUM_SELECTED } from './MediumSelector';

export type ViewMode = 'poster' | 'list';

export type ViewModeToggleProps = {
  value: ViewMode;
  onChange: (next: ViewMode) => void;
  /** The group's spoken name. Defaults to "View". */
  label?: string;
  testID?: string;
};

/** Collection's grid / list glyphs, poster first (founder §11). */
const MODES = [
  { value: 'poster', icon: 'grid', label: 'Poster view' },
  { value: 'list', icon: 'list', label: 'List view' },
] as const;

/**
 * **Poster or list, as one segmented control** (FU1113-B).
 *
 * Two icon cells in one hairline outline. The selected cell takes exactly
 * `MediumSelector`'s selected treatment — sunken ground, Maroon ink (`MEDIUM_SELECTED`) —
 * so a browse row's two choosers read as one family; the other cell is secondary ink.
 *
 * Each cell is a full 44pt target wide, and drawn 8pt shorter with the vertical slop
 * giving it back, so the pair sits on a 44pt row without towering over a heading. The
 * cells only ever touch each other side to side, where no slop is added, so neither can
 * take a press from the other.
 *
 * `radiogroup` / `radio`: neither choice is "off"; one is always the view in force.
 * `IconToggle` and the Feed's control are untouched by this.
 */
export function ViewModeToggle({ value, onChange, label = 'View', testID }: ViewModeToggleProps) {
  return (
    <View
      style={styles.group}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      testID={testID}
    >
      {MODES.map((mode, index) => {
        const selected = mode.value === value;
        return (
          <Pressable
            key={mode.value}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={mode.label}
            onPress={() => {
              if (!selected) onChange(mode.value);
            }}
            hitSlop={{ top: SLOP, bottom: SLOP }}
            testID={testID ? `${testID}-${mode.value}` : `view-mode-${mode.value}`}
            style={({ pressed }) => [
              styles.cell,
              index > 0 && styles.divider,
              selected && styles.cellOn,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name={mode.icon}
              size={theme.layout.icon.sm}
              color={selected ? MEDIUM_SELECTED.ink : theme.text.secondary}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/** The cells are drawn this much shorter than 44 on each side; slop gives it back. */
const SLOP = theme.space[1];

const styles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    flexShrink: 0,
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    overflow: 'hidden',
    backgroundColor: theme.surface.raised,
  },
  cell: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget - SLOP * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
    borderLeftColor: theme.border.hairline,
  },
  cellOn: { backgroundColor: MEDIUM_SELECTED.background },
  pressed: { opacity: 0.7 },
});
