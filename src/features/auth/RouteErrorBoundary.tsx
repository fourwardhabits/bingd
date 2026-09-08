import { Component, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { errorLineFor, recordRenderError } from '@/lib/render-errors';
import { Button, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * The boundary this app did not have.
 *
 * Until now there was no error boundary anywhere in `app/` or `src/`. `Sentry.wrap`
 * looks like one and is not — it installs a touch-event boundary and a profiler, and a
 * render error passes straight through it. So **any** exception thrown during render
 * unmounted the entire React tree and left the host view empty, with no way back inside
 * that process. That is the founder's "signing out sometimes produces a blank screen,
 * sometimes crashes the app entirely": one defect, and the difference between the two
 * presentations is only how the platform reacts to an empty root.
 *
 * The specific throw is `useCurrentProfile`, which raises outside a `ready` session on
 * purpose, as a programming-error guard. Every screen in `app/` opens with it — the
 * feed, the title page, both profiles, all five settings screens. `supabase.auth
 * .signOut()` emits `SIGNED_OUT` **while one of them is still mounted**, so the context
 * flips to `signed-out` and the screen re-renders and throws, in the same commit,
 * before `useAuthRouting`'s effect can move anybody. The "sometimes" is the race
 * between that render and the `router.replace` in the sign-out handler.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS HERE AND NOT AN `ErrorBoundary` EXPORT FROM `app/_layout.tsx`
 *
 * Expo Router honours a route module that exports `ErrorBoundary`, and using it for the
 * root layout would be the obvious thing. It is the wrong thing, and the reason is what
 * has to survive the error: `useAuthRouting` and `usePush` live *in* that layout. A
 * boundary declared there wraps the component that owns them, so catching would unmount
 * the one hook whose job is to route somebody out of the state that caused the throw —
 * leaving a recovery screen with nothing to recover to.
 *
 * So this wraps the `<Stack>` and nothing above it. `useAuthRouting` keeps running,
 * observes `signed-out`, and replaces to `/(auth)/sign-in` while the boundary is
 * showing. `resetKey` is the auth status, so the moment that changes the boundary drops
 * its error and renders the navigator again — which is now correctly at the sign-in
 * screen. The recovery is automatic and needs no tap.
 *
 * The button is there for the case that is not a sign-out: a genuine render bug on some
 * screen, where the auth status never changes and nothing else is going to clear this.
 *
 * ---------------------------------------------------------------------------
 * IT IS THE SECOND LINE, NOT THE FIRST
 *
 * `app/_layout.tsx` also stops the protected screens rendering at all once auth leaves
 * `ready`, so an ordinary sign-out no longer reaches this class. Both exist because
 * they answer different questions: that one makes the known throw unreachable, and this
 * one makes *any* unknown throw survivable. A pre-RC build with no boundary at all is a
 * build where the next unhandled render error is a permanent blank screen for whoever
 * finds it.
 *
 * ---------------------------------------------------------------------------
 * **CATCHING HERE COSTS THE BACK STACK, WHICH IS WHY A ROUTE MAY CATCH FIRST**
 * (founder, physical Android, 2026-09-07)
 *
 * The report was "the title page shows the boundary, and sometimes I end up back on
 * Feed instead of on the title page". The second half is this component, and it is not a
 * navigation decision anybody wrote:
 *
 *   1. this boundary wraps `<Stack>`, so catching **unmounts the navigator** and the
 *      pushed route goes with it — there is no longer a title page to be on, and no
 *      entry behind it to go back to;
 *   2. clearing the error (Try again, or `resetKey` changing) mounts a *new* `<Stack>`,
 *      which starts at the root index;
 *   3. `nextRoute` reads the root index as `group === undefined` and returns
 *      `/(tabs)/feed` (`session.tsx`), so `useAuthRouting` replaces to the feed.
 *
 * Every step is correct on its own and the sum is a reader losing their place. The right
 * answer is not to weaken any of them: it is that a **screen's** render error should be
 * caught by the screen, inside the navigator, where the route survives and Back still
 * goes where it went before. Expo Router supports exactly that — a route module may
 * export `ErrorBoundary`, and the router wraps the route component in it. `app/title/
 * [id].tsx` does, and any screen may.
 *
 * So the layering is now: a route's own boundary catches that route's render errors and
 * keeps the stack; this one catches everything a route boundary cannot — a throw in a
 * layout, in the navigator itself, or on a screen that has not declared one — and
 * accepts the reset, because at that point there is nothing left to preserve.
 */
type Props = { children: ReactNode; resetKey: string };
type State = { error: Error | null };

export class RouteErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  /**
   * Cleared when the thing that caused it changes.
   *
   * Without this the boundary is a dead end: the error is caught, routing fixes the
   * state underneath it, and the screen keeps showing an apology for a condition that
   * has passed. Comparing in `getDerivedStateFromProps` rather than in an effect
   * because it has to happen in the same render the new key arrives in.
   */
  static getDerivedStateFromProps(props: Props, state: State & { key?: string }): State | null {
    if (state.key !== props.resetKey) {
      return { error: null, key: props.resetKey } as State;
    }
    return null;
  }

  override componentDidCatch(error: Error) {
    // Sentry *and* the flight recorder. A render error nobody can read is a crash report
    // the founder cannot ask a tester about, and Sentry is the half this project has not
    // been able to read. See `lib/render-errors.ts`.
    recordRenderError(error, 'route_render');
  }

  override render() {
    if (!this.state.error) return this.props.children;

    const line = errorLineFor(this.state.error);

    return (
      <View style={styles.fill}>
        <Text variant="title1" style={styles.centred}>
          Something went wrong
        </Text>
        <Text variant="body" tone="secondary" style={styles.centred}>
          Your films are safe. This screen stopped, not your account.
        </Text>
        {/* Beta and below. It is the difference between a report that says "the title
            page crashed" and one that names the exception, and it costs a stranger's
            build nothing because they never see it. */}
        {line ? (
          <Text testID="boundary-error" variant="caption" tone="tertiary" style={styles.centred}>
            {line}
          </Text>
        ) : null}
        <Button label="Try again" onPress={() => this.setState({ error: null })} />
      </View>
    );
  }
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface.base,
    paddingHorizontal: theme.space[5],
    gap: theme.space[3],
  },
  centred: { textAlign: 'center' },
});
