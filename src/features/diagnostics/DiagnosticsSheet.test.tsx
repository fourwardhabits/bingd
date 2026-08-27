import { act, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';
import { note, recordRequest, resetFlightRecorder, tally } from '@/lib/flight-recorder';

import { Clipboard } from 'react-native';

import { DiagnosticsSheet } from './DiagnosticsSheet';

/**
 * The sheet that would not appear.
 *
 * On the founder's device, tapping Diagnostics in Settings highlighted the control and
 * opened nothing. The cause was not this component: it was where it was mounted. A React
 * Native `<Modal>` is presented from the **root** view controller, and `settings` is a
 * `Stack.Screen` with `presentation: 'modal'`, so the root controller is already presenting
 * — and iOS will not let it present twice. The sheet was refused, or drawn underneath the
 * screen that asked for it.
 *
 * The repair is that each entry point renders this component in its own tree, so the modal
 * presents from that screen's controller. What these tests can hold is the half that lives
 * in JavaScript: that `visible` genuinely produces content, that it does so while the app's
 * state is unhealthy, and that opening and closing repeatedly keeps working.
 *
 * The native presentation itself cannot be reproduced in Jest, and this file does not
 * pretend otherwise.
 */

const mockPrefs = new Map<string, unknown>();
let mockSessionHangs = false;

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
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

jest.mock('expo-router', () => ({ useSegments: () => ['settings'] }));

jest.mock('react-native/Libraries/Components/Clipboard/Clipboard', () => ({
  __esModule: true,
  default: { setString: jest.fn(), getString: jest.fn() },
}));

jest.mock('expo-updates', () => ({
  isEmbeddedLaunch: false,
  createdAt: new Date('2026-08-26T23:00:00.000Z'),
  runtimeVersion: 'd3b308f7',
  updateId: '01a04092',
  channel: 'beta',
}));

const setString = Clipboard.setString as unknown as jest.Mock;

beforeEach(() => {
  setString.mockReset();
  mockPrefs.clear();
  mockSessionHangs = false;
  resetFlightRecorder();
});

/** Enough recorded activity that an empty report would be a visible failure. */
const someActivity = () => {
  const handle = recordRequest('https://x.supabase.co/rest/v1/rankings');
  handle.sent();
  handle.settled({ status: 200 });
  note('route', 'onboarding/taste', 'stay:ready');
  note('signout', 'signOut.supabase', 'timeout', 2000);
  tally('auth.callbacks', 2);
};

describe('opening the sheet', () => {
  it('shows the report', async () => {
    someActivity();
    const view = await renderWithProviders(<DiagnosticsSheet visible onClose={() => {}} />);

    await waitFor(() => expect(view.getByText(/bingd\. diagnostics/)).toBeTruthy());
    expect(view.getByText(/rest:rankings/)).toBeTruthy();
    expect(view.getByText(/signOut\.supabase/)).toBeTruthy();
  });

  it('renders nothing at all when it is not open', async () => {
    const view = await renderWithProviders(
      <DiagnosticsSheet visible={false} onClose={() => {}} />,
    );
    expect(view.queryByText(/bingd\. diagnostics/)).toBeNull();
  });

  /**
   * **The condition that matters.** The founder opens this precisely when the app is
   * unwell, so a session read that never answers must not stop the report appearing —
   * `facts.ts` bounds it and reports UNKNOWN.
   */
  it('opens while the session read is hanging', async () => {
    mockSessionHangs = true;
    someActivity();

    jest.useFakeTimers();
    try {
      const view = await renderWithProviders(<DiagnosticsSheet visible onClose={() => {}} />);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3000);
      });
      expect(view.getByText(/bingd\. diagnostics/)).toBeTruthy();
      expect(view.getByText(/UNKNOWN \(read did not answer\)/)).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('opens with no recorded activity at all, and says so', async () => {
    const view = await renderWithProviders(<DiagnosticsSheet visible onClose={() => {}} />);

    await waitFor(() => expect(view.getByText(/bingd\. diagnostics/)).toBeTruthy());
    // An empty report is still a useful one: it says the recorder is empty rather than
    // leaving a blank screen that reads as another presentation failure.
    expect(view.getByText(/\(none\)/)).toBeTruthy();
  });

  it('can be closed and opened again', async () => {
    someActivity();
    const onClose = jest.fn();
    const view = await renderWithProviders(<DiagnosticsSheet visible onClose={onClose} />);
    await waitFor(() => expect(view.getByText(/bingd\. diagnostics/)).toBeTruthy());

    await view.rerender(<DiagnosticsSheet visible={false} onClose={onClose} />);
    expect(view.queryByText(/bingd\. diagnostics/)).toBeNull();

    await view.rerender(<DiagnosticsSheet visible onClose={onClose} />);
    await waitFor(() => expect(view.getByText(/bingd\. diagnostics/)).toBeTruthy());
  });

  /** Building the report must not become a render loop on the one screen that must not. */
  it('builds the report once per open rather than on every render', async () => {
    someActivity();
    const view = await renderWithProviders(<DiagnosticsSheet visible onClose={() => {}} />);
    await waitFor(() => expect(view.getByText(/bingd\. diagnostics/)).toBeTruthy());

    const before = view.getByText(/bingd\. diagnostics/).props.children as string;
    await view.rerender(<DiagnosticsSheet visible onClose={() => {}} />);
    await act(async () => {});

    // Same text object: a rebuild would have stamped a new `captured` timestamp.
    expect(view.getByText(/bingd\. diagnostics/).props.children).toBe(before);
  });

  it('offers Refresh and Copy', async () => {
    someActivity();
    const view = await renderWithProviders(<DiagnosticsSheet visible onClose={() => {}} />);
    await waitFor(() => expect(view.getByText(/bingd\. diagnostics/)).toBeTruthy());

    expect(view.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    const copy = view.getByRole('button', { name: 'Copy' });
    await fireEvent.press(copy);
    await waitFor(() => expect(view.getByRole('button', { name: 'Copied' })).toBeTruthy());
  });
});

describe('what the Copy control claims', () => {
  /**
   * **Independent review 57's finding.** The first version said "Copied" whether or not the
   * write had happened — which is the founder-visible silent failure this whole task exists
   * to remove, reproduced inside the control meant to replace it.
   */
  it('says the copy failed when the clipboard refuses', async () => {
    someActivity();
    setString.mockImplementation(() => {
      throw new Error('Clipboard has been removed from react-native core');
    });

    const view = await renderWithProviders(<DiagnosticsSheet visible onClose={() => {}} />);
    await waitFor(() => expect(view.getByText(/bingd\. diagnostics/)).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(view.getByRole('button', { name: 'Copy failed' })).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  /**
   * And there is nothing to copy until the report exists, so the control does not offer a
   * press that would quietly do nothing.
   */
  it('is unavailable until the report has been built', async () => {
    mockSessionHangs = true;
    someActivity();

    jest.useFakeTimers();
    try {
      const view = await renderWithProviders(<DiagnosticsSheet visible onClose={() => {}} />);
      // Mid-build: the report is still empty.
      expect(view.getByText('Building…')).toBeTruthy();
      expect(view.getByRole('button', { name: 'Copy' }).props.accessibilityState.disabled).toBe(
        true,
      );

      await act(async () => {
        await jest.advanceTimersByTimeAsync(3000);
      });
      expect(view.getByRole('button', { name: 'Copy' }).props.accessibilityState.disabled).toBe(
        false,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
