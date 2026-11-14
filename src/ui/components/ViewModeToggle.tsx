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
 * **Each cell is a real 44pt target** (Codex review, #288). The pill is drawn 36pt tall so
 * it does not tower over a heading, and used to get its 44 back from vertical `hitSlop` —
 * which React Native does not honour past the parent's bounds, and the parent was the
 * 36pt pill. So each `Pressable` is now 44 × 44 and the pill is inset inside the group:
 * its outline (`frame`) sits behind the cells, and each cell draws its 36pt segment
 * (`segment`) centred in its own target. Nothing on screen moves; the touch area is real.
 *
 * `radiogroup` / `radio`: neither choice is "off"; one is always the view in force.
 * `IconToggle` and the Feed's control are untouched by this.
 */
export function ViewModeToggle({ value, onChange, label = 'View', testID }: ViewModeToggleProps) {
  const base = testID ?? 'view-mode';
  return (
    <View
      style={styles.group}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      testID={testID}
    >
      {/* The pill's outline and ground, behind the cells and never pressed. */}
      <View pointerEvents="none" style={styles.frame} testID={`${base}-frame`} />
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
            testID={`${base}-${mode.value}`}
            style={styles.cell}
          >
            {({ pressed }) => (
              <View
                testID={`${base}-${mode.value}-segment`}
                style={[
                  styles.segment,
                  index === 0 ? styles.first : styles.divider,
                  index === MODES.length - 1 && styles.last,
                  selected && styles.segmentOn,
                  pressed && styles.pressed,
                ]}
              >
                <Ionicons
                  name={mode.icon}
                  size={theme.layout.icon.sm}
                  color={selected ? MEDIUM_SELECTED.ink : theme.text.secondary}
                />
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The pill's height inside each 44pt cell: 8pt shorter, 4pt above and below. */
const INSET = theme.space[1];
const BORDER = StyleSheet.hairlineWidth * 2;
/** The pill's inner corner, which the end segments' ground follows (was `overflow`). */
const INNER_RADIUS = Math.max(0, theme.radius.control - BORDER);

const styles = StyleSheet.create({
  // The group is the targets' height; the border's width either side keeps the cells
  // where they sat inside the old pill's outline.
  group: {
    flexDirection: 'row',
    flexShrink: 0,
    height: theme.layout.minTapTarget,
    paddingHorizontal: BORDER,
  },
  // The pill exactly as it was drawn: outline, raised ground, 36pt inside its border.
  frame: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: INSET - BORDER,
    bottom: INSET - BORDER,
    borderRadius: theme.radius.control,
    borderWidth: BORDER,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  cell: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    paddingVertical: INSET,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  first: { borderTopLeftRadius: INNER_RADIUS, borderBottomLeftRadius: INNER_RADIUS },
  last: { borderTopRightRadius: INNER_RADIUS, borderBottomRightRadius: INNER_RADIUS },
  divider: {
    borderLeftWidth: BORDER,
    borderLeftColor: theme.border.hairline,
  },
  segmentOn: { backgroundColor: MEDIUM_SELECTED.background },
  pressed: { opacity: 0.7 },
});
