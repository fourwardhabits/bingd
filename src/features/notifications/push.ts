import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { reportHandled } from '@/lib/monitoring';
import { note } from '@/lib/flight-recorder';
import { supabase } from '@/lib/supabase';
import { theme } from '@/ui/tokens';

/**
 * Everything this app does with the notification service, in one file.
 *
 * The React wiring is in `use-push.ts` and the decision about *when to ask* is in
 * `push-permission.ts`. This is the part that touches the platform: permissions, tokens,
 * the two RPCs, and the nudge that makes the sender run.
 *
 * ---------------------------------------------------------------------------
 * EVERY FUNCTION HERE IS ALLOWED TO FAIL, AND NONE OF THEM MAY THROW
 *
 * Push is the least reliable thing in this app by construction: it needs a physical
 * device, a permission somebody may have denied, a round trip to Expo's servers to mint a
 * token, and a network. Every one of those fails routinely and none of them is a reason
 * for anything else to stop working.
 *
 * So the contract is uniform: these return a value that says what happened, report the
 * failure to Sentry with a stage rather than a message, and never reject. `signOut` is
 * the sharpest case — a token revoke that throws would leave somebody signed in, which is
 * a far worse outcome than a stale token.
 *
 * ---------------------------------------------------------------------------
 * NO TOKEN EVER REACHES TELEMETRY
 *
 * A push token addresses a person's phone. `reportHandled` takes scalars and this file
 * hands it a stage, a platform and a category — never the token, and never the error
 * object from a call that had the token in scope, because a rejected request can echo its
 * own body. `noteFailure` below is the only path out of this file to a vendor, and it is
 * the thing to read before adding a field to it.
 */

export type PushPlatform = 'ios' | 'android';

/**
 * What the operating system currently thinks, reduced to the four cases that lead
 * somewhere different.
 *
 * `blocked` is separated from `undetermined` because they need opposite treatment: one is
 * a question nobody has been asked, the other is an answer somebody gave. Asking again
 * after a denial does nothing on iOS — the OS refuses to present the dialog a second time
 * — so the app would show a prompt that could not work.
 */
export type PushPermission = 'granted' | 'undetermined' | 'blocked' | 'unavailable';

/** Where a failure happened, as a searchable category rather than a message. */
export type PushStage =
  | 'permission_request'
  | 'token_acquisition'
  | 'token_registration'
  | 'token_revocation'
  | 'sender_invocation'
  | 'channel_setup';

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Everything token-shaped, taken out of a message before it leaves the device.
 *
 * **This exists because a test found a real leak rather than because it seemed prudent.**
 * `getExpoPushTokenAsync` fails by rejecting with a message composed by the SDK, and that
 * message can carry the **device** push token — the raw APNs or FCM string it was
 * exchanging for an Expo one. Forwarding the error object straight to Sentry put it in a
 * vendor's hands, and there was nothing on screen and nothing in a review that would have
 * shown it.
 *
 * Two passes, and the second is the one that matters. The first removes an Expo token by
 * its literal shape; the second removes **any long opaque run**, which is what an APNs
 * token, an FCM token and a JWT all look like. Over-redacting a long identifier that was
 * not a secret costs a little diagnostic detail; under-redacting costs somebody's device
 * address, permanently, in somebody else's database.
 */
export function redactTokens(message: string): string {
  return message
    .replace(/Expo(nent)?PushToken\[[^\]]*\]/g, '[token]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .slice(0, 300);
}

/**
 * One place, so there is one thing to audit.
 *
 * Deliberately **not** a PostHog event. `lib/analytics.ts` is a closed vocabulary of
 * thirteen product events whose whole design is that a property cannot be added in a
 * hurry, and "push registration failed" is an operational fact rather than something
 * anybody will build a funnel on. Sentry already carries the release, the platform and
 * the account id, which is everything a founder debugging "why did I not get a
 * notification" needs.
 *
 * The error is **rebuilt** rather than forwarded, so a message goes through
 * `redactTokens` whatever produced it. Forwarding the original would keep its stack,
 * which is worth less here than the guarantee: every one of these failures is a call to a
 * named function two lines from the report, and the stage says which.
 */
