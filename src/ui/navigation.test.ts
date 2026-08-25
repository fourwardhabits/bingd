import { BACK_LABEL, INTERNAL_ROUTE_MARKERS, ROOT_SCREEN_TITLES, rootStackScreenOptions } from './navigation';

/**
 * **`‹ (tabs)` on a physical iPhone.**
 *
 * The founder photographed it in the header of a title page. It is not a stray string:
 * on iOS the native stack labels the back button with the *previous route's title*, the
 * route behind every pushed screen here is the tab group, a group's title defaults to
 * its route name, and this router spells groups with parentheses. So a screen that does
 * not name its own back label gets the router's internal directory name rendered at the
 * top of the app.
 *
 * It was invisible for two reasons worth writing down. Android draws no back title at
 * all, so nothing about it shows up in day-to-day testing on the platform this app
 * ships to first. And five screens had each been given `headerBackTitle: 'Back'`
 * individually — `/u/[username]`, `/person/[id]` and three Settings screens — so most
 * paths looked right and only `title/[id]` and `lists/[id]` did not.
 *
 * These assert the two properties that keep it fixed rather than the one screen that
 * showed it: the default exists on the stack, so a new screen inherits a correct label,
 * and no title anywhere in the root stack is a route name, so the fallback cannot be one
 * either.
 */

describe('the back control never says a route name', () => {
  it('gives every pushed screen a back label by default', () => {
    // The fix is a default rather than a sixth per-screen override. Without it the next
    // screen somebody adds inherits the leak, on the platform nobody tests it on.
    expect(rootStackScreenOptions.headerBackTitle).toBe(BACK_LABEL);
    expect(rootStackScreenOptions.headerBackTitle).toBeTruthy();
  });

  it('uses the word this app already uses, rather than a second convention', () => {
    // Five screens had already chosen "Back" one at a time. A navigation convention that
    // differs by screen is worse than either choice made consistently.
    expect(BACK_LABEL).toBe('Back');
  });

  it('has no route name in any root title', () => {
    for (const [route, title] of Object.entries(ROOT_SCREEN_TITLES)) {
      // The route names themselves are the thing being excluded — `(tabs)`, `(auth)`,
      // `title/[id]`. A title equal to its own route is the exact defect.
      expect(title).not.toBe(route);
      expect(title).not.toMatch(INTERNAL_ROUTE_MARKERS);
    }
  });

  it('catches the class rather than the one string that leaked', () => {
    // Guarding only against the literal `(tabs)` would pass the day somebody adds
    // `(modals)` or lets `[id]` through. Brackets of any kind in a user-facing
    // navigation string mean a route name has escaped.
    expect('(tabs)').toMatch(INTERNAL_ROUTE_MARKERS);
    expect('(auth)').toMatch(INTERNAL_ROUTE_MARKERS);
    expect('title/[id]').toMatch(INTERNAL_ROUTE_MARKERS);
    expect('Back').not.toMatch(INTERNAL_ROUTE_MARKERS);
    expect('Profile').not.toMatch(INTERNAL_ROUTE_MARKERS);
  });

  /**
   * The groups are empty on purpose, and that is the belt to `headerBackTitle`'s braces:
   * neither shows a header, so the empty string is never drawn as a title, and if the
   * back label were ever removed the worst this degrades to is a bare chevron.
   */
  it('leaves the route groups without a title of their own', () => {
    expect(ROOT_SCREEN_TITLES['(tabs)']).toBe('');
    expect(ROOT_SCREEN_TITLES['(auth)']).toBe('');
  });

  it('covers every route the title page can be reached from', () => {
    // Feed, Collection, Search, For You and Profile all push `title/[id]` from inside
    // the tab group, so all five paths share one previous route — which is why one
    // default fixes all five and why the group's own title is the thing to check.
    expect(Object.keys(ROOT_SCREEN_TITLES)).toContain('title/[id]');
    expect(ROOT_SCREEN_TITLES['title/[id]']).toBe('Title');
    expect(ROOT_SCREEN_TITLES['(tabs)']).not.toMatch(INTERNAL_ROUTE_MARKERS);
  });
});
