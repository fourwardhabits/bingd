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
    mockPrefs.set('user-1.onboarding.taste.phase', 'skipped');

    const result = await read();
    expect(result.current.data?.needed).toBe(false);
  });

  it('is not needed by somebody who finished it', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'done');
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    const result = await read();
    expect(result.current.data?.needed).toBe(false);
  });

  /**
   * The defect independent review found, as two tests.
   *
   * The entry test used to be "this account has nothing in it", and the flow's own first
   * film falsifies that — `set_bucket` writes a `user_media` row. So from film one
   * onward the account no longer looked new: the router saw somebody on the onboarding
   * route who no longer needed it and sent them to the feed at 1 of 5, and closing the
   * app after the first film meant reopening went straight past the rest.
   *
   * The entry decision is now taken once and remembered, and only progress is read live.
   */
  it('stays needed once the flow has started and put a film in the collection', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 1;
    mockCounts.user_media = 1;

    const result = await read();
    expect(result.current.data).toEqual({ ranked: 1, needed: true });
  });

  it('resumes a flow abandoned after one film, on the next launch', async () => {
    // Bucketed one and closed the app before the comparison finished: a `user_media`
    // row exists and no ranking does. Under the old test this account read as
    // established and never saw the flow again.
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 0;
    mockCounts.user_media = 1;

    const result = await read();
    expect(result.current.data?.needed).toBe(true);
  });

  it('stays needed at five, because leaving is an act and not a count', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    // Tying this to the count would give the fifth placement two jobs — completing the
    // flow and dismissing it — and the second fires first, so the screen would be sent
    // away at the moment it had a summary to show. Somebody who force-quits on the
    // summary reopens on the summary, which is right: they have not said where they
    // wanted to go.
    expect((await read()).current.data?.needed).toBe(true);
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
