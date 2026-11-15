import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { BrandLockup, LOCKUP_TOP_MARGIN } from './BrandLockup';
import { Text } from './Text';

export type AppHeaderProps = {
  right?: ReactNode;
  /**
   * The inbox, when this header belongs to a screen that should offer it.
   *
   * Passed rather than read here, because `AppHeader` lives in `ui/` and reaching into
   * a feature hook from it would invert the dependency the directory split exists to
   * hold. The count is the caller's to compute, which also means each screen decides
   * what it counts.
   */
  notifications?: { count: number; onPress: () => void };
  /**
   * Settings, as a gear to the *left* of the bell.
   *
   * It was a text button called "Settings" and it displaced the bell, so the one
   * control that is meant to sit in the same corner on every screen did not. A glyph
   * of the same size, in the same row, keeps the bell where a reader has learned to
   * find it and costs the header nothing.
   */
  settings?: { onPress: () => void };
  /**
   * A back chevron before the lockup, for a pushed page that wears the tabs' header rather
   * than the stack's (My lists, founder Preview QA, 2026-11-07). A full 44pt target.
   */
  back?: { onPress: () => void };
};

/**
 * The top of a root tab: the bingd. lockup on the left, one screen's own control on the
 * right, at the same height on all five.
 *
 * **What sits on the right** (founder, UI cohesion pass, 2026-11-06):
 * - Feed: the notification bell, which is where the inbox lives.
 * - Collection and For You: their Movies | TV switch, passed as `right`.
 * - Profile: the Settings gear alone. Its second bell went; notifications stay on Feed.
 * - Search: nothing.
 *
 * Pushed screens use `Stack.Screen`'s own header and never this component, so nothing
 * here can displace a Back control.
 */
