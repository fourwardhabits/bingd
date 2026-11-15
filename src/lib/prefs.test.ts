import { readPref, writePref } from './prefs';

/**
 * `readPref` is the one place a stored preference is parsed, so a key that is not JSON —
 * truncated by an interrupted write, or left by something else — has to come back as
 * absent rather than throw. Collection and For You then treat absent as their default.
 */
/** Read lazily inside the factory's functions, so `jest.mock`'s hoisting above it is safe. */
const mockStore: Record<string, string | null> = {};

jest.mock('./session-storage', () => ({
  sessionStorage: {
    getItem: (key: string) => Promise.resolve(mockStore[key] ?? null),
    setItem: (key: string, value: string) => {
      mockStore[key] = value;
      return Promise.resolve();
    },
  },
}));

beforeEach(() => {
  for (const key of Object.keys(mockStore)) delete mockStore[key];
});

describe('readPref', () => {
  it('reads what writePref wrote, under the pref. prefix', async () => {
    await writePref('user-1.for-you.selection', { medium: 'tv', topMedium: null });

    expect(mockStore['pref.user-1.for-you.selection']).toBe('{"medium":"tv","topMedium":null}');
    await expect(readPref('user-1.for-you.selection')).resolves.toEqual({ medium: 'tv', topMedium: null });
  });

  it('answers null for a key that was never written', async () => {
    await expect(readPref('user-1.collection.segment')).resolves.toBeNull();
  });

  it.each(['{"medium":"tv"', 'watchlist', '{]'])('answers null for malformed JSON %p', async (raw) => {
    mockStore['pref.user-1.collection.segment'] = raw;

    await expect(readPref('user-1.collection.segment')).resolves.toBeNull();
  });
});
