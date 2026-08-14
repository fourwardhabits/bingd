import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Nothing that is not a route may live under app/.
 *
 * expo-router builds its route tree from `require.context(app, true, /\.[tj]sx?$/)`, and the
 * only names it excludes are `+api`, `+html` and `+middleware`. A test file colocated with
 * its screen is therefore part of the bundle: `@testing-library/react-native` imports
 * `redent` and `util`, which broke `expo export` outright — the honest failure. Had it
 * bundled, every user would have downloaded the test suite.
 *
 * Tests for routes live beside the feature they exercise and import the screen by relative
 * path. This guard is here because the mistake is invisible until an export runs, which is
 * long after the test was written.
 */

const APP = join(__dirname, '..', '..', 'app');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

describe('the app directory', () => {
  it('contains no tests, because everything in it is bundled', () => {
    const offenders = walk(APP)
      .filter((path) => /\.(test|spec)\.[tj]sx?$/.test(path))
      .map((path) => path.slice(APP.length + 1));

    expect(offenders).toEqual([]);
  });

  it('contains no test helpers either', () => {
    const offenders = walk(APP)
      .filter((path) => /(^|[\\/])(__tests__|__mocks__|test-utils)([\\/]|$)/.test(path))
      .map((path) => path.slice(APP.length + 1));

    expect(offenders).toEqual([]);
  });
});
