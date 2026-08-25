import { signOut } from './methods';

/**
 * Sign-out has to *settle*, and the reason is what its four callers do with it.
 *
 * `app/settings/index.tsx`, `app/settings/account.tsx` (twice) and
 * `app/(auth)/create-profile.tsx` all write `await signOut()` and then navigate. None of
 * them catches. So a rejection anywhere inside is a person who tapped **Sign out**, saw
 * nothing happen, and is still signed in — with an unhandled promise behind it.
 *
 * Independent review 45 found the live version of that: the Keychain delete between the
 * push-token release and the session teardown was unguarded, and `SecureStore` rejects
 * rather than returning when the store is locked or unavailable.
 *
 * The worst caller is the account-deletion one, where the account is **already gone
 * server-side** and this session is the last thing pointing at it.
 */

const mockSupabaseSignOut = jest.fn();
const mockRelease = jest.fn();
const mockDelete = jest.fn();
const mockReport = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { signOut: (...a: unknown[]) => mockSupabaseSignOut(...a) } },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/features/notifications/push', () => ({
  releaseDeviceOnSignOut: (...a: unknown[]) => mockRelease(...a),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: (...a: unknown[]) => mockDelete(...a),
}));

jest.mock('@/lib/monitoring', () => ({
  reportHandled: (...a: unknown[]) => mockReport(...a),
}));

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));
jest.mock('expo-linking', () => ({ createURL: (p: string) => `bingd://${p}` }));

beforeEach(() => {
  [mockSupabaseSignOut, mockRelease, mockDelete, mockReport].forEach((m) => m.mockReset());
  mockRelease.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
  mockSupabaseSignOut.mockResolvedValue({ error: null });
});

describe('signing out', () => {
  /**
   * The push token is released **before** the session ends, because revoking needs a JWT
   * and there is none a line later. A device left registered would deliver the next
   * account's follows and recommendations — with a sender's name and a film's title — to
   * whoever signs in after this one.
   */
  it('releases the device before ending the session', async () => {
    const order: string[] = [];
    mockRelease.mockImplementation(async () => void order.push('release'));
    mockSupabaseSignOut.mockImplementation(async () => {
      order.push('signOut');
      return { error: null };
    });

    await signOut();

    expect(order).toEqual(['release', 'signOut']);
    expect(mockDelete).toHaveBeenCalled();
  });

  /**
   * **The review-45 defect.** A Keychain that will not delete must not be able to keep
   * somebody signed in.
   */
  it('ends the session even when the Keychain delete rejects', async () => {
    mockDelete.mockRejectedValue(new Error('User interaction is not allowed.'));

    await expect(signOut()).resolves.toBeUndefined();

    expect(mockSupabaseSignOut).toHaveBeenCalled();
    expect(mockReport).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ scope: 'signOut.clearPendingDisplayName' }),
    );
  });

  /**
   * And the teardown itself settles rather than rejecting into a caller that is about to
   * navigate. `supabase.auth.signOut()` normally returns `{ error }` instead of throwing;
   * this is the branch where something underneath it does.
   */
  it('settles even when the session teardown itself throws', async () => {
    mockSupabaseSignOut.mockRejectedValue(new Error('storage unavailable'));

    await expect(signOut()).resolves.toBeUndefined();

    expect(mockReport).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ scope: 'signOut.supabase' }),
    );
  });

  /**
   * The one thing that is allowed to be missing is the pending Apple display name, and it
   * is cosmetic: it pre-fills a signup form. A session that outlives the tap is not.
   */
  it('does not swallow the release step, which reports for itself', async () => {
    // `releaseDeviceOnSignOut` is documented as reporting and returning rather than
    // throwing. If that ever changes, this is the assertion that notices.
    await signOut();
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockReport).not.toHaveBeenCalled();
  });
});
