import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { signOut, useAuth } from '@/features/auth';
import { newOperationId } from '@/features/collection/writes';
import {
  claimForRedemption,
  holdInvite,
  isInviteToken,
  replacePendingInvite,
  serialiseRedemption,
  settle,
  type RedeemOutcome,
} from '@/features/invite';
import { Button, EmptyState, LoadingScreen, Screen } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Invitation acceptance, `https://bingd.app/i/<token>` (PRD §17).
 *
 * ---------------------------------------------------------------------------
 * The three ways somebody arrives here, and the one that used to lose them
 * ---------------------------------------------------------------------------
 *
 * **Signed in.** A verified Universal Link opens this screen with the token in hand.
 * Acceptance is an explicit tap, never automatic — PRD §17 — because the account that
 * would be attributed is whichever one happens to be signed in, and silently binding an
 * invitation to it is a decision the person did not make.
 *
 * **Signed out.** `useAuthRouting` replaces this route with `/(auth)/sign-in` the moment
 * it sees no session, and everything after that — a code by email, Apple, Google, then
 * the profile form — rebuilds the stack. So the token is written to device storage
 * *first*, in an effect that runs before any of that, and the redemption happens from
 * the other side of signup. `features/invite/pending.ts` is the whole of that mechanism
 * and states why every alternative loses it.
 *
 * **Signed in as somebody else.** The screen names the account that will be attributed
 * *before* the tap, and offers to change it — §17's "clear disclosure of which account
 * will accept, with an option to switch". The switch is a sign-out that keeps the token
 * held, so the invitation survives it.
 *
 * ---------------------------------------------------------------------------
 * What is not on this screen
 * ---------------------------------------------------------------------------
 *
 * The inviter is not named before acceptance. Naming them would need a read of
 * `profiles` keyed on a token held by somebody with no account and no relationship to
 * them, which is a way to learn who an account is from outside every visibility rule
 * the app has. The handle comes back from `redeem_invite` *after* the attribution
 * exists, at which point the two accounts are connected by a fact.
 *
 * ---------------------------------------------------------------------------
 * What acceptance does, and it is §17's list
 * ---------------------------------------------------------------------------
 *
 * The tap calls `redeem_invite`, which writes the attribution **and** creates the
 * one-way follow §17 specifies — a follow *request* when the inviter is private, so the
 * private setting is honoured rather than bypassed — and files the inviter's
 * notification, which is what prompts them to follow back. The inviter is never
 * auto-followed.
 *
 * An earlier version of this screen wrote only the attribution and recorded the
 * omission in the PRD as a deliberate narrowing. Independent review 26 rejected that,
 * and rightly: a specification is not amended by a note saying it was not implemented.
 */
