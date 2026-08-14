/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testPathIgnorePatterns: ['/node_modules/', '/design-references/', '/.expo/'],
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
