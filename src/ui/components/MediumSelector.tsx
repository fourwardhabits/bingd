import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { inkAlpha, theme } from '../tokens';
import { Text } from './Text';

export type Medium = 'movies' | 'tv_seasons';

export type MediumSelectorOption<T extends string = Medium> = { id: T; label: string };

export type MediumSelectorProps<T extends string = Medium> = {
  value: T;
  onChange: (next: T) => void;
  /**
   * What this control chooses between, defaulting to the two categories a collection is
   * made of.
   *
   * For You offers a third — People — because the honest answer to "what next" is
   * sometimes a person, and a screen with one category control should not grow a second
   * control above it to say which *kind* of category. The generic is what keeps that
   * from leaking: a caller that passes no table is a two-option control whose `onChange`
   * still receives `Medium`, so Collection cannot be handed an id it has no list for.
   */
  options?: readonly MediumSelectorOption<T>[];
  /**
   * Override what a category is called on this screen.
   *
   * The visible category is "TV" (external-beta polish) even though the rankable unit
   * underneath remains the individual season. For You still overrides to "TV shows" —
   * TMDB answers "similar" about a series and never about a season, so its wall holds
   * shows and says so. One control, two accurate labels, rather than two controls.
   */
  labels?: Partial<Record<T, string>>;
  /**
   * How large the closed control reads. The open sheet is identical either way.
   *
   * `title` — DM Serif at `title1`, the screen's actual title. Collection and For You.
   *
   * `section` — the app's section-header treatment: uppercase, Maroon, `sectionHeader`.
   *   Added 2026-08-29 for the Leaderboard's timeframe, which sits in a *content* header
   *   row opposite the Feed/Trophy toggle rather than at the top of a screen. A page
   *   title there would out-shout the row it belongs to and disagree with `TRENDING NOW`
   *   directly across from it.
   *
   * A prop rather than a second component, for the reason `IconToggle` is one component
   * with two callers: these are the same interaction — tap, choose from a sheet — and two
   * implementations of it would drift into two dialects at the next tuning pass. What
   * changes is type size, not behaviour.
   */
  size?: 'title' | 'section';
};

/**
 * The default table, exported so a screen that adds an option can extend the shared two
 * rather than restate them — a second copy of "Movies" is how two screens come to
 * disagree about what the category is called.
 */
export const MEDIUM_OPTIONS: readonly MediumSelectorOption[] = [
  { id: 'movies', label: 'Movies' },
  { id: 'tv_seasons', label: 'TV' },
];

const labelFor = <T extends string>(
  value: T,
  options: readonly MediumSelectorOption<T>[],
  labels?: Partial<Record<T, string>>,
) => labels?.[value] ?? options.find((o) => o.id === value)?.label ?? '';

/**
 * The category the collection is showing, as a dropdown (screens.md §5).
 *
 * This used to change value on tap, with a swap glyph. A control that mutates on
 * press without saying what it will become cannot be read before it is used, and
 * it only worked because there happened to be exactly two options — a third
 * category would have turned it into a guessing game. It also gave no way to see
 * what else existed without changing the screen out from under yourself. For You now
 * has that third category, so the objection was not hypothetical.
 *
 * Set in DM Serif at `title1`, because this is the screen's actual title. Beli
 * does the same and it is why its collection header reads as a page rather than
 * as a toolbar.
 */
export function MediumSelector<T extends string = Medium>({
  value,
  onChange,
  options,
  labels,
  size = 'title',
}: MediumSelectorProps<T>) {
  const [open, setOpen] = useState(false);
  /**
   * The cast is the seam between a concrete default and a caller that has widened `T`,
   * and it is safe in the only direction that matters: every id in `MEDIUM_OPTIONS` is a
   * `Medium`, and a caller who omits `options` leaves `T` inferred as `Medium` — the
   * widened case always supplies its own table, so these two are never mixed.
   */
  const table = (options ?? (MEDIUM_OPTIONS as readonly MediumSelectorOption<string>[])) as
    readonly MediumSelectorOption<T>[];

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Showing ${labelFor(value, table, labels)}`}
        accessibilityHint="Choose a category"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={size === 'section' ? styles.buttonSection : styles.button}
      >
        <View style={styles.row}>
          {size === 'section' ? (
            // Uppercased as a *style*, exactly as `SectionHeader` does it — the accessible
            // label on the Pressable carries the readable spelling, so a screen reader is
            // not made to spell out "T H I S  M O N T H".
            <Text variant="sectionHeader" tone="action">
              {labelFor(value, table, labels).toUpperCase()}
            </Text>
          ) : (
            <Text variant="title1">{labelFor(value, table, labels)}</Text>
          )}
          <Ionicons
            name="chevron-down"
            size={size === 'section' ? theme.layout.icon.sm : theme.layout.icon.md}
            color={size === 'section' ? theme.semantic.action : theme.text.secondary}
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
            {table.map((option) => {
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
                  <Text variant="title2">{labelFor(option.id, table, labels)}</Text>
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
  // No gutter of its own: a section-sized control sits inside a row the caller has
  // already padded, where the title-sized one is measuring from the screen edge.
  buttonSection: { minHeight: theme.layout.minTapTarget, justifyContent: 'center' },
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
