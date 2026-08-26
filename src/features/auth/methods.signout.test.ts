import { signOut } from './methods';

/**
 * Sign-out has to *settle*, and — since TestFlight build 4 — it has to settle **soon**.
 *
 * The first half is review 45's: `app/settings/index.tsx`, `app/settings/account.tsx`
 * (twice), `app/(auth)/create-profile.tsx` and `UseDifferentAccount.tsx` all write
 * `await signOut()` and then navigate, and none of them catches. A rejection anywhere
 * inside is a person who tapped **Sign out**, saw nothing happen, and is still signed in.
 * The worst caller is the account-deletion one, where the account is already gone
 * server-side and this session is the last thing pointing at it.
 *
 * The second half is what the founder's device demonstrated. Every step in here is a
 * promise the platform is allowed to never settle — two network calls and two Keychain
 * calls — and they were all awaited unbounded. So `Signing out…` sat there while the one
 * thing that could end the session waited on a reply that was not coming, the button's
 * own 8-second grace was reached with the session still alive, and routing correctly read
 * that as "still signed in" and put the person back where they started. Being unable to
 * leave an account is the trap this whole surface exists to open.
 *
 * The contract these tests pin: **remote first, briefly; local always.**
 */

const mockSupabaseSignOut = jest.fn();
const mockRelease = jest.fn();
const mockDelete = jest.fn();
const mockReport = jest.fn();
const mockRemoveItem = jest.fn();
const mockAnnounce = jest.fn();

const STORAGE_KEY = 'sb-project-auth-token';

jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { signOut: (...a: unknown[]) => mockSupabaseSignOut(...a) } },
  authStorageKey: 'sb-project-auth-token',
  announceLocalSignOut: (...a: unknown[]) => mockAnnounce(...a),
  startSessionRefresh: () => () => {},
}));

