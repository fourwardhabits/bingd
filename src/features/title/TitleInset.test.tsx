import { waitFor } from '@testing-library/react-native';

import { PADDED_INSETS, SAFE_AREA_TEST_ID, rootPadding } from '@/test-utils/padded-safe-area';
import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files.
import TitleScreen from '../../../app/title/[id]';

/**
 * **No doubled top inset on a title page that has not loaded** (founder QA, 2026-11-12),
 * the Settings root's fix.
 *
 * The root layout shows a native-stack header on `title/[id]` until the page has its
 * title, when it hides that header and draws its own bar over the hero (`edges={[]}`,
 * unchanged and not asserted here). So the spinner, *Could not load this title* and
 * *Title not found* are the states that sat under a real header with `Screen`'s default
 * top edge as well. See `@/test-utils/padded-safe-area` for the stand-in.
 */
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual('@/test-utils/padded-safe-area').paddedSafeAreaModule(),
);

/** How every read answers: held open, failed, or (for `missing`) never asked. */
let mockMode: 'pending' | 'error' = 'pending';
let mockOpenId: string | undefined = 'film-1';

jest.mock('@/lib/supabase', () => {
  const answer = () =>
    mockMode === 'pending'
      ? new Promise(() => {})
      : Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } });
  return {
    supabase: {
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
      rpc: () => answer(),
      from: () => {
        const chain: Record<string, unknown> = {
          single: answer,
          maybeSingle: answer,
          then: (resolve: (value: unknown) => unknown, reject: (e: unknown) => unknown) =>
            answer().then(resolve, reject),
        };
        for (const m of [
          'select',
          'eq',
          'in',
          'is',
          'gt',
          'lt',
          'gte',
          'order',
          'limit',
          'or',
        ]) {
          chain[m] = () => chain;
        }
        return chain;
      },
    },
    startSessionRefresh: () => () => {},
  };
});

jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  useRouter: () => ({ push: () => {}, back: () => {}, replace: () => {} }),
  useLocalSearchParams: () => ({ id: mockOpenId }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

jest.mock('@/features/title/use-enrichment', () => ({
  ...jest.requireActual('@/features/title/use-enrichment'),
  useTitleEnrichment: () => ({ enriching: false }),
}));

jest.mock('expo-localization', () => ({ getLocales: () => [{ regionCode: 'US' }] }));

const expectHeaderOwnsTheTop = async (ready?: RegExp) => {
  const view = await renderWithProviders(<TitleScreen />);
  await waitFor(() => {
    expect(view.getAllByTestId(SAFE_AREA_TEST_ID).length).toBeGreaterThan(0);
    if (ready) expect(view.getByText(ready)).toBeTruthy();
  });
  const style = rootPadding(view);
  expect(style.paddingTop).toBe(0);
  expect(style.paddingLeft).toBe(PADDED_INSETS.left);
  expect(style.paddingRight).toBe(PADDED_INSETS.right);
};

beforeEach(() => {
  mockMode = 'pending';
  mockOpenId = 'film-1';
});

describe('the top of a title page that has not loaded', () => {
  it('adds no second inset under the header while it loads', async () => {
    await expectHeaderOwnsTheTop();
  });

  it('adds none on Could not load this title', async () => {
    mockMode = 'error';
    await expectHeaderOwnsTheTop(/Could not load this title/);
  });

  it('adds none on Title not found', async () => {
    mockOpenId = undefined;
    await expectHeaderOwnsTheTop(/Title not found/);
  });
});
