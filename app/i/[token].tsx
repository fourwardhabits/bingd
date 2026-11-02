import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { signOut, useAuth } from '@/features/auth';
import { newOperationId } from '@/features/collection/writes';
import {
  claimForRedemption,
  clearPendingInvite,
  holdInvite,
  isInviteToken,
  previewInvite,
  releaseShownInvite,
  replacePendingInvite,
  serialiseRedemption,
  settle,
  type InvitePreview,
  type RedeemOutcome,
} from '@/features/invite';
import { queryKeys } from '@/lib/query';
import { Button, EmptyState, LoadingScreen, Screen } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Invitation acceptance, `https://bingd.app/i/<token>` (PRD §17).
 *
 * ---------------------------------------------------------------------------
 * The rule this screen exists to keep
 * ---------------------------------------------------------------------------
 *
 * **Accepting is an explicit tap, and nothing else on this path grants anything.** Opening
 * a link connects nobody. Security audit 2026-11-01, B-1: this screen used to store every
 * token it was opened with, and the layout redeemed it behind the person, so a private
 * account that opened an attacker's link and left had made the attacker an approved
 * follower. The tap is what calls `accept_invite`, and the server takes that call as the
 * consent, so the screen has to say first who it is from and what it does.
 *
 * ---------------------------------------------------------------------------
 * The three ways somebody arrives here, and the one that used to lose them
 * ---------------------------------------------------------------------------
 *
 * **Signed in.** A verified Universal Link opens this screen with the token in hand, and
 * the route is the only place the token lives. Leaving the screen is the end of it.
 *
 * **Signed out.** `useAuthRouting` replaces this route with `/(auth)/sign-in` the moment
 * it sees no session, and everything after that — a code by email, Apple, Google, then
 * the profile form — rebuilds the stack. So the token is written to device storage
 * *first*, in an effect that runs before any of that, and `useResumePendingInvite` brings
 * the person back here from the other side of signup. `features/invite/pending.ts` is the
 * whole of that mechanism and states why every alternative loses it.
 *
 * **Signed in as somebody else.** The screen names the account that will accept *before*
 * the tap, and offers to change it — §17's "clear disclosure of which account will accept,
 * with an option to switch". The switch is a sign-out that keeps the token held, so the
 * invitation survives it.
 *
 * ---------------------------------------------------------------------------
 * Naming the inviter
 * ---------------------------------------------------------------------------
 *
 * This screen used to withhold the inviter until after acceptance. Consent to "whoever
 * sent this" is not consent, so `invite_preview` now names them first, and `20261024000100`
 * records why that is safe to answer. If it cannot be answered, Accept is not offered.
 *
 * ---------------------------------------------------------------------------
 * What acceptance does, and it is §17's list
 * ---------------------------------------------------------------------------
 *
 * The tap calls `accept_invite`, which writes the attribution, connects the two accounts
 * — both directions approved for a personal link, or a one-way follow for a referral —
 * and files the inviter's notification.
 */
