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

import { initAnalytics, track } from '@/lib/analytics';
import { initMonitoring, navigationIntegration } from '@/lib/monitoring';
import { createQueryClient } from '@/lib/query';
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

  useEffect(() => {
    track({ name: 'app_opened' });
  }, []);

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
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.surface.base },
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
        </Stack>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

// Sentry.wrap is what catches render errors in the tree below it. It is a no-op
// when Sentry was never initialised.
export default Sentry.wrap(RootLayout);