export function noteFailure(stage: PushStage, error?: unknown, extra?: Record<string, string>) {
  const detail = error instanceof Error ? redactTokens(error.message) : null;

  reportHandled(new Error(detail ? `push: ${stage}: ${detail}` : `push: ${stage}`), {
    push_stage: stage,
    platform: Platform.OS,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// The platform
// ---------------------------------------------------------------------------

/** Null on web, which has no `device_tokens` platform and no build that ships there. */
export function pushPlatform(): PushPlatform | null {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null;
}

/**
 * The EAS project the token should be attributed to.
 *
 * Read from the resolved config rather than written down here, because `app.config.ts`
 * already holds it and two copies of a project id is one copy that goes stale. Expo would
 * default to the same value; passing it explicitly is what its own documentation
 * recommends, and it is the difference between a clear failure and a token minted against
 * nothing.
 */
export function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  const fromConfig = extra?.eas?.projectId;
  if (fromConfig) return fromConfig;

  const easConfig = (Constants as { easConfig?: { projectId?: string } }).easConfig;
  return easConfig?.projectId ?? null;
}

/**
 * Whether this build can receive a push at all, before any permission question.
 *
 * A simulator cannot: neither APNs nor FCM issues a token to one, and
 * `getExpoPushTokenAsync` fails rather than returning null. Checking first turns a
 * recurring error report from every developer's simulator into a quiet, correct "not
 * here".
 */
export function canReceivePush(): boolean {
  return pushPlatform() !== null && Device.isDevice === true;
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

function readStatus(settings: Notifications.NotificationPermissionsStatus): PushPermission {
  // iOS provisional authorisation delivers quietly to the notification centre without
  // ever having asked, and `granted` is false for it. Treating it as ungranted would ask
  // somebody who is already receiving notifications.
  if (settings.granted) return 'granted';
  if (settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL)
    return 'granted';
  return settings.canAskAgain ? 'undetermined' : 'blocked';
}

/** Reads the OS state. Never prompts — that is `requestPushPermission`. */
export async function pushPermission(): Promise<PushPermission> {
  if (!canReceivePush()) return 'unavailable';

  try {
    return readStatus(await Notifications.getPermissionsAsync());
  } catch (error) {
    noteFailure('permission_request', error, { operation: 'read' });
    return 'unavailable';
  }
}

/**
 * Presents the operating system's own dialog. Exactly once per install, in practice —
 * iOS will not show it again after a denial, which is why `push-permission.ts` is careful
 * about the moment it is spent on.
 */
export async function requestPushPermission(): Promise<PushPermission> {
  if (!canReceivePush()) return 'unavailable';

  try {
    return readStatus(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: false, allowSound: true },
      }),
    );
  } catch (error) {
    noteFailure('permission_request', error, { operation: 'request' });
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * The Expo push token for this installation, or null.
 *
 * This is a network call to Expo's servers and it fails offline, which is ordinary rather
 * than exceptional — the caller retries on the next launch or the next foreground, and
 * nothing waits on it.
 */
export async function acquirePushToken(): Promise<string | null> {
  if (!canReceivePush()) return null;

  const projectId = easProjectId();
  if (!projectId) {
    noteFailure('token_acquisition', undefined, { reason: 'no_project_id' });
    return null;
  }

  try {
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return token?.data ?? null;
  } catch (error) {
    // The message can name the project and the device, neither of which is a token.
    noteFailure('token_acquisition', error);
    return null;
  }
}

/**
 * One operation id per intent, held until the server answers.
 *
 * The same rule `lib/operation-intent.ts` states, in the smallest form that applies here.
 * It is smaller because both writers are **assertions of state** rather than ledger
 * entries: re-registering a token is the same write again, and neither is rate-limited,
 * so there is no slot for a replay to spend. What holding the id buys is that a retry
 * after a lost reply is recognised rather than recorded twice.
 *
 * Keyed on the account as well as the token: the same phone under a new account is a
 * different intent, and must not be answered `already_applied` by the previous one.
 */
const heldOperations = new Map<string, string>();

function operationFor(key: string): string {
  const held = heldOperations.get(key);
  if (held) return held;

  const minted = Crypto.randomUUID();
  heldOperations.set(key, minted);
  return minted;
}

export type PushWriteResult = 'ok' | 'failed';

/** Claims this device for the signed-in account. Moves it if somebody else held it. */
export async function registerPushToken(
  userId: string,
  token: string,
  platform: PushPlatform,
): Promise<PushWriteResult> {
  const key = `register:${userId}:${token}`;

  const { error } = await supabase.rpc('register_device_token', {
    p_operation_id: operationFor(key),
    p_token: token,
    p_platform: platform,
  });

  if (error) {
    // The id is kept, so the retry is the same operation. Deliberately no error object:
    // PostgREST echoes the failing statement's arguments in some classes of error, and
    // one of this statement's arguments is the token.
    noteFailure('token_registration', undefined, { code: error.code ?? 'unknown' });
    return 'failed';
  }

  heldOperations.delete(key);
  return 'ok';
}

/**
 * Releases this device, which is what signing out does.
 *
 * **The one call in this file whose failure has a consequence beyond push.** If it fails
 * and the sign-out proceeds anyway, the token stays pointed at the account that just left
 * — and the next notification for them lands on a phone somebody else may now be holding.
 * The server closes that hole from the other side: `register_device_token` moves the row
 * on conflict, so the next account to sign in takes the device whether or not this
 * succeeded. This is the tidy path; that is the guarantee.
 */
export async function revokePushToken(userId: string, token: string): Promise<PushWriteResult> {
  const key = `revoke:${userId}:${token}`;

  const { error } = await supabase.rpc('revoke_device_token', {
    p_operation_id: operationFor(key),
    p_token: token,
  });

  if (error) {
    noteFailure('token_revocation', undefined, { code: error.code ?? 'unknown' });
    return 'failed';
  }

  heldOperations.delete(key);
  return 'ok';
}

/**
 * The token this device most recently registered, so sign-out has something to revoke.
 *
 * Held in memory rather than in storage, and that is a deliberate limit rather than an
 * oversight. A token in `expo-secure-store` would survive a cold start and let a sign-out
 * revoke a token acquired in a previous process — but it would also be a token belonging
 * to *whoever was signed in when it was written*, sitting on disk across an account
 * switch, which is the exact state this whole lifecycle exists to prevent. The server's
 * `on conflict (token)` already makes the switch safe without it.
 */
/**
 * The device token as last delivered by the OS — the edge that broke a feedback loop.
 *
 * **This is the register_device_token storm from the 2026-08-27 physical reports** (repeat
 * 118 by ten seconds of uptime, bursts of ~28 registrations in 300ms). The cycle, proven
 * from vendor source: `getExpoPushTokenAsync` calls `getDevicePushTokenAsync`, which asks
 * the OS to register for remote notifications — and expo-notifications emits its
 * push-token event on **every delivery of the token, not only on change**. The token-roll
 * listener then called `registerThisDevice`, which acquires the token, which registers,
 * which delivers, which fires the listener… at one Expo fetch plus one RPC per ~50ms,
 * for as long as the app was foregrounded. That storm is the sustained network and CPU
 * churn behind the hot phone — and it began exactly at build 4, because build 4 is the
 * binary that gained the aps-environment entitlement (#49); on build 3 the OS
 * registration failed, so the event never fired and the loop could not start.
 *
 * So a delivery only counts as a *roll* when the token actually differs from the one last
 * delivered. The first delivery of a process records and does not count: the only way a
 * delivery happens is a registration this app initiated, and the initial registration
 * already has an owner. Deliberately **not** cleared on sign-out — the device token
 * belongs to the device, not the account, and an account switch must not turn the next
 * echo back into a “roll”.
 */
let lastDeliveredDeviceToken: string | null = null;

export function deviceTokenRolled(delivered: unknown): boolean {
  const data = typeof delivered === 'string' ? delivered : JSON.stringify(delivered ?? null);
  if (lastDeliveredDeviceToken === data) return false;
  const first = lastDeliveredDeviceToken === null;
  lastDeliveredDeviceToken = data;
  if (first) return false;
  // A genuine roll is rare and worth a line in the report; the echoes are not.
  note('push', 'token-rolled');
  return true;
}

/** Test seam: one test's delivered token must not leak into the next. */
export function resetDeliveredDeviceToken() {
  lastDeliveredDeviceToken = null;
}
let currentToken: { userId: string; token: string } | null = null;

export function rememberToken(userId: string, token: string) {
  currentToken = { userId, token };
}

export function forgetToken() {
  currentToken = null;
}

export function heldToken(): { userId: string; token: string } | null {
  return currentToken;
}

/**
 * How many sessions this process has released, so an in-flight registration can tell that
 * the account it was registering for has since left.
 *
 * **This exists because of a race an independent review found**, and the race is the
 * account-switch hole arriving by the back door rather than through a missing call:
 *
 *   1. `usePush` sees permission already granted and starts registering for A;
 *   2. acquiring an Expo token is a network round trip, and A signs out during it;
 *   3. `releaseDeviceOnSignOut` looks for a token to revoke and finds **none**, because
 *      the registration has not finished writing one yet;
 *   4. the registration completes — A's session is still valid for the moment it takes
 *      `supabase.auth.signOut()` to return — and the device ends up owned by A, *after*
 *      the revoke that was supposed to release it.
 *
 * A boolean "cancelled" flag scoped to the effect cannot see this: the effect's own
 * cleanup runs, but the promise it started is already past its last check. A counter that
 * lives in this module can, and `registerThisDevice` compares it either side of every
 * awaited step.
 */
let sessionEpoch = 0;

/** The epoch to compare against later. Captured before a registration begins. */
export function pushSessionEpoch(): number {
  return sessionEpoch;
}

/**
 * A registration whose write has been **dispatched**, which sign-out has to let finish.
 *
 * The epoch alone was not enough, and the re-review was right about why. It closes the
 * case where the account leaves *before* the write goes out — nothing is written, so
 * there is nothing to release. It does not close the case where the write is already in
 * flight: that registration lands, notices the stale epoch and revokes itself, but by then
 * `supabase.auth.signOut()` may have ended the session and the compensating revoke fails
 * with nothing to authenticate as. The row survives, addressed to an account that has
 * left.
 *
 * So sign-out **waits** for it. Not for the whole registration — acquiring a token from
 * Expo can hang for a long time on a bad connection, and a registration still at that
 * stage writes nothing anyway. Only from the moment the RPC is dispatched, which is one
 * round trip, plus the compensating revoke it may then need, which is a second.
 *
 * Empty almost always: a registration happens once per session start, so a sign-out that
 * collides with one is rare and this costs nothing on every other sign-out.
 *
 * **A set rather than a slot**, which the third review round was right to insist on. There
 * are three entry points — the launch registration, the token-change listener, and the
 * permission flow — and they can overlap. A single slot is overwritten by whichever
 * started last, so sign-out would wait for the *newest* write and return while an older,
 * slower one was still out there; that one then lands with no session left to revoke as,
 * which is the whole scenario back again.
 */
const dispatchedWrites = new Set<Promise<unknown>>();

/**
 * Marks `write` as something sign-out must let finish. Returns it unchanged.
 *
 * Rejections are swallowed **for the tracked copy only** — sign-out waits on these and
 * must not inherit a failure — while the caller still gets the original to await.
 */
export function trackDispatchedWrite<T>(write: Promise<T>): Promise<T> {
  const tracked = write.then(
    () => undefined,
    () => undefined,
  );

  dispatchedWrites.add(tracked);
  void tracked.then(() => dispatchedWrites.delete(tracked));

  return write;
}

/**
 * How long sign-out will wait for a dispatched registration to settle.
 *
 * Two round trips' worth. It is a ceiling rather than a delay: the wait ends the moment
 * the write does, and there is no wait at all unless one is in flight. Sign-out is a
 * control somebody presses, so this cannot be generous — and past it the server's
 * move-on-conflict is the backstop, as it always was.
 */
const DISPATCHED_WRITE_GRACE_MS = 3000;

/** Test seam: leaves no dispatched write behind for the next test to wait on. */
export function resetDispatchedWrites() {
  dispatchedWrites.clear();
}

/**
 * Everything sign-out has to do about push, in the order it has to do it.
 *
 * Called **before** `supabase.auth.signOut()`, because revoking needs the session that is
 * about to end. Returns rather than throws, always: `auth/methods.ts` awaits this and a
 * rejection there would leave somebody signed in.
 *
 * Three steps, and the order of the first two is the whole correctness argument:
 *
 *   1. the epoch moves, so a registration that has not written yet abandons itself and a
 *      registration that has will revoke what it wrote;
 *   2. **every** dispatched write is waited for, bounded, so that revoke happens while the
 *      session it needs still exists;
 *   3. whatever this process is holding is released.
 *
 * Step 2 waits on all of them rather than the latest, and keeps waiting while more arrive
 * inside its budget. Three paths can start a registration and they can overlap; the loop
 * below is what four rounds of review reduced to, and each clause of it is a defect that
 * was found rather than one that was anticipated:
 *
 *   · **a snapshot, not the live set** — it is mutated as its members settle;
 *   · **every member removed after its wait**, not just the settled ones. A write that
 *     never settles removes itself in a callback that will never run, so it would sit
 *     there for the life of the process and charge every later sign-out the full budget;
 *   · **removing the batch rather than clearing** — a registration that starts *during*
 *     the wait belongs to the next iteration, and clearing would drop it untracked;
 *   · **a shared deadline**, so however many arrive, sign-out is bounded once rather than
 *     once per round.
 */
export async function releaseDeviceOnSignOut(): Promise<void> {
  sessionEpoch += 1;

  const deadline = Date.now() + DISPATCHED_WRITE_GRACE_MS;

  while (dispatchedWrites.size) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    // `Promise.all` over the tracked copies cannot reject — `trackDispatchedWrite` has
    // already absorbed that — so this races a settlement against the remaining budget.
    const batch = [...dispatchedWrites];

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(batch),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      }),
    ]);
    // Or the timer holds the event loop open for the rest of the budget after a sign-out
    // that did not need it — on a device, a background task nobody asked for.
    if (timer) clearTimeout(timer);

    // Given their grace, settled or not. Anything added while this was waiting is still
    // in the set and is picked up by the next turn of the loop.
    for (const write of batch) dispatchedWrites.delete(write);
  }

  const held = heldToken();
  forgetToken();
  heldOperations.clear();

  if (!held) return;

  try {
    await revokePushToken(held.userId, held.token);
  } catch (error) {
    noteFailure('token_revocation', error);
  }
}