export default function InvitationScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const auth = useAuth();
  const router = useRouter();

  const [result, setResult] = useState<RedeemOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = isInviteToken(token);
  const status = auth.status;
  const userId = status === 'ready' ? auth.userId : null;

  /**
   * Held only while there is no account to show this to, because that is the one case the
   * route will not survive. The effect is what runs before `useAuthRouting` moves them: a
   * child's effect fires first in the commit that changes `status`.
   *
   * Once there is an account, the screen has the token and storage lets go of it, so
   * walking away leaves nothing behind.
   */
  useEffect(() => {
    if (!valid) return;
    if (status === 'signed-out' || status === 'onboarding') void holdInvite(token);
    if (userId) void releaseShownInvite(token, userId);
  }, [status, token, userId, valid]);

  const preview = useQuery({
    queryKey: queryKeys.invitePreview(userId ?? '', valid ? token : ''),
    queryFn: () => previewInvite(token),
    enabled: valid && userId !== null,
  });

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
    if (!valid || busy || !userId) return;
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
        const operationId = await claimForRedemption(token, userId, newOperationId);
        // `settle` owns the keep-or-let-go rule, so this screen and the replay on the next
        // launch cannot drift on what an answer means.
        return operationId ? settle(token, operationId, userId) : null;
      });

      if (outcome) setResult(outcome);
    } finally {
      setBusy(false);
    }
  }, [busy, token, userId, valid]);

  /** Saying no is a decision too, so nothing about this invitation stays on the device. */
  const notNow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await serialiseRedemption(clearPendingInvite);
      router.replace('/collection');
    } finally {
      setBusy(false);
    }
  }, [busy, router]);

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
   * `useResumePendingInvite` brings whichever account they arrive as back to this screen.
   * The invitation survives the switch without them having to find the link again.
   *
   * **It claims *this* invitation first, and independent review 26b is why.**
   * `holdInvite` keeps the first token it is given, deliberately: opening a second link
   * is a link tapped, not a decision. But acting on *this* screen is a decision about
   * *this* invitation, so it is the one they should come back to.
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
          title="You have been invited to bingd"
          body="Sign in or create your account, and this invitation will be waiting when you get there."
        />
      </Screen>
    );
  }

  if (result) return <Outcome result={result} onRetry={accept} busy={busy} />;

  if (preview.isPending) return <LoadingScreen />;

  if (preview.isError) {
    return (
      <Screen airy includeBottomInset>
        <EmptyState
          kind="couldNotLoad"
          title="Could not load this invitation"
          body="Nothing has been accepted. Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void preview.refetch() }}
        />
      </Screen>
    );
  }

  const invitation = preview.data;
  if (invitation.outcome !== 'ready') {
    return <Outcome result={invitation} onRetry={accept} busy={busy} />;
  }

  return (
    <Screen airy includeBottomInset>
      <EmptyState
        kind="nothingYet"
        title={invitationTitle(invitation)}
        // Who it is from, what accepting grants, and the account that would be granting it,
        // all before the tap. PRD §17: a person signed into a second account must be able
        // to see which one is about to accept.
        body={acceptanceBody(invitation, auth.profile)}
        action={{ label: busy ? 'Accepting…' : 'Accept invitation', onPress: () => void accept() }}
      />
      <View style={styles.secondary}>
        <Button
          kind="secondary"
          label="Not now"
          onPress={() => void notNow()}
          disabled={busy}
          disabledReason="Finishing the last attempt."
        />
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

type ReadyInvitation = Extract<InvitePreview, { outcome: 'ready' }>;

const invitationTitle = ({ inviterDisplayName, inviterUsername }: ReadyInvitation): string =>
  inviterDisplayName
    ? `${inviterDisplayName} (@${inviterUsername}) invited you to bingd`
    : `@${inviterUsername} invited you to bingd`;

/**
 * What the tap does, in the words of the person granting it.
 *
 * The private case is spelled out because it is the one that widens something: until now
 * this account decided who could see it one request at a time, and accepting skips that
 * for this one person.
 */
function acceptanceBody(
  invitation: ReadyInvitation,
  account: { username: string; visibility: 'public' | 'private' },
): string {
  const who = `@${invitation.inviterUsername}`;
  const signedInAs = `You are signed in as @${account.username}.`;

  if (invitation.kind === 'referral') {
    return `Accepting records that you joined on this invitation and follows ${who}. ${signedInAs}`;
  }

  const reach =
    account.visibility === 'private'
      ? `Your account is private, and ${who} will be able to see your rankings, watchlist and activity.`
      : `${who} will see your rankings, watchlist and activity in their feed.`;
  return `Accepting means you and ${who} follow each other. ${reach} ${signedInAs}`;
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
  connected: boolean,
): string {
  const who = inviterUsername ? `@${inviterUsername}` : 'the person who invited you';
  const follow = connected
    ? ` You and ${who} now follow each other.`
    : followState === 'pending'
      ? ` You have asked to follow ${who}, and they will get the request.`
      : followState === 'approved'
        ? ` You are now following ${who}.`
        : '';
  return `You joined on ${who}'s invitation.${follow} Keep ranking and they will hear about it.`;
}

function Outcome({
  result,
  onRetry,
  busy,
}: {
  /** A preview that refused is the same answer accepting would have given, one tap sooner. */
  result: RedeemOutcome | Exclude<InvitePreview, ReadyInvitation>;
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
            body={acceptedBody(result.inviterUsername, result.followState, result.connected)}
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
            body="Send it to somebody who is not on bingd yet, and they will land here."
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
            body="The account it came from is not available. You can still use bingd. Nothing else is affected."
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
  // Under the empty state's own action and quieter than it: the invitation is what the
  // screen is about.
  secondary: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[4],
    alignItems: 'center',
    gap: theme.space[2],
  },
});
