import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { useRouter, useSegments } from 'expo-router';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  STAGE_ROUTES,
  hydrateStage,
  useOnboardingStage,
  type OnboardingStage,
} from '@/features/onboarding/use-onboarding-stage';
import { FIRST_FIVE, useTasteOnboarding } from '@/features/onboarding/use-taste-onboarding';
import { hydrateWelcomeSeen, useWelcomeSeen } from '@/features/onboarding/welcome';
import { identify } from '@/lib/analytics';
import { note, rememberRoute, tally } from '@/lib/flight-recorder';
import { withGrace } from '@/lib/grace';
import { avatarUri } from '@/lib/images';
import { identifyForMonitoring } from '@/lib/monitoring';
import { queryKeys } from '@/lib/query';
import { onLocalSignOut, startSessionRefresh, supabase } from '@/lib/supabase';

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

/**
 * How long the first read of the stored session may hold the whole app.
 *
 * **Independent review 49's second major finding, and it is the one lane the request
 * deadline cannot reach.** Hydration is `storage.getItem` and nothing else — no fetch has
 * started, so no network budget applies — and `SecureStore.getItemAsync` is a promise iOS
 * does not promise to settle. One that does not leaves `sessionLoaded` false for the life
 * of the process: the navigator is never mounted, the loading overlay never leaves, and
 * every later storage operation on that key queues behind the same unresolved read.
 *
 * Eight seconds because a Keychain read is measured in milliseconds when it works at all,
 * so this is not a budget anybody meets by being slow. Past it the answer is not "signed
 * out" — that would be a wrong claim about an account, and it would send somebody with a
 * perfectly good session to the sign-in screen — it is *we could not find out*, which is a
 * state this provider already has and `AuthStatusOverlay` already draws with a retry.
 */
const SESSION_HYDRATION_GRACE_MS = 8000;

/**
 * Distinguishes "asked, and there is no session" from "could not ask".
 *
 * A wrapper rather than a `null` return, because `null` is already the first of those and
 * conflating them is what would send somebody with a working session to the sign-in
 * screen — the same distinction `AuthState`'s own `error` case exists to preserve.
 */
type Hydration = { ok: true; session: Session | null } | { ok: false };

