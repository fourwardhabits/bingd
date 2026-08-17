import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { useRouter, useSegments } from 'expo-router';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useTasteOnboarding } from '@/features/onboarding/use-taste-onboarding';
import { identify } from '@/lib/analytics';
import { avatarUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { startSessionRefresh, supabase } from '@/lib/supabase';

export type Profile = {
  id: string;
  username: string;
  display_name: string;
  /** The line they wrote about themselves, under the handle. Null until they do. */
  bio: string | null;
  /** The object path as stored. Pass to `set_avatar` and to the delete of the
   *  previous file; use `avatarUri` for anything that renders. */
  avatar_path: string | null;
  /** Already resolved against the project's storage origin. */
  avatarUri: string | null;
  visibility: 'public' | 'private';
};

/**
 * Five states, and `onboarding` is the one the architecture insists on.
 *
 * `onboarding` is being authenticated without having an account: `profiles.id`
 * references `auth.users(id)`, the date of birth is collected during onboarding,
 * and so there is a real and persistent state in between (auth.md §4). Treating it
 * as a transient loading step is what produces the empty-profile bug in PRD
 * §26.1.8 — a user who abandons signup halfway and reopens the app must land back
 * in onboarding, not in a broken account.
 *
 * `error` exists so that not knowing is distinguishable from knowing there is no
 * profile. Collapsing the two would send a signed-in user with a flaky connection
 * into the signup form, where the username they already own is taken.
 */
export type AuthState =
  | { status: 'loading' }
  | { status: 'error'; retry: () => void }
  | { status: 'signed-out' }
  | { status: 'onboarding'; userId: string; email: string | null }
  | { status: 'ready'; userId: string; profile: Profile };

const AuthContext = createContext<AuthState>({ status: 'loading' });

export const useAuth = () => useContext(AuthContext);

/** Throws outside a `ready` session, so screens behind the gate need no null checks. */
export function useCurrentProfile(): Profile {
  const auth = useAuth();

  if (auth.status !== 'ready') {
    throw new Error('useCurrentProfile was called outside a signed-in, onboarded session.');
  }
  return auth.profile;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => startSessionRefresh(), []);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setSessionLoaded(true);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setSessionLoaded(true);
      // Everything cached was read under the previous identity. Keeping any of it
      // across a sign-out would show one user another user's content on a shared
      // device, which no amount of correct RLS prevents once it is already in
      // memory.
      if (!next) queryClient.clear();
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [queryClient]);

  const userId = session?.user?.id ?? null;

  // The internal UUID and nothing else, and reset on sign-out so a second account
  // on the same device is a separate person to the analytics vendor.
  useEffect(() => {
    identify(userId);
  }, [userId]);

  const profileQuery = useQuery({
    queryKey: queryKeys.myProfile(userId ?? 'none'),
    enabled: Boolean(userId),
    // A missing profile is a fact about the account, not a stale read, and it stops
    // being true exactly once — when create_profile succeeds and invalidates this.
    staleTime: Infinity,
    queryFn: async (): Promise<Profile | null> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, bio, avatar_path, visibility')
        .eq('id', userId!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;

      // Resolved here rather than at the `<Avatar>`, so a bare object path
      // cannot reach an `<Image source>` anywhere downstream.
      const row = data as Omit<Profile, 'avatarUri'> & { avatar_path: string | null };
      return { ...row, avatarUri: avatarUri(row.avatar_path) };
    },
  });

  const value = useMemo<AuthState>(() => {
    if (!sessionLoaded) return { status: 'loading' };
    if (!userId) return { status: 'signed-out' };
    if (profileQuery.isPending) return { status: 'loading' };
    if (profileQuery.isError) return { status: 'error', retry: () => void profileQuery.refetch() };
    if (!profileQuery.data) {
      return { status: 'onboarding', userId, email: session?.user?.email ?? null };
    }
    return { status: 'ready', userId, profile: profileQuery.data };
  }, [sessionLoaded, userId, profileQuery, session?.user?.email]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export type RoutingInput = {
  status: AuthState['status'];
  /** `segments[0]` and `segments[1]`, which is all this needs of the route. */
  group: string | undefined;
  screen: string | undefined;
  /** Undefined while the first-run check has not answered. */
  tasteNeeded: boolean | undefined;
  tastePending: boolean;
};

/**
 * Where a user belongs, as a function rather than as an effect.
 *
 * Extracted so it can be tested as arithmetic. It was inline, and independent review
 * found a defect in it that no test could have caught from outside — the hook's own
 * `useAuth` cannot be mocked past a `requireActual`, so a test of the hook was really a
 * test of a provider it had not built. Returning a path or `null` makes every branch
 * reachable from a table of inputs.
 */
export function nextRoute({
  status,
  group,
  screen,
  tasteNeeded,
  tastePending,
}: RoutingInput): string | null {
  // Not knowing where the user belongs is not a reason to move them.
  if (status === 'loading' || status === 'error') return null;

  const inAuthGroup = group === '(auth)';

  if (status === 'signed-out') return inAuthGroup ? null : '/(auth)/sign-in';

  if (status === 'onboarding') {
    return !inAuthGroup || screen !== 'create-profile' ? '/(auth)/create-profile' : null;
  }

  /**
   * **Routing sends people into the first-run flow; it never takes them out of it.**
   *
   * The screen owns its own exit — the two buttons on its summary, and "Not now".
   * Letting this decide as well is the blocker independent review found: bucketing the
   * first film makes the account stop looking new, and the router, seeing somebody on
   * the onboarding route who no longer needed it, replaced the screen with the feed at
   * one of five. The flow working correctly was being read as a reason to end it.
   */
  if (group === 'onboarding') return null;

  /**
   * Still pending is not a reason to move anyone: the flow's screen would be mounted
   * and then replaced, and the feed would flash behind it. Waiting costs one count
   * query on a cold start and nothing afterwards (`staleTime: Infinity`).
   */
  if (tastePending) return null;

  if (tasteNeeded) return '/onboarding/taste';

  /**
   * `/` is the other route a ready user does not belong on. `(tabs)` is a group and
   * contributes no path segment, so nothing serves `/` and `app/index.tsx` only waits
   * there. At the root index `segments` is empty, which is what the undefined group
   * means. Redirecting from that screen instead would mount the feed before this state
   * resolves, and the feed calls `useCurrentProfile`, which throws.
   */
  if (inAuthGroup || group === undefined) return '/(tabs)/feed';

  return null;
}

/**
 * Keeps the visible route consistent with the auth state, in one place. Screens do
 * not redirect each other: with three entry points into onboarding — cold start,
 * a completed sign-in, and a deep link — per-screen guards disagree about which
 * one is in charge, and the symptom is a redirect loop that only reproduces on a
 * cold start with a specific link.
 */
export function useAuthRouting() {
  const auth = useAuth();
  const segments = useSegments();
  const router = useRouter();

  /**
   * Whether this account has never ranked or logged anything.
   *
   * Asked only once a profile exists, because it is a question about a collection and
   * an account without a profile has none. It resolves to `needed: false` on failure,
   * so a flaky connection sends somebody to the feed rather than into a five-step flow
   * they have already completed — see `use-taste-onboarding.ts`.
   */
  const taste = useTasteOnboarding(
    auth.status === 'ready' ? auth.userId : null,
    auth.status === 'ready',
  );

  useEffect(() => {
    // Typed routes give `segments` a union of fixed-length tuples, so indexing past the
    // shortest one is a type error rather than a runtime one. The names are what this
    // needs, not the route type.
    const [group, screen] = segments as readonly (string | undefined)[];

    const destination = nextRoute({
      status: auth.status,
      group,
      screen,
      tasteNeeded: taste.data?.needed,
      tastePending: taste.isPending,
    });

    if (destination) router.replace(destination as never);
  }, [auth, segments, router, taste.isPending, taste.data?.needed]);
}
