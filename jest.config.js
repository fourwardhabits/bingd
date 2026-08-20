/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  /**
   * `supabase/functions` is Deno, not Node. `normalize.test.ts` there uses `Deno.test`
   * and imports from `jsr:`, neither of which Jest can evaluate — it is run by
   * `npm run functions:test`. Jest found it by name the moment it was added, which is
   * how a green suite became a failing one without a line of application code changing.
   */
  testPathIgnorePatterns: [
    '/node_modules/',
    '/design-references/',
    '/.expo/',
    '/supabase/functions/',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
  /**
   * The default five seconds is not enough for the first test in a screen suite on CI.
   * The cost is one-off: the first render transforms and evaluates the whole screen tree
   * including navigation and the query client, which takes about a second here and rather
   * more on a shared runner. Later tests in the same file run in tens of milliseconds.
   *
   * Fifteen is still short enough that a genuinely stuck `waitFor` fails the build rather
   * than hanging it.
   */
  testTimeout: 15000,
};
