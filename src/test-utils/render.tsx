import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/**
 * Renders a component the way the app does, with a real QueryClient rather than a stand-in.
 *
 * The sheets in this app are mostly a state machine over a handful of RPCs, and a fake
 * useQuery hides the transitions that matter — a card that is still loading, a read that
 * failed. The one change from production is `retry: false`, so a deliberate failure is a
 * failure on the first attempt instead of after three back-offs.
 */
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * A phone with Android 3-button navigation, for the assertions that are about clearing it.
 *
 * 48dp is the system bar's own height, which is what a device reports through the bottom
 * inset under edge-to-edge. The default `METRICS` above is an iPhone's home indicator, and
 * a fix that clears 34 does not necessarily clear 48 — which is the difference the founder
 * was looking at on a physical device.
 */
export const ANDROID_NAV_INSET = 48;

const providers = (bottomInset?: number) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: 0 },
    },
  });

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SafeAreaProvider
        initialMetrics={
          bottomInset === undefined
            ? METRICS
            : { ...METRICS, insets: { ...METRICS.insets, bottom: bottomInset } }
        }
      >
        {children}
      </SafeAreaProvider>
    </QueryClientProvider>
  );

  return { client, Wrapper };
};

export async function renderWithProviders(
  ui: ReactElement,
  options?: { bottomInset?: number },
) {
  const { client, Wrapper } = providers(options?.bottomInset);

  // Everything in this library is async as of v14: render, rerender and fireEvent all wrap
  // their work in act and have to be awaited, or assertions run against a tree that has not
  // been given the chance to update.
  return { client, ...(await render(ui, { wrapper: Wrapper })) };
}

export async function renderHookWithProviders<T>(hook: () => T) {
  const { client, Wrapper } = providers();
  return { client, ...(await renderHook(hook, { wrapper: Wrapper })) };
}