export function AppHeader({ right, notifications, settings, back }: AppHeaderProps) {
  return (
    <View style={styles.wrap} accessibilityRole="header" testID="app-header">
      {back ? (
        <View style={styles.left}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={back.onPress}
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}
            testID="app-header-back"
          >
            <Ionicons name="chevron-back" size={theme.layout.icon.md} color={theme.text.primary} />
          </Pressable>
          <BrandLockup size="sm" />
        </View>
      ) : (
        <BrandLockup size="sm" />
      )}
      <View style={styles.right}>
        {settings ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={settings.onPress}
            hitSlop={theme.space[3]}
            style={({ pressed }) => [styles.bell, pressed && styles.pressed]}
          >
            <Ionicons
              name="settings-outline"
              size={theme.layout.icon.md}
              color={theme.text.secondary}
            />
          </Pressable>
        ) : null}
        {notifications ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              notifications.count > 0
                ? `Notifications, ${notifications.count} waiting`
                : 'Notifications'
            }
            onPress={notifications.onPress}
            hitSlop={theme.space[3]}
            style={({ pressed }) => [styles.bell, pressed && styles.pressed]}
          >
            <Ionicons
              name={notifications.count > 0 ? 'notifications' : 'notifications-outline'}
              size={theme.layout.icon.md}
              color={notifications.count > 0 ? theme.semantic.action : theme.text.secondary}
            />
            {/* A count rather than a dot, and it is the unread count: the founder's
                words for this control are "bell with unread badge", and the number a
                bell carries everywhere else is how much is waiting to be read. It can
                reach zero, which is what makes it worth showing — the inbox has a Mark
                all read, and a badge nothing clears is a badge people stop seeing.

                Settings' own row still says how many *requests* are pending, because
                that is a different statement: news is unread, a request is a task. */}
            {notifications.count > 0 ? (
              <View style={styles.badge}>
                <Text variant="caption" tone="action" allowFontScaling={false}>
                  {notifications.count > 9 ? '9+' : notifications.count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
        {/* On the logo's centre line, not the row's (founder, nav cohesion sprint,
            2026-11-06). The lockup carries a top margin, so a centred row puts the
            mark half that margin below the switch's centre. A transform, so the header's
            height and every touch target stay where they were. Collection and For You. */}
        {right ? <View style={styles.rightSlot}>{right}</View> : null}
      </View>
    </View>
  );
}

/**
 * **The bell's box, which every tab's right side now reserves** (founder final polish,
 * 2026-11-04: "the logo appears at the same vertical position on every tab").
 *
 * The lockup is centred in this row, so the row's height decides where the logo sits.
 * The bell's pressable (a 24pt glyph inside 4pt of padding) came out about 2pt taller than
 * the lockup, which made Feed and Profile 2pt taller than For You, Collection and Search,
 * and put their logo 1pt lower. Reserving the bell's height on every tab, with or without
 * a bell, gives all five the same row. The row's share of it is fixed at this height so
 * that a platform drawing the glyph a little taller cannot reopen the difference; the box
 * itself is now `ACTIONS_BOX`, a 44pt minimum that bleeds back to this height (below).
 * The bell is centred in it and its hit area (`hitSlop`) is unchanged.
 */
const ACTIONS_HEIGHT = 34;
/**
 * **The right side's box is a full 44pt, and still takes 34pt of the row.**
 *
 * Collection's and For You's Movies | TV halves are 44pt presses, and a press never
 * answers outside its parent's bounds: in a 34pt box their top and bottom 5pt were dead
 * on Android. So the box is 44pt tall with 5pt pulled back above and below, into the
 * header's own padding. The row lays out exactly as it did, the logo stays where it was
 * on every tab, and the presses sit wholly inside a parent that contains them. A minimum
 * rather than a fixed height, so a switch grown by a large system text size enlarges the
 * header instead of being cut.
 */
const ACTIONS_BOX = 44;
const ACTIONS_BLEED = (ACTIONS_BOX - ACTIONS_HEIGHT) / 2;

const styles = StyleSheet.create({
  left: { flexDirection: 'row', alignItems: 'center' },
  // The glyph's own edge on the gutter: the 44pt cell reaches 10pt past it to the left.
  back: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    marginLeft: -(theme.layout.minTapTarget - theme.layout.icon.md) / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /**
   * **4pt more below the logo, and the same above it** (founder final polish, 2026-11-04).
   *
   * Only the bottom grew: the top inset is what keeps the logo clear of the Android
   * status bar, so the bar breathes below its content rather than moving it up.
   */
  /**
   * **Wraps, and only when it must** (independent review, UI cohesion pass, 2026-11-06).
   * Movies | TV beside the lockup fits every phone at ordinary text sizes; at the largest
   * system sizes on a 320–360pt phone the two together are wider than the row. The right
   * side then moves to a line of its own, still right-aligned and wholly inside the header,
   * rather than overlapping the logo or leaving part of a target outside its parent.
   */
  wrap: {
    minHeight: theme.layout.control.headerHeight,
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    paddingBottom: theme.space[2] + theme.space[1],
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    rowGap: theme.space[2],
  },
  // Grows into the rest of the row, from its own content's width rather than from zero:
  // a zero basis would let it shrink under its control instead of wrapping. With nothing
  // wide inside, the icons end up exactly where `space-between` used to leave them.
  right: {
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: 'auto',
    minHeight: ACTIONS_BOX,
    marginVertical: -ACTIONS_BLEED,
    justifyContent: 'flex-end',
    marginLeft: theme.space[4],
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
  },
  bell: { padding: theme.space[1] },
  rightSlot: { transform: [{ translateY: LOCKUP_TOP_MARGIN / 2 }] },
  /**
   * Parchment carrying Maroon, outlined in it — the founder's correction, and the
   * inverse of the pair it replaced.
   *
   * It was a solid Maroon disc with Parchment on it, which is the score badge's
   * treatment: the app's loudest mark, spent on a count that is subordinate to the
   * bell it sits on. Turning the pair around keeps the same certified 7.4:1 contrast
   * (design-system.md §3 — the same two colours, swapped) while letting the glyph stay
   * the thing the eye lands on. The ring is what keeps it legible where the badge
   * overlaps the bell's own dark strokes, which a bare Parchment disc would not.
   */
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: theme.radius.full,
    backgroundColor: theme.surface.sunken,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.semantic.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
});
