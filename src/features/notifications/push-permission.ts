import { Alert } from 'react-native';

import { readPref, writePref } from '@/lib/prefs';
import { supabase } from '@/lib/supabase';

import {
  acquirePushToken,
  noteFailure,
  pushPermission,
  pushPlatform,
  pushSessionEpoch,
  registerPushToken,
  rememberToken,
  requestPushPermission,
  revokePushToken,
  trackDispatchedWrite,
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
 * It is one alert with two buttons, not a screen and not a sequence — and since the
 * founder's device pass it is *the same* alert whichever act reached it. The moment
 * governs the timing, not the wording: what is being asked for is the operating
 * system's permission to notify this account at all, and writing that as a follow-up to
 * one particular tap made it read as a question about that tap. See `COPY`.
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

/**
 * Which social act earned the question. Both are PRD §15's.
 *
 * It no longer selects the copy — see `COPY` — but it is still what the caller passes
 * and what `noteFailure` records, which is the only way to tell afterwards *when* the
 * one question this app ever gets to ask was spent.
 */
export type PermissionMoment = 'follow' | 'invite';

const OFFERED_PREF = 'push.offered';

/**
 * **One dialog, and it is about notifications rather than about the tap that preceded
 * it.** The founder's device pass, 2026-08-26.
 *
 * There were two, and each was written as a follow-up to its moment: "Know when they
 * follow you back?" after a follow, "Know when they join?" after an invitation. Read on
 * a phone, a second after the act, the first one is a strange question — it asks about
 * one specific future event, from one specific person, when what it is actually
 * requesting is the operating system's permission to notify this account about
 * anything, for good.
 *
 * That mismatch has a cost beyond the wording. Somebody who does not care whether
 * *that* person follows back says Not now, and `push.offered` is written whichever
 * button they press, so they are never asked again — and the OS prompt, which is the
 * one that is permanent, is never reached. The narrow question was losing the broad
 * permission.
 *
 * So: one title that names what is being turned on, and one body that lists what would
 * arrive. Three examples rather than an exhaustive list, because the point is the
 * shape of the thing and Settings is where the categories live.
 *
 * **This is the OS permission and not Bingd's own preferences**, which are a separate
 * set of switches under Settings → Notifications and are all on by default
 * (`20260820000100`). Somebody can have every Bingd category enabled and still receive
 * nothing, because iOS has never been asked. That is exactly the state this dialog
 * exists to resolve, and it is why the copy talks about being notified rather than
 * about what Bingd will send.
 */
const COPY = {
  title: 'Turn on notifications?',
  body: 'Get notified when someone follows you, recommends something, or comments on what you watched.',
} as const;

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

/**
 * The native alert, as a promise. Separated so a test can answer it.
 *
 * It takes no moment any more: there is one dialog. The moment is still carried through
 * `offerPushPermission` because `noteFailure` records it, and because the *timing* rule
 * — PRD §15, never at first launch — is about which moments may ask at all.
 */
function ask(): Promise<boolean> {
  const { title, body } = COPY;

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
 *
 * ---------------------------------------------------------------------------
 * IT ABANDONS ITSELF IF THE ACCOUNT LEAVES WHILE IT RUNS
 *
 * Two awaits, and a sign-out during either of them is a device left registered to somebody
 * who has gone — the account-switch hole arriving by a race rather than a missing call.
 * Independent review found it: `releaseDeviceOnSignOut` looks for a token to revoke, this
 * function has not written one yet, so the revoke releases nothing and the write lands
 * afterwards.
 *
 * `pushSessionEpoch` moves on every sign-out, so it is compared either side of both
 * awaits. The check after the write is the one that matters most, and it does not merely
 * decline to remember the token — it **revokes what it just wrote**, because by then the
 * row exists and nothing else is going to look for it.
 *
 * **And the write is announced to sign-out before it goes out.** The epoch alone leaves
 * the compensating revoke racing `supabase.auth.signOut()` for the session it needs, which
 * a re-review was right to call the original hole only narrowed. `trackDispatchedWrite`
 * makes sign-out wait for the block below — briefly, and only when one is genuinely in
 * flight — so the revoke happens while there is still an account to revoke as.
 *
 * Only the write is announced, not the token acquisition above it: that can hang for a
 * long time on a bad connection, sign-out must not, and a registration still at that stage
 * has written nothing to release.
 */
export async function registerThisDevice(userId: string): Promise<void> {
  const platform = pushPlatform();
  if (!platform) return;

  const epoch = pushSessionEpoch();

  const token = await acquirePushToken();
  if (!token) return;
  // Signed out while Expo was minting a token. Nothing was written, so there is nothing
  // to undo — just do not write it.
  if (pushSessionEpoch() !== epoch) return;

  await trackDispatchedWrite(
    (async () => {
      const result = await registerPushToken(userId, token, platform);
      if (result !== 'ok') return;

      if (pushSessionEpoch() !== epoch) {
        // The write landed after the sign-out's revoke had already run and found nothing.
        // Undo it rather than leaving the phone addressed to an account that has left.
        // Sign-out is waiting on this promise, so the session is still there.
        await revokePushToken(userId, token);
        return;
      }

      // Remembered only on success, so sign-out does not try to revoke a token the server
      // never heard of — which would spend a round trip to be told nothing changed.
      rememberToken(userId, token);
    })(),
  );
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

    const wants = await ask();
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
