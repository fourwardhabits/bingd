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
