import { Stack, useLocalSearchParams } from 'expo-router';

import { ImportScreen } from '@/features/import/ImportScreen';

/**
 * Import from Letterboxd.
 *
 * The permanent home of the importer. Contract V3 §9 makes it optional and available at
 * any time, so Settings is where it lives. Onboarding offers it once, as an optional step
 * that draws this same screen in place (`app/onboarding/letterboxd.tsx`, 2026-09-13).
 *
 * `ImportScreen` renders its own `Screen`; this route exists to own the header and the
 * surface name the analytics funnel is split by.
 *
 * `job` is the import a notification is about (20260917001500): the push and the inbox
 * row open `/settings/import?job=<id>`, and the screen reconstructs that job from the
 * server, so it works from a cold start as well as from inside the app. An id that is not
 * a string, or names no job this account can read, opens the importer.
 */
export default function ImportRoute() {
  const { job } = useLocalSearchParams<{ job?: string }>();
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Import from Letterboxd',
          headerBackTitle: 'Back',
        }}
      />
      <ImportScreen surface="settings" jobId={typeof job === 'string' && job ? job : null} />
    </>
  );
}
