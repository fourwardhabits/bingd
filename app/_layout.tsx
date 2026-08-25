import {
  DMSerifDisplay_400Regular,
  DMSerifDisplay_400Regular_Italic,
} from '@expo-google-fonts/dm-serif-display';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import * as Sentry from '@sentry/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack, useNavigationContainerRef } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  AuthProvider,
  AuthStatusOverlay,
  RouteErrorBoundary,
  useAuth,
  useAuthRouting,
} from '@/features/auth';
import { useRedeemPendingInvite } from '@/features/invite';
import { configurePushPresentation } from '@/features/notifications/push';
import { usePush } from '@/features/notifications/use-push';
import { initAnalytics } from '@/lib/analytics';
import { initMonitoring, navigationIntegration } from '@/lib/monitoring';
import { createQueryClient, startQueryFocusTracking } from '@/lib/query';
import { startUpdateChecks } from '@/lib/updates';
import { ROOT_SCREEN_TITLES, rootStackScreenOptions } from '@/ui/navigation';

// Before the first render, so a crash during startup is still reported. Both
// calls are no-ops when their keys are absent, which is how the project runs
// with no Sentry or PostHog account at all.
initMonitoring();
initAnalytics();

/**
 * How a push behaves when it arrives, which has to be decided before one can.
 *
 * At module scope beside the two above, and for the same reason: a notification can be
 * delivered to a cold-started process before the first render, and a handler registered
 * in an effect would be registered too late to say what happens to it. It asks for
 * nothing and prompts for nothing — see `usePush`, which is the half that runs under the
 * session.
 */