const UNREADABLE: Hydration = { ok: false };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  /** Bumped by the retry on the error state, which is the only thing that re-reads. */
  const [attempt, setAttempt] = useState(0);
  const queryClient = useQueryClient();

  useEffect(() => startSessionRefresh(), []);

  useEffect(() => {
    let active = true;

    const hydrationBegan = Date.now();
    void withGrace<Hydration, Hydration>(
      supabase.auth.getSession().then(
        ({ data }): Hydration => ({ ok: true, session: data.session }),
        // A rejection is the same class of answer as silence: the store could not be
        // read. Without this the `.then` below simply never runs, which is the hang.
        (): Hydration => UNREADABLE,
      ),
      SESSION_HYDRATION_GRACE_MS,
      UNREADABLE,
    ).then((result) => {
      note(
        'auth',
        'hydrate',
        result.ok ? (result.session ? 'session' : 'none') : 'unreadable',
        Date.now() - hydrationBegan,
      );
      if (!active) return;
      if (!result.ok) {
        setUnreadable(true);
        return;
      }
      setSession(result.session);
      setSessionLoaded(true);
    });

    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      // Counted as well as listed: a callback storm is a number, not a story.
      tally('auth.callbacks');
      note('auth', event, next ? 'session' : 'none');
      // A late answer from a slow store arrives here as `INITIAL_SESSION`, so a launch
      // that gave up above still recovers on its own rather than needing the retry.
      setUnreadable(false);
      setSession(next);
      setSessionLoaded(true);
      // Everything cached was read under the previous identity. Keeping any of it
      // across a sign-out would show one user another user's content on a shared
      // device, which no amount of correct RLS prevents once it is already in
      // memory.
      if (!next) queryClient.clear();
    });

    /**
     * The app's own sign-out signal, for the exit that could not wait for Supabase's.
     *
     * `SIGNED_OUT` is emitted only after `_removeSession` has awaited three storage
     * operations, and a device whose storage has stopped answering is exactly the device
     * somebody is trying to leave. `signOut` says it here instead, once the credential is
     * gone — and this branch does the same three things the null case above does, because
     * it means the same thing.
     */
    const stopListeningForLocalSignOut = onLocalSignOut(() => {
      if (!active) return;
      setUnreadable(false);
      setSession(null);
      setSessionLoaded(true);
      queryClient.clear();
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
      stopListeningForLocalSignOut();
    };
  }, [queryClient, attempt]);

  const userId = session?.user?.id ?? null;

  /**
   * The internal UUID and nothing else, and reset on sign-out so a second account on
   * the same device is a separate person to both vendors.
   *
   * **Both**, and that is the change: `identifyForMonitoring` existed and nothing had
   * ever called it, so every Sentry event was anonymous. A crash report that cannot be
   * tied to an account is a crash nobody can ask about — the beta's whole support loop
   * is "you said the app broke, let me find your session".
   *
   * This is also the account-deletion path. `delete_account` is followed by a sign-out
   * (`app/settings/account.tsx`), including on the branch where the outcome was never
   * established, so the session goes to null and both identities reset here rather than
   * in a second place that could be forgotten.
   *
   * **Gated on `sessionLoaded`, and that gate is the point.** Before `getSession`
   * answers, `userId` is null because nothing has been read yet — which is *not knowing*,
   * not *signed out*. Reporting it as signed out asks the vendors to reset on every
   * single launch, which throws away the anonymous distinct id that joins somebody's
   * pre-signup events to the account they go on to create. Once it has answered, a null
   * really does mean signed out, and the reset is the right thing — including for an
   * identity a previous process left behind. Independent review 24.
   */
  useEffect(() => {
    if (!sessionLoaded) return;
    identify(userId);
    identifyForMonitoring(userId);
  }, [sessionLoaded, userId]);

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
    // Before the loading branch, because it is a *stronger* statement than "not yet":
    // the read was attempted and could not be completed, and the overlay's retry is the
    // only thing that will ask again.
    if (unreadable && !sessionLoaded) {
      return { status: 'error', retry: () => setAttempt((n) => n + 1) };
    }
    if (!sessionLoaded) return { status: 'loading' };
    if (!userId) return { status: 'signed-out' };
    if (profileQuery.isPending) return { status: 'loading' };
    if (profileQuery.isError)
      return { status: 'error', retry: () => void profileQuery.refetch() };
    if (!profileQuery.data) {
      return { status: 'onboarding', userId, email: session?.user?.email ?? null };
    }
    return { status: 'ready', userId, profile: profileQuery.data };
  }, [sessionLoaded, unreadable, userId, profileQuery, session?.user?.email]);

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
  /**
   * How far the first-run flow got on this device, or undefined if it never started.
   *
   * Asked *before* `tasteNeeded` below, and that ordering is load-bearing rather than
   * arbitrary. See `use-onboarding-stage.ts`: five rankings no longer mean the flow is
   * over, so the taste query answers "not needed" for somebody sitting on the People
   * step, and a router that trusted it alone would open the Feed with the last two
   * steps skipped.
   */
  stage: OnboardingStage | null | undefined;
  /**
   * How many movies this account has ranked, when the taste check has answered.
   *
   * Read only by the lost-stage fallback below. It is the evidence that distinguishes "a
   * brand new account with no stage" from "an account whose stage preference was lost
   * after it had already finished the ranking run".
   */
  tasteRanked: number | undefined;
  /**
   * Whether the opening has been shown on this device. Undefined while it is unread.
   *
   * Device-scoped rather than account-scoped, because it is the one screen that runs
   * with no session and there is nothing to key it to. It is also the reason a signed
   * out user is not sent straight to the form any more.
   */
  welcomeSeen: boolean | undefined;
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
  stage,
  tasteRanked,
  welcomeSeen,
}: RoutingInput): string | null {
  // Not knowing where the user belongs is not a reason to move them.
  if (status === 'loading' || status === 'error') return null;

  const inAuthGroup = group === '(auth)';

  /**
   * Signed out, and the opening now sits in front of the form.
   *
   * **The wait on `welcomeSeen` is bounded where it is read, not here.** An undefined
   * value means the preference has not been answered yet, and moving on it would either
   * show the opening to somebody who has already dismissed it or skip it on a first
   * launch, depending on which way the guess went. Neither is worth guessing, and the
   * read cannot hang for ever: `hydrateWelcomeSeen` resolves it to `true` on a failure
   * or a stall, on the rule that losing one screen is a smaller cost than holding the
   * whole app. So this is a hold measured in one Keychain read, not an open-ended one.
   */
  if (status === 'signed-out') {
    if (inAuthGroup) return null;
    if (welcomeSeen === undefined) return null;
    return welcomeSeen ? '/(auth)/sign-in' : '/(auth)/welcome';
  }

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
   * **A flow that has started is answered by where it got to, and by nothing else.**
   *
   * Before the taste rule, deliberately. `readState` settles an `active` account with
   * five rankings to `done` so a summary cannot repeat for ever, and that repair is
   * still right for the ranking sub-flow — but the run is step 7 of ten now, so an
   * account resting on People or on the notification question has five rankings and a
   * taste query that says "not needed". Asking that question first would open the Feed
   * with two steps silently skipped, which is the same class of defect as the router
   * ejecting somebody after their first film.
   *
   * `done` falls through on purpose: the flow is over, and where the app opens is the
   * exiting screen's decision rather than this function's.
   */
  /**
   * **Not knowing where somebody is in the flow is not a reason to guess.**
   *
   * `undefined` is the stage preference not having been read yet. Guessing it absent sends
   * an account resting on the People step back to step 3, and — because `readState` settles
   * such an account to `done` on the way past — lets the launch after that skip the social
   * half entirely. Independent review found exactly that sequence.
   *
   * The wait is bounded where it is read: `hydrateStage` resolves a dead or slow Keychain
   * to `null` after four seconds, so this cannot become the build-4 hang in a new place.
   */
  if (stage === undefined) return null;

  if (stage && stage !== 'done') return STAGE_ROUTES[stage];

  /**
   * **A finished flow is finished, and the taste rule is not consulted again.**
   *
   * This used to fall through to the rules below, which is a second defect review found:
   * the two authorities are written by separate preference keys, so a completion whose
   * *taste* write is lost leaves `stage: 'done'` beside a phase still marked `active` —
   * and the taste rule would then send a fully onboarded account back to step 3 to do all
   * ten again. The stage is the flow's authority, so `done` answers here.
   */
  if (stage === 'done') return inAuthGroup || group === undefined ? '/(tabs)/feed' : null;

  /**
   * Still pending is not a reason to move anyone: the flow's screen would be mounted
   * and then replaced, and the feed would flash behind it. Waiting costs one count
   * query on a cold start and nothing afterwards (`staleTime: Infinity`).
   */
  if (tastePending) return null;

  if (tasteNeeded) {
    /**
     * **The stage is gone but the ranking plainly happened, so the flow resumes after it.**
     *
     * The safety net for a lost or unreadable stage preference. Without it, this branch
     * sends an account that has already placed five movies back to the motivation
     * question — and the steps it would then have to walk again include the ranking run,
     * which is the expensive one and the one already done.
     *
     * `FIRST_FIVE` rankings is not proof the reader reached People, but it is proof they
     * finished step 7, and People is the step after it. Repeating one step somebody may
     * have already seen is a far smaller cost than repeating six, and far smaller than the
     * alternative failure this replaces, which was skipping the social half in silence.
     */
    if (stage === null && (tasteRanked ?? 0) >= FIRST_FIVE) return STAGE_ROUTES.people;

    // An account that belongs in the flow and has no stage yet starts at the top of it.
    // The stage is written by the first screen rather than here, so this stays a pure
    // function of its inputs.
    return STAGE_ROUTES.motivations;
  }

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

  const userId = auth.status === 'ready' ? auth.userId : null;
  const stage = useOnboardingStage(userId);
  const welcomeSeen = useWelcomeSeen();

  /**
   * The two device-local reads the router depends on, each performed once.
   *
   * Separate from the routing effect below on purpose. That effect runs on every segment
   * change, and hydration is a Keychain read: doing it there would put one on every
   * navigation for a value that cannot change without this process being told. Both
   * helpers return early once they have an answer, so a second call is free, and both
   * publish to the subscriptions above rather than returning into a variable nothing
   * would re-render on.
   */
  useEffect(() => {
    void hydrateWelcomeSeen();
  }, []);

  useEffect(() => {
    if (!userId) return;
    void hydrateStage(userId);
  }, [userId]);

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
      stage,
      tasteRanked: taste.data?.ranked,
      welcomeSeen,
    });

    /**
     * Recorded whether or not it moves anybody, because "decided to stay" is exactly as
     * informative as "decided to move" when the question is whether onboarding is routing
     * itself in a circle. The `from` is the group and screen the router was on; nothing
     * here is a path with an id in it.
     */
    rememberRoute(`${group ?? '(root)'}/${screen ?? ''}`);
    note('route', `${group ?? '(root)'}/${screen ?? ''}`, destination ?? `stay:${auth.status}`);
    if (destination) {
      tally('route.replace');
      router.replace(destination as never);
    }
  }, [
    auth,
    segments,
    router,
    taste.isPending,
    taste.data?.needed,
    taste.data?.ranked,
    stage,
    welcomeSeen,
  ]);
}
