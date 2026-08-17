import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useTasteOnboarding } from './use-taste-onboarding';

const mockPrefs = new Map<string, unknown>();
const mockCounts: Record<string, number | null> = {};
const mockErrors: Record<string, unknown> = {};

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: () => Promise.resolve(),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          resolve({
            data: null,
            error: mockErrors[table] ?? null,
            count: mockCounts[table] ?? 0,
          }),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => {
  mockPrefs.clear();
  for (const key of Object.keys(mockCounts)) delete mockCounts[key];
  for (const key of Object.keys(mockErrors)) delete mockErrors[key];
  mockCounts.rankings = 0;
  mockCounts.user_media = 0;
});

const read = async () => {
  const { result } = await renderHookWithProviders(() => useTasteOnboarding('user-1'));
  await waitFor(() => expect(result.current.isPending).toBe(false));
  return result;
};

/**
 * Who gets the first-run flow, and — much more importantly — who never does.
 *
 * Dropping an existing user into "build your taste" is the app telling somebody with a
 * collection that it has never met them. That is the failure worth being careful about,
 * so every test here except the first is a way of *not* entering.
 */
describe('useTasteOnboarding', () => {
  it('is needed by an account with nothing in it', async () => {
    const result = await read();
    expect(result.current.data).toEqual({ ranked: 0, needed: true });
  });

  it('is not needed by an account that has ranked something', async () => {
    mockCounts.rankings = 12;
    mockCounts.user_media = 12;

    const result = await read();
    expect(result.current.data?.needed).toBe(false);
  });

  it('is not needed by an account that logged without ranking', async () => {
    // The test is any collection at all, not zero rankings. Somebody who logged four
    // films and never compared them has been using the app.
    mockCounts.rankings = 0;
    mockCounts.user_media = 4;

    const result = await read();
    expect(result.current.data?.needed).toBe(false);
  });

  it('is not needed by somebody who already said not now', async () => {
    mockPrefs.set('user-1.onboarding.taste.skipped', true);

    const result = await read();
    expect(result.current.data?.needed).toBe(false);
  });

  it('reports how many films are already placed, which is the progress', async () => {
    mockCounts.rankings = 3;
    mockCounts.user_media = 3;

    const result = await read();
    expect(result.current.data?.ranked).toBe(3);
  });

  it('does not put anyone through the flow when it cannot tell', async () => {
    // A failed read is not evidence that somebody is new. The routing treats a missing
    // answer as "not needed" for exactly this reason: the cost of skipping the flow for
    // a genuinely new account is a suggestion they did not get, and the cost of the
    // other mistake is an established user being asked to start again.
    mockErrors.rankings = { message: 'network' };

    const { result } = await renderHookWithProviders(() => useTasteOnboarding('user-1'));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data?.needed).toBeUndefined();
    expect(result.current.isError).toBe(true);
  });
});