jest.mock('@/lib/session-storage', () => ({
  sessionStorage: { removeItem: (...a: unknown[]) => mockRemoveItem(...a) },
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
  [
    mockSupabaseSignOut,
    mockRelease,
    mockDelete,
    mockReport,
    mockRemoveItem,
    mockAnnounce,
  ].forEach((m) => m.mockReset());
  mockRelease.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
  mockRemoveItem.mockResolvedValue(undefined);
  mockSupabaseSignOut.mockResolvedValue({ error: null });
});

/** A promise the platform never answers — the shape every step here has to survive. */
const never = () => new Promise<never>(() => {});

/**
 * Runs `start()` against fake timers and reports how long, on that clock, it took.
 *
 * A thunk rather than a promise: the timers have to be faked *before* the work begins,
 * or the first `withGrace` inside it schedules against the real clock and the whole
 * measurement is of a test that is simply waiting.
 */
async function timed(start: () => Promise<unknown>): Promise<number> {
  jest.useFakeTimers();
  const began = Date.now();
  let elapsed = -1;
  const done = start().then(() => {
    elapsed = Date.now() - began;
  });
  // The button's own grace, which everything below has to fit inside.
  await jest.advanceTimersByTimeAsync(8_000);
  await done;
  jest.useRealTimers();
  return elapsed;
}

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
   * **This device, not every device.** The Supabase default is `scope: 'global'`, which
   * revokes every refresh token the account holds — so "Use a different account" on one
   * phone would silently sign the same person out of their iPad. Nothing in this product
   * asks for that.
   */
  it('ends this device’s session only', async () => {
    await signOut();
    expect(mockSupabaseSignOut).toHaveBeenCalledWith({ scope: 'local' });
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

  it('settles even when the session teardown itself throws', async () => {
    mockSupabaseSignOut.mockRejectedValue(new Error('storage unavailable'));

    await expect(signOut()).resolves.toBeUndefined();

    expect(mockReport).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ scope: 'signOut.supabase' }),
    );
  });

  it('does not swallow the release step, which reports for itself', async () => {
    await signOut();
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockReport).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // The build-4 half: nothing here may wait forever
  // -------------------------------------------------------------------------

  /**
   * **The device-token release is a network call**, and on a phone whose replies are not
   * arriving it is the first thing between the tap and the exit.
   */
  it('leaves without the device release when the release does not answer', async () => {
    mockRelease.mockImplementation(never);

    const elapsed = await timed(() => signOut());

    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(8_000);
    expect(mockSupabaseSignOut).toHaveBeenCalled();
  });

  /**
   * **The one that matters most.** When the server-side teardown does not answer, the
   * session is ended on this device anyway: the Keychain entry is deleted directly, and
   * `signOut` is then called a second time — which with storage empty finds no access
   * token, skips the network entirely, and emits the `SIGNED_OUT` that `AuthProvider` is
   * waiting on to clear the cache and let routing move the person.
   */
  it('ends the local session when the remote teardown does not answer', async () => {
    mockSupabaseSignOut.mockImplementationOnce(never).mockResolvedValue({ error: null });

    const elapsed = await timed(() => signOut());

    expect(elapsed).toBeLessThan(8_000);
    expect(mockRemoveItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(mockSupabaseSignOut).toHaveBeenCalledTimes(2);
  });

  /**
   * And when the remote teardown *worked*, the local step is skipped. It has already
   * removed the stored session, so repeating it is two Keychain calls and a second
   * `SIGNED_OUT` for nothing.
   */
  it('does not repeat the local exit when the server already did it', async () => {
    await signOut();
    expect(mockRemoveItem).not.toHaveBeenCalled();
    expect(mockSupabaseSignOut).toHaveBeenCalledTimes(1);
  });

  /**
   * A Keychain that has stopped answering altogether — every step hanging at once, which
   * is the state the founder's device was in. The exit still happens, inside the grace the
   * button gives it.
   */
  it('is bounded even when nothing at all answers', async () => {
    mockRelease.mockImplementation(never);
    mockDelete.mockImplementation(never);
    mockSupabaseSignOut.mockImplementation(never);
    mockRemoveItem.mockImplementation(never);

    const elapsed = await timed(() => signOut());

    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(8_000);
  });

  /**
   * **Independent review 49's first blocker.** Supabase emits `SIGNED_OUT` only after
   * `_removeSession` has awaited three storage operations, and storage that will not
   * answer is the whole condition this hotfix is about — so on the device that needs it
   * most, the event that tells the app it is signed out sits behind the thing that is
   * stuck. Routing goes on seeing a `ready` session and sends the escaping person back to
   * the screen they were leaving. The app has to be able to say it itself.
   */
  it('tells the app it is signed out even when nothing else answers', async () => {
    mockRelease.mockImplementation(never);
    mockDelete.mockImplementation(never);
    mockSupabaseSignOut.mockImplementation(never);
    mockRemoveItem.mockImplementation(never);

    await timed(() => signOut());

    expect(mockAnnounce).toHaveBeenCalledTimes(1);
  });

  /** And it is not said when the ordinary teardown worked — that emits its own event. */
  it('leaves the announcement to Supabase when Supabase managed it', async () => {
    await signOut();
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  /**
   * **Independent review 49's second blocker.** The teardown that was abandoned is still
   * running, and a token refresh already in flight when the Keychain entry was deleted can
   * write a working session back afterwards — auth-js guards only against removals it made
   * itself. On the next launch the person is signed in to the account they escaped. So the
   * key is removed once more when that abandoned work finally settles.
   */
  it('sweeps the stored session again once the abandoned teardown settles', async () => {
    let releaseTeardown = () => {};
    mockSupabaseSignOut
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseTeardown = () => resolve({ error: null });
          }),
      )
      .mockResolvedValue({ error: null });

    await timed(() => signOut());
    const duringExit = mockRemoveItem.mock.calls.length;

    releaseTeardown();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRemoveItem.mock.calls.length).toBeGreaterThan(duringExit);
    expect(mockRemoveItem).toHaveBeenLastCalledWith(STORAGE_KEY);
  });

  /** A step that ran out of time is reported, or a silent bound is a silent failure. */
  it('reports the step that ran out of time', async () => {
    mockRelease.mockImplementation(never);

    await timed(() => signOut());

    expect(mockReport).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ scope: 'signOut.releaseDevice' }),
    );
  });
});
