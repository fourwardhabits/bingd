import { useRouter, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useAuth } from '@/features/auth';

import { resumePendingInvite } from './redeem';

/**
 * Brings somebody back to the invitation this device is holding, once there is an account
 * to show it to.
 *
 * ---------------------------------------------------------------------------
 * It shows the invitation. It does not accept it
 * ---------------------------------------------------------------------------
 *
 * Security audit 2026-11-01, B-1. This hook used to redeem whatever was held, with no tap
 * and nothing on screen, so opening an attacker's link and leaving gave them access to a
 * private account. Now it routes to `app/i/[token].tsx`, which names the inviter and says
 * what accepting grants, and only the button there accepts. A new account sees that screen
 * straight after the profile form, before the first-run flow continues.
 *
 * The one thing that still reaches the server from here is a replay of a press of Accept
 * whose answer was lost. `resumePendingInvite` states the rule.
 *
 * ---------------------------------------------------------------------------
 * Why this is a hook in the layout and not a call in the signup screen
 * ---------------------------------------------------------------------------
 *
 * There are three ways to arrive at a ready session and only one of them goes through
 * the profile form. A person who abandoned signup and came back a day later completes it
 * from a cold start; a person who signed in with Apple returns through an OAuth round trip
 * that remounts the tree; an existing account signs back in with a token held. A call
 * placed in `create-profile.tsx` would cover exactly one of the three.
 *
 * So it hangs off the same place `useAuthRouting` does — the one component that sees
 * every transition into `ready` — and asks device storage whether there is anything to
 * do. There almost never is, and the cost of finding out is one read.
 *
 * ---------------------------------------------------------------------------
 * Once per session, and the ref rather than a query
 * ---------------------------------------------------------------------------
 *
 * A ref keyed on the user id, because this can write, and React Query's retry and refetch
 * behaviour is exactly wrong for that.
 */
export function useResumePendingInvite() {
  const auth = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const attempted = useRef<string | null>(null);

  const [group] = segments as readonly (string | undefined)[];
  const onInvitationScreen = group === 'i';

  useEffect(() => {
    if (auth.status !== 'ready' || onInvitationScreen) return;
    if (attempted.current === auth.userId) return;

    attempted.current = auth.userId;
    void resumePendingInvite(auth.userId).then((token) => {
      if (token) router.push({ pathname: '/i/[token]', params: { token } });
    });
  }, [auth, onInvitationScreen, router]);
}
