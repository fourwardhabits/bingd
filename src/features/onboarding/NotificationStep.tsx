import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import {
  markPushOffered,
  registerThisDevice,
  shouldOfferPush,
} from '@/features/notifications/push-permission';
import { noteFailure, pushPermission, requestPushPermission } from '@/features/notifications/push';
import { Button, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * The last thing onboarding asks: may we notify you.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS HERE AND NOT AT LAUNCH
 *
 * PRD §15's rule is **never at first launch**, and the reason is that the operating
 * system dialog can be presented once. Spend it on a cold start and somebody who has not
 * met a single other person in the app is being asked to agree to hear from them; iOS
 * will not offer it again, and the account is permanently unreachable by exactly the
 * notifications the feature exists for.
 *
 * This is not first launch. It comes after an account exists, after five films have been
 * ranked, and immediately before the handoff into the app — which is the first moment
 * where "know when friends follow you" describes something the person can picture,
 * because they have just built the thing friends would respond to.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT PROMPT ON MOUNT
 *
 * The founder's rule, and it is the same rule the contextual primer follows: a screen
 * that fires the OS dialog as it appears has spent the one permanent question before the
 * reader has read a word of why. **Nothing here touches the OS until "Turn on
 * notifications" is pressed.** "Not now" makes no request at all, so it costs nothing and
 * remains recoverable; a "Don't Allow" is forever.
 *
 * ---------------------------------------------------------------------------
 * AND IT IS NOT REQUIRED
 *
 * Both buttons continue. The step returns `done` either way and onboarding finishes.
 * There is no third state where somebody is held here.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL NOT CLAIM
 *
 * The one thing this screen must not do is tell somebody notifications are on when the
 * binary they are holding cannot receive one. On the friend-beta build that is not
 * hypothetical: Android has no `google-services.json` compiled in, so FCM registration
 * fails, and iOS carries `aps-environment: development` — the APNs *sandbox* — while
 * being distributed through TestFlight (`config/push.cjs` records both, measured against
 * the installed plugin).
 *
 * So the outcome shown is the outcome that happened. `registerThisDevice` reports whether
 * a token was actually minted and stored, and a `failed` there produces a different, true
 * sentence rather than the success one. **No lane is hardcoded**: this asks the device
 * what it managed to do, so the same code tells the truth on a beta binary today and
 * reports success on a production one the moment the credentials exist. That is the
 * founder's J4 — gate on capability, and never on a build flag that would have to be
 * remembered and removed.
 */
export type NotificationStepProps = {
  /** Called once the reader is finished with this step, whichever way they answered. */
  onDone: () => void;
};

type State = 'asking' | 'working' | 'granted' | 'undelivered' | 'declined';

export function NotificationStep({ onDone }: NotificationStepProps) {
  const profile = useCurrentProfile();
  const [state, setState] = useState<State>('asking');

  const turnOn = async () => {
    setState('working');
    try {
      // Written before the OS is touched, and for both answers — see `markPushOffered`.
      // A crash between the request and the write would otherwise leave somebody who has
      // already been asked eligible to be asked again by the contextual primer.
      await markPushOffered();

      const granted = await requestPushPermission();
      if (granted !== 'granted') {
        setState('declined');
        return;
      }

      const outcome = await registerThisDevice(profile.id);
      setState(outcome === 'registered' ? 'granted' : 'undelivered');
    } catch (error) {
      // Nothing here is worth interrupting onboarding for. The account exists, the films
      // are ranked, and this was the optional step.
      noteFailure('permission_request', error, { moment: 'onboarding' });
      setState('undelivered');
    }
  };

  const notNow = () => {
    // No OS request, deliberately. But the offer is recorded, so the contextual primer
    // does not put the same question again five minutes later — see `markPushOffered`.
    void markPushOffered();
    setState('declined');
  };

  /**
   * Once an answer is in, this screen has nothing left to do.
   *
   * A pause rather than an immediate hand-off, so the sentence explaining what happened
   * is actually readable — particularly the `undelivered` one, which is the only place
   * the app admits something did not work.
   */
  useEffect(() => {
    if (state === 'asking' || state === 'working') return;
    const timer = setTimeout(onDone, state === 'granted' ? 900 : 1400);
    return () => clearTimeout(timer);
  }, [state, onDone]);

  return (
    <Screen airy includeBottomInset>
      <View style={styles.body}>
        {state === 'granted' ? (
          <>
            <Text variant="title1" style={styles.centre}>
              You are all set
            </Text>
            <Text variant="body" tone="secondary" style={styles.centre}>
              We will let you know when something happens.
            </Text>
          </>
        ) : state === 'undelivered' ? (
          <>
            {/* The honest branch. It does not say "something went wrong", because
                nothing did from the reader's side — they said yes and the OS agreed.
                What is missing is on this end, and the inbox genuinely does still
                work, so that is what the sentence says. */}
            <Text variant="title1" style={styles.centre}>
              Thanks
            </Text>
            <Text variant="body" tone="secondary" style={styles.centre}>
              This build cannot send notifications to your lock screen yet. You will still
              see everything in the app.
            </Text>
          </>
        ) : state === 'declined' ? (
          <>
            <Text variant="title1" style={styles.centre}>
              No problem
            </Text>
            <Text variant="body" tone="secondary" style={styles.centre}>
              You can turn notifications on later in Settings.
            </Text>
          </>
        ) : (
          <>
            <Text variant="title1" style={styles.centre}>
              Stay in the loop
            </Text>
            {/* The founder's copy, unchanged. Three examples rather than an exhaustive
                list: the point is the shape of the thing, and Settings is where the
                categories live. */}
            <Text variant="body" tone="secondary" style={styles.centre}>
              Know when friends follow you, recommend something, or interact with what you
              watched.
            </Text>

            <View style={styles.actions}>
              <Button
                label={state === 'working' ? 'One moment…' : 'Turn on notifications'}
                onPress={() => void turnOn()}
                disabled={state === 'working'}
                disabledReason="Asking your phone."
              />
              <Button
                label="Not now"
                kind="tertiary"
                onPress={notNow}
                disabled={state === 'working'}
                disabledReason="Asking your phone."
              />
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}

/**
 * Whether this step should be shown at all, resolved before it is mounted.
 *
 * The three refusals are different in kind and only one of them is Bingd's:
 *
 *   `granted`      the OS has already said yes, on another install or a restore. There is
 *                  nothing to ask, and `usePush` will have registered the device already.
 *   `blocked`      the OS has said no and will not ask again. Presenting a button whose
 *                  only outcome is nothing is worse than presenting no button.
 *   `unavailable`  a simulator, or a platform with no push at all.
 *   `offered`      Bingd has already put the question once, anywhere.
 *
 * `shouldOfferPush` is the same predicate the contextual primer uses, which is what makes
 * the two mutually exclusive rather than merely unlikely to collide — see `offerPushPermission`.
 */
export async function shouldShowNotificationStep(offered: boolean): Promise<boolean> {
  const permission = await pushPermission();
  return shouldOfferPush({ permission, offered });
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: 'center', gap: theme.space[4], paddingHorizontal: theme.layout.gutter },
  centre: { textAlign: 'center' },
  actions: { gap: theme.space[3], paddingTop: theme.space[3] },
});
