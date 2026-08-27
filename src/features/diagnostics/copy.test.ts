import { QueryClient } from '@tanstack/react-query';
import { Clipboard } from 'react-native';

import { note, recordRequest, resetFlightRecorder } from '@/lib/flight-recorder';

import { copyDiagnostics } from './copy';
import { buildDiagnosticsReport } from './report';

/**
 * The failsafe, and the reason it exists.
 *
 * The recorder was unreachable on the founder's device for a whole day — not because it was
 * broken, but because the sheet that displayed it could not be presented. An instrument that
 * a rendering bug can lock away is not an instrument, so there is now a path to the same text
 * that presents nothing at all.
 *
 * These pin the two halves: the report can be assembled with no component mounted, and
 * writing it to the clipboard cannot throw into the screen that offered the control.
 */

const mockPrefs = new Map<string, unknown>();
/** Preference names whose read never settles — the Keychain lane of the device's pathology. */
const mockReadHangs = new Set<string>();
let mockSessionHangs = false;

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) =>
    mockReadHangs.has(name)
      ? new Promise(() => {})
      : Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () =>
        mockSessionHangs
          ? new Promise(() => {})
          : Promise.resolve({ data: { session: null }, error: null }),
    },
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: null, error: null, count: 0 }),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-updates', () => ({
  isEmbeddedLaunch: false,
  createdAt: new Date('2026-08-26T23:00:00.000Z'),
  runtimeVersion: 'd3b308f7',
  updateId: '01a04092',
  channel: 'beta',
}));

// `react-native`'s top-level `Clipboard` is a getter that returns the `default` export of
// this module, so the mock has to have one.
jest.mock('react-native/Libraries/Components/Clipboard/Clipboard', () => ({
  __esModule: true,
  default: { setString: jest.fn(), getString: jest.fn() },
}));

const setString = Clipboard.setString as unknown as jest.Mock;

beforeEach(() => {
  mockPrefs.clear();
  mockReadHangs.clear();
  mockSessionHangs = false;
  resetFlightRecorder();
  setString.mockReset();
});

describe('copying without opening anything', () => {
  it('writes the report to the clipboard', () => {
    expect(copyDiagnostics('bingd. diagnostics\nRELEASE\n  app 0.1.0')).toBe(true);
    expect(setString).toHaveBeenCalledWith(expect.stringContaining('bingd. diagnostics'));
  });

  it('refuses an empty report rather than clearing the clipboard', () => {
    expect(copyDiagnostics('')).toBe(false);
    expect(setString).not.toHaveBeenCalled();
  });

  /**
   * A failsafe that can crash the screen it is a failsafe for is not one. If a future SDK
   * finally removes the deprecated core clipboard, this reports failure and the sheet's
   * selectable text is still a way off the device.
   */
  it('reports failure rather than throwing when the clipboard is gone', () => {
    setString.mockImplementation(() => {
      throw new Error('Clipboard has been removed from react-native core');
    });

    expect(() => copyDiagnostics('anything')).not.toThrow();
    expect(copyDiagnostics('anything')).toBe(false);
  });
});

describe('the report, assembled with no component mounted', () => {
  /**
   * **This is the property the hotfix is for.** Every section is present, produced by a
   * plain function call, with nothing rendered anywhere.
   */
  it('contains every section the device is asked about', async () => {
    const handle = recordRequest('https://x.supabase.co/rest/v1/rankings');
    handle.sent();
    handle.settled({ status: 200 });
    note('signout', 'signOut.supabase', 'timeout', 2000);
    note('onboarding', 'read', 'active(disk)');
    note('route', 'onboarding/taste', 'stay:ready');

    const report = await buildDiagnosticsReport(new QueryClient(), 'settings');

    for (const heading of [
      'RELEASE',
      'AUTH',
      'ONBOARDING',
      'APP',
      'NETWORK',
      'QUERIES',
      'EVENTS',
      'COUNTS',
    ]) {
      expect(report).toContain(heading);
    }
    expect(report).toContain('rest:rankings');
    expect(report).toContain('signOut.supabase');
    expect(report).toContain('active(disk)');
    expect(report).toContain('settings');
  });

  /** And the sanitisation of PR #55 is unchanged on this path, because it is the same path. */
  it('carries nothing private', async () => {
    const handle = recordRequest(
      'https://x.supabase.co/rest/v1/profiles?select=id&username=eq.fourward_test&apikey=eyJhbGciOi',
    );
    handle.sent();
    handle.settled({
      error: Object.assign(new Error('value "a private note" violates check'), {
        name: 'PostgrestError',
      }),
    });

    const report = await buildDiagnosticsReport(new QueryClient(), 'settings');

    for (const secret of ['fourward_test', 'eyJhbGciOi', 'a private note', 'eq.']) {
      expect(report).not.toContain(secret);
    }
  });
});

describe('a report source that does not answer', () => {
  /**
   * **The founder's "Building…", as a test.** `readLastSession` is a cold Keychain read —
   * the one await in the builder that carried no bound, flagged by review 51 and dismissed
   * as theoretical. On the device it hung, and with it both the sheet and Copy
   * diagnostics: a hang is not a rejection, so no catch fired and nothing changed.
   *
   * The report now arrives anyway, and the timeout is printed as what it is — a storage
   * finding — rather than silently absent.
   */
  it('still produces the report when the persisted tail cannot be read', async () => {
    jest.useFakeTimers();
    try {
      mockReadHangs.add('diagnostics.lastSession');
      const handle = recordRequest('https://x.supabase.co/rest/v1/rankings');
      handle.sent();
      handle.settled({ status: 200 });

      const building = buildDiagnosticsReport(new QueryClient(), 'settings');
      const outcome = building.then((text) => ({ done: true as const, text }));
      await jest.advanceTimersByTimeAsync(9000);

      const report = await Promise.race([
        outcome,
        Promise.resolve({ done: false as const, text: '' }),
      ]);

      expect(report.done).toBe(true);
      expect(report.text).toContain('rest:rankings');
      expect(report.text).toContain('unreadable — the storage read did not answer');
    } finally {
      jest.useRealTimers();
    }
  });

  /** And the belt over everything: even an unforeseen stall cannot hold the builder. */
  it('resolves within the watchdog whatever hangs', async () => {
    jest.useFakeTimers();
    try {
      mockReadHangs.add('diagnostics.lastSession');
      mockSessionHangs = true;

      const building = buildDiagnosticsReport(new QueryClient(), 'settings');
      const settled = jest.fn();
      void building.then(settled);

      await jest.advanceTimersByTimeAsync(8100);
      expect(settled).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  /** The heat question gets a number: recent request starts, from the ring itself. */
  it('reports how much network work started recently', async () => {
    const handle = recordRequest('https://x.supabase.co/rest/v1/rankings');
    handle.sent();
    handle.settled({ status: 200 });

    const report = await buildDiagnosticsReport(new QueryClient(), 'settings');

    expect(report).toContain('ACTIVITY');
    // The window is labelled by what was actually observed — a young process says so
    // rather than implying a full minute (review 58's minor).
    expect(report).toMatch(/last \d+s\s+1 requests started/);
  });
});
