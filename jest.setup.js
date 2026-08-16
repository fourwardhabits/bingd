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
 * suite that surfaced this — `LogScreen › opens title detail from the row` failed
 * once under a full parallel run and passed in isolation every time, which is the
 * signature of a budget set below the work rather than of a race. Five seconds is
 * still far short of the fifteen-second test timeout, so a genuinely stuck `waitFor`
 * fails the run rather than hanging it; what it stops is a slow machine being
 * reported as a broken assertion.
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
