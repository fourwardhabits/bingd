import {
  DMSerifDisplay_400Regular,
  DMSerifDisplay_400Regular_Italic,
} from '@expo-google-fonts/dm-serif-display';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from '@expo-google-fonts/inter';
import * as Sentry from '@sentry/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack, useNavigationContainerRef } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, AuthStatusOverlay, useAuthRouting } from '@/features/auth';
import { useRedeemPendingInvite } from '@/features/invite';
import { initAnalytics } from '@/lib/analytics';
import { initMonitoring, navigationIntegration } from '@/lib/monitoring';
import { createQueryClient, startQueryFocusTracking } from '@/lib/query';
import { startUpdateChecks } from '@/lib/updates';
import { theme } from '@/ui/tokens';

// Before the first render, so a crash during startup is still reported. Both
// calls are no-ops when their keys are absent, which is how the project runs
// with no Sentry or PostHog account at all.
initMonitoring();
initAnalytics();

SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden, or the module is unavailable in this environment.
});

function RootLayout() {
  // Bundled as local assets and never fetched at runtime — the failure the
  // brand SVGs currently have (PRD §5).
  const [fontsLoaded, fontError] = useFonts({
    DMSerifDisplay_400Regular,
    DMSerifDisplay_400Regular_Italic,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });

  const [queryClient] = useState(createQueryClient);
  const navigationRef = useNavigationContainerRef();

  // Gives Sentry the route names behind an error. Paths carry ids rather than
  // titles, and query strings are stripped before send (monitoring.ts).
  useEffect(() => {
    if (navigationRef?.current) {
      navigationIntegration.registerNavigationContainer(navigationRef);
    }
  }, [navigationRef]);

  // `app_opened` used to be emitted here and has been removed. PostHog's own
  // `captureAppLifecycleEvents` already sends Application Opened for the same launch,
  // and it gets the background-to-foreground case right where a mount effect does not.
  // Two events for one launch is the duplicate-capture problem in miniature.

  useEffect(() => startUpdateChecks(), []);
  // Without this, `refetchOnWindowFocus` cannot fire at all on a phone — see
  // `startQueryFocusTracking`.
  useEffect(() => startQueryFocusTracking(), []);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SafeAreaProvider>
          <StatusBar style="dark" />
          <Navigation />
        </SafeAreaProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * Separate from RootLayout only so `useAuthRouting` sits below AuthProvider. It
 * keeps the visible route and the auth state in agreement in one place, rather
 * than each screen deciding whether it should be showing (session.tsx).
 */
function Navigation() {
  useAuthRouting();
  /**
   * An invitation opened before there was an account to attribute it to.
   *
   * Here rather than in the signup screen because there are three ways to reach a ready
   * session and only one of them passes through that screen — see the hook. It reads
   * device storage on each transition into `ready` and does nothing on the launches,
   * which are almost all of them, where there is nothing held.
   */
  useRedeemPendingInvite();

  return (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.surface.base },
          headerStyle: { backgroundColor: theme.surface.base },
          headerTintColor: theme.text.primary,
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="title/[id]" options={{ headerShown: true, title: 'Title' }} />
        <Stack.Screen name="u/[username]" options={{ headerShown: true, title: 'Profile' }} />
        {/* Reached from a cast strip. The header title is set by the screen once
            the person resolves, so it is empty here rather than "Person". */}
        <Stack.Screen name="person/[id]" options={{ headerShown: true, title: '' }} />
        <Stack.Screen name="lists/[id]" options={{ headerShown: true, title: 'List' }} />
        {/* No header and no back: it is the first thing a new account sees, and there
            is nowhere behind it to return to. Leaving is an explicit choice made on
            the screen itself. */}
        <Stack.Screen name="onboarding/taste" options={{ headerShown: false }} />
        <Stack.Screen
          name="settings"
          options={{ presentation: 'modal', headerShown: true, title: 'Settings' }}
        />
      </Stack>
      <AuthStatusOverlay />
    </>
  );
}

// Sentry.wrap is what catches render errors in the tree below it. It is a no-op
// when Sentry was never initialised.
export default Sentry.wrap(RootLayout);
