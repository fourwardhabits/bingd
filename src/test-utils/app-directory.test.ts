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
   *
   * Two details are the difference between this checking the invariant and merely looking
   * as though it does, and review found both:
   *
   *   · the walk is **recursive**, and an `index` file names its directory. A flat
   *     `onboarding/foo.tsx` is not the only way to add a route — `onboarding/foo/index.tsx`
   *     is a route too, and a test that read one level would have passed while it sat
   *     unguarded, which is precisely the failure being pinned;
   *
   *   · the layout is read with its **comments stripped**. Substring matching against the
   *     whole file lets a route name mentioned in prose satisfy the assertion, and the
   *     block above this guard names several.
   */
  /**
   * **Every onboarding route is behind *a* guard, and this walks all of them.**
   *
   * It used to slice between the first opening tag and the first closing one, which was
   * the whole of the guard when there was one. There are two since 2026-09-09:
   * motivations and *How bingd. helps* run before the profile exists, so they sit behind
   * `ready || onboarding` while everything after the form stays behind `ready`. A
   * single-block slice would have reported the new pair as unguarded, which is the
   * opposite of what happened to them.
   *
   * What the assertion is about is unchanged and is the thing that actually bit: an
   * onboarding screen added as a file and never declared is still served by expo-router
   * (it builds its tree from the directory) and is then outside every guard, where
   * `useCurrentProfile` and `useCurrentUserId` throw on an involuntary exit.
   */
  it('declares every onboarding route inside a guard', () => {
    const source = readFileSync(join(APP, '_layout.tsx'), 'utf8');
    const layout = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    /** Every guarded region, in order. */
    const blocks: string[] = [];
    let cursor = 0;
    for (;;) {
      const open = layout.indexOf('<Stack.Protected', cursor);
      if (open === -1) break;
      const close = layout.indexOf('</Stack.Protected>', open);
      expect(close).toBeGreaterThan(open);
      blocks.push(layout.slice(open, close));
      cursor = close + 1;
    }
    expect(blocks.length).toBeGreaterThan(0);
    const guarded = blocks.join('\n');

    const ONBOARDING = join(APP, 'onboarding');
    const routes = walk(ONBOARDING)
      .filter((path) => /\.[tj]sx?$/.test(path))
      .map((path) => path.slice(ONBOARDING.length + 1).replace(/\\/g, '/'))
      .filter((route) => !route.split('/').some((part) => /^[_+]/.test(part)))
      .map((route) => route.replace(/\.[tj]sx?$/, ''))
      // `foo/index` is the route `foo`, which is the name the layout declares.
      .map((route) => route.replace(/\/index$/, ''))
      .map((route) => `onboarding/${route}`);

    // A guard nobody can see the shape of is worth asserting is non-empty first.
    expect(routes.length).toBeGreaterThan(0);

    const unguarded = routes.filter((route) => !guarded.includes(`name="${route}"`));
    expect(unguarded).toEqual([]);
  });
});
