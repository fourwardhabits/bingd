const { configure } = require('@testing-library/react-native');

/**
 * How long an async matcher waits before giving up.
 *
 * The library's default is one second, and that is below what several screens here
 * genuinely cost. `jest.config.js` already records the shape of it: the first render
 * in a screen suite transforms and evaluates the whole tree including navigation and
 * the query client, which takes about a second locally and rather more on a shared
 * runner.
 *
 * The Log screen adds a real 180ms search debounce on top of that, and it is the
 * suite that surfaced this: `LogScreen › opens title detail from the row` failed once
 * under a full parallel run and passed in isolation every time.
 *
 * What was actually demonstrated, and what was not. Squeezing this budget to 250ms
 * fails that test and no other, so the assertion is timeout-sensitive and it is the
 * first test in its file — the one that pays the whole screen-tree evaluation. That
 * is consistent with runner contention and it does not *prove* the absence of a race;
 * independent review made that point and it is right. No race was found — the test
 * waits for the row before pressing it — but the honest statement is that the budget
 * was too small for the work, not that a race has been ruled out. Worth watching test
 * durations rather than treating it as closed.
 *
 * Five seconds is still far short of the fifteen-second test timeout, so a genuinely
 * stuck `waitFor` fails the run rather than hanging it.
 */
configure({ asyncUtilTimeout: 5000 });

// Fonts are bundled assets, so tests do not need to resolve them.
jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  loadAsync: jest.fn(),
  isLoaded: () => true,
}));

// src/lib/env.ts refuses to load without a valid configuration, which is deliberate — a
// build missing its Supabase URL should fail at startup rather than on the first query. A
// test run is not a build, so it gets a configuration of its own. Deliberately not
// production, so anything gated on the variant behaves as it does in a preview build.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        variant: 'preview',
        supabaseUrl: 'https://project.supabase.co',
        supabaseAnonKey: 'anon-key-for-tests',
      },
    },
  },
}));

/**
 * A `<Modal>` that reports its own dismissal, which is the part of iOS jest does not have.
 *
 * ---------------------------------------------------------------------------
 * **Why every suite needs this and not just the one that found the bug.**
 *
 * Since 2026-09-10 the screens that hand one sheet straight over to another keep the
 * outgoing one mounted, close it with `visible`, and wait for `onDismiss` before
 * presenting the next — because UIKit refuses to present over a dismissing controller and
 * the transparent window it leaves behind swallows every touch. `useSheetHandoff` carries
 * the account.
 *
 * React Native never fires `onDismiss` under jest, so without this every handover test in
 * the app would wait forever — and that is the fix working, not the fix broken. This
 * supplies the one callback the platform owes.
 *
 * Faithful in the two ways that matter, and no further:
 *
 *   - **children stay rendered through the dismissal**, because iOS keeps them, which is
 *     precisely why a dismissing sheet's controls have to be made inert; and
 *   - **`onDismiss` fires only on the true -> false transition**, never on mount and
 *     never on unmount — a modal unmounted while still visible reports nothing, which is
 *     the behaviour that made the bug possible and must not be papered over.
 *
 * `globalThis.__modalDismissals.hold` lets a test stand inside the gap.
 */
globalThis.__modalDismissals = { hold: false, pending: [] };

jest.mock('react-native/Libraries/Modal/Modal', () => {
  const React = require('react');
  function MockModal(props) {
    const prev = React.useRef(Boolean(props.visible));
    const [dismissing, setDismissing] = React.useState(false);
    // Derived during render, not in the effect. `dismissing` cannot be set until after
    // the commit where `visible` flips false, so a mock that relied on it alone rendered
    // null for exactly that one commit — unmounting and remounting the children it is
    // supposed to keep. That re-ran rank_start and reset the very state the guards under
    // test depend on.
    const closing = prev.current && !props.visible;
    React.useEffect(() => {
      if (closing && props.onDismiss) {
        const done = props.onDismiss;
        setDismissing(true);
        const finish = () => {
          setDismissing(false);
          done();
        };
        if (globalThis.__modalDismissals.hold) globalThis.__modalDismissals.pending.push(finish);
        else finish();
      }
      prev.current = Boolean(props.visible);
      // Deps rather than every render: the only thing this has to react to is a change
      // in visible, which is exactly when prev needs updating.
    }, [closing, props.onDismiss, props.visible]);
    // A host element named 'Modal', not a fragment: tests reach the real component by
    // type to dispatch `requestClose` (the Android back button), and a fragment leaves
    // them nothing to find.
    const { children, ...rest } = props;
    return props.visible || closing || dismissing
      ? React.createElement('Modal', rest, children)
      : null;
  }
  // `react-native`'s index resolves this module's `default`.
  return { __esModule: true, default: MockModal };
});

beforeEach(() => {
  globalThis.__modalDismissals.hold = false;
  globalThis.__modalDismissals.pending.length = 0;
});
