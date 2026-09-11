import { Stack } from 'expo-router';

import { ImportScreen } from '@/features/import/ImportScreen';

/**
 * Import from Letterboxd.
 *
 * The permanent home of the importer. Contract V3 §9 makes it optional and available at
 * any time rather than a step in first-run, so Settings is where it lives and onboarding
 * only points at it.
 *
 * `ImportScreen` renders its own `Screen`; this route exists to own the header and the
 * surface name the analytics funnel is split by.
 */
export default function ImportRoute() {
  return (
    <>
      <Stack.Screen
        options={{ headerShown: true, title: 'Import from Letterboxd', headerBackTitle: 'Back' }}
      />
      <ImportScreen surface="settings" />
    </>
  );
}
