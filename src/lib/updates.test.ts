import { act, renderHook } from '@testing-library/react-native';
import * as Updates from 'expo-updates';
import { AppState, type AppStateStatus } from 'react-native';

import {
  isSafeToReload,
  resetUpdateChecks,
  startUpdateChecks,
  useUpdateChecks,
} from './updates';

jest.mock('expo-updates', () => ({
  isEnabled: true,
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
}));

const mocked = Updates as jest.Mocked<typeof Updates>;

/**
 * The AppState listener, captured, so a test can walk the app to the background and back
 * the way a trip to Mail does.
 */
let emit: (next: AppStateStatus) => void = () => {
  throw new Error('startUpdateChecks registered no listener');
};

const foreground = async () => {
  await act(async () => {
    emit('background');
    emit('active');
  });
};

const dev = (globalThis as { __DEV__?: boolean }).__DEV__;

beforeEach(() => {
  resetUpdateChecks();
  jest.clearAllMocks();
  // A release build: in development `startUpdateChecks` does nothing at all.
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    emit = handler as (next: AppStateStatus) => void;
    return { remove: jest.fn() } as never;
  });

  // A channel carrying an update newer than what is running — which is every fresh
  // install of a binary older than its channel's latest update.
  mocked.checkForUpdateAsync.mockResolvedValue({ isAvailable: true } as never);
  mocked.fetchUpdateAsync.mockResolvedValue({ isNew: true } as never);
  mocked.reloadAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = dev;
  jest.restoreAllMocks();
});

describe('isSafeToReload', () => {
  it('allows only a signed-in account outside the first-run route groups', () => {
    expect(isSafeToReload('ready', '(tabs)')).toBe(true);
    expect(isSafeToReload('ready', 'title')).toBe(true);
    // The index route, `/`, has no group; it is a transit screen for a ready account.
    expect(isSafeToReload('ready', undefined)).toBe(true);
  });

  it.each([
    ['signed-out', '(auth)', 'the sign-in form and the code screen'],
    ['signed-out', undefined, 'signed out before the router has placed them'],
    ['onboarding', '(auth)', 'create-profile: an account with no profile yet'],
    ['ready', 'onboarding', 'the first-run steps, including the notification prompt'],
    ['ready', '(auth)', 'a ready session still drawn on an auth screen'],
    ['loading', undefined, 'not knowing where somebody is'],
    ['error', undefined, 'knowing that we could not find out'],
    ['something-new', '(tabs)', 'a status nobody has classified yet'],
  ])('holds the reload for %s on %s (%s)', (status, group, _why) => {
    expect(isSafeToReload(status, group)).toBe(false);
  });
});

