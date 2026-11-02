import { readPref, writePref } from '@/lib/prefs';

import { serialiseRedemption } from './serialise';

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
 * So the screen writes it down before it is routed away, and the person is brought back
 * to the invitation from the other side of signup. This is the difference between *the
 * invitation works for people who already had Bingd* and *the invitation works*, which is
 * the entire point of the resolver.
 *
 * ---------------------------------------------------------------------------
 * A held token is a place to come back to, never a decision
 * ---------------------------------------------------------------------------
 *
 * Security audit 2026-11-01, B-1. This file used to hold every token that was merely
 * opened, and the layout redeemed whatever it found, so opening a link and leaving was
 * enough to connect two accounts. Now:
 *
 *   * a token is held **only** while there is no account to show the invitation to.
 *     Somebody already signed in has it in the route, and leaving that screen is the end
 *     of it;
 *   * holding one does nothing but bring the person back to the invitation screen, once;
 *   * the only thing that redeems is a press of Accept. `claimForRedemption` records that
 *     press as an operation id, and an id is the only thing that lets a token be sent
 *     without a person looking at it — and then only as a replay of that same press,
 *     whose answer never arrived.
 *
 * **The id lives under a new key on purpose.** `invite.pendingOperation` was minted by the
 * background path too, so a value left there by an older build says nothing about anybody
 * having pressed anything, and reading it would turn that build's silent attempt into a
 * consent.
 *
 * **A press belongs to the account that made it, and to the invitation it was made on.**
 * The ledger is per account, so an id replayed under a different one looks like a fresh
 * call, and on a shared phone that would accept the invitation for somebody who only signed
 * in. The token is the same question: it lives under its own key, so a process killed
 * between two writes could leave one invitation beside a press made on another. So the
 * press records both, in one write, and anything else is not a press at all.
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
 * It is cleared on *any* settled answer, including a refusal, and as soon as the screen
 * is showing it: past that point the route has it, and a token left here would bring the
 * person back to an invitation they had already walked away from.
 *
 * The one case it is deliberately kept is a press of Accept whose outcome was never
 * established. That is `write-outcome.ts`'s rule, applied here: an unanswered write may
 * have committed, and the retry carries the same operation id.
 */

const TOKEN_KEY = 'invite.pendingToken';
const OPERATION_KEY = 'invite.acceptedOperation';

/** One press of Accept: the id it minted, who pressed it, and on which invitation. */
type AcceptedPress = { id: string; userId: string; token: string };

/** The shape `create_invite_link` mints: a uuid with the dashes removed. */
export const isInviteToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);

/**
 * Holds a token until there is an account to show it to.
 *
 * **First one wins.** Two invitations opened before signing in is a real sequence — a
 * link in a group chat, then a second from somebody else — and the person who is about
 * to sign up made a decision when they tapped the first one. Overwriting silently would
 * hand the attribution to whichever link they happened to tap last, which is not a
 * choice anybody made. `accept_invite`'s primary key enforces the same rule on the
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
 * which one is held — that is a link tapped, not a decision. But when somebody is looking
 * at invitation B and takes an action **on that screen**, B is the one they chose.
 *
 * The operation id is reset with it: a different invitation is a different decision, and
 * reusing the previous one's id would have the new token answered `already_applied` for a
 * call it was never part of.
 */
export async function replacePendingInvite(token: string): Promise<void> {
  if (!isInviteToken(token)) return;
  await writePref(TOKEN_KEY, token);
  await writePref<AcceptedPress | null>(OPERATION_KEY, null);
}

/**
 * Makes one token the pending one and returns the operation id to accept it with.
 *
 * **The single entry point for accepting a specific invitation**, called from the Accept
 * button and from nowhere else. The id it mints is the record that the button was
 * pressed. Independent review 26c is why it reconciles the stored token first: an
 * explicit action on a screen showing token B has to do that *before* it takes an
 * operation id, or B is submitted carrying **A's** id. If A's earlier uncertain call had
 * in fact committed, the server answers `already_applied` and the screen reports B as
 * accepted while A's owner holds the credit, and the attribution never moves.
 *
 * When the stored token already **is** this one, nothing is reset: the held id is the
 * whole point of the retry path, and dropping it would make a lost reply a second call.
 * Only a genuinely different invitation replaces it.
 */
export async function claimForRedemption(
  token: string,
  userId: string,
  mint: () => string,
): Promise<string | null> {
  if (!isInviteToken(token)) return null;
  const held = await pendingInvite();
  if (held !== token) await replacePendingInvite(token);
  return redemptionOperationId(token, userId, mint);
}

export async function pendingInvite(): Promise<string | null> {
  const token = await readPref<string>(TOKEN_KEY);
  return isInviteToken(token) ? token : null;
}

export async function clearPendingInvite(): Promise<void> {
  await writePref<string | null>(TOKEN_KEY, null);
  await writePref<AcceptedPress | null>(OPERATION_KEY, null);
}

/**
 * The invitation screen has this token now, so storage lets go of it.
 *
 * Called by the screen rather than by whatever routed there, because only the screen
 * knows it arrived: a route can be replaced underneath a push, and clearing first would
 * lose the invitation. Walking away from the screen after this leaves nothing behind.
 *
 * A held operation id means Accept was already pressed and the answer never came, so that
 * pairing is left alone.
 */
export async function releaseShownInvite(token: string, userId: string): Promise<void> {
  await serialiseRedemption(async () => {
    if ((await pendingInvite()) !== token) return;
    if (await acceptedOperationId(token, userId)) return;
    await clearPendingInvite();
  });
}

/**
 * Drops the held operation id and keeps everything else.
 *
 * For the refusal that certainly did **not** commit — `53400` from the rate limiter,
 * `42501` from the caller's own suspension. The claim was rolled back with the raise, so
 * the id was never spent and the next attempt is a genuine new one. Holding it would be
 * harmless today and wrong tomorrow, and the asymmetry is the rule rather than an
 * optimisation.
 *
 * With the id gone the token no longer records a press, so the next launch shows the
 * invitation again rather than sending it.
 */
export async function releaseRedemptionOperationId(): Promise<void> {
  await writePref<AcceptedPress | null>(OPERATION_KEY, null);
}

/**
 * The id of this account's press of Accept on this invitation whose answer never arrived,
 * or null when there was none. Any other press answers null: see the header.
 */
export async function acceptedOperationId(token: string, userId: string): Promise<string | null> {
  const held = await readPref<AcceptedPress>(OPERATION_KEY);
  return held?.userId === userId && held.token === token && held.id.length > 0 ? held.id : null;
}

/**
 * The operation id this device will use for the acceptance, minted once and reused.
 *
 * The id belongs to the *intent* and not to the attempt — `lib/operation-intent.ts`
 * states the rule and the reviews that established it. Here the intent spans a process
 * boundary: the app can be killed between an acceptance that committed and the reply
 * that never arrived, and the retry on the next launch has to carry the same id or
 * `_claim_operation` cannot recognise it. A fresh id would be a second genuine call,
 * and a second call against the ceiling for one decision.
 *
 * Stored beside the token and cleared with it.
 */
export async function redemptionOperationId(
  token: string,
  userId: string,
  mint: () => string,
): Promise<string> {
  const held = await acceptedOperationId(token, userId);
  if (held) return held;
  const fresh = mint();
  await writePref<AcceptedPress>(OPERATION_KEY, { id: fresh, userId, token });
  return fresh;
}
