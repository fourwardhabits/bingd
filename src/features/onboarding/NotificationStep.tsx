import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import {
  markPushOffered,
  registerThisDevice,
  shouldOfferPush,
} from '@/features/notifications/push-permission';
import { noteFailure, pushPermission, requestPushPermission } from '@/features/notifications/push';
import { withGrace } from '@/lib/grace';
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

type State = 'asking' | 'working' | 'granted' | 'pending' | 'undelivered' | 'declined';

/**
 * How long the screen will wait for an honest answer before continuing without one.
 *
 * **The wait is for the sentence, never for the entry.** The founder's TestFlight
 * build 4 session proved the lane this bounds: `getExpoPushTokenAsync` is a promise the
 * platform is allowed to never settle — APNs simply not calling back is a documented
 * behaviour, not a crash — and an unbounded `await` on it left a person on
 * "One moment…" for good, with five ranked films and a working account on the other
 * side of it. Registration itself is not cancelled at the deadline; the attempt keeps
 * running, and `usePush` re-registers on every launch where permission exists, so the
 * only thing given up is knowing the outcome *right now* — which is what the `pending`
 * copy says.
 */
const REGISTRATION_GRACE_MS = 5000;

/** A preference write is local and quick; a hung one must not trap the screen. */
const PREF_WRITE_GRACE_MS = 1500;

export function NotificationStep({ onDone }: NotificationStepProps) {
  const profile = useCurrentProfile();
  const [state, setState] = useState<State>('asking');

  const turnOn = async () => {
    setState('working');
    try {
      // Written before the OS is touched, and for both answers — see `markPushOffered`.
      // A crash between the request and the write would otherwise leave somebody who has
      // already been asked eligible to be asked again by the contextual primer. Bounded
      // and best-effort: a preference that could not be written costs one repeat of a
      // recoverable question, which is nothing next to holding the person here.
      await withGrace(
        markPushOffered().catch(() => undefined),
        PREF_WRITE_GRACE_MS,
        undefined,
      );

      // Deliberately unbounded: this settles when the person answers the OS dialog, and
      // while that dialog is up "One moment…" behind it is the truth. The escape from a
      // dialog that never appears is "Not now", which stays live below.
      const granted = await requestPushPermission();
      if (granted !== 'granted') {
        settleFromWorking('declined');
        return;
      }

      /**
       * **Registration never gates the exit.** The race is the state model, not a
       * shortened timeout: whichever side settles first, this function reaches a
       * `setState` and the effect below reaches `onDone`. A slow or never-settling
       * registration continues in the background and is retried by `usePush` on the
       * next launch; what it can no longer do is keep somebody out of the app.
       */
      const outcome = await withGrace(
        registerThisDevice(profile.id).catch((error) => {
          noteFailure('token_registration', error, { moment: 'onboarding' });
          return 'failed' as const;
        }),
        REGISTRATION_GRACE_MS,
        'pending' as const,
      );
      settleFromWorking(
        outcome === 'registered' ? 'granted' : outcome === 'pending' ? 'pending' : 'undelivered',
      );
    } catch (error) {
      // Nothing here is worth interrupting onboarding for. The account exists, the films
      // are ranked, and this was the optional step.
      noteFailure('permission_request', error, { moment: 'onboarding' });
      settleFromWorking('undelivered');
    }
  };

  /**
   * Applies an answer only if the screen is still waiting for one. "Not now" stays live
   * while `working` (it is the escape from an OS dialog that never appeared), so a late
   * outcome must not overwrite an exit the person has already taken.
   */
  const settleFromWorking = (next: State) =>
    setState((current) => (current === 'working' ? next : current));

  const notNow = () => {
    // No OS request, deliberately. But the offer is recorded, so the contextual primer
    // does not put the same question again five minutes later — see `markPushOffered`.
    void markPushOffered().catch(() => {});
    setState('declined');
  };

  /**
   * Once an answer is in, this screen has nothing left to do.
   *
   * A pause rather than an immediate hand-off, so the sentence explaining what happened
   * is actually readable — particularly the `undelivered` one, which is the only place
   * the app admits something did not work.
   */
  /**
   * The hand-off is armed by the **answer**, and by nothing else.
   *
   * `onDone` is an inline arrow at the call site — `onDone={() => void finish(leaving)}` —
   * so it is a different function on every render of the screen above. With it in the
   * dependency array this effect tore down and re-armed the timer on each of those
   * renders, which is two failures rather than one: a parent re-rendering faster than the
   * pause would restart the countdown forever and never hand off at all, and once it
   * *did* fire, `finish` writes to the query cache, the parent re-renders, and a fresh
   * `onDone` arms it again — a second exit for a person who has already left.
   *
   * A ref rather than asking the caller for a stable callback, because the fix has to
   * hold whoever writes the next call site too.
   */
  const done = useRef(onDone);
  // Kept current in an effect rather than during render, which the React Compiler rules
  // forbid outright — and rightly: a ref written mid-render is a value two concurrent
  // renders can disagree about. The assignment lands before any timer below can fire,
  // because effects run in order and this one has no condition to skip it.
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (state === 'asking' || state === 'working') return;
    const timer = setTimeout(() => done.current(), state === 'granted' ? 900 : 1400);
    return () => clearTimeout(timer);
  }, [state]);

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
        ) : state === 'pending' ? (
          <>
            {/* The bounded-wait branch: permission is on and the outcome is not yet
                known. It claims neither success nor failure, because at this moment
                neither is true — registration is still running behind this sentence,
                and `usePush` retries it on every launch where permission exists. */}
            <Text variant="title1" style={styles.centre}>
              Thanks
            </Text>
            <Text variant="body" tone="secondary" style={styles.centre}>
              Still setting up notifications in the background. You will see everything in
              the app either way.
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
              {/* Live during `working`, deliberately. While the OS dialog is up it is
                  unreachable anyway — the dialog is modal — so the only person who can
                  press this mid-work is one the platform has left staring at
                  "One moment…", and they must always have a way out. `settleFromWorking`
                  keeps a late outcome from overwriting the exit. */}
              <Button label="Not now" kind="tertiary" onPress={notNow} />
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
