import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/ui/components';
import { LABEL_EM_PER_CHAR } from '@/ui/components/ActionPair';
import { hapticSelection } from '@/ui/haptics';
import { fontFamily, theme } from '@/ui/tokens';

/**
 * For You's two feature entry points, **Sent to You and Find for a Group** (founder, nav
 * cohesion sprint, 2026-11-06; Find for a Group since the title-page sprint the same day).
 *
 * They are features, not filters, and they used to be drawn as two more chips in the
 * Filters row. Now they are a pair of their own under the page's heading row: equal
 * halves, a Maroon icon and word, a feature hairline (`actionSubtle`) and no card fill.
 * Filters moved up beside the heading as a quiet text action, so the three no longer read
 * as equivalent pills, and the page is still two rows of controls above the wall.
 *
 * Sent to You keeps its toggle (Parchment and a Maroon outline while the wall shows the
 * sent list) and its unread count, now a badge drawn like the bell's. Find for a Group opens
 * its sheet. Each is a 44pt target.
 *
 * **Quieter since the marquee cohesion sprint** (2026-11-07): they competed with the wall.
 * 34pt drawn rather than 40 (still 44pt to press), a hairline outline rather than the
 * Maroon one, a 16pt glyph and a 13pt label in ink. The glyph keeps the Maroon.
 *
 * **One row whenever both labels genuinely fit, stacked only when they do not** (founder QA
 * B7, 2026-11-15). The founder ruled out clipping or abbreviating them (title-page sprint,
 * 2026-11-06), and the pair used to keep that promise with two blunt rules, stacking below a
 * 340pt window or from a 1.2 text size, which stacked them on a 320pt phone at the default
 * size where both fit with room to spare. Now the decision is made the way `ActionPair` and
 * `RankingSheet`'s reveal exits make it: each label's advance read from Inter Medium
 * (`SHORTCUT_LABEL_EM`, re-measured from the font file by `ForYouShortcuts.test.tsx`) at
 * the reader's text size, plus the glyph, the badge actually drawn and the padding, against
 * the half the row really has. See {@link shortcutsLayout} for the order it tries things in.
 */
export type ForYouShortcut = {
  key: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  accessibilityLabel?: string;
  /** Unread items, drawn as a badge; a string so `12+` can say "at least". */
  badge?: string | null;
  /** A toggle's state. Absent for a shortcut that opens something. */
  selected?: boolean;
  onPress: () => void;
};

/**
 * Each label's advance width in Inter Medium (`fontFamily.sansMedium`), in em, measured from
 * the font file. `ForYouShortcuts.test.tsx` re-measures them, so the table cannot drift from
 * the font; a label not in it falls back to `ActionPair`'s per-character estimate, which was
 * set above SemiBold's widest average and so errs toward stacking in the lighter weight.
 */
export const SHORTCUT_LABEL_EM: Record<string, number> = {
  'Sent to You': 5.555,
  'Find for a Group': 7.757,
};

/**
 * A badge's characters, per character, in Inter Medium: at or above the widest of what a
 * badge can say (digits at most 0.656em, `+` 0.667, `New` 0.724 on average), so a badge is
 * never estimated narrower than it draws. The test checks it against the font too.
 */
export const BADGE_EM_PER_CHAR = 0.75;

/** The padding each half wants, and the floor it gives up to before the pair stacks. */
export const SHORTCUT_PADDING = theme.space[3];
export const SHORTCUT_MIN_PADDING = theme.space[1];

/**
 * The room the shortcuts row does not get from the window, besides the safe area: its own
 * page gutter either side, and the gap between the halves.
 */
const ROW_CHROME = theme.layout.gutter * 2 + theme.space[2];

/** 4% over the measured advance, for hinting and rounding (as `ActionPair`, `RankingSheet`). */
const ADVANCE_MARGIN = 1.04;
/** The outline's `hairlineWidth * 2`, at its 1pt maximum on any device, either side. */
const BORDER = 1;
const LABEL_SIZE = theme.typography.footnote.fontSize;
const BADGE_SIZE = theme.typography.caption.fontSize;
const BADGE_MIN_WIDTH = 18;
const BADGE_PADDING = 4;

/** The badge's drawn width. It does not scale with the text size (`allowFontScaling`). */
function badgeWidth(badge: string) {
  const text =
    badge.length * (BADGE_EM_PER_CHAR * BADGE_SIZE + theme.typography.caption.letterSpacing);
  return Math.max(BADGE_MIN_WIDTH, text + 2 * BADGE_PADDING + 2 * BORDER);
}

/**
 * The natural width of one shortcut at this text size and side padding: outline, padding,
 * glyph, gap, label and, when one is drawn, gap and badge. Exported for the layout tests:
 * jest has no text layout, so the arithmetic is what can be pinned.
 */
export function shortcutWidth(
  shortcut: Pick<ForYouShortcut, 'label' | 'badge'>,
  fontScale: number,
  padding: number,
) {
  const em = SHORTCUT_LABEL_EM[shortcut.label] ?? shortcut.label.length * LABEL_EM_PER_CHAR;
  const label = em * LABEL_SIZE * fontScale * ADVANCE_MARGIN;
  const badge = shortcut.badge ? GAP + badgeWidth(shortcut.badge) : 0;
  return 2 * BORDER + 2 * padding + GLYPH + GAP + label + badge;
}

