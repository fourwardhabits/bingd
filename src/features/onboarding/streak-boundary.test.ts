import { resetTasteIntent, streakBoundary } from './use-taste-onboarding';

/**
 * Where the weekly streak's life starts, per account, on this device (founder QA,
 * 2026-09-21). `clampToBoundary` in `streaks/streak.ts` applies it; `streak.test.ts` holds
 * the week-A / week-B / week-C timeline. This pins the three answers the boundary can give.
 */
const mockPrefs = new Map<string, unknown>();
jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));
jest.mock('@/lib/supabase', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }));

const PHASE = 'user-1.onboarding.taste.phase';
const STAMP = 'user-1.onboarding.taste.completed_at';

beforeEach(() => {
  mockPrefs.clear();
  resetTasteIntent();
});

describe('the streak boundary', () => {
  it('is now while onboarding is still under way', async () => {
    mockPrefs.set(PHASE, 'active');
    const before = Date.now();
    const boundary = await streakBoundary('user-1');
    expect(boundary).not.toBeNull();
    expect(boundary!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('is the recorded completion instant once onboarding has ended', async () => {
    mockPrefs.set(PHASE, 'done');
    mockPrefs.set(STAMP, '2026-09-16T19:11:00.000Z');
    expect((await streakBoundary('user-1'))?.toISOString()).toBe('2026-09-16T19:11:00.000Z');
  });

  it('prefers the stamp even while the phase still reads active', async () => {
    // The five-placed settle stamps the instant while the session keeps the flow live.
    mockPrefs.set(PHASE, 'active');
    mockPrefs.set(STAMP, '2026-09-16T19:11:00.000Z');
    expect((await streakBoundary('user-1'))?.toISOString()).toBe('2026-09-16T19:11:00.000Z');
  });

  it('is absent for an account that finished before the stamp existed — its streak is untouched', async () => {
    mockPrefs.set(PHASE, 'done');
    expect(await streakBoundary('user-1')).toBeNull();
  });

  it('is absent for anybody this device knows nothing about, such as another profile', async () => {
    expect(await streakBoundary('someone-else')).toBeNull();
  });

  it('ignores an unreadable stamp rather than inventing a boundary', async () => {
    mockPrefs.set(PHASE, 'done');
    mockPrefs.set(STAMP, 'not a date');
    expect(await streakBoundary('user-1')).toBeNull();
  });
});
