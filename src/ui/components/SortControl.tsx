import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  directionWords,
  isDirectional,
  nextSortState,
  sortDirectionIcon,
  spokenSortLabel,
  type SortAxisSpec,
  type SortState,
} from '../sort';
import { theme } from '../tokens';
import { FilterChip } from './FilterChip';
import { Text } from './Text';

/**
 * The sort control, as a chip and a menu that are placed separately.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO COMPONENTS AND NOT ONE
 *
 * The chip belongs in a row beside Filters and the view toggle; the menu opens *under*
 * that row, full width, wrapping. One component returning both would have to be dropped
 * into the row, and the menu would be laid out as a third cell of it. Both surfaces
 * already had exactly this arrangement — a chip in a row, a menu below — so the split is
 * theirs and only the vocabulary is new.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SHARED, AND WHY IT HAD TO BE
 *
 * The rules these draw are `ui/sort.ts`'s, and the reason they are one module is the
 * defect that produced them: the Collection tab and the profile See-all sheet had grown
 * two sort controls with two vocabularies — `Your score: high` and `Highest first` for
 * the same idea — and the one that was wrong was wrong in a way the other's tests could
 * not see. A shared control cannot disagree with itself.
 *
 * **The chip says the axis and points the direction.** Label and arrow are separate
 * channels on purpose: the label is stable while the arrow flips, which is what makes
 * "the axis did not change, only the order did" legible without reading two words that
 * both moved. `accessibilityLabel` spells the direction out, because an arrow is not a
 * sentence.
 *
 * **The menu is one row per axis, never one row per direction.** The row for the axis
 * already on carries its current arrow, so pressing it reads as "flip this" rather than
 * "choose this again"; pressing any other row lands in that axis's own intuitive
 * direction rather than inheriting the previous axis's.
 */
export type SortChipProps<Axis extends string> = {
  /** Every axis this surface can actually order by, in menu order. The first is its fallback. */
  axes: readonly SortAxisSpec<Axis>[];
  value: SortState<Axis>;
  onPress: () => void;
};

export function SortChip<Axis extends string>({ axes, value, onPress }: SortChipProps<Axis>) {
  const active = axes.find((option) => option.axis === value.axis);

  return (
    <FilterChip
      // Rule 5: the arrow is the direction. An axis with no order to reverse keeps the
      // two-headed glyph the row has always used, because there is nothing to point at.
      icon={
        active && isDirectional(active)
          ? sortDirectionIcon(value.direction)
          : 'swap-vertical-outline'
      }
      label={active?.label ?? 'Sort'}
      accessibilityLabel={spokenSortLabel(value, axes)}
      onPress={onPress}
    />
  );
}

export type SortMenuProps<Axis extends string> = {
  axes: readonly SortAxisSpec<Axis>[];
  value: SortState<Axis>;
  /** Already run through {@link nextSortState} — the caller only stores it. */
  onChange: (next: SortState<Axis>) => void;
  /** Closes the menu. Called after every press, including one that changes nothing. */
  onClose: () => void;
  /**
   * Pressed when the reader picks the axis already on and that axis has no direction —
   * Shuffle's reseed. Absent means such a press is a no-op.
   */
  onRepeatUndirected?: (axis: Axis) => void;
};

export function SortMenu<Axis extends string>({
  axes,
  value,
  onChange,
  onClose,
  onRepeatUndirected,
}: SortMenuProps<Axis>) {
  const press = (axis: Axis) => {
    const spec = axes.find((option) => option.axis === axis);
    if (spec && !isDirectional(spec) && axis === value.axis) {
      onRepeatUndirected?.(axis);
      onClose();
      return;
    }
    onChange(nextSortState(value, axis, axes));
    onClose();
  };

  return (
    <View style={styles.menu} accessibilityRole="radiogroup">
      {axes.map((option) => {
        const selected = option.axis === value.axis;
        // The arrow on a selected row is the direction it is *currently* in, which is
        // the one pressing it will reverse.
        const words = selected ? directionWords(option, value.direction) : null;
        return (
          <Pressable
            key={option.axis}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={words ? `${option.label}, ${words}` : option.label}
            onPress={() => press(option.axis)}
            style={({ pressed }) => [
              styles.option,
              selected && styles.selected,
              pressed && styles.pressed,
            ]}
          >
            <Text variant="callout" tone={selected ? 'inverse' : 'primary'}>
              {option.label}
            </Text>
            {selected && isDirectional(option) ? (
              <Ionicons
                name={sortDirectionIcon(value.direction)}
                size={theme.layout.icon.sm}
                color={theme.text.inverse}
              />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  menu: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.control.chipHeight,
    justifyContent: 'center',
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  selected: { backgroundColor: theme.semantic.action, borderColor: theme.semantic.action },
  pressed: { opacity: 0.7 },
});
