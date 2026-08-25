import { theme } from './tokens';

/**
 * The word on the back control.
 *
 * A constant so the regression test can assert against the value the stack actually
 * uses rather than against a second copy of the string, which is the usual way a test
 * like this stops testing anything.
 */
export const BACK_LABEL = 'Back';

/**
 * What the root stack gives every screen it pushes.
 *
 * ---------------------------------------------------------------------------
 * WHY `headerBackTitle` IS HERE AND NOT ON THE SCREENS
 *
 * The founder's iPhone showed `‹ (tabs)` in the header of a title page. That is not a
 * typo or a stray string — it is React Navigation working exactly as documented. On
 * iOS the native stack labels the back button with **the previous route's title**, and
 * the route behind every pushed screen in this app is the tab group. A group's title
 * defaults to its route name, and this router spells route groups with parentheses. So
 * the fallback for a screen that does not name its own back label is the router's
 * internal directory name, rendered at the top of the app.
 *
 * Five screens had already been given `headerBackTitle: 'Back'` one at a time, which is
 * why only some paths showed it: `/u/[username]`, `/person/[id]` and the Settings
 * screens set it and were fine, while `title/[id]` and `lists/[id]` did not and were
 * not. That is the shape of defect that comes back — the next screen somebody adds
 * inherits the leak, and it is invisible on Android, which is where most of the
 * day-to-day testing happens.
 *
 * So the default lives on the stack. A screen may still override it; none has to, and
 * one that forgets now gets a correct label rather than a directory name.
 *
 * `'Back'` rather than a bare chevron because that is what this app already does on the
 * five screens that got it right, and a navigation convention that differs by screen is
 * worse than either choice made consistently.
 */
export const rootStackScreenOptions = {
  headerShown: false,
  headerBackTitle: BACK_LABEL,
  contentStyle: { backgroundColor: theme.surface.base },
  headerStyle: { backgroundColor: theme.surface.base },
  headerTintColor: theme.text.primary,
} as const;

/**
 * Anything that looks like a router-internal identifier rather than a name for a
 * person.
 *
 * Expo Router spells groups `(tabs)` and dynamic segments `[id]`, so a bracket of any
 * kind in a user-facing navigation string means a route name has escaped into the
 * interface. Deliberately broader than the string that actually leaked: `(tabs)` was
 * the instance, and the defect is the class.
 */
export const INTERNAL_ROUTE_MARKERS = /[()[\]]/;

/**
 * The title each root route carries, which on iOS is also the back label of whatever
 * is pushed *on top of* it.
 *
 * Declared here rather than inline in the layout so it can be asserted: the invariant
 * is that no entry is a route name, and an invariant nothing checks is a convention.
 *
 * The two groups are `''` on purpose and are the belt to `headerBackTitle`'s braces.
 * Neither shows a header — so the empty string is never drawn as a title — and if the
 * back label above were ever removed, the worst this could degrade to is a bare
 * chevron rather than the router's directory name.
 */
export const ROOT_SCREEN_TITLES = {
  '(tabs)': '',
  '(auth)': '',
  'title/[id]': 'Title',
  'u/[username]': 'Profile',
  /** Reached from a cast strip. The screen sets the person's name once it resolves. */
  'person/[id]': '',
  'lists/[id]': 'List',
  settings: 'Settings',
} as const;