// ---------------------------------------------------------------------------
// Making the sender run
// ---------------------------------------------------------------------------

/** Two nudges inside this window are one nudge. A drain is global, not per caller. */
const NUDGE_INTERVAL_MS = 10_000;

let lastNudgeAt = 0;

/**
 * Tells the server there may be push work, and waits for nothing.
 *
 * **The client chooses nothing by calling this.** `push-sender` takes no recipient, no
 * copy and no batch size; it reads `push_outbox`, whose primary key is a notification id.
 * So this is a nudge rather than a send, and that is why an ordinary signed-in account is
 * allowed to give one — the person who caused a notification is holding a phone at that
 * moment, which makes their client the cheapest scheduler available.
 *
 * **What this does not guarantee.** Nothing else drains the queue: there is no cron and
 * no database networking extension (`20260825000300` says why). A notification created
 * while nobody has the app open therefore waits until somebody does. That is the one
 * piece of this system deliberately left for a scheduler, and the runbook in
 * `supabase/functions/push-sender/README.md` says what it would take.
 *
 * Fire and forget by design: no caller's write should be slower because delivery was.
 */
export function nudgePushDelivery(): void {
  const now = Date.now();
  if (now - lastNudgeAt < NUDGE_INTERVAL_MS) return;
  lastNudgeAt = now;

  /**
   * The `try` is not defensive padding. This is called from the success path of six
   * writes that have **already committed**, and it returns void — so a synchronous throw
   * here would surface as a failed follow, a failed comment or a failed recommendation
   * for something that worked. Nothing about delivery is worth that.
   */
  try {
    void supabase.functions
      .invoke('push-sender', { body: {} })
      .then(({ error }) => {
        if (error) noteFailure('sender_invocation', undefined, { reason: 'invoke_failed' });
      })
      .catch(() => {
        noteFailure('sender_invocation', undefined, { reason: 'rejected' });
      });
  } catch {
    noteFailure('sender_invocation', undefined, { reason: 'threw' });
  }
}

