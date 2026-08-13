import { Tabs } from 'expo-router';

import { theme } from '@/ui/tokens';

/**
 * Feed · Collection · + · Recommendations · Profile — founder decision,
 * 2026-08-13, superseding Provisional INF-4. See docs/design/screens.md §2.
 *
 * Collection holds Ranked, Logged, Watchlist, and Lists. The centre + is the
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
        tabBarStyle: {
          backgroundColor: theme.surface.raised,
          borderTopColor: theme.border.hairline,
        },
        tabBarLabelStyle: theme.typography.caption,
      }}
    >
      <Tabs.Screen name="feed" options={{ title: 'Feed' }} />
      <Tabs.Screen name="collection" options={{ title: 'Collection' }} />
      <Tabs.Screen name="log" options={{ title: 'Log' }} />
      <Tabs.Screen name="recommendations" options={{ title: 'For you' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}
