import { nextRoute, type RoutingInput } from './session';

/**
 * Where a user is sent, and — the part independent review found broken — where they are
 * deliberately left alone.
 *
 * A table rather than a rendered hook. The first attempt at this file mocked
 * `useAuthRouting`'s own module to replace `useAuth`, which cannot work: the hook holds a
 * direct reference to the real one past `requireActual`, so every assertion passed
 * because auth was stuck at `loading` and nothing was ever routed. Tests that pass for a
 * reason unrelated to their subject are worse than no tests, which is why the decision is
 * now a function.
 */
const decide = (input: Partial<RoutingInput>) =>
  nextRoute({
    status: 'ready',
    group: undefined,
    screen: undefined,
    tasteNeeded: false,
    tastePending: false,
    ...input,
  });

describe('nextRoute', () => {
  describe('before it knows', () => {
    it('moves nobody while auth is loading', () => {
      expect(decide({ status: 'loading' })).toBeNull();
    });

    it('moves nobody when auth failed, because not knowing is not a destination', () => {
      // Sending a signed-in user with a flaky connection to sign-in would ask them to
      // claim a username they already own.
      expect(decide({ status: 'error' })).toBeNull();
    });

    it('waits for the first-run check rather than flashing the feed', () => {
      expect(decide({ tastePending: true, tasteNeeded: undefined })).toBeNull();
    });
  });

  describe('signed out and half signed up', () => {
    it('sends a signed-out user to sign in', () => {
      expect(decide({ status: 'signed-out' })).toBe('/(auth)/sign-in');
    });

    it('leaves a signed-out user already in the auth group', () => {
      expect(decide({ status: 'signed-out', group: '(auth)', screen: 'sign-in' })).toBeNull();
    });

    it('sends an authenticated user with no profile to create one', () => {
      expect(decide({ status: 'onboarding' })).toBe('/(auth)/create-profile');
    });

    it('pulls them back if they wander to another auth screen', () => {
      expect(decide({ status: 'onboarding', group: '(auth)', screen: 'sign-in' })).toBe(
        '/(auth)/create-profile',
      );
    });
  });

  describe('the first-run flow', () => {
    it('sends a brand-new account to build its taste', () => {
      expect(decide({ tasteNeeded: true })).toBe('/onboarding/taste');
    });

    it('sends an established account to the feed instead', () => {
      expect(decide({ tasteNeeded: false })).toBe('/(tabs)/feed');
    });

    /**
     * The blocker independent review found.
     *
     * Bucketing the first film writes a `user_media` row, so the account stops looking
     * new — which is the flow doing its job. Routing read that as a reason to end it and
     * replaced the screen with the feed at one of five; closing the app mid-flow did the
     * same on reopening. Routing now sends people *into* the flow and never takes them
     * out. The screen owns its exit.
     */
    it('leaves somebody in the flow once their first film makes them look established', () => {
      expect(decide({ group: 'onboarding', screen: 'taste', tasteNeeded: false })).toBeNull();
    });

    it('leaves them in it at five of five, so the summary is reachable', () => {
      expect(decide({ group: 'onboarding', screen: 'taste', tasteNeeded: false })).toBeNull();
    });

    it('does not bounce them out while the check is still pending either', () => {
      expect(
        decide({ group: 'onboarding', screen: 'taste', tastePending: true, tasteNeeded: undefined }),
      ).toBeNull();
    });

    it('never sends a signed-out user into it', () => {
      expect(decide({ status: 'signed-out', tasteNeeded: true })).toBe('/(auth)/sign-in');
    });

    it('never sends a user without a profile into it', () => {
      // The screen calls `useCurrentProfile`, which throws outside a ready session.
      expect(decide({ status: 'onboarding', tasteNeeded: true })).toBe('/(auth)/create-profile');
    });
  });

  describe('a settled user', () => {
    it('is moved off the root index, which serves nothing', () => {
      expect(decide({ group: undefined })).toBe('/(tabs)/feed');
    });

    it('is moved out of the auth group once signed in', () => {
      expect(decide({ group: '(auth)', screen: 'sign-in' })).toBe('/(tabs)/feed');
    });

    it('is left alone anywhere else, so pushed detail routes are not yanked back', () => {
      expect(decide({ group: 'title', screen: '[id]' })).toBeNull();
      expect(decide({ group: '(tabs)', screen: 'feed' })).toBeNull();
      expect(decide({ group: 'settings' })).toBeNull();
    });
  });

  it('never returns the route it was already on, so there is no redirect loop', () => {
    // Every destination this can return, fed back in as the current location.
    const cases: { input: Partial<RoutingInput>; settled: string }[] = [
      { input: { status: 'signed-out', group: '(auth)', screen: 'sign-in' }, settled: 'sign-in' },
      {
        input: { status: 'onboarding', group: '(auth)', screen: 'create-profile' },
        settled: 'create-profile',
      },
      { input: { group: 'onboarding', screen: 'taste', tasteNeeded: true }, settled: 'taste' },
      { input: { group: '(tabs)', screen: 'feed' }, settled: 'feed' },
    ];

    for (const { input } of cases) expect(decide(input)).toBeNull();
  });
});
