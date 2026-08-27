import { FIRST_FIVE, tastePhaseOnDevice } from '@/features/onboarding/use-taste-onboarding';
import { snapshot, withoutRecording } from '@/lib/flight-recorder';
import type { AuthFacts, OnboardingFacts } from '@/lib/flight-report';
import { supabase } from '@/lib/supabase';
import type { Session } from '@supabase/supabase-js';

/**
 * The two sections that have to ask something rather than read a buffer.
 *
 * Both are read **once, when the sheet opens**. Neither polls, and neither is allowed to
 * hang the sheet: `getSession()` goes through the same session machinery the app does, and
 * on the device this exists to diagnose, that machinery is the suspect. A sheet that could
 * not open because auth was stuck would be the one failure mode that makes it useless — so
 * every read here is bounded and degrades to "unknown" rather than waiting.
 */

/** How long the sheet will wait for a fact before reporting what it already knows. */
const FACT_GRACE_MS = 2500;

function withinGrace<T>(work: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), FACT_GRACE_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export type LiveFacts = { auth: AuthFacts; onboarding: OnboardingFacts };

const UNKNOWN_ONBOARDING: OnboardingFacts = {
  storedPhase: 'unreadable',
  derivedNeeded: 'unknown',
  ranked: null,
  logged: null,
};

/**
 * Session and onboarding facts, from one session read.
 *
 * The account id is used and never printed. It is needed because the taste phase is stored
 * under a per-account key, and reading the wrong key is one of the concrete mechanisms
 * this whole exercise is trying to rule in or out — so the report says *which phase*, not
 * *whose*.
 *
 * `expires_at` is a number of seconds, not a credential: it says when the token stops
 * working, which is what explains a refresh storm, and nothing about what the token is.
 * The access token, the refresh token and the email address are all on the object this
 * reads, and none of them is touched.
 */
export async function liveFacts(): Promise<LiveFacts> {
  const flight = snapshot();
  const authCallbacks = flight.counters['auth.callbacks'] ?? 0;
  const hydrationMs = flight.events
    .filter((event) => event.channel === 'auth' && event.label === 'hydrate')
    .at(-1)?.ms;

  /**
   * Suppressed, so the sheet does not write into the evidence it is about to read — review
   * 51's third finding. These are ordinary Supabase requests and would otherwise enter the
   * same thirty-record ring, bump the same repeat counters, and on a busy session evict the
   * records carrying the failure.
   *
   * `unknown` is a third answer and not a nicety: on the exact stall this exists to
   * diagnose, `getSession()` is the thing that does not come back, and reporting that as
   * "session NO" would be the report asserting the opposite of the truth.
   */
  const asked = await withoutRecording(() =>
    withinGrace<{ known: true; session: Session | null } | { known: false }>(
      supabase.auth.getSession().then(({ data }) => ({ known: true, session: data.session })),
      { known: false },
    ),
  );
  const session = asked.known ? asked.session : null;

  const auth: AuthFacts = session
    ? {
        sessionExists: true,
        sessionKnown: true,
        expiresInSeconds: session.expires_at
          ? Math.round(session.expires_at - Date.now() / 1000)
          : undefined,
        hydrationMs,
        authCallbacks,
      }
    : { sessionExists: false, sessionKnown: asked.known, hydrationMs, authCallbacks };

  const userId = session?.user?.id;
  if (!userId) return { auth, onboarding: UNKNOWN_ONBOARDING };

  const state = await withoutRecording(() => withinGrace(tastePhaseOnDevice(userId), null));
  if (!state) return { auth, onboarding: UNKNOWN_ONBOARDING };

  return {
    auth,
    onboarding: {
      storedPhase: `disk=${state.stored ?? 'absent'} memory=${state.remembered ?? 'absent'}`,
      derivedNeeded:
        state.ranked === null ? 'unknown' : `${state.needed ? 'YES' : 'NO'} (of ${FIRST_FIVE})`,
      ranked: state.ranked,
      logged: state.logged,
    },
  };
}