/**
 * **How the pair is laid out in this window** (founder QA B7, 2026-11-15), in the order the
 * founder asked for:
 *
 * 1. Two equal halves at the padding they want (`space[3]`).
 * 2. Two equal halves at the floor (`space[1]`, what the halves always had), before giving up
 *    the row. The content is centred, so this only ever costs air at the half's edges.
 * 3. Stacked, one full-width row each, only when a label cannot fit its half even then.
 *
 * Never a smaller label: the text keeps the reader's size, unabbreviated.
 *
 * `horizontalInset` is what the window spends besides the row's own gutters and gap: the
 * `Screen`'s left and right safe-area edges, which For You's `Screen` applies (zero on a
 * portrait phone, a notch's width in landscape).
 *
 *     half = (window - insets - 2 * gutter - gap) / 2 = (W - insets - 40) / 2
 *     W     320    340    360    375    430
 *     half  140    150    160    167.5  195
 *
 * `Find for a Group` (7.757em) is the wider label, and binds unless Sent to You carries a
 * wide badge: 134.9pt at fontScale 1 on the floor, 150.9 at `space[3]`. So, with no badge
 * or one of up to two digits (`12` makes Sent to You 137.5pt on the floor):
 *
 *     fontScale   one row at                         stacked at
 *     1           320–341 on the floor, 342+ at 12   never on a phone
 *     1.1         340+                               320
 *     1.2         360+                               320, 340
 *     1.3         375+ (the floor below 414)         320, 340, 360
 *     1.6, 2      never on a phone (430 is 2.8 short) every width
 *
 * The widest badges, `New` (37.6pt as estimated) and `200+` (46.8), stack a 320pt phone at
 * the default size, and `200+` a 340 one. The badge drawn is the badge measured, so the
 * pair can change shape when it does; only those two can make it, and only near a boundary.
 */
export function shortcutsLayout(
  shortcuts: readonly Pick<ForYouShortcut, 'label' | 'badge'>[],
  windowWidth: number,
  fontScale: number,
  horizontalInset = 0,
): { stacked: boolean; padding: number } {
  const half = (windowWidth - horizontalInset - ROW_CHROME) / 2;
  for (const padding of [SHORTCUT_PADDING, SHORTCUT_MIN_PADDING]) {
    if (shortcuts.every((shortcut) => shortcutWidth(shortcut, fontScale, padding) <= half)) {
      return { stacked: false, padding };
    }
  }
  return { stacked: true, padding: SHORTCUT_PADDING };
}

export function ForYouShortcuts({ shortcuts }: { shortcuts: readonly ForYouShortcut[] }) {
  const { fontScale, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { stacked, padding } = shortcutsLayout(
    shortcuts,
    width,
    fontScale,
    insets.left + insets.right,
  );
  if (shortcuts.length === 0) return null;

  return (
    <View
      style={[styles.row, stacked && styles.stacked]}
      testID="for-you-shortcuts"
      accessibilityLabel="For You features"
    >
      {shortcuts.map((shortcut) => {
        const toggle = shortcut.selected !== undefined;
        return (
          <Pressable
            key={shortcut.key}
            accessibilityRole="button"
            accessibilityLabel={shortcut.accessibilityLabel ?? shortcut.label}
            accessibilityState={toggle ? { selected: shortcut.selected } : undefined}
            onPress={() => {
              hapticSelection();
              shortcut.onPress();
            }}
            hitSlop={HIT_SLOP}
            testID={`for-you-shortcut-${shortcut.key}`}
            style={({ pressed }) => [
              styles.shortcut,
              { paddingHorizontal: padding },
              !stacked && styles.half,
              shortcut.selected && styles.selected,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons name={shortcut.icon} size={GLYPH} color={theme.semantic.action} />
            {/* One line in a half, which the measurement above guarantees fits; free to
                wrap when stacked, for the largest accessibility sizes on the narrowest
                phones, rather than shrink or clip. The mild fit in a half is only a net
                under the 4% allowance, not a way to make a label fit. */}
            <Text
              variant="footnote"
              tone={shortcut.selected ? 'action' : 'primary'}
              {...(stacked
                ? {}
                : { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.9 })}
              style={styles.label}
            >
              {shortcut.label}
            </Text>
            {shortcut.badge ? (
              <View style={styles.badge} accessibilityElementsHidden>
                <Text variant="caption" tone="action" allowFontScaling={false}>
                  {shortcut.badge}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** 34pt drawn, 44pt pressed. */
const HEIGHT = 34;
const GLYPH = 16;
const GAP = theme.space[1];
/**
 * The 10pt that makes 34 into 44, split so that every point of it is inside the row: a press
 * never answers outside its parent's bounds (`CompactSwitch`), so a slop taller than the
 * row's 4pt top padding would lose its overhang. 4 above, 6 below, inside the row's
 * `space[1]` and `space[3]`.
 */
const SLOP_TOP = theme.space[1];
const SLOP_BOTTOM = theme.layout.minTapTarget - HEIGHT - SLOP_TOP;
const HIT_SLOP = { top: SLOP_TOP, bottom: SLOP_BOTTOM };

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: SLOP_TOP,
    paddingBottom: theme.space[3],
  },
  // Stacked, the gap is the two slops end to end, so they meet without crossing and each
  // half keeps its whole 44pt (the rule `chipHitSlop` follows across a chip row).
  stacked: { flexDirection: 'column', gap: SLOP_TOP + SLOP_BOTTOM },
  shortcut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: GAP,
    minHeight: HEIGHT,
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
  },
  half: { flex: 1, flexBasis: 0 },
  selected: { borderColor: theme.semantic.action, backgroundColor: theme.surface.sunken },
  label: { flexShrink: 1, fontFamily: fontFamily.sansMedium },
  // The bell's badge, in line rather than on a corner: Parchment, a Maroon ring and numeral.
  badge: {
    minWidth: BADGE_MIN_WIDTH,
    height: 18,
    paddingHorizontal: BADGE_PADDING,
    borderRadius: theme.radius.full,
    backgroundColor: theme.surface.sunken,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.semantic.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
});
