/**
 * Invitations, the half below the link.
 *
 * `create_invite_link` and the share sheet live in `features/recommendations` because
 * that is where the share is started from. What is here is everything after the tap on
 * the recipient's side: holding the token across signup, redeeming it, and reporting
 * the redemption.
 */
export {
  claimForRedemption,
  clearPendingInvite,
  holdInvite,
  isInviteToken,
  MAX_RECOVERABLE_ATTEMPTS,
  pendingInvite,
  recordRecoverableRefusal,
  releaseRedemptionOperationId,
  replacePendingInvite,
} from './pending';
/**
 * `redemptionOperationId` is deliberately **not** exported.
 *
 * Independent review 26d: it was reachable, and a caller that took an id without first
 * claiming the token it belongs to is exactly the divergence `claimForRedemption` exists
 * to prevent. One way in, and it pairs the id with its token.
 */
/**
 * `resetRedemptionQueueForTests` is deliberately not re-exported either. Review 26e:
 * calling it while a redemption is in flight would step straight past the correctness
 * boundary the queue exists to be. The tests that need it import it from './serialise'.
 */
export { serialiseRedemption } from './serialise';
export { redeemInvite, redeemPendingInvite, settle, type RedeemOutcome } from './redeem';
export { revokeInviteLink, type RevokeOutcome } from './revoke';
export { useRedeemPendingInvite } from './use-pending-invite';