describe('the foreground update check', () => {
  /**
   * **The fresh-install case the audit found.** Signed out, code requested, off to Mail
   * and back. The update still downloads — it is on disk for the next launch — and the
   * code screen is left where it was.
   */
  it('does not reload a signed-out person returning to the app', async () => {
    await renderHook(() => useUpdateChecks(isSafeToReload('signed-out', '(auth)')));

    await foreground();

    expect(mocked.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mocked.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mocked.reloadAsync).not.toHaveBeenCalled();
  });

  /**
   * The same trip with the route the layout actually passes for `(auth)/verify`, and
   * a second return — somebody who went back to Mail to check they copied it right.
   */
  it('does not reload the code screen, however many times it comes back', async () => {
    // `(auth)/verify` reaches the layout as segments ['(auth)', 'verify'], and only the
    // first is passed.
    await renderHook(() => useUpdateChecks(isSafeToReload('signed-out', '(auth)')));

    await foreground();
    await foreground();

    expect(mocked.reloadAsync).not.toHaveBeenCalled();
  });

  it('does not reload during the first-run steps of a signed-in account', async () => {
    await renderHook(() => useUpdateChecks(isSafeToReload('ready', 'onboarding')));

    await foreground();

    expect(mocked.reloadAsync).not.toHaveBeenCalled();
  });

  /** The behaviour everybody already signed in has had since the beta, unchanged. */
  it('reloads a signed-in account in the app, as before', async () => {
    await renderHook(() => useUpdateChecks(isSafeToReload('ready', '(tabs)')));

    await foreground();

    expect(mocked.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mocked.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it('does not reload when there is nothing new', async () => {
    mocked.checkForUpdateAsync.mockResolvedValue({ isAvailable: false } as never);
    await renderHook(() => useUpdateChecks(isSafeToReload('ready', '(tabs)')));

    await foreground();

    expect(mocked.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(mocked.reloadAsync).not.toHaveBeenCalled();
  });

  /**
   * **A held update applies at the next safe moment.** Signed out on the first return, so
   * it is downloaded and held; signed in and in the app on a later one, so it applies.
   */
  it('applies a held update on the first foreground return that is safe', async () => {
    const view = await renderHook(({ safe }: { safe: boolean }) => useUpdateChecks(safe), {
      initialProps: { safe: isSafeToReload('signed-out', '(auth)') },
    });

    await foreground();
    expect(mocked.reloadAsync).not.toHaveBeenCalled();

    await view.rerender({ safe: isSafeToReload('ready', '(tabs)') });
    await foreground();

    expect(mocked.reloadAsync).toHaveBeenCalledTimes(1);
  });

  /**
   * The gate is read when the download finishes, not when the check starts. A download is
   * seconds on a phone; somebody can sign out, or a new account be routed into its
   * first-run steps, while it runs.
   */
  it('re-reads the gate after the download, not before the check', async () => {
    let finishDownload: (value: { isNew: true }) => void = () => {};
    mocked.fetchUpdateAsync.mockImplementation(
      () => new Promise((resolve) => (finishDownload = resolve)) as never,
    );
    const view = await renderHook(({ safe }: { safe: boolean }) => useUpdateChecks(safe), {
      initialProps: { safe: true },
    });

    await foreground();
    await view.rerender({ safe: false });
    await act(async () => finishDownload({ isNew: true }));

    expect(mocked.reloadAsync).not.toHaveBeenCalled();
  });

  /**
   * **What a restart looks like from here.** `expo-updates` launches the newest downloaded
   * update at a cold start; that is native and not this module's to test. What is this
   * module's: the held update was fetched (so there is something to launch), and on the
   * restarted process the update now running is the one the channel carries, so the check
   * finds nothing and nothing reloads — the restart does not become a reload of its own.
   */
  it('leaves a held update for the restart, which then runs it without reloading again', async () => {
    await renderHook(() => useUpdateChecks(isSafeToReload('signed-out', '(auth)')));
    await foreground();
    expect(mocked.fetchUpdateAsync).toHaveBeenCalledTimes(1);

    // The restart: a new process, running the update it fetched.
    resetUpdateChecks();
    mocked.checkForUpdateAsync.mockResolvedValue({ isAvailable: false } as never);
    await renderHook(() => useUpdateChecks(isSafeToReload('ready', '(tabs)')));
    await foreground();

    expect(mocked.reloadAsync).not.toHaveBeenCalled();
  });

  /**
   * **No reload loop.** `reloadAsync` replaces the JavaScript context, so nothing runs after
   * it. If it resolves without doing so, every later return would otherwise ask again for
   * an update that has already shown it will not apply this session.
   */
  it('asks for a reload at most once per process', async () => {
    await renderHook(() => useUpdateChecks(isSafeToReload('ready', '(tabs)')));

    await foreground();
    await foreground();
    await foreground();

    expect(mocked.reloadAsync).toHaveBeenCalledTimes(1);
    // And stops checking, rather than downloading the same bundle on every return.
    expect(mocked.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });

  it('does not stack a second check on one still downloading', async () => {
    mocked.fetchUpdateAsync.mockImplementation(() => new Promise(() => {}) as never);
    await renderHook(() => useUpdateChecks(isSafeToReload('ready', '(tabs)')));

    await foreground();
    await foreground();

    expect(mocked.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });

  it('never reloads in the foreground when started with no gate', async () => {
    const stop = startUpdateChecks();

    await foreground();

    expect(mocked.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mocked.reloadAsync).not.toHaveBeenCalled();
    stop();
  });

  it('does nothing in a development build', () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;

    startUpdateChecks(() => true);

    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });

  it('counts a return from inactive, which is what a system sheet produces', async () => {
    await renderHook(() => useUpdateChecks(isSafeToReload('signed-out', '(auth)')));

    await act(async () => {
      emit('inactive');
      emit('active');
    });

    expect(mocked.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mocked.reloadAsync).not.toHaveBeenCalled();
  });
});
