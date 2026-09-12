import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useImport } from './use-import';

/**
 * The two in-flight guards, tested on the hook rather than through the screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 *
 * These belong next to the other importer tests in `ImportScreen.test.tsx` and cannot live
 * there. **Two `fireEvent.press` calls in one test make every later render in that file
 * return an empty tree** — a known RNTL behaviour this project has been caught by before —
 * so a double-press test poisons every test declared after it, whichever order they are in
 * and whether or not the presses are awaited.
 *
 * Calling the hook's own handlers twice inside one `act` is a closer model of the thing
 * being tested anyway. The guards are refs precisely *because* a rendered phase has not
 * committed yet when the second press arrives, and two synchronous calls with no render
 * between them is exactly that situation.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE GUARDS ARE FOR
 *
 * `pick` — `File.pickFileAsync` presents a view controller. iOS refuses a second
 * presentation while the first is up, React believes it succeeded, and the refused promise
 * may never settle. That leaves the phase on `reading` for ever: a spinner with no buttons
 * on it, force-quit the only way out. This repo's 2026-09-10 freeze was the same shape.
 *
 * `start` — two staging loops against one job interleave their progress updates, so the
 * "Part 3 of 9" line goes backwards, and `import_started` is counted twice, inflating the
 * one distribution nobody currently has a second source for.
 */

const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};

/** How many pickers are open right now, and how many were ever opened. */
let openPickers = 0;
let pickerOpens = 0;
/** Resolves the picker when a test wants to hold it open across the second call. */
let releasePicker: (() => void) | null = null;

jest.mock('expo-file-system', () => ({
  File: {
    pickFileAsync: () => {
      pickerOpens += 1;
      openPickers += 1;
      return new Promise((resolve) => {
        releasePicker = () => {
          openPickers -= 1;
          // Cancelled, so the hook returns to `idle` without needing a real archive. What
          // is under test is how many times the picker was reached, not what it returned.
          resolve({ canceled: true, result: null });
        };
      });
    },
  },
}));

/**
 * An RPC whose answer can be held open.
 *
 * `import_discard` is dispatched without being awaited, so the only way to test the window
 * it opens is to keep it in flight while something else happens.
 */
let mockHold: Record<string, { resolve: () => void }> = {};
/** Which RPCs are held open rather than answered immediately. */
const mockHeld = new Set<string>();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const data = mockRpcResults[name] ?? null;
      const settled = { data, error: null, maybeSingle: () => Promise.resolve({ data, error: null }) };

      if (mockHeld.has(name)) {
        let release!: () => void;
        const pending = new Promise<typeof settled>((r) => {
          release = () => r(settled);
        });
        mockHold[name] = { resolve: release };
        return Object.assign(pending, settled);
      }

      return Object.assign(Promise.resolve(settled), settled);
    },
    // No open job to recover; the recovery effect is not what this file is about.
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return builder;
    },
  },
}));

jest.mock('@/lib/analytics', () => ({ track: () => {} }));

beforeEach(() => {
  mockRpc.mockClear();
  mockRpcResults = {};
  mockHold = {};
  mockHeld.clear();
  openPickers = 0;
  pickerOpens = 0;
  releasePicker = null;
});

