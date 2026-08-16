import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '@/ui/tokens';
import { Text } from '@/ui/components';

import {
  WEEKDAY_INITIALS,
  addDays,
  addMonths,
  formatWatchDate,
  monthGrid,
  monthLabel,
  today,
} from './dates';

export type WatchDatePickerProps = {
  value: string;
  onChange: (iso: string) => void;
};

/**
 * Quick choices, then a month grid.
 *
 * **Deliberately not a native picker.** `@react-native-community/datetimepicker` is
 * the obvious reach and it is a native module: adding one changes the fingerprint,
 * and `runtimeVersion: { policy: 'fingerprint' }` then puts every tester on a new
 * build. app.config.ts already refuses `expo-navigation-bar` on exactly that
 * reasoning. A calendar is a grid of buttons; it is not worth a forced reinstall.
 *
 * Today and Yesterday cover almost every real log — Beli's pattern, and the reason
 * the grid stays folded away until asked for. The grid is what makes the field
 * genuinely editable rather than a two-option toggle, which matters for someone
 * catching up on things they watched weeks ago.
 */
export function WatchDatePicker({ value, onChange }: WatchDatePickerProps) {
  const now = today();
  const [month, setMonth] = useState(value);
  const [gridOpen, setGridOpen] = useState(false);

  const cells = monthGrid(month);

  return (
    <View style={styles.container}>
      <View style={styles.quick}>
        <QuickChip label="Today" selected={value === now} onPress={() => onChange(now)} />
        <QuickChip
          label="Yesterday"
          selected={value === addDays(now, -1)}
          onPress={() => onChange(addDays(now, -1))}
        />
        <QuickChip
          label={gridOpen ? 'Hide calendar' : 'Pick a date'}
          selected={gridOpen}
          onPress={() => {
            setMonth(value);
            setGridOpen((open) => !open);
          }}
        />
      </View>

      {gridOpen ? (
        <View style={styles.calendar}>
          <View style={styles.monthBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              onPress={() => setMonth(addMonths(month, -1))}
              hitSlop={theme.space[2]}
              style={styles.monthButton}
            >
              <Ionicons
                name="chevron-back"
                size={theme.layout.icon.sm}
                color={theme.text.secondary}
              />
            </Pressable>
            <Text variant="subhead" style={styles.monthLabel}>
              {monthLabel(month)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next month"
              onPress={() => setMonth(addMonths(month, 1))}
              hitSlop={theme.space[2]}
              style={styles.monthButton}
            >
              <Ionicons
                name="chevron-forward"
                size={theme.layout.icon.sm}
                color={theme.text.secondary}
              />
            </Pressable>
          </View>

          <View style={styles.week}>
            {WEEKDAY_INITIALS.map((initial, index) => (
              <Text
                key={`${initial}-${index}`}
                variant="caption"
                tone="tertiary"
                style={styles.cell}
              >
                {initial}
              </Text>
            ))}
          </View>

          <View style={styles.grid}>
            {cells.map((iso, index) =>
              iso === null ? (
                <View key={`blank-${index}`} style={styles.cell} />
              ) : (
                <Day
                  key={iso}
                  iso={iso}
                  selected={iso === value}
                  // A future watch date is not a thing that happened. The server
                  // refuses beyond tomorrow; the UI stops at today so the two never
                  // disagree in front of the user.
                  disabled={iso > now}
                  onPress={() => onChange(iso)}
                />
              ),
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function QuickChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text variant="footnote" tone={selected ? 'primary' : 'secondary'}>
        {label}
      </Text>
    </Pressable>
  );
}

function Day({
  iso,
  selected,
  disabled,
  onPress,
}: {
  iso: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      // The number alone is meaningless out of context, and a screen reader reads
      // the grid one cell at a time.
      accessibilityLabel={formatWatchDate(iso)}
      disabled={disabled}
      onPress={onPress}
      style={[styles.cell, styles.day, selected && styles.daySelected]}
    >
      <Text
        variant="footnote"
        tone={selected ? 'inverse' : disabled ? 'tertiary' : 'primary'}
      >
        {Number(iso.slice(8, 10))}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { gap: theme.space[3], paddingHorizontal: theme.layout.gutter },
  quick: { flexDirection: 'row', gap: theme.space[2] },
  chip: {
    minHeight: theme.layout.control.chipHeight,
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
    paddingHorizontal: theme.space[3],
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: theme.surface.sunken, borderColor: theme.border.strong },
  calendar: { gap: theme.space[2] },
  monthBar: { flexDirection: 'row', alignItems: 'center' },
  monthButton: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthLabel: { flex: 1, textAlign: 'center' },
  week: { flexDirection: 'row' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  // Seven to a row, sized by share rather than by points so the grid fits any width.
  cell: { width: `${100 / 7}%`, textAlign: 'center' },
  day: { height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.control },
  daySelected: { backgroundColor: theme.semantic.action },
});
