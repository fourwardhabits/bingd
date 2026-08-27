import { useQueryClient } from '@tanstack/react-query';
import * as Updates from 'expo-updates';
import { useSegments } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, ScrollView, Share, StyleSheet, View } from 'react-native';

import { snapshot } from '@/lib/flight-recorder';
import { formatReport, queryFacts, type ReportInput } from '@/lib/flight-report';
import { releaseContext } from '@/lib/release';
import { readLastSession } from '@/lib/flight-persistence';
import { liveFacts } from './facts';
import { onDiagnosticsRequested } from './open';
import { Button, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * The Diagnostics sheet, mounted once above the navigator.
 *
 * **It renders nothing until it is asked for**, which is the property that lets this ship
 * into a beta that is already too warm. There is no timer, no subscription to the flight
 * recorder, and no re-render on new events: the report is built once when the sheet opens
 * and once per Refresh press. Between openings this component is a single `useState` and
 * one listener registration.
 *
 * A sheet rather than a route — see `open.ts` for why routing cannot carry this.
 */
export function DiagnosticsHost() {
  const [visible, setVisible] = useState(false);
  const [report, setReport] = useState('');
  const queryClient = useQueryClient();
  const segments = useSegments();

  const route = (segments as readonly string[]).join('/') || '(root)';

  const build = useCallback(async () => {
    const release = releaseContext();
    const now = Date.now();
    const live = await liveFacts();

    const input: ReportInput = {
      release: {
        appVersion: release.app_version,
        buildNumber: release.build_number,
        runtimeVersion: release.runtime_version,
        updateId: release.eas_update_id,
        channel: release.eas_channel,
        embedded: Updates.isEmbeddedLaunch,
        // `createdAt` is the update's publish time, which is the closest thing the client
        // has to "which source is this" without shipping a commit string.
        commit: Updates.createdAt ? Updates.createdAt.toISOString() : null,
        launchedAtIso: new Date(now - snapshot().uptimeMs).toISOString(),
      },
      auth: live.auth,
      onboarding: live.onboarding,
      route,
      appState: AppState.currentState,
      flight: snapshot(),
      queries: queryFacts(queryClient.getQueryCache().getAll(), now),
      lastSession: await readLastSession(),
    };

    setReport(formatReport(input));
  }, [queryClient, route]);

  useEffect(
    () =>
      onDiagnosticsRequested(() => {
        setVisible(true);
        void build();
      }),
    [build],
  );

  if (!visible) return null;

  return (
    <Sheet visible onClose={() => setVisible(false)} label="Diagnostics">
      <ScrollView style={styles.body} contentContainerStyle={styles.content}>
        <Text variant="caption" tone="secondary" style={styles.mono} selectable>
          {report}
        </Text>
      </ScrollView>
      <View style={styles.actions}>
        <Button label="Refresh" kind="secondary" onPress={() => void build()} />
        <Button
          label="Copy report"
          onPress={() => {
            // `Share` rather than a clipboard module: adding a dependency would move the
            // fingerprint, and this update has to land on the build already in the
            // founder's hands. The iOS share sheet offers Copy.
            void Share.share({ message: report }).catch(() => {});
          }}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { maxHeight: 460 },
  content: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[4] },
  mono: { fontFamily: undefined, fontSize: 11, lineHeight: 15 },
  actions: {
    flexDirection: 'row',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[3],
  },
});
