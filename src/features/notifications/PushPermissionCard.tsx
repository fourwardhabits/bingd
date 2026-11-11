import { useEffect, useState } from 'react';
import { AppState, Linking, StyleSheet, View } from 'react-native';

import { Button, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { pushPermission, requestPushPermission, type PushPermission } from './push';
import { markPushOffered, registerThisDevice } from './push-permission';

/**
 * Whether this phone gets bingd's pushes, and the one thing to do about it (2026-10-28).
 *
 * The way back from "Not now" that `architecture/push.md` §9 recorded as missing. Before
 * this, the question was asked once per install — at the first follow, the first invite,
 * or onboarding's step — and a reader who declined had no path to push anywhere in the
 * app, including the screen whose whole subject is notifications.
 *
 * **What it says is the operating system's answer, read now**, and re-read when the app
 * comes back to the foreground, because the usual way out of `blocked` is a trip to
 * Settings and back.
 *
 *   granted       nothing to do. One quiet line, so the switches below read as governing
 *                 push as well as the inbox.
 *   undetermined  the OS can still ask. "Turn on" asks — the reader pressed it, which is
 *                 the only moment this app ever spends the OS dialog on.
 *   blocked       the OS will not ask again (iOS after one denial, Android after two).
 *                 "Open Settings" goes to bingd's own page there. Re-requesting would be a
 *                 no-op that looks like a broken button.
 *   unavailable   a simulator or a build that cannot receive push: nothing is drawn.
 *
 * **It never nags.** It lives on this screen only, says one sentence, and does nothing
 * until it is pressed.
 */
export function PushPermissionCard({ userId }: { userId: string }) {
  const [status, setStatus] = useState<PushPermission | 'checking'>('checking');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = () => {
      void pushPermission().then((next) => {
        if (alive) setStatus(next);
      });
    };
    read();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') read();
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  const turnOn = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Recorded first, as onboarding does, so the contextual primer never asks again on
      // top of an answer given here.
      await markPushOffered().catch(() => undefined);
      const answer = await requestPushPermission();
      if (answer === 'granted') {
        // Best-effort and not awaited for the screen's sake: `usePush` retries on the next
        // launch if this does not land.
        void registerThisDevice(userId).catch(() => undefined);
      }
      setStatus(answer);
    } finally {
      setBusy(false);
    }
  };

  if (status === 'checking' || status === 'unavailable') return null;

  const copy =
    status === 'granted'
      ? {
          title: 'Push notifications are on',
          body: 'This phone gets bingd notifications. Choose which ones below.',
        }
      : status === 'undetermined'
        ? {
            title: 'Push notifications are off',
            body: 'Turn them on to hear when a friend replies, or when something you saved is coming out.',
          }
        : {
            title: 'Notifications are off for bingd',
            body: 'They are switched off in your phone’s settings, so bingd can’t ask again from here.',
          };

  return (
    <View style={styles.card} testID="push-permission-card">
      <View style={styles.copy}>
        <Text variant="callout">{copy.title}</Text>
        <Text variant="footnote" tone="secondary">
          {copy.body}
        </Text>
      </View>
      {status === 'undetermined' ? (
        <Button label="Turn on" onPress={() => void turnOn()} disabled={busy} disabledReason="One moment" />
      ) : status === 'blocked' ? (
        <Button label="Open Settings" kind="secondary" onPress={() => void Linking.openSettings()} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: theme.layout.gutter,
    marginTop: theme.space[4],
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.raised,
    padding: theme.space[4],
    gap: theme.space[3],
  },
  copy: { gap: 2 },
});
