import type { QueryClient } from '@tanstack/react-query';
import * as Updates from 'expo-updates';
import { AppState } from 'react-native';

import { readLastSession } from '@/lib/flight-persistence';
import { snapshot } from '@/lib/flight-recorder';
import { formatReport, queryFacts, type ReportInput } from '@/lib/flight-report';
import { releaseContext } from '@/lib/release';

import { liveFacts } from './facts';

/**
 * The report, built without any user interface at all.
 *
 * **This separation is the point of the hotfix rather than a tidy-up.** The report used to
 * be assembled inside the sheet component, so the only way to obtain it was to get that
 * sheet on screen — and on the founder's device the sheet could not be presented, which
 * meant the recorder existed and was unreachable. An instrument that can be blocked by its
 * own display is not an instrument.
 *
 * So the text is produced here, by a plain function, and two things use it: the sheet, and
 * **Copy diagnostics**, which needs no presentation whatsoever. If the sheet ever fails to
 * appear again, the report is still one tap away.
 *
 * Everything it reads is bounded and already in memory except the two live facts, which are
 * themselves bounded and suppressed from the recorder — see `facts.ts`.
 */
export async function buildDiagnosticsReport(
  queryClient: QueryClient,
  route: string,
): Promise<string> {
  const release = releaseContext();
  const now = Date.now();
  const live = await liveFacts();
  const flight = snapshot();

  const input: ReportInput = {
    release: {
      appVersion: release.app_version,
      buildNumber: release.build_number,
      runtimeVersion: release.runtime_version,
      updateId: release.eas_update_id,
      channel: release.eas_channel,
      embedded: Updates.isEmbeddedLaunch,
      // The update's publish time, which is the closest thing the client has to "which
      // source is this" without shipping a commit string into the bundle.
      commit: Updates.createdAt ? Updates.createdAt.toISOString() : null,
      launchedAtIso: new Date(now - flight.uptimeMs).toISOString(),
    },
    auth: live.auth,
    onboarding: live.onboarding,
    route,
    appState: AppState.currentState,
    flight,
    queries: queryFacts(queryClient.getQueryCache().getAll(), now),
    lastSession: await readLastSession(),
  };

  return formatReport(input);
}