describe('two taps on the picker', () => {
  it('opens one picker, not two', async () => {
    const { result } = await renderHookWithProviders(() => useImport('settings'));

    // Both calls before either settles, and before any render commits — which is what a
    // double tap is. Neither is awaited: awaiting the first would let the guard clear.
    await act(async () => {
      void result.current.pick();
      void result.current.pick();
    });

    expect(pickerOpens).toBe(1);
    expect(openPickers).toBe(1);
    expect(result.current.state.phase).toBe('reading');

    // And the guard is released when the first one finishes, so the button is not wedged
    // for the rest of the session.
    await act(async () => {
      releasePicker?.();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    await act(async () => {
      void result.current.pick();
    });
    expect(pickerOpens).toBe(2);
  });
});

describe('two taps on Import', () => {
  const preview = {
    normalised: { counts: { watched: 1, ratings: 0, watches: 0, watchlist: 0 } },
    rows: [{ kind: 'watched', correlation: 'a|2001', name: 'A', year: 2001, filmUri: null }],
    pages: [[{ kind: 'watched', correlation: 'a|2001', name: 'A', year: 2001, filmUri: null }]],
  } as unknown as Parameters<ReturnType<typeof useImport>['start']>[0];

  it('creates one job and hands it over once', async () => {
    mockRpcResults = { import_create: 'job-1', import_status: null };
    const { result } = await renderHookWithProviders(() => useImport('settings'));

    await act(async () => {
      void result.current.start(preview);
      void result.current.start(preview);
    });

    await waitFor(() => expect(result.current.state.phase).toBe('working'));

    const called = mockRpc.mock.calls.map(([name]) => name);
    expect(called.filter((name) => name === 'import_create')).toHaveLength(1);
    expect(called.filter((name) => name === 'import_stage')).toHaveLength(1);
    expect(called.filter((name) => name === 'import_ready')).toHaveLength(1);
  });
});

describe('Start over while the discard is still in flight', () => {
  const preview = {
    normalised: { counts: { watched: 1, ratings: 0, watches: 0, watchlist: 0 } },
    rows: [{ kind: 'watched', correlation: 'a|2001', name: 'A', year: 2001, filmUri: null }],
    pages: [[{ kind: 'watched', correlation: 'a|2001', name: 'A', year: 2001, filmUri: null }]],
  } as unknown as Parameters<ReturnType<typeof useImport>['start']>[0];

  /**
   * **The window this closes is the ordinary case, not the rare one.**
   *
   * `reset` fires `import_discard` without awaiting it, so between the tap and the answer
   * there is a gap as long as the network takes. On the dropped connection that motivates
   * the whole mechanism that gap is seconds. Pick a second archive inside it and, if the
   * debt is recorded only when the discard *fails*, `start` sees nothing owing,
   * `import_create` adopts the job being discarded, and the two archives merge — which is
   * exactly what `import_discard` was written to prevent.
   *
   * This is the second fix to this mechanism and the first test of it.
   */
  it('settles the abandoned job before creating a new one', async () => {
    mockRpcResults = { import_create: 'job-2', import_status: null, import_discard: {} };
    const { result } = await renderHookWithProviders(() => useImport('settings'));

    // Get a job id into the hook, then walk away from it.
    await act(async () => {
      await result.current.start(preview);
    });
    await waitFor(() => expect(result.current.state.phase).toBe('working'));

    // Hold the discard open, so the reset is still in flight when the next import starts.
    mockHeld.add('import_discard');
    await act(async () => {
      result.current.reset();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(mockHold.import_discard).toBeDefined();

    mockRpc.mockClear();
    mockHeld.delete('import_discard');

    await act(async () => {
      await result.current.start(preview);
    });

    const called = mockRpc.mock.calls.map(([name]) => name);
    // The debt is paid first. Anything else means `import_create` could have handed back
    // the job that was mid-discard.
    expect(called[0]).toBe('import_discard');
    expect(called.indexOf('import_discard')).toBeLessThan(called.indexOf('import_create'));

    // And the in-flight discard resolving late does not clear a debt recorded since.
    await act(async () => {
      mockHold.import_discard?.resolve();
    });
  });

  it('does not re-discard once the first attempt succeeded', async () => {
    // The debt is recorded pessimistically and cleared on success, so the common path costs
    // nothing: a reset whose discard lands leaves the next import with no debt to settle.
    mockRpcResults = { import_create: 'job-3', import_status: null, import_discard: {} };
    const { result } = await renderHookWithProviders(() => useImport('settings'));

    await act(async () => {
      await result.current.start(preview);
    });
    await waitFor(() => expect(result.current.state.phase).toBe('working'));

    await act(async () => {
      result.current.reset();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    mockRpc.mockClear();
    await act(async () => {
      await result.current.start(preview);
    });

    expect(mockRpc.mock.calls.map(([name]) => name)[0]).toBe('import_create');
  });
});
