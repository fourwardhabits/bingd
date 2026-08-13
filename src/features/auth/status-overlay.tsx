import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Button, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { useAuth } from './session';

/**
 * Renders the two auth states that are not a place in the app.
 *
 * `error` existed in the state machine with nothing displaying it, and the
 * consequence was worse than a missing screen. Routing deliberately does not move a
 * user whose profile could not be read, so a signed-in user on a bad connection
 * landed on whatever route happened to be mounted, with no message and no way to
 * retry: the `retry` function was reachable only in principle. Nothing would recover
 * on its own either, since the profile query never refetches once it has failed.
 *
 * An overlay rather than a screen, so the navigator stays mounted. Unmounting it
 * would take the router's state with it, and `useAuthRouting` needs somewhere to
 * navigate to when the state resolves.
 *
 * Covering `loading` here too closes a smaller gap: the splash screen hides when the
 * fonts finish, which is usually before the session and profile are known, so the
 * tabs are briefly visible to someone who is not signed in.
 */
export function AuthStatusOverlay() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <View style={styles.fill}>
        <ActivityIndicator color={theme.semantic.action} />
      </View>
    );
  }

  if (auth.status === 'error') {
    return (
      <View style={[styles.fill, styles.padded]}>
        <Text variant="title1" style={styles.centered}>
          We couldn&apos;t load your account
        </Text>
        <Text variant="body" tone="secondary" style={[styles.centered, styles.body]}>
          Your films are safe. This is usually a connection that dropped at the wrong
          moment.
        </Text>
        <Button label="Try again" onPress={auth.retry} />
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.surface.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  padded: { paddingHorizontal: theme.space[5], gap: theme.space[3] },
  centered: { textAlign: 'center' },
  body: { marginBottom: theme.space[2] },
});
