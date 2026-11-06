import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
   * `title` — DM Serif at `title1`, the screen's actual title.
   *
   * `nav` — DM Serif at `title2` (22pt), the left half of the navigation row on For You
   *   and Collection, with the Movies | TV `CompactSwitch` on its right (founder final
   *   polish, 2026-11-04). One step down from `title` so the pair shares a 360pt row; no
   *   right padding, because the row's own gap is the space before the switch.
   *
   * `section` — the app's section-header treatment: uppercase, Maroon, `sectionHeader`.
   *   Added 2026-08-29 for the Leaderboard's timeframe, which sits in a *content* header
   *   row opposite the Feed/Trophy toggle rather than at the top of a screen. A page
   *   title there would out-shout the row it belongs to and disagree with `TRENDING NOW`
   *   directly across from it.
   *
   * `heading` — Inter Semibold at `headline` (17pt), For You's Recommended / Top Rated
   *   (founder, nav cohesion sprint, 2026-11-06). Still the page's content-mode selector,
   *   but in the interface face at the size of the controls around it, rather than a 22pt
   *   serif dropdown standing alone under the header. No gutter of its own.
   *
   * `filter` — a compact text-and-chevron, Inter Medium at `subhead` (14pt) in secondary
   *   ink: the Leaderboard's This month / All time (same sprint). A secondary filter
   *   under the section's own heading, not a heading itself. No gutter of its own.
   *
   * `heading` and `filter` open a **small menu under the control** rather than the
   * bottom sheet: two options do not need a sheet's scrim and travel (same sprint). The
   * other sizes keep the sheet.
   *
   * A prop rather than a second component, for the reason `IconToggle` is one component
   * with two callers: these are the same interaction — tap, choose — and two
   * implementations of it would drift into two dialects at the next tuning pass.
   */
  size?: 'title' | 'nav' | 'section' | 'heading' | 'filter';
  /** What a screen reader hears after the label. Defaults to "Choose a category". */
  accessibilityHint?: string;
  testID?: string;
};

/**
 * The default table, exported so a screen that adds an option can extend the shared two
 * rather than restate them — a second copy of "Movies" is how two screens come to
 * disagree about what the category is called.
 */
