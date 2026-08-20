import { newOperationId } from '@/features/collection/writes';
import { setAcquisition, track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';
import { classifyWrite } from '@/lib/write-outcome';

import {
  claimForRedemption,
  clearPendingInvite,
  pendingInvite,
  recordRecoverableRefusal,
  releaseRedemptionOperationId,
} from './pending';
import { serialiseRedemption } from './serialise';

/**
 * The client half of `redeem_invite` (`20260819000500`).
 *
 * The server owns every rule — which tokens are live, who may be attributed to whom,
 * and what a replay means. This owns two things the server cannot: turning its answers
 * into a sentence, and deciding whether the held token should survive the attempt.
 */

export type RedeemOutcome =
  /**
   * Attributed, and PRD §17's acceptance semantics have run: the one-way follow, or a
   * request if the inviter is private. `followState` is what actually exists, which is
   * not always what this call would have created — an invitee who already followed
   * their inviter keeps the state they had.
   *
   * The handle is the inviter's and is safe to show: they are the person who gave this
   * link out, and the attribution now connects the two accounts by a fact.
   */
  | { outcome: 'redeemed'; inviterUsername: string | null; followState: 'approved' | 'pending' | null }
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
export async function redeemInvite(token: string, operationId: string): Promise<RedeemOutcome> {
  const { data, error } = await supabase.rpc('redeem_invite', {
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
  };
}

/**
 * Redeems whatever this device is holding, if anything.
 *
 * Called once a session is `ready` — after sign-in *and* after profile creation, which
 * is the ordering `redeem_invite` requires and PRD §17 states: "the recipient must have
 * an account". Calling it during onboarding would be answered `28000` by
 * `assert_can_write`, or worse, attributed to an account that then abandons signup.
 *
 * Returns null when there was nothing to redeem, which is the overwhelming majority of
 * launches and costs one read of device storage.
 *
 * **What is kept, and what is let go.** The question is not "did this commit" — that
 * is `changed`, and it decides whether the operation id is reused. The question here is
 * **"could this succeed later"**, and there are three answers.
 *
 * *Final.* `invalid`, `self` and `already_attributed` never become true later. The
 * token is dropped; keeping it would replay a settled answer on every cold start.
 *
 * *Recoverable, and bounded.* `unavailable` is the one the first version of this file
 * got wrong, and independent review 26 caught it. It covers a block in either direction
 * and a suspended inviter — **both of which get lifted** — so a recipient who completed
 * signup during a temporary block was losing their invitation permanently. It is now
 * retried on later launches, up to `MAX_RECOVERABLE_ATTEMPTS`, because the same answer
 * also covers a deleted inviter, which never recovers.
 *
 * *Unsettled.* `failed` is always kept — including when `changed` is false, which
 * reaches here as `53400` from the rate limiter or `42501` from the caller's own
 * suspension. Both stop being true. Discarding somebody's invitation because they were
 * briefly over a ceiling is the failure this beta can least afford, and the cost of
 * keeping it is one call on the next launch.
 *
 * ---------------------------------------------------------------------------
 * The operation id is a second decision, and it is the opposite one
 * ---------------------------------------------------------------------------
 *
 * Whether to keep the **token** asks *could this succeed later*. Whether to keep the
 * **id** asks *did the server already record this attempt*, and the two answers do not
 * line up — which is the defect independent review 26b found in the first version.
 *
 * `unavailable` is settled, so `_claim_operation` committed and that id is **spent**. A
 * retry carrying it is answered `already_applied`; the server never reconsiders the
 * token, the block or the suspension. So the five recoverable attempts were five
 * identical non-answers, and the mechanism was inert.
 *
 * The rule, from `lib/operation-intent.ts` and now actually followed: **the id is
 * dropped the moment the server answers anything, and held only when the outcome was
 * never established.** So it is released on `unavailable`, released on a `failed` that
 * was certainly refused, and held only on a `failed` that may have committed.
 *
 * ---------------------------------------------------------------------------
 * Inside the queue, and the token is read inside it too
 * ---------------------------------------------------------------------------
 *
 * Independent review 26d. This call and an explicit tap on the invitation screen can be
 * in flight at once — the hook stands down when the route changes, but the promise it has
 * already started does not stop — and reading the token and taking an id are two separate
 * awaits over storage. Interleaved, the two could be handed the **same** operation id
 * while each still held a *different* token, and whichever request reached the server
 * first would take an attribution that never moves.
 *
 * So the whole body runs inside `serialiseRedemption`, and the token is read **within**
 * it rather than before it. A queued attempt therefore sees whatever the attempt ahead of
 * it left behind: if that was an acceptance of a different invitation, this one re-reads
 * the pending token and is either a no-op or the redemption of a token still waiting.
 *
 * `claimForRedemption` rather than `redemptionOperationId`, so there is exactly one way
 * in this app to obtain an id for a redemption, and it always pairs that id with the
 * token it was taken for.
 */
export async function redeemPendingInvite(): Promise<RedeemOutcome | null> {
  return serialiseRedemption(async () => {
    const token = await pendingInvite();
    if (!token) return null;

    const operationId = await claimForRedemption(token, newOperationId);
    if (!operationId) return null;

    return settle(token, operationId);
  });
}

/**
 * Runs one redemption and applies the keep-or-let-go rule above.
 *
 * Shared by the background path and the invitation screen so the two cannot drift on what
 * an answer means — the screen used to carry its own copy of this branch, and two copies
 * of a rule this fiddly is how they end up disagreeing about `unavailable`.
 *
 * **Assumes it is already inside `serialiseRedemption`.** Both callers put it there, and
 * that is the invariant review 26d's race turns on: reading the token, taking an id for
 * it, and sending the two together has to be one critical section.
 */
export async function settle(token: string, operationId: string): Promise<RedeemOutcome> {
  const result = await redeemInvite(token, operationId);

  if (result.outcome === 'failed') {
    // A refusal that certainly did not commit rolled its claim back with the raise, so
    // the id was never spent and the next attempt is a genuine new one. Only an
    // unestablished outcome keeps it.
    if (!result.changed) await releaseRedemptionOperationId();
    return result;
  }

  // The one recoverable refusal. Kept while attempts remain — with a fresh id, or the
  // retry is answered `already_applied` and nothing is reconsidered. Let go when they
  // run out, so a permanently dead invitation stops costing a request on every launch.
  if (result.outcome === 'unavailable') {
    if (!(await recordRecoverableRefusal())) await clearPendingInvite();
    return result;
  }

  await clearPendingInvite();
  return result;
}
