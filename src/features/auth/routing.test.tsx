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
    /**
     * An established account, on a device that has already been introduced to the app.
     *
     * Both defaults are the *settled* answer rather than the unknown one, so that a case
     * about the taste rule is not silently also a case about the opening. The tests that
     * are about those two set them explicitly.
     */
    stage: undefined,
    welcomeSeen: true,
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


  describe('the opening, which runs before there is an account', () => {
    it('sends a device that has never seen it to the opening rather than the form', () => {
      expect(decide({ status: 'signed-out', welcomeSeen: false })).toBe('/(auth)/welcome');
    });

    it('sends a device that has seen it straight to sign in', () => {
      expect(decide({ status: 'signed-out', welcomeSeen: true })).toBe('/(auth)/sign-in');
    });

    /**
     * The hold, and why it is safe to have one here at all.
     *
     * Guessing either way is wrong: `true` skips the opening on a genuine first launch,
     * `false` shows it again to somebody who dismissed it. The wait is bounded in
     * `hydrateWelcomeSeen`, which resolves an unreadable or unresponsive preference to
     * `true` — so this state cannot outlive one Keychain read, and the app is never held
     * on it indefinitely. That is the build-4 lesson applied rather than repeated.
     */
    it('moves nobody while the preference has not been answered', () => {
      expect(decide({ status: 'signed-out', welcomeSeen: undefined })).toBeNull();
    });

    it('leaves somebody alone once they are inside the auth group', () => {
      expect(
        decide({ status: 'signed-out', group: '(auth)', screen: 'welcome', welcomeSeen: false }),
      ).toBeNull();
    });
  });

  describe('resuming a flow that is longer than the ranking run', () => {
    /**
     * **The defect the stage rule exists to prevent, stated as a test.**
     *
     * Five rankings used to mean the flow was over, and `readState` still settles an
     * `active` account with five of them to `done` so a summary cannot repeat for ever.
     * The run is step 7 of ten now: an account that closed the app on the People step has
     * five rankings and a taste query that answers "not needed". Asking taste first would
     * open the Feed with People and the notification question silently skipped.
     */
    it('returns somebody to the step they left, even though taste says they are done', () => {
      expect(decide({ stage: 'people', tasteNeeded: false })).toBe('/onboarding/people');
    });

    it('returns them to the notification step for the same reason', () => {
      expect(decide({ stage: 'notifications', tasteNeeded: false })).toBe(
        '/onboarding/notifications',
      );
    });

    /**
     * A finished flow falls through to the ordinary rules rather than being routed by
     * this one. Where the app opens after onboarding is the exiting screen's decision —
     * the Feed when a connection was made, For You when none was — and a stage rule that
     * answered here would overrule it every time.
     */
    it('stops answering once the flow is done', () => {
      expect(decide({ stage: 'done', tasteNeeded: false })).toBe('/(tabs)/feed');
    });

    /**
     * The stage outranks a taste check that has not come back, which is what stops the
     * resume flashing the wrong screen: without this, a cold start on the People step
     * would sit on `/` until two count queries answered a question that cannot change
     * where this person belongs.
     */
    it('does not wait for the taste check when the stage already answers', () => {
      expect(decide({ stage: 'people', tastePending: true, tasteNeeded: undefined })).toBe(
        '/onboarding/people',
      );
    });

    it('still refuses to pull anybody out of the flow group', () => {
      expect(decide({ group: 'onboarding', screen: 'people', stage: 'done' })).toBeNull();
    });
  });
  describe('the first-run flow', () => {
    /**
     * The flow now begins at the motivation question rather than at the picker.
     *
     * The account exists by this point — auth is step 2 — so there is somewhere to put
     * an answer, and the two value screens come before the reader is asked to spend any
     * effort on a five-film selection.
     */
    it('sends a brand-new account to the top of the flow', () => {
      expect(decide({ tasteNeeded: true })).toBe('/onboarding/motivations');
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
