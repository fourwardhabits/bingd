import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/features/auth';

import { registerThisDevice } from './push-permission';
import {
  canReceivePush,
  forgetToken,
  nudgePushDelivery,
  pushPermission,
  pushPlatform,
  registerPushToken,
  rememberToken,
} from './push';
import { hrefForPush } from './routing';

/**
 * The push lifecycle, as one hook mounted once under the auth provider.
 *
 * Five jobs, and they are separate effects because they have different lifetimes:
 *
 *   1. register this device when a session becomes ready **and permission already
 *      exists** — never by asking, which is `push-permission.ts`'s job and PRD §15's rule;
 *   2. re-register when the platform rolls the token underneath us;
 *   3. keep the inbox current when a push arrives in the foreground;
 *   4. route a tap, from a cold start as well as from a warm one;
 *   5. nudge the sender when the app comes forward, which is the only thing standing in
 *      for a scheduler.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER ASKS FOR PERMISSION, AND THAT IS THE POINT
 *
 * This runs on every launch of every session. If it prompted, it would prompt on the
 * first launch of a new account, which is exactly what PRD §15 forbids and what spends
 * the one dialog iOS will ever show. It reads the OS state and acts on `granted`;
 * everything else it leaves alone.
 *
 * ---------------------------------------------------------------------------
 * SIGN-OUT IS NOT HERE
 *
 * Releasing the device belongs to `signOut` in `features/auth/methods.ts`, because it has
 * to happen **while the session still exists** — a revoke needs a JWT, and by the time
 * this hook observed `signed-out` there is none. What this hook does on sign-out is
 * forget the token it was holding, so a second account signing in on the same device
 * cannot inherit the first one's registration state in memory.
 */
export function usePush() {
  const auth = useAuth();
  const userId = auth.status === 'ready' ? auth.userId : null;
  const queryClient = useQueryClient();
  const router = useRouter();

  // ---------------------------------------------------------------------------
  // 1. Register, when there is already permission to
  // ---------------------------------------------------------------------------

  /**
   * Latched per account, because `registerThisDevice` is a network call to Expo followed
   * by a round trip to Postgres and this effect re-runs whenever the auth object's
   * identity changes — which is every profile refetch.
   *
   * Keyed on the account rather than a boolean: signing out and back in as somebody else
   * has to register again, under the new owner.
   */
  const registeredFor = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) {
      registeredFor.current = null;
      // The in-memory token belonged to whoever just left. `signOut` has already revoked
      // it server-side; this is the half that stops it being reused here.
      forgetToken();
      return;
    }

    if (!canReceivePush()) return;
    if (registeredFor.current === userId) return;
    registeredFor.current = userId;

    /**
     * **Abandoned if the session ends while this is in flight**, which is not a tidiness
     * guard. Reading the OS permission is asynchronous and registering is two more round
     * trips; somebody who signs out during that window would otherwise have a token
     * written *for the account they just left*, after `signOut` had already revoked the
     * one it knew about — the exact state the whole lifecycle exists to prevent, arrived
     * at by a race rather than by a missing call.
     */
    let live = true;

    void (async () => {
      const permission = await pushPermission();
      if (!live || permission !== 'granted') return;
      await registerThisDevice(userId);
    })();

    return () => {
      live = false;
    };
  }, [userId]);

  // ---------------------------------------------------------------------------
  // 2. The token rolling underneath us
  // ---------------------------------------------------------------------------

  /**
   * APNs and FCM may replace a token while the app is running, and the old one stops
   * working at that moment. Without this the account keeps a dead token until the next
   * cold start, and every notification in between is delivered to nothing.
   *
   * The listener carries the **device** token, not the Expo one, so the new Expo token is
   * fetched rather than read out of the event — `registerThisDevice` is the same path the
   * first registration takes, which is what stops the two disagreeing.
   */
  useEffect(() => {
    if (!userId || !canReceivePush()) return;

    const subscription = Notifications.addPushTokenListener(() => {
      void registerThisDevice(userId);
    });

    return () => subscription.remove();
  }, [userId]);

  // ---------------------------------------------------------------------------
  // 3. A push arriving while somebody is looking at the app
  // ---------------------------------------------------------------------------

  /**
   * No banner is shown (`configurePushPresentation`), so this is what makes the arrival
   * visible: the bell and the inbox refetch, which is the same thing that happens when
   * the app comes back to the foreground.
   *
   * Invalidating rather than writing the row in from the payload. The payload carries four
   * fields and an inbox row needs a dozen — and more to the point, `my_notifications`
   * applies `can_discover_profile`, so the server is the only thing that may decide a row
   * is showable.
   */
  useEffect(() => {
    if (!userId) return;

    const subscription = Notifications.addNotificationReceivedListener(() => {
      void queryClient.invalidateQueries({ queryKey: ['notifications', userId] });
    });

    return () => subscription.remove();
  }, [userId, queryClient]);

  // ---------------------------------------------------------------------------
  // 4. The tap
  // ---------------------------------------------------------------------------

  /**
   * `useLastNotificationResponse` covers both entrances with one value: a tap that
   * launched the app cold, and a tap while it was already running. The alternative — a
   * listener plus a separate `getLastNotificationResponse` on mount — is two paths for one
   * event and the cold one is the one that gets forgotten.
   *
   * **Gated on a ready session**, and that gate is doing real work rather than being
   * defensive. A cold start from a tap mounts this before the profile query has answered,
   * and `useAuthRouting` is simultaneously deciding where the person belongs; navigating
   * from here first would be immediately replaced by the feed. The response is retained by
   * the module until it is cleared, so waiting costs nothing.
   *
   * Cleared once acted on, or the same tap would be re-navigated on every remount for the
   * rest of the process.
   */
  const response = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!response || !userId) return;

    const data = response.notification.request.content.data as Record<string, unknown> | null;
    Notifications.clearLastNotificationResponse();
    router.push(hrefForPush(data));
  }, [response, userId, router]);

  // ---------------------------------------------------------------------------
  // 5. Standing in for a scheduler
  // ---------------------------------------------------------------------------

  /**
   * Nothing else drains `push_outbox` — see `nudgePushDelivery`. Coming to the foreground
   * is the cheapest moment to check, and it is also the moment somebody is most likely to
   * have caused work while they were away.
   *
   * Debounced inside `nudgePushDelivery`, so a rapid app-switch is one call. It is a
   * global drain rather than a personal one, so any account's foreground moves everybody's
   * queue.
   */
  useEffect(() => {
    if (!userId) return;

    nudgePushDelivery();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') nudgePushDelivery();
    });

    return () => subscription.remove();
  }, [userId]);
}

/**
 * Re-exported so a caller that already holds a token does not reach past this module.
 * Nothing in `app/` should import `push.ts` directly.
 */
export { registerPushToken, rememberToken, pushPlatform };
