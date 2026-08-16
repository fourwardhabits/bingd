import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';

import { theme } from '@/ui/tokens';

/**
 * Feed · Collection · + · Recommendations · Profile — founder decision,
 * 2026-08-13, superseding Provisional INF-4. See docs/design/screens.md §2.
 *
 * Collection holds Ranked, Watched, Watchlist, and Lists. The centre + is the
 * log-and-rank entry point and opens directly into title search, which is why
 * there is no separate Search tab.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.semantic.action,
        tabBarInactiveTintColor: theme.text.tertiary,
        // No `height` here, deliberately. Setting one overrides the navigator's
        // own `49 + insets.bottom` and the bar stops covering the Android
        // system navigation bar, leaving its buttons on a strip of whatever is
        // behind them. The colour is all this needs to say.
        tabBarStyle: {
          backgroundColor: theme.surface.raised,
          borderTopColor: theme.border.hairline,
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
          title: 'Log',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? 'add-circle' : 'add-circle-outline'}
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
