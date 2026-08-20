/**
 * One redemption at a time, process-wide.
 *
 * ---------------------------------------------------------------------------
 * The race this closes
 * ---------------------------------------------------------------------------
 *
 * Independent review 26d. `claimForRedemption` made *sequential* acceptance correct — the
 * displayed token becomes the pending one before an operation id is taken — but reading
 * the token and reading the id are two `await`s over device storage, and two redemptions
 * can be in flight in one process:
 *
 *   1. off the invitation screen, `useRedeemPendingInvite` starts and reads pending token
 *      **A**. The route then changes, which stands the hook down for *future* effects and
 *      does not cancel the promise already running;
 *   2. the person opens invitation **B** and taps Accept. `claimForRedemption(B)` replaces
 *      the pending token and clears the stored id;
 *   3. both calls now ask for an operation id with nothing serialising them, and can be
 *      handed the **same** one while each still holds its own token;
 *   4. whichever request reaches the server first takes the attribution. If that is A,
 *      B is answered `already_applied` and the screen reports "Already accepted" for an
 *      invitation whose owner received nothing.
 *
 * And the attribution is immutable, so B can never be credited afterwards. The same shape
 * exists between two invitation screens in the navigation stack: each has its own `busy`,
 * and neither knows about the other.
 *
 * ---------------------------------------------------------------------------
 * Why a queue, and why here rather than in the storage layer
 * ---------------------------------------------------------------------------
 *
 * The critical section is not one read or one write — it is **read the token, take an id
 * for that token, send them together**. A lock inside `readPref`/`writePref` would make
 * each step atomic and leave the sequence exactly as interleavable as it is now. So the
 * whole redemption runs inside the queue, and every caller uses it.
 *
 * A promise chain rather than a flag: a flag makes the second caller give up, and giving
 * up is wrong here. The background attempt and the explicit tap are both things somebody
 * wants to happen; they simply must not happen at once. Queued, the second one runs
 * against storage the first has finished with, re-reads the pending token, and is either
 * a no-op — the account is attributed, and the server answers `already_attributed` — or
 * the genuine redemption of a token that is still pending.
 *
 * **Process-wide is the whole scope, and it is sufficient.** A phone runs one app
 * process, and the server's own guarantees cover everything beyond it: the primary key on
 * `invite_attributions.invitee_id` means two devices cannot both be credited, and
 * `_claim_operation` means one id cannot be spent twice. This closes the gap those two
 * cannot see — one process holding one storage slot for two different tokens.
 *
 * Failures do not poison the queue: the chain continues on rejection as well as on
 * fulfilment, or one dropped connection would stop every later redemption in the session.
 */

let chain: Promise<unknown> = Promise.resolve();

export function serialiseRedemption<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Exported for tests, which must not inherit a previous test's queue. */
export function resetRedemptionQueueForTests(): void {
  chain = Promise.resolve();
}
