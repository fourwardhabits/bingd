import { readFileSync, readdirSync } from 'node:fs';
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

  /**
   * **Every onboarding screen is behind the signed-in guard, and this is checked from the
   * directory rather than from the layout.**
   *
   * The invariant it protects is the one `app/_layout.tsx` spends thirty lines on: those
   * screens open with `useCurrentProfile()`, which throws outside a `ready` session, so
   * `Stack.Protected` removes them in the same render the status changes rather than
   * leaving the throw to an error boundary. `onboarding/taste` was declared inside it and
   * the five screens added later were not — and nothing failed, because expo-router builds
   * its tree from this directory and serves an undeclared route perfectly happily. The
   * declaration is only how a route gets *options*, protection among them.
   *
   * So the list is taken from the filesystem, which is what the router uses. A screen added
   * to `app/onboarding/` tomorrow and forgotten in the layout fails here, which is the only
   * moment anybody would find out before an expired token found it for them.
   *
   * `_layout` and `+`-prefixed files are excluded because they are not routes.
   */
  it('declares every onboarding route inside the signed-in guard', () => {
    const layout = readFileSync(join(APP, '_layout.tsx'), 'utf8');

    const open = layout.indexOf('<Stack.Protected');
    const close = layout.indexOf('</Stack.Protected>');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const guarded = layout.slice(open, close);

    const routes = readdirSync(join(APP, 'onboarding'))
      .filter((name) => /\.[tj]sx?$/.test(name))
      .filter((name) => !name.startsWith('_') && !name.startsWith('+'))
      .map((name) => `onboarding/${name.replace(/\.[tj]sx?$/, '')}`);

    // A guard nobody can see the shape of is worth asserting is non-empty first.
    expect(routes.length).toBeGreaterThan(0);

    const unguarded = routes.filter((route) => !guarded.includes(`name="${route}"`));
    expect(unguarded).toEqual([]);
  });
});
