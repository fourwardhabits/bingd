import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { errorLineFor, recordRenderError } from '@/lib/render-errors';

import { theme } from '../tokens';
import { Button } from './Button';
import { Text } from './Text';

export type ScreenErrorProps = {
  /** The exception the router caught for this route. */
  error: Error;
  /** Re-renders the route by clearing the router's error state. */
  retry: () => void | Promise<void>;
};

/**
 * What a **screen** shows when its own render threw.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND PLACE TO CATCH, WHEN `RouteErrorBoundary` ALREADY EXISTS
 *
 * Because of where the other one sits. It wraps `<Stack>` in `app/_layout.tsx`, so
 * catching there unmounts the navigator, and the pushed route the reader was on goes
 * with it — along with everything behind it. Clearing the error mounts a fresh `<Stack>`
 * at the root index, `nextRoute` reads that as `group === undefined`, and
 * `useAuthRouting` replaces to `/(tabs)/feed`. That is the whole of the founder's "and
 * sometimes I end up back on Feed": no code decided to go to the feed, the back stack
 * simply stopped existing.
 *
 * Expo Router lets a route module export `ErrorBoundary`, and wraps the route component
 * — and only the route component — in it. Caught here, the navigator is untouched: the
 * route is still on the stack, Back still returns to whatever pushed it, and the reader
 * is still where they were. `retry` re-renders the route in place.
 *
 * **This is not a broader try/catch around the defect.** It changes nothing about
 * whether a screen throws; it changes only what a throw costs, and the thing it stops
 * costing is the reader's place in the app.
 *
 * The copy is the root boundary's, deliberately — a person should not have to learn two
 * apologies — and so is the beta-only exception line, which is the difference between a
 * report that says "the title page crashed" and one that names the exception.
 */
export function ScreenError({ error, retry }: ScreenErrorProps) {
  /**
   * Reported from an effect rather than from a `componentDidCatch`, because the catching
   * is the router's and this is only the view it renders. The effect runs once per
   * distinct error: a re-render while the same error is showing must not report it
   * again, or a counter that exists to say "this happened twice" says it happened forty
   * times.
   */
  useEffect(() => {
    recordRenderError(error, 'screen_render');
  }, [error]);

  const line = errorLineFor(error);

  return (
    <View style={styles.fill}>
      <Text variant="title1" style={styles.centred}>
        Something went wrong
      </Text>
      <Text variant="body" tone="secondary" style={styles.centred}>
        Your films are safe. This screen stopped, not your account.
      </Text>
      {line ? (
        <Text
          testID="screen-error-detail"
          variant="caption"
          tone="tertiary"
          style={styles.centred}
        >
          {line}
        </Text>
      ) : null}
      <Button label="Try again" onPress={() => void retry()} />
    </View>
  );
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
