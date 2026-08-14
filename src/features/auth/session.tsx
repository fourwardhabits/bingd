import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { useRouter, useSegments } from 'expo-router';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { identify } from '@/lib/analytics';
import { queryKeys } from '@/lib/query';
import { startSessionRefresh, supabase } from '@/lib/supabase';

export type Profile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
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
        .select('id, username, display_name, avatar_url, visibility')
        .eq('id', userId!)
        .maybeSingle();
      if (error) throw error;
      return (data as Profile) ?? null;
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

  useEffect(() => {
    // Not knowing where the user belongs is not a reason to move them.
    if (auth.status === 'loading' || auth.status === 'error') return;

    // Typed routes give `segments` a union of fixed-length tuples, so indexing past
    // the shortest one is a type error rather than a runtime one. The names are what
    // this needs, not the route type.
    const [group, screen] = segments as readonly (string | undefined)[];
    const inAuthGroup = group === '(auth)';

    if (auth.status === 'signed-out') {
      if (!inAuthGroup) router.replace('/(auth)/sign-in');
      return;
    }

    if (auth.status === 'onboarding') {
      if (!inAuthGroup || screen !== 'create-profile') router.replace('/(auth)/create-profile');
      return;
    }

    if (inAuthGroup) router.replace('/(tabs)/feed');
  }, [auth, segments, router]);
}
