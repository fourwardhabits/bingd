import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { BrandLockup } from './BrandLockup';
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
};

/**
 * The top of a root tab.
 *
 * The bell is here rather than on one screen because the founder's correction is that
 * the inbox should be **discoverable**, and a control three taps into Settings is not.
 * It appears on every root tab and on none of the pushed screens, which is exactly what
 * keeps it from displacing a Back control: a pushed screen uses `Stack.Screen`'s own
 * header and never this component.
 */
export function AppHeader({ right, notifications, settings }: AppHeaderProps) {
  return (
    <View style={styles.wrap} accessibilityRole="header">
      <BrandLockup size="sm" />
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
        {right}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    minHeight: theme.layout.control.headerHeight,
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  right: {
    marginLeft: theme.space[4],
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
  },
  bell: { padding: theme.space[1] },
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