configurePushPresentation();

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
   * Whether the routes that assume an account may be mounted at all.
   *
   * Every screen behind this gate opens with `useCurrentProfile()`, which **throws**
   * outside a `ready` session — deliberately, so those screens need no null checks. The
   * cost, which the founder found by signing out, is that the throw is reachable:
   * `supabase.auth.signOut()` emits its state change while one of them is still
   * mounted, so the context flips and the screen re-renders and raises, in the same
   * commit, before `useAuthRouting`'s effect can move anybody. With no error boundary
   * anywhere in the app that unmounted the whole tree and left a blank screen — and
   * "sometimes" only because it raced the `router.replace` in the sign-out handler.
   *
   * `Stack.Protected` removes those screens from the navigator in the same render the
   * status changes, so the throw is not reached rather than merely survived. It covers
   * the involuntary exits too, which no handler could: an expired refresh token and
   * `delete_account` both end a session with nobody having pressed Sign out.
   *
   * `(auth)` is deliberately outside it. That group is where a signed-out person
   * belongs, and gating it would leave the router with nowhere to send them.
   *
   * ---------------------------------------------------------------------------
   * **THE GUARD IS NOT THE WHOLE ANSWER, AND `resolved` IS THE REST OF IT**
   *
   * A guard alone has to choose between two wrong things while the session is still
   * loading, which independent reviews 43 and 43b found in turn.
   *
   * Guard on `ready` and the protected routes are absent for the first few hundred
   * milliseconds of *every* launch — so a launch carrying a URL (`bingd://activity/…`, a
   * shared `/u/` link) has that URL arrive while the route it names does not exist. The
   * navigator resolves it somewhere else and nothing brings it back.
   *
   * Guard on `!== 'signed-out'` instead and the routes are present, but they render with
   * no profile: `useCurrentProfile` throws, `RouteErrorBoundary` catches, and recovering
   * unmounts and remounts the navigator underneath the deep link. Better than the blank
   * screen it replaced, and still not a mechanism anybody should rely on.
   *
   * The mistake in both is the same: trying to answer "which routes exist" while the
   * question "who is this" has no answer yet. So the navigator is not mounted at all
   * until it does. **This file already does exactly that one screen up** — `RootLayout`
   * returns null until the fonts resolve — and deep links have always survived it,
   * because the URL lives in the router's store rather than in the navigator's state.
   *
   * Once mounted, `signedIn` is a settled fact and the guard is simple.
   */
  const auth = useAuth();
  /**
   * `loading` is not knowing; `error` is knowing that we could not find out. Neither is a
   * state any route below can be drawn in, and `AuthStatusOverlay` renders both — a
   * loading screen and a retry — over the space the navigator would occupy, so the person
   * sees the same thing they saw before.
   */
  const resolved = auth.status !== 'loading' && auth.status !== 'error';
  const signedIn = auth.status === 'ready';
  /**
   * An invitation opened before there was an account to attribute it to.
   *
   * Here rather than in the signup screen because there are three ways to reach a ready
   * session and only one of them passes through that screen — see the hook. It reads
   * device storage on each transition into `ready` and does nothing on the launches,
   * which are almost all of them, where there is nothing held.
   */
  useRedeemPendingInvite();
  /**
   * The push lifecycle: register a device that already has permission, follow a token
   * that rolls, refresh the inbox on arrival, route a tap, and nudge the sender when the
   * app comes forward.
   *
   * Here rather than in a screen because two of those are process-wide — a tap can start
   * the app cold, and a token can roll on any screen — and because it must sit under
   * `AuthProvider`, whose session is what a registration belongs to. **It never asks for
   * permission**; that is `offerPushPermission`, called from the two social moments PRD
   * §15 names.
   */
  usePush();

  return (
    <>
      {/* `headerBackTitle` is in `rootStackScreenOptions`, and the reason it had to
          move there is the `‹ (tabs)` the founder photographed on a title page — see
          `ui/navigation.ts`. The titles come from `ROOT_SCREEN_TITLES` for the same
          reason: on iOS a route's title is the back label of whatever is pushed on top
          of it, so they are an invariant worth asserting rather than seven strings
          spread down a JSX tree. */}
      {/* Not mounted until the session has resolved. See `resolved` above: this is the
          same withholding `RootLayout` already does for the fonts, and for the same
          reason — a tree that cannot be drawn correctly yet should not be drawn. The
          URL survives it, because the router's store holds the destination and the
          navigator derives its state from that store when it mounts. */}
      {resolved ? (
        <RouteErrorBoundary resetKey={auth.status}>
          <Stack screenOptions={rootStackScreenOptions}>
            {/* Always available, and the only group that is: it is where a signed-out
              person belongs, and it is also what `onboarding` status routes to. */}
            <Stack.Screen name="(auth)" options={{ title: ROOT_SCREEN_TITLES['(auth)'] }} />

            <Stack.Protected guard={signedIn}>
              <Stack.Screen name="(tabs)" options={{ title: ROOT_SCREEN_TITLES['(tabs)'] }} />
              <Stack.Screen
                name="title/[id]"
                options={{ headerShown: true, title: ROOT_SCREEN_TITLES['title/[id]'] }}
              />
              <Stack.Screen
                name="u/[username]"
                options={{ headerShown: true, title: ROOT_SCREEN_TITLES['u/[username]'] }}
              />
              {/* Reached from a cast strip. The header title is set by the screen once
                the person resolves, so it is empty here rather than "Person". */}
              <Stack.Screen
                name="person/[id]"
                options={{ headerShown: true, title: ROOT_SCREEN_TITLES['person/[id]'] }}
              />
              <Stack.Screen
                name="lists/[id]"
                options={{ headerShown: true, title: ROOT_SCREEN_TITLES['lists/[id]'] }}
              />
              {/* Where a comment or reply notification lands. Declared here rather than
                left to the file tree so it carries `ROOT_SCREEN_TITLES` like its
                neighbours — on iOS a route's title is the back label of whatever is
                pushed on top of it, and an undeclared route's is its directory name. */}
              <Stack.Screen
                name="activity/[id]"
                options={{ headerShown: true, title: ROOT_SCREEN_TITLES['activity/[id]'] }}
              />
              {/* No header and no back: it is the first thing a new account sees, and
                there is nowhere behind it to return to. Leaving is an explicit choice
                made on the screen itself. */}
              <Stack.Screen name="onboarding/taste" options={{ headerShown: false }} />
              <Stack.Screen
                name="settings"
                options={{
                  presentation: 'modal',
                  headerShown: true,
                  title: ROOT_SCREEN_TITLES.settings,
                }}
              />
            </Stack.Protected>
          </Stack>
        </RouteErrorBoundary>
      ) : null}
      {/* Outside the boundary, so the two states that are not a place in the app are
          still explained even if the navigator underneath them stopped. */}
      <AuthStatusOverlay />
    </>
  );
}

// Sentry.wrap is what catches render errors in the tree below it. It is a no-op
// when Sentry was never initialised.
export default Sentry.wrap(RootLayout);
