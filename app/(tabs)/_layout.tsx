import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '@/ui/tokens';

/**
 * The bar's own height, before the system inset is added to it.
 *
 * 49 is React Navigation's iOS figure and is left alone there. Android gets 56: the
 * icons are the same size, but the gesture pill or the three-button strip sits
 * directly under the bar rather than beside it, and 49 leaves the labels touching it.
 */
const TAB_BAR_HEIGHT = Platform.OS === 'android' ? 56 : 49;

/**
 * Feed · Collection · Search · Recommendations · Profile — founder decision,
 * 2026-08-13, superseding Provisional INF-4. See docs/design/screens.md §2.
 *
 * Collection holds Ranked, Watched, Watchlist, and Lists.
 *
 * **The centre tab is Search, and was called Log.** The rename is the founder's, and
 * the reasoning is that the surface is where you *find* something — a title or a
 * member — and logging is what happens after you have chosen one. Calling it Log named
 * the second step and hid the first, which is also why member search sat behind a chip
 * nobody had a reason to press.
 *
 * The icon moved with the label: a `+` under the word Search describes neither, and the
 * centre position is what carries the "this is the thing you do most" weight rather
 * than the glyph. The route is still `log` — renaming a file to match a label is a
 * deep-link and history change bought for nothing.
 */
export default function TabsLayout() {
  const insets = useSafeAreaInsets();

  /**
   * SDK 57 draws Android edge to edge, so the tab bar's box reaches the bottom of the
   * display and the system navigation sits over its lower strip. The bar has to be
   * tall enough to hold both: its own content, and the inset underneath it.
   *
   * The previous version set no height at all, reasoning that any height overrides the
   * navigator's `49 + insets.bottom` and stops the bar covering the system navigation.
   * That was right about the failure and wrong about the remedy — the answer is not to
   * omit the height but to put the inset *into* it. A height without the inset crops
   * the bar; a height with it keeps the coverage and lifts the icons clear.
   *
   * `paddingBottom` is what actually moves the content up; the height is what stops
   * that padding eating the icons. Both are needed, and on iOS neither is: the
   * navigator is already correct there, and overriding it would only add a second
   * opinion for no gain.
   */
  const androidInsets =
    Platform.OS === 'android'
      ? {
          height: TAB_BAR_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
          paddingTop: theme.space[1],
        }
      : null;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.semantic.action,
        tabBarInactiveTintColor: theme.text.tertiary,
        tabBarStyle: {
          backgroundColor: theme.surface.raised,
          borderTopColor: theme.border.hairline,
          ...androidInsets,
        },
        tabBarLabelStyle: theme.typography.caption,
      }}
    >
      <Tabs.Screen
        name="feed"
        options={{
          title: 'Feed',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? 'newspaper' : 'newspaper-outline'}
              size={theme.layout.icon.md}
              color={focused ? theme.semantic.action : theme.text.tertiary}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="collection"
        options={{
          title: 'Collection',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? 'albums' : 'albums-outline'}
              size={theme.layout.icon.md}
              color={focused ? theme.semantic.action : theme.text.tertiary}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="log"
        options={{
          title: 'Search',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? 'search' : 'search-outline'}
              size={theme.layout.icon.lg}
              color={focused ? theme.semantic.action : theme.text.tertiary}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="recommendations"
        options={{
          title: 'For you',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? 'sparkles' : 'sparkles-outline'}
              size={theme.layout.icon.md}
              color={focused ? theme.semantic.action : theme.text.tertiary}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? 'person-circle' : 'person-circle-outline'}
              size={theme.layout.icon.md}
              color={focused ? theme.semantic.action : theme.text.tertiary}
            />
          ),
        }}
      />
    </Tabs>
  );
}
