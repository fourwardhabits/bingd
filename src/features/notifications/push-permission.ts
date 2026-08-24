import { Alert } from 'react-native';

import { readPref, writePref } from '@/lib/prefs';
import { supabase } from '@/lib/supabase';

import {
  acquirePushToken,
  noteFailure,
  pushPermission,
  pushPlatform,
  registerPushToken,
  rememberToken,
  requestPushPermission,
  type PushPermission,
} from './push';

/**
 * When Bingd asks to send notifications, and what it says.
 *
 * PRD §15: **never at first launch.** "Request after the user's first successful invite or
 * first follow, when the value is concrete." That is the whole rule, and the reason it is
 * a rule is that the operating system dialog can be presented **once**. Spend it on a
 * cold start and a person who has not yet seen anybody else in the app is being asked to
 * agree to hear from people they have not met; iOS will not offer it again, and the
 * account is permanently unreachable by the two notifications — an invite landing and a
 * follow arriving — the feature exists for.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A DIALOG BEFORE THE DIALOG
 *
 * A native `Alert` first, then the OS prompt if they say yes. Two dialogs is not a
 * pattern to reach for lightly and it is right here for one reason: **a "Not now" costs
 * nothing and a "Don't Allow" costs everything.** The OS answer is permanent in practice;
 * ours is not, so the cheap question goes first and only somebody who has already said
 * yes is shown the expensive one.
 *
 * It is one alert with two buttons, not a screen and not a sequence. The moment is the
 * context — this fires within a second of following somebody — so the copy has to add
 * only what the moment does not say.
 *
 * ---------------------------------------------------------------------------
 * ASKED ONCE, EVER
 *
 * `push.offered` is written whichever button is pressed, so a person who says "Not now"
 * is not asked again the next time they follow somebody. The alternative — asking on
 * every follow until they give in — is the behaviour that teaches people to dismiss
 * dialogs without reading them, and it would be spent on the same person the OS prompt
 * would then also fail on.
 *
 * There is no path back from "Not now" inside the app today, and that is a real gap
 * rather than a hidden one: Settings → Notification Settings is where a control for it
 * would go, and it is recorded in the deferred list rather than built here.
 */

/** Which social act earned the question. Both are PRD §15's, and both are one sentence. */
export type PermissionMoment = 'follow' | 'invite';

const OFFERED_PREF = 'push.offered';

const COPY: Record<PermissionMoment, { title: string; body: string }> = {
  /**
   * The one that matters most. Following somebody is the moment a person has decided
   * they care what somebody else does, which is exactly what a notification carries.
   */
  follow: {
    title: 'Know when they follow you back?',
    body: 'bingd. can let you know when someone follows you, recommends you something, or comments on what you watched.',
  },
  /**
   * An invitation is a promise to somebody who is not here yet, and the payoff — they
   * joined — arrives days later when the app is closed. It is the one notification that
   * cannot be replaced by opening the app at the right moment.
   */
  invite: {
    title: 'Know when they join?',
    body: 'bingd. can let you know when someone you invited joins, and when people follow or recommend you something.',
  },
};

/**
 * Whether to put the question, as a function of what is known rather than as a sequence
 * of ifs inside an async handler.
 *
 * Separated so every branch is reachable from a table. The three refusals are different
 * in kind and only one of them is about this app: `granted` and `blocked` are the OS
 * having already decided, `unavailable` is a simulator or a platform with no push at all,
 * and `offered` is the only one Bingd is responsible for.
 */
export function shouldOfferPush({
  permission,
  offered,
}: {
  permission: PushPermission;
  offered: boolean;
}): boolean {
  if (permission !== 'undetermined') return false;
  return !offered;
}

/** The native alert, as a promise. Separated so a test can answer it. */
function ask(moment: PermissionMoment): Promise<boolean> {
  const { title, body } = COPY[moment];

  return new Promise((resolve) => {
    Alert.alert(title, body, [
      // "Not now" first, and cancel-styled, because the safe answer should be the easy
      // one. Somebody who meant to keep using the app and tapped through a dialog has
      // not consented to anything.
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Turn on', onPress: () => resolve(true) },
    ]);
  });
}

/**
 * Registers this device, given that permission exists. Safe to call whenever.
 *
 * Idempotent on the server — the token is unique and the write is an upsert — so calling
 * it on every launch is one round trip and no rows.
 */
export async function registerThisDevice(userId: string): Promise<void> {
  const platform = pushPlatform();
  if (!platform) return;

  const token = await acquirePushToken();
  if (!token) return;

  const result = await registerPushToken(userId, token, platform);
  // Remembered only on success, so sign-out does not try to revoke a token the server
  // never heard of — which would spend a round trip to be told nothing changed.
  if (result === 'ok') rememberToken(userId, token);
}

/**
 * The whole flow for one moment, from "should we?" to a registered device.
 *
 * Called with `void` from a social write's success path. It must never delay or fail that
 * write: the alert is presented after the action has already committed, and every failure
 * inside returns rather than throwing.
 *
 * **It takes no account id**, and resolves one from the session instead. Both call sites
 * are writes that have just succeeded under a session, so the caller always has one — but
 * one of them (`createInviteLink`) is a plain function that never needed a viewer for
 * anything else, and threading an id through it to reach here would be a signature change
 * to a tested function for the benefit of a side effect. `getSession` reads local storage
 * and makes no request.
 */
export async function offerPushPermission(moment: PermissionMoment): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user?.id ?? null;
    if (!userId) return;

    const permission = await pushPermission();

    // Already allowed, by this flow on another device or by the OS restoring a previous
    // install. There is nothing to ask and possibly something to register.
    if (permission === 'granted') {
      await registerThisDevice(userId);
      return;
    }

    const offered = (await readPref<boolean>(OFFERED_PREF)) === true;
    if (!shouldOfferPush({ permission, offered })) return;

    const wants = await ask(moment);
    // Written for both answers. See the header: asking again after "Not now" is the
    // behaviour that trains people to dismiss dialogs.
    await writePref(OFFERED_PREF, true);
    if (!wants) return;

    const granted = await requestPushPermission();
    if (granted !== 'granted') return;

    await registerThisDevice(userId);
  } catch (error) {
    // Nothing above is worth an interruption. The person followed somebody, which is what
    // they were trying to do, and that has already happened.
    noteFailure('permission_request', error, { moment });
  }
}

/** Test seam, and the only writer of this preference besides the flow above. */
export const PUSH_OFFERED_PREF = OFFERED_PREF;
