import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { inkAlpha, theme } from '../tokens';
import { Text } from './Text';

export type Medium = 'movies' | 'tv_seasons';

export type MediumSelectorProps = {
  value: Medium;
  onChange: (next: Medium) => void;
  /**
   * Override what a category is called on this screen.
   *
   * The rankable unit is the season, so Collection genuinely lists TV *seasons*. For
   * You recommends shows — TMDB answers "similar" about a series and never about a
   * season — so calling them seasons there would name something the wall does not
   * contain. One control, two accurate labels, rather than two controls.
   */
  labels?: Partial<Record<Medium, string>>;
};

const OPTIONS: { id: Medium; label: string }[] = [
  { id: 'movies', label: 'Movies' },
  { id: 'tv_seasons', label: 'TV seasons' },
];

const labelFor = (value: Medium, labels?: MediumSelectorProps['labels']) =>
  labels?.[value] ?? OPTIONS.find((o) => o.id === value)?.label ?? '';

/**
 * The category the collection is showing, as a dropdown (screens.md §5).
 *
 * This used to change value on tap, with a swap glyph. A control that mutates on
 * press without saying what it will become cannot be read before it is used, and
 * it only worked because there happened to be exactly two options — a third
 * category would have turned it into a guessing game. It also gave no way to see
 * what else existed without changing the screen out from under yourself.
 *
 * Set in DM Serif at `title1`, because this is the screen's actual title. Beli
 * does the same and it is why its collection header reads as a page rather than
 * as a toolbar.
 */
export function MediumSelector({ value, onChange, labels }: MediumSelectorProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Showing ${labelFor(value, labels)}`}
        accessibilityHint="Choose a category"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={styles.button}
      >
        <View style={styles.row}>
          <Text variant="title1">{labelFor(value, labels)}</Text>
          <Ionicons
            name="chevron-down"
            size={theme.layout.icon.md}
            color={theme.text.secondary}
          />
        </View>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.scrim} onPress={() => setOpen(false)} accessibilityLabel="Close">
          {/* Stops a tap inside the sheet from closing it. */}
          <Pressable style={styles.sheet} onPress={() => {}}>
            {OPTIONS.map((option) => {
              const selected = option.id === value;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                  style={[styles.option, selected && styles.optionSelected]}
                >
                  <Text variant="title2">{labelFor(option.id, labels)}</Text>
                  {selected ? (
                    <Ionicons
                      name="checkmark"
                      size={theme.layout.icon.md}
                      color={theme.semantic.action}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.layout.gutter,
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
    // 40% is the floor from design-system.md §8: a warm light ground behind a
    // lighter scrim turns muddy rather than dark.
    backgroundColor: inkAlpha(0.4),
  },
  sheet: {
    backgroundColor: theme.surface.raised,
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[10],
    paddingHorizontal: theme.layout.gutter,
    gap: theme.space[1],
    ...theme.elevation.e2,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: theme.layout.buttonMinHeight,
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
  },
  optionSelected: { backgroundColor: theme.surface.sunken },
});
