import { readLastSession, persistLastSession } from '@/lib/flight-persistence';
import { note, rememberRoute, resetFlightRecorder, snapshot } from '@/lib/flight-recorder';
import { formatReport } from '@/lib/flight-report';

import { diagnosticsAvailable, onDiagnosticsRequested, openDiagnostics } from './open';

/**
 * The way in, and the thing that survives a launch.
 *
 * Two properties worth pinning separately from the recorder itself:
 *
 *   · **the entrance is a signal, not a route** — because `useAuthRouting` sends the
 *     account this exists to diagnose straight back to `/onboarding/taste` from any other
 *     group, so a route would be pushed and immediately replaced on the exact screen the
 *     founder is stuck on;
 *   · **the persisted tail is validated before it is rendered** — it outlives an app
 *     update, so a payload written by an older build is an ordinary case rather than a
 *     hypothetical, and a half-shaped object reaching the formatter would be a crash in the
 *     one screen that must not have one.
 */

const mockPrefs = new Map<string, unknown>();
let mockWriteFails = false;

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    if (mockWriteFails) return Promise.reject(new Error('keychain unavailable'));
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

beforeEach(() => {
  mockPrefs.clear();
  mockWriteFails = false;
  resetFlightRecorder();
});

describe('the way in', () => {
  it('is available outside a store build', () => {
    // The test configuration is the `preview` variant, which is the lane a tester runs.
    expect(diagnosticsAvailable).toBe(true);
  });

  it('reaches every listener that asked', () => {
    const opened: string[] = [];
    const stopA = onDiagnosticsRequested(() => opened.push('a'));
    const stopB = onDiagnosticsRequested(() => opened.push('b'));

    openDiagnostics();

    expect(opened).toEqual(['a', 'b']);
    stopA();
    stopB();
  });

  it('stops reaching a listener that unsubscribed', () => {
    const opened: string[] = [];
    const stop = onDiagnosticsRequested(() => opened.push('a'));
    stop();

    openDiagnostics();

    expect(opened).toEqual([]);
  });

  /** A listener that unsubscribes itself while being notified must not break the loop. */
  it('survives a listener that removes itself mid-notification', () => {
    const opened: string[] = [];
    let stopSelf = () => {};
    stopSelf = onDiagnosticsRequested(() => {
      opened.push('self');
      stopSelf();
    });
    const stopOther = onDiagnosticsRequested(() => opened.push('other'));

    expect(() => openDiagnostics()).not.toThrow();
    expect(opened).toEqual(['self', 'other']);
    stopOther();
  });
});

describe('the tail kept for the next launch', () => {
  it('round-trips the last route and what was unfinished', async () => {
    note('route', 'onboarding/taste', 'stay:ready');
    rememberRoute('onboarding/taste');

    await persistLastSession('onboarding/taste');
    const held = await readLastSession();

    expect(held?.route).toBe('onboarding/taste');
    expect(held?.events.length).toBeGreaterThan(0);
  });

  /** A diagnostic that can break the app it is diagnosing is worse than no diagnostic. */
  it('never rejects when the store refuses', async () => {
    mockWriteFails = true;
    await expect(persistLastSession('feed')).resolves.toBeUndefined();
  });

  it('reads nothing when nothing was written', async () => {
    await expect(readLastSession()).resolves.toBeNull();
  });

  /**
   * The payload outlives an app update, so a shape written by an older build is ordinary.
   * Anything that does not match is discarded rather than handed to the formatter.
   */
  it('discards a payload it does not recognise', async () => {
    mockPrefs.set('diagnostics.lastSession', { route: 'feed' });
    await expect(readLastSession()).resolves.toBeNull();

    mockPrefs.set('diagnostics.lastSession', 'not an object');
    await expect(readLastSession()).resolves.toBeNull();
  });

  it('bounds what it hands back, whatever was stored', async () => {
    mockPrefs.set('diagnostics.lastSession', {
      endedAtIso: '2026-08-26T22:00:00.000Z',
      uptimeMs: 'not a number',
      events: Array.from({ length: 400 }, (_, i) => ({
        seq: i,
        at: i,
        channel: 'route',
        label: 'x',
      })),
      pending: Array.from({ length: 400 }, () => 'rest:rankings'),
    });

    const held = await readLastSession();

    expect(held?.events.length).toBe(12);
    expect(held?.pending.length).toBe(12);
    expect(held?.uptimeMs).toBe(0);
  });
});

describe('a payload written by a different build', () => {
  /**
   * **Independent review 51's fourth finding.** The shallow check confirmed `events` was an
   * array and handed the elements straight to a formatter that calls `padEnd` on `channel`
   * and `label`. A payload from an older build is an ordinary case — this value outlives an
   * app update — so that could throw inside the one screen that must not throw, or
   * interpolate a string this build never chose into text about to be pasted somewhere
   * public.
   */
  it('coerces every field of a stored event', async () => {
    mockPrefs.set('diagnostics.lastSession', {
      endedAtIso: '2026-08-26T22:00:00.000Z',
      uptimeMs: 1000,
      events: [
        {
          seq: 'x',
          at: null,
          channel: 'a-channel-from-the-future',
          label: 42,
          detail: {},
          ms: 'y',
        },
        null,
      ],
      pending: ['rest:rankings', 99, { table: 'rankings' }],
    });

    const held = await readLastSession();

    expect(held?.events[0]).toEqual({
      seq: 0,
      at: 0,
      channel: 'app',
      label: '(unknown)',
      detail: undefined,
      ms: undefined,
    });
    // A null element must not throw on the way through either.
    expect(held?.events[1]?.label).toBe('(unknown)');
    // Non-strings are dropped rather than rendered.
    expect(held?.pending).toEqual(['rest:rankings']);
  });

  /** And the formatter has to survive whatever comes out of that. */
  it('formats a coerced payload without throwing', async () => {
    mockPrefs.set('diagnostics.lastSession', {
      endedAtIso: '2026-08-26T22:00:00.000Z',
      events: [{ label: 12345 }],
      pending: [{}],
    });

    const held = await readLastSession();
    expect(() =>
      formatReport({
        release: {
          appVersion: null,
          buildNumber: null,
          runtimeVersion: null,
          updateId: null,
          channel: null,
          embedded: true,
          launchedAtIso: '2026-08-26T22:00:00.000Z',
        },
        auth: { sessionExists: false, authCallbacks: 0 },
        onboarding: { storedPhase: 'absent', derivedNeeded: 'NO', ranked: 0, logged: 0 },
        route: '(root)',
        appState: 'active',
        flight: snapshot(),
        queries: [],
        lastSession: held,
      }),
    ).not.toThrow();
  });
});

describe('a session that could not be read', () => {
  /**
   * On the exact stall this exists to diagnose, `getSession()` is the thing that does not
   * come back — so "no session" and "could not ask" must be different answers. Reporting
   * the first when the second is true would be the report asserting the opposite of the
   * truth.
   */
  it('says UNKNOWN rather than NO', () => {
    const report = formatReport({
      release: {
        appVersion: null,
        buildNumber: null,
        runtimeVersion: null,
        updateId: null,
        channel: null,
        embedded: true,
        launchedAtIso: '2026-08-26T22:00:00.000Z',
      },
      auth: { sessionExists: false, sessionKnown: false, authCallbacks: 0 },
      onboarding: {
        storedPhase: 'unreadable',
        derivedNeeded: 'unknown',
        ranked: null,
        logged: null,
      },
      route: '(root)',
      appState: 'active',
      flight: snapshot(),
      queries: [],
      lastSession: null,
    });

    expect(report).toContain('UNKNOWN (read did not answer)');
  });
});
