import { newOperationId } from '@/features/collection/writes';
import { setAcquisition, track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';
import { classifyWrite } from '@/lib/write-outcome';

import {
  acceptedOperationId,
  clearPendingInvite,
  pendingInvite,
  releaseRedemptionOperationId,
} from './pending';
import { serialiseRedemption } from './serialise';

/**
 * The client half of `accept_invite` and `invite_preview` (`20261024000100`).
 *
 * The server owns every rule — which tokens are live, who may be attributed to whom,
 * and what a replay means. This owns two things the server cannot: turning its answers
 * into a sentence, and deciding whether the held token should survive the attempt.
 *
 * **The server takes the call as the consent**, so `acceptInvite` has exactly two callers:
 * the Accept button, and `resumePendingInvite` replaying a press of it. `redeem_invite`
 * is no longer sent from here. It stays on the server for installed builds, and it
 * connects nobody.
 */

export type RedeemOutcome =
  /**
   * Attributed, and PRD §17's acceptance semantics have run. Since `20260912000200` a
   * **personal** token connects both parties, both edges approved, whatever either
   * account's visibility says; a `referral` token still writes the one-way follow, or a
   * request if its owner is private. `followState` is what actually exists, which is
   * not always what this call would have created — an invitee who already followed
   * their inviter keeps the state they had.
   *
   * The handle is the inviter's and is safe to show: they are the person who gave this
   * link out, and the attribution now connects the two accounts by a fact.
   */
  | {
      outcome: 'redeemed';
      inviterUsername: string | null;
      followState: 'approved' | 'pending' | null;
      /** Both directions came out approved, as read back by the server. */
      connected: boolean;
    }
  /**
   * The operation ledger recognised this id. The redemption already happened — or
   * already refused — and either way there is nothing left to do with the token.
   */
  | { outcome: 'already_applied'; attributed: boolean }
  /** Unknown, revoked, or minted in another environment. One answer; see the migration. */
  | { outcome: 'invalid' }
  /** Their own link. The ordinary way somebody checks what they just shared. */
  | { outcome: 'self' }
  /** A block in either direction, or an inviter who is gone or suspended. */
  | { outcome: 'unavailable' }
  /** This account already has an inviter, and an attribution never moves. */
  | { outcome: 'already_attributed' }
  /**
   * The call did not settle. `changed` carries `write-outcome.ts`'s reading: unknown
   * means it may have committed, so the token and its operation id are **kept** and the
   * retry carries the same id.
   */
  | { outcome: 'failed'; message: string; changed: boolean };

const REASON: Record<string, RedeemOutcome> = {
  invalid: { outcome: 'invalid' },
  self: { outcome: 'self' },
  blocked: { outcome: 'unavailable' },
  unavailable: { outcome: 'unavailable' },
  already_attributed: { outcome: 'already_attributed' },
};

/**
 * `blocked` and `unavailable` deliberately collapse into one client-facing outcome.
 *
 * The server distinguishes them because the two callers it has to be fair to are
 * different — a block is a fact the caller is party to — but the *screen* has one
 * sentence to say either way, and a message that read "they have blocked you" where the
 * other read "that account is unavailable" would turn a suspension into something a
 * stranger could detect by inviting themselves through somebody else's link.
 */
export async function acceptInvite(token: string, operationId: string): Promise<RedeemOutcome> {
  const { data, error } = await supabase.rpc('accept_invite', {
    p_operation_id: operationId,
    p_token: token,
  });

  if (error) {
    return {
      outcome: 'failed',
      message: error.message,
      changed: classifyWrite(error) === 'unknown',
    };
  }

  const result = data as {
    status?: string;
    reason?: string;
    attributed?: boolean;
    inviter_username?: string | null;
    follow_state?: string | null;
    connected?: boolean;
  } | null;

  if (!result) {
    // A 200 with an unusable body. The request was answered, so whatever it did is
    // committed — the same reading `ranking/session.ts` takes of the same shape.
    return { outcome: 'failed', message: 'The server said nothing.', changed: true };
  }

  if (result.status === 'already_applied') {
    return { outcome: 'already_applied', attributed: Boolean(result.attributed) };
  }

  if (result.status === 'refused') {
    return REASON[result.reason ?? ''] ?? { outcome: 'invalid' };
  }

  /**
   * `invite_redeemed`, and it follows the **row** rather than the tap.
   *
   * Emitted only on `ok`, which is the one answer that means an attribution row was
   * inserted by this call. `already_applied` is a replay of a redemption that was
   * already counted; every refusal wrote nothing. So one invitation claimed is counted
   * once, and a lost reply is under-counted rather than double-counted — the direction
   * `analytics.md` §6 requires everywhere.
   *
   * No token, no inviter, no handle. `ALLOWED_PROPERTY_KEYS` would strip them anyway;
   * they are not sent in the first place.
   */
  track({ name: 'invite_redeemed' });

  /**
   * The first honest writer for `acquisition_source`, which has existed unset since
   * analytics were built. Redemption is the one mechanism that establishes how somebody
   * arrived without inferring it from behaviour, and every event this account sends from
   * here on carries it.
   */
  setAcquisition({ source: 'invite' });

  const followState =
    result.follow_state === 'approved' || result.follow_state === 'pending'
      ? result.follow_state
      : null;

  return {
    outcome: 'redeemed',
    inviterUsername: result.inviter_username ?? null,
    followState,
    connected: result.connected === true,
  };
}

/** What `invite_preview` says about a token, before anything is granted. */
export type InvitePreview =
  | {
      outcome: 'ready';
      kind: 'personal' | 'referral';
      inviterUsername: string;
      inviterDisplayName: string | null;
    }
  | { outcome: 'invalid' }
  | { outcome: 'self' }
  | { outcome: 'unavailable' }
  | { outcome: 'already_attributed' };

/**
 * Whose invitation this is. A throw means the question went unanswered, and the screen
 * must not offer Accept on that basis: consent to a person it could not name is not
 * consent.
 */
export async function previewInvite(token: string): Promise<InvitePreview> {
  const { data, error } = await supabase.rpc('invite_preview', { p_token: token });
  if (error) throw error;

  const result = data as {
    status?: string;
    reason?: string;
    kind?: string;
    inviter_username?: string;
    inviter_display_name?: string | null;
  } | null;

  if (result?.status === 'ok' && result.inviter_username) {
    return {
      outcome: 'ready',
      kind: result.kind === 'referral' ? 'referral' : 'personal',
      inviterUsername: result.inviter_username,
      inviterDisplayName: result.inviter_display_name ?? null,
    };
  }

  switch (result?.reason) {
    case 'self':
    case 'unavailable':
    case 'already_attributed':
      return { outcome: result.reason };
    default:
      return { outcome: 'invalid' };
  }
}

/**
 * What a signed-in session does with whatever this device is holding.
 *
 * Returns the token to show the person, or null when there is nothing to show — which is
 * the overwhelming majority of launches and costs one read of device storage.
 *
 * **It never accepts anything on its own.** A held token with no operation id was opened
 * and never answered, so all this does is hand it back for the invitation screen. The one
 * thing it sends is a replay: an id is only ever minted by a press of Accept, so a token
 * with this account's id is a press whose answer was lost, and the retry has to carry that
 * same id for `_claim_operation` to recognise it.
 *
 * ---------------------------------------------------------------------------
 * Inside the queue, and the token is read inside it too
 * ---------------------------------------------------------------------------
 *
 * Independent review 26d. This call and a tap on the invitation screen can be in flight
 * at once, and reading the token and reading its id are two separate awaits over storage.
 * Run in the queue, a queued attempt sees whatever the attempt ahead of it left behind.
 */
export async function resumePendingInvite(userId: string): Promise<string | null> {
  return serialiseRedemption(async () => {
    const token = await pendingInvite();
    if (!token) return null;

    const operationId = await acceptedOperationId(token, userId);
    if (!operationId) return token;

    await settle(token, operationId);
    return null;
  });
}

/**
 * Runs one acceptance and applies the keep-or-let-go rule.
 *
 * Shared by the replay above and the invitation screen so the two cannot drift on what an
 * answer means.
 *
 * Whether to keep the **id** asks *did the server already record this attempt*. The rule,
 * from `lib/operation-intent.ts`: **the id is dropped the moment the server answers
 * anything, and held only when the outcome was never established.** So it is held only on
 * a `failed` that may have committed.
 *
 * Every settled answer lets the token go, `unavailable` included. That one covers a block
 * and a suspended inviter, both of which get lifted, and it used to be retried on later
 * launches. That retry would now connect two accounts days after the screen told the
 * person it could not, so they open the link again instead.
 *
 * **Assumes it is already inside `serialiseRedemption`.** Both callers put it there, and
 * that is the invariant review 26d's race turns on: reading the token, taking an id for
 * it, and sending the two together has to be one critical section.
 */
export async function settle(token: string, operationId: string): Promise<RedeemOutcome> {
  const result = await acceptInvite(token, operationId);

  if (result.outcome === 'failed') {
    // A refusal that certainly did not commit rolled its claim back with the raise, so
    // the id was never spent and the next attempt is a genuine new one. Only an
    // unestablished outcome keeps it.
    if (!result.changed) await releaseRedemptionOperationId();
    return result;
  }

  await clearPendingInvite();
  return result;
}