export default function InvitationScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const auth = useAuth();
  const router = useRouter();

  const [result, setResult] = useState<RedeemOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = isInviteToken(token);

  /**
   * Held before anything else can route this screen away.
   *
   * Unconditional on the auth state, and that is deliberate: by the time the effect
   * could check, the redirect may already have happened. A token held for a session
   * that turns out to be signed in costs one storage write and is cleared by the
   * redemption below.
   */
  useEffect(() => {
    if (valid) void holdInvite(token);
  }, [token, valid]);

  /**
   * One acceptance at a time, and **one redemption at a time in the whole process**.
   *
   * `busy` is local to this screen, so it does not serialise this tap against the
   * background hook, or against a second invitation screen in the stack —
   * `serialiseRedemption` is what does, and review 26d is the reason it exists. Both are
   * kept: the queue is the correctness boundary, and `busy` is what stops the button
   * being tapped twice while it waits.
   */
  const accept = useCallback(async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const outcome = await serialiseRedemption(async () => {
      /**
       * Claims *this* invitation before taking an id, which is the whole of independent
       * review 26c's Major.
       *
       * The naive version asked for the held operation id and sent this token with it.
       * With another token already pending, that submits B carrying A's id — and if A's
       * earlier uncertain call had committed, the server answers `already_applied` while
       * this screen reports B as accepted and A's owner holds the credit.
       *
       * `claimForRedemption` makes the displayed token the pending one first, resetting
       * the id only when it genuinely changed. When it is already this token — the
       * ordinary case, and every retry — the held id is kept, which is what makes a lost
       * reply a replay rather than a second call.
       */
        const operationId = await claimForRedemption(token, newOperationId);
        // `settle` owns the keep-or-let-go rule, so this screen and the background hook
        // cannot drift on what an answer means.
        return operationId ? settle(token, operationId) : null;
      });

      if (outcome) setResult(outcome);
    } finally {
      setBusy(false);
    }
  }, [busy, token, valid]);

  /**
   * §17's "clear disclosure of which account will accept, **with an option to switch**".
   *
   * Independent review 26 found the second half missing: the screen named the account
   * and offered no way to change it, so somebody signed into an old account on a shared
   * phone could see the problem and do nothing about it.
   *
   * Signing out is the switch. There is no account picker in this app and adding one is
   * a product decision this run has no authority to take — but **the token stays held**,
   * which is what makes this work: sign-out sends them to `/(auth)/sign-in`, and
   * `useRedeemPendingInvite` redeems against whichever account they arrive as. The
   * invitation survives the switch without them having to find the link again.
   *
   * **It claims *this* invitation first, and independent review 26b is why.**
   * `holdInvite` keeps the first token it is given, deliberately: opening a second link
   * is a link tapped, not a decision, and it must not move an attribution. But acting on
   * *this* screen is a decision about *this* invitation — so somebody looking at token B
   * with token A still held would otherwise sign out, sign in as somebody else, and have
   * the background hook credit A's owner for an invitation they never acted on.
   */
  const switchAccount = useCallback(async () => {
    if (busy || !valid) return;
    setBusy(true);
    try {
      await replacePendingInvite(token);
      await signOut();
    } catch {
      // Already signed out, or the network is gone. Routing settles it either way, and
      // an error about signing out is not a thing to put in front of an invitation.
    } finally {
      setBusy(false);
    }
  }, [busy, token, valid]);

  if (!valid) {
    return (
      <Screen airy includeBottomInset>
        <EmptyState
          kind="couldNotLoad"
          title="That invitation link is incomplete"
          body="Messaging apps sometimes cut long links in half. Ask whoever invited you to send it again."
          action={{ label: 'Go to your collection', onPress: () => router.replace('/collection') }}
        />
      </Screen>
    );
  }

  // Signed out or mid-signup. `useAuthRouting` is already moving them; this is what is
  // on screen for the instant before it does, and it says the invitation is safe.
  if (auth.status !== 'ready') {
    return auth.status === 'loading' ? (
      <LoadingScreen />
    ) : (
      <Screen airy includeBottomInset>
        <EmptyState
          kind="nothingYet"
          title="You have been invited to bingd."
          body="Sign in or create your account, and this invitation will be waiting when you get there."
        />
      </Screen>
    );
  }

  if (result) return <Outcome result={result} onRetry={accept} busy={busy} />;

  return (
    <Screen airy includeBottomInset>
      <EmptyState
        kind="nothingYet"
        title="You have been invited to bingd."
        // The account that will be attributed, named before the tap rather than after
        // it. PRD §17: a person signed into a second account must be able to see which
        // one is about to accept.
        body={`Accepting records that you joined on this invitation and follows the person who invited you. You are signed in as @${auth.profile.username}.`}
        action={{ label: busy ? 'Accepting…' : 'Accept invitation', onPress: () => void accept() }}
      />
      <View style={styles.secondary}>
        <Button
          kind="tertiary"
          label="Use a different account"
          onPress={() => void switchAccount()}
          disabled={busy}
          disabledReason="Finishing the last attempt."
        />
      </View>
    </Screen>
  );
}

/**
 * What each answer says, and what it deliberately does not.
 *
 * `unavailable` covers a block in either direction, a suspended inviter and a deleted
 * one, with one sentence — the server distinguishes them and this does not, because a
 * message that read "they have blocked you" would let anybody detect a block, or a
 * suspension, by redeeming a link they were forwarded.
 */
/**
 * What acceptance did, in the recipient's words.
 *
 * The follow state is the server's, and it is not always the one this call created: an
 * invitee who already followed their inviter keeps the state they had, and telling
 * somebody approved months ago that they have "asked to follow" would be wrong.
 */