export const MEDIUM_OPTIONS: readonly MediumSelectorOption[] = [
  { id: 'movies', label: 'Movies' },
  { id: 'tv_seasons', label: 'TV Shows' },
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
  accessibilityHint = 'Choose a category',
  testID,
}: MediumSelectorProps<T>) {
  const [open, setOpen] = useState(false);
  const anchored = size === 'heading' || size === 'filter';
  /** Where the anchored menu opens: just under the control, in window coordinates. */
  const [anchor, setAnchor] = useState<{ x: number; y: number; height: number } | null>(null);
  /** The open menu's own height, once laid out, so it can be placed inside the window. */
  const [menuHeight, setMenuHeight] = useState<number | null>(null);
  const trigger = useRef<View>(null);
  const win = useWindowDimensions();
  /**
   * A window that changes size while the menu is open (a rotation, split screen) makes the
   * measured anchor wrong, so the menu closes rather than hanging where the control was
   * (independent review 1). Adjusted during render, against the size it was opened at.
   */
  const windowKey = `${win.width}x${win.height}`;
  const [openedAt, setOpenedAt] = useState(windowKey);
  if (open && openedAt !== windowKey) setOpen(false);
  /**
   * The foot of the option sheet, by `Sheet`'s rule (2026-09-07).
   *
   * It was a fixed `space[10]`, which is generous on a phone with a home indicator and
   * short on an Android device whose navigation bar reports a larger inset now that the
   * app draws edge to edge. Never less than what it had — the sheet does not get
   * visibly shorter anywhere — and never under the bar.
   */
  const insets = useSafeAreaInsets();
  const bottomPadding = Math.max(insets.bottom + theme.space[4], theme.space[10]);
  /**
   * The cast is the seam between a concrete default and a caller that has widened `T`,
   * and it is safe in the only direction that matters: every id in `MEDIUM_OPTIONS` is a
   * `Medium`, and a caller who omits `options` leaves `T` inferred as `Medium` — the
   * widened case always supplies its own table, so these two are never mixed.
   */
  const table = (options ??
    (MEDIUM_OPTIONS as readonly MediumSelectorOption<string>[])) as readonly MediumSelectorOption<T>[];

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Showing ${labelFor(value, table, labels)}`}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          if (!anchored) {
            setOpen(true);
            return;
          }
          // Measured on every open, because the row can have scrolled since the last one.
          // A view that cannot be measured, or whose measurement never answers, still
          // opens — near the top of the screen — so the control can never go dead.
          let settled = false;
          const openAt = (at: { x: number; y: number; height: number } | null) => {
            if (settled) return;
            settled = true;
            setAnchor(at);
            setMenuHeight(null);
            setOpenedAt(windowKey);
            setOpen(true);
          };
          const node = trigger.current;
          if (!node?.measureInWindow) {
            openAt(null);
            return;
          }
          node.measureInWindow((x, y, _width, height) => openAt({ x, y, height }));
          setTimeout(() => openAt(null), MEASURE_TIMEOUT_MS);
        }}
        style={
          size === 'section' || anchored
            ? styles.buttonSection
            : size === 'nav'
              ? styles.buttonNav
              : styles.button
        }
        testID={testID}
      >
        <View style={styles.row} ref={trigger} collapsable={false}>
          {anchored ? (
            <Text
              variant={size === 'heading' ? 'headline' : 'subhead'}
              tone={size === 'heading' ? 'primary' : 'secondary'}
              numberOfLines={1}
              style={styles.title}
            >
              {labelFor(value, table, labels)}
            </Text>
          ) : size === 'section' ? (
            // Uppercased as a *style*, exactly as `SectionHeader` does it — the accessible
            // label on the Pressable carries the readable spelling, so a screen reader is
            // not made to spell out "T H I S  M O N T H".
            <Text variant="sectionHeader" tone="action">
              {labelFor(value, table, labels).toUpperCase()}
            </Text>
          ) : (
            // `flexShrink` so a long label (For You's `Recommended Movies`, at a large text
            // size, on a narrow phone) wraps inside the row instead of pushing the chevron
            // off the screen. A label that fits is laid out exactly as before.
            <Text variant={size === 'nav' ? 'title2' : 'title1'} style={styles.title}>
              {labelFor(value, table, labels)}
            </Text>
          )}
          <Ionicons
            name="chevron-down"
            size={
              size === 'title'
                ? theme.layout.icon.md
                : size === 'filter'
                  ? CHEVRON_FILTER
                  : size === 'heading'
                    ? CHEVRON_HEADING
                    : theme.layout.icon.sm
            }
            color={size === 'section' ? theme.semantic.action : theme.text.secondary}
          />
        </View>
      </Pressable>

      {anchored ? (
        <Modal
          visible={open}
          transparent
          animationType="fade"
          onRequestClose={() => setOpen(false)}
          statusBarTranslucent
        >
          {/* A clear scrim: a tap anywhere outside the menu closes it, and the page stays
              as it was behind a menu this small. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
            accessibilityLabel="Close"
          />
          <View
            accessibilityRole="menu"
            testID={testID ? `${testID}-menu` : undefined}
            onLayout={(event) => setMenuHeight(event.nativeEvent.layout.height)}
            style={[
              styles.menu,
              menuPosition(anchor, win, insets, menuHeight),
              // Unseen for the one frame before its height is known, so it never shows
              // in a place it is about to leave.
              menuHeight === null && styles.unplaced,
            ]}
          >
            <ScrollView bounces={false} contentContainerStyle={styles.menuList}>
              {table.map((option) => {
                const selected = option.id === value;
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected }}
                    accessibilityLabel={labelFor(option.id, table, labels)}
                    onPress={() => {
                      setOpen(false);
                      if (!selected) onChange(option.id);
                    }}
                    style={({ pressed }) => [
                      styles.menuOption,
                      selected && styles.optionSelected,
                      pressed && styles.menuPressed,
                    ]}
                  >
                    <Text
                      variant="callout"
                      tone={selected ? 'action' : 'primary'}
                      style={styles.title}
                    >
                      {labelFor(option.id, table, labels)}
                    </Text>
                    {selected ? (
                      <Ionicons
                        name="checkmark"
                        size={theme.layout.icon.sm}
                        color={theme.semantic.action}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </Modal>
      ) : (
        <Modal
          visible={open}
          transparent
          animationType="fade"
          onRequestClose={() => setOpen(false)}
          /**
           * `Sheet`'s treatment, and the reason it was missing here was that this modal
           * predates it. Without it an Android modal is laid out *below* the status bar,
           * so the scrim stopped short of the top of the screen and the bar kept the
           * page's colour over a dimmed page — the one sheet in the app that did not dim
           * the whole screen (pre-GTM audit, 2026-09-07).
           */
          statusBarTranslucent
        >
          <Pressable
            style={styles.scrim}
            onPress={() => setOpen(false)}
            accessibilityLabel="Close"
          >
            {/* Stops a tap inside the sheet from closing it. */}
            <Pressable
              style={[styles.sheet, { paddingBottom: bottomPadding }]}
              onPress={() => {}}
            >
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
      )}
    </>
  );
}

/** How long an open waits for the control's position before using the fallback. */
const MEASURE_TIMEOUT_MS = 120;
const CHEVRON_HEADING = 18;
const CHEVRON_FILTER = 16;
/** The anchored menu's width, and the space it keeps from the control above it. */
const MENU_WIDTH = 220;
const MENU_GAP = theme.space[1];

/**
 * Where the anchored menu goes: under the control, its left edge on the control's, inside
 * the gutters — and always inside the window (independent review 1). If it does not fit
 * below the control it opens above it; if it fits neither way it is pinned to the window's
 * foot and scrolls, its height capped by the safe area. An unmeasured control (a test
 * renderer, a view not laid out yet) opens near the top.
 */
export function menuPosition(
  anchor: { x: number; y: number; height: number } | null,
  window: { width: number; height: number },
  insets: { top: number; bottom: number },
  menuHeight: number | null,
) {
  const width = Math.min(MENU_WIDTH, window.width - theme.layout.gutter * 2);
  const topBound = insets.top + MENU_GAP;
  const bottomBound = window.height - insets.bottom - MENU_GAP;
  const maxHeight = Math.max(0, bottomBound - topBound);
  const height = Math.min(menuHeight ?? 0, maxHeight);
  if (!anchor) {
    return {
      top: Math.max(topBound, Math.min(theme.space[10] * 2, bottomBound - height)),
      left: theme.layout.gutter,
      width,
      maxHeight,
    };
  }
  const left = Math.max(
    theme.layout.gutter,
    Math.min(anchor.x, window.width - theme.layout.gutter - width),
  );
  const below = anchor.y + anchor.height + MENU_GAP;
  const above = anchor.y - MENU_GAP - height;
  const top =
    below + height <= bottomBound
      ? below
      : above >= topBound
        ? above
        : Math.max(topBound, bottomBound - height);
  return { top, left, width, maxHeight };
}

const styles = StyleSheet.create({
  button: {
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.layout.gutter,
    justifyContent: 'center',
  },
  // No gutter of its own: a section-sized control sits inside a row the caller has
  // already padded, where the title-sized one is measuring from the screen edge.
  buttonNav: {
    minHeight: theme.layout.minTapTarget,
    paddingLeft: theme.layout.gutter,
    justifyContent: 'center',
  },
  buttonSection: { minHeight: theme.layout.minTapTarget, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  title: { flexShrink: 1 },
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
    // `paddingBottom` is set inline from the safe-area inset — see `bottomPadding`.
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
  menu: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.card,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    ...theme.elevation.e2,
  },
  menuList: { padding: theme.space[1], gap: 2 },
  unplaced: { opacity: 0 },
  menuOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
  },
  menuPressed: { opacity: 0.7 },
});
