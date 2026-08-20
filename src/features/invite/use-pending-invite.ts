import { useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useAuth } from '@/features/auth';

import { redeemPendingInvite } from './redeem';

/**
 * Redeems the invitation this device is holding, once there is an account to attribute.
 *
 * ---------------------------------------------------------------------------
 * Why this is a hook in the layout and not a call in the signup screen
 * ---------------------------------------------------------------------------
 *
 * There are three ways to arrive at a ready session and only one of them goes through
 * the profile form. A person invited on a phone that already had Bingd installed and
 * signed in never sees it; a person who abandoned signup and came back a day later
 * completes it from a cold start; a person who signed in with Apple returns through an
 * OAuth round trip that remounts the tree. A call placed in `create-profile.tsx` would
 * cover exactly one of the three, and the two it missed are the ones this whole
 * mechanism exists for.
 *
 * So it hangs off the same place `useAuthRouting` does — the one component that sees
 * every transition into `ready` — and asks device storage whether there is anything to
 * do. There almost never is, and the cost of finding out is one read.
 *
 * ---------------------------------------------------------------------------
 * Why it stands down on the invitation screen
 * ---------------------------------------------------------------------------
 *
 * `app/i/[token].tsx` redeems on an explicit tap, and PRD §17 requires that tap. If
 * this hook redeemed underneath it, the person would press Accept on an invitation that
 * had already been accepted a moment earlier and be told "already accepted" — correct,
 * idempotent, and a confusing thing to say to somebody who has just done the thing
 * once. The screen owns the token while it is on screen.
 *
 * Nothing is lost by waiting: leaving the screen without accepting keeps the token, and
 * the next launch redeems it here.
 *
 * ---------------------------------------------------------------------------
 * Once per session, and the ref rather than a query
 * ---------------------------------------------------------------------------
 *
 * A ref keyed on the user id, because this is not a read to be cached — it is a write,
 * and React Query's retry and refetch behaviour is exactly wrong for one. The outcome
 * is not rendered anywhere: a redemption that succeeds is visible as the app working,
 * and one that fails keeps its token for the next launch rather than interrupting
 * somebody's first minute with a message about a mechanism they never saw.
 */
export function useRedeemPendingInvite() {
  const auth = useAuth();
  const segments = useSegments();
  const attempted = useRef<string | null>(null);

  const [group] = segments as readonly (string | undefined)[];
  const onInvitationScreen = group === 'i';

  useEffect(() => {
    if (auth.status !== 'ready' || onInvitationScreen) return;
    if (attempted.current === auth.userId) return;

    attempted.current = auth.userId;
    void redeemPendingInvite();
  }, [auth, onInvitationScreen]);
}
