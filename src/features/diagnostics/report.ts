import type { QueryClient } from '@tanstack/react-query';
import * as Updates from 'expo-updates';
import { AppState } from 'react-native';

import { readLastSession } from '@/lib/flight-persistence';
import type { LastSession } from '@/lib/flight-recorder';
import { snapshot } from '@/lib/flight-recorder';
import {
  formatReport,
  queryFacts,
  type AuthFacts,
  type OnboardingFacts,
  type ReportInput,
} from '@/lib/flight-report';
import { releaseContext } from '@/lib/release';

import { liveFacts } from './facts';

/**
 * The report, built without any user interface at all — and now unable to hang.
 *
 * ---------------------------------------------------------------------------
 * THE CORRECTION THIS FILE CARRIES
 *
 * The previous version said "everything it reads is bounded" and it was not:
 * `readLastSession()` was awaited with no deadline, and it is a **cold Keychain read** —
 * the first touch of a key the memory mirror has only ever seen written, routed through
 * the per-key queue into `SecureStore`. Independent review 51 flagged exactly this line
 * and it was dismissed as theoretical. The founder's device then sat on "Building…"
 * indefinitely, and **Copy diagnostics did nothing**, because both await this builder and
 * a hang is not a rejection — no catch fires, no state changes, nothing appears.
 *
 * That is the same failing boundary as the rest of this device's story: Keychain
 * operations that answer late or never, behind awaits nobody bounded. The instrument
 * built to expose that pathology was itself parked behind it.
 *
 * So now every asynchronous source races its own deadline, a source that does not answer
 * is *named in the report* rather than silently absent — which turns the hang itself into
 * evidence — and an outer watchdog guarantees a report even if a source nobody
 * anticipated stalls. Everything else here is synchronous and cannot hold anything.
 */

/** How long the tail read may hold the report. A healthy read answers in milliseconds. */
const SOURCE_GRACE_MS = 2500;

/**
 * `liveFacts` bounds its own two reads at 2.5s each, sequentially — so its honest worst
 * case is ~5s, and this outer bound sits just past it. The ordering matters: when a read
 * inside is slow, `liveFacts` still answers with its more precise "UNKNOWN (read did not
 * answer)" detail, and this blunter fallback fires only if `liveFacts` itself misbehaves.
 */
const LIVE_FACTS_GRACE_MS = 5500;

/** The whole build, bounded outright, for the stall nobody has anticipated yet. */
const REPORT_WATCHDOG_MS = 8000;

/**
 * Distinct from `null`, because the difference is a finding. `null` is a fresh install
 * that has never persisted a tail; a timeout is this device's storage failing to answer —
 * the very pathology the report exists to document.
 */
const TIMED_OUT = 'timed-out' as const;

/**
 * Resolves to `fallback()` when `work` has not answered in time. Never rejects.
 *
 * The fallback is a thunk, not a value — review 58's minor: building it eagerly meant a
 * throw inside the fallback's own construction happened before any watchdog existed, which
 * contradicted the promise this module makes.
 */
function within<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback());
      },
    );
  });
}

/** What the report says when a source could not be asked. Not "NO" — "could not ask". */
const UNKNOWN_AUTH: AuthFacts = { sessionExists: false, sessionKnown: false, authCallbacks: 0 };

const UNKNOWN_ONBOARDING: OnboardingFacts = {
  storedPhase: 'unreadable',
  derivedNeeded: 'unknown',
  ranked: null,
  logged: null,
};

export async function buildDiagnosticsReport(
  queryClient: QueryClient,
  route: string,
): Promise<string> {
  try {
    return await within(assemble(queryClient, route), REPORT_WATCHDOG_MS, () =>
      // The watchdog fallback is still a real report: every synchronous section — release,
      // network ring, events, counters, query states — renders from what is already in
      // memory, with the two live sections marked unknown. A partial report that arrives
      // is worth more than a complete one that does not.
      formatReport({
        ...syncInput(queryClient, route),
        auth: UNKNOWN_AUTH,
        onboarding: UNKNOWN_ONBOARDING,
        lastSession: null,
        lastSessionUnreadable: true,
      }),
    );
  } catch (error) {
    // The one function in the app that must always return a string. A throw here is
    // itself the finding, so it is the report.
    return `bingd. diagnostics could not be assembled: ${error instanceof Error ? error.name : 'unknown'}`;
  }
}
async function assemble(queryClient: QueryClient, route: string): Promise<string> {
  const live = await within(liveFacts(), LIVE_FACTS_GRACE_MS, () => null);
  const lastSession = await within<LastSession | null | typeof TIMED_OUT>(
    readLastSession(),
    SOURCE_GRACE_MS,
    () => TIMED_OUT,
  );

  return formatReport({
    ...syncInput(queryClient, route),
    auth: live ? live.auth : UNKNOWN_AUTH,
    onboarding: live ? live.onboarding : UNKNOWN_ONBOARDING,
    lastSession: lastSession === TIMED_OUT ? null : lastSession,
    lastSessionUnreadable: lastSession === TIMED_OUT,
  });
}

/** A date that might be anything, rendered or dropped — never thrown. */
function safeIso(value: Date | null | undefined): string | null {
  try {
    return value ? value.toISOString() : null;
  } catch {
    return null;
  }
}

/** Every section that is already in memory. Synchronous by construction: nothing to bound. */
function syncInput(
  queryClient: QueryClient,
  route: string,
): Omit<ReportInput, 'auth' | 'onboarding' | 'lastSession'> {
  const release = releaseContext();
  const now = Date.now();
  const flight = snapshot();

  return {
    release: {
      appVersion: release.app_version,
      buildNumber: release.build_number,
      runtimeVersion: release.runtime_version,
      updateId: release.eas_update_id,
      channel: release.eas_channel,
      embedded: Updates.isEmbeddedLaunch,
      // The update's publish time, which is the closest thing the client has to "which
      // source is this" without shipping a commit string into the bundle.
      commit: safeIso(Updates.createdAt),
      launchedAtIso: new Date(now - flight.uptimeMs).toISOString(),
    },
    route,
    appState: AppState.currentState,
    flight,
    queries: queryFacts(queryClient.getQueryCache().getAll(), now),
  };
}
