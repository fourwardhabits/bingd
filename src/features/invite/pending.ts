import { readPref, writePref } from '@/lib/prefs';

/**
 * The invitation a signed-out visitor is holding, kept across signup.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * A verified Universal Link opens `app/i/[token].tsx` with the token in hand, and then
 * `useAuthRouting` immediately replaces that route with `/(auth)/sign-in`, because the
 * visitor has no session. Sign-in is several screens — a code by email, or Apple, or
 * Google — followed by profile creation, and the navigation stack is rebuilt underneath
 * all of it. By the time there is an account to attribute, the token is gone.
 *
 * So the screen writes it down before it is routed away, and the redemption happens
 * from the other side of signup. This is the difference between *the invitation works
 * for people who already had Bingd* and *the invitation works*, which is the entire
 * point of the resolver.
 *
 * ---------------------------------------------------------------------------
 * Why it is a stored value and not a navigation parameter
 * ---------------------------------------------------------------------------
 *
 * Every alternative loses it somewhere. A route parameter dies with the stack the
 * router replaces. React state dies with the reload after the OAuth round trip on
 * Android. A query string on the sign-in route survives neither. Storage is the only
 * thing here whose lifetime is longer than the flow it has to cross.
 *
 * It is device-local, and that is the *correct* scope rather than a compromise: an
 * invitation is a thing this phone was handed, and it must not follow the account to
 * another device where somebody else's link might already be waiting.
 *
 * ---------------------------------------------------------------------------
 * Why it is cleared eagerly
 * ---------------------------------------------------------------------------
 *
 * A token that outlives its redemption is a token that gets replayed at the next cold
 * start — harmlessly, because `redeem_invite` is idempotent on the primary key, but it
 * would spend a slot against the daily ceiling every launch and would eventually lock
 * a legitimate person out of the one call that matters. So it is cleared on *any*
 * settled answer, including a refusal: `invalid`, `self` and `already_attributed` are
 * all final, and none of them becomes true later.
 *
 * The one case it is deliberately kept is a call whose outcome was never established.
 * That is `write-outcome.ts`'s rule, applied here: an unanswered write may have
 * committed, and the retry carries the same operation id.
 */

const TOKEN_KEY = 'invite.pendingToken';
const OPERATION_KEY = 'invite.pendingOperation';
const ATTEMPTS_KEY = 'invite.pendingAttempts';

/**
 * How many times a *recoverable* refusal is retried before the token is let go.
 *
 * Independent review 26's second Major. The first version cleared the token for every
 * answer the server gave, on the reasoning that none of them becomes true later — and
 * that was wrong for one of them. `unavailable` covers a block in either direction and
 * a suspended inviter, and **both of those get lifted**. A recipient who completed
 * signup during a temporary block lost their invitation permanently, with nothing on
 * any screen to say so.
 *
 * So `unavailable` is retried on subsequent launches. It is *bounded* rather than
 * retried for ever because the same answer also covers a deleted inviter, which never
 * recovers — and an unbounded retry would spend a redeem slot on every cold start
 * until the daily ceiling refused a redemption that might actually have worked.
 *
 * Five is roughly a week of ordinary use for somebody who opens the app most days,
 * which is long enough for a block to be lifted or a suspension reviewed, and short
 * enough that a permanently dead invitation stops costing a request.
 *
 * It counts **refusals**, not retries after the first, so five `unavailable` answers is
 * where it gives up — the first attempt plus four more.
 */
export const MAX_RECOVERABLE_ATTEMPTS = 5;

/** The shape `create_invite_link` mints: a uuid with the dashes removed. */
export const isInviteToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);

/**
 * Holds a token for redemption after signup.
 *
 * **First one wins.** Two invitations opened before signing in is a real sequence — a
 * link in a group chat, then a second from somebody else — and the person who is about
 * to sign up made a decision when they tapped the first one. Overwriting silently would
 * hand the attribution to whichever link they happened to tap last, which is not a
 * choice anybody made. `redeem_invite`'s primary key enforces the same rule on the
 * server; this makes the client agree rather than race it.
 */
export async function holdInvite(token: string): Promise<void> {
  if (!isInviteToken(token)) return;
  const existing = await readPref<string>(TOKEN_KEY);
  if (isInviteToken(existing)) return;
  await writePref(TOKEN_KEY, token);
}

/**
 * Makes a token the pending one, **overwriting whatever was held**.
 *
 * The deliberate counterpart to `holdInvite`'s first-one-wins rule, and independent
 * review 26b is the reason it exists. Merely *opening* a second invitation must not move
 * the attribution — that is a link tapped, not a decision. But when somebody is looking
 * at invitation B and takes an action **on that screen**, B is the one they chose, and
 * the background hook must not go on to redeem A behind them.
 *
 * The concrete case review 26b found: token A held, the person opens token B, taps *Use
 * a different account*, signs in as somebody else — and `useRedeemPendingInvite` credited
 * A's owner for an invitation the person had never acted on.
 *
 * The operation id and the attempt count are reset with it: a different invitation is a
 * different decision, and reusing the previous one's id would have the new token
 * answered `already_applied` for a call it was never part of.
 */