/** Test seam. The debounce is module state, and a suite that shared it would be flaky. */
export function resetNudgeThrottle() {
  lastNudgeAt = 0;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * What happens when a push arrives while somebody is looking at Bingd.
 *
 * **Nothing visible, and that is the decision.** The inbox row is the notification; the
 * push is transport for it. A banner over an app that is already showing the bell — and
 * whose inbox refetches on the same event — is the same fact told twice, and it is the
 * duplication a reader would read as the app being broken rather than as being informed.
 *
 * `shouldShowBanner` and `shouldShowList` are the SDK 54+ spelling of what used to be
 * `shouldShowAlert`; both are named so the handler cannot silently mean something else
 * after an upgrade. The badge is false because this app has no badge — `setBadgeCount` is
 * never called, and a number that only ever goes up is worse than no number.
 *
 * `use-push.ts` is what makes the inbox current when this fires.
 */
export function configurePushPresentation() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  /**
   * Android delivers into a channel or not at all, and an app that never declares one
   * gets a channel called "Miscellaneous" with default importance. Naming it is what puts
   * "Notifications" in the system settings screen people actually open, and `HIGH` is what
   * makes a heads-up banner possible at all.
   */
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
      name: 'Notifications',
      importance: Notifications.AndroidImportance.HIGH,
      // The same Maroon `app.config.ts` hands the plugin for the small monochrome
      // status-bar icon. Two places, unavoidably: that one is a build-time native input
      // and this one is a runtime call, and neither toolchain can read the other's file.
      lightColor: theme.semantic.action,
    }).catch((error) => noteFailure('channel_setup', error));
  }
}