function acceptedBody(
  inviterUsername: string | null,
  followState: 'approved' | 'pending' | null,
): string {
  const who = inviterUsername ? `@${inviterUsername}` : 'the person who invited you';
  const follow =
    followState === 'pending'
      ? ` You have asked to follow ${who}, and they will get the request.`
      : followState === 'approved'
        ? ` You are now following ${who}.`
        : '';
  return `You joined on ${who}'s invitation.${follow} Rank ten titles and they will hear about it.`;
}

function Outcome({
  result,
  onRetry,
  busy,
}: {
  result: RedeemOutcome;
  onRetry: () => Promise<void>;
  busy: boolean;
}) {
  const router = useRouter();
  const toCollection = {
    label: 'Start ranking',
    onPress: () => router.replace('/collection'),
  };

  switch (result.outcome) {
    case 'redeemed':
      return (
        <Screen airy includeBottomInset>
          <EmptyState
            kind="nothingYet"
            title="You are in"
            // Which of the two follow states happened is said out loud: "following"
            // and "asked to follow" are different, and the person will look for one of
            // them on the inviter's profile a moment later.
            body={acceptedBody(result.inviterUsername, result.followState)}
            action={toCollection}
          />
        </Screen>
      );

    case 'already_attributed':
      return (
        <Screen airy includeBottomInset>
          <EmptyState
            kind="nothingYet"
            title="Already accepted"
            // An attribution is written once and never moves. Which invitation it was is
            // not said, because it may be from an account this person cannot see.
            body="Your account is already recorded as having joined on an invitation."
            action={toCollection}
          />
        </Screen>
      );

    /**
     * A replay the operation ledger recognised, and the two halves are **not** the same
     * thing — independent review 26b found this screen reporting both as success.
     *
     * `attributed` is what the original call actually achieved. True means the
     * attribution exists and this is the ordinary lost-reply path. False means the
     * original was *refused*, for a reason the ledger does not record, and telling
     * somebody "already accepted" when nothing was accepted is the one thing this screen
     * must not do.
     */
    case 'already_applied':
      return result.attributed ? (
        <Screen airy includeBottomInset>
          <EmptyState
            kind="nothingYet"
            title="Already accepted"
            body="Your account is already recorded as having joined on an invitation."
            action={toCollection}
          />
        </Screen>
      ) : (
        <Screen airy includeBottomInset>
          <EmptyState
            kind="couldNotLoad"
            title="This invitation was not accepted"
            body="An earlier attempt did not go through, and it cannot be repeated. Ask whoever invited you for their current link."
            action={toCollection}
          />
        </Screen>
      );

    case 'self':
      return (
        <Screen airy includeBottomInset>
          <EmptyState
            kind="nothingYet"
            title="That is your own link"
            body="Send it to somebody who is not on bingd. yet, and they will land here."
            action={toCollection}
          />
        </Screen>
      );

    case 'invalid':
      return (
        <Screen airy includeBottomInset>
          <EmptyState
            kind="couldNotLoad"
            title="This invitation is not valid"
            // One sentence for three server states — unknown, revoked, and minted in
            // another environment. Telling them apart would confirm that a token was
            // once real, which is what its 128 bits of entropy exist to withhold.
            body="It may have been replaced by a newer link. Ask whoever invited you for their current one."
            action={toCollection}
          />
        </Screen>
      );

    case 'unavailable':
      return (
        <Screen airy includeBottomInset>
          <EmptyState
            kind="couldNotLoad"
            title="This invitation cannot be accepted"
            body="The account it came from is not available. You can still use bingd. — nothing else is affected."
            action={toCollection}
          />
        </Screen>
      );

    case 'failed':
      return (
        <Screen airy includeBottomInset>
          <EmptyState
            kind="couldNotLoad"
            title="Could not accept the invitation"
            // Kept, not lost: the token is still on the device and the retry carries
            // the same operation id, so a call that committed and lost its reply is
            // recognised rather than repeated.
            body={`${result.message} Your invitation has been kept — try again, or open the link later.`}
            action={{ label: busy ? 'Trying…' : 'Try again', onPress: () => void onRetry() }}
          />
        </Screen>
      );
  }
}

const styles = StyleSheet.create({
  // Under the empty state's own action and quieter than it: switching accounts is the
  // rare path, and the invitation is what the screen is about.
  secondary: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[4],
    alignItems: 'center',
  },
});