export async function replacePendingInvite(token: string): Promise<void> {
  if (!isInviteToken(token)) return;
  await writePref(TOKEN_KEY, token);
  await writePref<string | null>(OPERATION_KEY, null);
  await writePref<number | null>(ATTEMPTS_KEY, null);
}

/**
 * Makes one token the pending one and returns the operation id to redeem it with.
 *
 * **The single entry point for acting on a specific invitation**, and it exists because
 * independent review 26c found that fixing the account switch alone was not enough. Any
 * explicit action on a screen showing token B has to reconcile the stored token *before*
 * it takes an operation id, or three things go wrong at once:
 *
 *   * B is submitted carrying **A's** operation id. If A's earlier uncertain call had in
 *     fact committed, the server answers `already_applied` — and the screen reports B as
 *     accepted while A's owner holds the credit.
 *   * A non-final answer leaves A pending, so the background hook redeems A afterwards,
 *     possibly in the same session.
 *   * Either way the attribution is immutable, so B can never be credited afterwards.
 *
 * When the stored token already **is** this one, nothing is reset: the held id is the
 * whole point of the retry path, and dropping it would make a lost reply a second call.
 * Only a genuinely different invitation replaces it.
 */
export async function claimForRedemption(
  token: string,
  mint: () => string,
): Promise<string | null> {
  if (!isInviteToken(token)) return null;
  const held = await pendingInvite();
  if (held !== token) await replacePendingInvite(token);
  return redemptionOperationId(mint);
}

export async function pendingInvite(): Promise<string | null> {
  const token = await readPref<string>(TOKEN_KEY);
  return isInviteToken(token) ? token : null;
}

export async function clearPendingInvite(): Promise<void> {
  await writePref<string | null>(TOKEN_KEY, null);
  await writePref<string | null>(OPERATION_KEY, null);
  await writePref<number | null>(ATTEMPTS_KEY, null);
}

/**
 * Records one recoverable refusal and says whether there are any left.
 *
 * Returns true while the token should be kept. Counted in storage rather than in memory
 * because the retries are on *different launches*: a block lifted tomorrow is the case
 * this exists for, and a counter in a ref would reset every time the app started, which
 * is exactly the unbounded retry the ceiling is there to avoid.
 *
 * **It releases the operation id, and without that the whole mechanism is inert.**
 * Independent review 26b found it: an `unavailable` refusal is a *settled* answer, so
 * `_claim_operation` has committed and that id is spent. A retry carrying it is answered
 * `already_applied` — the server never looks at the token, the block or the suspension
 * again — so the next launch would report a replay of a call that refused, and the client
 * would clear the invitation as though it had been dealt with. Five attempts against a
 * spent id are five identical non-answers.
 *
 * This is `lib/operation-intent.ts`'s asymmetric rule, and the first version of this file
 * quoted it and then broke it: **the id is dropped the moment the server answers
 * anything, and held only when the outcome was never established.** A fresh id on the
 * next launch is correct precisely because that launch is a genuinely new attempt.
 */
export async function recordRecoverableRefusal(): Promise<boolean> {
  const spent = (await readPref<number>(ATTEMPTS_KEY)) ?? 0;
  const next = spent + 1;
  if (next >= MAX_RECOVERABLE_ATTEMPTS) return false;
  await writePref(ATTEMPTS_KEY, next);
  await writePref<string | null>(OPERATION_KEY, null);
  return true;
}

/**
 * Drops the held operation id and keeps everything else.
 *
 * For the refusal that certainly did **not** commit — `53400` from the rate limiter,
 * `42501` from the caller's own suspension. The claim was rolled back with the raise, so
 * the id was never spent and the next attempt is a genuine new one. Holding it would be
 * harmless today and wrong tomorrow, and the asymmetry is the rule rather than an
 * optimisation.
 */
export async function releaseRedemptionOperationId(): Promise<void> {
  await writePref<string | null>(OPERATION_KEY, null);
}

/**
 * The operation id this device will use for the redemption, minted once and reused.
 *
 * The id belongs to the *intent* and not to the attempt — `lib/operation-intent.ts`
 * states the rule and the reviews that established it. Here the intent spans a process
 * boundary: the app can be killed between a redemption that committed and the reply
 * that never arrived, and the retry on the next launch has to carry the same id or
 * `_claim_operation` cannot recognise it. A fresh id would be a second genuine call,
 * and a second call against the ceiling for one decision.
 *
 * Stored beside the token and cleared with it.
 */
export async function redemptionOperationId(mint: () => string): Promise<string> {
  const held = await readPref<string>(OPERATION_KEY);
  if (typeof held === 'string' && held.length > 0) return held;
  const fresh = mint();
  await writePref(OPERATION_KEY, fresh);
  return fresh;
}
